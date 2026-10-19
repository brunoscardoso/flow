
# Phase Isolation

## Purpose

When `phase_isolation: true` in `flow/.flowconfig` (default), each `/execute-plan` phase implementation runs in an **isolated Agent sub-agent** with a clean context window. The sub-agent receives only the context it needs and returns a structured JSON summary. This eliminates context rot — phase 7 has the same quality as phase 1.

**Core principle**: Clean context in, structured summary out.

### Per-Task Verification

Phase sub-agents support **per-task verification** when plan tasks include `<verify>` tags. After completing each task, the sub-agent runs the verification command and, on failure, spawns a debug sub-agent (haiku) for diagnosis and repair. See `.claude/resources/core/per-task-verification.md` for the complete verification system, debug sub-agent prompt template, JSON schemas, and configuration.

---

## Architecture

### Sequential Mode (default)

```
Coordinator (main session)
    │
    ├─ Present phase in Plan Mode → User approves
    │
    ├─ Prepare isolated context (see Context Template below)
    │
    ├─ Spawn Agent sub-agent:
    │   model: [tier from model routing]
    │   mode: "auto"
    │   prompt: [focused context + instructions + return format]
    │
    ├─ Receive structured JSON summary (1-2K tokens)
    │
    ├─ Process summary:
    │   ├─ Update plan file (mark tasks [x])
    │   ├─ Accumulate files_modified list
    │   ├─ Append patterns to pending-patterns.md
    │   ├─ Git commit (if enabled)
    │   └─ Handle errors (present to user if status != success)
    │
    └─ Next phase...
```

### Wave Mode (when `wave_execution: true`)

```
Coordinator (main session)
    │
    ├─ For each Wave:
    │   │
    │   ├─ Approve each phase sequentially in Plan Mode
    │   │
    │   ├─ Prepare isolated context for EACH phase in the wave
    │   │
    │   ├─ Spawn MULTIPLE Agent sub-agents IN PARALLEL:
    │   │   ├─► Agent: Phase A  (model: [tier_A], prompt: phase_A_context)
    │   │   ├─► Agent: Phase B  (model: [tier_B], prompt: phase_B_context)
    │   │   └─► Agent: Phase C  (model: [tier_C], prompt: phase_C_context)
    │   │
    │   ├─ Wait for ALL sub-agents to complete
    │   │
    │   ├─ Collect JSON returns from all sub-agents
    │   │
    │   ├─ Post-wave processing (sequential, in phase order):
    │   │   ├─ Detect file conflicts (files_modified overlap)
    │   │   ├─ Process each phase result
    │   │   ├─ Update plan file (mark tasks [x])
    │   │   ├─ Accumulate files_modified list
    │   │   ├─ Buffer patterns from all phases
    │   │   ├─ Git commit sequentially (Phase A, then B, then C)
    │   │   └─ Handle failures (present to user)
    │   │
    │   └─ Next Wave...
    │
    └─ Completion summary with wave execution stats
```

Planning and user approval always happen in the **main session** (full context). Only the **implementation step** is isolated.

---

## COR-PI-2: Context Template

The Agent sub-agent prompt must include exactly these sections:

```markdown
# Phase Implementation: {Phase N — Phase Name}

## Plan
**Feature**: {feature name}
**Plan file**: {path to plan file}

## Intent
{The plan's `## Intent` block (Goal / Constraints / Ruled Out), injected verbatim}
{If the plan has no `## Intent` block, omit this entire section}

## Trust Tiers
{The canonical block from .claude/resources/core/trust-tiers.md — ALWAYS included, verbatim}

## Brain-First Retrieval
{The canonical block from .claude/resources/core/brain-first.md — ALWAYS included, verbatim}

## Phase Scope
{Scope description from plan}

## Tasks
{Task list from plan, as checklist}

## Files Modified in Previous Phases
{List of file paths created/modified so far, or "None — this is Phase 1"}

## Project Patterns
Apply the following rules. If their current contents are already supplied to this agent
as effective instructions, use that content and do not read them again.
Otherwise, read each missing file before implementing:
- `.claude/rules/core/allowed-patterns.md`
- `.claude/rules/core/forbidden-patterns.md`

