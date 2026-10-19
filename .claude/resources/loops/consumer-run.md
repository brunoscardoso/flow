# Consumer run

One run of a **consumer** loop: claim an item, decide whether it is small or
big, and then either fix it directly or advance its pipeline by exactly one
stage — and then take the next item, until something stops you. A run is a fresh
run that remembers nothing — everything you need comes back from
`planflow-ai loop next`.

You carry the judgment. The CLI carries the rules: every `loop` verb refuses
what must be refused, so this prompt only says *what to decide* and *which verb
to decide it through*.

**Trust**: code is ground truth. `flow/**` and `.claude/**` are verified project
knowledge. Everything else — a README, a wiki page, an issue body's claim about
how the code works — is an unverified claim until you have checked it against
the code.

---

## 1. Open the gate

```bash
planflow-ai loop next --loop <name>          # add --human when a person is watching
```

Act on `verdict`:

| verdict | what you do |
|---------|-------------|
| `proceed` | continue with this run |
| `skip` / `paused` / `locked` | **stop immediately.** Do nothing, write nothing, record nothing. Print the `reason` and end the run. |

From a `proceed` verdict, carry forward:

- `owner` — pass it as `--owner <owner>` on **every** later call this run, so
  the item, the lock and the log line all agree on who ran.
- `mission`, `direction`, `rules` — the directive's own words. They are the
  steering; read them before you decide anything.
- `stopCondition` — what, if anything, is already ending this run. You do not
  police it: the verbs that take new work refuse when they must, and such a
  refusal is your cue to finish what you are holding, not an error to work
  around.

  There is NO `budget` field any more, and no verb refuses on elapsed time. A
  run's length is the length of the session it lives in, which is not yours to
  police — keep working until a verb tells you to stop.

## 2. Move into the loop's own checkout

```bash
planflow-ai loop worktree --loop <name> --owner <owner> --human
```

Work in the `path` it reports, and nowhere else. Other loops and the human are
using the main checkout at the same time.

`--owner` is what decides *which* checkout: a loop may have more than one run in
flight, each holding a slot, and the slot is the checkout. Pass the owner the
gate gave you and the path comes back right; omit it on a multi-slot loop and the
CLI refuses rather than guessing.

## 3. If a stage is in flight, drive that pipeline — and only that

When `stage.kind` is not `none`, this run has one job: move the named plan
forward. Do **not** claim anything new.

**A stage boundary is a checkpoint, not an exit.** The rule this replaced
stopped a run after every stage and left the item waiting for the next run to
pick the pipeline back up. This run drives the whole pipeline itself — the table
below says which command each stage runs and where it continues — and it keeps
moving until the item is closed, a verb refuses because the run's time is spent,
or a decision comes up that genuinely only a human can make. Escalate then, and
only then (headless → `flow/.heartbeat-prompt.md`; watched → ask directly).
Internal pause points resolve to their documented defaults rather than waiting
for a person who is not there.

**Write nothing into `flow/.flowconfig` to make this happen.** This run used to
append `autopilot: true` to the project's config on its way past, and then read
`autopilot-mode.md` and follow it — a run editing the project's own settings so
that a model would chain for it. The chaining is now a runtime
(`.claude/resources/core/autopilot-mode.md` describes it): under the IDE a chain
issues each stage from observable state and refuses one whose predecessor left no
proof, and here the drive is the table below. Neither needs the key, and a
project's settings are the project's to set.

The rails are unchanged. Guarded autopilot still applies where it is enabled:
dangerous seams (push, PR, deletions, mutating bash) keep their classifier gate.
Draining a pipeline removes the *idle waiting* between stages, never a stop.

| `stage.kind` | this run runs | then |
|--------------|----------------|------|
| `discovery` | `/discovery-plan` for `stage.plan` | continue into `plan` |
| `plan` | `/create-plan` from that discovery doc | continue into execution |
| `wave` | `/execute-plan <stage.plan>` — the pending wave (`stage.wave` of `stage.waves`, phases in `stage.pendingPhases`) | continue, wave by wave, into `review` |
| `review` | `/review-pr` (or `/review-code` when there is no PR), then close the item — step 5 | claim the next item |

