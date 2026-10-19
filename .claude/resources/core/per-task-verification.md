
# Per-Task Verification

## Purpose

When a plan phase includes tasks with `<verify>` tags, the phase isolation sub-agent runs **targeted verification immediately after each task completes**. If verification fails, a nested debug sub-agent diagnoses the failure and the implementation sub-agent applies repairs. This catches errors at the task level instead of waiting for the final build+test step.

**Core principle**: Verify early, diagnose fast, repair in place.

---

## Architecture

```
Phase Sub-Agent (isolated)
    │
    ├─ Task 1: Implement
    │   ├─ Complete task implementation
    │   ├─ Parse <verify> tag → extract command
    │   ├─ Run verification command
    │   ├─ ✅ Pass → record result, move to Task 2
    │   └─ ❌ Fail → enter verification loop:
    │       │
    │       ├─ Spawn debug sub-agent (haiku):
    │       │   Input: error output + task context + file content
    │       │   Output: JSON diagnosis (root cause, repair actions)
    │       │
    │       ├─ Apply repair actions
    │       ├─ Re-run verification command
    │       ├─ ✅ Pass → record result (with repair info), move to Task 2
    │       ├─ ❌ Fail → retry (up to max_verify_retries)
    │       └─ ❌ Max retries exceeded → record failure, escalate to user
    │
    ├─ Task 2: Implement (no <verify> tag → skip verification)
    │
    ├─ Task 3: Implement
    │   ├─ Complete task implementation
    │   ├─ Parse <verify> tag → extract command
    │   └─ Run verification → ✅ Pass
    │
    └─ Return JSON (includes task_verifications array)
```

Verification is **internal to the phase sub-agent**. The wave coordinator and main session see only the final JSON return with verification results — they never interact with the verification loop directly.

---

## Verify Tag Syntax

### Declaration in Plans

Tasks in a plan phase can include an optional `<verify>` tag indented under the task:

```markdown
### Phase 2: API Integration

**Scope**: ...
**Complexity**: 5/10
**Dependencies**: Phase 1

- [ ] Create user authentication middleware in `src/middleware/auth.ts`
  <verify>npx tsc --noEmit src/middleware/auth.ts</verify>
- [ ] Add rate limiting to API routes
  <verify>npx jest src/middleware/__tests__/rate-limit.test.ts --no-coverage</verify>
- [ ] Update configuration constants
```

### Parsing Rules

1. **Tag format**: `<verify>COMMAND</verify>` on a single line, indented under a task
2. **One verify per task**: Only the first `<verify>` tag under a task is used; additional tags are ignored
3. **Command content**: The text between tags is executed as a shell command by the sub-agent
4. **No verify = no verification**: Tasks without `<verify>` tags skip verification entirely (backward compatible)
5. **Whitespace**: Leading/trailing whitespace inside the tag is trimmed
6. **Nesting**: The `<verify>` tag must be indented under its parent task (2+ spaces or 1+ tab)

### Recommended Verification Commands

| Task Type | Verify Command | Purpose |
|-----------|---------------|---------|
| File creation (TypeScript) | `npx tsc --noEmit <file>` | Type-check the new file |
| Test writing | `npx jest <test-file> --no-coverage` | Run the specific test |
| Schema/type changes | `npx tsc --noEmit <type-file>` | Verify type consistency |
| Config changes | *(no verify)* | Manual review preferred |
| Documentation | *(no verify)* | No automated check available |

**Constraint**: Verification commands must be **targeted** (single file or small scope). Never use full builds (`npm run build`) or full test suites (`npm test`) as verify commands — those run in the final Step 7.

---

## Debug Sub-Agent

### When to Spawn

A debug sub-agent is spawned when a verification command returns a **non-zero exit code**. The sub-agent diagnoses the failure and suggests repair actions.

### Prompt Template

```markdown
# Debug Diagnosis

## Failed Verification
**Task**: {task description}
**Command**: {verify command}
**Exit Code**: {exit code}

## Intent
{The plan's `## Intent` block (Goal / Constraints / Ruled Out), injected verbatim}
{Omit this entire section if the plan has no `## Intent` block}

## Error Output
```
{stderr + stdout from the failed command, truncated to 200 lines}
```

