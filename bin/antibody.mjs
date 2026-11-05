#!/usr/bin/env node
// antibody's command line. Run with no arguments for the list of commands.
import { appendFileSync, cpSync, existsSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { PLUGIN_ROOT, claudeDir, config, ensureDir, lastReview, paths } from '../lib/config.mjs';
import { append, commandHead, readEvents, redact, signature } from '../lib/events.mjs';
import { createIssue, listIssues, readIssue, sightings, status, writeIssue, findMatches } from '../lib/issues.mjs';
import { compile, evaluate, loadRules, makeContext, testRule, STATES } from '../lib/rules.mjs';
import { MANIFEST, readManifest, sameFiles, verifyFiles } from '../lib/manifest.mjs';
import { CHANGELOG, REPO, UPDATE, changes, checkEnabled, compareVersions, installedVersion, markSeen, readState, refresh, seenVersion } from '../lib/update.mjs';

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
  permissions [--apply] [--file <path>] show the permission entries settings.json is missing;
                                        --apply adds them (backs the file up first). Run it
                                        yourself: a Claude session is asked before it can apply
  doctor [--online]                     check the install: data folder, packs, rules, the plugin's
                                        files against the release manifest; --online also checks
                                        that manifest against the one published at the release tag
  update-check                          look for a newer release now (antibody also looks once a
                                        day at session start; "updateCheck": false turns it off)
  whats-new [--all] [--seen]            the changelog since the release you last confirmed (--all:
                                        every release); --seen confirms you've read it, which stops
                                        the notice that otherwise shows at every session start
  bug [--event <id>] [--issue <id>] [--out <file>]
                                        draft a bug report about antibody itself, with your
                                        version and setup; home paths and secrets are taken out
  bug --submit <file> --title <title>   file the draft on GitHub with gh. A person asks for this;
                                        antibody asks them before it runs and refuses in auto mode
  note [<event id>] <text...>           record what fixed (or caused) a failure, stall or block
  issues [--all]                        every issue with its computed status
  issue show <id>                       one issue in full
  issue add <file.md>                   add an issue (JSON front matter + Markdown body)
  issue fix <id> <text...>              record the fix (starts the "watching" clock)
  issue seen <id> <text...>             add a sighting by hand
  issue archive <id> [--project] <why...>  close an issue by hand: clears its matcher so its fix
                                        is no longer handed back; --project marks it a defect in
                                        the person's project (not Claude's) and retires its rules
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

// The permission entries antibody needs in ~/.claude/settings.json. No entry names the plugin's
// versioned path: "Bash(antibody *)" keeps working after an update, a full path would not.
const tildeHome = () => paths().home.replace(/\\/g, '/').replace(claudeDir().replace(/\\/g, '/'), '~/.claude');
function permissionEntries() {
  const home = tildeHome();
  return {
    allow: [`Edit(${home}/issues/**)`, `Edit(${home}/rules/**)`, `Edit(${home}/reviews/**)`, `Edit(${home}/learned.md)`, 'Bash(antibody *)'],
    deny: ['Edit(~/.claude/settings.json)', 'Edit(~/.claude/settings.local.json)', `Edit(${home}/guards/**)`, `Edit(${home}/events.jsonl)`],
  };
}

