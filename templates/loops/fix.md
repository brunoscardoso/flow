---
loop: fix
engine: consumer
paused: true
mission: Take work out of the list — drain it, task by task, each one fixed end to end and closed with evidence
scope: []
queue: ledger
# repo: owner/name — filled in from this project's git remote by `planflow-ai init`, together with queue: github
label: loop-fix
topic: backlog
max_open_issues: 20
max_run_minutes: 25
max_concurrent_runs: 1    # raise to let a second terminal run this loop too
needs_approval: false
---

> Seeded by `planflow-ai init` and **paused**, because a loop nobody has read is
> a loop pointed at a guess. Edit the mission, the scope and the prose below to
> say what this project actually wants drained, then set `paused: false` and
> commit — steering a loop is a commit, and `git log` on this file is the history
> of what it has been pointed at.

## Direction

Work the queue in the order it hands items to you, and spend the run on the item
you were given rather than shopping for a nicer one. What matters within a run
is that the user-visible behaviour the item describes is actually different
afterwards — not that a patch was written.

Value order when the queue is deep and you have to reason about what a run is
worth: data loss and destructive behaviour first, then anything a person filed by
hand, then anything a producer loop filed with a reproduction, then everything
else. An item whose expected behaviour you cannot understand is an item to
escalate, not to guess at.

Use this project's own pipeline rather than inventing a lighter one:
`/discovery-plan → /create-plan → /execute-plan → /review-pr`, one stage per
run for anything big. Do not run the heavyweight pipeline for a typo either.

## Rules

Reproduce before fixing, end to end, the way the reporter would. A fix validated
only by a unit test on the function you just changed is not validated — the
failure usually lives in the wiring.

Never trust a summary — your own included. The evidence for a close is the
commands you ran and the exit codes they returned; if you did not run them this
run, you do not have evidence.

Learn this project's verification commands once and record them here, so a run
never has to guess which runner or typecheck actually proves anything.

Stage only the files you touched. The checkout may be shared with a human and
with other loops.
