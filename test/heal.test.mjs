// Approved tier-2 fixes without a hand edit: porting a local guard into data rules, and applying a
// review's proposal as a ready patch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { call, cli, hook, tempHome } from './helpers.mjs';

// A guard with two checks; the second has the kind of bug the review can't fix by itself: it blocks
// `comment --issue-id KEY --id <comment>`, which is right.
const GUARD = `export default { id: 'local.demo', action: 'deny', message: '', check(ctx) {
  const c = ctx.command || '';
  if (/\\bmytool\\s+get\\b/.test(c) && /\\s--id\\b/.test(c)) return 'get takes keys positionally';
  if (/\\bmytool\\s+comment\\b/.test(c) && /\\s--id\\b/.test(c)) return 'comment names the card with --issue-id';
  return null;
} };
`;

const RULES = [
  { id: 'demo.get-id', match: { name: 'mytool', command: '\\bget\\b', hasFlag: '--id' }, message: 'get takes keys positionally', cases: { fire: ['mytool get --id A-1'], pass: ['mytool get A-1'] } },
  { id: 'demo.comment-id', match: { name: 'mytool', command: '\\bcomment\\b', hasFlag: '--id', lacksFlag: '--issue-id' }, message: 'comment names the card with --issue-id', cases: { fire: ['mytool comment --id A-1 --body x'], pass: ['mytool comment --issue-id A-1 --id 7 --body x'] } },
];

function setup({ state } = {}) {
  const h = tempHome();
  cli(h.env, 'init');
  const home = h.env.ANTIBODY_HOME;
  writeFileSync(join(home, 'guards', 'demo.mjs'), GUARD);
  if (state) writeFileSync(join(home, 'config.json'), JSON.stringify({ packs: [], ruleState: { 'local.demo': state } }));
  const log = (command) => writeFileSync(join(home, 'events.jsonl'), JSON.stringify({ id: `e${Math.random().toString(36).slice(2, 12)}`, ts: new Date().toISOString(), kind: 'block', tool: 'Bash', cwd: '/repo', command }) + '\n', { flag: 'a' });
  const rules = (list, name = 'port.json') => { const f = join(h.dir, name); writeFileSync(f, JSON.stringify(list)); return f; };
  return { h, home, log, rules };
}

test('guard port: a dry run checks the rules against their cases, each other and the logged commands', () => {
  const { h, home, log, rules } = setup();
  log('mytool get --id B-2');
  log('ls -la');
  log('mytool comment --id C-3 --body x');
  const file = rules(RULES);
  const dry = cli(h.env, 'guard', 'port', 'local.demo', file);
  assert.equal(dry.code, 0, dry.out + dry.err);
  assert.match(dry.out, /ok {4}demo\.get-id {2}\(1 fire, 1 pass\)/);
  assert.match(dry.out, /ok {4}demo\.comment-id/);
  assert.match(dry.out, /guard deny -> rules allow {2}"mytool comment --issue-id A-1 --id 7 --body x" {2}\(demo\.comment-id\)/, 'the fix shows as a change a case asks for');
  assert.match(dry.out, /Replay: 3 other commands .* 0 verdicts differ/);
  assert.match(dry.out, /Dry run: nothing changed/);
  assert.equal(existsSync(join(home, 'rules', 'ported-demo.json')), false);
  assert.match(cli(h.env, 'guard', 'port', 'demo', file).out, /Porting local\.demo/, 'a guard can be named by its file');

  // A logged command the rules treat differently, with no case asking for it, blocks the port.
  log('mytool comment --issue-id B-2 --id 9 --body y');
  const diff = cli(h.env, 'guard', 'port', 'local.demo', file);
  assert.equal(diff.code, 1);
  assert.match(diff.out, /1 verdicts differ[\s\S]*FAIL {2}guard deny -> rules allow .*mytool comment --issue-id B-2 --id 9/);
  assert.match(diff.err, /Not ported/);
  assert.equal(cli(h.env, 'guard', 'port', 'local.demo', file, '--apply').code, 1, 'nothing applies while it differs');
  assert.equal(existsSync(join(home, 'rules', 'ported-demo.json')), false);

  // Naming the logged command as a case makes the change intended.
  const fixed = structuredClone(RULES);
  fixed[1].cases.pass.push('mytool comment --issue-id B-2 --id 9 --body y');
  assert.equal(cli(h.env, 'guard', 'port', 'local.demo', rules(fixed)).code, 0);

  // A rule that catches another rule's pass case, and a rule that misses a case, both fail.
  const clash = [...structuredClone(fixed), { id: 'demo.any-comment', match: { name: 'mytool', command: '\\bcomment\\b' }, message: 'm', cases: { fire: ['mytool comment x'], pass: ['mytool get A-1'] } }];
  const c = cli(h.env, 'guard', 'port', 'local.demo', rules(clash, 'clash.json'));
  assert.equal(c.code, 1);
  assert.match(c.out, /a pass case of demo\.comment-id, but demo\.any-comment catches it/);
  const miss = structuredClone(fixed);
  miss[0].cases.fire.push('mytool get A-1 --id');
  miss[0].cases.fire.push('mytool get A-2');
  const m = cli(h.env, 'guard', 'port', 'local.demo', rules(miss, 'miss.json'));
  assert.equal(m.code, 1);
  assert.match(m.out, /FAIL {2}demo\.get-id/);

  // Only data, with cases, and new ids.
  assert.match(cli(h.env, 'guard', 'port', 'local.demo', rules([{ ...RULES[0], cases: { fire: ['mytool get --id A'] } }], 'nocase.json')).err, /at least one "fire" and one "pass"/);
  assert.match(cli(h.env, 'guard', 'port', 'local.nope', file).err, /No local guard local\.nope\. Guards: local\.demo \(demo\.mjs\)/);
  h.done();
});