// Entries an older init printed that name one plugin version's path; they stop matching after an update.
const pinned = (e) => /^Bash\(node ".*[\\/]antibody[\\/][^\\/]+[\\/]bin[\\/]antibody\.mjs" \*\)$/.test(e);

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
      // A new install has no old releases to catch up on.
      if (!readState().seenVersion) markSeen(seenVersion());
      const gi = join(p.home, '.gitignore');
      if (!existsSync(gi)) writeFileSync(gi, 'events*.jsonl\nstate/\n');
      const home = tildeHome();
      say(`Data folder ready: ${p.home}`);
      say(`Packs: core${packs.length ? ', ' + packs.join(', ') : ''} (change in config.json)`);
      say('');
      say('1. Add this line to ~/.claude/CLAUDE.md so sessions see the learned rules:');
      say(`   @${home}/learned.md`);
      say('');
      say('2. Add these to "permissions" in ~/.claude/settings.json so the review can heal unattended:');
      say(JSON.stringify(permissionEntries(), null, 2).replace(/^/gm, '   '));
      say('   To merge them for you, run this in your own terminal, not in a Claude session. It shows what it would');
      say('   add; add --apply to back the file up and add only the missing entries:');
      say(`     ${CLI} permissions`);
      say('   (A Claude session never edits settings.json on its own: that boundary stays a human act.)');
      say('');
      say(`3. Optional: put the data folder under git, so every review is a commit you can revert: cd "${p.home}" && git init`);
      say(`4. Schedule the review: ${CLI} schedule`);
      return;
    }

    case 'permissions': {
      const apply = flag('--apply');
      const file = opt('--file') || join(claudeDir(), 'settings.json');
      let settings = {};
      if (existsSync(file)) {
        try { settings = JSON.parse(readText(file)); } catch (e) { fail(`${file} isn't valid JSON (${e.message}). Fix it first; antibody won't rewrite it.`); }
        if (!settings || typeof settings !== 'object' || Array.isArray(settings)) fail(`${file} doesn't hold a JSON object; antibody won't rewrite it.`);
      }
      const perms = settings.permissions || {};
      const want = permissionEntries();
      const add = {};
      for (const k of ['allow', 'deny']) {
        if (perms[k] !== undefined && !Array.isArray(perms[k])) fail(`"permissions.${k}" in ${file} isn't a list; antibody won't rewrite it.`);
        add[k] = want[k].filter((e) => !(perms[k] || []).includes(e));
      }
      const stale = [...(perms.allow || []), ...(perms.deny || [])].filter(pinned);
      say(`Settings file: ${file}${existsSync(file) ? '' : ' (not there yet; --apply creates it)'}`);
      const n = add.allow.length + add.deny.length;
      if (!n) say('Every antibody permission entry is already there.');
      for (const k of ['allow', 'deny']) for (const e of add[k]) say(`  + ${k.padEnd(5)} ${e}`);
      if (stale.length) {
        say('These entries name one plugin version\'s path and stop matching after an update. "Bash(antibody *)" covers them; remove them by hand if you like:');
        stale.forEach((e) => say(`  - ${e}`));
      }
      if (!n) return;
      if (!apply) {
        say(`Nothing changed. To add ${n === 1 ? 'this entry' : `these ${n} entries`}, run this in your own terminal: ${CLI} permissions --apply`);
        return;
      }
      if (existsSync(file)) {
        const backup = `${file}.antibody-backup-${new Date().toISOString().replace(/[:.]/g, '-')}`;
        cpSync(file, backup);
        say(`Backed up to ${backup}`);
      } else ensureDir(join(file, '..'));
      settings.permissions = { ...perms };
      for (const k of ['allow', 'deny']) if (add[k].length) settings.permissions[k] = [...(perms[k] || []), ...add[k]];
      const tmp = `${file}.antibody-tmp`;
      writeFileSync(tmp, JSON.stringify(settings, null, 2) + '\n');
      renameSync(tmp, file);
      say(`Added ${n} ${n === 1 ? 'entry' : 'entries'} to ${file}. Start a new Claude session so they take effect.`);
      return;
    }

    case 'doctor': {
      const online = flag('--online');
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
        try {
          const j = JSON.parse(s);
          const en = Object.entries(j.enabledPlugins || {}).find(([k]) => k.startsWith('antibody@'));
          if (en && en[1] === false) bad('the antibody plugin is disabled in settings.json (enabledPlugins)');
        } catch {}
      }
      const last = lastReview();
      if (!last || Date.now() - Date.parse(last) >= 2 * 864e5) say(`note  the review last ran ${last || 'never'}; it's meant to run daily: ${CLI} schedule`);
      else ok(`the review last ran ${last}`);
      const have = installedVersion();
      const u = readState();
      if (!checkEnabled()) say(`note  antibody ${have}; the daily update check is off`);
      else if (u.latest && compareVersions(u.latest, have) > 0) say(`note  antibody ${u.latest} is out (you have ${have}); to update: ${UPDATE}`);
      else ok(`antibody ${have}${u.checkedAt ? `, latest as of ${u.checkedAt.slice(0, 10)}${u.error ? ` (last check failed: ${u.error})` : ''}` : ''}`);
      const todo = changes(seenVersion(), have).filter((c) => c.byHand);
      if (todo.length) say(`note  ${todo.map((c) => c.version).join(', ')} need(s) a step by hand you haven't confirmed: antibody whats-new`);
      const local = readManifest(PLUGIN_ROOT);
      const v = verifyFiles(PLUGIN_ROOT, local);
      if (!v) say(`note  no release file manifest (${MANIFEST}), so the plugin's files can't be checked; normal in a development copy`);
      else if (v.version !== have) say(`note  the file manifest is for ${v.version}, not ${have}; files not checked`);
      else if (v.changed.length || v.missing.length) {
        // Not a FAIL on its own: a copy installed from a commit after the release differs too.
        say(`note  ${v.changed.length + v.missing.length} plugin file(s) differ from the ${v.version} release: ${[...v.changed, ...v.missing.map((f) => `${f} (missing)`)].slice(0, 8).join(', ')}`);
        say(`      a later commit, or a local change; reinstall to be sure: claude plugin uninstall antibody@antibody, then claude plugin install antibody@antibody`);
      } else ok(`plugin files match the ${v.version} release manifest`);
      if (online && local) {
        try {
          const res = await fetch(`https://raw.githubusercontent.com/${REPO}/v${local.version}/${MANIFEST}`, { signal: AbortSignal.timeout(8000), headers: { 'user-agent': 'antibody-doctor' } });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          sameFiles(await res.json(), local) ? ok(`the manifest matches the one published at tag v${local.version}`) : bad(`the manifest differs from the one published at tag v${local.version}: this copy isn't that release`);
        } catch (e) { say(`note  couldn't fetch the v${local.version} manifest from GitHub: ${e.message}`); }
      }
      process.exit(problems.length ? 1 : 0);
    }

    case 'update-check': {
      const quiet = flag('--quiet');
      const have = installedVersion();
      const s = await refresh();
      if (quiet) return;
      if (s.error) fail(`Couldn't check for updates: ${s.error}`);
      if (compareVersions(s.latest, have) > 0) say(`antibody ${s.latest} is out (you have ${have}).\nTo update, run in a terminal: ${UPDATE}\nWhat changed: ${CHANGELOG}`);
      else say(`antibody ${have} is the latest.`);
      return;
    }

    case 'whats-new': {
      const have = installedVersion();
      if (flag('--seen')) {
        markSeen(have);
        say(`Marked antibody ${have}'s notes as read; the what's-new notice stops showing.`);
        return;
      }
      const since = flag('--all') ? '0.0.0' : seenVersion();
      const list = changes(since, have);
      if (!list.length) { say(`Nothing new since ${since}. antibody whats-new --all shows every release.`); return; }
      say(list.map((c) => c.text).join('\n\n'));
      if (list.some((c) => c.byHand) && compareVersions(have, seenVersion()) > 0) say(`\nOnce you've done the "By hand" steps above, run: antibody whats-new --seen`);
      return;
    }

    case 'bug': {
      const submit = opt('--submit');
      if (submit) {
        const title = opt('--title') || fail('Give the issue a title: --title "<title>"');
        if (!existsSync(submit)) fail(`No file ${submit}`);
        const gh = (...a) => spawnSync('gh', a, { encoding: 'utf8', shell: false });
        const manual = `Paste ${submit} into a new issue at https://github.com/${REPO}/issues/new instead.`;
        if (gh('--version').status !== 0) fail(`gh isn't installed. ${manual}`);
        if (gh('auth', 'status').status !== 0) fail(`gh isn't signed in (run: gh auth login). ${manual}`);
        const r = gh('issue', 'create', '--repo', REPO, '--title', title, '--body-file', submit);
        if (r.status !== 0) fail(`gh issue create failed: ${(r.stderr || r.stdout).trim()}\n${manual}`);
        say(`Filed: ${r.stdout.trim()}`);
        return;
      }
      say(bugDraft(opt('--event'), opt('--issue'), opt('--out')));
      return;
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
        // A hand-archived issue has no matcher, so a fix on it could never be watched for recurrence.
        if (sub === 'fix' && i.archivedAt) fail(`${i.id} was archived by hand (${i.cause === 'project' ? 'a project defect' : 'closed'}); write a new issue for Claude's part instead.`);
        if (sub === 'fix') Object.assign(i, { fix: text, fixedAt: new Date().toISOString() });
        else i.seen = [...(i.seen || []), `${new Date().toISOString().slice(0, 10)}, ${text}`];
        writeIssue(i);
        say(`${i.id} ${sub === 'fix' ? 'fix recorded; now watching for recurrence' : 'sighting added'}`);
        return;
      }
      if (sub === 'archive') {
        const project = flag('--project');
        const i = readIssue(args.shift()) || fail('No such issue');
        const why = args.join(' ').trim() || fail('Give the reason.');
        // Archived issues still match events, so the matcher has to go or the fix keeps coming back.
        if (Object.keys(i.when || {}).length) i.whenWas = i.when;
        i.when = {};
        Object.assign(i, { archivedAt: new Date().toISOString(), archivedWhy: why }, project ? { cause: 'project' } : {});
        const wasActive = !i.archived;
        i.archived = true;
        writeIssue(i);
        if (wasActive) rmSync(join(paths().issues, `${i.id}.md`), { force: true });
        // Local data rules and local guards both can name an issue; shipped packs never do.
        const { rules: local } = await loadRules({ packs: [] });
        const named = local.filter((r) => r.issue === i.id && r.state !== 'retired').map((r) => r.id);
        if (project) for (const id of named) saveRuleState(id, 'retired');
        say(`${i.id} archived${project ? ' as a project defect' : ''}; its matcher is cleared`);
        if (named.length) say(project ? `retired its rules: ${named.join(', ')}` : `rules still naming it: ${named.join(', ')} (retire them if they no longer apply)`);
        return;
      }
      fail('Usage: issue show|add|fix|seen|archive ...');
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
      // The desktop app's own scheduled task runs under the app's login. A task the OS starts runs the
      // `claude` CLI, which keeps a login of its own; when that has expired the run fails with
      // "OAuth session expired" in a window that closes before anyone reads it.
      say('With the Claude desktop app, the simplest is one of its scheduled tasks: prompt "/antibody:review", daily.');
      say('It runs under the app\'s own login. If you have a weekly one from an older setup, make it daily.\n');
      say('Or let the OS run it. That uses the claude CLI\'s own login, not the app\'s, so check that `claude -p "hi"` works');
      say('in a terminal first; for a login that lasts, run `claude setup-token` and set CLAUDE_CODE_OAUTH_TOKEN to it.');
      say('Run the review from the data folder, so its edits stay inside the working directory.');
      say('Never use --permission-mode bypassPermissions for it: the review must stay inside its allow list.\n');
      // PowerShell, not schtasks: \" inside a PowerShell string isn't an escape, so the old schtasks line
      // broke there. Single quotes take everything literally; a ' in the path doubles.
      const ps = (s) => `'${s.replace(/'/g, "''")}'`;
      if (process.platform === 'win32') say(`Windows (Task Scheduler, daily 09:00; paste into PowerShell):\n  Register-ScheduledTask -TaskName antibody-review -Trigger (New-ScheduledTaskTrigger -Daily -At 9am) -Settings (New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries) -Action (New-ScheduledTaskAction -Execute cmd.exe -Argument ${ps(`/c ${run}`)} -WorkingDirectory ${ps(home)})\n  Try it now: Start-ScheduledTask antibody-review; then Get-ScheduledTaskInfo antibody-review shows LastTaskResult (0 is success).`);
      else if (process.platform === 'darwin') say(`macOS: add a launchd agent, or cron:\n  crontab -e\n  0 9 * * * cd "${home}" && ${run} >> "${home}/reviews/cron.log" 2>&1`);
      else say(`Linux (cron, daily 09:00):\n  crontab -e\n  0 9 * * * cd "${home}" && ${run} >> "${home}/reviews/cron.log" 2>&1`);
      return;
    }

    default:
      fail(`Unknown command: ${cmd}\n\n${HELP}`);
  }
}

