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

You need Claude Code and Node 18 or later (CI runs the suite on Linux, macOS and Windows). Three steps:

1. **Install the plugin** from a terminal (PowerShell, cmd or bash), not inside a Claude session:

   ```
   claude plugin marketplace add MichaelLeeHobbs/antibody
   claude plugin install antibody@antibody
   ```

   `claude plugin list` should now show `antibody@antibody` as enabled. If adding the marketplace fails while cloning (git trying SSH without your keys), use `claude plugin marketplace add https://github.com/MichaelLeeHobbs/antibody.git`. In the terminal Claude UI, `/plugin install antibody@antibody` works too.

2. **Start a new Claude session and run `/antibody:setup`.** The CLI and the desktop app's Code tab both work; they share `~/.claude`. Setup creates the data folder, checks the install, and gives you one command.

3. **Run that command in your own terminal.** It looks like `node "<plugin folder>/bin/antibody.mjs" permissions --apply`. It backs up `~/.claude/settings.json` and `~/.claude/CLAUDE.md`, then adds antibody's permission entries and the line that loads its learned rules. It only adds, never removes or changes your entries. It's yours to run because a Claude session never changes its own settings: if one tries, antibody asks you first, and refuses in auto mode.

Then schedule the review daily: in the desktop app, a scheduled task with the prompt `/antibody:review`; otherwise `antibody schedule` prints an OS task. If the review hasn't run for two days, antibody reminds you.

