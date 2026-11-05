---
description: Set antibody up after installing the plugin. Creates the data folder, checks the install, and shows the settings to add.
---

You are walking the person through antibody's first-time setup. Keep it short: run the steps, then give one summary.

`antibody` is on PATH in your shell tools (the plugin's `bin/` folder). If the shell says it isn't found, use `node "${CLAUDE_PLUGIN_ROOT}/bin/antibody.mjs"` instead for every step.

1. Run `antibody init` and keep its output. It is safe to run again: it never overwrites `config.json` or `learned.md`.
2. Run `antibody doctor`. If a line says FAIL, stop and report it.
3. Show the two settings from the `init` output exactly as printed, each in its own code block:
   - the `@~/.claude/antibody/learned.md` line for `~/.claude/CLAUDE.md`. Offer to add it yourself, and add it only on a yes.
   - the `permissions` block for `~/.claude/settings.json`. Never edit `settings.json` yourself, and don't run `permissions --apply` yourself, even if asked: antibody keeps that a human step. Run `antibody permissions` (read-only) to show which entries are missing, then give the person the `permissions --apply` command from the `init` output to run in their own terminal. It backs the file up and adds only the missing entries. Merging by hand into the existing `allow` and `deny` lists works too.
4. Tell the person, in one or two lines, how updates work: Claude Code won't update antibody by itself, so antibody checks GitHub once a day and says at session start when a newer release is out, with the commands to run. They can turn that check off with `"updateCheck": false` in `config.json`. Letting Claude Code install updates by itself is optional, and the README's Updating section shows how. Don't recommend it either way.
5. Run `antibody schedule` and show what it prints: the review is meant to run daily, so a mistake made today has a fix by tomorrow. In the desktop app, lead with its scheduled task (prompt `/antibody:review`, daily), which uses the app's login; an OS task runs the `claude` CLI, which needs its own valid login. Don't create the scheduled task yourself; it's theirs to add. Mention that antibody reminds them at session start if the review hasn't run for two days.
6. End with one short summary: the data folder, the packs that are on, and the event log path (`events.jsonl` in the data folder).
