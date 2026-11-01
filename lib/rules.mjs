// Rules: what antibody does before a tool call runs.
//
// A rule says when it applies (tools, scope, match), what it does (deny, ask, warn or rewrite), the
// message the model sees, its state (enforce, shadow or retired) and its own test cases. Most rules
// are data (JSON) so the healer can add and tune them without writing code. Rules that need real
// logic are predicates (a `check(ctx)` function) and ship only in reviewed packs, or as a person's
// own local guards.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PLUGIN_ROOT, config, paths } from './config.mjs';
import { dialectFor, flagCount, flagValue, hasFlag, stages } from './shell.mjs';

export const ACTIONS = ['deny', 'ask', 'warn', 'rewrite'];
export const STATES = ['enforce', 'shadow', 'retired'];

const rx = (src, flags = '') => (src instanceof RegExp ? src : new RegExp(src, flags));

export function makeContext({ tool, input = {}, cwd = '', session = '', platform = process.platform }) {
  const command = typeof input.command === 'string' ? input.command : null;
  const dialect = dialectFor(tool);
  return {
    tool,
    input,
    cwd: String(cwd || ''),
    session,
    platform,
    dialect,
    command,
    filePath: input.file_path || input.notebook_path || null,
    stages: command ? stages(command, dialect) : [],
  };
}

export function withCommand(ctx, command) {
  return { ...ctx, command, input: { ...ctx.input, command }, stages: stages(command, ctx.dialect) };
}

// The stage's text from its command name on (leading VAR=value dropped), masked.
const line = (st) => (st.words.length ? st.masked.slice(st.words[0].start - st.start) : '');

function stageMatches(m, st) {
  if (m.stage === 'first' && st.index !== 0) return false;
  if (m.name && !(Array.isArray(m.name) ? m.name.includes(st.name) : rx(`^(?:${m.name})$`, 'i').test(st.name))) return false;
  if (m.command && !rx(m.command).test(line(st))) return false;
  if (m.raw && !rx(m.raw).test(st.orig)) return false;
  if (m.notRaw && rx(m.notRaw).test(st.orig)) return false;
  for (const f of [].concat(m.hasFlag || [])) if (!hasFlag(st, f)) return false;
  if ([].concat(m.anyFlag || []).length && ![].concat(m.anyFlag).some((f) => hasFlag(st, f))) return false;
  for (const f of [].concat(m.lacksFlag || [])) if (hasFlag(st, f)) return false;
  for (const f of [].concat(m.repeatedFlag || [])) if (flagCount(st, f) < 2) return false;
  for (const [f, v] of Object.entries(m.flagValue || {})) if (!rx(v, 'i').test(flagValue(st, f) ?? '\u0000')) return false;
  if (m.next && !(st.next && rx(m.next, 'i').test(line(st.next)))) return false;
  if (m.redirect && !st.redirects.some((r) => rx(m.redirect, 'i').test(r.target))) return false;
  if (m.noInput && (st.index !== 0 || st.redirects.some((r) => r.op.startsWith('<')))) return false;
  return true;
}

// Apply a data rewrite to one stage; returns the whole new command.
function rewriteStage(ctx, st, op) {
  const cmd = ctx.command;
  const before = cmd.slice(0, st.start);
  const after = cmd.slice(st.end);
  let text = st.orig;
  const rel = (i) => i - st.start;
  if (op.renameFlag) {
    const w = st.words.find((x) => x.masked === op.renameFlag.from || x.masked.startsWith(op.renameFlag.from + '='));
    if (!w) return null;
    text = text.slice(0, rel(w.start)) + op.renameFlag.to + text.slice(rel(w.start) + op.renameFlag.from.length);
  } else if (op.dropFlag) {
    const k = st.words.findIndex((x) => x.masked === op.dropFlag);
    if (k < 0) return null;
    let a = rel(st.words[k].start);
    let b = rel((op.keepValue ? st.words[k] : st.words[k + 1] || st.words[k]).end);
    // Take the blanks after the dropped words (or before them, at the end of the stage) and nothing else.
    const tail = text.slice(b).match(/^[ \t]+/);
    if (tail) b += tail[0].length;
    else { const lead = text.slice(0, a).match(/[ \t]+$/); if (lead) a -= lead[0].length; }
    text = text.slice(0, a) + text.slice(b);
  } else if (op.insertAfterName) {
    const w = st.words[0];
    if (!w) return null;
    text = text.slice(0, rel(w.end)) + op.insertAfterName + text.slice(rel(w.end));
  } else if (op.replace) {
    const re = rx(op.replace.find);
    if (!re.test(text)) return null;
    text = text.replace(re, op.replace.with); // $1 etc. refer to the find pattern's groups
  } else return null;
  return before + text + after;
}

