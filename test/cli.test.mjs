import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { call, cli, hook, tempHome } from './helpers.mjs';

test('init, doctor and test on a fresh install', () => {
  const h = tempHome();
  const init = cli(h.env, 'init', '--packs', 'git-bash-windows,windows-orphans');
  assert.equal(init.code, 0, init.err);
  assert.match(init.out, /learned\.md/);
  assert.match(init.out, /"deny"/);
  const doc = cli(h.env, 'doctor');
  assert.equal(doc.code, 0, doc.out + doc.err);
  const t = cli(h.env, 'test');
  assert.equal(t.code, 0, t.out);
  assert.match(t.out, /0 failing/);
  h.done();
});

test('issues: add, fix, computed status, search', () => {
  const h = tempHome();
  cli(h.env, 'init');
  const f = join(h.dir, 'issue.md');
  writeFileSync(f, '---\n{"title":"grep with no file hangs","when":{"kind":"stall","command":"^grep"}}\n---\n\n## What failed\ngrep waited on stdin.\n');
  const add = cli(h.env, 'issue', 'add', f);
  assert.match(add.out, /added AB-0001/);
  assert.match(cli(h.env, 'issue', 'add', f).err, /already has this title/);
  assert.match(cli(h.env, 'issues').out, /^open/m);
  cli(h.env, 'issue', 'fix', 'AB-0001', 'core.stdin-hang now refuses it');
  assert.match(cli(h.env, 'issues').out, /^watching/m);
  assert.match(cli(h.env, 'search', 'stdin').out, /AB-0001/);
  h.done();
});

test('rules: add starts in shadow, promote runs the cases, report shows hits', () => {
  const h = tempHome();
  cli(h.env, 'init');
  const f = join(h.dir, 'twg.json');
  writeFileSync(f, JSON.stringify({ id: 'twg.get-positional', match: { name: 'twg', command: '\\bworkitem\\s+get\\b', hasFlag: '--id' }, message: 'keys are positional', cases: { fire: ['twg jira workitem get --id MED-1'], pass: ['twg jira workitem get MED-1'] } }));
  const add = cli(h.env, 'rule', 'add', f);
  assert.equal(add.code, 0, add.err);
  assert.match(add.out, /\(shadow\)/);
  const out = hook(h.env, { hook_event_name: 'PreToolUse', ...call('Bash', { command: 'twg jira workitem get --id MED-9' }) });
  assert.equal(out, null, 'a shadow rule does not act');
  hook(h.env, { hook_event_name: 'PreToolUse', ...call('Bash', { command: 'twg jira workitem get --id MED-10' }, { session_id: 'other' }) });
  hook(h.env, { hook_event_name: 'PreToolUse', ...call('Bash', { command: 'twg jira workitem get --id MED-11' }) });
  assert.match(cli(h.env, 'report').out, /twg\.get-positional \[shadow deny\] 3 hits in 2 sessions -> ready to promote/);
  assert.match(cli(h.env, 'rule', 'promote', 'twg.get-positional').out, /shadow -> enforce/);
  assert.equal(hook(h.env, { hook_event_name: 'PreToolUse', ...call('Bash', { command: 'twg jira workitem get --id MED-12' }) }).permissionDecision, 'deny');
  assert.match(cli(h.env, 'rule', 'demote', 'core.stdin-hang').out, /config\.json/);
  assert.equal(JSON.parse(readFileSync(join(h.env.ANTIBODY_HOME, 'config.json'), 'utf8')).ruleState['core.stdin-hang'], 'shadow');
  writeFileSync(f.replace('twg', 'bad'), JSON.stringify({ id: 'bad.one', match: { name: 'ls' }, message: 'x', cases: { fire: ['pwd'], pass: ['ls'] } }));
  assert.match(cli(h.env, 'rule', 'add', f.replace('twg', 'bad')).err, /own cases fail/);
  h.done();
});

test('replay: a rule change shows up as changed verdicts against a snapshot', () => {
  const h = tempHome();
  cli(h.env, 'init');
  hook(h.env, { hook_event_name: 'PostToolUseFailure', ...call('Bash', { command: 'twg bb pull-requests list --state OPEN' }), error: 'Exit code 1\nerror: unknown command list' });
  const snap = cli(h.env, 'snapshot').out.trim();
  mkdirSync(join(h.env.ANTIBODY_HOME, 'rules'), { recursive: true });
  writeFileSync(join(h.env.ANTIBODY_HOME, 'rules', 'bb.json'), JSON.stringify({ id: 'bb.no-list', state: 'enforce', match: { name: 'twg', command: '\\bpull-requests\\s+list\\b' }, message: 'use query', cases: { fire: ['twg bb pull-requests list'], pass: ['twg bb pull-requests query'] } }));
  const r = cli(h.env, 'replay', '--before', snap);
  assert.match(r.out, /CHANGED allow -> deny:bb\.no-list/);
  assert.match(r.out, /1 verdicts changed/);
  h.done();
});

