import { test } from 'node:test';
import assert from 'node:assert/strict';
import { flagValue, heredocs, mask, parse, stages, subcommands, unquote } from '../lib/shell.mjs';

const names = (cmd, d) => stages(cmd, d).map((s) => s.name);

test('mask keeps length and hides quoted text', () => {
  const c = `grep "a|b" 'c;d' e`;
  const m = mask(c);
  assert.equal(m.length, c.length);
  assert.equal(m, `grep "xxx" 'xxx' e`);
});

test('bash: a backslash does not escape inside single quotes', () => {
  // 'a\' is a complete single-quoted word in bash; the pipe after it is structure.
  assert.deepEqual(names(`echo 'a\\' | grep x`), ['echo', 'grep']);
});

test('bash: escaped characters outside quotes are not structure', () => {
  assert.deepEqual(names('echo a\\|b; ls'), ['echo', 'ls']);
  assert.deepEqual(names('echo \\"; ls'), ['echo', 'ls']);
});

test('separators and pipes', () => {
  assert.deepEqual(names('a && b || c; d\ne | f |& g'), ['a', 'b', 'c', 'd', 'e', 'f', 'g']);
  assert.deepEqual(names('sleep 5 & echo hi'), ['sleep', 'echo']);
  assert.deepEqual(names('make 2>&1 | tail -n 3'), ['make', 'tail']);
  assert.deepEqual(names('make &> log.txt'), ['make']);
});

test('command substitution and comments are not structure', () => {
  assert.deepEqual(names('x=$(git log | head -1); echo "$x"'), ['', 'echo']);
  assert.deepEqual(names('echo `a | b`'), ['echo']);
  assert.deepEqual(names('ls # | rm -rf /'), ['ls']);
  assert.deepEqual(names('echo $((1 << 2))'), ['echo']);
});

test('heredoc bodies are not commands', () => {
  const c = "cat > f.txt <<'EOF'\nsed -i x y\nrm -rf /\nEOF\nls";
  assert.deepEqual(names(c), ['cat', 'ls']);
  assert.equal(heredocs(c)[0].body, 'sed -i x y\nrm -rf /');
  assert.deepEqual(names('cat <<-EOF\n\tbody | x\n\tEOF\necho done'), ['cat', 'echo']);
});

test('heredocs() finds one inside $(...)', () => {
  const h = heredocs("git commit -m \"$(cat <<'EOF'\nFix it\nEOF\n)\"");
  assert.equal(h.length, 1);
  assert.equal(h[0].body, 'Fix it');
});

test('words, redirects, assignments and names', () => {
  const [st] = stages(`FOO=1 C:/tools/twg.exe jira workitem get MED-1 --id "a b" > "out file.txt" 2>&1`);
  assert.equal(st.name, 'twg');
  assert.deepEqual(st.assigns, ['FOO=1']);
  assert.deepEqual(st.argv, ['C:/tools/twg.exe', 'jira', 'workitem', 'get', 'MED-1', '--id', 'a b']);
  assert.deepEqual(st.redirects.map((r) => [r.op, r.target]), [['>', 'out file.txt'], ['>&', '1']]);
  assert.equal(flagValue(st, '--id'), 'a b');
  assert.deepEqual(subcommands(st), ['jira', 'workitem', 'get']);
});

test('unquote follows bash rules', () => {
  assert.equal(unquote(`'a\\b'`), 'a\\b');
  assert.equal(unquote(`"a\\"b"`), 'a"b');
  assert.equal(unquote(`a\\ b`), 'a b');
  assert.equal(unquote(`"$x"'y'`), '$xy');
});

test('powershell quoting', () => {
  assert.deepEqual(names(`Write-Host 'it''s; fine' ; Get-ChildItem | Select-Object Name`, 'powershell'), ['write-host', 'get-childitem', 'select-object']);
  assert.deepEqual(names('Write-Host "a`"; b" ; ls', 'powershell'), ['write-host', 'ls']);
  assert.deepEqual(names("$x = @'\nline; | not structure\n'@\nls", 'powershell'), ['$x', 'ls']);
});

test('parse groups stages into pipelines', () => {
  const p = parse('a | b; c');
  assert.equal(p.length, 2);
  assert.deepEqual(p[0].stages.map((s) => s.name), ['a', 'b']);
});

test('a heredoc body adds no words to the command that opened it', () => {
  const [st] = stages("cat <<'EOF' | grep x\nsed -i a b\nEOF");
  assert.deepEqual(st.argv, ['cat']);
  assert.equal(stages("cat <<'EOF' | grep x\nsed -i a b\nEOF").length, 2);
});

test('newlines inside quotes and line continuations do not split a command', () => {
  assert.deepEqual(names('echo "a\nb" | grep x f'), ['echo', 'grep']);
  assert.deepEqual(stages('ls \\\n  -la')[0].argv, ['ls', '-la']);
  const ps = stages('Set-Content -Value "a\nb" `\n -Path x.json', 'powershell');
  assert.equal(ps.length, 1);
  assert.deepEqual(ps[0].argv, ['Set-Content', '-Value', 'a\nb', '-Path', 'x.json']);
});

test('redirects attached to words are still redirects', () => {
  const r = (c, d) => stages(c, d).map((s) => [s.argv, s.redirects.map((x) => x.fd + x.op + x.target)]);
  assert.deepEqual(r('echo {}>~/.claude/settings.json'), [[['echo', '{}'], ['>~/.claude/settings.json']]]);
  assert.deepEqual(r('cat<file'), [[['cat'], ['<file']]]);
  assert.deepEqual(r('cmd foo2>x 2>&1'), [[['cmd', 'foo2'], ['>x', '2>&1']]]);
  assert.deepEqual(r('echo "a>b" x'), [[['echo', 'a>b', 'x'], []]]);
  assert.deepEqual(r('Get-X 2>&1 *>out.txt', 'powershell'), [[['Get-X'], ['2>&1', '*>out.txt']]]);
  assert.deepEqual(r('diff <(sort a) <(sort b)'), [[['diff'], ['<(sort a)', '<(sort b)']]]);
});

test('comments add no words', () => {
  assert.deepEqual(stages('grep foo # explain this')[0].argv, ['grep', 'foo']);
  assert.deepEqual(stages('Get-Item x # note', 'powershell')[0].argv, ['Get-Item', 'x']);
});
