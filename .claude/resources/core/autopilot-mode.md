# Autopilot

## What autopilot is

Autopilot is a **runtime**, not an instruction. When it is on, the workflow chain
— discovery → plan → execute → review → the git tail — runs because code runs
it, from state anybody can look at. Nothing in this file asks a model to decide
whether to continue, because that decision is no longer a model's to make.

This matters more than it sounds. Autopilot was a config key plus an
`AUTOPILOT MODE CHECK` block pasted into four command files, asking the agent to
please run the next thing. Nothing executed the chain, so whether it happened
was a choice — and a choice made at the end of a long run, by a context that had
been about something else for an hour. The complaint that it "does not really
work" was accurate, and the fix was to move the ordering out of prose entirely.

What is left here is a **description of what the code does**, so that an agent
running inside a chain knows what is being done around it. Read it that way. If
it ever disagrees with the code, the code is right and this file is a bug.

---

## Autopilot Detection

This is the **single, canonical way** to determine autopilot state. Every
workflow command and every consumer reads it here — do NOT restate the check,
and do NOT inspect the raw `flow/.autopilot` file directly.

1. Run `planflow-ai flow show --json`.
2. Read `config.autopilot`. If it is `true`, autopilot is **ON**; otherwise **OFF**.

`config.autopilot` is already fully resolved by the config parser: it merges the
`.flowconfig` `autopilot` key, the legacy `flow/.autopilot` file as a
backward-compat fallback, and the built-in default (off — a project nobody has
asked has not opted in). That is why the raw file must never be checked on its
own — setting `autopilot` via `.flowconfig` (the IDE toggle and
`/flow autopilot=true`) deletes the legacy file, so a raw-file check reads a
project with autopilot ON as OFF. Reading `config.autopilot` is the one code
path that cannot drift. The app resolves the same two sources in
`app/src/main/flow/autopilot.ts`, which the chain driver and the config observer
both call, for the same reason.

---

## The two halves

Autopilot is **a driver and a refusal**, deliberately separate. A driver that is
careful is a driver that can be careless tomorrow; the refusal is what makes the
wrong rung impossible regardless of who issued it.

### The ladder

`src/cli/state/workflow-stages.ts` holds the four rungs in order, as data:
`discovery → create-plan → execute-plan → review-code`. The app mirrors the same
tuple in `app/src/main/drive/chain-model.ts` (the two packages do not import each
other — the CLI is reached by spawning the bundled binary), and the order is the
whole of what is mirrored: everything about what PROVES a stage ran lives on the
CLI side, because proofs are files.

### The driver

`app/src/main/drive/autopilot-chain.ts` issues the next rung when a turn ends. It
decides from **observable state only** — the thread's stored stage, its status,
and whether its last turn ended cleanly. It never reads a transcript for "I
finished": the model reporting its own completion is exactly the evidence this
feature exists to stop trusting.

It shares one advance mechanism (`TurnDriver`) and one claims registry
(`ThreadClaims`) with the board's own loop, so a conversation has at most one
thing driving it, refused in code rather than by everyone remembering.

