// The daily update check. Claude Code only updates a marketplace it was told to auto-update, so
// antibody looks for a newer release itself, at most once a day, and tells the person. It never
// installs anything: updating stays a step the person takes.
//
// The one network call is a GET of plugin.json from the repo's main branch, the same file
// `claude plugin update` reads. Nothing is sent but the request itself. Off with
// "updateCheck": false in config.json, ANTIBODY_NO_UPDATE_CHECK=1, or Claude Code's own
// CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CLI, PLUGIN_ROOT, config, ensureDir, paths } from './config.mjs';

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
// The file is read again after the fetch: a session start or `whats-new --seen` may have written it
// meanwhile, and only this check's own fields should change.
export async function refresh() {
  const found = { checkedAt: new Date().toISOString() };
  try {
    const res = await fetch(updateUrl(), { signal: AbortSignal.timeout(5000), headers: { 'user-agent': 'antibody-update-check' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const v = (await res.json()).version;
    if (!/^\d+\.\d+\.\d+/.test(String(v))) throw new Error('no version in plugin.json');
    Object.assign(found, { latest: v, error: undefined });
  } catch (e) {
    found.error = String(e.message || e).slice(0, 200);
  }
  const s = { ...readState(), ...found };
  writeState(s);
  return s;
}

// The two update commands, one per line: each pastes as-is into PowerShell 5.1, cmd or bash, where a
// line joined with `&&` or strung into a sentence would not.
export const UPDATE_COMMANDS = ['claude plugin marketplace update antibody', 'claude plugin update antibody@antibody'];
// Updated hooks load only in a new session or after /reload-plugins, so the notice says so.
export const UPDATE = `To update, run these in your own terminal, then start a new Claude session:\n${UPDATE_COMMANDS.map((c) => `  ${c}`).join('\n')}`;
// Confirming a "By hand" step: the bare `antibody` works only in Claude's shell, so the person's own
// terminal gets the full path.
export const CONFIRM = `Once it's done, tell Claude (you approve one prompt), or run in your own terminal:\n  ${CLI} whats-new --seen`;

// A notice shows in the first few new sessions of each day, not only the first: a session that another
// session or a script started would otherwise use it up where nobody sees it. Counts in `s` (toldAt
// opens the day, toldCount counts within it) and says whether this session may be told.
export const TELLS_PER_DAY = 3;
export function mayTell(s, now = Date.now()) {
  const fresh = s.toldAt && now - Date.parse(s.toldAt) < DAY;
  const count = fresh ? s.toldCount || 1 : 0;
  if (count >= TELLS_PER_DAY) return false;
  if (!fresh) s.toldAt = new Date(now).toISOString();
  s.toldCount = count + 1;
  return true;
}

// What's new since the person last said they read it. A release can need a step by hand (the
// changelog's "By hand:" line), and a notice shown a few times a day can be used up by sessions nobody
// watches, so this one keeps showing at every session start until the person confirms with
// `antibody whats-new --seen`. seenVersion in update.json is the last release they confirmed.

// The last release before this notice existed: a data folder from then has no seenVersion yet.
const BEFORE_WHATS_NEW = '0.5.0';

// Changelog sections newer than `since`, up to `upto`, newest first: { version, text, byHand }.
// byHand is null when the release needs nothing done by hand.
export function changes(since, upto = installedVersion()) {
  let log;
  try { log = readFileSync(join(PLUGIN_ROOT, 'CHANGELOG.md'), 'utf8').replace(/\r\n/g, '\n'); } catch { return []; }
  const out = [];
  for (const part of log.split(/^(?=## )/m)) {
    const v = part.match(/^## (\d+\.\d+\.\d+)/)?.[1];
    if (!v || compareVersions(v, since) <= 0 || compareVersions(v, upto) > 0) continue;
    const hand = part.match(/^By hand:\s*(.+)$/m)?.[1].trim() || '';
    out.push({ version: v, text: part.trim(), byHand: /^nothing\b/i.test(hand) || !hand ? null : hand });
  }
  return out;
}

// The version the person last confirmed. A data folder with no events is a fresh install, which has
// nothing to catch up on; one with events predates this notice.
export function seenVersion(s = readState()) {
  if (s.seenVersion) return s.seenVersion;
  return existsSync(paths().events) ? BEFORE_WHATS_NEW : installedVersion();
}

export function markSeen(v = installedVersion()) {
  writeState({ ...readState(), seenVersion: v });
}

// The message after an update, or null. A release with something to do by hand shows at every session
// start until confirmed; one with nothing to do shows once and counts as read.
export function whatsNew() {
  if (!existsSync(paths().home)) return null;
  const s = readState();
  const have = installedVersion();
  const since = seenVersion(s);
  if (!s.seenVersion && compareVersions(since, have) === 0) markSeen(have);
  const list = changes(since, have);
  if (!list.length) return null;
  const todo = list.filter((c) => c.byHand);
  if (!todo.length) {
    markSeen(have);
    return `antibody was updated to ${have} (from ${since}); nothing to do by hand. What changed: ${CHANGELOG}`;
  }
  // A changelog's `antibody <command>` becomes the full form, which works in the person's own terminal.
  const steps = todo.map((c) => `${todo.length > 1 ? `${c.version}: ` : ''}${c.byHand.replace(/`antibody ([^`]+)`/g, (_, rest) => `\`${CLI} ${rest}\``)}`).join(' ');
  return `antibody is now ${have} and has a step for you${todo.length > 1 || todo[0].version === have ? '' : ` (from ${todo[0].version})`}: ${steps}\n${CONFIRM}\nThis shows at each session start until then.`;
}

// The message for a newer release, or null. A new version starts the count again.
export function notice({ now = Date.now(), mark = true } = {}) {
  const s = readState();
  const have = installedVersion();
  if (!s.latest || compareVersions(s.latest, have) <= 0) return null;
  if (s.toldVersion !== s.latest) delete s.toldAt;
  if (!mayTell(s, now)) return null;
  if (mark) writeState({ ...s, toldVersion: s.latest });
  return `antibody ${s.latest} is out (you have ${have}). ${UPDATE}\nWhat changed: ${CHANGELOG}`;
}