## Task Context
**File**: {primary file being modified}
**Phase**: {phase name}
**What was implemented**: {brief description of what the task did}

## File Content
```
{content of the primary file, truncated to 300 lines}
```

## Instructions
Analyze the error output and diagnose the root cause. Return a JSON object with your diagnosis and suggested repair actions. Do NOT fix the code — only diagnose.

If an Intent block is present, use it to tell a deliberate decision apart from a mistake: never suggest a repair that re-introduces an approach listed under "Ruled Out", contradicts a stated constraint, or removes code the Intent shows is deliberate.

Return ONLY a JSON object (no markdown fences):
{see Debug Return Schema below}
```

### Debug Return Schema

```json
{
  "root_cause": "Missing import for AuthMiddleware type used on line 15",
  "category": "import_missing",
  "repair_actions": [
    "Add import { AuthMiddleware } from '../types/auth' to src/middleware/auth.ts"
  ],
  "confidence": "high",
  "file_to_fix": "src/middleware/auth.ts"
}
```

### Field Descriptions

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `root_cause` | string | Yes | Human-readable description of what went wrong |
| `category` | string | Yes | Error category: `import_missing`, `type_error`, `syntax_error`, `runtime_error`, `test_failure`, `config_error`, `other` |
| `repair_actions` | string[] | Yes | Ordered list of specific actions to fix the issue |
| `confidence` | `"high" \| "medium" \| "low"` | Yes | How confident the diagnosis is |
| `file_to_fix` | string | Yes | Primary file that needs modification |

### Sub-Agent Configuration

- **Model**: Always uses haiku (fast tier) — diagnosis is a focused, low-complexity task
- **Mode**: `"auto"`
- **Read-only**: The debug sub-agent does NOT modify files — it only returns a diagnosis. The implementation sub-agent applies the repairs.

---

## Verification Loop

### Flow

```
1. Complete task implementation
2. Parse <verify> tag → extract command
3. Run command
4. If exit code == 0 → PASS (record result, continue)
5. If exit code != 0:
   a. Increment retry counter
   b. If retry counter > max_verify_retries → ESCALATE (record failure)
   c. Spawn debug sub-agent with error context (+ Intent block, if present)
   d. Receive JSON diagnosis
   e. Classify repair actions (see Repair Classification below):
      - Mechanical → apply per the Fix-Pass Rules
      - Behavioral → do NOT apply; record outcome failed-needs-decision, stop retrying, continue to next task
   f. Re-run verification command → go to step 4
```

### Repair Classification

Before applying any repair action, classify it. This mirrors the review Action Classification taxonomy in `.claude/resources/core/review-multi-agent.md` (mechanical repairs sit in auto-fix territory; behavior/intent repairs sit in ask-user territory) — reference that taxonomy's language, do not redefine it here.

| Classification | Covers | Behavior |
|----------------|--------|----------|
| **Mechanical** | Build errors, type errors, test wiring, lint issues, missing imports | Apply as today — apply the repair, re-run verification |
| **Behavioral** | Repairs that would alter product behavior, remove intentional code, or contradict the plan's `## Intent` block | Do NOT apply. Record the task with outcome `failed-needs-decision` and stop retrying |

**When in doubt, withhold the repair** (treat it as behavioral) — consistent with the review taxonomy's "when in doubt, default to ask-user".

`failed-needs-decision` is not a new escalation path — it **reuses the existing max-retries escalation path**: the sub-agent records the outcome in `task_verifications` (with the last diagnosis and the withheld repair), continues to the next task, sets phase status to `"partial"`, and the coordinator presents it to the user with the diagnosis **and why the repair was withheld**.

### Fix-Pass Rules

When applying repair actions, the implementation sub-agent MUST follow these rules:

1. **Always start by double-checking whether the diagnosis/finding is legitimate** — a diagnosis can be wrong; verify it against the actual code and error output before acting
2. **Prefer the smallest correct root-cause fix** — no drive-by refactoring, no scope expansion
3. **Never resolve a failure by removing or reverting the author's intentional changes** unless it is a genuine correctness/reliability/security issue
4. **When in doubt, leave it unresolved and report** — record `failed-needs-decision` rather than guessing
5. **Do not add code comments explaining fixes**

### Retry Behavior

