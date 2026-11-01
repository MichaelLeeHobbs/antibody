// Test helpers: every test gets its own throwaway data folder, so nothing touches a real install.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
export const HOOK = join(ROOT, 'hooks', 'hook.mjs');
export const CLI = join(ROOT, 'bin', 'antibody.mjs');

export function tempHome() {
  const dir = mkdtempSync(join(tmpdir(), 'antibody-test-'));
  return { dir, env: { ...process.env, ANTIBODY_HOME: join(dir, 'antibody'), CLAUDE_CONFIG_DIR: join(dir, 'claude'), CLAUDE_PLUGIN_ROOT: ROOT, ANTIBODY_DRY_RUN: '' }, done: () => rmSync(dir, { recursive: true, force: true }) };
}

export function hook(env, input) {
  const r = spawnSync(process.execPath, [HOOK], { input: JSON.stringify(input), env, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`hook exited ${r.status}: ${r.stderr}`);
  return r.stdout ? JSON.parse(r.stdout).hookSpecificOutput : null;
}

export function cli(env, ...args) {
  const opts = typeof args[args.length - 1] === 'object' ? args.pop() : {};
  const r = spawnSync(process.execPath, [CLI, ...args], { env, encoding: 'utf8', cwd: opts.cwd });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

let n = 0;
export const call = (tool, tool_input, extra = {}) => ({ session_id: 'test-session', cwd: '/repo', tool_name: tool, tool_use_id: `tu${++n}`, tool_input, ...extra });
