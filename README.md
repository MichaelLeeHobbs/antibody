# antibody 🦠💉

> **You:** It's been eleven minutes. What's going on?
>
> **Claude:** Oh, my bad! My `grep` didn't have a file, so it was waiting on stdin. I would have sat here until the heat death of the universe. 🙂
>
> **You:** 😐

Makes you want to #@!$ scream, doesn't it?

And it's never just the once. It's the `--id` flag that was never a flag, for the fourth time this week. It's the heredoc that ate a backtick and turned your file into modern art. It's `tail -5 a.log b.log`, said with total confidence. It's the same retry, three times in a row, each one hopeful that this time the laws of physics will be different.

**Friends, there is a cure. It's called antibody.** *(Side effects may include fewer apologies, shorter sessions, and an unfamiliar feeling of calm. Ask your doctor if antibody is right for you. Your doctor is `antibody doctor`.)*

antibody is a Claude Code plugin that gives Claude an immune system for its own tool mistakes. It catches a failure the first time, remembers the cure, and hands it back the next time, often before the bad command even runs. The `grep` that would have waited forever gets refused in milliseconds, along with a polite note about which file it forgot.

## How the immune system works

| | |
|---|---|
| **Capture** 🔬 | Hooks log every failed tool call, interrupted call, killed background task and slow call to an event log. Sessions don't do any bookkeeping themselves. |
| **Recall** 🧠 | When a call fails and the failure matches a known issue, antibody hands the fix straight back to the model in the same turn. That works in subagents too. |
| **Prevent** 🛡️ | Before a shell command runs, rules can **rewrite** it (a certain, mechanical fix), **deny** it (naming the right form), **ask** the person (refused outright when no one would see the question, as in auto mode), or **warn**. |
| **Learn** 📚 | A review command turns recent events, the "what worked next" pairs and session notes into issues and new rules. |
| **Tolerate** 🧘 | New rules start in **shadow** mode: they log what they would have done, and act only once real traffic shows they're right. Rules that misfire get demoted, because an immune system that attacks the host is called an autoimmune disease. |

## Install

1. **Add the marketplace and install the plugin.** In Claude Code:

   ```
   /plugin marketplace add MichaelLeeHobbs/antibody
   /plugin install antibody@antibody
   ```

   `/plugin install` opens the plugin screen. Confirm the install there; it prints nothing else. From a terminal, `claude plugin install antibody@antibody` does the same without the screen.

2. **Run the setup.** Run `/antibody:setup`. It does steps 3 to 5 for you. To do them by hand instead, read on.

3. **`antibody init`** creates the data folder (`~/.claude/antibody`, or `$ANTIBODY_HOME`) and picks packs for your OS. Claude Code puts the plugin's `bin/` on PATH for its Bash tool, and some versions do the same for PowerShell, so `antibody init` usually just works there. If the shell says `antibody` isn't found, or you're in your own terminal, use `node ~/.claude/plugins/cache/antibody/antibody/<version>/bin/antibody.mjs init`.

4. **Add the two settings `init` prints.** antibody never edits `settings.json` itself, so this step is yours:
   - an `@~/.claude/antibody/learned.md` line for `~/.claude/CLAUDE.md`;
   - a `permissions` block for `~/.claude/settings.json`. Merge its entries into your existing `allow` and `deny` lists.

5. **Check the install** with `antibody doctor`.

`antibody schedule` shows how to run the review daily or weekly on your OS.

### Updating

Releases are tagged on GitHub (`v0.2.0`) and listed in [CHANGELOG.md](CHANGELOG.md). Claude Code only sees an update when the version number changes, so every release bumps it. To update:

```
/plugin marketplace update antibody
```

then update antibody from the `/plugin` screen (or `claude plugin update antibody@antibody` from a terminal), and restart Claude Code so the new hooks load. Your data folder, settings lines and `Bash(antibody *)` permission carry over unchanged; anything a release needs you to do by hand is listed in the changelog.

Requires Node 18 or later. CI runs the suite on Linux, macOS and Windows.

## Packs

| Pack | What it does |
|---|---|
| `core` (always on) | Protects antibody and your settings: a session can't edit `settings.json` (asks you), the plugin's files, the event log or local guards, or disable the plugin without you. Refuses commands that would hang reading stdin (`grep pattern` with no file, `sort -u` with nothing piped in). |
| `git-bash-windows` | For Windows with Git Bash: refuses heredocs and inline `node -e` holding backticks, backslashes or `${`, and `sed -i` (misses on CRLF checkouts). Rewrites `tail -5 a b` to `tail -n 5 a b`. |
| `windows-orphans` | After a background task is stopped on Windows, it names node processes still holding a port. |

Turn packs on in `config.json` (`"packs": ["git-bash-windows"]`). Switch any single shipped rule with `antibody rule demote|retire <id>`.

## Your own rules

Data rules live in `rules/*.json` in the data folder. The review adds them, and you can too:

```json
{
  "id": "twg.get-positional",
  "tools": ["Bash", "PowerShell"],
  "match": { "name": "twg", "command": "\\bworkitem\\s+get\\b", "hasFlag": "--id" },
  "action": "rewrite",
  "rewrite": { "dropFlag": "--id", "keepValue": true },
  "message": "`twg jira workitem get` takes keys positionally.",
  "state": "shadow",
  "issue": "AB-0004",
  "cases": {
    "fire": [{ "command": "twg jira workitem get --id MED-1", "to": "twg jira workitem get MED-1" }],
    "pass": ["twg jira workitem get MED-1 MED-2"]
  }
}
```

