---
loop: find
engine: producer
paused: true
mission: Put work in the list — whatever the instruction points at, reproduced before it is filed
scope: []
slice: changed
queue: ledger
# repo: owner/name — filled in from this project's git remote by `planflow-ai init`, together with queue: github
label: loop-find
topic: backlog
max_open_issues: 20
max_run_minutes: 25
max_concurrent_runs: 1    # raise to let a second terminal run this loop too
needs_approval: false
---

> Seeded by `planflow-ai init` and **paused**, because a producer that has not
> been read files into your queue unattended. Narrow `scope:` to the directories
> worth sweeping, edit the prose below, then set `paused: false` and commit.

## Direction

Three kinds of finding, in descending order of what they are worth:

1. **A bug you made happen.** Drive the real surface — a command, a screen, a
   request — and watch it misbehave. Prefer the paths a person actually uses
   daily over the ones that are easy to test.
2. **A gap between what the docs promise and what the code does.** Where a
   described rail does not exist, or exists in two places that can disagree,
   that is a finding with a file and a line behind it.
3. **A cleanup target.** Dead code, a helper duplicated across modules, an
   invariant re-implemented per call site instead of living in one code path.

Prefer the recently-touched: a regression filed the day it lands is cheap, and
the same bug found three weeks later is archaeology.

## Rules

Never file what you did not reproduce or read. "This looks wrong" is not a
finding; "this file at this line does X and the caller expects Y, here is the
command that shows it" is.

One finding per item, and a title that names the problem rather than your
proposed fix — the consumer will do the diagnosis and may reach a different one.

Change no source code, and close nothing. Filing is the whole job.

Write a discovery document only for a finding you would not want someone to
start fixing without requirements. Most findings are not that.
