import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { call, cli, hook, tempHome } from './helpers.mjs';

test('init, doctor and test on a fresh install', () => {
  const h = tempHome();
  const init = cli(h.env, 'init', '--packs', 'git-bash-windows,windows-orphans');
  assert.equal(init.code, 0, init.err);
  assert.match(init.out, /learned\.md/);
  assert.match(init.out, /"deny"/);
  assert.match(init.out, /"Bash\(antibody \*\)"/, 'a permission entry that survives plugin updates');
  const doc = cli(h.env, 'doctor');
  assert.equal(doc.code, 0, doc.out + doc.err);
  const t = cli(h.env, 'test');
  assert.equal(t.code, 0, t.out);
  assert.match(t.out, /0 failing/);
  h.done();
});

test('permissions: lists missing entries, --apply backs up and adds only those', () => {
  const h = tempHome();
  cli(h.env, 'init');
  assert.doesNotMatch(cli(h.env, 'init').out, /Bash\(node /, 'no version-pinned entry');
  const dir = h.env.CLAUDE_CONFIG_DIR;
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'settings.json');
  const pinned = 'Bash(node "C:/u/.claude/plugins/cache/antibody/antibody/0.2.0/bin/antibody.mjs" *)';
  writeFileSync(file, JSON.stringify({ model: 'm', permissions: { allow: ['Bash(ls *)', 'Bash(antibody *)', pinned], deny: ['Edit(~/.claude/settings.json)'] } }));
  const dry = cli(h.env, 'permissions');
  assert.equal(dry.code, 0, dry.err);
  assert.match(dry.out, /\+ allow Edit\(.*issues/);
  assert.doesNotMatch(dry.out, /\+ allow Bash\(antibody/);
  assert.match(dry.out, /- Bash\(node /, 'points out the stale entry');
  assert.match(dry.out, /Nothing changed/);
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).permissions.allow.length, 3);
  const app = cli(h.env, 'permissions', '--apply');
  assert.equal(app.code, 0, app.err);
  assert.match(app.out, /Backed up to/);
  const j = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(j.model, 'm');
  assert.deepEqual(j.permissions.allow.slice(0, 3), ['Bash(ls *)', 'Bash(antibody *)', pinned], 'keeps existing entries in place');
  assert.equal(j.permissions.allow.length, 7);
  assert.equal(j.permissions.deny.length, 4);
  assert.equal(j.permissions.deny.filter((e) => e === 'Edit(~/.claude/settings.json)').length, 1);
  assert.match(cli(h.env, 'permissions', '--apply').out, /already there/);
  writeFileSync(file, '{ not json');
  const bad = cli(h.env, 'permissions', '--apply');
  assert.equal(bad.code, 1);
  assert.match(bad.err, /isn't valid JSON/);
  assert.equal(readFileSync(file, 'utf8'), '{ not json');
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

test('issue archive: clears the matcher, --project retires its rules', () => {
  const h = tempHome();
  cli(h.env, 'init');
  const f = join(h.dir, 'issue.md');
  writeFileSync(f, '---\n{"title":"pnpm add rewrites workspace links","when":{"tool":"Bash","command":"^pnpm add"},"fix":"read the lockfile diff"}\n---\n');
  cli(h.env, 'issue', 'add', f);
  const r = join(h.dir, 'r.json');
  writeFileSync(r, JSON.stringify({ id: 'x.pnpm', issue: 'AB-0001', match: { name: 'pnpm', command: '\\badd\\b' }, message: 'm', cases: { fire: ['pnpm add zod'], pass: ['pnpm install'] } }));
  assert.equal(cli(h.env, 'rule', 'add', r).code, 0);
  assert.match(cli(h.env, 'issue', 'archive', 'AB-0001').err, /Give the reason/);
  const out = cli(h.env, 'issue', 'archive', 'AB-0001', '--project', 'a the-portal version range, not a Claude failure');
  assert.equal(out.code, 0, out.err);
  assert.match(out.out, /archived as a project defect/);
  assert.match(out.out, /retired its rules: x\.pnpm/);
  assert.ok(!existsSync(join(h.env.ANTIBODY_HOME, 'issues', 'AB-0001.md')));
  const shown = cli(h.env, 'issue', 'show', 'AB-0001').out;
  assert.match(shown, /"cause": "project"/);
  assert.match(shown, /"whenWas"/);
  assert.match(cli(h.env, 'issues', '--all').out, /^project .*AB-0001/m);
  assert.match(cli(h.env, 'rules', '--state', 'retired').out, /x\.pnpm/);
  assert.match(cli(h.env, 'issue', 'fix', 'AB-0001', 'x').err, /archived by hand/);
  mkdirSync(join(h.env.ANTIBODY_HOME, 'guards'), { recursive: true });
  writeFileSync(join(h.dir, 'g.md'), '---\n{"title":"second"}\n---\n');
  cli(h.env, 'issue', 'add', join(h.dir, 'g.md'));
  writeFileSync(join(h.env.ANTIBODY_HOME, 'guards', 'g.mjs'), "export default { id: 'g.one', issue: 'AB-0002', check: () => null };\n");
  assert.match(cli(h.env, 'issue', 'archive', 'AB-0002', '--project', 'x').out, /retired its rules: g\.one/);
  assert.equal(JSON.parse(readFileSync(join(h.env.ANTIBODY_HOME, 'config.json'), 'utf8')).ruleState['g.one'], 'retired');
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

test('the antibody shims run the CLI', () => {
  const bin = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin');
  const sh = readFileSync(join(bin, 'antibody'), 'utf8');
  assert.ok(sh.startsWith('#!/bin/sh\n'), 'the sh shim keeps LF endings');
  const out = process.platform === 'win32'
    ? execFileSync('cmd.exe', ['/d', '/c', join(bin, 'antibody.cmd'), 'help'], { encoding: 'utf8' })
    : execFileSync('sh', [join(bin, 'antibody'), 'help'], { encoding: 'utf8' });
  assert.match(out, /^antibody: learn from/);
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
