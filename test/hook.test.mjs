import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { call, cli, hook, tempHome } from './helpers.mjs';

const events = (env) => {
  const f = join(env.ANTIBODY_HOME, 'events.jsonl');
  return existsSync(f) ? readFileSync(f, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];
};

test('PreToolUse: deny, ask, rewrite and allow', () => {
  const h = tempHome();
  cli(h.env, 'init', '--packs', 'git-bash-windows');
  const deny = hook(h.env, { hook_event_name: 'PreToolUse', ...call('Bash', { command: 'grep -n TODO' }) });
  assert.equal(deny.permissionDecision, 'deny');
  assert.match(deny.permissionDecisionReason, /core\.stdin-hang/);

  const ask = hook(h.env, { hook_event_name: 'PreToolUse', ...call('Edit', { file_path: join(h.env.CLAUDE_CONFIG_DIR, 'settings.json'), old_string: 'a', new_string: 'b' }) });
  assert.equal(ask.permissionDecision, 'ask');

  const rw = hook(h.env, { hook_event_name: 'PreToolUse', ...call('Bash', { command: 'tail -5 a.log b.log', description: 'd' }) });
  assert.equal(rw.permissionDecision, undefined, 'a rewrite keeps the normal permission flow');
  assert.deepEqual(rw.updatedInput, { command: 'tail -n 5 a.log b.log', description: 'd' });

  assert.equal(hook(h.env, { hook_event_name: 'PreToolUse', ...call('Bash', { command: 'ls -la' }) }), null);
  assert.deepEqual(events(h.env).map((e) => [e.kind, e.rule]), [['block', 'core.stdin-hang'], ['ask', 'core.protect-settings'], ['rewrite', 'gbw.tail-short-multi']]);
  h.done();
});

