// git-bash-windows: for Claude Code on Windows with Git Bash as the Bash tool. There, the tool's own
// wrapping plus Git Bash mangle nested quotes, backslashes and backticks, and checkouts are CRLF.
// Every refused shape has a file-based alternative, so nothing here leaves the model stuck.
import { heredocs } from '../../lib/shell.mjs';

const RISKY = /[`\\]|\$\{/; // backtick, backslash, or ${ (template literal / parameter expansion)
const INSTEAD =
  ' Instead: write file content with the Write tool and change files with the Edit tool; ' +
  'put a script in a scratchpad .mjs file with Write and run `node <file>`; ' +
  'put a commit message or PR body in a scratchpad file and pass it with `git commit -F - < "<file>"` (git itself cannot open long scratchpad paths) or the CLI\'s body-file option.';

const EVAL_FLAG = /^(-e|-p|--eval|--print|-pe|-ep)$/;

// Does bash run a backtick or expand `${` in this word as written? Single quotes keep both literal,
// and so does a backslash before them.
function bashExpands(raw) {
  let q = null;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (q === "'") { if (c === "'") q = null; continue; }
    if (c === '\\') { i++; continue; }
    if (c === "'" && !q) { q = c; continue; }
    if (c === '"') { q = q ? null : c; continue; }
    if (c === '`' || (c === '$' && raw[i + 1] === '{')) return true;
  }
  return false;
}

// The sed scripts in a sed command's words (after `sed`): each -e/--expression value, or else the
// first operand. A script read from a file (-f) can't be checked, so it isn't returned.
function sedScripts(words) {
  const out = [];
  let operand = null;
  for (let k = 0; k < words.length; k++) {
    const m = words[k].masked;
    if (m === '-e' || m === '--expression') { if (words[k + 1]) out.push(words[++k].text); continue; }
    if (m.startsWith('--expression=')) { out.push(words[k].text.slice('--expression='.length)); continue; }
    if (m === '-f' || m === '--file' || m === '-l' || m === '--line-length') { k++; continue; }
    if (m.startsWith('-') && m !== '-') continue;
    if (operand === null) operand = words[k].text;
  }
  const usesFile = words.some((w) => /^(-f|--file)(=|$)/.test(w.masked));
  return out.length ? out : operand !== null && !usesFile ? [operand] : [];
}

// A sed script's regexes (s patterns and /re/ addresses) and its command letters. Replacement text
// and the `$` address (the last line) are left out: CRLF can't break either.
function sedParts(s) {
  const patterns = [];
  let commands = '';
  let i = 0;
  const delimited = (d) => { let out = ''; while (i < s.length && s[i] !== d) { if (s[i] === '\\') out += s[i++]; out += s[i++] ?? ''; } i++; return out; };
  const address = () => {
    if (s[i] === '/') { i++; patterns.push(delimited('/')); }
    else if (s[i] === '\\') { const d = s[i + 1]; i += 2; patterns.push(delimited(d)); }
    else if (s[i] === '$') i++;
    else while (/[\d~+]/.test(s[i] || '')) i++;
    if (s[i] === 'I' || s[i] === 'M') i++;
  };
  while (i < s.length) {
    while (/[\s;{}!]/.test(s[i] || '')) i++;
    if (i >= s.length) break;
    address();
    if (s[i] === ',') { i++; address(); }
    while (/[\s!]/.test(s[i] || '')) i++;
    const c = s[i++];
    if (!c) break;
    if (c === '{' || c === '}' || c === ';') continue;
    if (c === 's' || c === 'y') { const d = s[i++]; const pat = delimited(d); delimited(d); if (c === 's') patterns.push(pat); }
    else commands += c;
    if (/[aic]/.test(c)) { while (i < s.length && s[i] !== '\n') i++; continue; }
    while (i < s.length && !/[;\n}]/.test(s[i])) i++;
  }
  return { patterns, commands };
}

// CRLF only breaks a match at the end of a line (a `$` anchor) or across lines (`N`, `\n` in a regex).
function crlfSensitive(script) {
  const { patterns, commands } = sedParts(script);
  return patterns.some((p) => /(^|[^\\])\$(\\?\)|\\?\||$)/.test(p) || /\\n/.test(p)) || commands.includes('N');
}

