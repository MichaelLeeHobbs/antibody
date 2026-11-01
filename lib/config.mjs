// Where antibody keeps its data and how it is configured. Everything else asks this module.
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT || dirname(dirname(fileURLToPath(import.meta.url)));

export function claudeDir() {
  return process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
}

export function dataHome() {
  return process.env.ANTIBODY_HOME || join(claudeDir(), 'antibody');
}

export const paths = () => {
  const home = dataHome();
  return {
    home,
    config: join(home, 'config.json'),
    events: join(home, 'events.jsonl'),
    issues: join(home, 'issues'),
    archive: join(home, 'issues', 'archive'),
    rules: join(home, 'rules'),
    guards: join(home, 'guards'),
    reviews: join(home, 'reviews'),
    learned: join(home, 'learned.md'),
    state: join(home, 'state'),
    snapshots: join(home, 'state', 'snapshots'),
  };
};

export const DEFAULTS = {
  // Shipped packs to load. `core` is always loaded.
  packs: [],
  // Per-rule overrides of the shipped state: { "<rule id>": "shadow" | "enforce" | "retired" }.
  ruleState: {},
  // How a protected path is guarded: "ask" puts a person in the loop, "deny" refuses outright.
  protect: { settings: 'ask', plugin: 'deny', events: 'deny', localGuards: 'ask' },
  // A Bash/PowerShell call that runs longer than this is logged as `slow` (milliseconds).
  slowMs: 120000,
  // After a failure, watch this many later calls in the same session for the one that worked.
  recoveryWindow: 6,
  // Promotion gate for shadow rules.
  promote: { minHits: 3, minSessions: 2 },
  // An issue with a fix is `fixed` once quiet this long; a sighting after that makes it `recurring`.
  quietDays: 14,
  // Extra secret patterns to redact from logged text, as regex sources.
  redact: [],
  // Who reads the reviews and where repo fixes go.
  owner: '',
  repoFixes: { mode: 'list', max: 3 },
};

let cached;
export function config() {
  if (cached) return cached;
  let user = {};
  try {
    user = JSON.parse(readFileSync(paths().config, 'utf8'));
  } catch {}
  cached = { ...DEFAULTS, ...user, protect: { ...DEFAULTS.protect, ...(user.protect || {}) }, promote: { ...DEFAULTS.promote, ...(user.promote || {}) } };
  if (!cached.packs.includes('core')) cached.packs = ['core', ...cached.packs];
  return cached;
}

export function resetConfigCache() {
  cached = undefined;
}

export function ensureDir(dir) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}