// Turn a data rule into a rule with a check(ctx) function.
export function compile(rule, source = 'local') {
  const r = { tools: ['Bash'], scope: {}, action: 'deny', state: 'enforce', cases: {}, ...rule, source };
  r.tools = [].concat(r.tools);
  if (typeof r.check === 'function') return r;
  const m = r.match || {};
  r.check = (ctx) => {
    if (m.filePath) return ctx.filePath && rx(m.filePath, 'i').test(ctx.filePath.replace(/\\/g, '/')) ? { action: r.action, message: r.message } : null;
    if (!ctx.command) return null;
    if (m.whole && !rx(m.whole).test(ctx.command)) return null;
    if (m.notWhole && rx(m.notWhole).test(ctx.command)) return null;
    for (const st of ctx.stages) {
      if (!stageMatches(m, st)) continue;
      if (r.action === 'rewrite') {
        const command = rewriteStage(ctx, st, r.rewrite || {});
        if (command && command !== ctx.command) return { action: 'rewrite', message: r.message, command };
        continue;
      }
      return { action: r.action, message: r.message };
    }
    return null;
  };
  return r;
}

function inScope(r, ctx) {
  if (!r.tools.includes(ctx.tool) && !r.tools.includes('*')) return false;
  const s = r.scope || {};
  if (s.os && ![].concat(s.os).includes(ctx.platform)) return false;
  if (s.cwd && !rx(s.cwd, 'i').test(ctx.cwd.replace(/\\/g, '/'))) return false;
  return true;
}

async function importAll(file) {
  const mod = await import(pathToFileURL(resolve(file)).href);
  const v = mod.default ?? mod.rules ?? [];
  return Array.isArray(v) ? v : [v];
}

// Load every rule in effect: shipped packs named in config, local data rules, local guards.
// `dirs` lets replay load an older copy of the local rules.
export async function loadRules({ packs = config().packs, rulesDir = paths().rules, guardsDir = paths().guards, root = PLUGIN_ROOT } = {}) {
  const out = [];
  const errors = [];
  for (const name of packs) {
    const file = join(root, 'packs', name, 'rules.mjs');
    if (!existsSync(file)) {
      if (!existsSync(join(root, 'packs', name))) errors.push(`pack ${name}: not found in ${join(root, 'packs')}`);
      continue; // a pack may ship only after-call checks (post.mjs)
    }
    try { for (const r of await importAll(file)) out.push(compile({ ...r, pack: name }, 'pack')); } catch (e) { errors.push(`pack ${name}: ${e.message}`); }
  }
  if (rulesDir && existsSync(rulesDir)) {
    for (const f of readdirSync(rulesDir).filter((x) => x.endsWith('.json')).sort()) {
      try {
        const v = JSON.parse(readFileSync(join(rulesDir, f), 'utf8'));
        for (const r of [].concat(v)) out.push(compile({ ...r, file: f }, 'local'));
      } catch (e) { errors.push(`rules/${f}: ${e.message}`); }
    }
  }
  if (guardsDir && existsSync(guardsDir)) {
    for (const f of readdirSync(guardsDir).filter((x) => x.endsWith('.mjs')).sort()) {
      try {
        for (const r of await importAll(join(guardsDir, f))) out.push(compile({ tools: ['Bash', 'PowerShell'], ...r, id: r.id || f.replace(/\.mjs$/, ''), file: f }, 'guard'));
      } catch (e) { errors.push(`guards/${f}: ${e.message}`); }
    }
  }
  const overrides = config().ruleState || {};
  for (const r of out) if (overrides[r.id]) r.state = overrides[r.id];
  return { rules: out, errors };
}