test('guard port --apply: the rules take the guard\'s state and the guard is retired', () => {
  const { h, home, log, rules } = setup();
  log('mytool get --id B-2');
  const app = cli(h.env, 'guard', 'port', 'local.demo', rules(RULES), '--apply');
  assert.equal(app.code, 0, app.out + app.err);
  assert.match(app.out, /added 2 rules \(enforce\) to rules\/ported-demo\.json/);
  assert.match(app.out, /local\.demo: enforce -> retired/);
  const saved = JSON.parse(readFileSync(join(home, 'rules', 'ported-demo.json'), 'utf8'));
  assert.deepEqual(saved.map((r) => [r.id, r.state, r.ported]), [['demo.get-id', 'enforce', 'local.demo'], ['demo.comment-id', 'enforce', 'local.demo']]);
  assert.equal(JSON.parse(readFileSync(join(home, 'config.json'), 'utf8')).ruleState['local.demo'], 'retired');
  assert.ok(existsSync(join(home, 'guards', 'demo.mjs')), 'the guard file stays');
  const pre = (command) => hook(h.env, { hook_event_name: 'PreToolUse', ...call('Bash', { command }) });
  assert.match(pre('mytool get --id X-1').permissionDecisionReason, /\[demo\.get-id\]/);
  assert.equal(pre('mytool comment --issue-id X-1 --id 4 --body z'), null, 'the guard\'s false positive is gone');
  assert.equal(cli(h.env, 'test').code, 0);
  assert.match(cli(h.env, 'guard', 'port', 'local.demo', rules(RULES)).err, /retired already/);
  h.done();

  // A guard in shadow ports into shadow rules.
  const s = setup({ state: 'shadow' });
  const sh = cli(s.h.env, 'guard', 'port', 'local.demo', s.rules(RULES), '--apply');
  assert.equal(sh.code, 0, sh.out + sh.err);
  assert.deepEqual(JSON.parse(readFileSync(join(s.home, 'rules', 'ported-demo.json'), 'utf8')).map((r) => r.state), ['shadow', 'shadow']);
  s.h.done();
});

function proposal(home, n, p) {
  const dir = join(home, 'reviews', 'proposals');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `2026-11-05-${n}.json`), JSON.stringify(p, null, 2));
}

