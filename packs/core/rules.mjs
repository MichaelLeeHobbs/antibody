// The core pack: always on. It protects antibody itself and catches commands that hang.
import { homedir } from 'node:os';
import { join, posix } from 'node:path';
import { PLUGIN_ROOT, claudeDir, config, paths } from '../../lib/config.mjs';
import { flagValue, hasFlag } from '../../lib/shell.mjs';

const norm = (p) => {
  const s = String(p || '').replace(/\\/g, '/').replace(/^\/([a-z])\//i, '$1:/').toLowerCase();
  return s ? posix.normalize(s) : s; // folds a/../b and ./x so a protected path can't hide behind them
};
const under = (p, dir) => {
  const a = norm(p);
  const b = norm(dir).replace(/\/$/, '');
  return a === b || a.startsWith(b + '/');
};
const home = () => norm(claudeDir());
const tildeOf = (p) => norm(p).replace(home(), '~/.claude');

// A path as the shell would see it: ~ and $HOME expanded, relative paths taken from the directory the
// command runs in.
const HOME = /^(~|\$HOME|\$\{HOME\}|\$env:USERPROFILE|\$env:HOME)(?=[\\/]|$)/i;
function resolvePath(p, cwd) {
  let s = String(p || '');
  if (HOME.test(s)) return s.replace(HOME, () => homedir());
  if (!s || !cwd || /^([\\/]|[A-Za-z]:|\$)/.test(s)) return s;
  return cwd.replace(/[\\/]+$/, '') + '/' + s;
}

// Commands and redirects that write to a path, for Bash and PowerShell. Reads (cat, grep, Get-Content) are fine.
const WRITERS = /^(cp|mv|rm|tee|truncate|dd|install|ln|chmod|touch|sed|perl|node|python3?|copy-item|move-item|remove-item|set-content|add-content|out-file|new-item|clear-content|rename-item)$/;
// Write calls in an inline node, python or perl script. Anything that might write counts, so a
// script that writes some other file while reading settings.json still asks.
const INLINE_WRITE = /\b(write\w*|append\w*|copy\w*|cp(Sync)?|rename\w*|unlink\w*|rm(Sync|dir\w*)?|truncate\w*|createWriteStream|dump|replace|remove|move|symlink\w*|link(Sync)?|chmod\w*|utimes\w*)\s*\(|,\s*(mode\s*=\s*)?['"](r\+|[rbt]*[wax][bt+]*|\+?>>?)['"]|shutil\.|\s-[a-zA-Z]*i\b/;
function writesTo(ctx, check) {
  let cwd = ctx.cwd;
  const test = (p, loose) => (loose ? check(p, true) : check(resolvePath(p, cwd)));
  if (ctx.filePath) return ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(ctx.tool) && test(ctx.filePath);
  for (const st of ctx.stages) {
    // Follow `cd dir && ...` so a relative path is read from where it runs.
    if (/^(cd|pushd|set-location|sl)$/.test(st.name)) {
      const to = st.argv.slice(1).find((a) => !a.startsWith('-'));
      if (to) cwd = resolvePath(to, cwd);
      continue;
    }
    if (st.redirects.some((r) => r.op.includes('>') && !/^&?\d*$/.test(r.target) && test(r.target))) return true;
    if (!WRITERS.test(st.name)) continue;
    if (st.name === 'sed' && !st.argv.some((a) => /^-[a-zA-Z]*i|^--in-place/.test(a))) continue;
    if (/^(node|python3?|perl)$/.test(st.name) && !st.argv.some((a) => /^-(e|p|c|-eval|-print)$/.test(a))) continue;
    // Inline scripts: look for the path anywhere in the stage, but only when the script writes
    // something; a script that only reads the file (JSON.parse, json.load) is fine.
    if (/^(node|python3?|perl)$/.test(st.name)) { if (INLINE_WRITE.test(st.orig) && test(st.orig, true)) return true; continue; }
    const operands = st.argv.slice(1).filter((a) => !a.startsWith('-'));
    // cp, install and ln only change their last operand; copying a file *from* a protected path is fine.
    const targets = /^(cp|install|ln|copy-item)$/.test(st.name) ? operands.slice(-1) : operands;
    if (targets.some((a) => test(a))) return true;
  }
  return false;
}

const isSettings = (p, loose) => {
  const n = norm(p);
  if (loose) return /settings(\.local)?\.json/.test(n) && n.includes('.claude');
  const t = tildeOf(n);
  return /^(~\/\.claude|\.claude)\/settings(\.local)?\.json$/.test(t) || /(^|\/)\.claude\/settings(\.local)?\.json$/.test(n);
};

const STDIN_READERS = {
  // name: { pattern operands, options that take a value, options that mean "no stdin needed" }
  grep: { pre: 1, vals: ['-e', '-f', '-m', '-A', '-B', '-C', '-d', '-D', '--regexp', '--file', '--max-count', '--context', '--after-context', '--before-context'], patternOpts: ['-e', '-f', '--regexp', '--file'], noStdin: ['-r', '-R', '--recursive', '--dereference-recursive', '-V', '--version', '--help'] },
  egrep: 'grep', fgrep: 'grep',
  sed: { pre: 1, vals: ['-e', '-f', '-l', '--expression', '--file'], patternOpts: ['-e', '-f', '--expression', '--file'], noStdin: ['--help', '--version'] },
  awk: { pre: 1, vals: ['-f', '-v', '-F'], patternOpts: ['-f'], noStdin: ['--help', '--version'] },
  sort: { pre: 0, vals: ['-k', '-t', '-o', '-S', '-T', '--key', '--field-separator', '--output'], noStdin: ['--help', '--version'] },
  uniq: { pre: 0, vals: ['-f', '-s', '-w'], noStdin: ['--help', '--version'] },
  wc: { pre: 0, vals: [], noStdin: ['--help', '--version'] },
  cat: { pre: 0, vals: [], noStdin: ['--help', '--version'] },
  head: { pre: 0, vals: ['-n', '-c', '--lines', '--bytes'], noStdin: ['--help', '--version'] },
  tail: { pre: 0, vals: ['-n', '-c', '--lines', '--bytes', '-s', '--pid'], noStdin: ['--help', '--version'] },
  cut: { pre: 0, vals: ['-d', '-f', '-c', '-b', '--delimiter', '--fields'], noStdin: ['--help', '--version'] },
  jq: { pre: 1, vals: ['--arg:2', '--argjson:2', '--slurpfile:2', '--rawfile:2', '--indent', '-f', '--from-file'], patternOpts: ['-f', '--from-file'], noStdin: ['-n', '--null-input', '--help', '--version'] },
  tr: { pre: 0, vals: [], always: true },
};

// The operands of a stdin reader: positional words after options and their values.
function operands(st, spec) {
  const vals = new Map(spec.vals.map((v) => { const [f, n] = v.split(':'); return [f, Number(n || 1)]; }));
  const out = [];
  let patternFromOpt = false;
  const words = st.words.slice(1);
  for (let k = 0; k < words.length; k++) {
    const w = words[k].masked;
    if (w === '--') { out.push(...words.slice(k + 1)); break; }
    if (/^-[^-]/.test(w) && !w.includes('=')) {
      // A short cluster (-in, -efoo, -A3): each letter is a flag until one takes a value, which is
      // the rest of the word or else the next word.
      for (let c = 1; c < w.length; c++) {
        const flag = '-' + w[c];
        if (!vals.has(flag)) continue;
        if ((spec.patternOpts || []).includes(flag)) patternFromOpt = true;
        if (c === w.length - 1) k += vals.get(flag);
        break;
      }
      continue;
    }
    if (/^-/.test(w) && w !== '-') {
      const flag = w.includes('=') ? w.slice(0, w.indexOf('=')) : w;
      if ((spec.patternOpts || []).includes(flag)) patternFromOpt = true;
      if (vals.has(flag) && !w.includes('=')) k += vals.get(flag);
      // Short options glued to a value (-n5, -A3) take nothing more.
      continue;
    }
    out.push(words[k]);
  }
  return { files: out.slice(patternFromOpt ? 0 : spec.pre), all: out };
}

function stdinHang(ctx, { emptyVars = false } = {}) {
  for (const st of ctx.stages) {
    if (st.index !== 0) continue; // fed by the stage before it
    let spec = STDIN_READERS[st.name];
    if (typeof spec === 'string') spec = STDIN_READERS[spec];
    if (!spec) continue;
    if (st.redirects.some((r) => r.op.startsWith('<'))) continue;
    if (st.words.some((w) => (spec.noStdin || []).some((f) => w.masked === f || (f.length === 2 && /^-[a-zA-Z]+$/.test(w.masked) && w.masked.includes(f[1]) && !w.masked.startsWith('--'))))) continue;
    // Inside a loop or function body the stage may be fed by `done < file`; skip those.
    if (/\b(while|until|for)\b[\s\S]*\bdo\b/.test(ctx.command.slice(0, st.start)) && /\bdone\b/.test(ctx.command.slice(st.end))) continue;
    const { files } = operands(st, spec);
    if (spec.always || files.length === 0) {
      if (emptyVars) continue;
      return { st, why: spec.always ? `\`${st.name}\` only reads stdin` : `\`${st.name}\` has no file to read` };
    }
    if (emptyVars && files.every((w) => /^\$\{?\w+\}?$/.test(w.raw))) return { st, why: `\`${st.name}\` reads only ${files.map((w) => w.raw).join(' ')}, and if that is empty it waits on stdin` };
  }
  return null;
}

export default [
  {
    id: 'core.protect-settings',
    tools: ['Bash', 'PowerShell', 'Write', 'Edit', 'MultiEdit'],
    get action() { return config().protect.settings; },
    message: 'This changes Claude Code settings (permissions and hooks). antibody leaves that to a person: say what you want changed and why, and let them make or approve the edit.',
    check(ctx) {
      // `antibody permissions --apply` writes settings.json too: a person runs it, or approves it.
      const applies = ctx.stages.some((st) => {
        const i = st.name === 'antibody' ? 0 : st.name === 'node' ? st.argv.findIndex((a) => /antibody(\.mjs)?$/i.test(a)) : -1;
        return i >= 0 && st.argv[i + 1] === 'permissions' && st.argv.includes('--apply');
      });
      return applies || writesTo(ctx, (p, loose) => isSettings(p, loose)) ? { action: config().protect.settings, message: this.message } : null;
    },
    cases: {
      fire: [
        { tool: 'Edit', file_path: '/home/u/.claude/settings.json' },
        'echo {} > ~/.claude/settings.json',
        'echo {}>~/.claude/settings.json',
        { command: 'cp x.json settings.json', cwd: join(homedir(), '.claude') },
        { tool: 'PowerShell', command: 'Set-Content -Value "a\nb" `\n -Path $HOME/.claude/settings.json' },
        'cp x.json ~/.claude/settings.local.json',
        `node -e "require('fs').writeFileSync(require('os').homedir()+'/.claude/settings.json','{}')"`,
        { tool: 'PowerShell', command: 'Set-Content -Path $HOME/.claude/settings.json -Value "{}"' },
        `python3 -c "import json,os; p=os.path.expanduser('~/.claude/settings.json'); d=json.load(open(p)); json.dump(d, open(p,'w'))"`,
        `perl -pi -e 's/a/b/' ~/.claude/settings.json`,
        `python -c "import os; f=open(os.path.expanduser('~/.claude/settings.json'), mode='a'); f.close()"`,
        'antibody permissions --apply',
        'node "C:/Users/u/.claude/plugins/cache/antibody/antibody/0.2.0/bin/antibody.mjs" permissions --apply',
        { tool: 'PowerShell', command: 'antibody permissions --apply' },
      ],
      pass: ['cat ~/.claude/settings.json',
        `node -e "const s=JSON.parse(require('fs').readFileSync(require('os').homedir()+'/.claude/settings.json','utf8')); console.log(s.permissions)"`,
        `python3 -c "import json,os; print(json.load(open(os.path.expanduser('~/.claude/settings.json')))['permissions'])"`,
        'antibody permissions',
        `node -e "const p=require('os').homedir()+'/.claude/settings.json'; Object.keys(JSON.parse(require('fs').readFileSync(p,'utf8'))).forEach((k) => console.log(k))"`,
        { tool: 'PowerShell', command: 'Get-Content $HOME/.claude/settings.json | ConvertFrom-Json' }, 'cp ~/.claude/settings.json /tmp/settings-backup.json', 'grep -n hooks ~/.claude/settings.json', { tool: 'Edit', file_path: '/repo/src/settings.json' }, 'node script.mjs ~/.claude/settings.json'],
    },
  },
  {
    id: 'core.protect-plugin',
    tools: ['Bash', 'PowerShell', 'Write', 'Edit', 'MultiEdit'],
    action: 'deny',
    message: "antibody's own files (its hooks, packs and CLI) change only through a plugin release, so a session cannot switch off its own logging or guards. If a shipped rule is wrong, record it with the antibody note command; the healer can set that rule to shadow or retired in config.",
    check(ctx) {
      return writesTo(ctx, (p, loose) => (loose ? norm(p).includes(norm(PLUGIN_ROOT)) : under(p, PLUGIN_ROOT))) ? { action: config().protect.plugin, message: this.message } : null;
    },
    cases: { fire: [{ tool: 'Write', file_path: join(PLUGIN_ROOT, 'hooks', 'hook.mjs') }], pass: [{ tool: 'Write', file_path: '/tmp/x.mjs' }] },
  },
  {
    id: 'core.protect-events',
    tools: ['Bash', 'PowerShell', 'Write', 'Edit'],
    action: 'deny',
    message: "The event log is written only by antibody's hooks. To add what you learned, run the antibody note command; to change an issue, edit its file under issues/.",
    check(ctx) {
      return writesTo(ctx, (p, loose) => (loose ? /events\.jsonl/.test(norm(p)) && norm(p).includes('antibody') : norm(p) === norm(paths().events) || /\/antibody\/events\.jsonl$/.test(norm(p)))) ? { action: config().protect.events, message: this.message } : null;
    },
    cases: { fire: ['echo x >> ~/.claude/antibody/events.jsonl', { command: 'rm events.jsonl', cwd: paths().home }, `cd '${paths().home}' && echo x > ./events.jsonl`], pass: ['tail -n 5 ~/.claude/antibody/events.jsonl'] },
  },
  {
    id: 'core.protect-local-guards',
    tools: ['Write', 'Edit', 'MultiEdit', 'Bash', 'PowerShell'],
    action: 'ask',
    message: 'Local guards are code that runs before every shell command. A person approves changes to them; unattended runs should propose the change as a data rule or in the review instead.',
    check(ctx) {
      return writesTo(ctx, (p, loose) => (loose ? norm(p).includes(norm(paths().guards)) || norm(p).includes('/antibody/guards/') : under(p, paths().guards) || /\/\.claude\/antibody\/guards(\/|$)/.test(norm(p)))) ? { action: config().protect.localGuards, message: this.message } : null;
    },
    cases: { fire: [{ tool: 'Write', file_path: '/home/u/.claude/antibody/guards/twg.mjs' }, { tool: 'Write', file_path: join(paths().guards, 'lib', 'shell.mjs') }, { command: 'rm lib/shell.mjs', cwd: paths().guards }], pass: [{ tool: 'Write', file_path: '/home/u/.claude/antibody/rules/twg.json' }] },
  },
  {
    id: 'core.plugin-disable',
    tools: ['Bash', 'PowerShell'],
    action: 'ask',
    message: 'This turns plugins off or removes them, which would stop antibody. A person decides that.',
    check(ctx) {
      return ctx.stages.some((st) => st.name === 'claude' && st.argv[1] === 'plugin' && /^(disable|uninstall|remove|rm)$/.test(st.argv[2] || '')) ? { action: 'ask', message: this.message } : null;
    },
    cases: { fire: ['claude plugin disable antibody'], pass: ['claude plugin list'] },
  },
  {
    id: 'core.stdin-hang',
    tools: ['Bash'],
    action: 'deny',
    message: '',
    check(ctx) {
      const hit = stdinHang(ctx);
      if (!hit) return null;
      return {
        action: 'deny',
        message: `${hit.why}, so it would wait for input that never comes and the call would hang until someone kills it. Name the file to read (or \`-r\` for a directory). If reading nothing is really what you want, add \`< /dev/null\`.`,
      };
    },
    cases: {
      fire: ['grep -n foo', 'grep -e foo -e bar', 'grep -efoo', 'grep -ie foo', 'grep -n foo # explain', 'echo "a\nb" | sort -u; grep x', 'sort -u', 'cd src && grep TODO', 'tr a-z A-Z', 'jq .name', "sed 's/a/b/'"],
      pass: [
        'grep -n foo src/a.ts', 'grep -rn foo', 'grep -rn foo .', 'git log | grep foo', 'grep foo < f.txt', 'cat a.txt',
        "grep -e foo -e bar file", 'grep -efoo file.txt', 'grep -ffile.txt input.txt', "sed -es/a/b/ file", 'grep -inA3 foo file','jq -n "1+1"', "sed -n '1,5p' file.ts", 'echo $((1 << 2))', 'grep --version',
        'while read l; do grep x; done < list.txt', 'sort -k 2 file.txt', 'head -n 5 a.log', 'wc -l *.ts', 'jq --arg a b .x f.json',
        "grep -c x <<< 'here'", "cat <<'EOF' | grep x\nhi\nEOF",
      ],
    },
  },
  {
    // Shipped in shadow: an unquoted variable as the only file is usually fine, so this rule has to
    // prove itself on real traffic before it acts.
    id: 'core.stdin-hang-empty-var',
    tools: ['Bash'],
    action: 'rewrite',
    state: 'shadow',
    message: 'If the variable is empty this command waits on stdin forever; `< /dev/null` makes it end instead.',
    check(ctx) {
      const hit = stdinHang(ctx, { emptyVars: true });
      if (!hit) return null;
      const st = hit.st;
      const w = st.words[0];
      const command = ctx.command.slice(0, w.end) + ' < /dev/null' + ctx.command.slice(w.end);
      return { action: 'rewrite', message: this.message, command };
    },
    cases: {
      fire: [{ command: 'grep -n foo $FILES', to: 'grep < /dev/null -n foo $FILES' }],
      pass: ['grep -n foo "$FILE"', 'grep foo a.txt'],
    },
  },
];

export { stdinHang, operands, flagValue, hasFlag };
