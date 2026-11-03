import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT, cli, tempHome } from './helpers.mjs';
import { MANIFEST, buildManifest, readManifest, sameFiles, verifyFiles } from '../lib/manifest.mjs';

const git = (dir, ...a) => {
  const r = spawnSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'core.autocrlf=false', ...a], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
};
const release = (dir, ...a) => spawnSync(process.execPath, [join(ROOT, 'scripts', 'release.mjs'), ...a], { env: { ...process.env, ANTIBODY_RELEASE_ROOT: dir }, encoding: 'utf8' });

function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'antibody-release-'));
  mkdirSync(join(dir, '.claude-plugin'));
  mkdirSync(join(dir, 'lib'));
  writeFileSync(join(dir, 'package.json'), '{\n  "name": "antibody",\n  "version": "0.3.0"\n}\n');
  writeFileSync(join(dir, '.claude-plugin', 'plugin.json'), '{\n  "name": "antibody",\n  "version": "0.3.0"\n}\n');
  writeFileSync(join(dir, 'CHANGELOG.md'), '# Changelog\n\n## Unreleased (0.4.0)\n\n- new\n\n## 0.3.0 (2026-11-02)\n');
  writeFileSync(join(dir, 'lib', 'a.mjs'), 'export const a = 1;\n');
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'init');
  return dir;
}

test('release bumps both versions, dates the changelog and writes a manifest that verifies', () => {
  const dir = repo();
  try {
    assert.match(release(dir, '0.4.0').stderr, /release branch, not main/);
    git(dir, 'switch', '-q', '-c', 'release-0.4.0');
    assert.match(release(dir, '0.3.0').stderr, /isn't newer/);
    writeFileSync(join(dir, 'stray.txt'), 'x');
    assert.match(release(dir, '0.4.0').stderr, /working tree has changes/);
    rmSync(join(dir, 'stray.txt'));
    const r = release(dir, '0.4.0');
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /0\.3\.0 -> 0\.4\.0/);
    assert.equal(JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).version, '0.4.0');
    assert.equal(JSON.parse(readFileSync(join(dir, '.claude-plugin', 'plugin.json'), 'utf8')).version, '0.4.0');
    assert.match(readFileSync(join(dir, 'CHANGELOG.md'), 'utf8'), /^## 0\.4\.0 \(\d{4}-\d{2}-\d{2}\)$/m);
    const m = readManifest(dir);
    assert.equal(m.version, '0.4.0');
    assert.ok(m.files['lib/a.mjs'] && m.files['CHANGELOG.md'] && !m.files[MANIFEST]);
    assert.deepEqual(verifyFiles(dir), { version: '0.4.0', changed: [], missing: [] });
    writeFileSync(join(dir, 'lib', 'a.mjs'), 'export const a = 1;\r\n');
    assert.deepEqual(verifyFiles(dir).changed, [], 'CRLF checkouts still match');
    writeFileSync(join(dir, 'lib', 'a.mjs'), 'export const a = 2;\n');
    rmSync(join(dir, 'CHANGELOG.md'));
    assert.deepEqual(verifyFiles(dir), { version: '0.4.0', changed: ['lib/a.mjs'], missing: ['CHANGELOG.md'] });
    assert.ok(sameFiles(m, buildManifest(dir, ['package.json'], '0.4.0')) === false);
    assert.ok(sameFiles(m, JSON.parse(JSON.stringify(m))));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('doctor says when there is no manifest to check against', () => {
  const h = tempHome();
  cli(h.env, 'init');
  const d = cli(h.env, 'doctor');
  assert.equal(d.code, 0, d.out);
  assert.match(d.out, readManifest(ROOT) ? /plugin files|differ from/ : /no release file manifest/);
  h.done();
});
