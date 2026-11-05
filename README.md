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
| **Capture** 🔬 | Hooks log every failed tool call, interrupted call, killed background task and slow call to an event log. Sessions don't do any bookkeeping themselves. When a session commits, pushes, opens a PR or moves a card while its task list has sat unchanged for 15 minutes, it is reminded to update the list, so the progress you check isn't stuck on step one. |
| **Recall** 🧠 | When a call fails and the failure matches a known issue, antibody hands the fix straight back to the model in the same turn. That works in subagents too. |
| **Prevent** 🛡️ | Before a shell command runs, rules can **rewrite** it (a certain, mechanical fix), **deny** it (naming the right form), **ask** the person (refused outright when no one would see the question, as in auto mode), or **warn**. |
| **Learn** 📚 | A review command turns recent events, the "what worked next" pairs and session notes into issues and new rules. |
| **Tolerate** 🧘 | New rules start in **shadow** mode: they log what they would have done, and act only once real traffic shows they're right. Rules that misfire get demoted, because an immune system that attacks the host is called an autoimmune disease. |

## Install

1. **Add the marketplace and install the plugin.** From a terminal (PowerShell, cmd, bash), not inside a Claude session:

   ```
   claude plugin marketplace add MichaelLeeHobbs/antibody
   claude plugin install antibody@antibody
   ```

   Adding the marketplace only registers it; the second command is what installs the plugin. Check it with `claude plugin list`, which should show `antibody@antibody` as enabled. Start a new Claude session afterwards so the hooks load. The plugin is installed for your user, so other Claude Code front ends that share `~/.claude`, such as the Desktop app's Code tab, should pick it up too.

   Inside the terminal Claude Code UI you can use `/plugin marketplace add MichaelLeeHobbs/antibody` and `/plugin install antibody@antibody` instead. Both open the plugin screen, and nothing is installed until you confirm the install there. These slash commands may not work in the Claude Desktop app, so use the terminal commands above there.

   If adding the marketplace fails while cloning (for example, git tries SSH and can't find your keys), add it by its HTTPS URL instead: `claude plugin marketplace add https://github.com/MichaelLeeHobbs/antibody.git`. Adding a marketplace needs `git` on your PATH.

2. **Run the setup.** Run `/antibody:setup`. It does steps 3 to 5 for you. To do them by hand instead, read on.

3. **`antibody init`** creates the data folder (`~/.claude/antibody`, or `$ANTIBODY_HOME`) and picks packs for your OS. Claude Code puts the plugin's `bin/` on PATH for its Bash tool, and some versions do the same for PowerShell, so `antibody init` usually just works there. If the shell says `antibody` isn't found, or you're in your own terminal, use `node ~/.claude/plugins/cache/antibody/antibody/<version>/bin/antibody.mjs init`.

4. **Add the two settings `init` prints.** A Claude session never edits `settings.json` on its own, so this step is yours:
   - an `@~/.claude/antibody/learned.md` line for `~/.claude/CLAUDE.md`;
   - a `permissions` block for `~/.claude/settings.json`. Merge its entries into your existing `allow` and `deny` lists, or let antibody do it: in your own terminal, run the `permissions` command `init` prints (`node "<plugin folder>/bin/antibody.mjs" permissions`). It lists the missing entries; add `--apply` to back the file up and add them. It only adds entries, never removes or changes yours. If a Claude session runs `permissions --apply`, antibody asks you first, and in auto mode it refuses.

5. **Check the install** with `antibody doctor`.

6. **Schedule the review daily.** With the desktop app, a daily scheduled task with the prompt `/antibody:review` is simplest. Otherwise `antibody schedule` prints the command for your OS (it runs the `claude` CLI, which needs its own login). A daily run means a mistake Claude made today has a fix or a rule by tomorrow. If the review hasn't run for two days, antibody reminds you at session start.

### Updating

Releases are tagged on GitHub (`v0.3.0`) and listed in [CHANGELOG.md](CHANGELOG.md). Claude Code only sees an update when the version number changes, so every release bumps it.

Claude Code doesn't auto-update plugins from marketplaces outside Anthropic's own, and it doesn't light up the Update button for them either. So antibody checks for you: once a day, at session start, it looks up the latest version on GitHub, and if there's a newer one it tells you at the start of your next sessions (up to 3 a day), with the commands to run. The CLI shows it on screen; in the desktop app, which doesn't, Claude mentions it in one line at the end of its first reply. It never installs anything itself. `antibody update-check` checks right away, and `antibody doctor` shows the result. (Turn the check off in [Network](#network).)

To update, first refresh the marketplace. This only refreshes the list of plugins; it doesn't touch the installed copy:

```
claude plugin marketplace update antibody
```

Then update the plugin itself:

```
claude plugin update antibody@antibody
```

(or, in the terminal UI, `/plugin` → Installed → antibody → Update now), and run `/reload-plugins` or start a new session so the new hooks load. Your data folder, settings lines and `Bash(antibody *)` permission carry over unchanged (an older `Bash(node ".../<version>/bin/antibody.mjs" *)` entry stops matching after an update; `antibody permissions` points it out); anything a release needs you to do by hand is listed in the changelog. After an update, that "By hand" step shows at every session start until you run `antibody whats-new --seen` (or tell Claude you've read it, and approve when antibody asks), so it can't be used up by sessions you never look at. `antibody whats-new` prints the notes since the release you last confirmed.

**Want updates without asking?** You can let Claude Code install new releases by itself. That means new antibody code, which runs on every tool call, arrives without you reading it first, so it's your call. To do it, add `"autoUpdate": true` to the antibody entry under `extraKnownMarketplaces` in `~/.claude/settings.json` (create the entry if it isn't there), or use `/plugin` → Marketplaces → antibody → Enable auto-update in the terminal UI:

```json
"extraKnownMarketplaces": {
  "antibody": {
    "source": { "source": "github", "repo": "MichaelLeeHobbs/antibody" },
    "autoUpdate": true
  }
}
```

Claude Code then updates in the background once a session is under way; that session keeps the old version until `/reload-plugins` or a new session. `DISABLE_AUTOUPDATER=1` or `DISABLE_UPDATES=1` turn plugin auto-update off too, unless you also set `FORCE_AUTOUPDATE_PLUGINS=1`.

Requires Node 18 or later. CI runs the suite on Linux, macOS and Windows.

## Packs

| Pack | What it does |
|---|---|
| `core` (always on) | Protects antibody and your settings: a session can't edit `settings.json` (asks you; reading it is fine), the plugin's files, the event log or local guards, disable the plugin, or file a bug report without you. Refuses commands that would hang reading stdin (`grep pattern` with no file, `sort -u` with nothing piped in). |
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
- `export`, `schedule`;
- `update-check`;
- `bug`: draft a bug report about antibody, and file it with `gh` (see below).

## Reporting a problem with antibody

If antibody gets something wrong (a rule that misfires, a hook error, a confusing message), ask Claude to report it, or run `/antibody:bug`. Claude drafts the issue with `antibody bug`, which adds your antibody version, OS, packs and `doctor` output and takes out your home folder and anything that looks like a secret. Then it shows you the whole draft. Nothing is filed until you've read it and said yes. It's filed as a public issue on this repo with your own `gh` login, and antibody asks you once more before `gh` runs (in auto mode it refuses, and hands you the command instead). Without `gh`, you get the draft to paste at [github.com/MichaelLeeHobbs/antibody/issues/new](https://github.com/MichaelLeeHobbs/antibody/issues/new).

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

## Network

antibody makes one automatic network request, the daily update check. It's a plain GET of [`.claude-plugin/plugin.json`](https://raw.githubusercontent.com/MichaelLeeHobbs/antibody/main/.claude-plugin/plugin.json) from this repo, the same file `claude plugin update` reads. It sends nothing about you or your work beyond the request itself (GitHub sees your IP address, as with any download), and it runs in its own process so it never slows a session down. Turn it off with any of:

- `"updateCheck": false` in `config.json`;
- `ANTIBODY_NO_UPDATE_CHECK=1`;
- Claude Code's own `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`.

Two more requests happen only when you run them: `antibody update-check`, and `antibody doctor --online`, which fetches the release's file manifest from GitHub. Bug reports go out only when you ask for one and confirm it (see above).

## Releasing (maintainers)

On a clean branch cut from an up-to-date main, run `npm run release -- 0.4.0`. It bumps `package.json` and `plugin.json`, dates the changelog's `## Unreleased` heading, and writes `.claude-plugin/files.json`, the manifest `doctor` checks installs against. It changes files only, then prints the rest: commit, merge while the branch is up to date with main, and tag the merge commit `v0.4.0`. Bumping the version on main is the release, because Claude Code and the update check both read main's `plugin.json`.

## Known gaps (no vaccine is 100% effective)

- `warn` relies on PreToolUse `additionalContext` reaching the model without a permission decision. The hook docs don't confirm this, so check it in your version.
- Background-task ids are read from the Bash tool's response text, and the stop tool names checked are `TaskStop`, `KillShell` and `KillBash`. If your version words these differently, a stall is still logged, but without the command that hung.
- Whether a person will see an `ask` is read from the hook input's `permission_mode`. A Claude Code version that doesn't send it gets the plain `ask`, which in auto mode is settled without a person.
- `doctor` checks the plugin's files against the release manifest that ships next to them, which catches a partial or local change but not someone who rewrites both. `doctor --online` closes that by comparing the manifest with the one published at the release tag on GitHub. A copy installed from a commit made after the release (Claude Code installs from main, not from the tag) shows its changed files as a note, not a failure.
- The session-start messages (update and review reminders) go out as the hook's `systemMessage`, which the CLI shows and the desktop app doesn't, and as context Claude passes on. In the desktop app you hear about them only through Claude's first reply.

## License

MIT
