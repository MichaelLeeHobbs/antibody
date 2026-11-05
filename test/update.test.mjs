import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { CLI, HOOK, ROOT, call, cli, hook, tempHome } from './helpers.mjs';
import { compareVersions } from '../lib/update.mjs';

const VERSION = JSON.parse(readFileSync(join(ROOT, '.claude-plugin', 'plugin.json'), 'utf8')).version;

function start(env) {
  const r = spawnSync(process.execPath, [HOOK], { input: JSON.stringify({ hook_event_name: 'SessionStart', source: 'startup', session_id: 's1' }), env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout ? JSON.parse(r.stdout) : null;
}

const writeState = (h, s) => {
  mkdirSync(join(h.env.ANTIBODY_HOME, 'state'), { recursive: true });
  writeFileSync(join(h.env.ANTIBODY_HOME, 'state', 'update.json'), JSON.stringify(s));
};

test('a release names one version everywhere', () => {
  const read = (...p) => readFileSync(join(ROOT, ...p), 'utf8');
  assert.equal(JSON.parse(read('package.json')).version, VERSION, 'package.json and plugin.json agree');
  assert.ok(JSON.parse(read('.claude-plugin', 'marketplace.json')).plugins.every((p) => p.version === undefined), 'only plugin.json sets the version');
  assert.match(read('CHANGELOG.md'), new RegExp(`^## ${VERSION.replace(/\./g, '\\.')} `, 'm'), 'the changelog has a heading for it');
});

test('compareVersions', () => {
  assert.equal(compareVersions('0.10.0', '0.9.9'), 1);
  assert.equal(compareVersions('0.3.0', '0.4.0'), -1);
  assert.equal(compareVersions('1.2.3', '1.2.3'), 0);
  assert.equal(compareVersions('junk', '1.0.0'), 0);
});

test('update-check reads the latest version and says what to run', async () => {
  const server = createServer((req, res) => res.end(JSON.stringify({ name: 'antibody', version: '99.0.0' })));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const h = tempHome();
  const env = { ...h.env, ANTIBODY_UPDATE_URL: `http://127.0.0.1:${server.address().port}/plugin.json` };
  try {
    const { stdout } = await promisify(execFile)(process.execPath, [CLI, 'update-check'], { env, encoding: 'utf8' });
    assert.match(stdout, /antibody 99\.0\.0 is out/);
    assert.match(stdout, /claude plugin update antibody@antibody/);
    assert.match(cli(env, 'doctor').out, /note  antibody 99\.0\.0 is out/);
  } finally {
    server.close();
    h.done();
  }
});

test('an update check in flight keeps a confirmation written meanwhile', async () => {
  const h = tempHome();
  writeState(h, { seenVersion: '0.1.0', toldCount: 1 });
  // The confirmation lands while the request is out.
  const server = createServer((req, res) => {
    writeState(h, { seenVersion: '9.9.9', toldCount: 2 });
    res.end(JSON.stringify({ version: '99.0.0' }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    await promisify(execFile)(process.execPath, [CLI, 'update-check', '--quiet'], { env: { ...h.env, ANTIBODY_UPDATE_URL: `http://127.0.0.1:${server.address().port}/plugin.json` } });
    const s = JSON.parse(readFileSync(join(h.env.ANTIBODY_HOME, 'state', 'update.json'), 'utf8'));
    assert.equal(s.latest, '99.0.0');
    assert.equal(s.seenVersion, '9.9.9');
    assert.equal(s.toldCount, 2);
  } finally {
    server.close();
    h.done();
  }
});

test('a failed check is reported and not retried until tomorrow', () => {
  const h = tempHome();
  const r = cli(h.env, 'update-check');
  assert.equal(r.code, 1);
  assert.match(r.err, /Couldn't check for updates/);
  const s = JSON.parse(readFileSync(join(h.env.ANTIBODY_HOME, 'state', 'update.json'), 'utf8'));
  assert.ok(s.checkedAt && s.error);
  h.done();
});

test('session start names a newer release in three sessions a day, and stays quiet when off or current', () => {
  const h = tempHome();
  writeState(h, { checkedAt: new Date().toISOString(), latest: '99.0.0' });
  const first = start(h.env);
  assert.match(first.systemMessage, new RegExp(`antibody 99\\.0\\.0 is out \\(you have ${VERSION.replace(/\./g, '\\.')}\\)`));
  assert.equal(first.hookSpecificOutput.hookEventName, 'SessionStart');
  assert.match(first.hookSpecificOutput.additionalContext, /antibody 99\.0\.0 is out[\s\S]*end of your first reply/, 'Claude gets it too, for the desktop app');
  assert.ok(start(h.env) && start(h.env), 'second and third sessions');
  assert.equal(start(h.env), null, 'told three times today');
  writeState(h, { checkedAt: new Date().toISOString(), latest: '99.0.1', toldVersion: '99.0.0', toldAt: new Date().toISOString(), toldCount: 3 });
  assert.match(start(h.env).systemMessage, /99\.0\.1 is out/, 'a newer version starts the count again');
  writeState(h, { checkedAt: new Date().toISOString(), latest: '99.0.0', toldVersion: '99.0.0', toldAt: new Date(Date.now() - 2 * 864e5).toISOString(), toldCount: 3 });
  assert.ok(start(h.env), 'a new day starts the count again');
  writeState(h, { checkedAt: new Date().toISOString(), latest: VERSION });
  assert.equal(start(h.env), null, 'nothing newer');
  writeState(h, { checkedAt: new Date().toISOString(), latest: '99.0.0' });
  assert.equal(start({ ...h.env, ANTIBODY_NO_UPDATE_CHECK: '1' }), null, 'switched off by env');
  writeFileSync(join(h.env.ANTIBODY_HOME, 'config.json'), JSON.stringify({ updateCheck: false }));
  assert.equal(start(h.env), null, 'switched off in config');
  h.done();
});

test('session start reminds about an overdue review, in three sessions a day', () => {
  const h = tempHome();
  const home = h.env.ANTIBODY_HOME;
  const env = { ...h.env, ANTIBODY_NO_UPDATE_CHECK: '1' };
  mkdirSync(join(home, 'state'), { recursive: true });
  writeFileSync(join(home, 'events.jsonl'), '');
  assert.equal(start(env), null, 'a fresh install gets two days');
  const ago = (d) => new Date(Date.now() - d * 864e5).toISOString();
  writeFileSync(join(home, 'state', 'review.json'), JSON.stringify({ firstSeen: ago(3) }));
  assert.match(start(env).systemMessage, /review last ran never/);
  assert.match(start(env).hookSpecificOutput.additionalContext, /review last ran never/);
  assert.ok(start(env));
  assert.equal(start(env), null, 'told three times today');
  mkdirSync(join(home, 'reviews'), { recursive: true });
  writeFileSync(join(home, 'reviews', `${ago(5).slice(0, 10)}.md`), 'x');
  writeFileSync(join(home, 'state', 'review.json'), JSON.stringify({ firstSeen: ago(30) }));
  assert.match(start(env).systemMessage, new RegExp(`review last ran ${ago(5).slice(0, 10)}`));
  writeFileSync(join(home, 'reviews', `${new Date().toISOString().slice(0, 10)}.md`), 'x');
  writeFileSync(join(home, 'state', 'review.json'), JSON.stringify({ firstSeen: ago(30) }));
  assert.equal(start(env), null, 'reviewed today');
  writeFileSync(join(home, 'config.json'), JSON.stringify({ reviewReminder: false }));
  rmSync(join(home, 'reviews'), { recursive: true });
  assert.equal(start(env), null, 'switched off in config');
  h.done();
});

test('bug drafts a report without home paths, and submit needs a title and a person', () => {
  const h = tempHome();
  cli(h.env, 'init');
  hook(h.env, { hook_event_name: 'PostToolUseFailure', ...call('Bash', { command: `cat ${homedir()}/secret-project/x.txt` }), error: 'Exit code 1\nno such file' });
  const id = JSON.parse(readFileSync(join(h.env.ANTIBODY_HOME, 'events.jsonl'), 'utf8').trim().split('\n').at(-1)).id;
  const out = join(h.dir, 'bug.md');
  const r = cli(h.env, 'bug', '--event', id, '--out', out);
  assert.equal(r.code, 0, r.err);
  const draft = readFileSync(out, 'utf8');
  assert.match(draft, /## What happened/);
  assert.match(draft, new RegExp(`antibody ${VERSION.replace(/\./g, '\\.')}`));
  assert.match(draft, /~\/secret-project/);
  assert.ok(!draft.includes(homedir()) && !draft.includes(homedir().replace(/\\/g, '/')), 'no home folder');
  assert.doesNotMatch(draft, /test-session/, 'no session id');
  assert.match(cli(h.env, 'bug', '--submit', out).err, /--title/);
  const pre = hook(h.env, { hook_event_name: 'PreToolUse', ...call('Bash', { command: `antibody bug --submit ${out} --title x` }, { permission_mode: 'auto' }) });
  assert.equal(pre.permissionDecision, 'deny', 'no person in auto mode');
  assert.equal(hook(h.env, { hook_event_name: 'PreToolUse', ...call('Bash', { command: `antibody bug --submit ${out} --title x` }, { permission_mode: 'default' }) }).permissionDecision, 'ask');
  h.done();
});

// A copy of the plugin at a pretend version, with a changelog of its own.
function fakePlugin(h, version, log) {
  const root = join(h.dir, 'plugin');
  mkdirSync(join(root, '.claude-plugin'), { recursive: true });
  writeFileSync(join(root, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'antibody', version }));
  writeFileSync(join(root, 'CHANGELOG.md'), log);
  return { ...h.env, CLAUDE_PLUGIN_ROOT: root, ANTIBODY_NO_UPDATE_CHECK: '1' };
}

const LOG = '# Changelog\r\n\r\n## Unreleased\r\n\r\n- next\r\n\r\nBy hand: later.\r\n\r\n## 0.7.0 (2026-12-01)\r\n\r\n- seven\r\n\r\nBy hand: nothing.\r\n\r\n## 0.6.0 (2026-11-10)\r\n\r\n- six\r\n\r\nBy hand: make the review daily.\r\n\r\n## 0.5.0 (2026-11-03)\r\n\r\n- five\r\n\r\nBy hand: nothing.\r\n';

test('what\'s new with a step by hand shows in every session until the person confirms it', () => {
  const h = tempHome();
  const env = fakePlugin(h, '0.7.0', LOG);
  mkdirSync(h.env.ANTIBODY_HOME, { recursive: true });
  writeFileSync(join(h.env.ANTIBODY_HOME, 'events.jsonl'), '');
  for (let i = 0; i < 5; i++) {
    const m = start(env);
    assert.match(m.systemMessage, /updated to 0\.7\.0 \(from 0\.5\.0\) and needs a step by hand\. 0\.6\.0: make the review daily\./, `session ${i + 1}`);
    assert.doesNotMatch(m.systemMessage, /later/, 'Unreleased is not a release');
    assert.match(m.hookSpecificOutput.additionalContext, /only after the person says they've read/);
  }
  assert.match(cli(env, 'doctor').out, /note  0\.6\.0 need\(s\) a step by hand/);
  const notes = cli(env, 'whats-new').out;
  assert.match(notes, /## 0\.7\.0[\s\S]*## 0\.6\.0[\s\S]*whats-new --seen/);
  assert.doesNotMatch(notes, /## 0\.5\.0/);
  assert.match(cli(env, 'whats-new', '--all').out, /## 0\.5\.0/);
  const pre = (mode) => hook(h.env, { hook_event_name: 'PreToolUse', ...call('Bash', { command: 'antibody whats-new --seen' }, { permission_mode: mode }) });
  assert.equal(pre('auto').permissionDecision, 'deny', 'no person in auto mode');
  assert.equal(pre('default').permissionDecision, 'ask');
  assert.match(cli(env, 'whats-new', '--seen').out, /Marked antibody 0\.7\.0/);
  assert.equal(start(env), null, 'confirmed');
  assert.doesNotMatch(cli(env, 'doctor').out, /step by hand/);
  assert.match(cli(env, 'whats-new').out, /Nothing new since 0\.7\.0/);
  h.done();
});

test('what\'s new with nothing by hand shows once; a fresh install has nothing to catch up on', () => {
  const h = tempHome();
  const home = h.env.ANTIBODY_HOME;
  let env = fakePlugin(h, '0.7.0', LOG);
  writeState(h, { seenVersion: '0.6.0' });
  assert.match(start(env).systemMessage, /updated to 0\.7\.0 \(from 0\.6\.0\); nothing to do by hand/);
  assert.equal(start(env), null, 'shown once');
  rmSync(home, { recursive: true });
  assert.equal(start(env), null, 'no data folder, no notice');
  assert.equal(cli(env, 'init').code, 0);
  assert.equal(start(env), null, 'init counts as caught up');
  env = fakePlugin(h, '0.8.0', LOG.replace('## Unreleased', '## 0.8.0 (2027-01-01)'));
  assert.match(start(env).systemMessage, /updated to 0\.8\.0 \(from 0\.7\.0\) and needs a step by hand\. 0\.8\.0: later\./);
  h.done();
});

test('schedule leads with the desktop app and prints a PowerShell-safe Windows command', () => {
  const h = tempHome();
  const out = cli({ ...h.env, ANTIBODY_HOME: join(h.dir, "it's here") }, 'schedule').out;
  assert.match(out, /desktop app[\s\S]*\/antibody:review/);
  assert.match(out, /claude setup-token/);
  if (process.platform === 'win32') {
    assert.match(out, /Register-ScheduledTask .*-WorkingDirectory '.*it''s here'/);
    assert.doesNotMatch(out, /\\"/, 'no cmd.exe-style escapes');
  }
  h.done();
});
