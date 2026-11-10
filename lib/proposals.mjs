// Code and instruction changes as patches.
//
// When a fix needs code (a local guard, a helper script in ~/.claude/bin), the review writes it as a
// patch file and applies it with `antibody apply <date> <n>`, which backs the files up, runs the
// checks and puts everything back if they get worse. Patches to antibody's own files (the data folder
// and ~/.claude/bin) are the review's to apply. A patch to anything else under ~/.claude (CLAUDE.md,
// skills, agents) changes how every project works, so a person applies it.
//
// A patch is a list of exact text replacements, like the Edit tool's: each `find` must occur exactly
// once in its file, so a file that changed since the review is refused rather than patched in the
// wrong place.
//
//   reviews/proposals/<YYYY-MM-DD>-<n>.json
//   { "title": "...", "issue": "AB-0110", "why": "...",
//     "edits": [{ "file": "guards/x.mjs", "find": "old text", "replace": "new text" },
//               { "file": "~/.claude/bin/helper.mjs", "content": "a new file" }],
//     "checks": [{ "run": ["~/.claude/bin/helper.mjs", "--file", "reviews/fixtures/x.txt"], "expect": "\"issues\"" }] }
//
// `file` is relative to the data folder, or starts with ~/.claude/. Targets stay inside ~/.claude and
// never touch settings, installed plugins or the event log: those keep their own paths. A change to a
// script outside guards/ (guards have their own cases) needs at least one check: `run` is a script
// antibody may patch and its arguments, run with node and no shell; it must exit 0 (or `exit`) and
// print text matching the `expect` regex.
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, posix, relative, resolve } from 'node:path';
import { claudeDir, paths } from './config.mjs';

export const proposalsDir = () => join(paths().reviews, 'proposals');
export const proposalFile = (date, n) => join(proposalsDir(), `${date}-${n}.json`);

const readText = (f) => readFileSync(f, 'utf8').replace(/\r\n/g, '\n');
const inside = (p, dir) => {
  const r = relative(resolve(dir), resolve(p));
  return r === '' || (!r.startsWith('..') && !isAbsolute(r));
};

// A path with every symlink in it followed, for a file that may not exist yet: the nearest existing
// folder is resolved and the rest joined on.
function real(p) {
  let dir = resolve(p);
  const rest = [];
  while (!existsSync(dir)) {
    const up = dirname(dir);
    if (up === dir) break;
    rest.unshift(basename(dir));
    dir = up;
  }
  try { dir = realpathSync(dir); } catch {}
  return join(dir, ...rest);
}

export function target(file) {
  const s = String(file || '').replace(/\\/g, '/');
  if (!s) throw new Error('an edit names no file');
  if (isAbsolute(s) || /^[A-Za-z]:/.test(s)) throw new Error(`${file}: give a path relative to the data folder, or one starting with ~/.claude/`);
  const full = s.startsWith('~/.claude/') ? join(claudeDir(), s.slice('~/.claude/'.length)) : join(paths().home, s);
  // Check the path as written and where it really leads, so a symlinked folder can't reach past the checks.
  const claude = real(claudeDir());
  const home = real(paths().home);
  const to = real(full);
  for (const [p, c, h, st] of [[full, claudeDir(), paths().home, paths().state], [to, claude, home, real(paths().state)]]) {
    if (!inside(p, c) && !inside(p, h)) throw new Error(`${file}: outside ~/.claude${p === to && to !== resolve(full) ? ` (it leads to ${to})` : ''}`);
    const rel = relative(resolve(c), resolve(p)).replace(/\\/g, '/').toLowerCase();
    if (/^settings(\.local)?\.json$/.test(rel) || rel.startsWith('plugins/') || /(^|\/)events[^/]*\.jsonl$/.test(rel) || inside(p, st)) {
      throw new Error(`${file}: settings, installed plugins, the event log and antibody's state are never patched`);
    }
  }
  return to;
}

// antibody's own files: the data folder and the agent helpers in ~/.claude/bin.
export function ownFile(file) {
  const s = posix.normalize(String(file || '').replace(/\\/g, '/'));
  if (s.startsWith('~/')) return s.startsWith('~/.claude/bin/');
  return !!s && s !== '.' && !s.startsWith('../') && s !== '..';
}

// The files in a proposal that a person has to approve. An unreadable proposal counts as one.
export function filesForPerson(date, n) {
  try {
    const p = JSON.parse(readText(proposalFile(date, n)));
    if (p.applied) return [];
    return (p.edits || []).map((e) => e.file).filter((f) => !ownFile(f));
  } catch {
    return [`proposal ${date} #${n}`];
  }
}

const isScript = (f) => /\.(mjs|cjs|js)$/i.test(f);
const needsCheck = (f) => isScript(f) && !/^guards\//.test(posix.normalize(String(f).replace(/\\/g, '/')));

// Run a proposal's checks; returns the failures (empty when all pass).
export function runChecks(p, spawn) {
  const fails = [];
  for (const c of p.checks || []) {
    const run = Array.isArray(c.run) ? c.run.map(String) : [];
    if (!run.length) { fails.push('a check has no "run"'); continue; }
    let script;
    try { script = target(run[0]); } catch (e) { fails.push(`check script ${run[0]}: ${e.message}`); continue; }
    const args = run.slice(1).map((a) => (a.startsWith('~/.claude/') ? join(claudeDir(), a.slice('~/.claude/'.length)) : a));
    const r = spawn(process.execPath, [script, ...args], { cwd: paths().home, encoding: 'utf8', timeout: 60000, windowsHide: true });
    const out = `${r.stdout || ''}${r.stderr || ''}`;
    const want = c.exit ?? 0;
    if (r.status !== want) fails.push(`${run.join(' ')}: exit ${r.status ?? r.error?.code}, expected ${want}\n${out.slice(0, 400)}`);
    else if (c.expect && !new RegExp(c.expect).test(out)) fails.push(`${run.join(' ')}: output doesn't match /${c.expect}/\n${out.slice(0, 400)}`);
  }
  return fails;
}

const count = (text, s) => (s ? text.split(s).length - 1 : 0);

// Read a proposal and work out, for each edit, the file's text before and after.
export function loadProposal(date, n) {
  const file = proposalFile(date, n);
  if (!existsSync(file)) throw new Error(`No proposal ${date} #${n} (looked for ${file})`);
  let p;
  try { p = JSON.parse(readText(file)); } catch (e) { throw new Error(`${file} isn't valid JSON: ${e.message}`); }
  if (!p.title || !Array.isArray(p.edits) || !p.edits.length) throw new Error(`${file}: a proposal needs a "title" and a list of "edits"`);
  // Applied once is applied: a `replace` that contains its `find` would otherwise apply again.
  if (p.applied) return { file, proposal: p, plan: p.edits.map((e) => ({ ...e, done: true })), files: [] };
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
  const changed = [...files.values()].filter((f) => f.after !== f.before);
  const unchecked = changed.filter((f) => needsCheck(f.name));
  if (unchecked.length && !(Array.isArray(p.checks) && p.checks.length)) {
    throw new Error(`${file}: it changes ${unchecked.map((f) => f.name).join(', ')}, so it needs "checks" that run the script and show the fix works`);
  }
  return { file, proposal: p, plan, files: changed };
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
