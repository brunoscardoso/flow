# Agent Loops

A **loop** is a mission plus the state it runs against. Its direction lives in a
versioned directive file; whether it may run right now lives in one state file;
and a **run** is a fresh run that reads both rather than remembering anything.

Two engines cover every loop:

| engine | what a run does |
|--------|------------------|
| `producer` | hunts inside its scope slice, reproduces what it thinks it found, and **files** what survives |
| `consumer` | **claims** one filed item, judges it big or small, and either fixes it directly or drives the project's own `/discovery-plan → /create-plan → /execute-plan → /review-pr` pipeline itself — stages chain within a run, because a stage boundary is a checkpoint rather than an exit |

## Where everything lives

| Path | What | Trust |
|------|------|-------|
| `loops/<name>.md` | The directive — the steering surface, versioned in git | precious, hand-edited |
| `flow/loops/state.json` | Pause flags, breaker counters, locks | machine-owned; written only through the CLI |
| `flow/loops/queue.jsonl` | The ledger queue (`queue: ledger` only) | machine-owned |
| `flow/loops/foreign.jsonl` | What a loop knows about items it did not file — claims and handled records | machine-owned; append-only |
| `flow/loops/runs.jsonl` | One line per run, plus pause/resume/approve events | append-only |
| `flow/loops/classifications.jsonl` | The recorded big/small verdicts | append-only |
| `.claude/resources/loops/consumer-run.md` | The consumer run prompt | shipped asset |
| `.claude/resources/loops/producer-run.md` | The producer run prompt | shipped asset |
|  `.claude/commands/loop.md` | `/agent-loop <name>` — one run inside a session | shipped asset |

## Invariants live in the CLI, never in a prompt