- **`match`** keys (all must hold on one stage of the command): `name`, `command` (regex on the stage with quoted text masked), `raw`, `notRaw`, `hasFlag`, `anyFlag`, `lacksFlag`, `repeatedFlag`, `flagValue`, `next` (the next stage in the pipe), `redirect`, `stage: "first"`, `noInput`. Whole-command keys: `whole`, `notWhole`. For Write/Edit rules: `filePath`.
- **Actions:** `deny`, `ask`, `warn`, `rewrite`. An `ask` reaches a person only in the `default`, `acceptEdits` and `plan` permission modes. In `auto` mode Claude Code settles an ask without showing it, and `bypassPermissions` and `dontAsk` never prompt, so in those (and any mode antibody doesn't know) the hook turns `ask` into `deny` and tells the session to hand the person the exact change.
- **Rewrite operations:** `renameFlag`, `dropFlag`, `insertAfterName`, `replace` (a regex on the stage, with `$1` groups).
- **Scope:** `scope.os` and `scope.cwd`, for example `{ "cwd": "/web-app(/|$)" }` makes a rule project-only.

A rule that needs real logic is a local guard: an `.mjs` file in `guards/` that exports `{ id, check(ctx) }`. Guards are code, so the review only proposes them and a person adds them.

## Issues

There's one file per root cause, `issues/AB-0001.md`: JSON front matter, then a short Markdown body.

```
---
{
  "id": "AB-0001",
  "title": "grep with no file operand waits on stdin",
  "when": { "kind": ["stall", "interrupt", "timeout"], "command": "^(cd [^;&]+&& )?grep\\b" },
  "fix": "Name the file to search, or use -r for a directory.",
  "rules": ["core.stdin-hang"],
  "fixedAt": "2026-11-01T23:00:00.000Z"
}
---

## What failed
...
```

`when` is what makes the fix come back at the moment of failure. Status is computed, never typed:

- **open**: no fix recorded yet;
- **watching**: fixed less than `quietDays` ago;
- **fixed**: quiet since then;
- **recurring**: seen again after the fix, so it needs strengthening;
- **closed** or **project**: archived by hand with `issue archive`. `project` means it was a defect in your project, not something Claude did wrong.

antibody only fixes Claude's own failures. When something is really a bug in your code, dependencies or CI, the review says so ("This is not an AI failure…"), keeps any part that was Claude's mistake, and archives the rest with `antibody issue archive <id> --project <why>`. That clears the issue's matcher (archived issues still match events otherwise) and retires the rules that name it.

## Command line

`antibody help` lists everything. Where the plugin's `bin/` is on PATH, `bin/antibody` serves sh and Git Bash and `bin/antibody.cmd` serves PowerShell and cmd. Claude Code always adds it for the Bash tool; whether it does for PowerShell depends on the version. Anywhere `antibody` isn't found, run `node <plugin>/bin/antibody.mjs`.

- `note`: what a session found;
- `issues`, `issue show|add|fix|seen|archive`, `search`;
- `rules`, `rule add|promote|demote|retire`, `test`;
- `snapshot` and `replay --before`: re-run logged commands through old and new rules and list changed verdicts;
- `report`;
- `archive`, `rotate`;
- `export`, `schedule`.

## The review

`/antibody:review` (see [commands/review.md](commands/review.md)) runs the healing pass. It can do these itself (tier 1):

- issues;
- data rules, always starting in shadow, with cases, replay-checked;
- rule states;
- `learned.md`.

Anything executable is tier 2 and only proposed: helper scripts, local guards, repo changes. Event text is treated strictly as data. If the data folder is a git repo, each run is one commit, so `git revert` undoes a bad run.

Run it unattended with `--permission-mode acceptEdits` from the data folder, never `bypassPermissions`.

## Safety model

- antibody fails open: a broken rule or hook lets the call through.
- A rewrite returns `updatedInput` without a permission decision, so your normal permission rules and prompts still apply to the rewritten command.
- Changes to settings, the plugin itself, its log and local guards are caught by `core` rules. That covers Bash and PowerShell writes as well as the Edit and Write tools, which permission deny rules alone don't. It's best effort against a determined model, and `doctor` checks the install.
- Secrets matching common token patterns (and your own `redact` patterns in `config.json`) are removed before anything is logged. The event log stays local; keep it out of git (`init` writes a `.gitignore`).

## Known gaps (no vaccine is 100% effective)

- `warn` relies on PreToolUse `additionalContext` reaching the model without a permission decision. The hook docs don't confirm this, so check it in your version.
- Background-task ids are read from the Bash tool's response text, and the stop tool names checked are `TaskStop`, `KillShell` and `KillBash`. If your version words these differently, a stall is still logged, but without the command that hung.
- Whether a person will see an `ask` is read from the hook input's `permission_mode`. A Claude Code version that doesn't send it gets the plain `ask`, which in auto mode is settled without a person.
- `doctor` doesn't yet verify the plugin's files against release hashes.

## License

MIT
