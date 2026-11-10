// git-bash-windows: for Claude Code on Windows with Git Bash as the Bash tool. There, the tool's own
// wrapping plus Git Bash mangle nested quotes, backslashes and backticks, and checkouts are CRLF.
// Every refused shape has a file-based alternative, so nothing here leaves the model stuck.
import { heredocs } from '../../lib/shell.mjs';

const RISKY = /[`\\]|\$\{/; // backtick, backslash, or ${ (template literal / parameter expansion)
const INSTEAD =
  ' Instead: write file content with the Write tool and change files with the Edit tool; ' +
  'put a script in a scratchpad .mjs file with Write and run `node <file>`; ' +
  'put a commit message or PR body in a scratchpad file and pass it with `git commit -F - < "<file>"` (git itself cannot open long scratchpad paths) or the CLI\'s body-file option.';

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
    ...heredocRule('gbw.heredoc-writes-file', 'A heredoc that writes a file (`cat > file <<EOF`, `cat >> file`, `tee`).', (h) => !/\/dev\/null/.test(opener(h)) && (/\b(cat|tee)\b[^|;&]*>/.test(opener(h)) || /\btee\b/.test(opener(h)))),
    cases: { fire: ["mytool x > /dev/null 2>&1; cat >> notes.md <<'EOF'\nplain\nEOF", "cat > x.mjs <<'EOF'\nconsole.log(`hi ${name}`);\nEOF", "cat >> notes.md <<'EOF'\nplain text\nEOF", 'tee out.txt <<EOF\nhello\nEOF'], pass: ["sort <<'X'\nb\na\nX", "cat <<< 'here string'"] },
  },
  {
    ...heredocRule('gbw.heredoc-risky-body', 'A heredoc whose body contains a backtick, a backslash or `${`.', (h) => RISKY.test(h.body)),
    cases: {
      fire: ["node - <<'EOF'\nconst s = `a`;\nEOF", "git commit -m \"$(cat <<'EOF'\nFix `foo`\nEOF\n)\""],
      pass: ["git commit -m \"$(cat <<'EOF'\nFix foo, don't drop rows\nEOF\n)\"", 'echo $((1 << 2))'],
    },
  },
  {
    id: 'gbw.node-eval-risky',
    tools: ['Bash'],
    action: 'deny',
    message: 'An inline `node -e` / `-p` script containing a backtick, a backslash or `${`.' + INSTEAD,
    check(ctx) {
      for (const st of ctx.stages) {
        if (!/^(node|bun|deno)$/.test(st.name)) continue;
        if (!st.argv.some((a) => /^(-e|-p|--eval|--print|-pe)$/.test(a))) continue;
        if (RISKY.test(st.orig)) return { action: 'deny', message: this.message };
      }
      return null;
    },
    cases: {
      fire: ["node -e \"console.log('C:\\\\Users')\"", "node -e 'const x = `y`'", "x=1; node -e \"const r=s.split('\\n')\" < f.json"],
      pass: ["node -e \"console.log(require('os').homedir())\"", "node -e \"console.log(1)\"; grep -n 'a\\|b' file", 'node script.mjs --flag'],
    },
  },
  {
    id: 'gbw.sed-in-place',
    tools: ['Bash'],
    action: 'deny',
    message: 'An in-place `sed -i` edit (silently misses on CRLF checkouts).' + INSTEAD,
    check(ctx) {
      for (const st of ctx.stages) {
        const argv = st.name === 'xargs' ? st.argv.slice(st.argv.findIndex((a) => /(^|\/)sed$/.test(a))) : st.name === 'sed' ? st.argv : null;
        if (!argv || !/(^|\/)sed$/.test(argv[0] || '')) continue;
        if (argv.slice(1).some((a) => /^-[a-zA-Z]*i/.test(a) || a.startsWith('--in-place'))) return { action: 'deny', message: this.message };
      }
      return null;
    },
    cases: {
      fire: ["sed -i 's/a/b/' file.ts", "sed -E -i 's/a/b/' file.ts", "sed -i.bak 's/a/b/' doc.md", "git grep -l X | xargs sed -i 's/X/Y/g'", "sed --in-place 's/a/b/' f"],
      pass: ["sed -n '1,5p' file.ts", "sed 's/a/b/' in.txt > out.txt", 'grep -n "sed -i" notes.md'],
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
