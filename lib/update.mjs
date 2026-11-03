// The daily update check. Claude Code only updates a marketplace it was told to auto-update, so
// antibody looks for a newer release itself, at most once a day, and tells the person. It never
// installs anything: updating stays a step the person takes.
//
// The one network call is a GET of plugin.json from the repo's main branch, the same file
// `claude plugin update` reads. Nothing is sent but the request itself. Off with
// "updateCheck": false in config.json, ANTIBODY_NO_UPDATE_CHECK=1, or Claude Code's own
// CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PLUGIN_ROOT, config, ensureDir, paths } from './config.mjs';

export const REPO = 'MichaelLeeHobbs/antibody';
const URL = `https://raw.githubusercontent.com/${REPO}/main/.claude-plugin/plugin.json`;
export const CHANGELOG = `https://github.com/${REPO}/blob/main/CHANGELOG.md`;
const DAY = 864e5;

export const updateUrl = () => process.env.ANTIBODY_UPDATE_URL || URL;
const stateFile = () => join(paths().state, 'update.json');

export function installedVersion() {
  try { return JSON.parse(readFileSync(join(PLUGIN_ROOT, '.claude-plugin', 'plugin.json'), 'utf8')).version || null; } catch { return null; }
}

export function checkEnabled() {
  if (process.env.ANTIBODY_NO_UPDATE_CHECK || process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC) return false;
  return config().updateCheck !== false;
}

// 1 when a is newer than b, -1 when older, 0 when the same or either isn't x.y.z.
export function compareVersions(a, b) {
  const pa = String(a || '').match(/^(\d+)\.(\d+)\.(\d+)/);
  const pb = String(b || '').match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!pa || !pb) return 0;
  for (let i = 1; i <= 3; i++) if (Number(pa[i]) !== Number(pb[i])) return Number(pa[i]) > Number(pb[i]) ? 1 : -1;
  return 0;
}

export function readState() {
  try { return JSON.parse(readFileSync(stateFile(), 'utf8')); } catch { return {}; }
}

function writeState(s) {
  ensureDir(paths().state);
  writeFileSync(stateFile(), JSON.stringify(s));
}

export const due = (s = readState(), now = Date.now()) => !s.checkedAt || now - Date.parse(s.checkedAt) >= DAY;

// Fetch the latest version and save it. A failed check is saved too, so it isn't retried until tomorrow.
export async function refresh() {
  const s = { ...readState(), checkedAt: new Date().toISOString() };
  try {
    const res = await fetch(updateUrl(), { signal: AbortSignal.timeout(5000), headers: { 'user-agent': 'antibody-update-check' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const v = (await res.json()).version;
    if (!/^\d+\.\d+\.\d+/.test(String(v))) throw new Error('no version in plugin.json');
    Object.assign(s, { latest: v, error: undefined });
  } catch (e) {
    s.error = String(e.message || e).slice(0, 200);
  }
  writeState(s);
  return s;
}

export const UPDATE = 'claude plugin marketplace update antibody, then claude plugin update antibody@antibody';

// The message for a newer release, or null. Shown once a day at most, per new version.
export function notice({ now = Date.now(), mark = true } = {}) {
  const s = readState();
  const have = installedVersion();
  if (!s.latest || compareVersions(s.latest, have) <= 0) return null;
  if (s.toldVersion === s.latest && s.toldAt && now - Date.parse(s.toldAt) < DAY) return null;
  if (mark) writeState({ ...s, toldVersion: s.latest, toldAt: new Date(now).toISOString() });
  return `antibody ${s.latest} is out (you have ${have}). To update, run in a terminal: ${UPDATE}. What changed: ${CHANGELOG}`;
}