// The command on the heredoc's own line that opens it: `cat > x <<EOF` from `a; cat > x <<EOF`.
const opener = (h) => { const head = h.head.slice(0, h.head.indexOf('<<') + 1 || undefined); return head.split(/;|&&|\|\||\|/).pop(); };

const heredocRule = (id, message, test) => ({
  id,
  tools: ['Bash'],
  action: 'deny',
  message: message + INSTEAD,
  check(ctx) {
    return heredocs(ctx.command).some(test) ? { action: 'deny', message: this.message } : null;
  },
});

export default [
  {
    ...heredocRule('gbw.heredoc-devnull', 'A dummy heredoc into /dev/null changes nothing about how the command runs; drop it. If the next command is an inline script, put it in a scratchpad .mjs file.', (h) => /\/dev\/null/.test(opener(h))),
    cases: { fire: [{ command: "cat > /dev/null <<'X'\nX\ngrep -n foo a.ts", message: 'dummy heredoc' }], pass: ["sort <<'X'\nb\na\nX"] },
  },
  {
    // With a quoted delimiter the file gets the body byte for byte, so only an unquoted one is worth a word.
    id: 'gbw.heredoc-writes-file',
    tools: ['Bash'],
    action: 'warn',
    message: 'A heredoc with an unquoted delimiter writes a file (`cat > file <<EOF`, `tee`): bash expands `$`, backticks and backslashes in the body. Quote the delimiter (`<<\'EOF\'`) or use the Write tool.',
    check(ctx) {
      const writes = (h) => !h.quoted && !/\/dev\/null/.test(opener(h)) && (/\b(cat|tee)\b[^|;&]*>/.test(opener(h)) || /\btee\b/.test(opener(h)));
      return heredocs(ctx.command).some(writes) ? { action: 'warn', message: this.message } : null;
    },
    cases: {
      fire: ["mytool x > /dev/null 2>&1; cat >> notes.md <<EOF\nplain\nEOF", 'tee out.txt <<EOF\nhello\nEOF', 'cat > x.txt <<-EOF\n\tx\nEOF'],
      pass: ["cat > out.txt <<'EOF'\nplain text with a \\ backslash and ${HOME}\nEOF", "cat > x.mjs <<'EOF'\nconsole.log(`hi ${name}`);\nEOF", 'cat >> notes.md <<"EOF"\nplain text\nEOF', 'cat > x.txt <<\\EOF\nx\nEOF', "sort <<'X'\nb\na\nX", "cat <<< 'here string'"],
    },
  },
  {
    ...heredocRule('gbw.heredoc-risky-body', 'A heredoc with an unquoted delimiter whose body contains a backtick, a backslash or `${`, which bash expands before the command sees it. Quote the delimiter (`<<\'EOF\'`) to keep the body literal.', (h) => !h.quoted && RISKY.test(h.body)),
    cases: {
      fire: ['node - <<EOF\nconst s = `a`;\nEOF', 'git commit -m "$(cat <<EOF\nFix `foo`\nEOF\n)"', 'python - <<EOF\nprint("a\\nb")\nEOF', 'cat <<EOF | sh\necho ${X}\nEOF'],
      pass: ["node - <<'EOF'\nconst s = `a`;\nEOF", "python - <<'EOF'\nprint('a\\nb')\nEOF", "git commit -m \"$(cat <<'EOF'\nFix `foo`\nEOF\n)\"", 'node - <<"EOF"\nconst s = `${a}`;\nEOF', "git commit -m \"$(cat <<'EOF'\nFix foo, don't drop rows\nEOF\n)\"", 'cat <<EOF\nplain $HOME\nEOF', 'echo $((1 << 2))'],
    },
  },
  {
    id: 'gbw.node-eval-risky',
    tools: ['Bash'],
    action: 'deny',
    message: 'An inline `node -e` / `-p` script with a backtick or `${` outside single quotes: bash runs the backtick as a command and expands `${...}` before node sees the script. Single-quote the script, or put it in a file.' + INSTEAD,
    check(ctx) {
      for (const st of ctx.stages) {
        if (!/^(node|bun|deno)$/.test(st.name)) continue;
        for (let k = 1; k < st.words.length; k++) {
          const w = st.words[k];
          const glued = w.masked.match(/^--(eval|print)=/);
          const script = glued ? w.raw.slice(glued[0].length) : EVAL_FLAG.test(w.masked) ? st.words[k + 1]?.raw : null;
          if (script != null && bashExpands(script)) return { action: 'deny', message: this.message };
        }
      }
      return null;
    },
    cases: {
      fire: ['node -e "const x = `y`"', 'node -e "console.log(`${a}`)"', 'x=1; node -e "const r=`ls`" < f.json', 'node -p ${X}.length', 'node --eval="`id`"', 'node -pe "require(\'x\')[`a`]"'],
      pass: [
        "node -e 'console.log(`ok ${1+1}`)'", "node -e \"const r=s.split('\\n')\" < f.json", "node -e \"console.log('C:\\\\Users')\"",
        "node -e \"console.log(require('os').homedir())\"", "node -e \"console.log(1)\"; grep -n 'a\\|b' file", 'node script.mjs --flag', 'node -e "const a = \\`x\\`"',
      ],
    },
  },
  {
    id: 'gbw.sed-in-place',
    tools: ['Bash'],
    action: 'deny',
    message: 'An in-place `sed -i` edit whose expression uses a `$` anchor or works across lines (`N`, `\\n`): on a CRLF checkout each line ends in `\\r`, so the match silently misses.' + INSTEAD,
    check(ctx) {
      for (const st of ctx.stages) {
        const from = st.name === 'xargs' ? st.words.findIndex((w) => /(^|\/)sed$/.test(w.text)) : st.name === 'sed' ? 0 : -1;
        if (from < 0) continue;
        const words = st.words.slice(from + 1);
        if (!words.some((w) => /^-[a-zA-Z]*i/.test(w.masked) || w.masked.startsWith('--in-place'))) continue;
        if (sedScripts(words).some(crlfSensitive)) return { action: 'deny', message: this.message };
      }
      return null;
    },
    cases: {
      fire: ["sed -i 's/a$/b/' file.ts", "sed -E -i 's/^(x)$/y/' file.ts", "sed -i.bak -e 's/a/b/' -e 's/ *$//' doc.md", "git grep -l X | xargs sed -i 's/X$/Y/g'", "sed --in-place 'N;s/a\\nb/c/' f", "sed -i '/start/{N;d}' f", "sed -i \"s/x$/y/\" f", "sed -i --expression='s/a$//' f", "sed -i '$!N;s/a/b/' f", "sed -i '/^export default {$/,/^};$/d' f", "sed -i 's|x$|y|; s|a|b|' f", "sed -i 's/\\(a$\\)/b/' f"],
      pass: ["sed -i 's/a/b\\nc/' f", "sed -i 's/a/cost: $5/' f", "sed -i '/^foo/d' f", "sed -i 's#a\\.b#c#g' x y","sed -i 's/foo/bar/g' some-file.txt", "sed -i 's/toastTitles/toastTexts/g' file.tsx", "sed -i '$d' f", "sed -i \"s/x/${NEW}/\" f", "sed -i 's/Name/Nom/' f", "sed -n '1,5p' file.ts", "sed 's/a$/b/' in.txt > out.txt", 'grep -n "sed -i" notes.md'],
    },
  },
  {
    id: 'gbw.tail-short-multi',
    tools: ['Bash'],
    action: 'rewrite',
    message: 'This `tail` refuses the short `-N` form with more than one file, so antibody wrote it as `tail -n N`.',
    check(ctx) {
      for (const st of ctx.stages) {
        if (st.name !== 'tail' || !/^-\d+$/.test(st.argv[1] || '')) continue;
        if (st.argv.slice(2).filter((a) => !a.startsWith('-')).length < 2) continue;
        const w = st.words[1];
        const command = ctx.command.slice(0, w.start) + `-n ${w.text.slice(1)}` + ctx.command.slice(w.end);
        return { action: 'rewrite', message: this.message, command };
      }
      return null;
    },
    cases: {
      fire: [{ command: 'tail -5 a.log b.log', to: 'tail -n 5 a.log b.log' }, { command: 'tail -2 "$S/tc.log" "$S/lint.log"', to: 'tail -n 2 "$S/tc.log" "$S/lint.log"' }],
      pass: ['tail -n 5 a.log b.log', 'tail -5 a.log', 'pnpm t x 2>&1 | tail -5', 'tail -5 a.log > out.txt'],
    },
  },
];
