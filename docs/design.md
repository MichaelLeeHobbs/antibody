# Design notes

## Why the loop looks like this

antibody grew out of a hand-built "failure ledger": every session searched and appended to a Markdown ledger, PreToolUse guards refused known-bad command shapes, and a weekly unattended review tidied the ledger and wrote new guards. It worked. Guards in particular reached subagents and already-running sessions in a way written instructions never did. Three costs pushed the redesign:

1. **Sessions did bookkeeping.** Stopping mid-task to search and write the ledger cost attention and tokens. Writing entries through the shell was itself a common failure.
2. **Healing meant writing code unattended.** The review edited guard code and helper scripts. That is the riskiest thing an unattended agent can do, and the event text it learns from (error output, command text) is untrusted.
3. **Learning was slow and judged by opinion.** Fixes landed weekly, and whether a fix held was a hand-set status.

So:

- **Capture is automatic.** A session's only optional duty is a one-line `note`.
- **Recall at the moment of failure.** The failure hook matches the event against issue matchers and returns the fix as context.
- **Rules are data where they can be.** The healer adds and tunes JSON rules, and ports a guard's checks into data rules when they fit (`guard port`, checked against the guard on every logged command).
- **Healing needs no person.** The person often doesn't use the tools Claude fails with, so a fix waiting on their approval is a fix that never lands. When a fix needs code in antibody's own files (a local guard, an agent helper in `~/.claude/bin`), the healer writes a patch and applies it itself with `apply`, which backs the files up, runs `antibody test` and the patch's own checks, and puts everything back if they get worse. That keeps the risk of unattended code (it learns from untrusted event text) bounded by evidence instead of by a person who lacks context. Changes outside antibody's files (`~/.claude/CLAUDE.md`, settings, permissions) still go to a person.
- **Local knowledge stays local.** Tool traps for one person's tools and hosts live in their data folder (`learned.md`, local rules, guards). The plugin ships only generic rules.
- **Evidence gates every rule.** New rules start in shadow. Promotion needs hits across sessions with none disputed, every case passing, and a clean replay against logged traffic.
- **Status is computed** from recurrence after the fix.
- **"What worked next" is data.** After a failure, the next similar successful call in the session is logged as a recovery: the fix, written by the model that hit the problem.

## Stalls

A hang isn't a failure: the call never errors. Either the person presses stop or the session kills its own background task, and the kill succeeds. antibody covers this in three ways:

- interrupts (`is_interrupt` on PostToolUseFailure) and TaskStop/KillShell are logged as `interrupt` and `stall` events, with the command and how long it ran;
- every shell call is timed (PreToolUse writes a marker, PostToolUse reads it), so slow calls show up even when they finish;
- `core.stdin-hang` refuses the most common cause before it runs: a stdin reader (`grep`, `sort`, `jq`, `tr`, ...) with no file operand and nothing piped in.

## A stale task list

A long run can do the work and still look stuck: the person checks the task list (TodoWrite, the Task tools, or the desktop app's `update_plan`), and the list can sit on step one for hours while commits and PRs land. antibody records when a session last touched its list. When a commit, push, PR create/merge or Jira transition lands and the list is older than `stalePlanMs` (15 minutes), the model is reminded to update it, at most once per `stalePlanMs`, and a `stale-plan` event is logged. A session that never keeps a list hears nothing. How long a turn runs is not checked: a long turn is often what the person asked for.

## Parsing shell without a shell

`lib/shell.mjs` masks everything that isn't structure (quoted text, escapes, `$(...)`, backticks, comments, heredoc bodies) into same-length text, then splits on separators and pipes. Rules match structure on the masked text and read values back from the original at the same offsets. Bash and PowerShell quoting are modelled separately.

## Boundaries

| Who | Can change |
|---|---|
| Any session | nothing in antibody's state except `note` (and issue files) |
| The review (unattended) | issues, data rules and their states, `learned.md`, its review file, and through `apply` (tested, rolled back on failure) local guards and helpers in `~/.claude/bin` |
| A person | packs (by release), settings, permissions, `~/.claude/CLAUDE.md` |

`core` rules enforce the bottom row against shell writes too, since permission deny rules cover only the file tools.