## Evidence
Evidence directory: flow/.evidence/{run-id}/ — write per-task evidence there per `.claude/resources/core/per-task-verification.md`

## Design Context
{Only if UI phase — include design tokens from discovery doc}
{Otherwise omit this section entirely}

## Shared Context from Sibling Phases

{Only included for multi-phase waves. Omitted for single-phase waves and sequential execution.}

The following contracts, decisions, and progress updates were emitted by other phases running in parallel with yours. Use these to inform your implementation:

{Injected context entries as formatted text}

**Instructions**:
- Before each task, review shared context entries for relevant contracts or decisions
- If a sibling phase defined an API endpoint you consume, match its signature exactly
- If a sibling phase made an architectural decision, follow it for consistency
- If you define a new API endpoint, type interface, or make an architectural decision, include it in your `context_entries` return array

## Commit Instructions
{Only include this section when `commit: true` in `.flowconfig`}

### Sequential Mode (wave_execution: false)
- After each task completes and verification passes (if applicable):
  1. Stage changed files: `git add -A`
  2. Create atomic commit: `git commit -m "feat(phase-N.task-M): <truncated description> — <feature>"`
     - Use format: feat(phase-{phase_number}.task-{task_number_in_phase}): <description> — <feature>
     - Truncate description to 50 chars (use ellipsis if truncated)
     - Task numbers are 1-indexed within each phase
  3. Continue to next task
- Return `tasks_completed` array in JSON with files_created/files_modified per task
- Do NOT create a final phase commit (coordinator will not create one either)

### Wave Mode (wave_execution: true)
- Do NOT create any commits during task implementation
- The coordinator will commit your changes after this wave completes
- Return `tasks_completed` array with per-task file lists (see Return Format below)
- Coordinator will iterate tasks and commit: feat(phase-N.task-M): ... per task

## Instructions
1. Read the plan file to understand the full feature context
2. Implement all tasks listed above
3. Follow the project patterns supplied or loaded under Project Patterns
4. After completing each task, check if it has a `<verify>` tag indented beneath it:
   - If yes: run the verification command inside the tag
   - If the command exits 0: record a pass result and continue to the next task
   - If the command exits non-zero: spawn a debug sub-agent (haiku, mode: "auto") with the error output, task context, and file content. Apply only MECHANICAL repairs from the diagnosis and re-run the verification command (up to `max_verify_retries` attempts, default 2). Withhold behavior-altering or intent-contradicting repairs: record a `failed-needs-decision` result with the `withheld_repair`, and continue to the next task — per the Repair Classification in `.claude/resources/core/per-task-verification.md`. See that file for the debug sub-agent prompt template and return schema.
   - If max retries exceeded: record a fail result and continue to the next task (do NOT abort)
   - If no `<verify>` tag: skip verification for that task
5. Return a JSON summary in the exact format below — do NOT return markdown

## Return Format
Return ONLY a JSON object (no markdown fences, no explanation):
{see Return Format Schema below}
```

### Intent Injection

When the plan file contains an `## Intent` block (Goal / Constraints / Ruled Out — see `.claude/resources/patterns/plans-templates.md`, "Intent Section"), the coordinator copies it **verbatim** into the `## Intent` section of the sub-agent prompt, placed after `## Plan` and before `## Phase Scope`. Intent lets the sub-agent — and its nested per-task repair loop — tell a deliberate decision apart from a mistake: an approach listed under "Ruled Out" must never be re-introduced as a fix or "corrected" during repairs.

**Fallback**: If the plan has no `## Intent` block, omit the section entirely. The prompt is then identical to the pre-Intent template — fully backward compatible.

### Trust Tiers Injection

Unlike `## Intent` and `## Design Context`, the `## Trust Tiers` section is **unconditional** — it is injected into every phase sub-agent prompt regardless of plan content, feature type, or gating. The coordinator copies the canonical block from `.claude/resources/core/trust-tiers.md` verbatim, placed after `## Intent` (or immediately after `## Plan` when the plan has no Intent block) and before `## Phase Scope`. This keeps the sub-agent honest about foreign documentation encountered while reading files during implementation.

