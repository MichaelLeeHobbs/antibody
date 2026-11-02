// Issues: one file per root cause, under issues/. The file is JSON front matter (what to match,
// the one-line fix, when it was fixed) followed by a short Markdown body for people.
import { closeSync, existsSync, openSync, readdirSync, readFileSync, renameSync, writeFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { config, ensureDir, paths } from './config.mjs';

const ID = /^AB-(\d{4,})$/;
const FENCE = '---';

export function parseIssue(text, file = '') {
  const t = text.replace(/\r\n/g, '\n');
  if (!t.startsWith(FENCE + '\n')) throw new Error(`${file}: must start with a --- line`);
  const end = t.indexOf('\n' + FENCE + '\n', 4);
  if (end < 0) throw new Error(`${file}: front matter has no closing --- line`);
  const meta = JSON.parse(t.slice(4, end));
  const body = t.slice(end + FENCE.length + 2).trim();
  return { ...meta, body };
}

export function formatIssue(issue) {
  const { body = '', ...meta } = issue;
  return `${FENCE}\n${JSON.stringify(meta, null, 2)}\n${FENCE}\n\n${body.trim()}\n`;
}

const fileOf = (id, archived = false) => join(archived ? paths().archive : paths().issues, `${id}.md`);

export function listIssues({ archived = false } = {}) {
  const dirs = [paths().issues, ...(archived ? [paths().archive] : [])];
  const out = [];
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir).filter((x) => /^AB-\d+\.md$/.test(x)).sort()) {
      try {
        out.push({ ...parseIssue(readFileSync(join(dir, f), 'utf8'), f), archived: dir === paths().archive });
      } catch {}
    }
  }
  return out;
}

export function readIssue(id) {
  for (const archived of [false, true]) {
    const f = fileOf(id, archived);
    if (existsSync(f)) return { ...parseIssue(readFileSync(f, 'utf8'), f), archived };
  }
  return null;
}

// Each issue is its own small file, so two sessions never rewrite each other's work.
export function writeIssue(issue) {
  const { archived, ...rest } = issue;
  const f = fileOf(issue.id, archived);
  ensureDir(archived ? paths().archive : paths().issues);
  const tmp = `${f}.${process.pid}.${randomBytes(3).toString('hex')}.tmp`;
  writeFileSync(tmp, formatIssue(rest));
  renameSync(tmp, f);
  return f;
}

// Create a new issue with the next free id. Creating the file exclusively means two sessions
// adding at the same moment get different ids.
export function createIssue(fields) {
  ensureDir(paths().issues);
  const used = listIssues({ archived: true }).map((i) => Number(ID.exec(i.id)?.[1] || 0));
  let n = Math.max(0, ...used) + 1;
  for (let tries = 0; tries < 50; tries++, n++) {
    const id = `AB-${String(n).padStart(4, '0')}`;
    if (existsSync(fileOf(id, true))) continue;
    let fd;
    try {
      fd = openSync(fileOf(id), 'wx');
    } catch {
      continue;
    }
    const issue = { id, created: new Date().toISOString().slice(0, 10), scope: 'global', when: {}, rules: [], seen: [], ...fields };
    issue.id = id;
    writeSync(fd, formatIssue(issue));
    closeSync(fd);
    return issue;
  }
  throw new Error('could not find a free issue id');
}

const rxOk = (src, text) => {
  try {
    return new RegExp(src, 'i').test(String(text ?? ''));
  } catch {
    return false;
  }
};

// Does an event belong to this issue? `when` lists what must all hold: tool, kind, a regex on the
// command, a regex on the error text, or an exact signature.
export function matches(issue, ev) {
  const w = issue.when || {};
  if (!Object.keys(w).length) return false;
  if (w.tool && ![].concat(w.tool).includes(ev.tool)) return false;
  if (w.kind && ![].concat(w.kind).includes(ev.kind)) return false;
  if (w.command && !rxOk(w.command, ev.command)) return false;
  if (w.error && !rxOk(w.error, ev.error)) return false;
  if (w.signature && ![].concat(w.signature).includes(ev.signature)) return false;
  if (w.rule && ![].concat(w.rule).includes(ev.rule)) return false;
  return true;
}

// Archived issues still count: archiving a quiet issue must not forget its fix.
export function findMatches(ev, issues = listIssues({ archived: true })) {
  return issues.filter((i) => matches(i, ev));
}

// Status is computed from evidence, never typed in:
//   open       no fix recorded yet
//   watching   fixed recently; waiting to see that it holds
//   fixed      fixed and quiet for quietDays
//   recurring  seen again after it was marked fixed
//   closed     archived by hand (issue archive), e.g. a project defect rather than Claude's
export function status(issue, events = []) {
  if (issue.archivedAt) return issue.cause === 'project' ? 'project' : 'closed';
  if (!issue.fixedAt) return 'open';
  const fixed = new Date(issue.fixedAt);
  // A recovery carries its failure's signature but is not a new failure, so it is no evidence.
  const after = events.filter((e) => e.kind !== 'recovery' && new Date(e.ts) > fixed && matches(issue, e)).length + (issue.seen || []).filter((s) => String(s).slice(0, 10) > issue.fixedAt.slice(0, 10)).length;
  if (after) return 'recurring';
  return Date.now() - fixed.getTime() > config().quietDays * 864e5 ? 'fixed' : 'watching';
}

export function sightings(issue, events = []) {
  return events.filter((e) => e.kind !== 'recovery' && matches(issue, e)).length + (issue.seen || []).length;
}