**It calls the refusal before it issues a rung** (`app/src/main/drive/stage-gate.ts`).
Every edge the chain steps across — `discovery → create-plan`,
`create-plan → execute-plan`, `execute-plan → review-code` — is checked against
the artifact the rung below it left behind, and a refusal **stops the chain**
with nothing sent. Ending a turn without an error is not the same as having done
the work, and for the whole of this feature's first cut it was treated as if it
were: the verb shipped with no caller at all (#1915 C2). The bottom rung is not
checked, because it has no predecessor.

**The chain mints the subject as well as the identity** (`app/src/main/drive/feature-slug.ts`).
The proofs are files named for a feature and the chain drives a conversation, not
a plan slug — so it derives a slug from the run's aim, binds the run's own id to
it, tells each stage to write its document under that name, and asks the gate
about that name. Nothing is read back out of the files being judged: a subject
resolved from the record it is about is C1's defect one field over.

### The refusal

`planflow-ai flow stage <stage> --check --feature <slug> [--chain <id>]` answers
whether a stage may run, by reading what its predecessor inevitably left behind —
never `flow/STATE.md`, which is written by a model following prose and so is the
same problem one level down wearing a filename:

| Stage | Proof | Strength |
| --- | --- | --- |
| `discovery` | `flow/discovery/discovery_<feature>_v<N>.md` exists | weak — presence only |
| `create-plan` | `flow/plans/plan_<feature>_v<N>.md` parses as a plan | strong |
| `execute-plan` | a `phase_result` entry in `flow/.rounds.jsonl` for that plan | strong |
| `review-code` | `flow/reviewed-code/review_<feature>.md` exists | weak — presence only |

Two proofs are file presence, and the verb says so rather than implying parity.

**`--chain` is the enforcement.** With a chain id, a missing proof is a
`flow refused:` line and exit 1. Without one, the identical verdict is reported
and exit stays 0 — a person running `/create-plan` by hand against a year-old
discovery is never refused into a corner. Enforcement is a property of the
enforced run, not a new law for everybody.

---

## The three pauses, and nothing else

An enforced run honours exactly three stops. They share one property: each is a
seam where a wrong action **leaves the machine**.

| Pause | Where | What holds it |
| --- | --- | --- |
| `high` risk before publishing | after the review, before push/PR | `planflow-ai flow risk --check` reads the `risk` entry **this chain** recorded via `planflow-ai flow risk --record <level> --chain <id>` — the one writer — and refuses `high`; it refuses `risk-unassessed` when nothing this chain recorded rated the work, which is a distinct reason and never treated as a low one. An unstamped or foreign-chain entry satisfies nothing (#1915 C1). It never judges risk itself. |
| The guard classifier's `ask` | inside a run's own turn | `planflow-ai guard classify` (only when `guarded_autopilot: true`). It surfaces as a question on the thread; the chain holds rather than talking over it. |
| An unbound branch at publish | at the first push | `planflow-ai worktree push` / `pr` refuse a branch nobody has bound, rather than guessing a remote name. The chain reports the refusal and stops. |

A held chain is **not a failed chain**: the work is built, reviewed and
committed, and it is sitting unpublished waiting on a person. Anything that
reports it as an error is telling somebody that something broke when in fact it
is waiting on them.

**What an enforced run does NOT stop for** are the four quality stops — a wave
file conflict, a contract conflict, a withheld behavioural repair, a failing lint
gate. It goes past them and records that it did, via
`planflow-ai flow pushed-through <stop> --feature <slug> --run <run-id> [--chain <id>]`,
the one writer of the `pushed_through` rounds entry. The publish gate reads them
back and **reports** them; it never refuses for them.

---

## The tail moved

`/execute-plan` commits, pushes and opens the pull request at the end of its own
run — which means the review that follows runs on work that has already been
published. Under a chain the **chain** owns that tail, after the review
(`app/src/main/drive/chain-tail.ts`), which is the better order.

One behaviour, two triggers. A chained `/execute-plan` is told so in the message
that starts it, and `.claude/commands/execute-plan.md` says the same thing, so a
reader who finds two push sites does not conclude one of them is a bug.

---

## What this means for an agent inside a chain

- **Do not chain anything yourself.** Finish your stage and stop. What comes
  next is issued by the harness, from state, not by you deciding you are done.
- **The chain id rides on the message that started you**, verbatim, in an HTML
  comment: `<!-- flow-chain: <id> stage=<stage> feature=<slug> -->`. Read it from
  there; never mint one, never reuse an earlier run's. Pass it to
  `flow risk --record` and `flow risk --check` — with it those verbs refuse,
  without it they only report. On `risk` it is also the run's IDENTITY: the gate
  reads only assessments recorded under the same id, so an entry recorded without
  it (or under someone else's) leaves the publish refused as unassessed. No
  marker means you are not chained — omit the flag.
- **The feature slug rides on the same marker, and it is not a suggestion.** The
  message names the document this stage is expected to leave behind
  (`discovery_<slug>_v<N>.md`, `plan_<slug>_v<N>.md`, `review_<slug>.md`). Write
  it under exactly that slug. The harness runs `flow stage --check` against that
  name before it issues the next rung, so a document named for something else
  does not quietly work — it stops the chain. You do not run the stage check
  yourself; it is run around you.
- **Do not commit, push or open a pull request** at the end of a chained
  `/execute-plan`. The chain does that after the review.
- **A question is a pause, not a failure.** Ask it on the thread. The chain holds
  while the thread is `needs-decision` or `blocked`, and your answer is what
  resumes it; headless runs write the question to `flow/.heartbeat-prompt.md`.
- **A step that did not finish cleanly stops the chain.** Do not paper over a
  failed stage so the next one can start on a foundation that is not there.

---

## Which threads chain

| Thread | Chains? |
| --- | --- |
| An ordinary conversation | only when the project's autopilot switch is on — the switch is the consent, and a chain that could start on a project which never asked for one would make it decorative |
| A board-loop thread | always — a conversation the loop opened is autonomous by definition, and its own consent was pressing play |

The asymmetry is deliberate and is implemented in
`app/src/main/tasks/board-loop.ts`. `autopilot` is a **project-wide** key: turning
it on so that loop cards chain would change how the person's own conversations
behave, which nobody asked for.

---

## What used to be here

Input classification, a six-step flow to follow, a transition-summary format, a
context-cleanup prompt, and a table of rules in other command files that
autopilot "suspends". Every one of those was an instruction to a model about
sequencing, and sequencing is now the harness's job. They were removed rather
than updated: a second specification of a behaviour that already exists in code
drifts from it, and the drift is invisible until it matters (allowed-pattern #14).