### Brain-First Injection

Like Trust Tiers, the `## Brain-First Retrieval` section is **unconditional**. The coordinator copies the canonical block from `.claude/resources/core/brain-first.md` verbatim, placed immediately after `## Trust Tiers` and before `## Phase Scope`. This routes the sub-agent's orientation questions (where/who/what/how-does) through `planflow-ai brain search` before any grep-and-read spelunking; freshness flags on hits keep the shortcut safe (stale means verify against code).

### Project Pattern Loading

Verify rule delivery for the **receiving agent**, in sequential and wave modes.
Claude Code may automatically supply `.claude/rules/` as project instructions;
omit redundant reads only when the current rule contents are verified present in
that agent's effective instructions. Do not infer loading from the provider name,
a file path in a prompt, or the parent's context. Native Codex starts from
`AGENTS.md`; it must explicitly load these rules when their contents have not
been supplied. If loading is unknown or only partially supplied, retain the
explicit read for each missing file. Do not inject a second copy into the prompt
as a substitute for avoiding a Read call.

### Context Size Target

Keep the coordinator-authored prompt **under 2K tokens** where possible, including
the verbatim Intent block (150–250 tokens by design). This is a prompt-size target,
not the phase's total context budget.

Before dispatch, account for **automatic instructions + prompt + induced reads**.
Induced reads include the plan file, missing project rules, verification resources,
and other files the template directs the agent to open (including nested references).
Report each component and the total as measured tokens or clearly labeled estimates;
mark an unavailable provider baseline as unknown, never zero. Count each delivered
copy: re-reading already supplied rules costs another copy, while merely referencing
content already present does not. Include expected implementation reads separately
when estimating headroom; update the estimate from actual reads during execution.

Charge this cost for every phase and every agent in a wave, then sum it for the
run. If required instructions exceed the compact prompt target, report that cost
and trim unrelated context; do not drop required project rules to meet 2K.

### Wave Mode Context Additions

When spawning sub-agents within a wave, the context template is **identical** to sequential mode with one key difference:

- **`Files Modified in Previous Phases`**: Include files from ALL completed waves (Wave 1 through Wave N-1), not just the immediately preceding phase. This gives each sub-agent awareness of everything that changed before the current wave.

Sub-agents within the same wave do NOT receive information about each other — no cross-phase awareness. Each sub-agent operates as if it is the only phase running.

**Exception**: When shared context is available from sibling phases (via `.wave-context.jsonl`), the coordinator injects a "Shared Context from Sibling Phases" section into the context template. See below for details.

### Shared Context Injection

