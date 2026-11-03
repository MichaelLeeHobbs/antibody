// Prepares a release on a clean branch: bumps the version in package.json and plugin.json, dates the
// changelog's "Unreleased" heading, and writes the file manifest that `doctor` checks installs
// against. It changes files only; committing, merging and tagging stay manual, and it prints them.
//
//   npm run release -- 0.4.0
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MANIFEST, buildManifest } from '../lib/manifest.mjs';
import { compareVersions } from '../lib/update.mjs';

const root = process.env.ANTIBODY_RELEASE_ROOT || dirname(dirname(fileURLToPath(import.meta.url)));
const fail = (msg) => { process.stderr.write(msg + '\n'); process.exit(1); };
const git = (...a) => execFileSync('git', ['-C', root, ...a], { encoding: 'utf8' });
const read = (f) => readFileSync(join(root, f), 'utf8');

const next = process.argv[2] || fail('Usage: npm run release -- <x.y.z>');
if (!/^\d+\.\d+\.\d+$/.test(next)) fail(`"${next}" isn't x.y.z`);
const current = JSON.parse(read('.claude-plugin/plugin.json')).version;
if (compareVersions(next, current) <= 0) fail(`${next} isn't newer than ${current}`);
if (git('status', '--porcelain').trim()) fail('The working tree has changes; commit or stash them first, so the manifest matches what ships.');
const branch = git('rev-parse', '--abbrev-ref', 'HEAD').trim();
if (branch === 'main') fail('Run this on a release branch, not main.');

// Only the version line changes, so each file keeps its own formatting and line endings.
for (const f of ['package.json', '.claude-plugin/plugin.json']) {
  const text = read(f);
  const bumped = text.replace(/("version"\s*:\s*")[^"]+(")/, `$1${next}$2`);
  if (bumped === text) fail(`No version field in ${f}`);
  writeFileSync(join(root, f), bumped);
}

const log = read('CHANGELOG.md');
if (!/^## Unreleased\b.*$/m.test(log)) fail('CHANGELOG.md has no "## Unreleased" heading to date.');
writeFileSync(join(root, 'CHANGELOG.md'), log.replace(/^## Unreleased\b.*$/m, `## ${next} (${new Date().toISOString().slice(0, 10)})`));

const files = git('ls-files').split('\n').map((s) => s.trim()).filter(Boolean);
const manifest = buildManifest(root, files.includes(MANIFEST) ? files : [...files, MANIFEST], next);
writeFileSync(join(root, MANIFEST), JSON.stringify(manifest, null, 2) + '\n');

process.stdout.write(`antibody ${current} -> ${next} on ${branch}: package.json, plugin.json, CHANGELOG.md and ${MANIFEST} (${Object.keys(manifest.files).length} files).

Next, by hand:
  1. Read the changelog entry, then commit: git commit -am "Release ${next}"   (add ${MANIFEST} first if it's new)
  2. Push, open the PR, and merge it while the branch is up to date with main, so main ships exactly these files.
  3. Tag the merge commit: git fetch, then git tag v${next} <merge commit> and git push origin v${next}.
     (origin/main is the merge commit if nothing has merged since.) doctor --online checks installs against this tag.
Bumping the version on main is the release: Claude Code and antibody's update check both read main's plugin.json.
`);