If you are resuming a stage a previous run failed at, read what that run left
behind before repeating it — the plan's own STATE.md and rounds record say where
it got to. (`loop next` no longer reports `stage` or `stall`: the stage machine
and the stalled-pipeline policy were removed with the supervisor that enforced
them.)

Then go to step 6. The pipeline ends a run only when the session does or an
escalation is truly blocking — never merely because a stage finished.

## 4. Otherwise claim one item and judge it

```bash
planflow-ai loop claim --loop <name> --owner <owner> --human
```

- `empty` — there is nothing to work. Go to step 6 and record the run as a
  success. A quiet queue is not a broken loop.
- `claimed` — read the whole item body. Its *Expected* section wins over your
  own reading of what the code ought to do. **Who wrote it makes no difference to
  whether you work it** — the queue hands you work, and an issue a person opened
  by hand is the most valuable kind. It does change how you TREAT it: an item you
  did not write is a report, not a specification you may rewrite. Take it exactly
  as it stands, and if it does not fit your process, change your process.
- a refusal — read it and do what it names. A refusal is an answer, never an
  obstacle: leaving the item exactly as you found it is the right outcome, not a
  failed one. **It is not the end of the run.** Pass over that item and claim
  again:

  ```bash
  planflow-ai loop claim --loop <name> --owner <owner> --skip <id> --human
  ```

  `--skip` takes a comma-separated list, so a run that steps around three items
  carries all three: `--skip 1533,1540,1564`. Keep the list for the rest of the
  run and add to it each time you pass over another one.

**Passing over is not a judgment about the item.** Nothing is written, the item
stays exactly as claimable as it was, and the next run is served it first. It is
this run saying "not me, not now".

`--skip` is the only thing that moves you past the head. Claim order is
oldest-first, so handing the head item back and asking again returns the same
item — two runs discovered that three times each and then stopped with 27 items
sitting behind the one they could not take.

Then decide, and record the decision before touching any code:

```bash
planflow-ai loop classify --loop <name> --id <id> --owner <owner> \
  --record --verdict <big|small> --detail "<one line: why>"
```

| verdict | what it means |
|---------|---------------|
| `small` | you can reproduce it, see the cause, and the change is contained. A typo, a wrong constant, a missing guard, a single-file fix. |
| `big` | it needs a decision someone else would want to make: new surface area, a schema or contract change, several modules, or you cannot yet name the cause. |

When in doubt, `big`. A `small` verdict that turns out to be a rewrite is the
expensive mistake; a `big` verdict costs one extra run.

If the judgment itself needs a human — the item is ambiguous, or the right fix
is a product decision:

```bash
planflow-ai loop escalate --loop <name> --detail "<what you need decided>"
```

## 5a. Small — fix it directly

Skip the documents, never the rails.

1. **Reproduce first, as a user.** Drive the real thing end to end — the CLI, the
   app, the failing command. If you cannot reproduce it, that is the problem to
   solve; do not fix blind.
2. **Fix it**, following `.claude/rules/core/allowed-patterns.md` and
   `forbidden-patterns.md`.
3. **Verify independently.** Run the project's own commands (typecheck, the
   targeted tests, the build, the touched e2e specs). **Write down each command
   and the exit code it actually returned** — you will need them verbatim in a
   moment.