- **Retry counter**: Starts at 0, increments on each failed verification attempt
- **First attempt**: The initial verification run does NOT count as a retry
- **Max retries**: Controlled by `max_verify_retries` in `.flowconfig` (default: 2)
- **Example with default**: Initial attempt + 2 retries = 3 total verification runs maximum

### Escalation on Max Retries

When max retries are exceeded — or a behavioral repair is withheld (`failed-needs-decision`) — the sub-agent:

1. Records the verification outcome in the `task_verifications` array (`"fail"` or `"failed-needs-decision"`)
2. Includes the last debug diagnosis in the record (plus the withheld repair, for `failed-needs-decision`)
3. Continues to the next task (does NOT abort the phase)
4. Sets overall phase `status` to `"partial"` if any task verification did not pass

The coordinator presents the failure to the user with the accumulated diagnosis:

```markdown
⚠️ Task verification failed after 2 retries:

**Task**: Create user authentication middleware in `src/middleware/auth.ts`
**Command**: `npx tsc --noEmit src/middleware/auth.ts`
**Last diagnosis**: Missing type export from @auth/core — dependency may need updating
**Category**: import_missing

Options:
1. Continue with remaining phases (issue noted)
2. Stop and fix manually
```

For `failed-needs-decision`, the presentation is the same shape but explicitly states that the repair was withheld to protect intent, and offers decision options:

```markdown
⚠️ Task verification failed — repair withheld to protect intent:

**Task**: Create user authentication middleware in `src/middleware/auth.ts`
**Command**: `npx jest src/middleware/__tests__/auth.test.ts --no-coverage`
**Diagnosis**: Test expects legacy session flow; implementation deliberately uses JWT
**Withheld repair**: Reverting to session-based auth — contradicts the plan's Intent (sessions are listed under Ruled Out)

Options:
1. Apply the repair anyway
2. Fix manually
3. Skip (continue with remaining phases, issue noted)
```

---

## Task Verifications Return Field

### Schema Extension

The phase isolation JSON return format is extended with an optional `task_verifications` array:

```json
{
  "status": "success",
  "phase": "Phase 2: API Integration",
  "summary": "Implemented auth middleware and rate limiting. One task required type import repair.",
  "files_created": ["src/middleware/auth.ts"],
  "files_modified": ["src/api/routes.ts"],
  "decisions": [],
  "deviations": [],
  "errors": [],
  "patterns_captured": [],
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
  ]
}
```

The first entry above shows the optional evidence fields populated; the second is a legacy pass/fail entry without them — both are valid (evidence fields are fully optional and backward compatible).

### Task Verification Entry Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `task` | string | Yes | Short description of the task (from plan) |
| `verify_command` | string | Yes | The verification command that was run |
| `status` | `"pass" \| "fail" \| "failed-needs-decision"` | Yes | Final verification outcome. `failed-needs-decision` = a repair existed but was withheld because it would alter product behavior, remove intentional code, or contradict the plan's Intent block (see Repair Classification) |
| `attempts` | number | Yes | Total verification attempts (1 = passed first try) |
| `repairs_applied` | string[] | Yes | List of repairs applied during retries (empty if passed first try) |
| `last_diagnosis` | object | No | Last debug sub-agent diagnosis (only present when `status` is not `"pass"`) |
| `withheld_repair` | string | No | The repair that was NOT applied and why it was withheld (only present when `status: "failed-needs-decision"`) |
| `tested` | string[] | No | **Evidence field.** Behaviors/scenarios actually exercised by the verification (e.g. "expired JWTs are rejected") |
| `testing_summary` | string | No | **Evidence field.** One-sentence prose summary of what was tested. For UI-affecting tasks without visual evidence, MUST state why no visual evidence exists (see Visual Evidence Rule) |
| `artifacts` | object[] | No | **Evidence field.** Each artifact is **exactly one of**: `{"path": "<repo-or-evidence-relative path>"}` \| `{"url": "<externally visible url>"}` \| `{"content": "<short inline log excerpt>"}`. See Evidence Directory and Artifact Path Safety below |

The three evidence fields (`tested`, `testing_summary`, `artifacts`) are **optional and additive** — when absent, the entry behaves exactly as a legacy pass/fail record. They never alter the required fields or the `pass | fail | failed-needs-decision` status enum.