// ---------------------------------------------------------------------------------------------

// A bug report about antibody itself, for the person to read before anything leaves the machine.
// Logged events are already redacted; this runs redact again and takes out the home folder.
function scrub(v) {
  const homes = [homedir(), homedir().replace(/\\/g, '/'), homedir().replace(/\\/g, '\\\\')];
  let s = redact(typeof v === 'string' ? v : JSON.stringify(v, null, 2));
  for (const h of homes) s = s.split(h).join('~');
  return s;
}

function bugDraft(eventId, issueId, outFile) {
  const out = [];
  const p = (s = '') => out.push(s);
  p('## What happened');
  p('');
  p('<!-- In your own words: what antibody did, what you expected instead, and how to make it happen again. -->');
  p('');
  p('## Setup');
  p('');
  const doc = spawnSync(process.execPath, [join(PLUGIN_ROOT, 'bin', 'antibody.mjs'), 'doctor'], { encoding: 'utf8' });
  p(`- antibody ${installedVersion()}, Node ${process.versions.node}, ${process.platform} ${process.arch}`);
  p(`- packs: ${config().packs.join(', ')}`);
  p('');
  p('```');
  p(scrub(doc.stdout.trim()));
  p('```');
  if (eventId) {
    const e = readEvents().find((x) => x.id === eventId) || fail(`No event ${eventId}`);
    const { session_id, cwd, ...keep } = e;
    p('');
    p(`## Event ${e.id}`);
    p('');
    p('```json');
    p(scrub(keep));
    p('```');
  }
  if (issueId) {
    const i = readIssue(issueId) || fail(`No issue ${issueId}`);
    p('');
    p(`## Issue ${i.id}: ${scrub(i.title)}`);
    p('');
    p(scrub(readText(join(i.archived ? paths().archive : paths().issues, `${i.id}.md`))));
  }
  const text = out.join('\n') + '\n';
  if (!outFile) return text;
  writeFileSync(outFile, text);
  return `Draft written to ${outFile}. Read all of it before filing: it goes to a public GitHub issue.\n\n${text}`;
}

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

await main();