Pause, dedup, the open-item cap, claim eligibility, the loop and pipeline locks,
the breaker, the approval gate, the push carve-out, the handled record and the
close-evidence requirement are all enforced inside `planflow-ai loop`
(allowed-pattern #14). A
run prompt that restated any of them would be a second copy of a rule that can
drift from the one that is actually in force — so the prompts carry judgment
only, and every gate is something they *call* rather than something they
*remember*.

Practical consequence when editing a prompt: if a sentence would still be true
with the word "must" in it, it probably belongs in code, not in the prompt.

## A run is unattended

**Nobody is reading the run while it happens.** A loop exists to work between
sessions — the word is in the first sentence of the panel that starts one — so
the run has no one to answer a question, and a question is not a stopping
condition. Only three things end a run: `cap`, `budget`, `empty`.

Concretely, a run NEVER:

- ends by asking what to do next ("Want me to …?", "should I …?"). If the run
  can act, it acts; if it cannot, it files what it proved and records the run;
- offers to start another flow — `/discovery-plan` and its relatives are things
  a run WRITES when a finding is big enough (producer step 5), never things it
  proposes and waits on;
- writes its findings into the conversation instead of the queue. Prose in a
  thread is not on anyone's list, is not deduplicated, and is gone the moment
  the thread is archived. The queue item IS the output.

Observed live (2026-09-02): a producer run swept the Loops UI, produced a
correct and detailed analysis naming files and lines — everything its own
"reproduce before you believe it" bar asks for — filed `0/20`, and ended with
"Want me to turn this into a /discovery-plan …?". The sweep was good work and
none of it reached the list, because nothing told the run it was alone.

A run that genuinely cannot proceed without a person does not ask: it files the
question as an item, or records the run as a `failure` with the reason. Both
are readable later; a question in a thread nobody opens is not.

## Directive grammar

`loops/<name>.md` is frontmatter plus two optional prose sections. Parsing
is strict: an unknown key, a duplicate key, a malformed boolean or a malformed
cap **refuses** — a loop that silently ran with a default mission would chase the
wrong thing unattended for hours.

```markdown
---
loop: find                # required — must match the filename
engine: producer          # required — producer | consumer
mission: Find gaps and cleanup targets in the IDE surface
queue: github             # required — github | ledger
repo: owner/name          # required when queue: github; refused otherwise
path: flow/loops/queue.jsonl   # queue: ledger only (default shown)
paused: false             # default false — steering by commit
scope: [src/, app/src/]   # default [] (the whole repo)
slice: changed            # changed | rotate | full   (default: changed)
label: qa-heartbeat       # label applied to filed items, when the queue has labels
topic: codemap            # the area this loop is pointed at right now
max_open_issues: 8        # default 8 — positive integer
max_run_minutes: 25      # default 25 — positive integer
max_concurrent_runs: 1    # default 1 — how many runs of this loop at once
needs_approval: false     # default false — filed items wait for a human
---

## Direction

Prose handed to the run verbatim. What to look at, what matters most, what a
good finding looks like for this loop.

## Rules

Prose handed to the run verbatim. The loop's own standing judgments — not the
CLI's invariants.
```

### Every key

| Key | Type | Required | Default | Notes |
|-----|------|----------|---------|-------|
| `loop` | name | yes | — | lowercase alphanumerics in dash-separated runs; must equal the filename |
| `engine` | `producer\|consumer` | yes | — | which run prompt runs |
| `mission` | text | yes | — | the one field with no default |
| `queue` | `github\|ledger` | yes | — | where this loop's items live; written by `loop point` (or by hand) |
| `repo` | `owner/name` | when `queue: github` | — | refused under `queue: ledger`; written by `loop point --repo` |
| `path` | path | no | `flow/loops/queue.jsonl` | `queue: ledger` only; refused under `queue: github`; written by `loop point --path` |
| `paused` | `true\|false` | no | `false` | outranks everything — the one signal that survives a lost state file; written by `loop disable` / `loop enable` (or by hand) |
| `scope` | inline list | no | `[]` | `[a, b]`; a bare value is a one-element list |
| `slice` | `changed\|rotate\|full` | no | `changed` | how much of `scope` a producer run sweeps |
| `label` | text | no | — | applied to items this loop files — provenance: *which loop* filed it |
| `topic` | label text | no | — | the area the loop is pointed at — *what it is working on*; see below |
| `max_open_issues` | positive int | no | `8` | the loop's own open items, not the queue's; **the one stop a loop keeps by default**; written by `loop describe --max-open` (or by hand) |
| `max_run_minutes` | positive int | no | `25` | also sizes the run's lock TTL |
| `max_concurrent_runs` | positive int | no | `1` | run slots — one git worktree each; capped at 25, see below |
| `needs_approval` | `true\|false` | no | `false` | filed items wait behind the approval gate |

Values may carry a trailing `# comment`. Anything outside this key list refuses
by name — `max_open_issue` is a plausible typo, and ignoring it would run the
loop with a cap the file appears to have set.

### `topic:` — where a loop is working right now

`label:` says *which machine* filed an item; `topic:` says *which area* it
belongs to. Both ride onto every filed item, and an item carries either, both or
neither. Steering is a commit, exactly like `mission:` — so `git log` on the
directive is the history of what the loop has been pointed at, and re-pointing
it is one line changed and pushed.

```markdown
topic: codemap        # find [codemap] — the bracket in `status`, and the panel row
```

The grammar is deliberately looser than a loop name (a topic is a label, never a
filename): lowercase alphanumerics separated by `-`, `.`, `_` or `/`, starting
and ending with a letter or digit, at most 50 characters, and never one of the
words the queue itself uses. A topic that breaks the grammar **refuses**, naming
the value — a topic silently rewritten into something legal is a loop filing
under a word its owner never chose. An empty `topic:` is absence, like `label:`.

Under `queue: github`, a missing topic label is **created** on the repo (and the
creation is logged). This is the one place a loop writes repo configuration, and
it is narrow on purpose: only the topic, never the queue's own vocabulary, which
stays a setup precondition a human is meant to see missing.

Two consequences worth knowing before you re-point a loop:

- **Old items keep their old topic.** A topic is not part of an item's dedup
  key, so re-pointing never re-files a backlog — but nothing rewrites what is
  already filed either. Items filed under `codemap` stay labelled `codemap`
  forever, which is what makes "what was this loop doing last month" answerable
  at all.
- **They still count against the cap.** `max_open_issues` bounds one **loop**,
  not one topic. A loop re-pointed three times with a full queue is still at its
  cap; the new area does not come with a fresh allowance. Close or park the old
  items if the loop needs room to work the new one.

## The verbs

Everything a run, a session and the IDE panel do goes through one command, so
all three see the same state:

| Verb | What it does |
|------|--------------|
| `next` | the gate every run opens with — verdict, mission, direction, rules, slice, scope, queue counts, known fingerprints, stage |
| `claim` | claim one item, subject to eligibility |
| `adopt` | a person hands the loop an item no loop filed — refused while a run is running |
| `rework` | a person clears the handled record, so an item can be worked again — refused while a run is running |
| `unclaim` | release a claim, putting the item back in the queue |
| `plan` | record on the claimed item which plan's pipeline this run is advancing (`--plan <name>`; omit it to clear) — the handoff the next run reads |
| `classify` | record (or read) the big/small verdict |
| `file` | file a finding, subject to dedup and the cap |
| `close` | close an item, subject to the evidence gate |
| `approve` | clear one item's approval gate |
| `escalate` | pause for a human decision, keeping the item claimed |
| `worktree` | resolve (or prune) the loop's own checkout |
| `push` | push a `loop/*` branch, optionally opening a PR |
| `merge` | land a pull request opened from this loop's own branch, on captured evidence |
| `pause` / `resume` | stop or restart one loop, or every loop — **runtime** state, on this machine |
| `disable` / `enable` | set one loop's `paused:` field in its **directive** — committed intent, and the only writer of that field |
| `finish` | mark one standing hunt `stopped` (`--focus <text>`) — a person's decision, and the only verb that writes that status deliberately. The hunt KEEPS its count and stays reported, so a surface can show it as finished work rather than dropping it; reports how many hunts the loop still has running. Touches no runtime state |
| `forget` | end a standing hunt (`--focus <text>`) or all of them (`--all`) — the instruction leaves the store, so nothing draws it any more. **Removal, not a status**: a `stopped` hunt is one a person may resume and is still reported; a forgotten one is over. Touches no runtime state — no pause is lifted, no breaker reset, nothing closed on the queue |
| `point` | say where a loop reads its work — `queue:` and its `repo:`/`path:`, both in one write; the only writer of those fields |
| `describe` | say what a loop is told — its `## Direction`, its `## Rules` and its `max_open_issues`; the only writer of those three |
| `status` | every loop's state, the producer's standing instructions (`text`, `filed`, `cap`, `status`) and the rolled-up run digest |
| `list` | the queue itself — every item in a loop's queue (`--state open\|closed\|all`, default `open`); an unreadable queue reads as `items: null`, never as `[]` |
| `log` | append the run's line, or read the log |

Add `--human` to any verb to render the same result object as compact text.

### Two pauses, two lifetimes

A loop can be stopped two ways, and they are **different facts**:

| | `loop pause` / `loop resume` | `loop disable` / `loop enable` |
|---|---|---|
| what it writes | `flow/loops/state.json` | `paused:` in `loops/<name>.md` |
| lifetime | local, expiring (`--until`), lost with the file | committed — travels with the repo, survives a lost state file |
| audit trail | a `pause` line in the run log | `git log -p loops/<name>.md` |
| needs a reason | yes (`--reason`) — a pause with no reason is a bug three days later | no — the commit message is the reason, and any `# comment` on the line is kept |

```bash
planflow-ai loop disable --loop find --human   # steer it off, in the file
planflow-ai loop enable  --loop find           # and back on (JSON by default)
```

**Neither lifts the other.** Enabling a loop does not clear a runtime pause that
is standing, and disabling one does not also pause it — a person who set two
stops meant two things, and a verb that quietly lifted the other would be
starting a loop somebody stopped. `loop status` reports both: `paused (<reason>)`
for the runtime one, `paused by directive` for this one.

**It takes effect at the next gate.** The directive is read when `loop next`
opens a run, so `disable` does not interrupt a run already in flight — `loop
pause` is the verb for stopping what is running now.

Both verbs are **idempotent**: setting the value the file already has succeeds,
writes nothing, and says so (`changed: false`, rendered as `already disabled`).
The write is surgical — one value token on one line — so key order, spacing,
trailing comments and the `## Direction` / `## Rules` prose come through
byte-for-byte. A directive that does not parse is **refused, and not rewritten**:
one `loop refused:` line naming the file and the field, exit 1, nothing written.

### Pointing a loop at a different list

`loop point` writes the two fields that say where a loop's work comes from. They
are **coupled** — `queue: github` requires a `repo:` and refuses a `path:`,
`queue: ledger` refuses the `repo:` — so both move in **one write**, and the
rewritten file is parsed before it is saved. A stale `repo:` left under
`queue: ledger` is not a cosmetic leftover: the parser refuses the whole file
and the loop stops running.

```bash
planflow-ai loop point --loop fix --queue github --repo acme/widgets
planflow-ai loop point --loop fix --queue ledger --human
planflow-ai loop point --loop fix --queue ledger --path flow/loops/backlog.jsonl
```

One verb rather than a pair: a queue is a store **plus a location in it**, not a
direction, and `--repo` / `--path` carry the half that actually differs between
two loops on the same backend. Omitting `--path` under `queue: ledger` keeps the
file the loop already reads (or the documented default when it has none) — an
unmentioned field is not a field to throw away. The companion the new kind
**forbids** is the one thing this verb deletes, and it takes its own trailing
comment with it.

**It moves nothing.** Re-pointing a loop does not pause it, does not resume it,
and does not copy, close or migrate the items sitting in the store it used to
read — those stay exactly where they are. Like the pause verbs it is idempotent
(`changed: false`, rendered as `already pointed`), refuses a directive that does
not parse without rewriting it, and records itself in `git log -p` rather than
in the run log.


### Telling a loop what to do, and what to stop on

`loop describe` writes the three things that steer a run — and, like `point`,
it is the **only** writer of them:

| flag | writes | what it means |
|------|--------|---------------|
| `--direction <text>` | `## Direction` | what to look at, and what a good finding looks like |
| `--rules <text>` | `## Rules` | what **this loop** has decided, as opposed to the invariants the CLI enforces |
| `--max-open <n>` | `max_open_issues` | how many open items of its own it may have before the gate refuses it more |

```bash
planflow-ai loop describe --loop find --max-open 12
planflow-ai loop describe --loop find --direction 'Start with the loops panel.' --human
planflow-ai loop describe --loop find --rules ''          # this loop has no rules of its own
planflow-ai loop describe --loop find --direction - < direction.md   # prose over stdin
```

**Prose goes over stdin, and on Windows it must.** `--direction` and `--rules`
accept `-` for "read it from stdin instead", the convention `--body` and
`--evidence` already use. This is not a nicety: the `.cmd` shim an IDE-launched
agent runs `planflow-ai` through goes via `cmd.exe /c`, whose parser treats a
literal newline inside an argument as a statement separator — a multi-line value
passed as an argument is truncated to its first line before the shim's own
script runs, and the verb reports success. A Direction is multi-line by nature.
Only ONE of the two may be `-` in a single call; asking for both is refused,
because stdin is read once and serving it to two fields would write a person's
direction into their rules.

**The default stop is a count, and only a count.** Time is not enforced — see
`max_run_minutes` above — and `empty` is an outcome rather than a limit, so
`max_open_issues` is the whole of the leash a loop carries out of the box.
Everything else a run should respect is a **custom rule**: prose in `## Rules`,
handed to the run verbatim, that nobody has to write. A loop with no rules is a
finished loop, not an unfinished one.

**Empty removes the section.** `--rules ''` deletes the heading rather than
leaving an empty one, because "this loop has no rules" is a state a person means
and a bare heading reads as one they abandoned.

At least one flag is required: a `describe` naming nothing is a caller that
forgot its arguments, and answering it `changed: []` would read as the loop
already saying something nobody asked about. Otherwise it behaves exactly like
`point` — idempotent (`changed: []` when the file already says it), parsed
before it is saved, and refusing a directive that does not read with one
`loop refused:` line and nothing written.

**Not the same number as `--cap`.** A hunt's `--cap` bounds ONE instruction:
how many findings it may file before stopping for a person. `--max-open` bounds
the **loop**: how much unfinished work of its own it may have standing before it
is refused more. A run can reach either, they mean different things, and neither
verb resolves them into one.

### Run slots — more than one run of the same loop

`max_concurrent_runs` is how many runs of a loop may be in flight at once. It
defaults to **1**, which is the original behaviour: the second run is `locked`
and stops.

Each concurrent run holds a **slot**, and a slot is a git checkout:

| Slot | Worktree | Branch |
|------|----------|--------|
| 1 | `../.<repo>-loops/<loop>` | `loop/<loop>` |
| 2, 3, … | `../.<repo>-loops/<loop>.2` | detached |

Slot 1 is unchanged — same path, same branch — so a loop that never runs
concurrently is untouched. Later slots are **detached** because git stores
`loop/<loop>` as the file `refs/heads/loop/<loop>` and a branch can be checked
out in exactly one worktree; a consumer branches per item (`loop/<loop>.<id>`)
the moment it claims one anyway, so the base is scaffolding either way.

**Why it is safe to run two.** The loop lock was never what stopped two runs
doing the same work — the queue's per-item claim is (`in-progress` + assignee,
re-read after writing). What the lock protects is the *checkout*, and a slot per
run answers that by construction (forbidden-pattern #11).

**What does not parallelize: the pipeline.** `flow/` is one symlink (into the vault, or into the project's Workspace folder) and
`STATE.md` carries no run key, so the single pipeline lock still admits exactly
one consumer. A second concurrent run does direct fixes and waits for the
machinery — which is most of a consumer's work, but not all of it.

Slots are capped at 25 — a safety backstop, not a working ceiling. Each is a
full checkout on disk, so a fat-fingered `500` refuses by name rather than
creating five hundred worktrees.

```bash
planflow-ai loop status --human      # "running ×2 (…)" while two runs are in flight
```

### What a run may not leave behind

`loop log --record` is the one call every run makes to end, so what an ending
must be true of is checked there rather than asked of a prompt. Four rules, all
refusing on one line with exit 1 and writing nothing:

| The run… | is refused because |
|----------|--------------------|
| still holds a claim | a claim ends by closing, handing off, or releasing it |
| opened a pull request it did not merge | a PR nobody merged is a fix nobody has — and the item goes back to the queue **open**, so the next run redoes landed work |
| says `empty` or `none` while items are claimable | a run is not one item, and nothing had stopped it |
| already recorded an ending | a run ends once; a second entry counts it twice in the digest |

The last three all have the same honest escape: `outcome: failure` with the
reason. A run that could not land its work, or could not continue, says so — and
the pull request is left for a person with the reason attached.

**Landing is part of the run.** The run that opened the pull request merges it
and closes the item; there is no separate approval step waiting on someone. The
run log pairs the `push` entry against the `merge` entry by item id, which is
why both carry one.

### How a run ends — the budget and the stop condition

**A run is not one item.** It keeps working until something stops it, and what
stopped it is recorded from a closed vocabulary — `cap`, `empty`, `budget` or
`none` — so "why did it stop" can be counted rather than read.

`max_run_minutes` is NO LONGER ENFORCED, and saying so plainly matters more than
the paragraph it replaced. Nothing measures a run's elapsed time and no verb
refuses on it: a run lasts as long as the Claude Code session it lives in, which
is the harness's business rather than the loop's. The key survives with one
narrow job — sizing how long the loop's checkout stays reserved after a run
stops reporting, so a dead run's worktree is eventually reusable.

`budget` therefore remains a word a run may RECORD about its own session ending.
It is not a limit the CLI can prove, and a run that names it while claimable work
is left is making the log say something nobody checked. The historical rule
follows, kept for the record of what used to be enforced:

| Verb | Once the budget is spent |
|------|--------------------------|
| `claim`, `file` | **refused**, naming how long the run has run and the budget it had |
| `close`, `unclaim`, `log --record` | **always allowed** — they finish work already in hand |

Abandoning a half-finished fix to honour a budget is worse than running three
minutes long, so a spent budget never interrupts work already held; it only
stops the run taking more. A run that re-enters the gate keeps its original
stamp — re-entering extends the lock's TTL, it does not restart the run.

The budget can only be enforced where a run touches the CLI: nothing is resident
during a run, so there is no timer. Two consequences follow. A loop nobody holds
has no run to bound and refuses nothing; and because the lock's TTL is the
budget plus a wrap-up margin, a run that outruns even the margin has lost its
lock — at which point another run may legitimately take the loop from it.

`loop next` reports `budget` (elapsed, remaining, spent) and `stopCondition` on
every verdict; `loop log --record` accepts `stopCondition` on the run's line,
refuses a word outside the vocabulary, and fills in `budget` itself when the run
named none and its time was up.

### Whose work a loop takes, and what it may write

These are **two rules**, and conflating them shipped a `fix` loop that could not
see a single hand-filed issue: `0 claimable` on a repo full of them, every run
skipping forever, on a loop whose entire mission is draining that backlog.

**Taking work is the engine's question.** A `consumer` drains the queue it is
pointed at, so it claims anything claimable in it — its own items, another loop's,
and the ones a person opened by hand. Whoever filed an item is irrelevant to a
loop whose job is emptying the queue. A `producer` files and never claims, so it
still works only its own work.

**Writing is the item's question, and it never depended on the engine.** `file()`
writes a `<!-- loop: <name> -->` marker into every body it composes; an item
carrying no marker is a person's, and on one of those the ONLY thing a loop
writes is the claim label — `in-progress` on claim, off again on release:

| Verb, on an item no loop filed | What happens |
|--------------------------------|--------------|
| `claim` / `unclaim` | the claim label goes on and comes off. The body, the title and every other label are untouched |
| `close` | the evidence gate runs exactly as always, the claim label comes off, and a **handled record** is written. The issue is **not** closed and **not** commented on — the result comes back `handled`, and says so |
| `merge` | lands as normal, but the merge note goes into the handled record instead of onto the issue |
| `approve` | **refused** — clearing a gate on someone's issue is a relabelling, and that was never a question about who works the item |

The issue is closed **by GitHub, not by the loop**: `loop push --pr --id <id>`
puts `Closes #<id>` in the pull request body, and the user's own repo closes the
issue when that pull request merges. That is what drains a backlog without a
robot ever resolving somebody's report for them.

### The handled record

`flow/loops/foreign.jsonl` holds what a loop knows about items it did not file —
local, derived state beside `state.json`, never a write to somebody's issue. Two
facts live there, and both have nowhere else to go:

- **who is working an item**, because the claim normally lives in the body and
  the body is exactly what may not be touched;
- **that this loop already finished with one**, because the issue stays **open**
  until the merge closes it. Without that record the next run claims the issue
  it just fixed and fixes it again — the same "nothing happens" failure the old
  provenance rule caused, in a new costume.

A handled item is not claimable, and `loop status` counts it out. When a fix did
not hold, a person puts it back:

```bash
planflow-ai loop rework --loop <name> --id <id> --detail "<why it came back>"
```

Like `adopt`, it is **refused while a run holds the loop**: a run able to clear
the record that is stopping it from repeating itself is a run that eventually
will.

### Only your own work: adoption

Adoption is unchanged, and it is **a person's act**:

```bash
planflow-ai loop adopt --loop <name> --id <id> --detail "<why>"
```

It appends the provenance marker and nothing else — no label, no fingerprint, no
reshaped body — and refuses an item that already belongs to a loop, so the record
of who filed an item can never be overwritten. It is also refused outright while
a run holds the loop, which is what makes "a run cannot adopt" a fact rather
than an instruction: during the only time a run exists, the verb says no. Run it
between runs, or pause the loop first.

What adoption is now FOR is narrower than it was: an item no longer has to be
adopted to be worked, only to become the loop's own — its body writable, its
close a real close. A loop that would need a repo reconfigured — a label created,
a body rewritten — before it could work an item is still a loop that should leave
the item alone.

### Landing what it produced

A fix that passes its gates and stops at an open pull request is finished but not
delivered, so a consumer merges what it produced — `loop merge`. It is the
largest thing a loop does unattended, and the leash is correspondingly short:

| Gate | What is required |
|------|------------------|
| the branch | inside **this loop's own** namespace — `loop/<name>` itself, or one item branch under it: `loop/<name>.<id>` (a `.`, because `loop/<name>/<id>` collides with the worktree branch's own ref and git refuses to create it). Another loop's branch is refused as flatly as a human's, even though `loop push` would allow it |
| the evidence | a typecheck, a build and the targeted tests, each a captured `{command, exitCode}` record, every one of them exited 0. Prose is refused, exactly as `close` refuses it |
| the item | one this loop may work (the engine rule above), not claimed by another run, and not already settled as `wontfix` or `duplicate` |
| the pull request | open, and proposing the very branch that was validated — the resolved head is re-checked against `gh`, because everything before it was a string the caller wrote |

The branch and the evidence are checked **before any `gh` call is made at all**,
and every one of these gates refuses before anything is merged — so a merge that
was going to be refused has landed nothing, and in the common case has run
nothing. What lands is a squash merge; the remote branch is not deleted, because
the push carve-out refuses branch deletion and merging is not the place to
acquire that power.

Merging does **not** close the item and closing does not merge: two decisions,
two gates, two lines in the record. The merge is written on the item (a comment
on the issue, a `merged` event in the ledger) carrying the evidence verbatim — or,
for an item a person filed, into the handled record instead, because that issue
takes no comment either. Either way it goes in the run log as the one line
saying a loop changed the default branch:

```bash
planflow-ai loop merge --loop <name> --id <id> --owner <owner> \
  --branch loop/<name>.<id> --evidence '{"commands":[{"command":"npm run build","exitCode":0}]}'
```

### How a claim ends

A claim ends in exactly three ways, and `loop log --record` enforces it: a run
that reports `success` while it still holds an open item is refused, by name.

| Ending | How |
|--------|-----|
| the item is **closed** | `loop close --reason done` with the captured evidence (or `wontfix` / `duplicate` with a written reason). On an item a person filed the same call comes back `handled` — the claim is released either way, so it is the same ending |
| it is **handed to the next run** | the pipeline is still in flight — the run's budget ended before the item did, so the item stays claimed on purpose and the next run picks the pipeline back up |
| it is **released** | `loop unclaim --loop <name> --id <id> --owner <owner>` |

A run that did none of those did not finish, and records `outcome: failure` —
which is the honest report, and the one the stall policy can act on. There is no
flag that skips the check; a run prompt is never told the rule, because the
refusal names the item and the three endings at the moment it matters.

Claims that outlive their run anyway (a crashed run, a killed process) are
surfaced by `loop status` as `abandonedClaims` once they are older than the
loop's lock TTL. That is a report only — nothing releases an item behind a
human's back.

## Running a run

- **In a session**: `/agent-loop <name>` — one run, human-readable, same state and
  same locks as a headless run.
- **On a schedule**: a `flow/heartbeat.md` task whose command is `/agent-loop <name>`
  and which carries `- **Loop**: <name>`. Loop tasks are exempt from the
  daemon's active-session deferral, because a loop runs in its own worktree and
  should not go quiet just because a human sat down at the machine.

Each loop gets one worktree (`loop worktree`), reused across runs and sitting on
its own `loop/<name>` branch — which is also the only namespace `loop push` will
write.

## Where directives live, and why it matters

A directive is **versioned intent** and lives in the tracked `loops/<name>.md`
at the project root. That is what makes the steering model work: edit the
mission, commit, and the next run — on this machine or another one — pulls it
before it reads anything.

It cannot live under `flow/`. That path is a symlink (into the vault or a Workspace), and git
refuses to track anything beyond a symbolic link, so a directive written there
exists on exactly one computer while every run's opening `git pull` carries
nothing. This shipped that way once and the symptom was a loop that simply did
not exist on the second machine.

**Runtime state stays in `flow/loops/`** — `state.json`, `runs.jsonl` and the
optional `queue.jsonl` are local, derived and correctly untracked. Intent is
versioned; state is not.

`flow/loops/<name>.md` is still READ, so a machine whose directives have not
been moved yet keeps working. The tracked copy always wins, so a committed
directive can never be shadowed by a stale local one.

