# Changelog

Claude Code notices an update only when the version changes, so every release bumps `version` in both `package.json` and `.claude-plugin/plugin.json` (`npm run release -- <x.y.z>` does it). "By hand" lists anything you need to do after updating; when it is empty, update and restart Claude Code.

## Unreleased

- **The update notice and review reminder now show in the desktop app.** The desktop app doesn't display a hook's `systemMessage`, so in 0.4.0 they reached only the CLI. The text now also goes to Claude, which mentions it in one line at the end of its first reply. Claude still doesn't run the update or the review unless you ask.
- **Each notice shows in up to 3 new sessions a day instead of 1.** A session started by another session or a script could use up the single daily showing where nobody saw it. A new release starts the count again.

By hand: nothing.

## 0.4.0 (2026-11-03)

- **antibody tells you when a new release is out.** Claude Code doesn't update plugins from marketplaces outside Anthropic's own, or even light up the Update button for them. So once a day a new `SessionStart` hook looks up the latest version on GitHub (one GET of `plugin.json`, in its own process), and the next session start names the new version and the two commands to run. It never installs anything. `antibody update-check` checks right away and `doctor` shows the result. Off with `"updateCheck": false` in `config.json`, `ANTIBODY_NO_UPDATE_CHECK=1` or `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`. The README has a new Network section.
- **`antibody bug` and `/antibody:bug` report a problem with antibody itself.** Only when you ask: Claude drafts the issue with your version, OS, packs and `doctor` output, with your home folder and secrets taken out, and shows you all of it. `antibody bug --submit <file> --title <t>` files it on GitHub with your `gh` login. A new core rule, `core.confirm-bug-report`, asks you before that runs (and before any `gh issue create` aimed at this repo), and refuses in auto mode.
- **The review runs daily.** `/antibody:review` is written for a daily run: it still reads a rolling week (so shadow rules can collect hits for promotion), stops after one line when nothing new happened, compares with the previous review, and gives an unanswered question 3 days before applying its default. Setup shows the `antibody schedule` command. When the review hasn't run for two days, session start reminds you (once a day; `"reviewReminder": false` turns it off), and `doctor` shows when it last ran.
- **`doctor` checks the plugin's files.** Releases ship `.claude-plugin/files.json`, a SHA-256 for every file (line endings folded, so Windows checkouts match). `doctor` notes any file that differs or is missing, and `doctor --online` also checks the manifest against the copy published at the release tag. `doctor` now shows the version, the last update check and the last review too.
- **`npm run release -- <x.y.z>`** prepares a release: bumps both version files, dates the changelog and writes the manifest. Committing, merging and tagging stay manual.
- **Auto-update is now an informed choice, not a setup step.** The README explains how to turn it on and what it means (new code that runs on every tool call, installed without review). `/antibody:setup` no longer pushes it.

By hand: nothing. To get updates without asking, see "Want updates without asking?" in the README.

## 0.3.0 (2026-11-02)

- **`antibody permissions [--apply]`** merges antibody's permission entries into `~/.claude/settings.json` for you. Without `--apply` it lists what's missing; with it, it backs the file up and adds only the missing entries. Run it in your own terminal: from a Claude session it asks you first, and in auto mode it is refused. `--file <path>` picks another settings file.
- **`init` no longer prints the version-pinned `Bash(node ".../<version>/bin/antibody.mjs" *)` entry.** It stopped matching on every update; `Bash(antibody *)` covers it. `permissions` lists any old ones it finds.
- **Reading `settings.json` from an inline script is no longer blocked.** `node -e` or `python -c` that only reads the file passes; one that writes still asks.
- README: install from a terminal with `claude plugin ...`; the `/plugin` slash commands may not install anything in the Desktop app.

By hand: optional. If your `settings.json` has a `Bash(node ".../antibody.mjs" *)` entry from an older `init`, you can delete it.

## 0.2.0 (2026-11-02)

- **The review only fixes Claude's own failures.** A defect in your project (code, dependencies, CI, infrastructure) is reported once as "This is not an AI failure. It is a <project> issue…" under a new "Not Claude's" section, and archived. The review no longer investigates root causes, writes repo-fix briefs or files cards for it. Issues that hold both get split: Claude's part stays. Steps 4, 8, 10 and 11 apply the test, and "Repo fixes" is now only for Claude failures whose fix lives in a repo.
- **`antibody issue archive <id> [--project] <why>`** closes an issue by hand. It clears the issue's matcher, because archived issues still match events and would keep handing back their fix. `--project` marks it `"cause": "project"` and retires the local rules that name it. `issues --all` shows these as `closed` or `project`.
- **An `ask` is refused where no person would see it** (auto mode, `bypassPermissions`, `dontAsk`), so core's settings and guard protections can't be settled silently.
- **Removed `migrate`.** The failure-ledger setup it imported had no other users.

By hand: nothing. The next review checks imported issues once and archives any that were project defects.

## 0.1.1

- `antibody` command on PATH (`bin/antibody`, `bin/antibody.cmd`), `/antibody:setup`, and a `Bash(antibody *)` permission that survives updates.

## 0.1.0

- First release: capture, recall, rules with shadow mode, and the review.