test('apply: shows the diff, backs up, patches, records it, and is safe to run twice', () => {
  const { h, home } = setup();
  const md = join(h.env.CLAUDE_CONFIG_DIR, 'CLAUDE.md');
  mkdirSync(h.env.CLAUDE_CONFIG_DIR, { recursive: true });
  writeFileSync(md, '# Global\r\n\r\nUse `--to`.\r\n');
  const find = "if (/\\bmytool\\s+comment\\b/.test(c) && /\\s--id\\b/.test(c))";
  proposal(home, 2, {
    title: 'Stop local.demo blocking comment --issue-id KEY --id <comment>',
    issue: 'AB-0001',
    why: 'Disputed hit on 11-05.',
    edits: [
      { file: 'guards/demo.mjs', find, replace: "if (/\\bmytool\\s+comment\\b/.test(c) && /\\s--id\\b/.test(c) && !/\\s--issue-id\\b/.test(c))" },
      { file: '~/.claude/CLAUDE.md', find: 'Use `--to`.', replace: 'Use `--transition-id`.' },
    ],
  });
  const list = cli(h.env, 'apply');
  assert.match(list.out, /^open +2026-11-05 2 {2}Stop local\.demo/);
  const dry = cli(h.env, 'apply', '2026-11-05', '2', '--dry-run');
  assert.equal(dry.code, 0, dry.err);
  assert.match(dry.out, /--- guards\/demo\.mjs line 4\n-  if \(\/\\bmytool[^\n]*\n\+  if [^\n]*--issue-id/);
  assert.match(dry.out, /--- ~\/\.claude\/CLAUDE\.md line 3\n-Use `--to`\.\n\+Use `--transition-id`\./);
  assert.match(dry.out, /Dry run: nothing changed/);
  assert.equal(readFileSync(join(home, 'guards', 'demo.mjs'), 'utf8'), GUARD);

  const app = cli(h.env, 'apply', '2026-11-05', '2');
  assert.equal(app.code, 0, app.out + app.err);
  assert.match(app.out, /Backed up guards\/demo\.mjs to .*demo\.mjs\.antibody-backup-/);
  assert.match(app.out, /Applied 2 file\(s\)\. antibody test: \d+ rules, 0 failing/);
  assert.match(readFileSync(join(home, 'guards', 'demo.mjs'), 'utf8'), /!\/\\s--issue-id\\b\/\.test\(c\)/);
  assert.equal(readFileSync(md, 'utf8'), '# Global\r\n\r\nUse `--transition-id`.\r\n', 'keeps CRLF');
  assert.equal(readdirSync(join(home, 'guards')).filter((f) => f.includes('antibody-backup')).length, 1);
  assert.equal(hook(h.env, { hook_event_name: 'PreToolUse', ...call('Bash', { command: 'mytool comment --issue-id A --id 3' }) }), null, 'the patched guard runs');
  assert.match(JSON.parse(readFileSync(join(home, 'reviews', 'proposals', '2026-11-05-2.json'), 'utf8')).applied, /^\d{4}-/);
  assert.match(readFileSync(join(home, 'events.jsonl'), 'utf8'), /applied review proposal 2026-11-05 #2/);
  assert.match(cli(h.env, 'apply').out, /applied \d{4}-\d{2}-\d{2} {2}2026-11-05 2/);
  const again = cli(h.env, 'apply', '2026-11-05', '2');
  assert.equal(again.code, 0);
  assert.match(again.out, /= guards\/demo\.mjs: already applied[\s\S]*Already applied; nothing to change/);
  h.done();
});

test('apply: refuses stale patches and protected targets, and puts files back when test gets worse', () => {
  const { h, home } = setup();
  proposal(home, 1, { title: 'stale', edits: [{ file: 'guards/demo.mjs', find: 'not in the file', replace: 'x' }] });
  const stale = cli(h.env, 'apply', '2026-11-05', '1');
  assert.equal(stale.code, 1);
  assert.match(stale.err, /found 0 times, not once; the file changed since the review/);
  for (const [n, file] of [[2, '~/.claude/settings.json'], [3, '~/.claude/plugins/cache/antibody/x.mjs'], [4, 'events.jsonl'], [5, '../../outside.txt'], [6, 'C:/Windows/x.txt']]) {
    proposal(home, n, { title: 't', edits: [{ file, find: 'a', replace: 'b' }] });
    const r = cli(h.env, 'apply', '2026-11-05', String(n));
    assert.equal(r.code, 1, file);
    assert.match(r.err, /never patched|outside ~\/\.claude|relative to the data folder/, file);
  }
  assert.match(cli(h.env, 'apply', '2026-11-05', '9').err, /No proposal 2026-11-05 #9/);
  assert.match(cli(h.env, 'apply', 'yesterday', '1').err, /Usage: apply <review date> <n>/);

  // A patch that breaks a rule's own cases is undone.
  const bad = { id: 'demo.broken', match: { name: 'mytool' }, message: 'm', cases: { fire: ['other'], pass: ['ls'] } };
  proposal(home, 7, { title: 'adds a broken rule', edits: [{ file: 'rules/broken.json', content: JSON.stringify(bad) }, { file: 'guards/demo.mjs', find: 'get takes keys positionally', replace: 'get takes keys as arguments' }] });
  const worse = cli(h.env, 'apply', '2026-11-05', '7');
  assert.equal(worse.code, 1);
  assert.match(worse.err, /antibody test got worse .* the files are back as they were/);
  assert.equal(existsSync(join(home, 'rules', 'broken.json')), false);
  assert.equal(readFileSync(join(home, 'guards', 'demo.mjs'), 'utf8'), GUARD);
  assert.equal(JSON.parse(readFileSync(join(home, 'reviews', 'proposals', '2026-11-05-7.json'), 'utf8')).applied, undefined);
  h.done();
});

test('apply asks a person before a session runs it, and refuses in auto mode', () => {
  const h = tempHome();
  cli(h.env, 'init');
  const pre = (command, mode) => hook(h.env, { hook_event_name: 'PreToolUse', ...call('Bash', { command }, { permission_mode: mode }) });
  assert.equal(pre('antibody apply 2026-11-05 2', 'default').permissionDecision, 'ask');
  assert.equal(pre('antibody apply 2026-11-05 2', 'auto').permissionDecision, 'deny');
  assert.equal(pre('antibody apply 2026-11-05 2 --dry-run', 'auto'), null);
  assert.equal(pre('antibody apply', 'auto'), null);
  assert.equal(pre('antibody guard port legacy.twg r.json --apply', 'auto'), null, 'porting to data rules is the review\'s own work');
  h.done();
});
