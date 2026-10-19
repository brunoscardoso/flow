---
loop: fix
engine: consumer
paused: false  # 2026-08-17: resumed at user request — the queue drains to empty (#1673); the earlier accumulate-mode pause is over.
mission: Take work out of the list — drain it, task by task, each one fixed end to end and closed with evidence
scope: [src/, app/src/, app/e2e/, scripts/, .claude/]
queue: ledger
label: loop-fix
topic: backlog
max_open_issues: 20
max_run_minutes: 45   # 2026-08-17: one run should fit a whole item incl. build+e2e; the SESSION chains runs until the queue is empty either way
max_concurrent_runs: 25   # 2026-09-03: raised from 2 — as many concurrent fixes as the user starts, up to the safety backstop
needs_approval: false
---

## Direction

This is the ONE consumer. There is no separate loop per kind of task — what a
task is about is a tag on the task, not a loop of its own.

### You drain, you do not do one thing and stop

Take a task, fix it, land it, take the next. Keep going until the list is empty,
the budget is spent, or the breaker trips. A run that fixes six tasks is a good
run; a run that fixes one and halts because it fixed one is the behaviour this
replaced.

Naming a task jumps the queue rather than shrinking the run:

    agent-loop fix          # drain the list in the order it hands them to you
    agent-loop fix 1432     # that one first, then carry on with the rest

### Five engineers share this list

Every task you start is assigned to you and marked in progress **on the task
itself**, before you touch any code. Not in local state — four other people and
their agents are reading the same list, and a claim they cannot see is not a
claim.

If a task fails, give it back: unassign it and say what failed. Leaving it
assigned to a run that has ended strands it for everyone else.

### Order when the list is deep

Data loss and destructive behaviour first, then anything a person filed by hand,
then anything a producer filed with a reproduction, then everything else. An item
whose *Expected* section you cannot understand is an item to escalate, not to
guess at.

The pipeline is the project's own: `/discovery-plan → /create-plan →
/execute-plan → /review-pr`, driven on plan-flow autopilot — stages chain
within a run for as long as its budget lasts, stopping only for a spent budget
or a decision only a human can make. Do not invent a lighter-weight process
for a big item, and do not run the heavyweight one for a typo.

## Rules

Reproduce before fixing, end to end, the way the reporter would. A fix validated
only by a unit test on the function you just changed is not validated — the
failure usually lives in the wiring.

Never trust a summary — your own included. The evidence for a close is the
commands you ran and the exit codes they returned; if you did not run them this
run, you do not have evidence.

This repo has two runtimes: root CLI tests run through `npm run test`, and the
app's typecheck is `npm run typecheck` (a bare `tsc --noEmit` inside `app/`
checks nothing). Bundled CLI assets under `app/resources/` are generated — edit
the repo-root `.claude/**` and rebuild.

Stage only the files you touched. The main checkout is shared with a human and
with other loops.

One task, one branch, one pull request, one line in the log. Six tasks in a run
are six of each — a revert should take back one fix, not five bystanders.
