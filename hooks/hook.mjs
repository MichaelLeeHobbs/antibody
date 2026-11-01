// antibody's one hook entry point, for PreToolUse, PostToolUse and PostToolUseFailure.
// It must never break a session: every error is swallowed and the hook exits 0, which lets the
// call through.
import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { PLUGIN_ROOT, config, ensureDir, paths } from '../lib/config.mjs';
import { append, errorText, isNoise, isRealTraffic, signature, commandHead } from '../lib/events.mjs';
import { evaluate, loadRules, makeContext } from '../lib/rules.mjs';
import { findMatches } from '../lib/issues.mjs';

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

async function pre(input) {
  const tool = input.tool_name;
  const real = isRealTraffic(input);
  if (SHELLS.has(tool) && real) {
    writeFileSync(callFile(input), JSON.stringify({ ts: Date.now(), command: input.tool_input?.command }));
    sweep();
  }
  const { rules } = await loadRules();
  const ctx = makeContext({ tool, input: input.tool_input || {}, cwd: input.cwd, session: input.session_id });
  const res = evaluate(ctx, rules);
  if (real) {
    for (const h of res.hits) {
      const kind = h.shadow ? 'shadow' : h.action === 'deny' ? 'block' : h.action;
      append({ kind, session_id: input.session_id, cwd: input.cwd, tool, rule: h.rule.id, action: h.action, command: h.from ?? ctx.command, file: ctx.filePath || undefined, message: h.message, to: h.command });
    }
  }
  const hso = { hookEventName: 'PreToolUse' };
  if (res.decision) {
    hso.permissionDecision = res.decision;
    hso.permissionDecisionReason =
      `antibody ${res.reason}` +
      (res.decision === 'deny'
        ? ` Take the alternative it names; don't reshape the command to get past the check. If the rule is wrong for this case, say so with: ${CLI} note "<why the rule is wrong>"`
        : '');
  }
  if (res.command && res.decision !== 'deny') hso.updatedInput = { ...(input.tool_input || {}), command: res.command };
  const notes = [...res.notes];
  if (res.command && res.decision !== 'deny') notes.unshift(`antibody rewrote the command to: ${res.command}`);
  if (notes.length) hso.additionalContext = notes.join('\n');
  if (Object.keys(hso).length > 1) out({ hookSpecificOutput: hso });
}

function remember(input, ev) {
  // Watch the next few calls in this session for the one that worked.
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
  if (input.is_interrupt) {
    // The person pressed stop. A long-running shell call that gets stopped is usually a stall.
    append({ ...base, kind: 'interrupt', signature: signature(tool, command, 'interrupted') });
    return;
  }
  const kind = /\b(timed out|timeout)\b/i.test(text) && SHELLS.has(tool) ? 'timeout' : isNoise(tool, command, text) ? 'noise' : 'failure';
  const ev = append({ ...base, kind, error: text, signature: signature(tool, command, text) });
  if (kind === 'noise') return;
  remember(input, ev);
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

async function post(input) {
  const tool = input.tool_name;
  if (!isRealTraffic(input)) return;
  const ti = input.tool_input || {};
  const context = [];
  if (SHELLS.has(tool)) {
    const started = startedAt(input);
    const ranMs = started ? Date.now() - started : null;
    if (ranMs && ranMs > config().slowMs && !ti.run_in_background) append({ kind: 'slow', session_id: input.session_id, cwd: input.cwd, tool, command: ti.command, ranMs, signature: signature(tool, ti.command, 'slow') });
    if (ti.run_in_background) {
      const resp = typeof input.tool_response === 'string' ? input.tool_response : JSON.stringify(input.tool_response ?? '');
      const id = resp.match(BG_ID)?.[1];
      if (id) writeFileSync(stateFile('bg', `${safe(id)}.json`), JSON.stringify({ ts: Date.now(), command: ti.command, session_id: input.session_id, cwd: input.cwd }));
    }
    const sf = stateFile('sessions', `${safe(input.session_id)}.json`);
    const m = readJson(sf);
    if (m) {
      const head = (c) => commandHead(tool, c).split(' ')[0];
      if (head(ti.command) === head(m.command) && ti.command !== m.command) {
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

try {
  const input = JSON.parse(readFileSync(0, 'utf8') || '{}');
  const event = input.hook_event_name || process.argv[2];
  if (event === 'PreToolUse') await pre(input);
  else if (event === 'PostToolUseFailure') failure(input);
  else if (event === 'PostToolUse') await post(input);
} catch {
  // never let antibody break a session
}
process.exit(0);
