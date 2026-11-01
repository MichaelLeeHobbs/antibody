// Shell structure without a shell parser: mask everything that is not structure, then split.
//
// mask(cmd, dialect) returns a string the same length as cmd in which the contents of quotes,
// escapes, command substitutions, comments and heredoc bodies are replaced by `x`. Indexes line
// up with the original, so a rule can find structure (pipes, `;`, flags, redirects) in the masked
// text and read the real values back from the original.

const BASH = 'bash';
const PWSH = 'powershell';

export function mask(cmd, dialect = BASH) {
  return dialect === PWSH ? maskPowerShell(cmd) : maskBash(cmd);
}

function maskBash(cmd) {
  const out = cmd.split('');
  const n = cmd.length;
  const hide = (a, b) => { for (let k = a; k < b; k++) if (out[k] !== '\n') out[k] = 'x'; };
  // Heredoc bodies become blanks, newlines included: they are data, and blank text is no stage at all.
  const blank = (a, b) => { for (let k = a; k < b; k++) out[k] = ' '; };
  const pendingHeredocs = []; // delimiters whose bodies start at the next newline
  let i = 0;

  // Skip a $( ... ) or ` ... ` region starting at i; returns the index after it.
  const skipSubst = (start) => {
    if (cmd[start] === '`') {
      let j = start + 1;
      while (j < n && cmd[j] !== '`') j += cmd[j] === '\\' ? 2 : 1;
      return Math.min(j + 1, n);
    }
    let depth = 1;
    let j = start + 2;
    let q = null;
    while (j < n && depth) {
      const c = cmd[j];
      if (q === "'") { if (c === "'") q = null; j++; continue; }
      if (q === '"') { if (c === '\\') { j += 2; continue; } if (c === '"') q = null; j++; continue; }
      if (c === '\\') { j += 2; continue; }
      if (c === "'" || c === '"') q = c;
      else if (c === '(') depth++;
      else if (c === ')') depth--;
      j++;
    }
    return j;
  };

  while (i < n) {
    const c = cmd[i];
    if (c === '\n' && pendingHeredocs.length) {
      // Heredoc bodies follow the line that opened them, one after another.
      let j = i + 1;
      const first = j;
      while (pendingHeredocs.length) {
        const { delim, strip } = pendingHeredocs.shift();
        while (j < n) {
          const eol = cmd.indexOf('\n', j);
          const end = eol < 0 ? n : eol;
          const line = cmd.slice(j, end);
          const done = (strip ? line.replace(/^\t+/, '') : line).trim() === delim;
          // Hide the body and the delimiter line, newlines included, so none of it reads as commands.
          blank(j === first ? j : j - 1, end);
          j = end + 1;
          if (done || eol < 0) break;
        }
      }
      i = j;
      continue;
    }
    if (c === '\\') { hide(i + 1, Math.min(i + 2, n)); i += 2; continue; }
    if (c === "'") {
      const end = cmd.indexOf("'", i + 1);
      const stop = end < 0 ? n : end;
      hide(i + 1, stop);
      i = stop + 1;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      while (j < n && cmd[j] !== '"') j += cmd[j] === '\\' ? 2 : 1;
      hide(i + 1, Math.min(j, n));
      i = j + 1;
      continue;
    }
    if ((c === '$' && cmd[i + 1] === '(' && cmd[i + 2] !== '(') || c === '`') {
      const end = skipSubst(i);
      hide(i + (c === '`' ? 1 : 2), Math.max(i, end - 1));
      i = end;
      continue;
    }
    if (c === '#' && (i === 0 || /\s|;|&|\|/.test(cmd[i - 1]))) {
      const eol = cmd.indexOf('\n', i);
      const end = eol < 0 ? n : eol;
      hide(i, end);
      i = end;
      continue;
    }
    if (c === '<' && cmd[i + 1] === '<' && cmd[i + 2] !== '<' && cmd[i - 1] !== '<') {
      const m = cmd.slice(i).match(/^<<(-?)\s*(['"]?)([A-Za-z_][\w.-]*)\2/);
      if (m) {
        pendingHeredocs.push({ delim: m[3], strip: m[1] === '-' });
        i += m[0].length;
        continue;
      }
    }
    i++;
  }
  return out.join('');
}

function maskPowerShell(cmd) {
  const out = cmd.split('');
  const n = cmd.length;
  const hide = (a, b) => { for (let k = a; k < b; k++) if (out[k] !== '\n') out[k] = 'x'; };
  let i = 0;
  while (i < n) {
    const c = cmd[i];
    if (c === '@' && (cmd[i + 1] === "'" || cmd[i + 1] === '"') && cmd[i + 2] === '\n') {
      const close = '\n' + cmd[i + 1] + '@';
      const end = cmd.indexOf(close, i + 3);
      const stop = end < 0 ? n : end;
      for (let k = i + 2; k < Math.min(n, stop + close.length); k++) out[k] = ' '; // data, not structure
      i = stop + close.length;
      continue;
    }
    if (c === '`') { hide(i + 1, Math.min(i + 2, n)); i += 2; continue; }
    if (c === "'") {
      let j = i + 1;
      while (j < n) { if (cmd[j] === "'") { if (cmd[j + 1] === "'") { j += 2; continue; } break; } j++; }
      hide(i + 1, j);
      i = j + 1;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      while (j < n) { if (cmd[j] === '`') { j += 2; continue; } if (cmd[j] === '"') { if (cmd[j + 1] === '"') { j += 2; continue; } break; } j++; }
      hide(i + 1, j);
      i = j + 1;
      continue;
    }
    if (c === '#' && (i === 0 || /\s|;/.test(cmd[i - 1]))) {
      const eol = cmd.indexOf('\n', i);
      const end = eol < 0 ? n : eol;
      hide(i, end);
      i = end;
      continue;
    }
    i++;
  }
  return out.join('');
}

// Separators between pipelines: && || ; newline, and a lone `&` (background), but not the `&` in
// `2>&1`, `&>` or `>&`. Pipes: `|` and `|&`, not `||`.
const SEP = /&&|\|\||;|\n|(?<![>&|])&(?![>&])/g;
const PIPE = /\|&?/g;

function cut(re, text, base) {
  const parts = [];
  let last = 0;
  for (const m of text.matchAll(re)) {
    parts.push([base + last, base + m.index]);
    last = m.index + m[0].length;
  }
  parts.push([base + last, base + text.length]);
  return parts;
}

// Split a command into pipelines, each a list of stages. Every stage has its original text, its
// masked text, its offsets in the original, its words (argv, unquoted) and its redirects.
export function parse(cmd, dialect = BASH) {
  const masked = mask(cmd, dialect);
  const pipelines = [];
  for (const [a, b] of cut(SEP, masked, 0)) {
    const stages = [];
    for (const [s, e] of cut(PIPE, masked.slice(a, b), a)) {
      const lead = masked.slice(s, e).search(/\S/);
      if (lead < 0) continue;
      const start = s + lead;
      const end = s + masked.slice(s, e).trimEnd().length;
      stages.push(makeStage(cmd, masked, start, end, dialect));
    }
    if (stages.length) pipelines.push({ stages });
  }
  return pipelines;
}

// Flat list of every stage, each tagged with its pipeline and position and a link to the next
// stage in the same pipeline.
export function stages(cmd, dialect = BASH) {
  const list = [];
  parse(cmd, dialect).forEach((p, pi) => p.stages.forEach((st, si) => {
    list.push(Object.assign(st, { pipeline: pi, index: si, next: p.stages[si + 1] || null, prev: p.stages[si - 1] || null }));
  }));
  return list;
}

const REDIRECT = /^(\d*|&)(>&|<&|&>>?|>>?|<<<|<<|<)(.*)$/;

function makeStage(cmd, masked, start, end, dialect) {
  const orig = cmd.slice(start, end);
  const m = masked.slice(start, end);
  const tokens = [];
  for (const t of m.matchAll(/\S+/g)) tokens.push({ start: start + t.index, end: start + t.index + t[0].length, masked: t[0] });
  const words = [];
  const redirects = [];
  const assigns = [];
  for (let k = 0; k < tokens.length; k++) {
    const t = tokens[k];
    const raw = cmd.slice(t.start, t.end);
    const r = t.masked.match(REDIRECT);
    const isRedirect = r && (dialect !== PWSH || /^(\d*)(>>?)/.test(t.masked));
    if (isRedirect) {
      let target = r[3];
      let tEnd = t.end;
      if (!target && tokens[k + 1] && !/^\d*[<>]/.test(tokens[k + 1].masked)) {
        target = cmd.slice(tokens[k + 1].start, tokens[k + 1].end);
        tEnd = tokens[k + 1].end;
        k++;
      } else target = cmd.slice(t.end - r[3].length, t.end);
      redirects.push({ op: r[2], fd: r[1], target: unquote(target, dialect), start: t.start, end: tEnd });
      continue;
    }
    if (!words.length && dialect !== PWSH && /^[A-Za-z_]\w*=/.test(t.masked)) { assigns.push(raw); continue; }
    words.push({ text: unquote(raw, dialect), raw, masked: t.masked, start: t.start, end: t.end });
  }
  const argv = words.map((w) => w.text);
  return {
    orig, masked: m, start, end, words, argv, redirects, assigns,
    // The command name without any directory or .exe/.cmd suffix, lowercased: `twg`, `node`, `grep`.
    name: argv.length ? argv[0].replace(/^.*[\\/]/, '').replace(/\.(exe|cmd|bat|ps1)$/i, '').toLowerCase() : '',
  };
}

export function unquote(s, dialect = BASH) {
  if (dialect === PWSH) {
    if (/^'.*'$/s.test(s)) return s.slice(1, -1).replace(/''/g, "'");
    if (/^".*"$/s.test(s)) return s.slice(1, -1).replace(/`(.)/g, '$1');
    return s;
  }
  let out = '';
  let q = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q === "'") { if (c === "'") q = null; else out += c; continue; }
    if (q === '"') {
      if (c === '\\' && /["\\$`]/.test(s[i + 1] || '')) { out += s[++i]; continue; }
      if (c === '"') q = null; else out += c;
      continue;
    }
    if (c === '\\') { out += s[++i] ?? ''; continue; }
    if (c === "'" || c === '"') { q = c; continue; }
    out += c;
  }
  return out;
}

// Does the stage carry this flag (`--id`, `--id=X`, or `-i` as its own word)?
export function hasFlag(stage, flag) {
  return stage.words.some((w) => w.masked === flag || w.masked.startsWith(flag + '='));
}

// How many times the flag appears.
export function flagCount(stage, flag) {
  return stage.words.filter((w) => w.masked === flag || w.masked.startsWith(flag + '=')).length;
}

// The value after a flag (`--id KEY` or `--id=KEY`), unquoted, or null.
export function flagValue(stage, flag) {
  for (let k = 0; k < stage.words.length; k++) {
    const w = stage.words[k];
    if (w.masked === flag) return stage.words[k + 1]?.text ?? null;
    if (w.masked.startsWith(flag + '=')) return w.text.slice(flag.length + 1);
  }
  return null;
}

// The non-flag words after the command name, up to the first flag: `twg jira workitem get` -> [jira, workitem, get].
export function subcommands(stage, max = 3) {
  const out = [];
  for (const w of stage.argv.slice(1)) {
    if (w.startsWith('-') || out.length >= max) break;
    out.push(w);
  }
  return out;
}

// Heredocs in the original text: [{ delim, head (the line holding `<<`), body }].
export function heredocs(cmd) {
  const found = [];
  const re = /<<(-?)\s*(['"]?)([A-Za-z_][\w.-]*)\2/g;
  let m;
  while ((m = re.exec(cmd))) {
    if (cmd[m.index - 1] === '<' || cmd[m.index + 2] === '<') continue;
    // Raw text on purpose: a heredoc inside "$(...)" is still a heredoc.
    const nl = cmd.indexOf('\n', m.index);
    if (nl < 0) continue;
    const lines = cmd.slice(nl + 1).split('\n');
    const end = lines.findIndex((l) => l.trim() === m[3] || l.trim().startsWith(m[3] + ')'));
    const body = (end < 0 ? lines : lines.slice(0, end)).join('\n');
    const head = cmd.slice(cmd.lastIndexOf('\n', m.index) + 1, nl);
    found.push({ delim: m[3], head, body });
  }
  return found;
}

export const DIALECT = { BASH, PWSH };
export function dialectFor(tool) {
  return tool === 'PowerShell' ? PWSH : BASH;
}
