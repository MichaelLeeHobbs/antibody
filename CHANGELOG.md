# Changelog

Claude Code notices an update only when the version changes, so every release bumps `version` in both `package.json` and `.claude-plugin/plugin.json`. "By hand" lists anything you need to do after updating; when it is empty, update and restart Claude Code.

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
