---
description: Report a problem with antibody itself as a GitHub issue. Drafts it, shows you every word, and files it with gh only when you say so.
---

The person wants to report a problem with antibody itself (a rule that misfired, a hook error, a confusing message), not a failure in their own work. Only do this when they asked for it.

`antibody` is on PATH in your shell tools. If the shell says it isn't found, use `node "${CLAUDE_PLUGIN_ROOT}/bin/antibody.mjs"` instead.

1. Work out what they're reporting. If it's about a specific event or issue, find its id (`antibody report`, `antibody issues`, or the id in antibody's message).
2. Draft the report into your scratchpad (or a temp folder): `antibody bug --out <file>`, adding `--event <id>` and/or `--issue <id>` when they apply. It fills in the version, OS, packs and `doctor` output, and takes out the home folder and anything that looks like a secret.
3. Fill in "What happened" from the person's own words with the Edit tool: what antibody did, what they expected, how to make it happen again. Don't add file contents, project names or paths beyond what the report needs.
4. Show the person the whole draft and a proposed title. Say plainly that it becomes a public issue on github.com/MichaelLeeHobbs/antibody. Ask them to check it for anything private and to confirm. Change it as they ask.
5. Only after they confirm: `antibody bug --submit <file> --title "<title>"`. antibody asks them once more before it runs; in auto mode it refuses, and then you give them that command to run themselves. If `gh` is missing or not signed in, the command says so: give them the file path and https://github.com/MichaelLeeHobbs/antibody/issues/new to paste it themselves.
6. Reply with the issue link it prints.
