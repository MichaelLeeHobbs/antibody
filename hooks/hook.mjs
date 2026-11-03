// antibody's one hook entry point, for SessionStart, PreToolUse, PostToolUse and PostToolUseFailure.
// It must never break a session: every error is swallowed and the hook exits 0, which lets the
// call through.
import { spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { PLUGIN_ROOT, config, ensureDir, lastReview, paths } from '../lib/config.mjs';
import { append, errorText, isNoise, isRealTraffic, redact, signature, commandHead } from '../lib/events.mjs';
import { evaluate, loadRules, makeContext } from '../lib/rules.mjs';
import { findMatches } from '../lib/issues.mjs';
import { checkEnabled, due, notice } from '../lib/update.mjs';

const SHELLS = new Set(['Bash', 'PowerShell']);
const STOPPERS = new Set(['TaskStop', 'KillShell', 'KillBash']);
const CLI = `node "${join(PLUGIN_ROOT, 'bin', 'antibody.mjs').replace(/\\/g, '/')}"`;

const out = (o) => process.stdout.write(JSON.stringify(o));
const safe = (s) => String(s || 'nosession').replace(/[^\w.-]/g, '_').slice(0, 80);

function stateFile(...parts) {
  const dir = join(paths().state, ...parts.slice(0, -1));
  ensureDir(dir);
  return join(dir, parts[parts.length - 1]);
}
const readJson = (f) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return null; } };

// A call's id: the hook's tool_use_id, or a hash of what was called.
const callId = (input) => safe(input.tool_use_id || createHash('sha1').update(JSON.stringify([input.tool_name, input.tool_input])).digest('hex').slice(0, 16));
const callFile = (input) => stateFile('calls', `${safe(input.session_id)}-${callId(input)}.json`);

function startedAt(input) {
  const f = callFile(input);
  const m = readJson(f);
  try { rmSync(f, { force: true }); } catch {}
  return m ? m.ts : null;
}

// Old markers (from calls that never reported back) are swept now and then.
function sweep() {
  try {
    const dir = join(paths().state, 'calls');
    if (!existsSync(dir) || Math.random() > 0.05) return;
    const old = Date.now() - 2 * 864e5;
    for (const f of readdirSync(dir)) {
      const p = join(dir, f);
      if (statSync(p).mtimeMs < old) rmSync(p, { force: true });
    }
  } catch {}
}

// An ask reaches a person only in the modes where Claude Code prompts. In auto mode it is settled
// for them, and bypassPermissions/dontAsk never prompt, so there an ask becomes a deny. A mode this
// list doesn't know counts as unattended too; with no mode in the input at all, the ask stands.
const ATTENDED = new Set(['default', 'acceptEdits', 'plan']);
const unattended = (mode) => typeof mode === 'string' && mode !== '' && !ATTENDED.has(mode);

async function pre(input) {
  const tool = input.tool_name;
  const real = isRealTraffic(input);
  if (SHELLS.has(tool) && real) {
    // Only the start time: the command itself stays out of state files (it may hold a secret).
    writeFileSync(callFile(input), JSON.stringify({ ts: Date.now() }));
    sweep();
  }
  const { rules } = await loadRules();
  const ctx = makeContext({ tool, input: input.tool_input || {}, cwd: input.cwd, session: input.session_id });
  const res = evaluate(ctx, rules);
  const mode = input.permission_mode;
  const noPerson = res.decision === 'ask' && unattended(mode);
  if (real) {
    for (const h of res.hits) {
      const kind = h.shadow ? 'shadow' : h.action === 'deny' || (h.action === 'ask' && noPerson) ? 'block' : h.action;
      append({ kind, session_id: input.session_id, cwd: input.cwd, tool, rule: h.rule.id, action: h.action, mode, command: h.from ?? ctx.command, file: ctx.filePath || undefined, message: h.message, to: h.command });
    }
  }
  const hso = { hookEventName: 'PreToolUse' };
  if (noPerson) {
    hso.permissionDecision = 'deny';
    hso.permissionDecisionReason =
      `antibody ${res.reason} This session runs in "${mode}" permission mode, where Claude Code settles an ask without showing it to a person, so antibody refuses it instead. ` +
      "Don't retry it another way: stop and give the person the exact change (the full command, or the file and the edit) so they can make it themselves.";
  } else if (res.decision) {
    hso.permissionDecision = res.decision;
    hso.permissionDecisionReason =
      `antibody ${res.reason}` +
      (res.decision === 'deny'
        ? ` Take the alternative it names; don't reshape the command to get past the check. If the rule is wrong for this case, say so with: ${CLI} note "<why the rule is wrong>"`
        : '');
  }
  if (res.command && hso.permissionDecision !== 'deny') hso.updatedInput = { ...(input.tool_input || {}), command: res.command };
  const notes = [...res.notes];
  if (res.command && hso.permissionDecision !== 'deny') notes.unshift(`antibody rewrote the command to: ${res.command}`);
  if (notes.length) hso.additionalContext = notes.join('\n');
  if (Object.keys(hso).length > 1) out({ hookSpecificOutput: hso });
}

