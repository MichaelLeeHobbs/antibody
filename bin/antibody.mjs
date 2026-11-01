#!/usr/bin/env node
// antibody's command line. Run with no arguments for the list of commands.
import { appendFileSync, cpSync, existsSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { PLUGIN_ROOT, claudeDir, config, ensureDir, paths } from '../lib/config.mjs';
import { append, commandHead, isNoise, readEvents, signature } from '../lib/events.mjs';
import { createIssue, listIssues, readIssue, sightings, status, writeIssue, findMatches } from '../lib/issues.mjs';
import { compile, evaluate, loadRules, makeContext, testRule, STATES } from '../lib/rules.mjs';

const CLI = `node "${join(PLUGIN_ROOT, 'bin', 'antibody.mjs').replace(/\\/g, '/')}"`;
const args = process.argv.slice(2);
const cmd = args.shift();
const opt = (name, dflt = null) => {
  const i = args.indexOf(name);
  if (i < 0) return dflt;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
};
const flag = (name) => {
  const i = args.indexOf(name);
  if (i < 0) return false;
  args.splice(i, 1);
  return true;
};
const fail = (msg, code = 1) => {
  process.stderr.write(msg + '\n');
  process.exit(code);
};
const say = (s = '') => process.stdout.write(s + '\n');
const readText = (f) => readFileSync(f, 'utf8').replace(/\r\n/g, '\n');
const days = (n) => new Date(Date.now() - n * 864e5);

const HELP = `antibody: learn from Claude's own tool failures and stop them recurring.

  init [--packs a,b] [--owner <name>]   create the data folder and print the settings to add
  doctor                                check the install: data folder, packs, rules, old hooks
  note [<event id>] <text...>           record what fixed (or caused) a failure, stall or block
  issues [--all]                        every issue with its computed status
  issue show <id>                       one issue in full
  issue add <file.md>                   add an issue (JSON front matter + Markdown body)
  issue fix <id> <text...>              record the fix (starts the "watching" clock)
  issue seen <id> <text...>             add a sighting by hand
  search <words...>                     issues containing every word
  rules [--state shadow|enforce|retired] every rule with its hits in the last 30 days
  rule add <file.json>                  add local data rule(s); new rules start in shadow
  rule promote|demote|retire <id>       change a rule's state
  test                                  run every rule's own cases (exit 1 on any failure)
  snapshot                              copy local rules and guards aside, for replay --before
  replay [--before <snapshot>] [--days N]  re-run logged commands through the rules
  report [--days N]                     the healer's numbers for the last N days (default 7)
  archive                               move fixed, quiet issues to issues/archive
  rotate [--keep-days N]                move events older than N days (default 90) to a dated file
  migrate --from <old ~/.claude>        import a failure-ledger setup (ledger, log, guards)
  export <rule id...>                   print rules as a shareable pack, without local details
  schedule                              how to run the review on a schedule on this OS

Data folder: ${paths().home}`;

function listRuleFiles() {
  const dir = paths().rules;
  return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => join(dir, f)) : [];
}

function saveRuleState(id, state) {
  for (const f of listRuleFiles()) {
    const v = JSON.parse(readText(f));
    const list = [].concat(v);
    const r = list.find((x) => x.id === id);
    if (!r) continue;
    r.state = state;
    r.stateChanged = new Date().toISOString().slice(0, 10);
    writeFileSync(f, JSON.stringify(Array.isArray(v) ? list : r, null, 2) + '\n');
    return `rules/${basename(f)}`;
  }
  // Shipped rules and local guards keep their files; their state lives in config.json.
  const file = paths().config;
  const c = existsSync(file) ? JSON.parse(readText(file)) : {};
  c.ruleState = { ...(c.ruleState || {}), [id]: state };
  writeFileSync(file, JSON.stringify(c, null, 2) + '\n');
  return 'config.json ruleState';
}

const verdict = (res) => (res.decision ? `${res.decision}:${res.reason.match(/^\[([^\]]+)\]/)?.[1]}` : res.command ? `rewrite:${res.hits.find((h) => h.action === 'rewrite')?.rule.id}` : 'allow');

