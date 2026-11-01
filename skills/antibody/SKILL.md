---
name: antibody
description: How to work with antibody's hook messages. Use when a tool call fails, is blocked or rewritten by antibody, when you stop a stuck task, or when asked about known failures, issues or rules.
---

# Working with antibody

antibody watches tool calls. It logs failures, stalls and blocks by itself. Before a shell command runs, it may block it, ask the person about it, or quietly rewrite it. After a failure, it hands back the known fix if there is one. You don't need to keep any log yourself.

## When antibody speaks

- **A call was blocked.** The message names the right form, so use it. Don't reshape the command to slip past the check. If the rule is wrong for this case, say so in one line with the note command from the message, then do the task another way.
- **A call was rewritten.** The context says what changed (for example `tail -5 a b` became `tail -n 5 a b`). The rewritten command is what ran.
- **A failure came back with "Known issue AB-…".** Try that fix first. If it doesn't work, note what did.
- **You stopped a task and antibody logged a possible stall.** If the task hung or misbehaved, note why it hung. If you stopped it on purpose, note "intended".

## Notes are the one thing to do

When you work out what actually fixed a failure, or why something hung, record it in one line with the note command antibody printed (it includes the event id):

```
node "<plugin>/bin/antibody.mjs" note <event id> "grep had no file operand and waited on stdin; name the file"
```

Write the fix, not the story. If the note text has backticks or quotes, keep them out of the shell: write the text to a file with the Write tool, then pass `"$(cat <file>)"`. The review turns notes into issues and rules. Don't edit antibody's files, its event log or the settings to "fix" a rule. Those changes belong to the review and to the person.

## Looking things up

- `antibody search <words>` finds known issues and their fixes.
- `antibody issues` lists every issue with its computed status (open, watching, fixed, recurring).
- `antibody rules` lists every rule, its state (enforce, shadow, retired) and its recent hits.

The full command list is `node "<plugin>/bin/antibody.mjs" help`.