function remember(input, ev) {
  // Watch the next few calls in this session for the one that worked. ev is the redacted copy.
  writeFileSync(stateFile('sessions', `${safe(input.session_id)}.json`), JSON.stringify({ event: ev.id, ts: Date.now(), tool: ev.tool, command: ev.command, signature: ev.signature, left: config().recoveryWindow }));
}

function failure(input) {
  const tool = input.tool_name;
  if (!isRealTraffic(input)) return;
  const command = input.tool_input?.command;
  const text = errorText(input);
  const started = SHELLS.has(tool) ? startedAt(input) : null;
  const ranMs = started ? Date.now() - started : undefined;
  const base = { session_id: input.session_id, cwd: input.cwd, tool, input: input.tool_input, command, ranMs };
  // The person pressed stop: a long-running shell call that gets stopped is usually a stall. It still
  // goes through recall, so an issue with when.kind "interrupt" hands back its fix.
  const interrupt = Boolean(input.is_interrupt);
  const kind = interrupt ? 'interrupt' : /\b(timed out|timeout)\b/i.test(text) && SHELLS.has(tool) ? 'timeout' : isNoise(tool, command, text) ? 'noise' : 'failure';
  const ev = append(interrupt ? { ...base, kind, signature: signature(tool, command, 'interrupted') } : { ...base, kind, error: text, signature: signature(tool, command, text) });
  if (kind === 'noise') return;
  if (!interrupt) remember(input, ev);
  const hits = findMatches(ev);
  const lines = [];
  for (const i of hits.slice(0, 3)) lines.push(`Known issue ${i.id} (${i.title}): ${i.fix || 'no fix recorded yet; see the issue file.'}`);
  lines.push(
    hits.length
      ? `antibody logged this as event ${ev.id}. If the known fix didn't work, say so: ${CLI} note ${ev.id} "<what did work>"`
      : `antibody logged this as event ${ev.id}. Once you find what works, record it in one line: ${CLI} note ${ev.id} "<the fix>"`,
  );
  if (kind === 'timeout') lines.unshift('This call timed out. If it was waiting for input (a command with no file operand reads stdin), name the file or add `< /dev/null`.');
  out({ hookSpecificOutput: { hookEventName: 'PostToolUseFailure', additionalContext: lines.join('\n') } });
}

