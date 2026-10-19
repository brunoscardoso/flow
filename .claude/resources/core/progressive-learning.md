
# Progressive Learning

## Purpose

**Progressive Learning** builds institutional module knowledge through four escalating tiers, starting from free structural discovery and advancing to guarded automatic re-learning when modules change. A single session-local learning-state store (`flow/brain/.structure/learning-state.jsonl`) and a learned module knowledge base (`flow/brain/modules/<slug>.md` + anchored investigation notes) replace ad-hoc prompting with persistent, scoped understanding.

Each tier is ALWAYS-ON where applicable:
- **T0 (Structure)** — automatic, no cost, rebuild-only
- **T1 (Onboarding)** — fired once per root on first provisioning readiness (consent persisted)
- **T2 (Per-Node Learn)** — manual learning via `/learn` slash command or board popover
- **T3 (Guarded Auto Re-Learn)** — automatic when source drift detected (gated by meaningful diff, previous learning, toggle, budget)

The feature powers the learn dot on every board cell (→ "none" / "pulsing" / "filled" / "amber" staleness), the feature map's Learning lens and percentage dial, and the popover Understanding section (note summary, doc link, Learn/Re-learn).

---

## Learning-State Store

The SINGLE writer/reader of `flow/brain/.structure/learning-state.jsonl` is the `learning-state` module (main-side, plain-Node loadable — no Electron). The store is small (one deduped line per module), so every update is a full rewrite via temp+rename — readers never observe half-written state.

| File | Role |
|------|------|
| `flow/brain/.structure/learning-state.jsonl` | Module learning status (learning / learned / stale) with `notedAt` timestamps; deduped by module, sorted deterministically |

Schema (one JSON object per line):

```json
{
  "module": "string — repo-relative module path (e.g., 'src/cli/blueprint')",
  "status": "'learning' | 'learned' | 'stale'",
  "notedAt": "ISO 8601 timestamp when the status was recorded"
}
```

**Reader behavior**: Fail-soft. A missing, unreadable, or corrupt file resolves to `undefined` (no learning state). Individual corrupt lines within a valid file are skipped, never thrown — mirrors the blueprint stores' contract.

**Snapshot projection**: When the board reads a blueprint snapshot (`BlueprintSnapshot`), the `learning` field carries deduped entries. The field is `undefined` when the store is missing/corrupt/empty.

---

## The Four Tiers

### T0 — Structure (Derived)

**When**: Automatic during every `planflow-ai blueprint derive` (Phase 4 task 2 / execute-plan post-run).

**What**: Discovers the repository's module structure (depth-1 directory heuristic + extracted canonical spine from extractors). Provides the container into which later tiers add understanding.

**Cost**: Free — extracted via the same heuristic pass that builds the blueprint graph.

**Output**: Modules listed in `BlueprintGraph.nodes` (kind = "module").

**Never fails or blocks**: Structure is foundational; derive proceeds even if extractors report partial coverage.

### T1 — Onboarding (Per-Root, Fired Once)

