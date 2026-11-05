// Tier-2 proposals as ready patches.
//
// The review can't change code (local guards, helper scripts) or ~/.claude/CLAUDE.md; a person
// approves those. So the review writes each proposal as a patch file, and the person applies it with
// one command (`antibody apply <date> <n>`) instead of making the edit by hand. A patch is a list of
// exact text replacements, like the Edit tool's: each `find` must occur exactly once in its file, so a
// file that changed since the review is refused rather than patched in the wrong place.
//
//   reviews/proposals/<YYYY-MM-DD>-<n>.json
//   { "title": "...", "issue": "AB-0110", "why": "...",
//     "edits": [{ "file": "guards/twg.mjs", "find": "old text", "replace": "new text" },
//               { "file": "~/.claude/bin/helper.mjs", "content": "a new file" }] }
//
// `file` is relative to the data folder, or starts with ~/.claude/. Targets stay inside ~/.claude and
// never touch settings, installed plugins or the event log: those keep their own paths.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { claudeDir, paths } from './config.mjs';

export const proposalsDir = () => join(paths().reviews, 'proposals');
export const proposalFile = (date, n) => join(proposalsDir(), `${date}-${n}.json`);

const readText = (f) => readFileSync(f, 'utf8').replace(/\r\n/g, '\n');
const inside = (p, dir) => {
  const r = relative(resolve(dir), resolve(p));
  return r === '' || (!r.startsWith('..') && !isAbsolute(r));
};

export function target(file) {
  const s = String(file || '').replace(/\\/g, '/');
  if (!s) throw new Error('an edit names no file');
  if (isAbsolute(s) || /^[A-Za-z]:/.test(s)) throw new Error(`${file}: give a path relative to the data folder, or one starting with ~/.claude/`);
  const full = s.startsWith('~/.claude/') ? join(claudeDir(), s.slice('~/.claude/'.length)) : join(paths().home, s);
  if (!inside(full, claudeDir()) && !inside(full, paths().home)) throw new Error(`${file}: outside ~/.claude`);
  const rel = relative(resolve(claudeDir()), resolve(full)).replace(/\\/g, '/').toLowerCase();
  if (/^settings(\.local)?\.json$/.test(rel) || rel.startsWith('plugins/') || /(^|\/)events[^/]*\.jsonl$/.test(rel) || inside(full, paths().state)) {
    throw new Error(`${file}: settings, installed plugins, the event log and antibody's state are never patched`);
  }
  return full;
}

const count = (text, s) => (s ? text.split(s).length - 1 : 0);

// Read a proposal and work out, for each edit, the file's text before and after.
export function loadProposal(date, n) {
  const file = proposalFile(date, n);
  if (!existsSync(file)) throw new Error(`No proposal ${date} #${n} (looked for ${file})`);
  let p;
  try { p = JSON.parse(readText(file)); } catch (e) { throw new Error(`${file} isn't valid JSON: ${e.message}`); }
  if (!p.title || !Array.isArray(p.edits) || !p.edits.length) throw new Error(`${file}: a proposal needs a "title" and a list of "edits"`);
  const files = new Map();
  const plan = [];
  for (const e of p.edits) {
    const full = target(e.file);
    // Files are compared with LF line ends; `crlf` puts CRLF back when the file is written.
    if (!files.has(full)) files.set(full, { full, name: e.file, existed: existsSync(full), before: existsSync(full) ? readText(full) : null, crlf: existsSync(full) && readFileSync(full, 'utf8').includes('\r\n') });
    const f = files.get(full);
    f.after ??= f.before;
    if (typeof e.content === 'string') {
      if (f.before !== null) {
        if (f.before === e.content) { plan.push({ ...e, done: true }); continue; }
        throw new Error(`${e.file} exists already; a new-file edit won't overwrite it`);
      }
      f.after = e.content;
      plan.push({ ...e, kind: 'create' });
      continue;
    }
    if (typeof e.find !== 'string' || typeof e.replace !== 'string' || !e.find) throw new Error(`${e.file}: each edit needs "find" and "replace" (or "content" for a new file)`);
    if (f.after === null) throw new Error(`${e.file} doesn't exist`);
    const n1 = count(f.after, e.find);
    if (n1 === 1) {
      // The diff shows whole lines: from the start of the line the text begins on to the end of the
      // line it ends on.
      const i = f.after.indexOf(e.find);
      const ls = f.after.lastIndexOf('\n', i - 1) + 1;
      const le = f.after.indexOf('\n', i + e.find.length) < 0 ? f.after.length : f.after.indexOf('\n', i + e.find.length);
      const old = f.after.slice(ls, le);
      f.after = f.after.replace(e.find, () => e.replace);
      plan.push({ ...e, kind: 'replace', line: f.after.slice(0, ls).split('\n').length, old, new: f.after.slice(ls, le + e.replace.length - e.find.length) });
      continue;
    }
    // Already applied: the old text is gone and the new text is there once.
    if (n1 === 0 && count(f.after, e.replace) === 1) { plan.push({ ...e, done: true }); continue; }
    throw new Error(`${e.file}: the text to replace is found ${n1} times, not once; the file changed since the review. Ask the next review to write the proposal again.`);
  }
  return { file, proposal: p, plan, files: [...files.values()].filter((f) => f.after !== f.before) };
}

// A short, readable diff of the planned edits.
export function diff(plan) {
  const out = [];
  for (const e of plan) {
    if (e.done) { out.push(`= ${e.file}: already applied`); continue; }
    if (e.kind === 'create') {
      out.push(`+++ ${e.file} (new file)`);
      for (const l of e.content.replace(/\n$/, '').split('\n')) out.push(`+${l}`);
      continue;
    }
    out.push(`--- ${e.file} line ${e.line}`);
    for (const l of e.old.split('\n')) out.push(`-${l}`);
    for (const l of e.new.split('\n')) out.push(`+${l}`);
  }
  return out.join('\n');
}

export function listProposals() {
  const dir = proposalsDir();
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => /^\d{4}-\d{2}-\d{2}-\d+\.json$/.test(f)).sort().map((f) => {
    const [, date, n] = f.match(/^(\d{4}-\d{2}-\d{2})-(\d+)\.json$/);
    let p = {};
    try { p = JSON.parse(readText(join(dir, f))); } catch {}
    return { date, n: Number(n), title: p.title || '(unreadable)', applied: p.applied || null };
  });
}
