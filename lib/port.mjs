// Porting a local guard into data rules.
//
// A guard is code, so only a person can change it. Most guard checks are flag and regex checks that
// data rules express just as well, and data rules the review can tune itself. A port takes a list of
// candidate data rules and shows whether they do what the guard does: each rule against its own
// cases, the whole set against every case (one rule's pass case must not be caught by another), and
// the set against the guard on every case and every logged command. A verdict that differs from the
// guard is fine only where a case asks for it; anywhere else it blocks the switch-over.
import { caseContext, compile, evaluate, makeContext, testRule } from './rules.mjs';

// What a set of rules does to one call: deny, ask, rewrite, warn or allow.
function verdict(ctx, rules) {
  const res = evaluate(ctx, rules);
  if (res.decision) return res.decision;
  if (res.command) return 'rewrite';
  return res.hits.some((h) => !h.shadow && h.action === 'warn') ? 'warn' : 'allow';
}

const enforced = (r) => ({ ...r, state: 'enforce' });
const keyOf = (ctx) => `${ctx.tool}\u0000${ctx.command}`;

// guard: a loaded guard rule. list: the candidate data rules (plain JSON). events: logged calls to replay.
export function portGuard(guard, list, events = []) {
  const rules = list.map((r) => compile({ ...r }, 'local'));
  const g = [enforced(guard)];
  const set = rules.map(enforced);
  const own = rules.map((r) => ({ id: r.id, fire: [].concat(r.cases?.fire || []).length, pass: [].concat(r.cases?.pass || []).length, fails: testRule(r) }));

  // Every case command, with the rules that list it as fire or pass.
  const cases = new Map();
  for (const r of rules) {
    for (const kind of ['fire', 'pass']) {
      for (const c of [].concat(r.cases?.[kind] || [])) {
        const ctx = caseContext(r, c);
        if (!ctx.command) continue;
        const k = keyOf(ctx);
        if (!cases.has(k)) cases.set(k, { ctx, fire: [], pass: [] });
        cases.get(k)[kind].push(r.id);
      }
    }
  }
  const conflicts = [];
  const changed = [];
  for (const { ctx, fire, pass } of cases.values()) {
    const want = fire.length ? 'fire' : 'pass';
    const got = verdict(ctx, set);
    if ((want === 'fire') !== (got !== 'allow')) {
      const by = evaluate(ctx, set).hits.map((h) => h.rule.id);
      conflicts.push({ command: ctx.command, why: want === 'fire' ? `a fire case of ${fire.join(', ')}, but no rule in the set catches it` : `a pass case of ${pass.join(', ')}, but ${by.join(', ')} ${by.length > 1 ? 'catch' : 'catches'} it` });
      continue;
    }
    const was = verdict(ctx, g);
    if (was !== got) changed.push({ command: ctx.command, guard: was, rules: got, cases: want === 'fire' ? fire : pass });
  }

  // Logged commands the cases don't cover: here the rules must do exactly what the guard did.
  const seen = new Set(cases.keys());
  const unintended = [];
  let replayed = 0;
  for (const e of events) {
    if (typeof e.command !== 'string' || !(e.tool === 'Bash' || e.tool === 'PowerShell')) continue;
    const ctx = makeContext({ tool: e.tool, input: { command: e.command }, cwd: e.cwd || '' });
    const k = keyOf(ctx);
    if (seen.has(k)) continue;
    seen.add(k);
    replayed++;
    const was = verdict(ctx, g);
    const got = verdict(ctx, set);
    if (was !== got) unintended.push({ command: e.command, ts: e.ts, guard: was, rules: got });
  }
  const ok = own.every((r) => !r.fails.length) && !conflicts.length && !unintended.length;
  return { ok, own, conflicts, changed, unintended, replayed };
}