// A check may return a string (deny with that message) or { action, message, command }.
function normalise(res, rule) {
  if (!res) return null;
  if (typeof res === 'string') return { action: rule.action === 'rewrite' ? 'deny' : rule.action, message: res };
  return { action: res.action || rule.action, message: res.message ?? rule.message, command: res.command };
}

export function runCheck(rule, ctx) {
  try {
    return normalise(rule.check(ctx), rule);
  } catch {
    return null; // a broken rule never blocks a call
  }
}

// Evaluate rules for one call. Shadow rules are checked against the original call and only
// reported. Enforced rewrites apply first (in order), then deny / ask / warn on the result.
export function evaluate(ctx, rules) {
  const active = rules.filter((r) => r.state !== 'retired' && inScope(r, ctx));
  const hits = [];
  for (const r of active.filter((x) => x.state === 'shadow')) {
    const res = runCheck(r, ctx);
    if (res) hits.push({ rule: r, ...res, shadow: true });
  }
  let cur = ctx;
  const notes = [];
  for (const r of active.filter((x) => x.state === 'enforce' && x.action === 'rewrite')) {
    const res = runCheck(r, cur);
    if (res && res.action === 'rewrite' && res.command && res.command !== cur.command) {
      hits.push({ rule: r, ...res, from: cur.command });
      notes.push(res.message);
      cur = withCommand(cur, res.command);
    }
  }
  let decision = null;
  let reason = null;
  for (const r of active.filter((x) => x.state === 'enforce' && x.action !== 'rewrite')) {
    const res = runCheck(r, cur);
    if (!res) continue;
    hits.push({ rule: r, ...res });
    if (res.action === 'deny' && decision !== 'deny') { decision = 'deny'; reason = `[${r.id}] ${res.message}`; }
    else if (res.action === 'ask' && !decision) { decision = 'ask'; reason = `[${r.id}] ${res.message}`; }
    else if (res.action === 'warn') notes.push(`[${r.id}] ${res.message}`);
  }
  return { decision, reason, command: cur.command !== ctx.command ? cur.command : null, notes, hits };
}

// Run a rule's own cases. Returns a list of failures (empty means all pass).
export function testRule(rule, base = {}) {
  const fails = [];
  const tool = rule.tools[0] === '*' ? 'Bash' : rule.tools[0];
  const toCtx = (c) => {
    const k = typeof c === 'string' ? { command: c } : c;
    const input = k.file_path ? { file_path: k.file_path } : { command: k.command };
    return makeContext({ tool: k.tool || tool, input, cwd: k.cwd || base.cwd || '', platform: k.platform || (rule.scope?.os ? [].concat(rule.scope.os)[0] : process.platform) });
  };
  for (const c of [].concat(rule.cases?.fire || [])) {
    const res = runCheck(rule, toCtx(c));
    const want = typeof c === 'object' ? c : {};
    if (!res) fails.push({ case: c, want: 'fire', got: 'pass' });
    else if (want.to && res.command !== want.to) fails.push({ case: c, want: want.to, got: res.command });
    else if (want.message && !String(res.message).includes(want.message)) fails.push({ case: c, want: `message containing ${want.message}`, got: res.message });
  }
  for (const c of [].concat(rule.cases?.pass || [])) {
    const res = runCheck(rule, toCtx(c));
    if (res) fails.push({ case: c, want: 'pass', got: `${res.action}: ${res.message}` });
  }
  return fails;
}