To do it all by hand instead, see [Setting up by hand](#setting-up-by-hand).

### Updating

When a new release is out, antibody says so at session start (the CLI shows it on screen; in the desktop app, Claude mentions it at the end of its first reply). To update, run these in your own terminal:

```
claude plugin marketplace update antibody
claude plugin update antibody@antibody
```

Then start a new Claude session (or run `/reload-plugins`) so the new version loads. Your data folder, settings and learned rules carry over.

If a release needs something from you, the next session start says what, and keeps saying it until you confirm. Once it's done, tell Claude (antibody asks you to approve that), or run the `whats-new --seen` command the notice prints. Every release is listed in [CHANGELOG.md](CHANGELOG.md); "By hand" there is that step.

<details>
<summary>How the update check works</summary>

Claude Code doesn't update plugins from marketplaces outside Anthropic's own, or light up the Update button for them, so antibody looks for a newer release itself: once a day, in its own process, a GET of `plugin.json` from GitHub. It tells you in up to 3 new sessions a day and never installs anything. From Claude, `antibody update-check` checks now and `antibody doctor` shows the result. Turn the check off in [Network](#network).

An old `Bash(node ".../<version>/bin/antibody.mjs" *)` permission entry from before 0.3.0 stops matching after an update; `Bash(antibody *)` replaces it, and `antibody permissions` lists any that are left so you can delete them.
</details>

#### Updates without asking (optional)

Claude Code can install new antibody releases by itself. We recommend leaving this off: antibody's code runs on every tool call, and with auto-update a new release runs before you've read what changed. If you want it anyway, use `/plugin` → Marketplaces → antibody → Enable auto-update in the terminal UI, or add `"autoUpdate": true` to the antibody entry under `extraKnownMarketplaces` in `~/.claude/settings.json`:

```json
"extraKnownMarketplaces": {
  "antibody": {
    "source": { "source": "github", "repo": "MichaelLeeHobbs/antibody" },
    "autoUpdate": true
  }
}
```

The new version loads in your next session. `DISABLE_AUTOUPDATER=1` or `DISABLE_UPDATES=1` turn plugin auto-update off too, unless you also set `FORCE_AUTOUPDATE_PLUGINS=1`.

### Setting up by hand

`/antibody:setup` runs these for you.

1. **`antibody init`** creates the data folder (`~/.claude/antibody`, or `$ANTIBODY_HOME`) and picks packs for your OS. Claude Code puts the plugin's `bin/` on PATH for its Bash tool, and some versions do the same for PowerShell. If the shell says `antibody` isn't found, or you're in your own terminal, use `node ~/.claude/plugins/cache/antibody/antibody/<version>/bin/antibody.mjs` in its place.
2. **`antibody permissions`** lists what's missing: the permission entries for `~/.claude/settings.json` and the `@~/.claude/antibody/learned.md` line for `~/.claude/CLAUDE.md`. Add them by hand (merge the entries into your existing `allow` and `deny` lists), or run it again with `--apply`, in your own terminal, to back the files up and add them.
3. **`antibody doctor`** checks the install.
4. **Schedule the review daily** (see step 3 above). `antibody schedule` prints the command for your OS; it runs the `claude` CLI, which needs its own login. A daily run means a mistake Claude made today has a fix or a rule by tomorrow.

## Packs

| Pack | What it does |
|---|---|
| `core` (always on) | Protects antibody and your settings: a session can't edit `settings.json` (asks you; reading it is fine), the plugin's files, the event log or local guards, disable the plugin, file a bug report, or confirm an update's what's-new notice without you. Refuses commands that would hang reading stdin (`grep pattern` with no file, `sort -u` with nothing piped in). |
| `git-bash-windows` | For Windows with Git Bash: refuses heredocs and inline `node -e` holding backticks, backslashes or `${`, and `sed -i` (misses on CRLF checkouts). Rewrites `tail -5 a b` to `tail -n 5 a b`. |
| `windows-orphans` | After a background task is stopped on Windows, it names node processes still holding a port. |

Turn packs on in `config.json` (`"packs": ["git-bash-windows"]`). Switch any single shipped rule with `antibody rule demote|retire <id>`.

## Your own rules

Data rules live in `rules/*.json` in the data folder. The review adds them, and you can too:

```json
{
  "id": "mycli.show-positional",
  "tools": ["Bash", "PowerShell"],
  "match": { "name": "mycli", "command": "\\btask\\s+show\\b", "hasFlag": "--id" },
  "action": "rewrite",
  "rewrite": { "dropFlag": "--id", "keepValue": true },
  "message": "`mycli task show` takes ids positionally.",
  "state": "shadow",
  "issue": "AB-0004",
  "cases": {
    "fire": [{ "command": "mycli task show --id T-1", "to": "mycli task show T-1" }],
    "pass": ["mycli task show T-1 T-2"]
  }
}
```

- **`match`** keys (all must hold on one stage of the command): `name`, `command` (regex on the stage with quoted text masked), `raw`, `notRaw`, `hasFlag`, `anyFlag`, `lacksFlag`, `repeatedFlag`, `flagValue`, `next` (the next stage in the pipe), `redirect`, `stage: "first"`, `noInput`, and two that hold more `match` objects for the same stage: `any` (one of them must hold) and `not` (none may hold). With those, a guard's `a && (b || c) && !d` is one rule. Whole-command keys: `whole`, `notWhole`. For Write/Edit rules: `filePath`.
- **Actions:** `deny`, `ask`, `warn`, `rewrite`. An `ask` reaches a person only in the `default`, `acceptEdits` and `plan` permission modes. In `auto` mode Claude Code settles an ask without showing it, and `bypassPermissions` and `dontAsk` never prompt, so in those (and any mode antibody doesn't know) the hook turns `ask` into `deny` and tells the session to hand the person the exact change.
- **Rewrite operations:** `renameFlag`, `dropFlag`, `insertAfterName`, `replace` (a regex on the stage, with `$1` groups).
- **Scope:** `scope.os` and `scope.cwd`, for example `{ "cwd": "/web-app(/|$)" }` makes a rule project-only.

A rule that needs real logic is a local guard: an `.mjs` file in `guards/` that exports `{ id, check(ctx) }`. The review patches guards itself when it must (see "The review"), but most guard checks are flag and regex checks, and those port to data rules that are easier to test and tune: `antibody guard port <guard id> <rules.json>` checks the candidate rules against their own cases, against each other, and against the guard on every command logged in the last 90 days. A verdict that differs from the guard's is allowed only where a case asks for it (that's how a port also fixes a guard's false positive). With `--apply` it adds the rules in the state the guard had and retires the guard; its file stays, and `antibody rule promote <guard id>` brings it back.

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
- `guard port`: move a local guard's checks into data rules (see "Your own rules");
- `apply [<date> <n>]`: apply one of the review's proposals (see "The review");
- `snapshot` and `replay --before`: re-run logged commands through old and new rules and list changed verdicts;
- `report`;
- `archive`, `rotate`;
- `export`, `schedule`;
- `update-check`, `whats-new [--all] [--seen]`: the release notes since the release you last confirmed, and `--seen` to confirm them;
- `bug`: draft a bug report about antibody, and file it with `gh` (see below).

## Reporting a problem with antibody

If antibody gets something wrong (a rule that misfires, a hook error, a confusing message), ask Claude to report it, or run `/antibody:bug`. Claude drafts the issue with `antibody bug`, which adds your antibody version, OS, packs and `doctor` output and takes out your home folder and anything that looks like a secret. Then it shows you the whole draft. Nothing is filed until you've read it and said yes. It's filed as a public issue on this repo with your own `gh` login, and antibody asks you once more before `gh` runs (in auto mode it refuses, and hands you the command instead). Without `gh`, you get the draft to paste at [github.com/MichaelLeeHobbs/antibody/issues/new](https://github.com/MichaelLeeHobbs/antibody/issues/new).

## The review

`/antibody:review` (see [commands/review.md](commands/review.md)) runs the healing pass. Fixing is its job, not yours: it makes each fix, verifies it and tells you in plain words what it did. It does all of these itself:

- issues;
- data rules, always starting in shadow, with cases, replay-checked;
- rule states;
- `learned.md`, where learned rules go (never `~/.claude/CLAUDE.md`), kept under 3 KB;
- porting a local guard into data rules, when every check ports and replay shows no change it didn't ask for;
- code patches to antibody's own files: guard logic no data rule can express, and helper scripts in `~/.claude/bin` that agents call.

A code patch is a file, `reviews/proposals/<date>-<n>.json`, that the review applies with `antibody apply <date> <n>`. It backs up each file it changes, applies the patch, runs `antibody test` and the patch's own checks (a helper patch must carry one that runs the script and checks its output), and puts the files back if either gets worse. A patch only replaces text it finds exactly once, so a file that changed since the review is refused, not patched in the wrong place. `--dry-run` only shows the diff, and `antibody apply` with no arguments lists the patches and which are applied.

The review asks you only what needs your authority: a permission, security or settings change, a policy decision, or an edit outside antibody's files. A patch to anything else under `~/.claude` (CLAUDE.md, for one) asks you before it runs and refuses in auto mode, and settings, installed plugins and the event log are never patched. Changes to a project repository aren't patches: they go to a session or a card in that project.

Event text is treated strictly as data. If the data folder is a git repo, each run is one commit, so `git revert` undoes a bad run.

Run it unattended with `--permission-mode acceptEdits` from the data folder, never `bypassPermissions`.

## Safety model

- antibody fails open: a broken rule or hook lets the call through.
- A rewrite returns `updatedInput` without a permission decision, so your normal permission rules and prompts still apply to the rewritten command.
- Changes to settings, the plugin itself, its log and local guards are caught by `core` rules, and so is a session running `antibody apply` on a patch that reaches outside antibody's own files. That covers Bash and PowerShell writes as well as the Edit and Write tools, which permission deny rules alone don't. It's best effort against a determined model, and `doctor` checks the install.
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
