import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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

test('a failed check is reported and not retried until tomorrow', () => {
  const h = tempHome();
  const r = cli(h.env, 'update-check');
  assert.equal(r.code, 1);
  assert.match(r.err, /Couldn't check for updates/);
  const s = JSON.parse(readFileSync(join(h.env.ANTIBODY_HOME, 'state', 'update.json'), 'utf8'));
  assert.ok(s.checkedAt && s.error);
  h.done();
});

test('session start names a newer release once a day, and stays quiet when off or current', () => {
  const h = tempHome();
  writeState(h, { checkedAt: new Date().toISOString(), latest: '99.0.0' });
  const first = start(h.env);
  assert.match(first.systemMessage, new RegExp(`antibody 99\\.0\\.0 is out \\(you have ${VERSION.replace(/\./g, '\\.')}\\)`));
  assert.equal(start(h.env), null, 'told once today');
  writeState(h, { checkedAt: new Date().toISOString(), latest: VERSION });
  assert.equal(start(h.env), null, 'nothing newer');
  writeState(h, { checkedAt: new Date().toISOString(), latest: '99.0.0' });
  assert.equal(start({ ...h.env, ANTIBODY_NO_UPDATE_CHECK: '1' }), null, 'switched off by env');
  writeFileSync(join(h.env.ANTIBODY_HOME, 'config.json'), JSON.stringify({ updateCheck: false }));
  assert.equal(start(h.env), null, 'switched off in config');
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