**When shared context is injected**:
- Multi-phase waves only (2+ phases in the same wave)
- Coordinator reads `.wave-context.jsonl` before spawning each sub-agent
- Entries from OTHER phases in the wave are injected (not the agent's own)
- Single-phase waves and sequential mode: section is omitted entirely

**When to emit context entries**:
- After implementing a task that creates or modifies an API endpoint, type interface, function signature, or makes an architectural decision
- Include in the `context_entries` array of your JSON return
- Format as ContextEntry objects (see `shared-context.md` COR-SC-2 for schema)

---

## Return Format Schema

The sub-agent must return a JSON object with this structure:

```json
{
  "status": "success",
  "phase": "Phase 1: Create Core Resource",
  "summary": "One-paragraph description of what was implemented and any notable decisions.",
  "files_created": [
    "src/types/auth.ts"
  ],
  "files_modified": [
    "src/api/routes.ts",
    "src/utils/helpers.ts"
  ],
  "decisions": [
    "Chose JWT over sessions because discovery DR-4 specified stateless auth"
  ],
  "deviations": [
    "Task 3 deferred — requires database migration first"
  ],
  "errors": [],
  "patterns_captured": [
    {
      "category": "allowed",
      "name": "Zod schema co-location",
      "description": "All Zod schemas live next to their type definitions",
      "confidence": "high"
    }
  ],
  "task_verifications": [
    {
      "task": "Create user authentication middleware",
      "verify_command": "npx tsc --noEmit src/middleware/auth.ts",
      "status": "pass",
      "attempts": 2,
      "repairs_applied": [
        "Added missing import for AuthMiddleware type"
      ],
      "tested": [
        "Type-check passes for the auth middleware",
        "Valid JWT is accepted; expired and malformed JWTs are rejected"
      ],
      "testing_summary": "Type-checked the middleware and exercised token validation against valid, expired, and malformed JWTs.",
      "artifacts": [
        { "path": "flow/.evidence/user-auth-20260705-101500/phase-2-task-1/tsc-output.txt" },
        { "content": "PASS src/middleware/__tests__/auth.test.ts — 3 tests, 0 failures" }
      ]
    },
    {
      "task": "Add rate limiting to API routes",
      "verify_command": "npx jest src/middleware/__tests__/rate-limit.test.ts --no-coverage",
      "status": "pass",
      "attempts": 1,
      "repairs_applied": []
    }
  ],
  "tasks_completed": [
    {
      "task_number": 1,
      "task_name": "Create user authentication middleware",
      "files_created": ["src/middleware/auth.ts"],
      "files_modified": []
    },
    {
      "task_number": 2,
      "task_name": "Add rate limiting to API routes",
      "files_created": ["src/middleware/rate-limit.ts"],
      "files_modified": ["src/api/routes.ts"]
    }
  ],
  "context_entries": [
    {
      "agent": "phase-N",
      "type": "contract",
      "timestamp": "ISO8601",
      "data": { "name": "GET /users", "kind": "endpoint", "signature": "GET /users → { id, name, email }", "fields": ["id", "name", "email"] }
    },
    {
      "agent": "phase-N",
      "type": "decision",
      "timestamp": "ISO8601",
      "data": { "choice": "Using Redis for session caching", "reason": "Low latency requirement" }
    }
  ]
}
```

### Field Descriptions

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `status` | `"success" \| "failure" \| "partial"` | Yes | Overall phase outcome |
| `phase` | string | Yes | Phase number and name |
| `summary` | string | Yes | 1-3 sentence description of what was done |
| `files_created` | string[] | Yes | Paths of new files created (empty array if none) |
| `files_modified` | string[] | Yes | Paths of existing files modified (empty array if none) |
| `decisions` | string[] | No | Architecture/design decisions made during implementation |
| `deviations` | string[] | No | Tasks skipped or changed from plan |
| `errors` | string[] | No | Errors encountered (even if resolved) |
| `patterns_captured` | object[] | No | Patterns observed during implementation |
| `task_verifications` | object[] | No | Array of per-task verification results. Only present when at least one task had a `<verify>` tag. Each entry contains: `task` (string), `verify_command` (string), `status` (`"pass" \| "fail" \| "failed-needs-decision"`), `attempts` (number), `repairs_applied` (string[]), and optionally `last_diagnosis` (object, only when status is not `"pass"`) and `withheld_repair` (string, only when status is `"failed-needs-decision"`). Entries may also carry three OPTIONAL evidence fields: `tested` (string[], behaviors/scenarios actually exercised), `testing_summary` (string, one-sentence prose), and `artifacts` (object[], each exactly one of `{"path": "<repo-or-evidence-relative path>"}` \| `{"url": "<externally visible url>"}` \| `{"content": "<short inline log excerpt>"}`). Absent evidence fields mean legacy pass/fail behavior — fully backward compatible. See `.claude/resources/core/per-task-verification.md` for the full schema, Evidence Directory, and Artifact Path Safety rules. |
| `tasks_completed` | object[] | No | Array of per-task file tracking for atomic commits. Each entry: `task_number` (number, 1-indexed within phase), `task_name` (string), `files_created` (string[]), `files_modified` (string[]). Present when any tasks ran. Used by coordinator for per-task commit messages. See `.claude/resources/core/atomic-commits.md` for full schema. |
| `context_entries` | object[] | No | Array of context entries emitted by this phase for sibling phases. Each entry: `agent` (string, e.g. "phase-3"), `type` (`"contract" \| "decision" \| "progress"`), `timestamp` (ISO8601 string), `data` (object with type-specific fields). Only relevant in multi-phase waves. See `.claude/resources/core/shared-context.md` COR-SC-2 for full schema. |

### Status Signal Mapping

The `status` field is a domain outcome enum and never changes. When a phase outcome is expressed in the unified signaling vocabulary (progress entries, event streams — see `.claude/resources/core/status-contract.md`), it maps as:

`success → done` · `failure → failed` · `partial → needs-decision`

### Failure Return Example

```json
{
  "status": "failure",
  "phase": "Phase 3: API Integration",
  "summary": "Failed to implement API routes. Missing dependency '@auth/core' not in package.json.",
  "files_created": [],
  "files_modified": ["src/api/auth.ts"],
  "decisions": [],
  "deviations": [],
  "errors": [
    "Cannot find module '@auth/core' — dependency not installed",
    "Partial implementation in src/api/auth.ts — needs cleanup"
  ],
  "patterns_captured": []
}
```

---

## Coordinator Processing

After receiving the sub-agent's JSON summary, the coordinator:

### On Success (`status: "success"`)

1. **Update plan file**: Mark all phase tasks as `[x]`
2. **Accumulate file list**: Merge `files_created` and `files_modified` into running list
3. **Buffer patterns**: Append `patterns_captured` entries to `flow/resources/pending-patterns.md`
4. **Git commit (per-task)**: If `commit: true` and `tasks_completed` is present:
   - **Sequential mode**: Sub-agent already created per-task commits — verify they exist, do NOT create phase commit
   - **Wave mode**: Coordinator iterates `tasks_completed` in task_number order and creates per-task commits:
     - For each task: `git add -A && git commit -m "feat(phase-N.task-M): <truncated task_name> — <feature>"`
     - Truncate `task_name` to 50 chars if needed
   - **Fallback**: If `tasks_completed` is absent (legacy sub-agent), fall back to single phase commit: `git add -A && git commit -m "Phase N: {name} — {feature}"`
5. **Log decisions**: Include `decisions` in phase completion message
6. **Display verification results**: If `task_verifications` is present, show pass/fail counts and any repairs applied
7. **Proceed**: Move to next phase

### On Failure (`status: "failure"`)

1. **Present error**: Show `errors` array to user
2. **Show partial work**: List `files_modified` so user knows what was touched
3. **Ask user**: "Phase failed. Options: (1) Retry phase, (2) Skip and continue, (3) Stop execution"
4. **Do NOT auto-retry**: Let user decide

### On Partial (`status: "partial"`)

1. **Present summary**: Show what was completed and what wasn't
2. **Show deviations**: List `deviations` explaining what was skipped
3. **Display verification failures**: If `task_verifications` contains failed entries, show task name, last diagnosis, and repair attempts
4. **Ask user**: "Phase partially complete. Continue to next phase or retry remaining tasks?"

---

## Wave Coordinator Processing

When multiple sub-agents return simultaneously from a wave, the coordinator handles them differently from sequential mode. See `.claude/resources/core/wave-execution.md` for the full wave system and `.claude/resources/skills/execute-plan-skill.md` Step 4c for the detailed processing flow.

**Per-task commits in wave mode**: After collecting all JSON returns from a wave, the coordinator commits per-task (not per-phase). For each phase in phase-number order, iterate `tasks_completed` and create atomic commits: `feat(phase-N.task-M): <desc> — <feature>`. See `.claude/resources/core/atomic-commits.md` for the complete commit format and coordinator processing rules.

### Collecting Multiple JSON Returns

After all sub-agents in a wave complete, the coordinator collects all JSON returns before processing any of them. This allows file conflict detection before committing.

### Processing Order

Results are always processed **sequentially in phase number order**, regardless of which sub-agent finished first. This ensures:
- Deterministic commit history (Phase A committed before Phase B)
- Predictable plan file updates
- Consistent file accumulation order

### File Conflict Detection

After collecting all wave results, check for `files_modified` overlap between phases:

```
For each pair of phases (A, B) in the wave:
  overlap = A.files_modified ∩ B.files_modified
  if overlap is not empty:
    → File conflict detected
```

**On conflict**: Present to user with options (accept as-is, re-run conflicting phases sequentially, or stop). Never silently resolve conflicts.

### Wave Failure Isolation

A failed phase in a wave does NOT affect other phases in the same wave:
- Successful phases are processed normally (plan updates, file accumulation, git commits)
- Failed phases are presented to the user after all successful phases are processed
- The user chooses per failed phase: retry, skip, or stop

This differs from sequential mode where a failure immediately pauses execution. In wave mode, all parallel phases complete independently before any failure handling.

---

## Aggregated Phases

When phases are aggregated (combined complexity ≤ 6), they run as **one sub-agent call** with all tasks from all aggregated phases. The context template lists all phases and tasks together. The return uses the highest phase number as the `phase` field.

In wave mode, aggregated phases within the same wave are treated as a **single unit** — they share one wave slot, one dependency set (union of all aggregated phases' dependencies), and one sub-agent call.

---

## Configuration

### `.flowconfig` Setting

```yaml
phase_isolation: true    # Run phases in isolated sub-agents (default: true)
```

- `true` (default): Each phase runs in an isolated Agent sub-agent
- `false`: Phases execute inline in the main session (legacy behavior, useful for debugging)

### Interaction with Model Routing

Phase isolation **enhances** model routing — it doesn't replace it:

| Setting | Behavior |
|---------|----------|
| `model_routing: true` + `phase_isolation: true` | Sub-agent spawned with correct tier model AND clean context |
| `model_routing: true` + `phase_isolation: false` | Sub-agent spawned with correct tier model, inherits session context |
| `model_routing: false` + `phase_isolation: true` | Sub-agent spawned with session model, clean context |
| `model_routing: false` + `phase_isolation: false` | Inline execution, no sub-agents (original behavior) |

### Interaction with Wave Execution

Phase isolation is the **foundation** for wave execution — wave mode spawns multiple isolated sub-agents per wave instead of one at a time:

| Setting | Behavior |
|---------|----------|
| `wave_execution: true` + `phase_isolation: true` | Multiple sub-agents per wave, each with clean context (optimal) |
| `wave_execution: true` + `phase_isolation: false` | Multiple sub-agents per wave, but sharing session context (may cause interference) |
| `wave_execution: false` + `phase_isolation: true` | One sub-agent at a time, clean context (existing behavior) |
| `wave_execution: false` + `phase_isolation: false` | Inline execution, no sub-agents (original behavior) |

**Recommendation**: `wave_execution: true` works best with `phase_isolation: true`. Without phase isolation, parallel sub-agents may interfere with each other's context.

---

## Rules

1. **Planning stays in session** — only implementation is isolated
2. **Compact prompts, full accounting** — target under 2K prompt tokens and count automatic instructions plus induced reads in the phase budget
3. **JSON return only** — no markdown in the return, pure JSON
4. **Coordinator validates** — check status field before proceeding
5. **Never auto-retry** — on failure, present to user and ask
6. **Pass paths for missing content** — reuse verified supplied rules; read only missing files and count those reads
7. **Each phase gets own sub-agent** — even in wave mode, phases are never merged into one sub-agent (except for aggregated phases per complexity rules)
8. **No cross-wave awareness** — sub-agents in the same wave know nothing about each other unless shared context entries are injected from `.wave-context.jsonl`
9. **Deterministic processing** — wave results are always processed in phase number order
10. **Collect before commit** — in wave mode, all JSON returns are collected before any commits happen
11. **Verification is internal** — per-task verification loops run inside the phase sub-agent; the coordinator sees only the final `task_verifications` results

---

## Related Files

| File | Purpose |
|------|---------|
| `.claude/resources/core/wave-execution.md` | Full wave-based parallel execution system |
| `.claude/resources/core/model-routing.md` | Model tier selection per phase complexity |
| `.claude/resources/core/discovery-sub-agents.md` | Parallel spawning pattern reference |
| `.claude/resources/core/per-task-verification.md` | Per-task verification system, debug sub-agent, and repair loops |
| `.claude/resources/core/shared-context.md` | Shared context schema, JSONL format, and coordinator injection rules |
| `.claude/resources/core/status-contract.md` | Unified status signal vocabulary and the phase status mapping |
| `.claude/resources/skills/execute-plan-skill.md` | Execute-plan skill with wave integration (Steps 2b, 3, 4) |