**When**: Fires once per root on first provisioning readiness (#513 task 1).

**What**: Presents a one-time question to the user: "Would you like to generate basic documentation for each module in this project to help Claude understand the codebase better?" Answer persisted as `basic_discovery_answer` in the `projects` database table (never re-asked unless reset in Settings).

**If YES**: Enqueues one deliberate `/learn` for each depth-1 module (the **onboarding sweep**), processed serially.

**If NO**: Skips the sweep; T3 auto-learning is still available later if toggled on.

**Output**: One `flow/brain/modules/<slug>.md` per module (if completed); each module's `learned` entry written to learning-state.

### T2 — Per-Node Learn (Manual)

**When**: User clicks "Learn" in the module card's popover (board) or runs `/learn <module>` CLI command.

**What**: Headless CAGED agent session:
- **Tools available**: `Read` + `Grep` + `Glob` only (no Write, no Bash, no network)
- **canUseTool**: Synchronous deny-all — the agent cannot run tool code, only PLAN tool calls and observe failures
- **Return**: Structured text ONLY (no file modifications)

The learn prompt (`buildLearnPrompt`, `app/src/main/agent/learn-session.ts`) carries the Brain-First compact variant from `.claude/resources/core/brain-first.md` (`BRAIN_FIRST_COMPACT`, `app/src/main/agent/brain-first.ts`): orient via acquired knowledge before reading code. Since the cage has no Bash, the constant names the fallback — Grep/Read over `flow/brain/**.md` (code cards, module docs, decisions) instead of the CLI verb; stale-looking knowledge is verified against the code actually read.

The agent analyzes the module's source files and produces:

1. **Documentation** (`flow/brain/modules/<slug>.md`):
   - Brief summary of the module's purpose and responsibility
   - List of key exports (functions, types, classes)
   - Integration points (imports from, used by)
   - Known patterns and conventions
   - Markdown format, Obsidian-readable

2. **Investigation note** (via `planflow-ai blueprint observe`):
   - Anchored to the module node
   - Summary of the learning (first line, 200 char cap)
   - Provenance: `learn:module`, identifying this as an auto-generated learning note
   - Hash-stamped with content hashes of analyzed files (see Staleness below)

**Error handling**: Fail-soft. If the agent returns incomplete output or errors, the executor logs the failure and escalates to the user — no partial writes, no corrupt learning-state entries.

**Re-learn**: Calling `/learn` or the Learn button again **supersedes** the prior note (via `blueprint observe --supersede-with-reason`) with a fresh analysis. The old note remains in `investigations.jsonl` (append-only) but marked as superseded.

### T3 — Guarded Auto Re-Learn (Staleness-Triggered)

**When**: Source files change → 12-min idle → `blueprint stale-check` detects drift → learning-state flips to `stale` → (gated conditions checked) → enqueue deliberate re-learn.

**Staleness detection** (always-on, free, no budget):

1. **Learn triggers** (phase 8 task 1) monitor `flow/` source file changes (debounced per-root):
   - Filter to source files (same `isSourceFileName` rule extractors use)
   - Map each file to its owning depth-1 module (longest path-prefix match against graph modules)
   - Per-module idle debounce (12 min): a fresh touch resets the timer; a burst of saves collapses into one check

2. On idle:
   - Spawn `planflow-ai blueprint stale-check --module <m> --json` (read-only authority)
   - Parse the report for stale notes
   - If any note's stamped files have drifted (content hash mismatch or missing file):
     - Append a 'stale' entry to learning-state
     - Board dot flips to amber (stale indicator)
   - **This step is FREE**: staleness flips the dot regardless of spend, toggle, or budget

**Auto re-learn conditions** (T3 phase 9 task 2 wiring):

When a module is stale AND a deliberate re-learn is triggered (see Trigger Ladder below), the following gates are checked:

1. **Meaningful diff**: `blueprint stale-check --module <m> --json` includes `numstat` + comment-only detection. Relearn only if >=15 non-comment lines changed (heuristic).
2. **Previously learned**: The module must have a `learned` entry in learning-state (T1 onboarding or prior T2/T3 learning). Never auto-learn virgin modules.
3. **Learn auto toggle**: `flow/.flowconfig` key `learn_auto` (default: true). Disable with `/flow learn_auto=false`.
4. **Per-session budget**: Default 10 auto re-learns per session. Deliberate learning (T1 onboarding, T2 manual, T3 run-release) does NOT count against budget. Configured via `flow/.flowconfig` key `max_learn_auto_per_session` (range: 1–unlimited).
5. **Not in-flight for any run**: Use `isModuleInPlay` (from run-triggers) to ensure the module is not currently touched by an active `/execute-plan` run (pause-during-runs rule — wait until the run releases the module via `module_completed` entry).

**Trigger ladder** (in priority order; whichever fires first enqueues re-learn):

| Trigger | Deliberate | Type | Condition |
|---------|-----------|------|-----------|
| Manual `/learn` | Yes | T2 | User clicks Learn button or runs CLI command; bypasses all gates |
| `module_completed` from rounds | Yes | T3 | Phase completes and releases the module (`flow/.rounds.jsonl` entry); enqueues immediately, subject to gates |
| `archive_sweep` from rounds | Yes | T3 | Plan archive sweep; enqueues for every touched module, subject to gates |
| Idle + stale + meaningful diff | No | T3 | 12-min idle after staleness detected; subject to all gates including budget |

**Gates apply to rows 2-4 (T3 auto-only).** Manual `/learn` (row 1) never consults gates — deliberate action, always runs immediately.

---

## The Staleness Authority: `blueprint stale-check`

**Command**: `planflow-ai blueprint stale-check [--module <m>] [--json]`

**What it does**:

1. Reads `flow/brain/.structure/learning-state.jsonl` (or returns empty report if missing)
2. For each 'learned' entry (or just the named module if `--module` is set):
   - Re-computes the hash of each file stamped in the corresponding investigation note
   - Compares against the stored stamp hash
   - Reports any file whose hash changed or which no longer exists
3. Returns a JSON report (with `--json`):
   ```json
   {
     "checked": 2,          /* modules checked */
     "fresh": 1,            /* modules with no drift */
     "stale": [
       {
         "fingerprint": "...",
         "anchors": [...],
         "changedFiles": ["src/cli/blueprint/index.ts"],
         "missingFiles": []
       }
     ]
   }
   ```

**Authority**: This is the ONLY staleness source of truth. The app's learn-triggers spawn it to detect drift; the board caches the learning-state entries but queries `stale-check` when the user opens a module's popover (no stale-check cached in memory — always fresh). The CLI can be called ad-hoc to audit staleness.

**Fail-soft**: A missing store, corrupt JSON, or unreadable stamped files return a report with those entries marked stale (conservative — missing/unreadable = stale).

---

## Learning-State Lifecycle

### Entry Statuses

| Status | Meaning | When Set | When Cleared |
|--------|---------|----------|--------------|
| `learning` | Module is currently being learned by an in-flight Learn session | T1 onboarding starts / T2 `/learn` starts / T3 re-learn starts | Agent completes (status → `learned` or removed on failure) |
| `learned` | Module has been successfully analyzed; investigations note exists and is stamped | Learn completes successfully | Never (persists until superseded or re-learned) |
| `stale` | Module's stamped files have drifted; code has changed but learning note hasn't been refreshed | `blueprint stale-check` detects drift | Auto re-learn completes (→ `learned`) or user manually re-learns (→ `learned`) |

### Transitions

```
     [T1 onboarding starts]
              ↓
        [learning]
             / \
            /   \
       [OK] / \ [error]
          /     \
      [learned] [removed]
         ↓
    [files change] ← source-file event → 12-min idle → stale-check
         ↓
      [stale]
         ↓
    [T3 re-learn triggered]
         ↓
    [learning]
         ↓
      [learned] or [removed on error]
```

---

## Outputs & Artifacts

### Documentation File

**Path**: `flow/brain/modules/<slug>.md`

**Format**: Markdown, Obsidian-compatible. One file per module.

**Naming**: `<slug>` is the URL-safe module path (e.g., `src-cli-blueprint` for `src/cli/blueprint`).

**Invariants contract (#898)**: every learned doc ends with a `## Invariants` section — bulleted, one testable invariant per bullet, each naming the file(s) it was verified against in backticks where possible; a doc with nothing to assert carries exactly `- (none observed)`. The section is parsed by ONE code path (`app/src/main/learn/invariants.ts` — allowed-pattern #14) and feeds the background invariant checker during review. Legacy docs without the section are tolerated: the parser reports `present: false` and the review surface shows "no invariants learned yet" until the module is re-learned.

**Content** (generated by Learn agent):
- Module purpose and responsibility (1–3 sentences)
- Key exports (list)
- Integration patterns (what imports this module, what it depends on)
- Internal patterns and conventions observed
- Known gotchas or important implementation details

**Lifecycle**:
- **Precious**: Never auto-deleted; user owns the content. `/learn` supersedes the prior version with a fresh analysis, but old notes remain in investigations.jsonl.
- **Discoverable**: Indexed by the brain query system; CLI commands and chat can reference it.

### Investigation Note

**Written via**: `planflow-ai blueprint observe --anchor module:<name> --note "<summary>" --hash-stamp <files>`

**Schema** (in `flow/brain/.structure/investigations.jsonl`, append-only):

```json
{
  "fingerprint": "<type>+<text>+<sorted anchor refs>",
  "anchorRefs": ["module:src/cli/blueprint"],
  "summary": "Brief module purpose — 200 char cap",
  "provenance": "learn:module (or learn:onboarding)",
  "ts": "ISO 8601 timestamp",
  "stamps": { "src/cli/blueprint/index.ts": "<hash>", ... }
}
```

**Stamping**: The executor computes SHA256 hashes of each analyzed file and includes them in the `stamps` field. The `blueprint stale-check` command re-computes these hashes to detect drift.

---

## Config & Toggles

All settings live in `flow/.flowconfig`:

| Key | Type | Default | Effect |
|-----|------|---------|--------|
| `learn_auto` | bool | `true` | Enable/disable T3 auto re-learning (staleness-triggered) |
| `max_learn_auto_per_session` | int | `10` | Max auto re-learn operations per session (manual/deliberate do not count) |
| `learn_module_cache_ttl_ms` | int | `5000` | (Phase 9+) Time-to-live for module stale-check cache on the board; after this, next popover re-queries |

**Reset defaults**: `/flow learn_auto=true max_learn_auto_per_session=10`

---

## The Learn Orchestrator (Phase 8 Wiring)

The **learn-orchestrator** (main-side) is the central queue and executor:

1. **Enqueue API**: `enqueueModule(module, deliberate, reason)`
   - Dedupes (same module enqueued twice collects into one queue entry)
   - Flags whether the learn is deliberate (manual / T1 onboarding / run-release) or auto (T3 idle)

2. **Serial execution** (within each session):
   - Pop the next module from the queue
   - Check gates (if auto)
   - Spawn a CAGED agent session with the module's source file list
   - Agent returns markdown doc + note metadata
   - Executor writes to disk (learning-state + module doc)
   - Proceed to next module

3. **Coordination with runs**: `isModuleInPlay` (from run-triggers) prevents auto re-learn of modules currently touched by an active `/execute-plan`. Deliberate re-learns (manual or run-release) enqueue regardless.

---

## Board Integration

### The Learn Dot, on a Cell

Every cell on the feature map's Territory sheet — and every module card on the code map — carries the same learn dot on its kicker row, in the same four states and the same hues (`fb-learn-*`, one vocabulary, two surfaces):

| Dot State | Meaning | Learning-State Entry |
|-----------|---------|----------------------|
| None (hollow dot) | Never learned | Absent |
| Pulsing (animated) | Learning in progress | `status: 'learning'` |
| Filled (solid dot) | Learned and current | `status: 'learned'` |
| Amber (solid, warning color) | Learned but stale | `status: 'stale'` |

While an understand pass is running, the cell it is about wears the in-flight mark and the dot steps aside; an ancestor of that cell wears the weaker *within* mark, so a country never reads as the province being drawn.

### The Learning Lens

The lens is a **line at the foot of a cell, never a fill**. A filled cell would claim the *feature* is understood, which is a different and much larger claim than the one the data supports: the line is about how much of the cell's own file coverage has been read. It is a toggle on the feature map, off by default, and it decorates the sheet in place rather than replacing it.

### The Percentage Dial

Beside the figure in the title strip sits a sixty-tick dial: filled ticks in the in-progress tint over a dim-ink track, and a figure that is hidden when there is nothing to report (a node with no parts shows ticks and no number rather than a 0% it cannot stand behind). Sixty ticks so one part landing out of forty moves it.

**One number, three places.** The dial, the title strip's figure and the learning headline all report the same percentage from the same computation (`progressFor` / `computeLearnProgress`) — never three independent counts that can disagree.

### The Features Bar and the Ground Block

The learning panel carries a second progress bar under the modules one — the **Features bar** — reusing the same treatment and `progressbar` role because the two are comparable measurements; only the LABEL differs. It counts through `understoodFraction`, the same counter the title strip and the dial ask, and is null (not 0%) when nothing can be counted.

A cell's popover carries the **Ground block**: the module files under this node and how much of that ground is learned, with a per-row Learn that enqueues through the same act the panel's own Learn performs. It is offered only when the lens already holds the files, so opening a popover never spawns a CLI.

### Popover Understanding Section

Click a module card on the code map (or drill to a module, then click its card) → popover opens → "Understanding" section displays:

- **Summary**: First line of the investigation note (200 char cap) or "Not yet documented"
- **Doc link**: Clickable link to `flow/brain/modules/<slug>.md` (disabled if no doc)
- **Actions**:
  - **Learn**: Re-learns the module (deliberate, bypasses gates, updates doc + note)
  - **Re-Learn**: (shown when status is 'stale') Same as Learn, but labeled to indicate a refresh

---

## Run Integration (Phase 9)

Execute-plan emits two **module-release** entries to `flow/.rounds.jsonl`:

### `module_completed` Entry

**When**: The last phase touching a given module completes.

**Shape**:
```json
{
  "type": "module_completed",
  "run_id": "...",
  "module": "src/cli/blueprint"
}
```

**Effect**: Run-triggers read this and enqueue a deliberate re-learn (subject to gates).

### `archive_sweep` Entry

**When**: Plan archive (end of execute-plan, after all phases complete).

**Shape**:
```json
{
  "type": "archive_sweep",
  "run_id": "...",
  "modules": ["src/cli/blueprint", "app/src/main/"]
}
```

**Effect**: Run-triggers enqueue deliberate re-learn for every module the run touched (subject to gates).

**Rationale**: Ensures that even if a module was touched by multiple phases with overlapping completions, the `archive_sweep` safety net fires at least once per run to offer re-learning.

---

## Snapshot & Inheritance

When the board reads a blueprint snapshot, the `learning` field (of type `BlueprintLearningEntry[]`) projects the deduped learning-state entries. The board uses these to:

1. Compute the corner dot state per module
2. Pre-populate the popover summary (no stale-check re-query needed until user opens)
3. Feed the story layer (learned modules linked in narrated stories)

The investigations snapshot also includes a `stale` boolean per note (computed via module-name join against learning-state) — cheap join in the app, no re-hashing.

---

## Graphify Integration

When graphify is enabled (Phase 9+ wiring), its extracted module nodes feed T0 structure. Progressive Learning always works with the union of native extractors + graphify backbone:

- **T0 structure** includes graphify-synthesized modules (modules inferred from dependency edges)
- **T1 onboarding sweep** learns both extracted + synthesized modules
- **T2/T3 learn** work on any module in the effective blueprint graph

No special graphify integration in learning-state or learn-triggers — the orchestrator consults the current graph and learns what's there.

---

## Failure Modes & Recovery

### Agent Crashes Mid-Learn

**Behavior**: Learn session times out or the agent process crashes.

**Recovery**: Orchestrator logs the failure, removes the `learning` entry from learning-state (or marks it `failed` if the architecture evolves), and escalates to the user. Manual re-learn can retry.

### Stale-Check Fails to Spawn

**Behavior**: `blueprint stale-check --module` exits with error or produces invalid JSON.

**Recovery**: Learn-triggers log and skip the module (do not append a `stale` entry). The module's dot stays unchanged. Next idle period retries.

### Learning-State File Corruption

**Behavior**: The `.jsonl` is partially written or corrupt.

**Recovery**: `readLearningState` skips corrupt lines (fail-soft), dedupes survivors, and proceeds. The reader never throws. On next write (new learn or stale-check), the full rewrite via temp+rename overwrites the corrupt data.

### Orphaned `learning` Entries After Crash

**Behavior**: A session crashes with a module stuck in `learning` state.

**Recovery**: On app restart, the orchestrator reads learning-state and finds the orphaned entry. It resets the entry to absent or `failed` (decision pending) and allows the next learn to proceed. User can manually retry via `/learn`.

---

## Budgeting & Rate Limits

**Per-session auto-learn budget** (T3 only):
- Default: 10 auto re-learn operations per app session
- Configured via `flow/.flowconfig` key `max_learn_auto_per_session`
- Counter increments only on auto re-learn completion (success or failure counts equally)
- Manual `/learn` and deliberate (run-release) do NOT count

**Rationale**: Prevent runaway learning in busy development sessions without blocking deliberate learning or run-triggered updates.

**Exceeded budget**: When the budget is hit, the orchestrator stops enqueuing auto re-learns for the remainder of the session. A toast notification informs the user; `/learn` commands and run-release still work.

---

## Rules & Invariants

> **THE WRITE RULE**: The `learning-state` module is the SINGLE writer to `flow/brain/.structure/learning-state.jsonl`. All other code that wishes to update learning state must call `writeLearningState()` (or the wrapper API on the learn-orchestrator). No direct file writes.

---

| Invariant | Enforcement | Reason |
|-----------|-------------|--------|
| One writer, atomic commits | Code: `learning-state.ts` enforces temp+rename | Prevent readers from observing half-written state |
| Dedup by module, latest per module | Code: `dedupLearningEntries` in `learning-state.ts` | Multiple sources (T1, T2, T3) may update same module; dedupe ensures deterministic sort and unique status per module |
| Status ∈ {learning, learned, stale} | Code: `LEARNING_STATUSES` enum checked on parse + write | Prevents typos and invalid states from corrupting the store |
| Staleness is hash-based, not mtime-based | Code: `blueprint stale-check` (P4 authority); always re-hashes | Uncommitted edits drift the file without moving mtime; only content hash is reliable (see forbidden-pattern #10) |
| Never auto-learn virgin modules | Code: `previouslyLearned` gate checked before T3 auto-enqueue | Protect against learning modules that the user intentionally left undocumented |
| Pause during runs | Code: `isModuleInPlay` checked in learn-triggers (run-triggers emits phase_result anchors) | Prevent race conditions where learning snapshot is taken while phases still write to the module |
| Investigation notes are append-only; supersede via flag | Code: `blueprint observe --supersede-with-reason`; old note stays untouched | Preserve audit trail of learning history; never rewrite or delete |

---

## Edge Cases

### Module Renamed or Moved

**Behavior**: A module's path changes in the graph (e.g., `src/cli` → `src/cli/blueprint` split).

**Effect**: 
- Old learning-state entries and old investigation notes remain under the old module name (append-only)
- New module has no learning-state entry (T0 structure reports it)
- T1 onboarding or `/learn` on the new module creates fresh learning

**Recovery**: Manual cleanup — user can `/learn` the new module, and old notes remain as historical records.

### Module Deleted

**Behavior**: A module disappears from the repo.

**Effect**:
- Learning-state entry persists (append-only; read-time filters handle absence)
- Investigation notes remain (append-only)
- Board does not render the module (it's not in the graph)
- `blueprint stale-check --module <deleted>` skips it gracefully

**No action needed**: Learning-state does not auto-prune; it is a mirror of graph history.

### Bulk Code Refactor (High Churn, Many Modules Affected)

**Behavior**: A refactor touches 50 modules, marking all as stale.

**Effect**:
- Learn-triggers detect 50 staleness entries → 50 modules enqueued for auto re-learn
- Budget constraint: only the first 10 (default) proceed in the session
- Remaining 40 stay enqueued but do not run (progress toast shows "10 of 50 planned")

**Recovery**: Manual `/learn <module>` for specific modules, or raise budget via `/flow max_learn_auto_per_session=50` before the next idle stale check.

---

## See Also

- `.claude/resources/core/auto-provisioning.md` — T1 onboarding provisioning readiness and the basic_discovery_answer consent.
- `.claude/resources/core/blueprint.md` — Investigation store, `blueprint observe`, and investigations.jsonl lifecycle.
- `.claude/resources/skills/execute-plan-skill.md` — `module_completed` and `archive_sweep` rounds entries emitted by execute-plan.