test('calls without a session id (tests, people running the hook by hand) are never logged', () => {
  const h = tempHome();
  const out = hook(h.env, { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'grep x' } });
  assert.equal(out.permissionDecision, 'deny', 'the rule still acts');
  hook(h.env, { hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', tool_input: { command: 'false' }, error: 'Exit code 1' });
  assert.deepEqual(events(h.env), []);
  h.done();
});

test('PostToolUseFailure: logs, classifies noise, and hands back a known fix', () => {
  const h = tempHome();
  cli(h.env, 'init');
  mkdirSync(join(h.env.ANTIBODY_HOME, 'issues'), { recursive: true });
  writeFileSync(join(h.env.ANTIBODY_HOME, 'issues', 'AB-0001.md'), '---\n' + JSON.stringify({ id: 'AB-0001', title: 'workitem get takes keys positionally', when: { tool: 'Bash', command: 'workitem\\s+get\\b.*--id' }, fix: 'Run `twg jira workitem get MED-1` (keys are positional).' }) + '\n---\n\nbody\n');
  const c = call('Bash', { command: 'twg jira workitem get --id MED-1' });
  hook(h.env, { hook_event_name: 'PreToolUse', ...c });
  const out = hook(h.env, { hook_event_name: 'PostToolUseFailure', ...c, error: 'Exit code 1\nerror: unknown option --id' });
  assert.match(out.additionalContext, /Known issue AB-0001/);
  assert.match(out.additionalContext, /keys are positional/);

  const noise = hook(h.env, { hook_event_name: 'PostToolUseFailure', ...call('Bash', { command: 'ls src; test -d node_modules && echo deps' }), error: 'Exit code 1\na.ts' });
  assert.equal(noise, null);

  hook(h.env, { hook_event_name: 'PostToolUse', ...call('Bash', { command: 'twg jira workitem get MED-1' }), tool_response: 'ok' });
  const ev = events(h.env);
  assert.deepEqual(ev.map((e) => e.kind), ['failure', 'noise', 'recovery']);
  assert.equal(ev[0].signature, 'Bash | twg jira workitem get | error: unknown option --id');
  assert.equal(ev[2].after, ev[0].id, 'the call that worked is linked to the failure');
  h.done();
});

test('stalls: a killed background task and an interrupted call are both logged', () => {
  const h = tempHome();
  cli(h.env, 'init');
  hook(h.env, { hook_event_name: 'PostToolUse', ...call('Bash', { command: 'npx tsx watch server.ts', run_in_background: true }), tool_response: 'Command running in background with ID: bash_3' });
  const stop = hook(h.env, { hook_event_name: 'PostToolUse', ...call('TaskStop', { task_id: 'bash_3' }), tool_response: 'stopped' });
  assert.match(stop.additionalContext, /possible stall/);
  assert.match(stop.additionalContext, /npx tsx watch server\.ts/);

  const c = call('Bash', { command: 'grep -n foo $EMPTY' });
  hook(h.env, { hook_event_name: 'PreToolUse', ...c });
  hook(h.env, { hook_event_name: 'PostToolUseFailure', ...c, is_interrupt: true, error: 'Interrupted' });
  const ev = events(h.env);
  const stall = ev.find((e) => e.kind === 'stall');
  assert.equal(stall.command, 'npx tsx watch server.ts');
  const intr = ev.find((e) => e.kind === 'interrupt');
  assert.equal(intr.command, 'grep -n foo $EMPTY');
  assert.ok(typeof intr.ranMs === 'number');
  assert.ok(ev.some((e) => e.kind === 'shadow' && e.rule === 'core.stdin-hang-empty-var'), 'the shadow rule saw it');

  const note = cli(h.env, 'note', stall.id, 'dev server was meant to be stopped', { cwd: h.dir });
  assert.equal(note.code, 0);
  assert.equal(events(h.env).at(-1).after, stall.id);
  h.done();
});

test('secrets are redacted before they reach the log', () => {
  const h = tempHome();
  cli(h.env, 'init');
  hook(h.env, { hook_event_name: 'PostToolUseFailure', ...call('Bash', { command: 'curl -H "Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456" https://x' }), error: 'Exit code 7\nAKIAABCDEFGHIJKLMNOP denied' });
  const raw = readFileSync(join(h.env.ANTIBODY_HOME, 'events.jsonl'), 'utf8');
  assert.doesNotMatch(raw, /abcdefghijklmnopqrstuvwxyz123456/);
  assert.doesNotMatch(raw, /AKIAABCDEFGHIJKLMNOP/);
  assert.match(raw, /Bearer \[REDACTED\]/);
  h.done();
});

test('state files never hold an unredacted command', () => {
  const h = tempHome();
  cli(h.env, 'init');
  const secret = 'ghp_' + 'a'.repeat(36);
  const c = call('Bash', { command: `curl -H "Authorization: token ${secret}" https://api.example/x` });
  hook(h.env, { hook_event_name: 'PreToolUse', ...c });
  hook(h.env, { hook_event_name: 'PreToolUse', ...call('Bash', { command: `deploy --token ${secret}` }) });
  hook(h.env, { hook_event_name: 'PostToolUseFailure', ...c, error: 'Exit code 22\nerror: 401' });
  const sess = readFileSync(join(h.env.ANTIBODY_HOME, 'state', 'sessions', 'test-session.json'), 'utf8');
  assert.match(sess, /curl/);
  assert.doesNotMatch(sess, new RegExp(secret));
  // The retry with the same (redacted) secret is still seen as the call that worked.
  hook(h.env, { hook_event_name: 'PostToolUse', ...call('Bash', { command: `curl -H "Authorization: token ${secret}" https://api.example/y` }), tool_response: 'ok' });
  assert.ok(events(h.env).some((e) => e.kind === 'recovery'));
  hook(h.env, { hook_event_name: 'PostToolUse', ...call('Bash', { command: `serve --token=${secret}`, run_in_background: true }), tool_response: 'Command running in background with ID: bash_9' });
  hook(h.env, { hook_event_name: 'PostToolUseFailure', ...call('Edit', { file_path: '/x', api_key: 'plainlookingvalue123', nested: { authToken: 12345678 } }), error: 'failed' });
  const dump = (dir) => (existsSync(dir) ? readdirSync(dir, { recursive: true }).map((f) => join(dir, String(f))).filter((f) => statSync(f).isFile()).map((f) => readFileSync(f, 'utf8')).join('\n') : '');
  const all = dump(h.env.ANTIBODY_HOME);
  assert.doesNotMatch(all, new RegExp(secret));
  assert.doesNotMatch(all, /plainlookingvalue123|12345678/);
  assert.match(all, /"api_key":"\[REDACTED\]"/);
  h.done();
});

test('an interrupt hands back a known fix, also from an archived issue', () => {
  const h = tempHome();
  cli(h.env, 'init');
  mkdirSync(join(h.env.ANTIBODY_HOME, 'issues', 'archive'), { recursive: true });
  writeFileSync(join(h.env.ANTIBODY_HOME, 'issues', 'archive', 'AB-0001.md'), '---\n' + JSON.stringify({ id: 'AB-0001', title: 'grep with no file waits on stdin', when: { kind: 'interrupt', command: '^grep\\b' }, fix: 'Name the file to search.', fixedAt: '2026-01-01T00:00:00.000Z' }) + '\n---\n\nbody\n');
  const c = call('Bash', { command: 'grep -n foo $EMPTY' });
  hook(h.env, { hook_event_name: 'PreToolUse', ...c });
  const out = hook(h.env, { hook_event_name: 'PostToolUseFailure', ...c, is_interrupt: true, error: 'Interrupted' });
  assert.match(out.additionalContext, /Known issue AB-0001/);
  assert.match(out.additionalContext, /note e\w+/);
  h.done();
});

test('a recovery after the fix date does not make an issue recurring', async () => {
  const { status } = await import('../lib/issues.mjs');
  const issue = { fixedAt: '2026-10-01T00:00:00.000Z', when: { signature: 'Bash | twg | x' } };
  assert.equal(status(issue, [{ kind: 'recovery', ts: '2026-10-02T00:00:00.000Z', signature: 'Bash | twg | x' }]).replace('fixed', 'watching'), 'watching');
  assert.equal(status(issue, [{ kind: 'failure', ts: '2026-10-02T00:00:00.000Z', signature: 'Bash | twg | x' }]), 'recurring');
});

test('rotate moves old events out and keeps the recent ones', () => {
  const h = tempHome();
  cli(h.env, 'init');
  const f = join(h.env.ANTIBODY_HOME, 'events.jsonl');
  writeFileSync(f, [{ id: 'old', ts: '2020-01-01T00:00:00.000Z', kind: 'note' }, { id: 'new', ts: new Date().toISOString(), kind: 'note' }].map((x) => JSON.stringify(x)).join('\n') + '\n');
  assert.match(cli(h.env, 'rotate').out, /moved 1 events/);
  assert.deepEqual(events(h.env).map((e) => e.id), ['new']);
  assert.deepEqual(readdirSync(h.env.ANTIBODY_HOME).filter((x) => /rotating/.test(x)), []);
  h.done();
});
