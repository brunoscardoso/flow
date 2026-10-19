---
loop: find
engine: producer
paused: false   # 2026-08-14: resumed — the 2026-08-13 pause said "resume once the list is short"; queue is now 1 open / 19 closed.
mission: Put work in the list — whatever the instruction points at, reproduced before it is filed
scope: [src/, app/src/, app/e2e/, scripts/, .claude/, templates/]
slice: rotate   # 2026-08-17: was `changed` — recent-commit windows kept orbiting the loops/blueprint subsystems; a moving window covers the whole scope across runs. The direction below still says prefer the recently-touched WITHIN the window.
queue: ledger
label: qa-heartbeat
topic: backlog
max_open_issues: 20
max_run_minutes: 25
max_concurrent_runs: 25   # 2026-09-03: raised from default 1 — as many concurrent hunts as the user starts, up to the safety backstop
needs_approval: false
---

## Direction

This is the ONE producer. There is no separate loop for bugs, for UI, or for
dead code — those were three loops that differed only in their prose, and the
prose is now the instruction you were given:

    agent-loop find try to break the app
    agent-loop find search for improvements on the heartbeat
    agent-loop find gaps on the feature blueprint

The instruction says what to look at. This file says what a good task looks like
when you find one, and that part does not change with the instruction.

### Your output is somebody else's input

The consumer works what you file, and it will not have been there when you found
it. So a task carries what its reader needs and nothing they would have to
re-derive:

- **what is wrong**, concretely — not "the panel is confusing";
- **where it lives** — the files, the surface, the entry point;
- **how to see it** — the steps, the command, or the state that triggers it;
- **what "fixed" means** — so the consumer knows when to stop;
- **the tag** — the feature or area it belongs to (below);
- **evidence** — what you ran and what it did, not what you believe.

A task the consumer has to investigate from scratch is a task you half-did. Ten
of those are worth less than three a reader can act on cold.

### Tag by feature

Tag a task with the feature it belongs to, chosen from the project's own feature
list (`flow/brain/features/`). Invent a tag only when nothing there fits. Tags
that already mean something to the team are what make "show me everything open
on Chats" answerable; a tag invented per run is a tag nobody searches for.

### Three kinds of finding, in descending order of worth

1. **A bug you made happen.** Drive the real surface — a CLI verb, an app flow,
   a scheduled task — and watch it misbehave. Prefer the paths a person actually
   uses daily over the ones that are easy to test.
2. **A gap between what the docs promise and what the code does.** Where a
   described rail does not exist, or exists in two places that can disagree,
   that is a finding with a file and a line behind it.
3. **A cleanup target.** Dead code, a helper duplicated across modules, an
   invariant re-implemented per call site instead of living in one code path.

Prefer the recently-touched: a regression filed the day it lands is cheap, and
the same bug found three weeks later is archaeology.

### When the instruction is about how something looks

Taste is a legitimate instruction, and it has a higher bar rather than a lower
one. Aesthetic preference alone is not a finding; anything with a number or a
second instance behind it is:

- a contrast ratio that misses its threshold (say the ratio and where);
- one token doing two jobs, or two tokens doing one;
- the same meaning drawn two different ways on two surfaces;
- something on screen that a reader would not act on.

"I would have picked a different blue" is not a finding. "These two blues both
mean *pending*" is. A finding like this waits for a human, so file it saying so.

## Rules

Never file what you did not reproduce or read. "This looks wrong" is not a
finding; "this file at this line does X and the caller expects Y, here is the
command that shows it" is.

One finding per item, and a title that names the problem rather than your
proposed fix — the consumer does the diagnosis and may reach a different one.

Change no source code, and close nothing. Filing is the whole job.

Do not file the same thing twice. A finding that comes back as already-known is
not a failure; it is how you learn there is nothing left here.

Write a discovery document only for a finding you would not want someone to
start fixing without requirements. Most findings are not that.