### Status Signal Mapping

The verification `status` enum (`pass | fail | failed-needs-decision`) is a domain outcome enum and never changes. When a verification outcome is expressed in the unified signaling vocabulary (see `.claude/resources/core/status-contract.md`), it maps as:

`pass → done` · `fail → failed` · `failed-needs-decision → needs-decision`

### When `task_verifications` is Omitted

- If a phase has **no tasks with `<verify>` tags**, the `task_verifications` field is omitted entirely from the JSON return
- This maintains backward compatibility — existing phase isolation returns are unchanged

---

## Evidence Capture

Per-task verification can go beyond pass/fail by recording **structured evidence** of what was actually tested: the optional `tested`, `testing_summary`, and `artifacts` fields on each `task_verifications` entry (see the entry fields table above), backed by an on-disk evidence directory.

### Evidence Directory

Verification command outputs and test logs are written to:

```
flow/.evidence/<run-id>/<phase>-<task>/
```

- **run-id**: `<plan-slug>-<execution start timestamp YYYYMMDD-HHMMSS>` (e.g. `user-auth-20260705-101500`). Generated by the **coordinator at execution start** and passed to each phase sub-agent in its context (via the `## Evidence` section of the phase-isolation Context Template — see `.claude/resources/core/phase-isolation.md`).
- **`<phase>-<task>`**: e.g. `phase-2-task-1` — one subdirectory per verified task.

**What goes where**:

| Output | Destination |
|--------|-------------|
| Command output longer than ~30 lines | File in the evidence dir, referenced by an `artifacts[]` `path` |
| Short decisive output (≤30 lines) | Inline `artifacts[]` `content` |
| Externally hosted artifacts (CI runs, deployed previews, etc.) | `artifacts[]` `url` |

The evidence directory is **gitignored** (covered by the `flow/` entry) — evidence is local-only and never committed.

### Visual Evidence Rule

For **UI-affecting tasks** (detection: same heuristics as design-awareness UI phase detection — see UI Phase Detection Heuristics in `.claude/resources/core/design-awareness.md`), the verification step requests **reviewer-visible visual evidence** — a screenshot, video, or rendered HTML file — when browser tooling is available in the project (e.g. playwright, puppeteer, or cypress in `package.json`).

- **Browser tooling available**: capture the visual artifact into the evidence directory and reference it via an `artifacts[]` `path`
- **Browser tooling unavailable**: `testing_summary` MUST state why no visual evidence exists (e.g. "No visual evidence — project has no browser automation tooling installed")
- **DOM snapshots do NOT qualify** as visual evidence — the artifact must be something a human reviewer can look at directly

### Artifact Path Safety

Artifact `path` values must resolve **inside the evidence directory or the repo working tree**. The sub-agent rejects:

- Absolute paths outside the repo
- `..` escapes that resolve outside the repo
- Symlinked targets that resolve outside the repo

When a path is rejected, the sub-agent **downgrades the artifact to inline `content`** (a truncated excerpt) instead of dropping it. Paths must never start with `.git/`.

---

## Configuration

### `.flowconfig` Setting

```yaml
max_verify_retries: 2    # Max repair attempts per task verification (default: 2, range: 1-5)
```

- **Default**: `2` (initial attempt + 2 retries = 3 total runs)
- **Range**: `1` to `5`
- **Values below 1 or above 5**: Clamped to the valid range with a warning

### Toggle via `/flow`

```
/flow max_verify_retries=3
```

### No Feature Toggle

Per-task verification has no on/off toggle. It activates automatically when tasks include `<verify>` tags. Plans without `<verify>` tags behave exactly as before — fully backward compatible.

---

## Error Handling

### Verification Command Errors

| Scenario | Behavior |
|----------|----------|
| Command not found | Treat as verification failure, spawn debug sub-agent |
| Command timeout (>30s) | Kill process, treat as failure, include timeout in error output |
| Command produces no output | Treat exit code as sole indicator (0 = pass, non-zero = fail) |
| Command produces large output | Truncate to 200 lines before passing to debug sub-agent |

### Debug Sub-Agent Errors

