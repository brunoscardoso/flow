---
description: Run one turn of an agent loop in this session — same gate, same state, and human-readable output.
---

# Loop: One Run, In Session

## Command Description

This command runs **one run** of a named agent loop inside the current session,
instead of waiting for the heartbeat daemon to run it headlessly. It is the same
protocol either way: the same gate (`planflow-ai loop next`), the same state, the
same locks, the same run log — only the output is rendered for a person.

That makes three terminals in three worktrees a supported way to work: each one
runs `/agent-loop <name>` for a different loop, and the CLI keeps them from stepping on
each other.

**Output**: the queue, drained. A consumer session chains runs — each run
fixes tasks, lands them and records its ledger line; when a run ends on
`budget` or `cap` with items still claimable, the session opens a fresh gate
and continues as the next run, exactly as the daemon's next scheduled run would. The
session stops ONLY when a run records `empty`, when the gate refuses in a way
a fresh gate cannot cure (`paused`, `locked` by another live run), or when a
human decision blocks everything that remains. A producer files until it finds
nothing new or a verb refuses it. Plus a summary and the recorded run lines.

---

## Help

**If the user invokes this command with `-help`, display only this section and stop:**

```
/agent-loop - One run of an agent loop

DESCRIPTION:
  Runs a single run of a named loop in this session. Same gate, same
  state and same locks as the headless (heartbeat) path; the only
  difference is that output is rendered for a human.

USAGE:
  /agent-loop <name>          One run of the named loop
  /agent-loop <name> <aim>    One run, aimed at part of what it already covers
  /agent-loop -status         Show every loop's state and the run digest
  /agent-loop -help           Show this help

ARGUMENTS:
  name          A loop with a directive at loops/<name>.md. Its mission,
                scope, queue and caps come from that directive and from
                nowhere else.
  aim           Optional. Everything after the name is a focus for THIS
                run: where to look first inside the mission the directive
                already sets. It cannot widen the scope. It is passed to
                the gate as --focus, stamped on the run's lock and written
                onto the run-log line, so a run aimed by hand reads back
                exactly like one that was not.

EXAMPLES:
  /agent-loop fix             One consumer run — claim an item and work it
  /agent-loop find            One producer run — sweep the slice and file findings
  /agent-loop find dead code  Same run, looking at dead code first
  /agent-loop -status         What every loop is doing right now

REFUSALS:
  /agent-loop                      no name -> show the loops, ask which one
  /agent-loop nosuchloop           no loop by that name -> show the loops, stop
  /agent-loop <name> <aim out of scope>
                             run the part that IS in scope and say what was
                             dropped; if none of it is, run nothing and offer
                             to edit the directive

WHAT A RUN DOES:
  consumer   claim a task, judge it big or small, fix it directly or drive
             its pipeline stage by stage (a stage boundary is a checkpoint,
             not an exit) — then take the NEXT task; when a run's budget
             ends mid-queue, a fresh gate continues as the next run, until
             the list is EMPTY
  producer   sweep the scope slice, reproduce before believing, file
             what survives

RELATED COMMANDS:
  /heartbeat         Schedule the same runs to run unattended
  /discovery-plan    The stage a big item starts at
  /review-pr         The stage a finished pipeline ends at
```

---

## Critical Rules

