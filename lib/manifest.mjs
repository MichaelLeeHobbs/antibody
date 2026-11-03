// The release file manifest: a SHA-256 for every shipped file, written by scripts/release.mjs and
// checked by `doctor`. Line endings are folded to LF before hashing, because a Windows install
// checks the files out with CRLF.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const MANIFEST = '.claude-plugin/files.json';

export const hashFile = (abs) => createHash('sha256').update(readFileSync(abs).toString('latin1').replace(/\r\n/g, '\n'), 'latin1').digest('hex');

export function buildManifest(root, files, version) {
  const out = {};
  for (const f of [...files].sort()) if (f !== MANIFEST) out[f] = hashFile(join(root, f));
  return { version, files: out };
}

export function readManifest(root) {
  try { return JSON.parse(readFileSync(join(root, MANIFEST), 'utf8')); } catch { return null; }
}

// Files that differ from the manifest, or are missing. Extra files (Claude Code's own markers) don't count.
export function verifyFiles(root, manifest = readManifest(root)) {
  if (!manifest) return null;
  const changed = [];
  const missing = [];
  for (const [f, sha] of Object.entries(manifest.files || {})) {
    const abs = join(root, f);
    if (!existsSync(abs)) missing.push(f);
    else if (hashFile(abs) !== sha) changed.push(f);
  }
  return { version: manifest.version, changed, missing };
}

// Same set of files with the same hashes.
export const sameFiles = (a, b) => JSON.stringify(Object.entries(a?.files || {}).sort()) === JSON.stringify(Object.entries(b?.files || {}).sort());