| Scenario | Behavior |
|----------|----------|
| Invalid JSON return | Skip this retry, count as failed attempt |
| Sub-agent timeout | Skip this retry, count as failed attempt |
| Empty repair_actions | Skip repair, re-run verification (may pass if issue was transient) |

### Phase-Level Impact

| Verification Outcome | Phase Status |
|----------------------|-------------|
| All verifications pass | `"success"` (no change) |
| Some verifications fail (max retries exceeded) | `"partial"` |
| Some verifications end in `failed-needs-decision` (repair withheld) | `"partial"` (same escalation path as a failure) |
| Task implementation itself fails | `"failure"` (existing behavior, unrelated to verification) |

---

## Interaction with Wave Mode

Per-task verification is **entirely internal** to each phase sub-agent. The wave coordinator:

- Does NOT know about individual task verifications during execution
- Receives `task_verifications` in the JSON return after the sub-agent completes
- Displays verification stats in the wave completion summary
- Does NOT retry phases based on verification failures (that is internal to the sub-agent)

```
Wave 1: Phase 1 (2 tasks verified: 2 pass), Phase 2 (3 tasks verified: 2 pass, 1 fail after 2 retries)
```

Wave execution treats a phase with failed verifications as `"partial"` — the same way it handles any partial result. The user decides whether to continue.

---

## Rules

1. **Verify is optional** — tasks without `<verify>` tags skip verification entirely
2. **Targeted commands only** — never use full builds or full test suites as verify commands
3. **Debug sub-agent is read-only** — it diagnoses but never modifies files
4. **Implementation sub-agent repairs** — only the phase sub-agent applies fixes
5. **Continue on failure** — failed verification does NOT abort the phase; it records the failure and continues to the next task
6. **Max retries are hard** — once exceeded, escalate to user; never increase retries dynamically
7. **First attempt is not a retry** — the initial verification run is attempt 1, retries start at attempt 2
8. **Truncate large output** — cap error output at 200 lines and file content at 300 lines for debug sub-agent
9. **Backward compatible** — phases without any `<verify>` tags produce no `task_verifications` field
10. **Wave-transparent** — wave coordinator sees only final results; verification loops are internal to phase sub-agents
11. **Intent guards repairs** — the debug sub-agent receives the plan's Intent block (when present) with the task description; repairs are classified before applying (see Repair Classification)
12. **Mechanical repairs only** — repairs that would alter product behavior, remove intentional code, or contradict the Intent block are withheld and recorded as `failed-needs-decision`; when in doubt, withhold
13. **Fix-Pass Rules are mandatory** — every applied repair follows the Fix-Pass Rules (verify diagnosis first, smallest root-cause fix, never revert intentional changes, no fix-explaining comments)
14. **Evidence fields are optional** — `tested`, `testing_summary`, and `artifacts` are additive; entries without them are legacy pass/fail records
15. **Evidence is local-only** — `flow/.evidence/<run-id>/` is gitignored and never committed; artifact `path` values follow the Artifact Path Safety rules (no escapes outside the evidence dir or repo working tree; violations are downgraded to inline `content`)
16. **Visual evidence for UI tasks** — UI-affecting tasks provide screenshot/video/rendered-HTML evidence when browser tooling exists; otherwise `testing_summary` states why none exists (DOM snapshots do not qualify)

---

## Related Files

| File | Purpose |
|------|---------|
| `.claude/resources/core/phase-isolation.md` | Sub-agent context template and JSON return format (extended by this feature) |
| `.claude/resources/core/wave-execution.md` | Wave coordinator behavior (verification is internal to sub-agents) |
| `.claude/resources/core/model-routing.md` | Model tier selection (debug sub-agent always uses haiku) |
| `.claude/resources/skills/execute-plan-skill.md` | Execute-plan skill with verification result display |
| `.claude/resources/skills/create-plan-skill.md` | Auto-generation of `<verify>` sections in plans |
| `.claude/resources/patterns/plans-templates.md` | Plan template with `<verify>` tag syntax and the `## Intent` section definition |
| `.claude/resources/core/review-multi-agent.md` | Action Classification taxonomy referenced by Repair Classification |
| `.claude/resources/core/design-awareness.md` | UI Phase Detection Heuristics referenced by the Visual Evidence Rule |
| `.claude/resources/core/status-contract.md` | Unified status signal vocabulary and the verification status mapping |