| Rule | Description |
|------|-------------|
| **A Name, Then Optionally An Aim** | The first argument is a loop name; anything after it is a **focus** for this one run. No name and a name no loop answers to are still refusals — see Step 1. |
| **The Directive Decides, The Focus Narrows** | Mission, scope, queue and gates come from the loop's committed directive and nothing on the command line can change them. A focus only says *where to look first* inside that mission. It is passed to `loop next --focus`, stamped on the run's lock, and written onto the run-log line — so a run aimed by hand leaves a log that says what it was aimed at. |
| **Gate First** | Every run starts with `planflow-ai loop next`. Never start work from anything else. |
| **Act On The Verdict** | Anything other than `proceed` ends the run immediately, having changed nothing. |
| **A Run Drains** | A run is NOT one item. Keep taking the next one until a verb tells you to stop — the list comes back empty, or a verb refuses because this run's time is spent. Fixing one thing and stopping wastes the rest of the run, and is the behaviour this replaced. The ONE exception is a pipeline: a run that enters one drives it for as long as the budget lasts — it stops for a spent budget or a decision only a human can make, never merely because a stage finished. The run drives it itself and writes nothing into the project's settings to do so. |
| **Report The Real Stop** | The condition you record must be the one that actually ended the run — `empty`, `budget`, `cap` or `none`. It exists to be counted, so a run that stopped early and claimed `budget` makes the log lie about how much work there was. |
| **One Owner** | Pass the `owner` from `loop next` as `--owner` on every later call in the run. |
| **Verbs, Not Improvisation** | Claim, classify, file, close, publish and escalate through the `loop` verbs. They are the only path that keeps every surface agreeing. |
| **The Session Drains To Empty** | A recorded `budget`/`cap` ending with claimables left is a checkpoint, not the finish: open a fresh gate and continue as the next run. The session stops only on `empty`, an uncurable gate refusal (`paused`, `locked` by a live run), or a human-blocking decision — never merely because one run's ledger line closed. |
| **Complete and Stop** | After the FINAL run's log line is recorded — the one that ended on `empty` or an uncurable refusal — stop and wait for the user. |

---

## Instructions

### Step 1: Read the arguments — a loop name, then an optional aim

The FIRST argument is the name of a loop. Everything after it is a **focus**: a
sentence aiming this one run at part of what its directive already covers.

The split matters, so hold it precisely:

- The **directive** (`loops/<name>.md`) sets the mission, the scope, the queue,
  the caps and the gates. A focus cannot change any of them. If the focus names
  something outside the directive's scope, say so and run the run on the part
  that IS in scope — or, when none of it is, stop and offer to edit the
  directive, which is where a lasting change of mission belongs.
- The **focus** says where to look first, and what "relevant" means this time.
  It is passed straight through to the gate as `--focus`, which stamps it on the
  run's lock and puts it on the run-log line. That record is the whole reason
  it is allowed: a run aimed by hand can be read back later exactly like one
  that was not.

Refusals **teach**: they show the loops that really exist, rather than telling
the user to go and look them up.

```bash
planflow-ai loop status --human
```

Show that output verbatim as part of the refusal — it is the list of real names,
read from the loops the project actually has.

| Invocation | Case | What to do |
|------------|------|------------|
| `/agent-loop` | **no name** | Run the status command above and show its output. Ask which of those loops to run. Start nothing until the user answers with a name. |
| `/agent-loop <name>` and the gate in Step 2 answers `loop refused: no directive for loop '<name>'` | **no loop by that name** | Run the status command above and show its output. Say that `<name>` is not one of them, and stop. Nothing was changed. |
| `/agent-loop <name> <focus text>` | **a name and an aim** | Pass the rest of the line to the gate verbatim as `--focus "<text>"`. Tell the user what the run is now aimed at in one line, then run the run normally. Everything else about it is unchanged: the same gate, the same scope, the same caps, the same log. |
| `/agent-loop <name> <focus>` where the focus asks for work the directive does not cover | **an aim out of scope** | Do not widen the scope to satisfy it. Run the run on the part of the aim that IS inside the directive and say which part you dropped; if none of it is, run nothing and offer to edit `loops/<name>.md`, where mission changes belong. |

If the user passed `-status`, run exactly that command, show the output, and stop.

### Step 2: Open the gate

```bash
planflow-ai loop next --loop <name> --human --stop-when-empty
```

Show the verdict to the user. If it is not `proceed`, print the `reason` and stop
— the run is over.

**`--stop-when-empty` is what makes a loop end itself.** A consumer whose list is
empty is not waiting for anything: it has done the work it was started for. The
flag turns that one condition — and only that one — into the loop switching
itself off, so "run until there is nothing left" is a thing a person can press
play on and walk away from. It writes a state pause, which the play button lifts;
the committed directive is untouched. Every other refusal (`cap`, `locked`, a
queue that could not be read) still changes nothing at all, because those are
reasons to wait rather than reasons to be over.

If the gate refuses with `no directive for loop '<name>'`, that is Step 1's **no
loop by that name** case: run `planflow-ai loop status --human`, show its output
so the real names are on screen, and stop there.