const BG_ID = /(?:background with ID|shell[_ ]?id|task[_ ]?id|bash[_ ]?id|\bID)["':\s]+([\w-]{4,})/i;

// The task list a person watches: Claude Code's TodoWrite and Task tools, and the desktop app's
// update_plan. A milestone is a call that finishes a piece of work the list should already show.
const PLANS = /^(TodoWrite|TaskCreate|TaskUpdate|mcp__.+__update_plan)$/;
const MILESTONES = [
  ['a commit', /\bgit\s+(?:-C\s+\S+\s+)?commit\b/],
  ['a push', /\bgit\s+(?:-C\s+\S+\s+)?push\b/],
  ['a pull request', /\b(?:gh\s+pr|pull-requests)\s+(?:create|merge)\b/],
  ['a card moving', /\bworkitem\s+transition\b/],
];
const planFile = (input) => stateFile('plans', `${safe(input.session_id)}.json`);

// A long run can leave its task list on step one while commits and PRs pile up (2026-11-03: two
// hours, three PRs, the list still on "Read epic design"). Only a session that keeps a list hears
// about it, once per stalePlanMs, and only when a milestone shows real progress since.
function stalePlan(input, tool, command) {
  const limit = config().stalePlanMs;
  if (!limit || !command) return null;
  const what = MILESTONES.find(([, re]) => re.test(command))?.[0];
  if (!what) return null;
  const f = planFile(input);
  const p = readJson(f);
  const now = Date.now();
  if (!p || now - p.ts < limit || (p.toldAt && now - p.toldAt < limit)) return null;
  const mins = Math.round((now - p.ts) / 60000);
  writeFileSync(f, JSON.stringify({ ...p, toldAt: now }));
  append({ kind: 'stale-plan', session_id: input.session_id, cwd: input.cwd, tool, command, staleMs: now - p.ts, signature: signature(tool, command, 'stale-plan') });
  return (
    `antibody: your task list hasn't changed in ${mins} min, and this call was ${what}. The person follows progress on that list, not in chat. ` +
    'If it no longer shows the step you are on, update it now (mark what is done, start the current step). If it is still right, carry on.'
  );
}

async function post(input) {
  const tool = input.tool_name;
  if (!isRealTraffic(input)) return;
  const ti = input.tool_input || {};
  const context = [];
  if (PLANS.test(tool)) {
    writeFileSync(planFile(input), JSON.stringify({ ts: Date.now() }));
    return;
  }
  if (SHELLS.has(tool)) {
    const stale = stalePlan(input, tool, ti.command);
    if (stale) context.push(stale);
    const started = startedAt(input);
    const ranMs = started ? Date.now() - started : null;
    if (ranMs && ranMs > config().slowMs && !ti.run_in_background) append({ kind: 'slow', session_id: input.session_id, cwd: input.cwd, tool, command: ti.command, ranMs, signature: signature(tool, ti.command, 'slow') });
    if (ti.run_in_background) {
      const resp = typeof input.tool_response === 'string' ? input.tool_response : JSON.stringify(input.tool_response ?? '');
      const id = resp.match(BG_ID)?.[1];
      if (id) writeFileSync(stateFile('bg', `${safe(id)}.json`), JSON.stringify({ ts: Date.now(), command: redact(ti.command), session_id: input.session_id, cwd: input.cwd }));
    }
    const sf = stateFile('sessions', `${safe(input.session_id)}.json`);
    const m = readJson(sf);
    if (m) {
      const head = (c) => commandHead(tool, c).split(' ')[0];
      // m.command was redacted when saved; compare like with like.
      const now = redact(ti.command);
      if (head(now) === head(m.command) && now !== m.command) {
        append({ kind: 'recovery', session_id: input.session_id, cwd: input.cwd, tool, command: ti.command, after: m.event, failed: m.command, signature: m.signature });
        rmSync(sf, { force: true });
      } else if (--m.left <= 0) rmSync(sf, { force: true });
      else writeFileSync(sf, JSON.stringify(m));
    }
  }
  if (STOPPERS.has(tool)) {
    const id = ti.task_id || ti.shell_id || ti.bash_id || ti.id || '';
    const bgf = id ? join(paths().state, 'bg', `${safe(id)}.json`) : null;
    const bg = bgf ? readJson(bgf) : null;
    if (bgf) try { rmSync(bgf, { force: true }); } catch {}
    const ev = append({ kind: 'stall', session_id: input.session_id, cwd: input.cwd, tool: bg ? 'Bash' : tool, command: bg?.command, task: id, ranMs: bg ? Date.now() - bg.ts : undefined, signature: signature('Bash', bg?.command, 'stall') });
    context.push(
      `antibody logged this stop as a possible stall (event ${ev.id}${bg ? `: \`${String(bg.command).slice(0, 120)}\`` : ''}). ` +
        `If the task hung or misbehaved, record why in one line: ${CLI} note ${ev.id} "<why it hung>". If you stopped it on purpose and it was fine, run: ${CLI} note ${ev.id} "intended"`,
    );
  }
  // Packs can add their own after-call checks (windows-orphans names leftover dev servers).
  for (const name of config().packs) {
    const f = join(PLUGIN_ROOT, 'packs', name, 'post.mjs');
    if (!existsSync(f)) continue;
    try {
      const mod = await import(pathToFileURL(f).href);
      const msg = await mod.default?.(input);
      if (msg) context.push(msg);
    } catch {}
  }
  if (context.length) out({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: context.join('\n') } });
}

// The review is meant to run daily. Two days without one (counted from the first session if there has
// never been one) gets a reminder, at most once a day.
const DAY = 864e5;
function reviewNotice(now = Date.now()) {
  if (config().reviewReminder === false || !existsSync(paths().events)) return null;
  const f = stateFile('review.json');
  const s = readJson(f) || {};
  s.firstSeen = s.firstSeen || new Date(now).toISOString();
  const last = lastReview();
  const since = last ? Date.parse(last) : Date.parse(s.firstSeen);
  let msg = null;
  if (now - since >= 2 * DAY && !(s.toldAt && now - Date.parse(s.toldAt) < DAY)) {
    msg = `antibody's review last ran ${last || 'never'}, so recent failures haven't been turned into fixes yet. Run /antibody:review, or schedule it daily (antibody schedule prints how).`;
    s.toldAt = new Date(now).toISOString();
  }
  writeFileSync(f, JSON.stringify(s));
  return msg;
}

// Tell the person about a newer release, and about a review that's overdue. The update check itself
// runs in its own process, at most once a day, so a slow network never holds up the session; what it
// finds shows at the next start.
function sessionStart() {
  const msgs = [];
  if (checkEnabled()) {
    if (due()) spawn(process.execPath, [join(PLUGIN_ROOT, 'bin', 'antibody.mjs'), 'update-check', '--quiet'], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    msgs.push(notice());
  }
  msgs.push(reviewNotice());
  const text = msgs.filter(Boolean).join('\n');
  if (text) out({ systemMessage: text });
}

try {
  const input = JSON.parse(readFileSync(0, 'utf8') || '{}');
  const event = input.hook_event_name || process.argv[2];
  if (event === 'SessionStart') sessionStart();
  else if (event === 'PreToolUse') await pre(input);
  else if (event === 'PostToolUseFailure') failure(input);
  else if (event === 'PostToolUse') await post(input);
} catch {
  // never let antibody break a session
}
process.exit(0);
