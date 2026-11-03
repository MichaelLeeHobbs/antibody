// The event log: one JSON line per thing worth learning from. Only antibody's hooks and CLI write it.
//
// kinds: failure (a tool call errored), interrupt (the person pressed stop), timeout, stall (a
// background task was killed), slow (a call ran past slowMs), block / rewrite / warn (a rule acted),
// shadow (a rule in shadow mode would have acted), recovery (a later call that worked after a
// failure), note (what a session says fixed it), stale-plan (a milestone landed while the task list
// had gone stale).
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { config, ensureDir, paths } from './config.mjs';
import { stages, subcommands, dialectFor } from './shell.mjs';

const MAX = 2000;

const SECRETS = [
  /\b(AKIA|ASIA)[0-9A-Z]{16}\b/g, // AWS access key ids
  /\bATATT[0-9A-Za-z_\-=]{20,}/g, // Atlassian API tokens
  /\bgh[pousr]_[0-9A-Za-z]{30,}\b/g, // GitHub tokens
  /\bxox[abprs]-[0-9A-Za-z-]{10,}/g, // Slack tokens
  /\bsk-[A-Za-z0-9_-]{20,}/g, // API keys in the sk- style
  /\beyJ[0-9A-Za-z_-]{10,}\.[0-9A-Za-z_-]{10,}\.[0-9A-Za-z_-]{10,}/g, // JWTs
  /(Bearer\s+)[0-9A-Za-z._~+/-]{16,}=*/gi,
  /((?:password|passwd|secret|token|api[_-]?key)["']?\s*[:=]\s*["']?)[^\s"',;]{6,}/gi,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];

export function redact(text) {
  if (typeof text !== 'string') return text;
  let out = text;
  for (const re of SECRETS) out = out.replace(re, (m, keep) => (typeof keep === 'string' && m.startsWith(keep) ? keep : '') + '[REDACTED]');
  for (const src of config().redact || []) {
    try { out = out.replace(new RegExp(src, 'g'), '[REDACTED]'); } catch {}
  }
  return out;
}

// Object keys whose values are credentials whatever they look like ({ api_key: "..." }, { authToken: 1234 }).
const SENSITIVE_KEY = /(^|_|-)(password|passwd|pwd|secret|token|api_?key|access_?key|secret_?key|auth|authorization|credentials?|private_?key|cookie|client_?secret)$/i;
export const sensitiveKey = (k) => SENSITIVE_KEY.test(String(k).replace(/([a-z0-9])([A-Z])/g, '$1_$2'));

export function trim(v) {
  if (typeof v === 'string') {
    const r = redact(v);
    return r.length > MAX ? r.slice(0, MAX) + `…[+${r.length - MAX} chars]` : r;
  }
  if (Array.isArray(v)) return v.map(trim);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, sensitiveKey(k) && x !== null && typeof x !== 'object' && x !== '' ? '[REDACTED]' : trim(x)]));
  return v;
}

export const newId = () => 'e' + Date.now().toString(36) + randomBytes(2).toString('hex');

// Runs from a test or by hand (no session id) are not real traffic; they never reach the real log.
export function isRealTraffic(input) {
  return Boolean(input && input.session_id) && !process.env.ANTIBODY_DRY_RUN;
}

// Returns the event as written: redacted and trimmed, so whatever a caller keeps from it is safe too.
export function append(event) {
  const e = trim({ id: newId(), ts: new Date().toISOString(), ...event });
  try {
    ensureDir(paths().home);
    appendFileSync(paths().events, JSON.stringify(e) + '\n');
  } catch {}
  return e;
}

export function readEvents({ since, kinds } = {}) {
  const file = paths().events;
  if (!existsSync(file)) return [];
  const out = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (since && new Date(e.ts) < since) continue;
    if (kinds && !kinds.includes(e.kind)) continue;
    out.push(e);
  }
  // Oldest first. `rotate` can put older lines after newer ones, so order by time, not by position.
  return out.map((e, i) => [e, i]).sort((a, b) => (Date.parse(a[0].ts) || 0) - (Date.parse(b[0].ts) || 0) || a[1] - b[1]).map((x) => x[0]);
}

export function errorText(input) {
  const v = input.error ?? input.tool_response ?? '';
  return typeof v === 'string' ? v : JSON.stringify(v);
}

export function exitCode(text) {
  const m = String(text).match(/^Exit code (\d+)/m);
  return m ? Number(m[1]) : null;
}

const ERRORISH = /\b(error|fatal|failed|failure|not found|no such|invalid|denied|refused|unknown|cannot|can't|unable|missing|unexpected|expected|usage:|EPERM|ENOENT|EACCES|EADDRINUSE|timed? ?out)\b/i;

// The line of an error that says what went wrong, normalised so repeats group together.
export function keyLine(text) {
  const lines = String(text).split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !/^Exit code \d+$/.test(l));
  const hit = lines.find((l) => ERRORISH.test(l)) || lines[lines.length - 1] || '';
  return hit
    .replace(/[A-Za-z]:[\\/][^\s'"]*|(?:~|\.{0,2})\/[^\s'"]+/g, '<path>')
    .replace(/\b[0-9a-f]{7,40}\b/g, '<hash>')
    .replace(/\d+/g, 'N')
    .slice(0, 140);
}

// What a command is, for grouping: the command name and its subcommands, from the stage that
// most likely failed (the first stage of the last pipeline, skipping `cd`, `echo` and friends).
const BORING = new Set(['cd', 'echo', 'export', 'set', 'printf', 'true', 'mkdir', 'pwd', 'sleep', 'test', '[', 'ls', 'cat', 'head', 'tail', 'grep', 'wc', 'cut', 'sort', 'uniq']);
export function commandHead(tool, command) {
  if (typeof command !== 'string') return tool;
  const list = stages(command, dialectFor(tool)).filter((s) => s.index === 0);
  const pick = [...list].reverse().find((s) => s.name && !BORING.has(s.name)) || list[list.length - 1];
  if (!pick || !pick.name) return tool;
  return [pick.name, ...subcommands(pick, 3)].join(' ');
}

export function signature(tool, command, text) {
  return `${tool} | ${commandHead(tool, command)} | ${keyLine(text)}`;
}

// A non-zero exit that is not a failure: a chain whose last command is a search or test that
// found nothing, while the output shows the earlier commands did their job.
export function isNoise(tool, command, text) {
  if (tool !== 'Bash' && tool !== 'PowerShell') return false;
  if (typeof command !== 'string') return false;
  const code = exitCode(text);
  if (code !== 1) return false;
  const all = stages(command, dialectFor(tool));
  if (!all.length) return false;
  const body = String(text).replace(/^Exit code \d+\s*/, '');
  if (ERRORISH.test(body)) return false;
  // The status comes from the last command, or from a test just before an `&& echo` that never ran.
  let k = all.length - 1;
  if (/^(echo|printf)$/.test(all[k].name) && k > 0) k--;
  const last = all[k];
  return /^(grep|egrep|fgrep|rg|test|\[|\[\[|diff|cmp|git)$/.test(last.name) && (last.name !== 'git' || /^(grep|diff)$/.test(last.argv[1] || ''));
}
