import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempHome } from './helpers.mjs';

const h = tempHome();
process.env.ANTIBODY_HOME = h.env.ANTIBODY_HOME;
process.env.CLAUDE_CONFIG_DIR = h.env.CLAUDE_CONFIG_DIR;
const { compile, evaluate, loadRules, makeContext, testRule } = await import('../lib/rules.mjs');

// Pin the platform so OS-scoped rules behave the same on every CI runner.
const ctx = (command, tool = 'Bash', extra = {}) => makeContext({ tool, input: { command }, cwd: '/repo', platform: 'linux', ...extra });

test('every shipped rule passes its own cases', async () => {
  const { rules, errors } = await loadRules({ packs: ['core', 'git-bash-windows', 'windows-orphans'], rulesDir: null, guardsDir: null });
  assert.deepEqual(errors, []);
  assert.ok(rules.length >= 10);
  for (const r of rules) {
    assert.ok((r.cases.fire || []).length, `${r.id} has fire cases`);
    assert.deepEqual(testRule(r), [], r.id);
  }
});

test('data rule: any and not hold sub-matches on the same stage', () => {
  const link = compile({ id: 't.link', match: { name: 'twg', command: '\\blink\\s+artifact\\b', any: [{ hasFlag: '--url' }, { flagValue: { '--type': '^pull-?request$' } }] }, message: 'm' });
  assert.equal(link.check(ctx('twg jira workitem link artifact --id MED-1 --url https://x'))?.action, 'deny');
  assert.equal(link.check(ctx('twg jira workitem link artifact --type pull-request --id MED-1 --target https://x'))?.action, 'deny');
  assert.equal(link.check(ctx('twg jira workitem link artifact --type pr --id MED-1 --target https://x')), null);
  // `a && (b || c) && !d`: a write whose output is piped away, except a transition that only lists.
  const hidden = compile({ id: 't.hidden', match: { name: 'twg', command: '\\b(update|transition)\\b', any: [{ next: '^head\\b' }, { redirect: '^/dev/null$' }], not: { command: '\\btransition\\b', lacksFlag: '--transition-id' } }, message: 'm' });
  assert.equal(hidden.check(ctx('twg jira workitem update --id MED-1 | head')).action, 'deny');
  assert.equal(hidden.check(ctx('twg jira workitem update --id MED-1 > /dev/null')).action, 'deny');
  assert.equal(hidden.check(ctx('twg jira workitem transition --id MED-1 --transition-id 31 | head')).action, 'deny');
  assert.equal(hidden.check(ctx('twg jira workitem transition --id MED-1 | head')), null, 'lists transitions only');
  assert.equal(hidden.check(ctx('twg jira workitem update --id MED-1 > out.txt')), null);
  assert.equal(hidden.check(ctx('twg jira workitem get MED-1 | head')), null, 'a read');
});

test('data rule: deny with flags and stage position', () => {
  const r = compile({ id: 't.get-id', match: { name: 'twg', command: '\\bworkitem\\s+get\\b', hasFlag: '--id' }, message: 'positional keys' });
  assert.equal(r.check(ctx('twg jira workitem get --id MED-1'))?.action, 'deny');
  assert.equal(r.check(ctx('twg jira workitem get MED-1')), null);
  assert.equal(r.check(ctx('grep "workitem get --id" notes.md')), null, 'quoted text is not a command');
});

test('data rule: rewrite operations', () => {
  const run = (rewrite, match, cmd) => compile({ id: 'x', action: 'rewrite', match, rewrite }).check(ctx(cmd))?.command;
  assert.equal(run({ renameFlag: { from: '--destination', to: '--dest' } }, { name: 'twg', hasFlag: '--destination' }, 'twg bb pull-requests create --destination main'), 'twg bb pull-requests create --dest main');
  assert.equal(run({ dropFlag: '--id' }, { name: 'twg', hasFlag: '--id' }, 'twg jira workitem get --id MED-1 -o json'), 'twg jira workitem get -o json');
  assert.equal(run({ dropFlag: '--id', keepValue: true }, { name: 'twg', hasFlag: '--id' }, 'twg jira workitem get --id MED-1'), 'twg jira workitem get MED-1');
  assert.equal(run({ insertAfterName: ' --no-pager' }, { name: 'git' }, 'git log -1'), 'git --no-pager log -1');
  assert.equal(run({ replace: { find: '^tail\\s+-(\\d+)', with: 'tail -n $1' } }, { name: 'tail' }, 'cd x && tail -5 a b'), 'cd x && tail -n 5 a b');
});