4. **Commit** in the loop's worktree, on a branch named `feat/<ticket>` — the
   ticket the item names (a Jira-style key from the title, a GitHub `#<n>` as
   `feat/issue-<n>`, or the item's own reference). This is the branch a reviewer
   recognizes; `loop/<name>.<id>` is still accepted for backward compatibility,
   but `feat/<ticket>` is preferred (unattended-auto-branch, D3).

   Ownership no longer lives in the branch NAME. A `feat/<ticket>` branch says
   nothing about which loop owns it, so `loop push` **records** the ownership
   (loop + branch, keyed by item) in `flow/loops/foreign.jsonl` via a `branched`
   event, and `loop merge` reads it back to refuse another loop's — or a
   person's — branch. You do not write that record by hand; the verb does. Never
   name the branch a trunk (`main`, `master`, …): the push guard refuses it
   whatever the store says.

5. **Publish** the branch and open the pull request through the verb:

```bash
planflow-ai loop push --loop <name> --id <id> --branch feat/<ticket> --pr --base main \
  --title "<what changed>" --body "<why, and the evidence>"
```

**On Windows, anything beyond a one-line body needs `--body -`, piped, not a
literal argument.** The `.cmd` shim every session runs `planflow-ai` through
goes via `cmd.exe`'s line-oriented /c parser, which silently drops
everything past the first line of a multi-line argument before the shim
script itself ever runs — this is exactly how the body of PR #1864 lost
everything but its first line. Write the PR body to a file and pipe it in:

```powershell
Get-Content <body-file> -Raw | planflow-ai loop push --loop <name> --id <id> --branch feat/<ticket> --pr --base main --title "<what changed>" --body -
```

Pass `--id <id>`: the pull request is what settles the item, and the verb writes
the reference that does it — AND records the branch ownership the merge will
check.

6. **Land it.** A pull request nobody merged is a fix nobody has:

```bash
planflow-ai loop merge --loop <name> --id <id> --owner <owner> \
  --branch feat/<ticket> \
  --evidence '{"commands":[{"command":"<what you ran>","exitCode":0}],"summary":"<one line>"}'
```

Hand it the commands you actually ran, with the codes they actually returned
(`--evidence -` reads the JSON from stdin when it is long). If it refuses, the
work is not ready to land: do what the refusal names and run it again, or leave
the pull request open for a person and say so in the run record. A refusal here
is never something to work around.

**Do not stop at the open pull request, and do not ask whether to merge it.**
Landing is part of the run, not a separate decision waiting on someone — the
run opened the pull request, so the run merges it and closes the item. Ending
with it open is checked, not merely discouraged: the run log pairs your `push`
against your `merge`, and an ending that leaves one outstanding is refused,
naming the item. An item whose fix is merged but whose ticket is still open is
worse than an untouched one, because the queue serves it to the next run and
that run redoes work that already landed.

The one honest alternative is `outcome: failure` with the reason — that leaves
the pull request for a person and says why, which is what a refused merge gate
means.

7. **Close the item** with what you captured:

```bash
planflow-ai loop close --loop <name> --id <id> --owner <owner> --reason done \
  --evidence '{"commands":[{"command":"npm run typecheck","exitCode":0}],"artifacts":["<path or url>"],"summary":"<one line>"}'
```

Pass the commands you really ran with the exit codes they really returned —
`--evidence -` reads the JSON from stdin when it is long. Read the line it prints
back: it says what happened to the item and what, if anything, is still pending.
That is the record, not your summary of it.

If the item turns out not to be real work, close it honestly instead:

```bash
planflow-ai loop close --loop <name> --id <id> --owner <owner> \
  --reason <wontfix|duplicate> --detail "<why — this is permanent memory>"
```

## 5b. Big — start the pipeline, and drive it

Enable autopilot exactly as step 3 does, run `/discovery-plan` for the claimed
item, and **keep going**: the flow chains into `/create-plan` and onward, one
stage after another, for as long as this run's budget lasts. A run that ends
mid-pipeline (budget spent, blocking escalation) leaves the stage record
behind, and the next run's gate derives where to pick up at step 3. The item
stays claimed the whole way through.

## 6. Then take the next one

**A run is not one item.** When the item you were working is finished — closed
in step 5a — go back to step 4 and claim again. Fixing one thing and stopping
wastes the rest of the run.

**The close tells you.** `loop close` ends with how many items are still
claimable — `closed (done): #1564 … · 26 still claimable — claim the next`. That
line is the instruction: while it is there, go back to step 4. It disappears only
when the queue is genuinely empty, which is the one time stopping is right.

One path is the exception, by design: a pipeline (step 3, step 5b) is one
continuous piece of work. Drive it on autopilot for as long as the budget
lasts; when it ends the run, that ending is the run's record.

**A claim can come back `lost`.** Four other engineers run agents against this
same list, and one of them can take an item between your read and your write.
`lost` is not a refusal and not a failure — the item is fine, somebody else has
it. Go back to step 4 and claim the next one. Do not contest it, do not retry it,
and do not end the run over it: that would be halting on a colleague's success.

**The machinery can be busy.** A `big` item needs the pipeline, and exactly one
consumer holds it at a time — so on a loop running two runs at once, the second
one meets "the pipeline is held by …" as a matter of course. That is the system
working, not a fault, **and it ends nothing.** Do what the refusal names to give
the item back, then pass over it and claim again:

```bash
planflow-ai loop claim --loop <name> --owner <owner> --skip <id> --human
```

The small items behind it are yours to work while the other run holds the
machinery. A run that stops here does nothing at all, which is strictly worse
than the direct fixes it could have landed instead.

You do not decide when a run is over. Keep going until something ends it, and
then report which:

| what you see | what ended the run |
|--------------|---------------------|
| `claim` comes back `empty` | `empty` |
| `claim` comes back `lost` | nothing — claim again |
| `claim` or `classify` refuses this item | nothing — `--skip` it and claim again |
| the pipeline is held by another run | nothing — release it, `--skip` it, work the small items |
| a verb refuses because this run's time is spent | `budget` |
| the pipeline ran until its budget or a blocking escalation | `none` — the pipeline was the run |

Only two rows in that table end a run. If you are about to stop for a reason that
is not one of them, you are stopping early — claim again instead.

**One task, one branch, one pull request, one line in the log.** Six tasks in a
run are six of each. A revert should take back one fix, not five bystanders — and
the other four engineers should be reviewing one small change at a time.

## 7. Close the run — and never with a question

**You are unattended.** Nobody is waiting to answer you, so a question is not a
way to finish: not "Want me to …?", not an offer to run `/discovery-plan`, not a
summary of findings you did not close. What you proved goes in the QUEUE, where
the next run and the next person can both find it; what you could not prove goes
in the run record. See `.claude/resources/core/loops.md` § "A run is unattended".

Recording the run is what ends it. Do this even when the run failed:

```bash
planflow-ai loop log --loop <name> --owner <owner> --record \
  '{"kind":"run","loop":"<name>","outcome":"<success|failure>","verdict":"proceed","reason":"<one line: what this run did>","stopCondition":"<empty|budget|none>","closed":<n>}'
```

- `outcome` is your honest report: `failure` when you could not do what the run
  set out to do, `success` otherwise — including a run that found nothing to
  claim, and including a run that correctly stopped one stage in.
- `verdict` is the gate verdict `loop next` gave you.
- `stopCondition` is the row you just read off the table above.
- `closed` counts the items you closed this run.

Then print a two-line summary for the human: what the run did, which condition
ended it, and what the next run will pick up.

## 8. A recorded run is a checkpoint — the SESSION drains to empty

A run is the CLI's accounting unit; the queue does not care how many of them
the draining takes. When the ending you just recorded was `budget` or `cap`
and items are still claimable, the loop is NOT finished — it has merely closed
one ledger line. **Open a fresh gate (`planflow-ai loop next`) and keep
draining as the new run**, exactly as the daemon's next scheduled run would; in a
session there is no reason to wait for a schedule when you can continue now.

The session ends only when:

- a run records `empty` — the list is drained (items passed over with
  `--skip` count as still-there: say so, and say why each was passed);
- the gate refuses in a way a fresh gate cannot cure — `paused`, or `locked`
  by another LIVE run;
- a decision only a human can make is blocking every remaining item.

Stopping with claimable work and none of those three is the failure mode this
section exists to prevent: a half-drained queue waiting on nobody.