function verdictOf(e, rules) {
  const ctx = makeContext({ tool: e.tool, input: { command: e.command }, cwd: e.cwd || '' });
  return verdict(evaluate(ctx, rules));
}

async function main() {
  switch (cmd) {
    case undefined:
    case 'help':
    case '--help':
      say(HELP);
      return;

    case 'init': {
      const p = paths();
      for (const d of [p.home, p.issues, p.rules, p.guards, p.reviews, p.state]) ensureDir(d);
      const packs = (opt('--packs') || (process.platform === 'win32' ? 'git-bash-windows,windows-orphans' : '')).split(',').map((s) => s.trim()).filter(Boolean);
      const owner = opt('--owner') || '';
      if (!existsSync(p.config)) writeFileSync(p.config, JSON.stringify({ packs, owner }, null, 2) + '\n');
      if (!existsSync(p.learned)) writeFileSync(p.learned, '# Learned rules (maintained by antibody\'s review)\n\nShort rules learned from repeat failures. The review keeps this file under 3 KB.\n');
      const gi = join(p.home, '.gitignore');
      if (!existsSync(gi)) writeFileSync(gi, 'events*.jsonl\nstate/\n');
      const t = (s) => s.replace(claudeDir().replace(/\\/g, '/'), '~/.claude');
      const home = t(p.home.replace(/\\/g, '/'));
      say(`Data folder ready: ${p.home}`);
      say(`Packs: core${packs.length ? ', ' + packs.join(', ') : ''} (change in config.json)`);
      say('');
      say('1. Add this line to ~/.claude/CLAUDE.md so sessions see the learned rules:');
      say(`   @${home}/learned.md`);
      say('');
      say('2. Add these to "permissions" in ~/.claude/settings.json so the review can heal unattended:');
      say(JSON.stringify({
        allow: [`Edit(${home}/issues/**)`, `Edit(${home}/rules/**)`, `Edit(${home}/reviews/**)`, `Edit(${home}/learned.md)`, `Bash(${CLI} *)`],
        deny: ['Edit(~/.claude/settings.json)', 'Edit(~/.claude/settings.local.json)', `Edit(${home}/guards/**)`, `Edit(${home}/events.jsonl)`],
      }, null, 2).replace(/^/gm, '   '));
      say('   (antibody does not edit settings.json itself: that boundary stays a human act.)');
      say('');
      say(`3. Optional: put the data folder under git, so every review is a commit you can revert: cd "${p.home}" && git init`);
      say(`4. Schedule the review: ${CLI} schedule`);
      return;
    }

    case 'doctor': {
      const p = paths();
      const problems = [];
      const ok = (s) => say(`ok    ${s}`);
      const bad = (s) => { problems.push(s); say(`FAIL  ${s}`); };
      Number(process.versions.node.split('.')[0]) >= 18 ? ok(`node ${process.versions.node}`) : bad(`node ${process.versions.node}: antibody needs 18 or later`);
      existsSync(p.home) ? ok(`data folder ${p.home}`) : bad(`no data folder; run: ${CLI} init`);
      try { if (existsSync(p.config)) JSON.parse(readText(p.config)); ok('config.json parses'); } catch (e) { bad(`config.json: ${e.message}`); }
      existsSync(join(PLUGIN_ROOT, 'hooks', 'hooks.json')) ? ok(`plugin at ${PLUGIN_ROOT}`) : bad(`no hooks/hooks.json under ${PLUGIN_ROOT}`);
      const { rules, errors } = await loadRules();
      errors.forEach((e) => bad(e));
      ok(`${rules.length} rules loaded (packs: ${config().packs.join(', ')})`);
      const failing = rules.map((r) => [r, testRule(r)]).filter(([, f]) => f.length);
      failing.length ? failing.forEach(([r, f]) => bad(`rule ${r.id}: ${f.length} case(s) fail; run: ${CLI} test`)) : ok('every rule passes its own cases');
      const untested = rules.filter((r) => !(r.cases?.fire || []).length);
      if (untested.length) say(`note  rules with no cases: ${untested.map((r) => r.id).join(', ')}`);
      const settings = join(claudeDir(), 'settings.json');
      if (existsSync(settings)) {
        const s = readText(settings);
        if (/log-failure\.mjs|guard-[\w-]+\.mjs/.test(s)) say('note  settings.json still registers old failure-ledger hooks; remove them once you have migrated, or failures get logged twice');
        try {
          const j = JSON.parse(s);
          const en = Object.entries(j.enabledPlugins || {}).find(([k]) => k.startsWith('antibody@'));
          if (en && en[1] === false) bad('the antibody plugin is disabled in settings.json (enabledPlugins)');
        } catch {}
      }
      process.exit(problems.length ? 1 : 0);
    }

    case 'note': {
      const id = /^e[0-9a-z]{8,}$/.test(args[0] || '') ? args.shift() : null;
      const text = args.join(' ').trim();
      if (!text) fail(`Usage: ${CLI} note [<event id>] <what fixed it, or why it hung>`);
      let target = id;
      if (!target) {
        const recent = readEvents({ since: days(1), kinds: ['failure', 'timeout', 'stall', 'interrupt', 'block', 'slow'] });
        const cwd = process.cwd().replace(/\\/g, '/').toLowerCase();
        const here = recent.filter((e) => String(e.cwd || '').replace(/\\/g, '/').toLowerCase() === cwd);
        target = (here.length ? here : recent).at(-1)?.id || null;
      }
      const ev = append({ kind: 'note', after: target, text, cwd: process.cwd() });
      say(`noted${target ? ` on ${target}` : ''} (${ev.id}). The review turns notes into fixes and rules.`);
      return;
    }

    case 'issues': {
      const all = flag('--all');
      const events = readEvents({ since: days(90) });
      const list = listIssues({ archived: all });
      for (const i of list) say(`${status(i, events).padEnd(9)} ${String(sightings(i, events)).padStart(3)}x  ${i.id}  ${i.title}${Object.keys(i.when || {}).length ? '' : '  (no matcher)'}`);
      say(`${list.length} issues`);
      return;
    }

    case 'issue': {
      const sub = args.shift();
      if (sub === 'show') {
        const i = readIssue(args[0]) || fail(`No issue ${args[0]}`);
        say(readText(join(i.archived ? paths().archive : paths().issues, `${i.id}.md`)));
        return;
      }
      if (sub === 'add') {
        const file = args[0] || fail('Usage: issue add <file.md>');
        const text = readText(file);
        const { parseIssue } = await import('../lib/issues.mjs');
        const parsed = text.startsWith('---\n') ? parseIssue(text, file) : { title: text.split('\n')[0].replace(/^#+\s*/, ''), body: text };
        if (!parsed.title) fail('The issue needs a title.');
        const dup = listIssues().find((x) => x.title.toLowerCase() === parsed.title.toLowerCase());
        if (dup) fail(`${dup.id} already has this title; add a sighting: ${CLI} issue seen ${dup.id} <text>`);
        const { id: _drop, ...fields } = parsed;
        const i = createIssue(fields);
        say(`added ${i.id}: ${i.title}`);
        return;
      }
      if (sub === 'fix' || sub === 'seen') {
        const i = readIssue(args.shift()) || fail('No such issue');
        const text = args.join(' ').trim() || fail('Give the text.');
        if (sub === 'fix') Object.assign(i, { fix: text, fixedAt: new Date().toISOString() });
        else i.seen = [...(i.seen || []), `${new Date().toISOString().slice(0, 10)}, ${text}`];
        writeIssue(i);
        say(`${i.id} ${sub === 'fix' ? 'fix recorded; now watching for recurrence' : 'sighting added'}`);
        return;
      }
      fail('Usage: issue show|add|fix|seen ...');
      return;
    }

    case 'search': {
      const ws = args.map((w) => w.toLowerCase());
      const hits = listIssues({ archived: true }).filter((i) => ws.every((w) => JSON.stringify(i).toLowerCase().includes(w)));
      for (const i of hits) say(`${i.id}  ${i.title}\n  fix: ${i.fix || '(none yet)'}\n`);
      say(`${hits.length} issues match`);
      return;
    }

    case 'rules': {
      const want = opt('--state');
      const { rules } = await loadRules();
      const events = readEvents({ since: days(30), kinds: ['block', 'ask', 'warn', 'rewrite', 'shadow'] });
      for (const r of rules.filter((x) => !want || x.state === want)) {
        const ev = events.filter((e) => e.rule === r.id);
        say(`${r.state.padEnd(8)} ${r.action.padEnd(7)} ${String(ev.length).padStart(4)} hits  ${r.id}  (${r.source}${r.pack ? ':' + r.pack : ''})`);
      }
      return;
    }

    case 'rule': {
      const sub = args.shift();
      if (sub === 'add') {
        const file = args[0] || fail('Usage: rule add <file.json>');
        const list = [].concat(JSON.parse(readText(file)));
        const { rules } = await loadRules();
        for (const r of list) {
          if (!r.id || !/^[\w.-]+$/.test(r.id)) fail(`Each rule needs an id of letters, digits, dots or dashes: ${JSON.stringify(r).slice(0, 80)}`);
          if (typeof r.check !== 'undefined') fail(`${r.id}: data rules cannot carry code`);
          if (rules.some((x) => x.id === r.id)) fail(`${r.id} already exists`);
          if (!r.cases?.fire?.length || !r.cases?.pass?.length) fail(`${r.id}: give at least one "fire" and one "pass" case`);
          r.state = r.state || 'shadow';
          const f = testRule(compile(r));
          if (f.length) fail(`${r.id}: its own cases fail:\n${JSON.stringify(f, null, 2)}`);
        }
        ensureDir(paths().rules);
        const out = join(paths().rules, basename(file));
        if (existsSync(out)) fail(`rules/${basename(file)} exists; pick another file name`);
        writeFileSync(out, JSON.stringify(list.length === 1 ? list[0] : list, null, 2) + '\n');
        say(`added ${list.map((r) => `${r.id} (${r.state})`).join(', ')} to rules/${basename(file)}`);
        return;
      }
      const state = { promote: 'enforce', demote: 'shadow', retire: 'retired' }[sub];
      if (!state) fail('Usage: rule add <file> | rule promote|demote|retire <id>');
      const id = args[0] || fail('Name the rule.');
      const { rules } = await loadRules();
      const r = rules.find((x) => x.id === id) || fail(`No rule ${id}`);
      if (state === 'enforce') {
        const f = testRule(r);
        if (f.length) fail(`${id} fails its own cases; fix them before promoting:\n${JSON.stringify(f, null, 2)}`);
      }
      say(`${id}: ${r.state} -> ${state} (saved in ${saveRuleState(id, state)})`);
      return;
    }

    case 'test': {
      const { rules, errors } = await loadRules();
      let bad = errors.length;
      errors.forEach((e) => say(`FAIL  load: ${e}`));
      for (const r of rules) {
        const f = testRule(r);
        if (f.length) bad++;
        say(`${f.length ? 'FAIL' : 'ok  '}  ${r.id}  (${(r.cases?.fire || []).length} fire, ${(r.cases?.pass || []).length} pass)`);
        for (const x of f) say(`        ${JSON.stringify(x)}`);
      }
      say(`${rules.length} rules, ${bad} failing`);
      process.exit(bad ? 1 : 0);
    }

    case 'snapshot': {
      const dir = join(paths().snapshots, new Date().toISOString().replace(/[:.]/g, '-'));
      ensureDir(dir);
      for (const sub of ['rules', 'guards']) if (existsSync(paths()[sub])) cpSync(paths()[sub], join(dir, sub), { recursive: true });
      if (existsSync(paths().config)) cpSync(paths().config, join(dir, 'config.json'));
      say(dir);
      return;
    }

    case 'replay': {
      const before = opt('--before');
      const n = Number(opt('--days', '30'));
      const events = readEvents({ since: days(n) }).filter((e) => typeof e.command === 'string' && (e.tool === 'Bash' || e.tool === 'PowerShell') && e.kind !== 'note');
      const seen = new Set();
      const uniq = events.filter((e) => (seen.has(e.tool + e.command) ? false : seen.add(e.tool + e.command)));
      const now = (await loadRules()).rules;
      if (before) {
        const old = (await loadRules({ rulesDir: join(before, 'rules'), guardsDir: join(before, 'guards') })).rules;
        let changed = 0;
        for (const e of uniq) {
          const a = verdictOf(e, old);
          const b = verdictOf(e, now);
          if (a !== b) { changed++; say(`CHANGED ${a} -> ${b}  ${e.ts.slice(0, 16)} ${JSON.stringify(e.command).slice(0, 160)}`); }
        }
        say(`replay: ${uniq.length} distinct commands from the last ${n} days, ${changed} verdicts changed`);
        process.exit(0);
      }
      const blocks = uniq.filter((e) => e.kind === 'block');
      const nowAllowed = blocks.filter((e) => verdictOf(e, now) === 'allow');
      const counts = {};
      for (const e of uniq) { const v = verdictOf(e, now); if (v !== 'allow') counts[v] = (counts[v] || 0) + 1; }
      say(`replay: ${uniq.length} distinct commands from the last ${n} days`);
      for (const [v, c] of Object.entries(counts).sort((a, b) => b[1] - a[1])) say(`  ${String(c).padStart(4)}  ${v}`);
      say(`blocked when logged but allowed now (false positives since fixed): ${nowAllowed.length}`);
      for (const e of nowAllowed) say(`  ${e.ts.slice(0, 16)} ${e.rule}: ${JSON.stringify(e.command).slice(0, 160)}`);
      return;
    }

    case 'report': {
      const n = Number(opt('--days', '7'));
      say(report(n, await loadRules()));
      return;
    }

    case 'archive': {
      const events = readEvents({ since: days(90) });
      let moved = 0;
      for (const i of listIssues()) {
        if (status(i, events) !== 'fixed') continue;
        ensureDir(paths().archive);
        renameSync(join(paths().issues, `${i.id}.md`), join(paths().archive, `${i.id}.md`));
        moved++;
      }
      say(`archived ${moved} fixed, quiet issues (search still reads them)`);
      return;
    }

    case 'rotate': {
      const keep = Number(opt('--keep-days', '90'));
      const file = paths().events;
      if (!existsSync(file)) return say('no events yet');
      const cut = days(keep);
      // Move the log aside first, in one rename. Hooks that append from now on start a fresh
      // events.jsonl, so no line written during the rotation is lost; the recent lines from the
      // old file are then appended back (readEvents orders by time, so their position is fine).
      const work = file + `.rotating-${process.pid}`;
      let moved = false;
      for (let t = 0; t < 20 && !moved; t++) {
        try { renameSync(file, work); moved = true; } catch (err) {
          if (!['EBUSY', 'EPERM', 'EACCES'].includes(err.code)) throw err;
          const until = Date.now() + 50; while (Date.now() < until); // a hook has the file open on Windows; retry
        }
      }
      if (!moved) return fail('events.jsonl is busy; try again');
      const lines = readText(work).split('\n').filter(Boolean);
      const old = [];
      const fresh = [];
      for (const l of lines) { let t; try { t = new Date(JSON.parse(l).ts); } catch { t = new Date(); } (t < cut ? old : fresh).push(l); }
      const dest = join(paths().home, `events-${new Date().toISOString().slice(0, 10)}.jsonl`);
      if (old.length) writeFileSync(dest, old.join('\n') + '\n', { flag: 'a' });
      if (fresh.length) appendFileSync(file, fresh.join('\n') + '\n');
      rmSync(work, { force: true });
      if (!old.length) return say('nothing to rotate');
      say(`moved ${old.length} events older than ${keep} days to ${basename(dest)}`);
      return;
    }

    case 'migrate': {
      const from = opt('--from') || fail('Usage: migrate --from <old ~/.claude folder>');
      say(migrate(from));
      return;
    }

    case 'export': {
      const { rules } = await loadRules();
      const out = [];
      for (const id of args) {
        const r = rules.find((x) => x.id === id) || fail(`No rule ${id}`);
        if (r.source !== 'local') fail(`${id} is ${r.source === 'pack' ? 'already shipped' : 'code (a local guard)'}; only data rules export`);
        const { source, file, issue, stateChanged, check, ...rest } = r;
        if (rest.scope) delete rest.scope.cwd;
        out.push({ ...rest, state: 'shadow' });
      }
      say(JSON.stringify(out, null, 2));
      return;
    }

    case 'schedule': {
      const home = paths().home;
      const run = 'claude -p "/antibody:review" --permission-mode acceptEdits';
      say('Run the review from the data folder, so its edits stay inside the working directory.');
      say('Never use --permission-mode bypassPermissions for it: the review must stay inside its allow list.\n');
      if (process.platform === 'win32') say(`Windows (Task Scheduler, daily 09:00):\n  schtasks /create /sc daily /st 09:00 /tn antibody-review /tr "cmd /c cd /d \\"${home}\\" && ${run.replace(/"/g, '\\"')}"`);
      else if (process.platform === 'darwin') say(`macOS: add a launchd agent, or cron:\n  crontab -e\n  0 9 * * * cd "${home}" && ${run} >> "${home}/reviews/cron.log" 2>&1`);
      else say(`Linux (cron, daily 09:00):\n  crontab -e\n  0 9 * * * cd "${home}" && ${run} >> "${home}/reviews/cron.log" 2>&1`);
      say('\nWith the Claude desktop app, a scheduled task with the prompt "/antibody:review" works as well.');
      return;
    }

    default:
      fail(`Unknown command: ${cmd}\n\n${HELP}`);
  }
}

// ---------------------------------------------------------------------------------------------

function report(n, { rules, errors }) {
  const since = days(n);
  const events = readEvents({ since });
  const all90 = readEvents({ since: days(90) });
  const issues = listIssues();
  const out = [];
  const p = (s = '') => out.push(s);
  const count = (xs, key) => Object.entries(xs.reduce((m, x) => ((m[key(x)] = (m[key(x)] || 0) + 1), m), {})).sort((a, b) => b[1] - a[1]);
  const kinds = count(events, (e) => e.kind);
  const sessions = new Set(events.map((e) => e.session_id).filter(Boolean)).size;
  p(`# antibody report, last ${n} days (since ${since.toISOString().slice(0, 10)})`);
  p();
  p(`Events: ${kinds.map(([k, c]) => `${k} ${c}`).join(', ') || 'none'}; ${sessions} sessions.`);
  if (errors.length) p(`Rule load errors: ${errors.join('; ')}`);

  const troubles = events.filter((e) => ['failure', 'timeout', 'stall', 'interrupt', 'slow'].includes(e.kind));
  const notes = events.filter((e) => e.kind === 'note');
  const recov = all90.filter((e) => e.kind === 'recovery');
  const unexplained = troubles.filter((e) => !findMatches(e, issues).length);
  p();
  p(`## Not covered by any issue (${unexplained.length} events), most common first`);
  for (const [sig, c] of count(unexplained, (e) => e.signature || `${e.tool} | ${e.kind}`).slice(0, 30)) {
    const ex = unexplained.filter((e) => (e.signature || `${e.tool} | ${e.kind}`) === sig);
    const sess = new Set(ex.map((e) => e.session_id)).size;
    p(`- ${c}x in ${sess} session(s) [${ex[0].kind}] ${sig}`);
    p(`  e.g. ${ex[0].id}: ${JSON.stringify(ex[0].command ?? ex[0].input ?? '').slice(0, 200)}`);
    for (const nt of notes.filter((x) => ex.some((e) => e.id === x.after)).slice(0, 3)) p(`  note: ${nt.text}`);
    const r = recov.find((x) => ex.some((e) => e.id === x.after));
    if (r) p(`  worked next: ${JSON.stringify(r.command).slice(0, 200)}`);
  }

  p();
  p('## Stalls and interrupts');
  const stalls = events.filter((e) => ['stall', 'interrupt', 'timeout', 'slow'].includes(e.kind));
  if (!stalls.length) p('None.');
  for (const e of stalls.slice(-20)) {
    const nt = notes.find((x) => x.after === e.id);
    p(`- ${e.ts.slice(0, 16)} ${e.kind}${e.ranMs ? ` after ${Math.round(e.ranMs / 1000)}s` : ''}: ${JSON.stringify(e.command ?? e.task ?? '').slice(0, 160)}${nt ? `\n  note: ${nt.text}` : ''}`);
  }

  p();
  p('## Issues');
  const st = issues.map((i) => [i, status(i, all90), sightings(i, events)]);
  p(`${issues.length} issues: ${count(st, ([, s]) => s).map(([k, c]) => `${k} ${c}`).join(', ') || 'none'}.`);
  for (const [i, s, c] of st.filter(([, s]) => s === 'recurring')) p(`- RECURRING ${i.id} ${i.title} (${c}x this period): the fix did not hold; strengthen it`);
  for (const [i, , c] of st.filter(([, s]) => s === 'open')) p(`- open ${i.id} ${i.title}${c ? ` (${c}x this period)` : ''}`);
  const blind = issues.filter((i) => !Object.keys(i.when || {}).length);
  if (blind.length) p(`- ${blind.length} issues have no "when" matcher, so their fix cannot be handed back at the moment of failure: ${blind.slice(0, 15).map((i) => i.id).join(', ')}${blind.length > 15 ? ', ...' : ''}`);

  p();
  p('## Rules');
  const acts = events.filter((e) => ['block', 'ask', 'warn', 'rewrite', 'shadow'].includes(e.kind));
  for (const r of rules) {
    const ev = acts.filter((e) => e.rule === r.id);
    if (!ev.length && r.state !== 'shadow') continue;
    const sess = new Set(ev.map((e) => e.session_id)).size;
    const disputed = notes.filter((x) => ev.some((e) => e.id === x.after));
    let line = `- ${r.id} [${r.state} ${r.action}] ${ev.length} hits in ${sess} sessions`;
    if (r.state === 'shadow') {
      const { minHits, minSessions } = config().promote;
      line += ev.length >= minHits && sess >= minSessions && !disputed.length ? ' -> ready to promote (check the hits below are real)' : ` (promotion needs ${minHits} hits in ${minSessions} sessions, none disputed)`;
    }
    p(line);
    for (const d of disputed.slice(0, 3)) p(`  disputed: ${d.text}`);
    if (r.state === 'shadow') for (const e of ev.slice(-3)) p(`  hit: ${JSON.stringify(e.command).slice(0, 160)}`);
  }

  p();
  p('## Notes from sessions');
  if (!notes.length) p('None.');
  for (const nt of notes.slice(-20)) p(`- ${nt.ts.slice(0, 16)}${nt.after ? ` on ${nt.after}` : ''}: ${nt.text}`);
  return out.join('\n');
}

// Import a failure-ledger setup: failure-ledger.md entries become issues, failure-log.jsonl lines
// become events, and guard-*.mjs files become local guards. Nothing in the old folder changes.
function migrate(from) {
  const out = [];
  const p = paths();
  for (const d of [p.home, p.issues, p.rules, p.guards, p.reviews]) ensureDir(d);
  const ledger = join(from, 'failure-ledger.md');
  if (existsSync(ledger)) {
    const text = readText(ledger);
    const entries = text.split(/^(?=### )/m).filter((s) => s.startsWith('### '));
    const existing = new Set(listIssues({ archived: true }).map((i) => i.title.toLowerCase()));
    let added = 0;
    for (const e of entries) {
      const title = e.split('\n')[0].slice(4).trim();
      if (existing.has(title.toLowerCase())) continue;
      const fields = {};
      let last = null;
      for (const l of e.split('\n').slice(1)) {
        const m = l.match(/^- (Seen|What failed|Root cause|Fix|Status):\s*(.*)$/);
        if (m) { last = m[1]; (fields[last] ||= []).push(m[2]); }
        else if (last && l.trim()) fields[last][fields[last].length - 1] += '\n' + l;
      }
      const statusText = (fields.Status || [''])[0];
      const seen = fields.Seen || [];
      const lastDate = seen.map((s) => s.match(/\d{4}-\d\d-\d\d/)?.[0]).filter(Boolean).sort().at(-1);
      const body = [`## What failed\n${(fields['What failed'] || ['']).join('\n')}`, `## Root cause\n${(fields['Root cause'] || ['']).join('\n')}`, `## Fix\n${(fields.Fix || ['']).join('\n')}`, `## Status when imported\n${statusText}`].join('\n\n');
      const fixed = /^fixed/i.test(statusText);
      createIssue({ title, seen, fix: (fields.Fix || [''])[0].slice(0, 400), ...(fixed && lastDate ? { fixedAt: `${lastDate}T23:59:59.000Z` } : {}), imported: 'failure-ledger', body });
      added++;
    }
    out.push(`issues: ${added} added from ${entries.length} ledger entries (titles already present were skipped)`);
    out.push('  None has a "when" matcher yet, so fixes are not handed back at failure time until the review adds them.');
  } else out.push(`no ${ledger}`);

  const log = join(from, 'failure-log.jsonl');
  if (existsSync(log)) {
    const lines = readText(log).split('\n').filter(Boolean);
    let n = 0;
    const target = p.events;
    const have = existsSync(target) ? new Set(readText(target).split('\n').filter(Boolean).map((l) => { try { const j = JSON.parse(l); return j.ts + j.session_id; } catch { return ''; } })) : new Set();
    const buf = [];
    for (const l of lines) {
      let j;
      try { j = JSON.parse(l); } catch { continue; }
      if (have.has(j.ts + j.session_id)) continue;
      const command = j.input?.command;
      const guard = String(j.tool).startsWith('guard:');
      const tool = guard ? 'Bash' : j.tool;
      const text = typeof j.error === 'string' ? j.error : JSON.stringify(j.error ?? '');
      const kind = guard ? 'block' : isNoise(tool, command, text) ? 'noise' : 'failure';
      buf.push(JSON.stringify({ id: 'm' + Buffer.from(j.ts + (j.session_id || '')).toString('base64url').slice(0, 14), ts: j.ts, kind, session_id: j.session_id, cwd: j.cwd, tool, rule: guard ? `legacy.${String(j.tool).slice(6)}` : undefined, command, input: guard ? undefined : j.input, error: guard ? undefined : text, message: guard ? text : undefined, signature: guard ? undefined : signature(tool, command, text), imported: true }));
      n++;
    }
    if (buf.length) writeFileSync(target, buf.join('\n') + '\n', { flag: 'a' });
    out.push(`events: ${n} imported from failure-log.jsonl`);
  } else out.push(`no ${log}`);

  const hooks = join(from, 'hooks');
  if (existsSync(hooks)) {
    ensureDir(join(p.guards, 'lib'));
    cpSync(join(PLUGIN_ROOT, 'templates', 'legacy-guard.mjs'), join(p.guards, 'lib', 'legacy-guard.mjs'));
    cpSync(join(PLUGIN_ROOT, 'lib', 'shell.mjs'), join(p.guards, 'lib', 'shell.mjs'));
    for (const f of readdirSync(hooks).filter((x) => /^guard-[\w-]+\.mjs$/.test(x) && !x.includes('.bak'))) {
      const name = f.slice(6, -4);
      if (name === 'bash-quoting') { out.push('guards: guard-bash-quoting.mjs is covered by the git-bash-windows pack (turn it on in config.json); not copied'); continue; }
      const dest = join(p.guards, `${name}.mjs`);
      if (existsSync(dest)) { out.push(`guards: ${name}.mjs already exists; skipped`); continue; }
      let src = readText(join(hooks, f));
      src = src.replace(/^import\s*\{([^}]*)\}\s*from\s*['"]\.\/lib\/guard\.mjs['"];?/m, (_, names) => `import {${names.replace(/\brunGuard\b,?\s*/, '')}} from './lib/legacy-guard.mjs';`);
      src = src.replace(/^runGuard\(\s*['"]([\w-]+)['"]\s*,\s*(\w+)\s*\);?\s*$/m, (_, id, fn) => `export default { id: 'legacy.${id}', tools: ['Bash', 'PowerShell'], action: 'deny', message: '', check: (ctx) => ${fn}(ctx.command || '') };`);
      if (!/export default/.test(src)) { out.push(`guards: ${f} has no runGuard(...) call to convert; skipped`); continue; }
      writeFileSync(dest, src);
      out.push(`guards: ${f} -> guards/${name}.mjs (rule legacy.${name}); add its test cases with a "cases" field`);
    }
  }
  out.push('');
  out.push(`Next: ${CLI} doctor, then ${CLI} report --days 30. Remove the old hooks from settings.json once antibody's look right.`);
  return out.join('\n');
}

await main();