test('data rule: next stage, redirect, whole-command and file path matches', () => {
  const hidden = compile({ id: 'h', match: { name: 'twg', command: '\\b(create|update)\\b', next: '^(grep|head|tail)\\b' }, message: 'm' });
  assert.ok(hidden.check(ctx('twg jira workitem create --x | grep key')));
  assert.equal(hidden.check(ctx('twg jira workitem create --x > out.txt')), null);
  const toNull = compile({ id: 'n', match: { name: 'twg', redirect: '^/dev/null$' }, message: 'm' });
  assert.ok(toNull.check(ctx('twg jira workitem update --x > /dev/null 2>&1')));
  const file = compile({ id: 'f', tools: ['Write'], match: { filePath: '\\.env$' }, message: 'm' });
  assert.ok(file.check(makeContext({ tool: 'Write', input: { file_path: 'C:\\repo\\.env' } })));
});

test('evaluate: shadow rules only report; rewrites apply before denies; scope filters', () => {
  const rules = [
    compile({ id: 'shadowed', match: { name: 'ls' }, state: 'shadow', message: 's' }),
    compile({ id: 'fix-tail', action: 'rewrite', match: { name: 'tail' }, rewrite: { replace: { find: '^tail\\s+-(\\d+)', with: 'tail -n $1' } }, message: 'r' }),
    compile({ id: 'no-short-tail', match: { name: 'tail', raw: '^tail\\s+-\\d' }, message: 'd' }),
    compile({ id: 'win-only', match: { name: 'ls' }, scope: { os: 'win32' }, message: 'w' }),
    compile({ id: 'portal-only', action: 'warn', match: { name: 'pnpm' }, scope: { cwd: '/web-app(/|$)' }, message: 'no turbo here' }),
  ];
  const a = evaluate(ctx('ls'), rules);
  assert.equal(a.decision, null);
  assert.deepEqual(a.hits.map((x) => [x.rule.id, Boolean(x.shadow)]), [['shadowed', true]]);
  const b = evaluate(ctx('tail -5 a b'), rules);
  assert.equal(b.command, 'tail -n 5 a b');
  assert.equal(b.decision, null, 'the rewritten command no longer trips the deny');
  const c = evaluate(makeContext({ tool: 'Bash', input: { command: 'pnpm turbo run x' }, cwd: 'D:\\src\\web-app', platform: 'linux' }), rules);
  assert.deepEqual(c.notes, ['[portal-only] no turbo here']);
  assert.equal(evaluate(ctx('ls', 'Bash', { platform: 'win32' }), rules).decision, 'deny');
});

test('a rule that throws never blocks', () => {
  const r = compile({ id: 'boom', check() { throw new Error('x'); } });
  assert.equal(evaluate(ctx('ls'), [r]).decision, null);
});

test('local data rules and guards load, and config overrides state', async () => {
  mkdirSync(join(h.env.ANTIBODY_HOME, 'rules'), { recursive: true });
  mkdirSync(join(h.env.ANTIBODY_HOME, 'guards'), { recursive: true });
  writeFileSync(join(h.env.ANTIBODY_HOME, 'rules', 'a.json'), JSON.stringify([{ id: 'local.a', match: { name: 'foo' }, message: 'm', cases: { fire: ['foo'], pass: ['bar'] } }]));
  writeFileSync(join(h.env.ANTIBODY_HOME, 'guards', 'g.mjs'), "export default { id: 'guard.g', check: (ctx) => /danger/.test(ctx.command) ? 'no' : null };");
  writeFileSync(join(h.env.ANTIBODY_HOME, 'config.json'), JSON.stringify({ ruleState: { 'local.a': 'shadow' } }));
  const { resetConfigCache } = await import('../lib/config.mjs');
  resetConfigCache();
  const { rules, errors } = await loadRules();
  assert.deepEqual(errors, []);
  const a = rules.find((r) => r.id === 'local.a');
  const g = rules.find((r) => r.id === 'guard.g');
  assert.equal(a.state, 'shadow');
  assert.deepEqual(g.tools, ['Bash', 'PowerShell']);
  assert.equal(evaluate(ctx('run danger'), rules).decision, 'deny');
  h.done();
});

test('dropFlag leaves the rest of the command exactly as it was', () => {
  const r = compile({ id: 'd', action: 'rewrite', match: { name: 'twg', hasFlag: '--id' }, rewrite: { dropFlag: '--id', keepValue: true } });
  assert.equal(r.check(ctx('twg get --id MED-1 --message "a  b"')).command, 'twg get MED-1 --message "a  b"');
  const end = compile({ id: 'e', action: 'rewrite', match: { name: 'twg', hasFlag: '--json' }, rewrite: { dropFlag: '--json', keepValue: true } });
  assert.equal(end.check(ctx('twg get "x  y" --json')).command, 'twg get "x  y"');
});