**A `locked` verdict is not a mistake to work around.** It means every run slot
this loop has is busy — the reason names the run holding the oldest one and, when
the loop has more than one slot, says so. Print it and stop. Do not pass a
different `--owner` to get past it, and do not edit `max_concurrent_runs` to make
room: the slots are checkouts, and taking a run into a checkout another run is
working in is the failure the whole arrangement exists to prevent
(forbidden-pattern #11).

**Running the same loop in two terminals is supported** when its directive says
`max_concurrent_runs: 2` or more. Both sessions call this same gate, each gets
its own slot and its own worktree, and the queue's per-item claim keeps them off
each other's work. The one thing they cannot share is the project's pipeline —
only one consumer holds it at a time, so a second run does direct fixes and waits
for the machinery.

### Step 3: Load the run prompt for this loop's engine

The gate result names the `engine`. Read the matching prompt and follow it for
the rest of the run:

| engine | prompt |
|--------|--------|
| `consumer` | `.claude/resources/loops/consumer-run.md` |
| `producer` | `.claude/resources/loops/producer-run.md` |

Re-run the gate for the full JSON (`owner`, `scope`, `fingerprints`) by dropping
`--human` and **passing `--owner <owner>`** — the owner is on the `slot N:` line
Step 2 just printed. Re-entry is by owner: the gate hands back the same result
object, on the same slot, with the run's original start time and only its
reservation extended.

The `--owner` is not optional here. A gate call without one mints a **fresh**
run id on purpose — two runs sharing a constant owner would both pass the
re-entrancy check and work the same checkout at once — so a bare re-run is a
different run asking to start, and it is answered as one:

- on a single-slot loop it comes back `locked` by the lock Step 2 minted, with
  `owner` empty — the one field the re-run was for;
- on a loop with slots to spare it is worse, because nothing refuses: it takes a
  **second slot and a second worktree** for one run, and holds them until they
  expire.

### Step 4: Run the run

Follow the prompt. Because a person is watching, also:

- pass `--human` on the `loop` verbs so the user can read what happened;
- surface each decision as you make it — the claimed item, the big/small verdict
  and why, the reproduction, the evidence — rather than only at the end;
- if the run needs a decision, ask the user directly instead of writing an
  escalation prompt file, and record the outcome in the run's reason.

### Step 5: Present the result

```markdown
Run complete — <loop> (<engine>)

**Verdict**: proceed
**Did**: <one line per task worked — a run that fixed six says six>
**Evidence**: <commands run and their exit codes, or the filed item's link>
**Stopped on**: <empty | budget | cap | none — the real one>
**Next run picks up**: <what the next run will find>
```

Then stop.

---

## Flow Diagram

```
+------------------------------------------+
|            /agent-loop <name>                  |
+------------------------------------------+
                    |
                    v
+------------------------------------------+
| Step 1: exactly one argument?            |
| - one name        -> continue            |
| - no name         -> show loops, ask     |
| - extra arguments -> refuse, show loops  |
+------------------------------------------+
                    |
                    v
+------------------------------------------+
| Step 2: planflow-ai loop next            |
| - no directive for <name> -> show loops  |
| - proceed -> continue                    |
| - skip / paused / locked -> stop         |
+------------------------------------------+
                    |
                    v
+------------------------------------------+
| Step 3: Load the engine's run prompt    |
| - consumer-run.md / producer-run.md    |
+------------------------------------------+
                    |
                    v
+------------------------------------------+
| Step 4: Run ONE run                     |
| - consumer: claim -> classify -> fix     |
|             or drive its pipeline        |
| - producer: sweep -> reproduce -> file   |
+------------------------------------------+
                    |
                    v
+------------------------------------------+
| Step 5: Record the run, summarize, stop |
+------------------------------------------+
```

## Context Loading

**Queries**:
- `planflow-ai state-query "agent loops directive" --scope resources`
- `planflow-ai state-query "loop run prompt" --scope resources`

---

## Related Resources

| Resource | Purpose |
|----------|---------|
| `core/loops.md` | The loop system: directive grammar, verbs, where state lives |
| `loops/consumer-run.md` | The consumer run prompt |
| `loops/producer-run.md` | The producer run prompt |
| `core/heartbeat.md` | Scheduling the same runs unattended |