test('migrate imports a failure-ledger setup without touching it', () => {
  const h = tempHome();
  const old = join(h.dir, 'old');
  mkdirSync(join(old, 'hooks', 'lib'), { recursive: true });
  const ledger = `# Failure ledger\n\n### twg workitem get takes keys positionally\n- Seen: 2026-10-28, web-app\n- Seen: 2026-10-29, api\n- What failed: \`twg jira workitem get --id MED-1\`\n- Root cause: keys are positional\n- Fix: guard-twg refuses \`--id\`\n- Status: fixed\n\n### AWS SSO token not refreshed\n- Seen: 2026-10-30, api\n- What failed: long SDK run died\n  (continued line)\n- Root cause: token expiry\n- Fix: workaround only: check expiresAt\n- Status: open\n`;
  writeFileSync(join(old, 'failure-ledger.md'), ledger);
  writeFileSync(join(old, 'failure-log.jsonl'), [
    { ts: '2026-10-29T10:00:00.000Z', session_id: 's1', cwd: '/r', tool: 'Bash', input: { command: 'ls; grep -n zz f' }, error: 'Exit code 1\nf' },
    { ts: '2026-10-29T10:01:00.000Z', session_id: 's1', cwd: '/r', tool: 'guard:twg', input: { command: 'twg jira workitem get --id MED-1' }, error: 'takes keys positionally' },
  ].map((x) => JSON.stringify(x)).join('\n') + '\n');
  writeFileSync(join(old, 'hooks', 'guard-example.mjs'), "import { pipelines, runGuard } from './lib/guard.mjs';\n\nfunction check(cmd) {\n  for (const { stages } of pipelines(cmd)) for (const st of stages) if (/^twg\\s.*--id\\b/.test(st.masked) && /workitem\\s+get/.test(st.masked)) return 'keys are positional';\n  return null;\n}\n\nrunGuard('example', check);\n");
  writeFileSync(join(old, 'hooks', 'guard-bash-quoting.mjs'), '// replaced by a pack\n');
  const before = readFileSync(join(old, 'failure-ledger.md'), 'utf8');
  const m = cli(h.env, 'migrate', '--from', old);
  assert.equal(m.code, 0, m.err);
  assert.match(m.out, /issues: 2 added/);
  assert.match(m.out, /events: 2 imported/);
  assert.match(m.out, /guard-example\.mjs -> guards\/example\.mjs/);
  assert.match(m.out, /covered by the git-bash-windows pack/);
  assert.equal(readFileSync(join(old, 'failure-ledger.md'), 'utf8'), before, 'the old ledger is unchanged');
  const issues = readdirSync(join(h.env.ANTIBODY_HOME, 'issues'));
  assert.deepEqual(issues.sort(), ['AB-0001.md', 'AB-0002.md']);
  assert.match(readFileSync(join(h.env.ANTIBODY_HOME, 'issues', 'AB-0002.md'), 'utf8'), /\(continued line\)/);
  const list = cli(h.env, 'issues').out;
  assert.match(list, /recurring|fixed|watching/);
  assert.match(list, /^open .*AWS SSO/m);
  // The converted guard works through the engine.
  const out = hook(h.env, { hook_event_name: 'PreToolUse', ...call('Bash', { command: 'twg jira workitem get --id MED-7' }) });
  assert.equal(out.permissionDecision, 'deny');
  assert.match(out.permissionDecisionReason, /legacy\.example/);
  // Running it twice adds nothing.
  assert.match(cli(h.env, 'migrate', '--from', old).out, /issues: 0 added/);
  const ev = readFileSync(join(h.env.ANTIBODY_HOME, 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(ev.filter((e) => e.imported).map((e) => e.kind), ['noise', 'block']);
  h.done();
});

test('export strips local details and ships in shadow', () => {
  const h = tempHome();
  cli(h.env, 'init');
  mkdirSync(join(h.env.ANTIBODY_HOME, 'rules'), { recursive: true });
  writeFileSync(join(h.env.ANTIBODY_HOME, 'rules', 'a.json'), JSON.stringify({ id: 'x.a', state: 'enforce', issue: 'AB-0003', scope: { cwd: 'D:/src/secret-repo' }, match: { name: 'foo' }, message: 'm', cases: { fire: ['foo'], pass: ['bar'] } }));
  const out = JSON.parse(cli(h.env, 'export', 'x.a').out);
  assert.equal(out[0].state, 'shadow');
  assert.equal(out[0].issue, undefined);
  assert.equal(out[0].scope.cwd, undefined);
  assert.ok(existsSync(join(h.env.ANTIBODY_HOME, 'rules', 'a.json')));
  h.done();
});
