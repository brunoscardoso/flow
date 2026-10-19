
# Unified Status Contract

## Purpose

A single **signaling vocabulary** for every agent that reports status to a coordinator — wave sub-agents, phase sub-agents, heartbeat tasks, and any future loop or background task. Five signals cover the full lifecycle of a unit of work:

`working` / `needs-decision` / `blocked` / `done` / `failed`

**Core principle**: This is the **signal layer only**. Existing domain outcome enums (`success/failure/partial`, `pass/fail/failed-needs-decision`, heartbeat NotificationType) are NEVER replaced or renamed — they map onto these signals via the tables below.

---

## The Five Signals

| Signal | Meaning | Coordinator Action |
|--------|---------|--------------------|
| `working` | In progress, no attention needed | None — informational only |
| `needs-decision` | Paused on a judgment only the user can make | Surface to the user, wait for a decision |
| `blocked` | Paused on an external dependency (missing tool, credentials, another task) | Surface to the user with the dependency named |
| `done` | Completed successfully | Process results, proceed |
| `failed` | Completed unsuccessfully, no user decision pending | Report the failure with evidence |

The distinction that matters most is `needs-decision` vs `blocked` vs `failed`:

- `needs-decision` — the agent *could* proceed but should not choose alone (e.g. a repair was withheld to protect intent)
- `blocked` — the agent *cannot* proceed until something external changes
- `failed` — the work is over; there is nothing to decide or unblock

---

## Contract Rules

Derived from the firstmate status protocol (see `flow/references/tool-firstmate.md`):

1. **One line, then stop** — a signaling agent appends exactly ONE status line, then stops. It does not narrate, elaborate, or append multiple signals in a burst. Long context goes in a file; the signal is the pointer.
2. **Every signal is a wake event** — each appended signal wakes the coordinator. Coordinators must treat signal arrival as the trigger for processing, not poll agent internals.
3. **`working` signals are absorbable** — a coordinator may absorb (swallow without waking) a `working` signal ONLY when the agent is provably still active (e.g. a live sub-agent call in flight, an active verification run-step). All other signals — `needs-decision`, `blocked`, `done`, `failed` — always wake.
4. **Live state beats stale signals** — when a signal contradicts observable live state (e.g. a `working` line from an agent whose process has exited), the live state is authoritative.

---

## Mapping to Existing Vocabularies

Domain enums stay exactly as they are. When a domain outcome needs to be expressed as a signal (progress entries, event streams, future loops), use these mappings:

### Phase Status (`phase-isolation.md` Return Format)

| Domain value | Signal |
|--------------|--------|
| `success` | `done` |
| `failure` | `failed` |
| `partial` | `needs-decision` |

`partial` maps to `needs-decision` — not `failed` — because a partial phase always asks the user to judge (continue, retry, or stop).

### Task Verification (`per-task-verification.md` `task_verifications` entries)

| Domain value | Signal |
|--------------|--------|
| `pass` | `done` |
| `fail` | `failed` |
| `failed-needs-decision` | `needs-decision` |

`failed-needs-decision` maps to `needs-decision` because a repair exists but was withheld pending the user's judgment.

### Heartbeat NotificationType (`heartbeat.md` Event Types)

| Domain value | Signal |
|--------------|--------|
| `task_started` | `working` |
| `phase_complete` | `working` |
| `task_complete` | `done` |
| `task_failed` | `failed` |
| `task_blocked` | `blocked` |

`phase_complete` maps to `working` — the task as a whole is still in progress; only `task_complete` signals `done`.

### Legacy Wave Progress (`shared-context.md` progress entries)

| Domain value | Signal |
|--------------|--------|
| `complete` | `done` |

Progress entries now write the signal vocabulary directly (see `shared-context.md` COR-SC-2); readers treat the legacy bare `complete` as `done`.

---

## Scope

- **The signal layer never replaces domain enums.** JSON return contracts, verification records, and heartbeat event types keep their existing values — no new required fields, no renames. Coordinators translate at the boundary using the tables above.
- **New signaling surfaces MUST use this vocabulary.** Any future loop, background task, watcher, or agent-to-coordinator status channel adopts `working / needs-decision / blocked / done / failed` directly — never a new bespoke enum.

---

## Rules

1. **Five signals, no additions** — new states must map into the existing five; extend the mapping tables, not the vocabulary
2. **Signal layer only** — domain outcome enums are never replaced, renamed, or given new required fields
3. **One status line per signal, then stop** — signaling agents do not narrate
4. **Absorb only provably-working** — `working` is the only absorbable signal, and only with live evidence of activity
5. **Legacy `complete` reads as `done`** — readers of progress entries accept both
6. **New surfaces adopt natively** — future signaling channels use this vocabulary from day one

---

## Related Files

| File | Purpose |
|------|---------|
| `.claude/resources/core/shared-context.md` | Progress entries carry the signal vocabulary directly (COR-SC-2) |
| `.claude/resources/core/phase-isolation.md` | Phase status enum (`success/failure/partial`) — mapped, not replaced |
| `.claude/resources/core/per-task-verification.md` | Verification status enum (`pass/fail/failed-needs-decision`) — mapped, not replaced |
| `.claude/resources/core/heartbeat.md` | NotificationType event stream — mapped, not replaced |
| `flow/references/tool-firstmate.md` | Source of the status protocol (firstmate deep read) |
