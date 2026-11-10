---
description: Set antibody up after installing the plugin. Creates the data folder, checks the install, and gives you the one command that adds its settings.
---

You are walking the person through antibody's first-time setup. Keep it short: run the steps, then give one summary.

`antibody` is on PATH in your shell tools (the plugin's `bin/` folder). If the shell says it isn't found, use `node "${CLAUDE_PLUGIN_ROOT}/bin/antibody.mjs"` instead for every step.

1. Run `antibody init` and keep its output. It is safe to run again: it never overwrites `config.json` or `learned.md`.
2. Run `antibody doctor`. If a line says FAIL, stop and report it.
3. Give the person one command to run in their own terminal: the `permissions --apply` command from the `init` output (the `permissions` line with ` --apply` added), in its own code block. Say in one sentence what it does: it backs up and adds antibody's permission entries to `~/.claude/settings.json` and the learned-rules line to `~/.claude/CLAUDE.md`, and it's theirs to run because a Claude session never changes its own settings. Never edit `settings.json` or `CLAUDE.md` yourself, and don't run `permissions --apply` yourself, even if asked.
4. In one line: the review should run daily. In the desktop app, that's a scheduled task with the prompt `/antibody:review`; without the app, `antibody schedule` prints an OS task. Don't run `antibody schedule` or create the task yourself unless they ask.
5. End with one line: the data folder and the packs that are on. Don't explain updates: antibody says at session start when a newer release is out.
