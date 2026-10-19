
# Execute Plan Skill

## Purpose

Execute an implementation plan **phase by phase**, using complexity scores to determine execution strategy. Each phase triggers **Plan mode** for collaborative design before implementation.

This skill **implements the plan** by:

- Reading and parsing the plan file
- Grouping phases by complexity
- Analyzing dependencies and grouping into parallel waves (when enabled)
- Switching to Plan mode for each phase
- Implementing after user approval
- Updating progress in the plan file

---

## CRITICAL RULE: Build Verification ONLY at the End

**DO NOT run `npm run build` after each phase or group.**

**`npm run build` and `npm run test` MUST ONLY be executed at the very end, after ALL phases (including Tests) are complete.**

**Why**:

- Running build after each phase wastes time and breaks flow
- Intermediate phases may have temporary type errors that get resolved in later phases
- The final build verification ensures everything works together

**The ONLY time to run build/test**:

- After ALL phases are complete -> `npm run build && npm run test`

---

## CRITICAL RULE: No Direct Database or ORM Commands

**NEVER execute any ORM or database commands directly. ALWAYS ask the user to run them manually.**

### Forbidden Commands (NEVER execute directly)

| Category        | Commands                                              |
| --------------- | ----------------------------------------------------- |
| **Prisma**      | `prisma migrate`, `prisma db push`, `prisma db seed`  |
| **Django**      | `python manage.py migrate`, `python manage.py dbshell`|
| **Alembic**     | `alembic upgrade`, `alembic downgrade`                |
| **Sequelize**   | `sequelize db:migrate`, `sequelize db:seed`           |
| **TypeORM**     | `typeorm migration:run`, `typeorm migration:revert`   |
| **Drizzle**     | `drizzle-kit push`, `drizzle-kit drop`                |
| **Raw SQL**     | Any direct SQL execution, psql, mysql, sqlite3        |
| **Connections** | Any database connection or query commands             |

### When Database Commands Are Needed

**ALWAYS present the command to the user and wait for confirmation:**

```markdown
## Action Required: Database Migration

The following command needs to be executed manually:

\`\`\`bash
[command here]
\`\`\`

**Why manual execution is required:**
- Database operations can be destructive and irreversible
- User should review the migration before applying
- Prevents accidental data loss in development/production

Please run this command and let me know when it's complete, or if you encounter any issues.
```

### Safe Commands (CAN be executed directly)

| Command               | Why It's Safe                              |
| --------------------- | ------------------------------------------ |
| `prisma generate`     | Only generates client code, no DB changes  |
| `prisma format`       | Only formats schema file                   |
| `prisma validate`     | Only validates schema                      |
| Reading schema files  | Read-only operation                        |

### Why This Rule Exists

1. **Data Safety**: Database migrations can delete or modify data
2. **Reversibility**: Some operations cannot be undone
3. **Environment Awareness**: User knows if this is dev/staging/prod
4. **Verification**: User can review the migration before applying
5. **Error Handling**: User can handle errors appropriately

---

## Inputs

| Input       | Required | Description                          |
| ----------- | -------- | ------------------------------------ |
| `plan_file` | Yes      | Path to plan file in `flow/plans/`   |
| `--fresh`   | No       | Ignore resume — run all phases even when the compile report marks some complete |

---

## Workflow

### Step 0: Compile the Run Script

Before anything else, compile the plan into its run-script artifact:

```bash
planflow-ai plan compile <plan>
```

`<plan>` is the plan name (e.g. `user-auth`) or a path under `flow/plans/`. The command writes `flow/plans/<name>.run.json` — a deterministic JSON artifact (`version`, `plan`, `planHash` = sha256 of the plan content minus its change notes' review lines (status, verdict, comments), `phases` with resolved model + skip, `waves`, `routing`, `commitStrategy`, `overrides`, `diagnostics`) — rotating any previous artifact to `<name>.run.prev.json`. The preserved `overrides` block (per-phase model/skip, per-task verify) survives recompiles; stale overrides are warned, never applied or dropped.

**The artifact is THE orchestration source of truth**: waves, per-phase model, skip flags, and verify commands are read from the artifact — never re-derived from the plan markdown. Steps 2b, 3, and 4 below consume the artifact's `waves`, `phases[].model`, and `phases[].skip` fields; the markdown remains the source for prose context (scope, tasks, approach) only.

**Print the compile report** into the session verbatim. It lists the plan path + short planHash, wave grouping (`Wave N: Phase …`), per-phase routing (`Phase N (complexity C) → <model>` with `[override]`/`[skip]` markers), per-phase resume states (`complete (resumable)` / `pending`), any `warning:` lines for stale overrides, and the run-script path.

**On `compile refused: <reason>`** (exit 1, nothing written): STOP. Surface the refusal line to the user and do not proceed — an uncompilable plan must be fixed before execution.

**Resume**: phases the report marks `complete (resumable)` are skipped, with a one-line notice: `resuming: phases X–Y already complete (run <run_id>)`. A phase resumes ONLY from `phase_result` entries with status `success` whose run lineage carries a `planHash` matching the artifact — unhashed legacy rounds never resume. `--fresh` on the invocation (`/execute-plan <plan> --fresh`) ignores resume entirely and runs all phases.

---

### Step 1: Parse the Plan

1. Read the specified plan file
2. Parse all phases with their complexity scores and tasks
3. Validate that all phases have complexity scores

**Important**: NEVER read or reference files in `flow/archive/` - these are outdated plans.

---

### Step 1b: Read the Change Notes

Plans carry `#### Change notes` blocks — notes for the main changes of the plan
(3–8, a repeated edit written once), plus file notes (grammar: `.claude/resources/patterns/plans-templates.md`,
Change Notes). The person may have reviewed them already (accepted, rejected,
commented). Read them once, at the start:

```bash
planflow-ai plan notes <plan> --json
```

It returns every note with its `phase`, `status` (`proposed` = unreviewed,
`accepted`, `rejected` with `reason`), `comments`, and `counts { total, accepted,
rejected, unreviewed }`. **When the plan has notes** (`counts.total > 0`), say
exactly one line before the execution summary:

```
Notes: U unreviewed — built as written; R rejected — left out
```

How notes drive the run:

| Status | What the run does |
|--------|-------------------|
| `accepted` | An instruction for its phase — build it as written, honouring its comments |
| `proposed` (unreviewed) | Built as written, exactly like an accepted note |
| `rejected` | **Never built.** Passed to its phase as "do not build", with its reason and comments |

Unreviewed notes never stop the run and never add a question: execution is the
person's go-ahead, whether they reviewed every note, some, or none. This is the
same with a chain driving and in a headless run — **notes add no pause of any
kind**. A plan with no notes (an older plan) runs exactly as before: skip this
step and Step 7b1b, and print no Notes lines.

A `plan refused: …` here (the plan cannot be read) is reported in one line and
the run continues as a plan without notes — the compile in Step 0 already
validated the phases.

---

### Step 2: Analyze Complexity and Determine Execution Strategy

Parse each phase and calculate execution groups based on complexity scores:

**Execution Strategy Rules**:

| Total Adjacent Score | Execution Strategy                                          |
| -------------------- | ----------------------------------------------------------- |
| <= 6                 | **Aggregate**: Execute multiple phases together in one pass |
| 7-10                 | **Cautious**: Execute 1-2 phases, then continue             |
| > 10                 | **Sequential**: Execute one phase at a time                 |

**Aggregation Rules**:

1. **Can aggregate** phases when their combined complexity <= 6
2. **Never aggregate** across a phase with complexity >= 8
3. **Always execute separately**: Tests phase (regardless of score)
4. **Prefer aggregation** for trivial consecutive phases (0-2 each)

**Example Analysis**:

```
Phase 1: Types and Schemas - Complexity: 3/10
Phase 2: Utility Functions - Complexity: 2/10
Phase 3: API Route - Complexity: 7/10
Phase 4: UI Components - Complexity: 6/10
Phase 5: Integration - Complexity: 4/10
Phase 6: Tests - Complexity: 5/10

Execution Groups:

- Group 1: Phase 1 + Phase 2 (combined: 5) -> Aggregate
- Group 2: Phase 3 (7) -> Execute alone
- Group 3: Phase 4 + Phase 5 (combined: 10) -> Execute together
- Group 4: Phase 6 (Tests) -> Always separate
```

---

### Step 2b: Wave Analysis (Wave Execution)

**Condition**: Only run this step when `wave_execution` is `true` in `flow/.flowconfig` (default: `true`). If `wave_execution` is `false` or the key is missing, skip entirely — proceed to Step 3 with sequential grouping only.

Read `.claude/resources/core/wave-execution.md` for the full system reference.

**Operational source**: wave grouping comes from the compiled run script's `waves` field (Step 0) — the calculation below runs inside `plan compile`; read the artifact's result rather than re-deriving it from markdown.

1. **Parse Dependencies**: For each phase, look for a `**Dependencies**:` line:
   - `Phase 1, Phase 3` → depends on those phases completing first
   - `None` → explicitly independent, can run in Wave 1 (if no other constraints)
   - Missing field → implicit dependency on Phase N-1 (Phase 1 has no implicit dependency)
   - Self-references and references to non-existent phases are ignored (warn on non-existent)

2. **Build dependency graph**: Map each phase to its dependency set (after applying defaults).

3. **Topological sort → assign wave numbers**:
   - Phases with no dependencies → Wave 1
   - For each remaining phase: `wave = max(wave of each dependency) + 1`
   - Tests phase exception: Move to its own final wave regardless of computed wave number
   - On circular dependency: warn user and **fall back to sequential execution**

4. **Apply aggregation to waves**: If phases within the same wave are adjacent and their combined complexity ≤ 6, aggregate them into a single sub-agent call (same aggregation rules as Step 2). Aggregated phases share one wave slot and one dependency set (union of all their dependencies).

5. **Estimate speedup**: Compare number of sequential phases vs number of waves.

6. **Store wave plan** for use in Steps 3 and 4.

**Backward compatibility**: Plans without any `Dependencies` fields produce a fully sequential wave plan (one phase per wave). This matches existing behavior exactly — no regression.

---

### Step 3: Present Execution Plan Summary

Before starting, present the execution plan to the user.

**When wave execution is disabled** (or wave plan is fully sequential), present the standard summary:

```markdown
## Execution Plan Summary

**Plan**: [Plan Name]
**Total Phases**: X
**Total Complexity**: XX/XX

### Execution Groups:

| Group | Phases           | Combined Complexity | Strategy   |
| ----- | ---------------- | ------------------- | ---------- |
| 1     | Phase 1, Phase 2 | 5/10                | Aggregate  |
| 2     | Phase 3          | 7/10                | Sequential |
| 3     | Phase 4, Phase 5 | 10/10               | Cautious   |
| 4     | Phase 6 (Tests)  | 5/10                | Sequential |

**Build Verification**: Only at the end, after ALL phases complete

Ready to begin execution?
```

**When wave execution is enabled** and the wave plan contains at least one wave with multiple phases, present the wave execution summary:

```markdown
## Execution Plan Summary

**Plan**: [Plan Name]
**Total Phases**: X
**Total Complexity**: XX/XX
**Execution Mode**: Wave-based parallel

### Wave Execution Plan:

| Wave | Phases | Parallel |
|------|--------|----------|
| 1 | Phase 1: Types, Phase 2: Utilities | Yes (2 parallel) |
| 2 | Phase 3: API Integration | No (1 phase) |
| 3 | Phase 4: Config Updates | No (1 phase) |
| 4 | Phase 5: Tests | No (always sequential) |

**Sequential phases**: 5 → **Waves**: 4 → **Estimated speedup**: ~20%
**Build Verification**: Only at the end, after ALL phases complete

Proceed with wave execution? (yes/no/sequential)
```

User response options for wave execution:
- **yes**: Execute with wave parallelism
- **no**: Stop execution
- **sequential**: Fall back to sequential execution (ignore waves, use standard Step 4)

Wait for user confirmation before proceeding.

---

### Step 4: Execute Each Phase with Plan Mode

**CRITICAL RULE**: Use the [Plan Mode Tool](../tools/plan-mode-tool.md) to switch to Plan mode for **EACH individual phase**.

**REMINDER**: Do NOT run `npm run build` between phases.

**Evidence run-id**: At execution start (before the first phase or wave), the coordinator generates the evidence run-id: `<plan-slug>-<execution start timestamp YYYYMMDD-HHMMSS>` (e.g. `user-auth-20260705-101500`), creates `flow/.evidence/<run-id>/`, and includes the run-id in EVERY phase sub-agent context via the `## Evidence` section of the phase-isolation Context Template (see `.claude/resources/core/phase-isolation.md`). Sub-agents write per-task verification evidence to `flow/.evidence/<run-id>/<phase>-<task>/` per the Evidence Directory rules in `.claude/resources/core/per-task-verification.md`. The directory is gitignored (covered by the `flow/` entry) — evidence is local-only.

#### Feature Confirmation (feature-blueprint)

After all phases complete and gates pass, CONFIRM any feature this plan
introduced:

```bash
planflow-ai blueprint features discover      # stage candidates
planflow-ai blueprint features confirm <slug>
```

This is the execution half of "plan proposes, execution confirms". Confirming
writes a real feature file with a stub body naming its provenance — never
invented prose. Fail-soft: no staged candidate simply means the plan introduced
no new feature, which is the common case.

**Levels**: a plan is a CHANGE to a feature, so it confirms as `kind: child`
under the capability it touches — never as a top-level feature. Capabilities
themselves come from the repo's own surfaces (routes, API groups, e2e suite
dirs, `features/` roots), which `discover` mines as `kind: core`. Confirming
every mined capability at once:

```bash
planflow-ai blueprint features confirm --all --kind core
```

A store levelled before this rule existed (everything `core`) is repaired with
`planflow-ai blueprint features reclass` — an explicit verb, never a step
inside `discover`, because `kind`/`parent` are human-owned.

---

## Rounds Record (`flow/.rounds.jsonl`)

At execution start (the same moment the evidence run-id is generated), the coordinator creates `flow/.rounds.jsonl` — a **persistent, append-only JSONL execution record**, one entry per phase/task event. Unlike `flow/.wave-context.jsonl` (ephemeral coordination, deleted after execution), the rounds file is NEVER deleted — it is the durable audit trail of the run, and the risk assessment (Step 7b2) and PR body (Step 7c) consume it.

**Run start — the first entry, written by a verb.** Immediately after generating the run-id (before the first phase or wave), the coordinator runs:

```bash
planflow-ai flow run-start --plan <plan-slug> --run <run-id> --json
```

It appends a `run_intent` carrying `base` — the full sha of `HEAD` at the moment the run starts — plus `planHash` when `flow/plans/<plan-slug>.run.json` exists (it creates `flow/.rounds.jsonl` if this is its first line). `planflow-ai blueprint storyline --plan <plan-slug>` reads that `base` as Today, so the board's Today ⇄ After comparison stays anchored to where the run began after the run's own commits move `HEAD`. **Never hand-compose this line** (a reader's input has one writer — forbidden-pattern #18). A refusal (`flow refused: …` — not a git repository, no commit yet, no active plan by that name) writes nothing: report it in one line and continue the run; Today then falls back to `HEAD`.

**Common envelope** (every entry):

```json
{"ts": "<ISO8601>", "run_id": "<run-id>", "type": "verification|phase_result|risk|escalation|run_intent|plan_decision|review_verdict|module_completed|archive_sweep", "phase": N, ...}
```

`run_id` **reuses the evidence run-id** (`<plan-slug>-<YYYYMMDD-HHMMSS>`, defined above) — do not invent a second id scheme. **Exception**: `plan_decision` entries are written at planning time, before any execution run exists — they use the plan-scoped id `<plan-slug>-plan`. **Second exception**: `review_verdict` entries from standalone reviews (no matching execution run) use `review-<YYYYMMDD-HHMMSS>`, as specified in the review skills. `phase` is the phase number, or `null` for run-level entries (e.g. the `risk` entry) and for both `plan_decision` and `review_verdict`.

**Entry types**:

| Type | When appended | Type-specific fields |
|------|---------------|----------------------|
| `verification` | One per task verification result, when the coordinator processes the phase return | `task`, `status` (`pass \| fail \| failed-needs-decision`), `attempts`, `repairs_applied` (repairs classified with the Repair Classification language — mechanical vs behavioral — from `.claude/resources/core/per-task-verification.md`, which mirrors the review action taxonomy in `.claude/resources/core/review-multi-agent.md`), `withheld_repair` (when a behavioral repair was withheld), `evidence` (artifact refs from `flow/.evidence/<run-id>/<phase>-<task>/`) |
| `phase_result` | One per phase, after the coordinator processes that phase's return | `status`, `summary`, `decisions`, `deviations`, `duration`, and **`anchors` — REQUIRED: every file that phase touched, project-relative (`app/src/x.ts`), plus any module anchors. This is not optional bookkeeping: it is the only durable record of which files belong to which phase, and Source Control's Phases view groups changes by it. Without it every change lands in "Other changes" and phase-by-phase commit does not work at all** (measured 2026-09-04: two real plans, 7 and 10 phases, attributed nothing). An anchored phase_result that carries decisions and/or deviations is promotable into the blueprint annotation stream on the next derive — routine completions are not (mapping and selection rules live in `.claude/resources/core/blueprint.md`, Promotion Rules) |
| `risk` | Once per run, at Step 7b2 (Post-Execution Risk Assessment) | `risk_level` (`low\|medium\|high`), `risk_rationale` |
| `run_intent` (start) | **Once per run, first**, at execution start — written ONLY via `planflow-ai flow run-start --plan <plan-slug> --run <run-id>`, never hand-composed | `plan` (the plan **slug**, as `blueprint storyline` matches it), `base` (the sha of `HEAD` when the run started), `planHash` (when the plan has been compiled); `phase: null` |
| `run_intent` | **Once per run**, written by the coordinator at run END (before the Step 7d blueprint derive, so the same run's derive promotes it) | `plan` (plan file name), `planHash` (**REQUIRED** going forward — the compiled artifact's sha256 plan hash, copied from `<name>.run.json`; this is the lineage key that lets `plan compile` resume completed phases from a prior run), `intent_goal` (the **verbatim** Goal line from the plan's Intent block), `originating_request` (the discovery/brainstorm ask that motivated the run — NOT the literal `/execute-plan` command), `anchors` (module/file anchors covering everything the run touched); `phase: null` |
| `escalation` | Whenever the coordinator escalates to the user (failed verification options, withheld repairs, file/contract conflicts, high-risk gate, **guarded-autopilot gate** — Step 7b4, #653) | `what` (what was escalated), `choice` (the user's decision); optionally `context` naming the gate (e.g. `"guarded-autopilot-gate"`) |
| `pushed_through` | Whenever an **enforced autopilot run** goes past one of the four quality stops it would otherwise honour — a wave file conflict, a contract conflict, a withheld behavioural repair, or a failing lint gate (an enforced run honours only three pauses: `high` risk before the publish, the guard classifier's `ask`, and an unbound branch at push). Written ONLY via `planflow-ai flow pushed-through <stop> --feature <slug> --run <run-id> [--chain <id>] [--detail <text>]`, which is the one writer and validates the vocabulary — never hand-composed | `stop` (`wave-file-conflict \| wave-contract-conflict \| withheld-repair \| lint-gate`), `detail` (one sentence, or null), `chain` (the chain that was driving, or null), `plan`; `phase: null`. Read back by the publish gate (`planflow-ai flow risk --check`), which reports them and never refuses for them |
| `plan_decision` | One per decision folded back into the plan during `/create-plan`'s Visual Plan Review (written by the create-plan skill at planning time — it creates the rounds file if it doesn't exist yet) | `decision` (plan section anchor / what was decided), `choice` (the selected answer), `source: "create-plan-visual-review"`; envelope uses `run_id: "<plan-slug>-plan"` and `phase: null` |
| `review_verdict` | One per review finding outcome, written by review skills (a later phase wires that) | `finding_fingerprint` (`"<file>+<title>+<category>"`), `classification` (`"kept" \| "dismissed" \| "deferred"`), `reason`; `phase: null` |
| `module_completed` | Once per module, the moment the coordinator determines the LAST phase whose Files list touches that module has completed (sequential: right after Step 4.7 for that phase; wave mode: during Step 4c.7's per-phase processing) | `module` (repo-relative dir — the module's anchor ref), `reason` (fixed string: `"last phase touching module completed"`) |
| `archive_sweep` | Once per run, at Step 7.6 (plan archive) — covers every module the run touched, as a run-level safety net alongside the per-module `module_completed` entries | `modules` (array of repo-relative dirs the run touched); `type: "archive_sweep"`, `phase: null` |

**Who writes it**: the coordinator (main session) for all execution-time types — sub-agents never write the rounds file directly; they already return round data in their JSON (`task_verifications`, `decisions`, `deviations`). Two skill-level writers exist for the non-execution types: `/create-plan` appends `plan_decision` entries (Visual Plan Review) and review skills append `review_verdict` entries (wired in a later phase).

**Pause-during-runs rule (progressive-learning)**: while a run is executing, every module its phases touch is *in play* — the progressive-learning system must never auto re-learn a module out from under an active run (a stale re-learn racing the run's own edits would waste a pass and could summarize half-finished code). `module_completed` and `archive_sweep` are the ONLY release signals: `module_completed` fires the instant a module's last touching phase finishes (the common case — most modules are fully touched within one run), and `archive_sweep` fires once at archive time as a run-level safety net covering every module the run touched, so a module that was touched but never got an unambiguous per-module release still gets swept clean. Downstream consumers (e.g. the app's `learn-run-triggers.ts`) tail-read these two entry types from `flow/.rounds.jsonl` and treat a module as released back to the auto-relearn pool only once one of these entries names it — never before.

**Cross-type notes**:

- PR body generation (Step 7c) **ignores plan-scoped run_ids** (`*-plan`) — except when rendering Intent context, where `plan_decision` entries may inform the Intent section.
- `review_verdict` entries are written by review skills, not by `/execute-plan` — the schema is defined here so the rounds schema lives in one place.

- **Sequential mode**: the coordinator appends `verification` entries (one per `task_verifications` item) and one `phase_result` entry immediately after processing each phase return (Step 4.7 below).
- **Wave mode**: the coordinator serializes appends **in phase/task order** during post-wave processing (Step 4c.7 below) — deterministic order regardless of which sub-agent finished first.

**Example rounds file**:

```jsonl
{"ts":"2026-07-04T18:02:11Z","run_id":"user-auth-plan","type":"plan_decision","phase":null,"decision":"phase-3-approach","choice":"JWT with refresh-token rotation","source":"create-plan-visual-review"}
{"ts":"2026-07-05T10:15:00Z","run_id":"user-auth-20260705-101500","type":"verification","phase":1,"task":1,"status":"pass","attempts":1,"repairs_applied":[],"evidence":["flow/.evidence/user-auth-20260705-101500/phase-1-task-1/tsc-output.txt"]}
{"ts":"2026-07-05T10:18:12Z","run_id":"user-auth-20260705-101500","type":"verification","phase":1,"task":2,"status":"failed-needs-decision","attempts":2,"repairs_applied":[],"withheld_repair":"Would remove an intentional null-check (behavioral — contradicts the plan's Intent block)","evidence":[]}
{"ts":"2026-07-05T10:18:30Z","run_id":"user-auth-20260705-101500","type":"escalation","phase":1,"what":"Repair withheld for task 2 (behavioral)","choice":"fix manually"}
{"ts":"2026-07-05T10:19:02Z","run_id":"user-auth-20260705-101500","type":"phase_result","phase":1,"status":"partial","summary":"Types and schema created; task 2 resolved manually","decisions":["Zod for validation"],"deviations":[],"duration":"4m"}
{"ts":"2026-07-05T10:42:55Z","run_id":"user-auth-20260705-101500","type":"risk","phase":null,"risk_level":"medium","risk_rationale":"Straightforward implementation, but one withheld repair was resolved manually — follow-up review of the null-check advised."}
{"ts":"2026-07-05T10:43:10Z","run_id":"user-auth-20260705-101500","type":"run_intent","phase":null,"plan":"plan_user-auth_v1","planHash":"f4a1b2c3d4e5f60718293a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d","intent_goal":"Users can sign in with email/password and stay signed in across sessions","originating_request":"Add authentication so each user gets a private workspace","anchors":[{"kind":"module","ref":"src/auth"},{"kind":"file","ref":"src/auth/token.ts"}]}
{"ts":"2026-07-05T11:03:40Z","run_id":"user-auth-20260705-101500","type":"review_verdict","phase":null,"finding_fingerprint":"src/auth/token.ts+Missing expiry check+correctness","classification":"dismissed","reason":"Expiry is enforced upstream in the middleware — intentional per the plan's Intent block"}
```

**Lifecycle**:

- **Created** at execution start by its first line — the `flow run-start` entry — alongside the run-id and evidence directory — unless `/create-plan`'s Visual Plan Review already created it with `plan_decision` entries, in which case the coordinator appends to the existing file
- **Appended** by the coordinator throughout execution — append-only, never edited or deleted mid-run
- **NEVER deleted** (unlike `.wave-context.jsonl`)
- **Archived** together with the plan at completion (Step 7.6): when the plan moves to `flow/archive/`, the rounds file is renamed to `flow/archive/rounds_<plan-name>.jsonl`
- **Backward compatible**: rounds recording is unconditional (coordinator-side and cheap), but the *absence* of a rounds file must never break resume or archive flows — old runs without one simply archive the plan alone

#### Step 4 — Sequential Mode (default, or when wave_execution is disabled)

**For Each Phase**:

1. **Auto-switch to Plan mode** - Call `SwitchMode` tool
2. **Present phase details** - Show scope, tasks, and approach
3. **Wait for approval** - Get user confirmation
4. **Select model tier** - If `model_routing` is enabled in `flow/.flowconfig` (default: `true` — routes each phase by its complexity score):
   - Read the phase's complexity score
   - Look up model tier: **0-3 → Fast (haiku)**, **4-5 → Standard (sonnet)**, **6-10 → Powerful (opus)**
   - For aggregated phases, use the **highest individual phase complexity** to determine the tier
   - Only an explicit `model_routing: false` skips routing (then use the most capable model from the active provider — e.g., opus for Anthropic, o3 for OpenAI); an absent key routes, because the default is `true`
   - See `.claude/resources/core/model-routing.md` for full tier table, platform mappings, and rules
5. **Inject design context** - Before implementing, check if the discovery doc (from plan's "Based on Discovery" field) has a `## Design Context` section. If present and the phase involves UI work (see UI Phase Detection Heuristics in `.claude/resources/core/design-awareness.md`), include the Design Context in the implementation prompt. If no Design Context or phase is not UI-related, skip this step.
6. **Implement (with phase isolation)** - Check `phase_isolation` in `flow/.flowconfig` (default: `true`):
   - **If `phase_isolation: true`**: Prepare an isolated context prompt and spawn as Agent subagent. See `.claude/resources/core/phase-isolation.md` for the full context template and return format schema. The prompt includes: phase spec (scope + tasks), the plan's `## Intent` block injected **verbatim** (if the plan has one — omitted entirely otherwise; see the `## Intent` section of the phase-isolation Context Template), files modified so far (paths only), pattern file paths (allowed/forbidden), the evidence run-id (`## Evidence` section — see the Evidence run-id note at the top of Step 4), design context (if UI phase), the phase's change notes (`## Change Notes` section — see "Change notes in the phase context" below), plan file path. The sub-agent returns a structured JSON summary.
   - **If `phase_isolation: false`**: Execute inline in the main session (legacy behavior). Pattern capture happens inline via step 7.
   - **Agent spawning** combines model routing AND isolation: use `model={tier}` parameter (from step 4) AND the focused context prompt (from isolation). If model routing is disabled, use session model with isolation. If both are disabled, execute inline.
   - **Change notes in the phase context** (only when the phase has notes — omit the section entirely otherwise). Add after the phase spec, from the Step 1b read, filtered to this phase:

     ```markdown
     ## Change Notes

     Build these (accepted and unreviewed notes are instructions; a note's
     comments refine it). `where` is a quote of today's code marking the place —
     find it, do not search by line number. Notes are words: write the code
     yourself, following the plan's Intent and the project's patterns.

     - Note 3 (accepted) · change · src/cli/commands/plan.ts:runPlanNotes
       where: `const result = await readPlanNotes(planArg, { target: options.target });`
       what: … · why: …
       comments: keep the text output unchanged
     - Note 4 (unreviewed) · new · src/cli/state/change-notes.ts:countVerdicts
       signature: … · purpose: … · callers: readPlanNotes, compileRunScript

     Do NOT build these — the reviewer rejected them:

     - Note 5 (rejected — keep it inline; one call site) · new · src/cli/state/change-notes.ts:verdictLabel
       comments: …
     ```

     A rejected note is a decision, not an omission: do not build it, do not
     build a near-equivalent of it, and if a task cannot be finished without it,
     return `status: "partial"` with the conflict in `deviations` rather than
     building it anyway. The same section is used in inline mode (read it before
     implementing the phase).
7. **Process sub-agent return** (isolation mode only) - Parse the JSON summary returned by the sub-agent:
   - Check `status` field: `success` → continue; `failure` → present errors to user, ask retry/skip/stop; `partial` → present deviations, ask user
   - Accumulate `files_created` and `files_modified` into the running file list
   - Append `patterns_captured` entries to `flow/resources/pending-patterns.md`
   - Log `decisions` in phase completion message
   - If inline mode (no isolation), capture patterns directly per `.claude/resources/core/pattern-capture.md`
   - **Process task verifications** (if `task_verifications` array is present in the return):
     - Count pass/fail totals, sum repairs applied, and count evidence artifacts across all entries' `artifacts` arrays
     - Display a brief verification summary after the phase completion message:
       ```
       Task Verification: X/Y passed | Z repairs applied | N artifacts
       ```
       Only include the `| N artifacts` segment when the artifact count is > 0 (entries without evidence fields contribute nothing)
     - If any task verification has `status: "fail"`, present each failed task with its last diagnosis and offer options:
       ```
       ⚠️ Task verification failed after N retries:
       **Task**: <task description>
       **Command**: <verify command>
       **Last diagnosis**: <root_cause from last_diagnosis>
       **Category**: <category from last_diagnosis>

       Options:
       1. Continue with remaining phases (issue noted)
       2. Stop and fix manually
       ```
     - If any task verification has `status: "failed-needs-decision"`, present it like a failed verification, but state explicitly that the repair was **withheld to protect intent** (it would alter product behavior, remove intentional code, or contradict the plan's `## Intent` block — see Repair Classification in `.claude/resources/core/per-task-verification.md`):
       ```
       ⚠️ Task verification failed — repair withheld to protect intent:
       **Task**: <task description>
       **Command**: <verify command>
       **Diagnosis**: <root_cause from last_diagnosis>
       **Withheld repair**: <withheld_repair — the repair that was NOT applied and why>

       Options:
       1. Apply the repair anyway
       2. Fix manually
       3. Skip (continue with remaining phases, issue noted)
       ```
   - **Append rounds entries**: After processing the return, append to `flow/.rounds.jsonl` (see Rounds Record above): one `verification` entry per `task_verifications` item, then one `phase_result` entry. If the user was asked to resolve anything (failed verification, withheld repair), also append an `escalation` entry with the user's choice. Coordinator-only — the sub-agent never writes this file.
8. **Update progress** - Mark tasks complete in plan file
   - **Note**: Sub-agent creates per-task commits directly (if `commit: true`). Coordinator does NOT create a phase-level commit. See `.claude/resources/core/atomic-commits.md` for commit format: `feat(phase-N.task-M): <desc> — <feature>`
9. **Record model used** - Track which model tier was used for this phase (for the completion summary)
10. **Continue to next phase** - NO BUILD between phases

#### Step 4 — Wave Mode (when wave_execution is enabled and user chose "yes")

Execute phases **wave by wave**. Within each wave, approve phases sequentially in Plan Mode, then spawn all wave phases as parallel Agent sub-agents.

**For Each Wave**:

##### 4a. Sequential Approval (Plan Mode)

For each phase in the current wave (in phase number order):

1. **Auto-switch to Plan mode** - Call `SwitchMode` tool
2. **Present phase details** - Show scope, tasks, approach, and wave context (e.g., "Wave 2 of 4, running in parallel with Phase 5")
3. **Wait for approval** - Get user confirmation
4. **Select model tier** - Same rules as sequential mode (step 4.4 above)
5. **Inject design context** - Same rules as sequential mode (step 4.5 above)

After ALL phases in the wave are approved, proceed to parallel spawning.

##### 4b. Parallel Spawning

Launch all approved wave phases simultaneously as independent Agent sub-agents:

1. **Prepare context for each phase**: Use the phase-isolation context template (see `.claude/resources/core/phase-isolation.md`), including the plan's `## Intent` block injected **verbatim** when the plan has one (omitted entirely otherwise — same rule as sequential mode), the phase's `## Change Notes` section (same rule as sequential mode step 6 — accepted and unreviewed notes to build, rejected notes as "do not build"; omitted when the phase has none) and the evidence run-id in the `## Evidence` section (same run-id for all phases in the execution — see the Evidence run-id note at the top of Step 4). Key addition for wave execution: the `Files Modified in Previous Phases` section includes files from ALL completed waves (1 through N-1), not just the immediately preceding phase.
2. **Inject shared context from sibling phases** (multi-phase waves only):
   - Skip this step for single-phase waves (no siblings to share with)
   - Read `flow/.wave-context.jsonl` (create it if it doesn't exist yet — see wave lifecycle below)
   - Filter entries: include only entries from OTHER phases in the current wave (not the agent's own phase). Also include entries from all previous waves.
   - If there are matching entries, add an inline section in the sub-agent prompt after the phase spec:
     ```
     ## Shared Context from Sibling Phases

     The following context entries were published by other phases (COR-SC-2 envelope — see `.claude/resources/core/shared-context.md`). Use them to align on shared contracts, types, and architectural decisions.

     {"agent":"phase-2","type":"contract","timestamp":"2026-03-24T10:00:00.000Z","data":{"name":"UserAPI","kind":"endpoint","signature":"GET /users => { id, name, email }"}}
     {"agent":"phase-2","type":"contract","timestamp":"2026-03-24T10:00:30.000Z","data":{"name":"UserRecord","kind":"type","signature":"{ id: string, name: string }","fields":["id","name"]}}
     {"agent":"phase-1","type":"decision","timestamp":"2026-03-24T10:01:00.000Z","data":{"choice":"Use Redis for session caching","reason":"Faster than DB lookups for frequent reads"}}
     ```
   - If no matching entries exist, omit the section entirely
3. **Spawn all in parallel**: Launch all wave phases simultaneously using Agent sub-agents with their respective model tiers.
4. **Wait for all to complete**: All sub-agents must return before post-wave processing.

**Wave context lifecycle**:
- **Create** `flow/.wave-context.jsonl` at wave start (before first spawn in Step 4b), if it does not already exist. Start with an empty file.
- Context entries **accumulate across all waves** — the file is NOT cleared between waves. Later waves benefit from contracts and decisions published by earlier waves.
- **Delete** `flow/.wave-context.jsonl` after execution completes (Step 7, after build/test verification).

##### 4c. Wave Coordinator — Post-Wave Processing

After all sub-agents in the wave return, process results **sequentially in phase number order**:

1. **Collect JSON returns**: Gather the structured JSON summary from each sub-agent
2. **Validate JSON**: Parse each return, check for required fields (status, phase, summary, files_created, files_modified)
3. **Collect context entries**: For each phase's JSON return, check for a `context_entries` array:
   - If `context_entries` is present and non-empty, append each entry to `flow/.wave-context.jsonl` (one JSON object per line)
   - If `context_entries` is absent or empty, treat as empty array — no entries to append
   - Entry format: the COR-SC-2 envelope from `.claude/resources/core/shared-context.md` — `{"agent": "phase-N", "type": "contract|decision|progress", "timestamp": "<ISO-8601>", "data": {...}}`. Type definitions are contract entries with `data.kind: "type"` (there is no separate `type_definition` type).
   - These entries become available to phases in subsequent waves via Step 4b
4. **Detect file conflicts**: Check for `files_modified` overlap between phases in this wave:
   - For each pair of phases (A, B) in the wave: compute `overlap = A.files_modified ∩ B.files_modified`
   - If overlap is not empty → file conflict detected
5. **Handle file conflicts** (if any):
   - Present the conflicting files and which phases modified them
   - Offer options:
     - **(1) Accept as-is**: Last writer wins (the phase with the higher number committed last)
     - **(2) Re-run conflicting phases sequentially**: Re-execute only the conflicting phases in order
     - **(3) Stop execution**: Halt for manual resolution
   - File conflicts do NOT affect non-conflicting phases — their results are preserved
   - **On an enforced run**, do not present these options: take **(1) Accept as-is** and record `flow pushed-through wave-file-conflict` — see "Enforced-run quality stops" below.
6. **Detect contract conflicts**: For each pair of phases (A, B) in the wave, check their `context_entries` for contract entries with the same `name` but different `signature` or `fields`:
   - Compare all entries where `type` is `contract` (including type definitions, i.e. entries with `data.kind: "type"`)
   - If same `name` but different `signature`/`fields` → contract conflict detected
   - Present conflicts and offer resolution (see Contract Conflicts below)
   - Contract conflicts do NOT affect non-conflicting phases — their results are preserved
   - **On an enforced run**, do not present options: take the highest-numbered phase's version and record `flow pushed-through wave-contract-conflict` — see "Enforced-run quality stops" below.
7. **Process each phase** (in phase number order):
   - Check `status` field: `success` → continue; `failure` → present errors, ask retry/skip/stop; `partial` → present deviations, ask user
   - Update plan file (mark tasks `[x]`)
   - Accumulate `files_created` and `files_modified` into running list
   - Buffer `patterns_captured` entries to `flow/resources/pending-patterns.md`
   - Git commit if enabled (sequential, one commit **per task** in phase/task order — see `.claude/resources/core/atomic-commits.md`). For each phase (in phase number order), iterate `tasks_completed` and commit: `git add -A && git commit -m "feat(phase-N.task-M): <desc> — <feature>"`
   - **Append rounds entries** to `flow/.rounds.jsonl` (see Rounds Record above), serialized in phase/task order: one `verification` entry per `task_verifications` item, then one `phase_result` entry for the phase. Escalations resolved during post-wave processing (failed verifications, withheld repairs, file/contract conflicts) each get an `escalation` entry with the user's choice. Coordinator-only — sub-agents never write the rounds file.
   - Log `decisions` in phase completion message

##### Contract Conflicts

If contract conflicts are detected (same API name, different signatures):

1. Present both versions:
   ```
   Warning: Contract conflict detected:
   **API**: GET /users

   Phase 1 signature: GET /users → { id: string, name: string }
   Phase 3 signature: GET /users → { id: string, name: string, email: string }

   Options:
   1. Use Phase 1's version
   2. Use Phase 3's version
   3. Stop execution for manual resolution
   ```
2. Apply the chosen version: update the corresponding entry in `flow/.wave-context.jsonl` so subsequent waves see the resolved contract
3. Contract conflicts do NOT affect non-conflicting phases — only the conflicting contract entries need resolution

8. **Report wave completion**: Present summary of all phases in this wave, including task verification stats:
   - For each phase in the wave that returned `task_verifications`, include pass/fail counts, repairs applied, and evidence artifact counts (only show the artifact count when > 0)
   - Wave completion report template:
     ```
     Wave N complete: X phases finished
     - Phase A: success (Task Verification: 3/3 passed | 1 repair applied | 2 artifacts)
     - Phase B: success (no verifications)
     - Phase C: partial (Task Verification: 2/3 passed, 1 failed | 0 repairs applied)
     ```
   - If any task verification failed, display the failed task details (same format as sequential mode step 7)
   - If any task verification has `status: "failed-needs-decision"`, present it using the "repair withheld to protect intent" format from sequential mode step 7 — explicitly stating the withheld repair and offering the same options (apply the repair anyway / fix manually / skip)

##### 4d. Wave Failure Handling

| Scenario | Behavior |
|----------|----------|
| One phase fails, others succeed | Process successful phases normally. Present failure to user. Offer: retry failed phase, skip it, or stop. |
| Multiple phases fail | Process any successful phases. Present all failures. Offer same options per failed phase. |
| All phases in wave fail | Present all failures. Offer: retry wave, skip wave, or stop. |
| Sub-agent timeout | Treat as failure for that phase. Other phases unaffected. |
| Invalid JSON return | Treat as failure for that phase. |

**Key rule**: A failed phase in a wave does NOT cancel other phases in the same wave. Parallel phases are independent — let them all complete.

##### 4e. Continue to Next Wave

After post-wave processing is complete (all commits done, failures handled), proceed to the next wave. Repeat from Step 4a.

**Phase Presentation Template**:

```markdown
## Phase Execution: Phase X - [Phase Name]

**Complexity**: X/10
**Scope**: [Phase scope description]
**Design Context**: Available / Not applicable
**Wave**: [Wave N of M] / [Sequential]
**Parallel with**: [Phase Y, Phase Z] / [None]

### Tasks to Complete:
- [ ] Task 1
- [ ] Task 2
- [ ] Task 3

### Implementation Approach:
[Discuss the approach, patterns to follow, and any decisions needed]

### Rules Checklist:
- [ ] Following allowed patterns
- [ ] Avoiding forbidden patterns
- [ ] Using appropriate language patterns
- [ ] Following design tokens from Design Context (if applicable)

---

**Ready to implement this phase?**
```

---

### Step 4f: STATE.md Phase Lifecycle Updates

Update `flow/STATE.md` at each phase transition to enable session resumability:

1. **Before phase starts**: Update `Current Phase: {N} — {Phase Name}`, `Current Task: first task`, `Next Action: Implement phase {N}`
2. **During phase** (inline mode only): Update `Current Task` as tasks progress; append decisions/blockers as they occur
3. **After phase completes**: Append to `Completed Phases`: `Phase N: Name — {outcome}`. Set `Current Phase: none`, `Current Task: none`. Append new files to `Files Modified`. Set `Next Action: Begin phase {N+1}` (or `Run build verification` if last phase)
4. **On phase failure**: Append to `Blockers`: `Phase {N} failed: {error} (status: open, tried: {attempts})`
5. **Wave mode**: Update STATE.md once before each wave (set current wave phases) and once after each wave completes (batch-update completed phases)

**Important**: In isolation mode, the coordinator (main session) handles STATE.md updates — sub-agents do not write to STATE.md.

---

### Step 5: Update Progress After Each Phase

Mark completed tasks in the plan file:

```markdown
- [x] Task 1
- [x] Task 2
```

Then continue to the next phase (NO BUILD HERE).

**Note**: In wave mode, progress updates happen during post-wave processing (Step 4c.7) rather than after each individual phase spawn. The coordinator handles updates sequentially in phase order after all wave sub-agents return.

---

### Step 5b: Phase-Boundary Context Check

**After each phase completes**, check context window usage by looking at the token count from the last response. If you notice the conversation is getting long (many phases completed, lots of file reads/edits), **proactively run `/compact`** with a summary of remaining work.

**When to compact** (at phase boundaries):
- Context feels heavy (many tool calls, large file reads accumulated)
- Multiple phases completed and more remain
- You're about to start a complex phase (complexity >= 6)

**In wave mode**: Compact at **wave boundaries** (between waves), not between phases within a wave. Include wave progress in the compact summary.

**How to compact at a phase boundary**:

Run `/compact` with instructions that preserve execution state:

```
/compact Executing plan: [plan file path]. Completed phases: [list]. Completed waves: [N of M]. Next wave: [wave N, phases: list]. Key files modified: [list]. Active tasklist items: [list from flow/tasklist.md]. Resume execution from wave [N] / phase [N].
```

**Rules**:
- NEVER compact mid-phase — only at phase boundaries (between phases)
- In wave mode, NEVER compact mid-wave — only at wave boundaries (between waves)
- Always include enough context in the compact instructions to resume
- After compaction, re-read the plan file and continue from the next phase
- In autopilot mode, compact automatically without asking — this is a maintenance action, not a user decision

**Compaction Guide**: For detailed preserve/discard rules, see `COR-CG-2` and `COR-CG-3`. Use the summary template from `COR-CG-4` to structure your `/compact` instructions.

---

### Step 6: Handle Tests Phase

The Tests phase is **always executed separately**, regardless of complexity score:

1. Switch to Plan mode
2. Present the testing strategy
3. Discuss test coverage and edge cases
4. Get user approval
5. Implement tests
6. **DO NOT run tests yet** - Continue to Step 7

**Wave mode note**: The tests phase always runs alone in its own final wave. This is enforced during wave analysis (Step 2b.3) — the tests phase is moved to a dedicated final wave regardless of its computed wave number.

---

### Step 7b: Pattern Review

After all phases are complete but **before** build/test verification, run the pattern review protocol:

1. Read `flow/resources/pending-patterns.md`
2. If the buffer has entries, present grouped patterns for user approval
3. Write approved patterns to `.claude/rules/core/allowed-patterns.md` or `.claude/rules/core/forbidden-patterns.md`
4. Clear the buffer

See `.claude/resources/core/pattern-capture.md` for the full end-of-skill review protocol.

### Step 7b1a: Change-Simulation Reconciliation (blueprint-simulation)

After all phases complete and **before** the risk assessment, reconcile the plan's
predicted change-simulation baseline against what the run actually touched. The baseline was
written at plan-time by the `/create-plan` anchor gate (`blueprint gate-check`) for plans authored with a `## Story` — plans with change notes have none (see below); the run's
`phase_result` entries carry the actual touched anchors.

```bash
planflow-ai blueprint reconcile --plan <feature-name>
```

- **`reconcile: <plan> — C confirmed, M missed, S surprise`** plus, when any exist,
  `reconcile: unforeseen nodes (risk raise-only): <ids>`.
- **`reconcile refused: no simulation baseline …`** → the plan changed since the baseline or
  none was written (e.g. a pre-gate plan). Skip reconciliation for this run — it is not an
  error, and it never blocks completion. Note it in the summary.
- **Surprises** (nodes touched that were predicted in NO phase = genuinely unforeseen blast
  radius) are the signal that feeds the risk step below. The board shows them prominently in
  live mode; here, record them for the risk rationale. A node merely touched in a different
  phase than predicted is a timing shift, NOT a surprise, and does not raise risk.
- A plan written with change notes has no simulation baseline (plans no longer author a
  `## Story`, and the baseline is written from one), so `reconcile` refuses as above — expected.
  For such a plan the per-note verdicts of Step 7b1b are the reconciliation.

---

### Step 7b1b: Change-Note Verdicts (plans with notes only)

After all phases complete — after pattern review and reconciliation, **before** the
risk assessment (Step 7b2, so a `differs` or `not-built` verdict can inform it) and
before the Step 7 build/test gate — check each note against what was actually built
and record a verdict. Skip this step entirely when the plan has no notes.

1. **Get the facts mechanically**, one call per file the notes name (deduplicate):

   ```bash
   planflow-ai blueprint storyline --plan <plan-slug> --file <note file>
   ```

   It prints one JSON line. Its `compare` is measured against the run's recorded start (`base`, written by
   `flow run-start`): `compare.predicted` carries one entry per note on that file
   (`kind: note-change | note-new | note-file`, `note.n`) with a `fact` —
   `changed`, `added`, `unchanged` or `removed` — and `quoteMissing` when today's
   quote is no longer in the function. `compare.hunks` holds the real line diff of
   each changed piece. When the storyline cannot answer (a refusal, no `base`, a
   non-TypeScript file, a sibling project's note — `codeUnavailable`), reason from
   `git diff <base> -- <file>` instead, with `<base>` from the `run_intent` entry in
   `flow/.rounds.jsonl`, or the run's first commit's parent.
2. **Judge each accepted and unreviewed note** against its own words (`what` /
   `purpose` / `callers`) and the facts:

   | Verdict | When |
   |---------|------|
   | `done` | The change the note describes is in the code (a change note's function `changed` the way `what` says; a new note's function was `added` with that purpose and is called by its callers; a file note's file changed as described) |
   | `differs` | Something was built, but not as the note says — a different function, a different shape, a caller missing, or more than the note described |
   | `not-built` | The fact is `unchanged` (or the function does not exist) — nothing the note describes was built |

3. **Record each verdict through the one writer** — never by editing the plan file:

   ```bash
   planflow-ai plan note <plan> --note <n> --verdict done|differs|not-built --why "<one sentence>" --json
   ```

   The sentence says what the code shows, not what was intended ("runPlanNotes now
   prints the verdict count after the status counts"). A `plan refused: <reason>`
   comes with a JSON payload — correct the call from it once, or report the refusal
   verbatim; it never blocks completion.
4. **Rejected notes get no verdict.** They were not built by decision. (If the
   facts show a rejected note's function changed anyway, say so in one line in the
   completion summary — it is a deviation the reviewer must see.)
5. A `differs` or `not-built` verdict is a deviation: name it in the risk rationale
   (Step 7b2) and in the completion summary.

The completion summary carries exactly one line for the notes (only when the plan
has them):

```
Notes: A accepted · U unreviewed (built as written) · R rejected (left out) · verdicts D done / X differs / N not built
```

---

### Step 7b2: Post-Execution Risk Assessment

After pattern review and reconciliation complete, and **before** Auto-PR creation (Step 7c),
assess the **FULL changeset** — all phases combined, not per-phase — and produce:

- `risk_level`: `low | medium | high`
- `risk_rationale`: one sentence explaining the level

**Rubric**:

| Level | Meaning |
|-------|---------|
| `low` | Well-bounded, mostly cosmetic, or straightforward with little ambiguity |
| `medium` | Room to improve, but safe to merge first with concerns addressed as follow-ups |
| `high` | Should not be merged without explicit human approval — fundamental, risky, ambiguous, or carrying strong negative signals |

**Strong negative signals** (push the level toward `high`): failed verifications, withheld repairs (`failed-needs-decision`), unresolved escalations, and **reconciliation surprises** (Step 7b1a — nodes touched that the plan predicted in no phase). Read `flow/.rounds.jsonl` when assessing — it is the factual record of what actually happened during execution.

**Surprise → risk is RAISE-ONLY** (decision #14): unforeseen touched nodes may only push the level UP, never down, and the rationale must name them (e.g. "touched module:x, unpredicted by any phase"). Consistent with how graphify signals are raise-only. Absence of surprises is not evidence of low risk — it is one signal among the rubric.

**Severity floor**: this rubric is the judgment layer of the shared risk definition in `.claude/resources/core/review-severity-ranking.md` (see "Risk Level: Shared Definition"). When review findings exist for this changeset, the severity-derived floor applies: final risk = max(severity floor, rubric judgment). A changeset's risk is **never lower than its severity floor** — judgment may only raise it. This keeps the review flow and this step from ever contradicting each other.

**Record and consume**:

1. **Record it with the verb — never by composing the JSON line yourself**:

   ```bash
   planflow-ai flow risk --record <low|medium|high> \
     --feature <plan-slug> --run <run-id> \
     --rationale "<one sentence>" [--chain <chain-id>]
   ```

   This is the **one writer** of a `risk` entry, exactly as `flow pushed-through`
   is the one writer of its own. It validates the level
   vocabulary, owns the envelope, and **stamps the chain id** onto the entry. A
   hand-written line has no identity anyone can check: appending one used to flip
   a `high` refusal into a granted publish (#1915 C1), which is why this step no
   longer shows you a JSON shape to copy.

2. **Where `--chain <chain-id>` comes from — read it, never invent it.** The
   harness embeds it in the message that started this run, as an HTML comment:

   ```
   <!-- flow-chain: chain-2026-09-11-001 stage=execute-plan -->
   ```

   Take the id verbatim from that marker and pass the same value to `--record`
   here and to `--check` below. **If there is no marker, this run is not chained:
   omit `--chain` from both calls.** Never mint an id, never reuse one from an
   earlier run, and never guess: an id you made up records an assessment no gate
   will accept, and an id belonging to another run answers for work it never saw.

   **Recording without `--chain` inside a chained run means the publish gate will
   refuse** (`risk-unassessed`) even though you rated the work — an unstamped
   entry satisfies no enforced gate, and neither does one stamped by a different
   chain. That is the safe direction for a forgotten flag: it withholds a publish
   while the work stays committed locally. If you see that refusal and you did
   record an assessment, the fix is to re-record it with the right `--chain`.

3. Store the result for the PR body — Step 7c consumes it (rendered as a `## Risk Assessment` section in the PR)
4. Include the risk level and rationale in the Step 7 completion summary

**Autopilot High-Risk Gate**:

**The gate is code, not this paragraph.** Before push/PR, run
`planflow-ai flow risk --check --feature <plan-slug> --chain <chain-id>` — the
**same chain id** you recorded with, from the same `<!-- flow-chain: … -->`
marker — and honour its exit code: it reads the `risk` entry this run recorded
under that chain, and only that one, and refuses
(`flow refused:`, exit 1, the payload first on stdout) when the record says
`high` — or when no assessment was recorded at all, which is a distinct reason
(`risk-unassessed`) and never treated as a low one. It never judges risk itself;
that judgement is the rubric above and stays here. **Without `--chain` it reports
and refuses nothing**, so a manual run is never refused into a corner. The same
verb is what the IDE's autopilot chain calls before it publishes — one code path
for both (allowed-pattern #14).

**The gate keys on `--chain`, not on the autopilot key** — being inside an
enforced run is what makes a refusal binding, and that is a fact about the call,
not about a project setting:

- **Enforced run (`--chain` passed), `high` or unrecorded**: the verb refuses,
  and the refusal is honoured — do NOT push or open a PR. Present the rationale
  the payload carries and require explicit user approval to proceed. Headless
  (heartbeat daemon): write the approval request to `flow/.heartbeat-prompt.md`
  and wait. Record the outcome as an `escalation` entry in the rounds file.
  Under the IDE's chain this seam is not yours at all — `chain-tail.ts` calls the
  same verb before it publishes, and the chain stops on the refusal.
- **Enforced run, `low | medium`**: the verb exits 0; proceed per flowconfig
  (`push`/`pr`).
- **Manual run (no `--chain`)**: the same verdict is reported and nothing is
  refused. Risk is informational — rendered in the PR body and the completion
  summary — because the user is approving each step themselves.

A held publish is not a failed run: the work is built, reviewed and committed,
and it is waiting on a person. See `.claude/resources/core/autopilot-mode.md` for
the three pauses an enforced run honours and the four quality stops it does not.

### Enforced-run quality stops — push through and record, never pause

Three of the four quality stops — a **wave file conflict** (Step 5), a **wave
contract conflict** (Step 6), and a **failing lint gate** (Step 7b3) — are places
this skill normally stops and asks the user to choose. On an **enforced run**
they must NOT stop the flow: an enforced run is one whose starting message
carries a `<!-- flow-chain: <id> stage=execute-plan feature=<slug> -->` marker,
and its whole point is that the flow keeps executing without a mid-run pause it
was not asked for. (The fourth stop, a withheld behavioural repair, is already
observable in the `verification` record and is likewise not honoured.)

So on an enforced run, at each of those three stops: **do not present options and
do not wait.** Take the safe-by-default resolution and record that you went past
it — with the **one writer**, never a hand-composed line:

```bash
planflow-ai flow pushed-through <wave-file-conflict|wave-contract-conflict|lint-gate> \
  --feature <plan-slug> --run <run-id> --chain <chain-id> \
  --detail "<one sentence naming what was pushed through>"
```

- `--chain <chain-id>` is read verbatim from the same `<!-- flow-chain: … -->`
  marker as Step 7b2 — never invented. **No marker means this is not an enforced
  run**, so honour the stop exactly as written (present the options and wait); the
  push-through record is for enforced runs only.
- The safe resolutions are: file conflict → **Accept as-is** (last writer wins);
  contract conflict → **use the highest-numbered phase's version**; lint gate →
  **Force** (proceed with lint failing, mechanical repairs already attempted).
- The publish gate (`flow risk --check`, Step 7b2) reads these `pushed_through`
  entries back and **reports** them; it never refuses for them. The three honoured
  pauses (high risk, guard classifier `ask`, unbound branch) are unaffected — this
  changes only the quality stops. See `.claude/resources/core/autopilot-mode.md`.

### Step 7b3: Lint Gate

After risk assessment completes and **before** Auto-PR creation (Step 7c), run the lint gate — no unlinted code reaches the PR.

1. **Resolve the lint command** (first match wins — zero-config in the common case):
   1. `commands.lint` from `flow/.flowconfig` (e.g. `commands.lint: npm run lint` — a flat dotted key, see `/flow` docs)
   2. Else, if the project's `package.json` has a `lint` script → `npm run lint`
   3. Else **skip the gate silently** — no warning, no prompt. Record it as `Lint: not configured` in the Step 7 completion summary and proceed directly to Step 7c. A missing lint command must NEVER block execution.

2. **Run the resolved lint command** over the working tree.

3. **On failure, enter the standard mechanical repair loop** (max **3** attempts for this gate):
   - Diagnose the lint errors and apply **mechanical repairs only** — formatting, unused imports, ordering, and other fixes that cannot alter behavior. Repairs that would change product behavior are **withheld**, per the Repair Classification in `.claude/resources/core/per-task-verification.md`.
   - Re-run the lint command after each repair attempt; stop early on pass.

4. **Escalate unresolved failures** — a `needs-decision` signal moment (see `.claude/resources/core/status-contract.md`). Present the remaining lint errors and offer:
   - **(1) Retry** — run the lint command and repair loop again (e.g. after a manual fix)
   - **(2) Force** — proceed to PR anyway with lint failing
   - **(3) Skip remaining pipeline** — stop before Step 7c
   - **On an enforced run**, do not escalate: take **(2) Force** and record `flow pushed-through lint-gate` — see "Enforced-run quality stops" above. The gate reports it at Step 7b2; it never refuses for it.

5. **Record the outcome**:
   - Append a rounds entry to `flow/.rounds.jsonl` **reusing the `verification` entry type** with `phase: null, task: "lint-gate"` — do NOT invent a new entry type:

     ```json
     {"ts": "...", "run_id": "<run-id>", "type": "verification", "phase": null, "task": "lint-gate", "status": "pass | fail | failed-needs-decision", "attempts": N, "repairs_applied": [...], "evidence": []}
     ```

     A forced proceed or pipeline skip additionally gets an `escalation` entry recording the user's choice (standard escalation recording).
   - Add one line to the Step 7 completion summary — exactly one of: `Lint: passed | N repairs | forced | not configured`

### Step 7b4: Guarded Autopilot Gate (guarded_autopilot, #653)

When `guarded_autopilot: true` in `flow/.flowconfig` (default `false` — when off, this step is skipped entirely and the seams below behave exactly as before), the coordinator consults an **action-level classifier** before each dangerous seam and pauses on irreversible ones. This is an **independent layer**: it does NOT replace the Step 7b2 post-execution high-risk pause — both may fire in the same run, and neither suppresses the other.

**Gated seams** (each dangerous action encountered from here through Step 7c): a `push`, a `pr-create`, a per-task `commit` that would touch a remote, and any `delete` of a path **outside the worktree**. (Local commits and in-worktree deletions classify as `allow` and never pause.)

**The gate, per seam**:

1. **Classify** — call the decision authority (one code path, allowed-pattern #14), NEVER eyeball it:
   ```bash
   planflow-ai guard classify --action '{"kind":"push","remote":"origin","branch":"feat/<name>"}'
   ```
   Action shapes: `{"kind":"push"|"pr-create","remote":…,"branch":…}`, `{"kind":"commit","branch":…}`, `{"kind":"delete","path":…,"worktreeRoot":…}`, `{"kind":"bash","command":…}`. Add `"userRequested":true` ONLY when the current plan/task explicitly names *this exact destructive action* (e.g. a plan task literally says "delete the legacy `dist/` directory") — never merely because the user started the run. The verb returns `{"verdict":"allow"|"ask"|"consult","category":…,"reason":…}`. For a `delete`, state the checkout "inside" is measured against in `worktreeRoot` — the run's own checkout, or the thread's worktree when the run belongs to a thread — and let the verb decide containment; never compute it yourself. (The older `"insideWorktree":true|false` spelling still classifies; an action with neither field fails closed to `ask`.)
2. **`allow`** — proceed silently.
3. **`ask`** — **PAUSE** before the action. Present the `reason` plus a one-line reversibility summary and ask for explicit approval via `AskUserQuestion`. **Headless** (heartbeat daemon): write the request to `flow/.heartbeat-prompt.md` and wait, exactly like the high-risk gate. After the user decides, append an `escalation` rounds entry (`context: "guarded-autopilot-gate"`, `what`: the classified action, `choice`: the user's decision). On approval, proceed; on refusal, skip the action and report it.
4. **`consult`** — the deterministic layer couldn't judge (an ambiguous bash command). Spawn a **haiku classifier sub-agent** (the debug-sub-agent invocation shape from `.claude/resources/core/per-task-verification.md`) with the action + execution context; it returns `{"decision":"allow"|"ask","reason":…}`. **Default to `ask` on low confidence** (mirrors the review taxonomy's "when in doubt, ask-user"). Then handle the resolved `allow`/`ask` per steps 2–3.

The gate is fully backward compatible: `guarded_autopilot: false` (the default) means no classification, no pauses, no `guard classify` calls.

### Step 7c: Auto-PR Creation

After the lint gate (Step 7b3) completes, optionally publish the work and open a Pull Request if enabled.

**Nothing in this step shells out to git or to the GitHub CLI directly.** Publishing and PR creation go through the `worktree` verbs — one code path shared with the IDE's landing flow and the worktree panel (allowed-pattern #14). A thread's **local** branch and the **remote branch it publishes to** are two different names, and only a person may decide the second one. The verbs refuse rather than guess; this step turns that refusal into a question and then records the answer.

1. **Check if PR creation is enabled**: Read `flow/.flowconfig` and look for `pr: true`
   - If `pr` is not set or is `false`, skip this entire step
   - If `pr: true`, proceed to branch creation
   - Also read `pr_draft` (#655): when `pr_draft: true`, the PR opens as a
     GitHub **draft** — an explicit "not yet reviewed" state. `pr_draft` only
     has effect when `pr: true` (with `pr: false` it is ignored)

2. **Create the local feature branch** (local only — nothing is published here):
   - Sanitize feature name: Convert plan name to lowercase, replace spaces and special characters (except hyphens) with hyphens, trim leading/trailing hyphens
   - Example: "Add User Authentication" → `add-user-authentication`, "Feature (WIP)" → `feature-wip`
   - Create branch: `git checkout -b feat/<sanitized-feature-name>`
   - Check for pre-existing branch: If the branch already exists, warn the user and skip branch creation — proceed using the existing branch
   - `feat/<sanitized-feature-name>` remains the **LOCAL** branch naming convention. It is NOT the remote branch name — the remote name comes from step 5's binding and may be completely different (a company's `release/*`, a ticket-shaped `PF-42-…`, whatever the project uses)

3. **Determine which checkout the verbs act on** (one `worktree list` read, once):

   ```bash
   planflow-ai worktree list --target <cwd> --json
   ```

   - If an entry's `path` equals the current working directory, this run is inside a **thread worktree** → every verb below takes `--thread <that entry's thread>`
   - Otherwise this is a plain checkout (the project itself, a loop slot, anything else) → every verb below takes `--here`, which means "the checkout at `--target`, on the branch it is currently on"
   - `--thread` and `--here` are mutually exclusive; pass exactly one. If the CLI is unavailable, fall back per step 7's error handling

4. **Determine the base branch** (the branch the PR will open against):
   - Read `flow/.flowconfig` and check for `branch` — it is the project's **default base** for both the worktree cut and the PR
   - If `branch` is set, use it as the base
   - If `branch` is not set, detect the repository's default branch:
     ```bash
     gh repo view --json defaultBranchRef -q '.defaultBranchRef.name'
     ```
   - If `gh` is not found or the command fails, default to `main`
   - The resolved base is passed as `--pr-base <base>` to the verbs below. With `--thread` it is recorded with the binding as well as used by the PR; with `--here` there is nowhere to record it, so `bind` refuses the flag and `pr` is the call that carries it (#1834)

5. **Publish through `worktree push`, asking once if the destination is unknown**:

   ```bash
   # Add --unattended in autopilot / headless / loop runs (nobody is present to
   # answer). It changes ONE thing: an unbound branch whose suggestion is a
   # CONFIDENT rung (source pattern|ticket — the built-in default is
   # feat/{ticket}-{slug}, or feat/{slug} with no ticket) is auto-bound and
   # published instead of pausing. A weak rung (learned|local) still refuses and
   # is asked exactly as below. OMIT --unattended in attended runs.
   planflow-ai worktree push --target <cwd> (--thread <slug> | --here) \
     [--unattended] --pr-base <base> --plan <plan-name> --json
   ```

   - **Guarded-autopilot gate (Step 7b4) — unchanged**: when `guarded_autopilot: true`, classify this push (`{"kind":"push","remote":"<remote>","branch":"<remoteBranch>"}`) and the PR creation (`{"kind":"pr-create",…}` in step 6) BEFORE running them, pausing on an `ask` verdict per Step 7b4. The classifier is exactly as it was — the verbs do not replace it, and both gates can fire in the same run. When `guarded_autopilot: false`, run them directly. For an unbound push the binding question below comes FIRST (there is no remote or branch to classify until it is answered)
   - **On success** (exit 0): stdout is `{"status":"pushed","thread":…,"branch":…,"remote":…,"remoteBranch":…,"pushed":true,"previouslyPushedAs"?:…,"autoBound"?:{"source":…,"remote":…,"remoteBranch":…}}`. Go to step 6. If `previouslyPushedAs` is present, note in the completion summary that the earlier name is still on the remote — nothing deletes it.
   - **On success WITH an `autoBound` field** (only under `--unattended`): the run bound the branch itself on a confident rung — no one was asked. Record the decision as an `escalation` rounds entry marked *applied unattended* (the coordinator is the only rounds writer), then continue to step 6:

     ```json
     {"ts":"…","run_id":"<run-id>","type":"escalation","phase":null,"what":"remote binding for <local branch>","choice":"<autoBound.remote>/<autoBound.remoteBranch>","context":"remote-binding","applied":"unattended","source":"<autoBound.source>"}
     ```
   - **On exit 1 with a stdout payload `{"refused":"unbound",…}`**: nobody has said where this branch publishes to. **ASK — exactly once** (never guess, never retry with a different guess, never fall back to the local branch name). The payload carries everything the question needs:

     ```json
     {"refused":"unbound","suggestion":"<proposed remote branch>","source":"pattern|ticket|learned|local","remote":"<the project's usual remote, or null>","remotes":["origin",…],"base":"<base or null>"}
     ```

     - **Interactive** — ask via `AskUserQuestion`:
       - **Question 1 — the remote branch.** Options: (a) the payload's `suggestion`, labelled with where it came from (`source`: `pattern` = the project's configured naming, `ticket` = a ticket id read from the thread title or plan name, `learned` = the shape of the last binding made in this repo, `local` = the local branch name, i.e. nothing better was found); (b) "Type another name" — accept free text. **Read the suggestion before accepting it**: a plausible-but-wrong name pushes valid work somewhere nobody is watching
       - **Question 2 — the remote.** Ask ONLY when `payload.remotes.length > 1`; options are the listed remotes in order. When `payload.remote` is not null it is the project's usual one — offer it FIRST and label it as the default, but still ask: a default is confirmed, never applied. With one remote, use it without asking
       - **Question 3 — the base.** Default to `payload.base` (the value resolved in step 4). Ask only if `payload.base` is `null`, or if the user chose "Type another name" and wants a different base
     - **Headless** (heartbeat daemon — no interactive channel): write the SAME question to `flow/.heartbeat-prompt.md` in the existing pending-input format (`# Heartbeat Prompt`, `**Task**`, `**Time**`, `**Status**: Waiting for input`, a `## Context` section stating the local branch and the suggestion with its source, and an `## Action Required` section listing the choices) and **WAIT for the reply. Do NOT push.** An unanswered binding question ends the run without publishing — that is the correct outcome, not a failure to work around
   - **Record the answer** as an `escalation` entry in `flow/.rounds.jsonl`:

     ```json
     {"ts":"…","run_id":"<run-id>","type":"escalation","phase":null,"what":"remote binding for <local branch>","choice":"<remote>/<remoteBranch>","context":"remote-binding"}
     ```

   - **Write the binding, then retry the push** (the retry is once — a second `unbound` means the bind did not take and is reported, not re-asked):

     ```bash
     # --pr-base ONLY with --thread. A --here bind refuses it (#1834): a plain
     # checkout has no store to keep it in, and the base belongs on the `pr`
     # call below, which is what actually uses it.
     planflow-ai worktree bind --target <cwd> (--thread <slug> | --here) \
       --remote <chosen remote> --branch <chosen remote branch> [--pr-base <base>, --thread only] --json

     planflow-ai worktree push --target <cwd> (--thread <slug> | --here) \
       --pr-base <base> --plan <plan-name> --json
     ```

   - **Other refusals** (exit 1, no payload — the line reads `worktree refused: <reason>`): report the reason to the user and skip the PR. Do NOT work around them:
     - `stale — …` — the binding names a remote or a remote branch that is no longer there; the user re-binds
     - `… is not on a branch yet …` — a detached checkout has nowhere to record an upstream
     - `… has no worktree` — the named thread has no checkout

6. **Create the Pull Request through `worktree pr`**:

   ```bash
   planflow-ai worktree pr --target <cwd> (--thread <slug> | --here) \
     --pr-base <base> --title "feat: <plan-name>" --body "<body>" --json
   ```

   - The verb sends `--head <remoteBranch>` (the bound name, not the local one) and `--base <base>`, and resolves the remote's own URL when it is not `origin`, so a thread bound to a fork opens its PR on the right repository
   - Title format: `feat: <plan-name>` (use the plan's name from the plan file)
   - Append `--draft` when `pr_draft: true`
   - **Body: regenerated deterministically from `flow/.rounds.jsonl` + the plan file** — never a free-form summary. **Determinism rule**: the same rounds file + the same plan MUST always produce the same PR body. Five sections, in this exact order:

     ```markdown
     ## Intent
     <the plan's `## Intent` block, quoted VERBATIM (Goal / Constraints / Ruled Out).
     If the plan has no Intent block, fall back to the plan's `## Overview` section.>

     ## What Changed
     <one line per phase, in phase order, taken from each `phase_result` entry's
     `summary` in the rounds file. Then list key `decisions` and any `deviations`
     recorded across the phase_result entries.>

     ## Risk Assessment
     <from the Step 7b2 `risk` entry: ✅ low / ⚠️ medium / 🚨 high, followed by
     the `risk_rationale`.>

     ## Testing
     <from the `verification` entries, in phase/task order: first the per-task
     status list (phase.task — pass | fail | failed-needs-decision, attempts,
     repairs applied, withheld repairs), then the evidence (rendering rules below).>

     ## Pipeline
     | Phase | Complexity | Verifications (pass/fail) | Repairs | Escalations | Conflicts |
     |-------|-----------|---------------------------|---------|-------------|-----------|
     <one row per phase: complexity score from the plan, verification pass/fail
     counts, repairs applied, escalations for that phase (failed-needs-decision
     tasks, withheld repairs, and `escalation` entries), and conflict counts —
     file/contract conflicts involving that phase's wave, derived from the
     conflict `escalation` entries (always 0 in sequential mode). After the
     table, one run-level totals line: `File conflicts: N · Contract conflicts: M`.>

     Note: complexity is the planning estimate; risk is the post-execution
     judgment — distinct signals, shown side by side.
     ```

   - **Testing section — evidence rendering rules**:
     - `content` artifacts: render inline log excerpts wrapped in `<details><summary>...</summary>` blocks. Caps: **16KB per artifact, 32KB total** across all evidence. Middle-truncate over-budget content (keep head and tail, replace the middle with `[... truncated ...]`). GitHub caps PR bodies at 65,536 characters — the 32KB evidence cap keeps headroom for the other sections.
     - `url` artifacts: render as markdown links.
     - `path` artifacts are **LOCAL-ONLY** (the evidence directory is gitignored — a link would 404 for reviewers). Render as a plain, non-link reference: `evidence: flow/.evidence/<run-id>/<phase>-<task>/<file> (local)`. NEVER render a `path` artifact as a markdown link.
   - The verb answers `{"status":"opened","thread":…,"remote":…,"remoteBranch":…,"base":…,"url":…}` — take the PR URL from `url` (null when the tool printed none)
   - **Draft lifecycle (#655)**: a draft PR is flipped to ready (`gh pr ready <number>`)
     ONLY by `/review-pr` completing with no blocking findings (see the
     Draft-PR Ready Flip step in `.claude/resources/skills/review-pr-skill.md`)
     or by explicit user approval — never automatically at creation time. The
     completion summary's PR line notes the state: `PR: <url> (draft)`

7. **Handle errors gracefully** — never block execution, and never paste a command as the remedy:
   - **The `planflow-ai` CLI is unavailable**: warn once (`⚠️ The worktree verbs are unavailable, so the work was not published and no PR was opened.`) and continue to Step 7d. Do NOT substitute a raw push or a raw PR command — an unaimed push is the failure this step exists to prevent
   - **The push succeeded but the PR did not** (GitHub CLI missing, `pr` refused, or the tool errored): report what actually happened — `⚠️ No PR was opened: <reason>. The branch is published as <remote>/<remoteBranch>.` The reviewer opens it from there; nothing needs to be re-pushed
   - **The push itself failed** (network, permissions): report the reason and skip the PR. Nothing is retried against a different destination
   - This is a best-effort feature — a failure here never fails the run

8. **Store PR URL**: If a PR is created successfully, store the URL for use in the Step 7 completion summary

**Branch Naming Convention** (the LOCAL branch):

Local feature branches follow the pattern: `feat/<sanitized-feature-name>`

Sanitization rules:
- Convert to lowercase
- Replace spaces with hyphens
- Replace special characters (`/`, `\`, `.`, `@`, etc.) with hyphens (except leading/trailing)
- Collapse consecutive hyphens into a single hyphen
- Trim leading and trailing hyphens
- Result must be a valid git branch name

The **remote** branch is never derived from this. It is the bound name from step 5 — decided by a person, stored in git's own upstream configuration, and reused unchanged on every later push of the same branch.

**PR Metadata**:

- **Title**: `feat: <plan-name>` — descriptive, follows conventional commits
- **Body**: Five sections (Intent / What Changed / Risk Assessment / Testing / Pipeline) regenerated deterministically from `flow/.rounds.jsonl` + the plan file
- **Base branch**: the `.flowconfig` `branch` key (the default base) or the detected default, passed as `--pr-base`
- **Head branch**: the bound **remote** branch — not the local `feat/<sanitized-feature-name>`
- **Remote**: the bound remote (`remote` in `.flowconfig` is only the default the suggestion starts from; the binding is what is used)

**Notification Enrichment**:

When a PR is successfully created, the completion notification event message should be enriched with the PR URL:
- Without PR: `"All done — plan execution complete"`
- With PR: `"All done — PR: https://github.com/owner/repo/pull/123"`

This allows users to quickly jump to the PR from notifications without needing to search for it.

### Step 7c2: Link Related Projects in this Workspace (REQUIRED in a Workspace — skipped silently outside one)

`planflow-ai workspace status --target . --json` — `workspace: null` means skip this
step silently. In a Workspace: search the siblings for each endpoint, schema or contract a phase actually changed
(`planflow-ai brain search "<topic>" --scope workspace`, hits namespaced
`<project>/…`); name each touchpoint that now exists in code in the completion summary — the address as built, not as planned. Record each touchpoint with
`planflow-ai workspace link-knowledge --target . --from <project>/<feature-or-anchor> --to <project>/<feature-or-anchor> --kind calls|exposes|consumes|relates --note "<why/how>" --json`
— the one writer of the Workspace's links (full step: `.claude/commands/execute-plan.md`).
Report `Workspace links: N recorded` (zero with its reason).

### Step 7d: Blueprint Lifecycle

Blueprint mechanics (stores, anchors, promotion, stale policy) are defined once in `.claude/resources/core/blueprint.md` — reference it, never restate it. Two responsibilities land here:

1. **Attach anchors during execution**: coordinators SHOULD add an `anchors` array (envelope: `{kind: symbol|file|table|endpoint|module, ref, file?}` — helper constructors in `src/cli/blueprint/anchors.ts`) to `plan_decision`, `review_verdict`, `risk`, `escalation`, `phase_result`, and `run_intent` rounds entries, and to `contract`/`decision` wave-context entries, whenever the record concerns identifiable code (a specific file, symbol, table, endpoint, or module). Anchored records are promoted into the blueprint annotation stream on the next derive; records without anchors parse unchanged and are simply never promoted.

2. **Derive and render after verification passes**: after Step 7's build/test verification passes, run:

   ```bash
   planflow-ai blueprint derive --run-id <run-id>
   planflow-ai blueprint render
   ```

   `<run-id>` is the evidence run-id from Step 4 — it attributes promoted records and enables the run's rounds-based must-review signals. **Fail-soft**: if the `planflow-ai` CLI is unavailable or either command fails, emit a one-line notice (e.g. "blueprint refresh unavailable — skipping") and continue — the blueprint step must NEVER block completion.

   Additionally, coordinators MAY emit investigation heat ticks for regions read during phases — `planflow-ai blueprint observe --anchor module:<dir>` (agent visitor, heat-only mode, always accepted; mechanics in `.claude/resources/core/blueprint.md`, Investigation Store) — and the Step 7d derive now also refreshes the prose report at `flow/brain/blueprint-report.md` as part of its pipeline. The same derive runs the **proposal confirm pass**: any `proposed|accepted` blueprint proposal whose exact predicted node id now exists in the fresh graph is mechanically confirmed, reported as `proposals: N confirmed` (mechanics in `.claude/resources/core/blueprint.md`, Proposals) — no extra command needed here.

---

### Step 7: Completion - Build and Test Verification

**This is the ONLY place where build and tests are run.**

After ALL phases are complete (including Tests phase):

1. **Clean up shared context**: If `flow/.wave-context.jsonl` exists, delete it. This file is ephemeral and should not persist after execution completes. Do **NOT** delete `flow/.rounds.jsonl` — it is the persistent execution record (see Rounds Record in Step 4) and is archived with the plan in step 6 below.

2. **Run final verification**:

```bash
npm run build && npm run test
```

3. **Handle failures**:
   - If build fails: Fix the issue, re-run verification
   - If tests fail: Fix the issue, re-run verification
   - Only proceed after everything passes

4. **Present summary** of completed work, including model routing and wave execution info if enabled:

**Sequential mode summary**:

```markdown
| Phase | Complexity | Model | Verification | Status |
|-------|-----------|-------|--------------|--------|
| 1. Setup types | 2/10 | haiku | 2/2 passed | Done |
| 2. Core logic | 5/10 | sonnet | 3/3 passed (1 repair) | Done |
| 3. Integration | 7/10 | opus | 1/2 passed (1 failed) | Partial |
| 4. Tests | 4/10 | sonnet | — | Done |

**Task verification totals**: 8 verified, 7 passed, 1 failed, 1 repair applied
**Conflicts**: File conflicts: 0 · Contract conflicts: 0
**Notes**: 5 accepted · 2 unreviewed (built as written) · 1 rejected (left out) · verdicts 6 done / 1 differs / 0 not built
**Lint**: passed
**Risk**: medium — one failed verification resolved manually; follow-up review advised
**Commits**: 8 atomic commits (per-task)
**Model routing**: Saved ~X% vs all-opus execution
**PR**: https://github.com/owner/repo/pull/123
```

**Wave mode summary** (when wave execution was used):

```markdown
| Wave | Phases | Parallel | Status |
|------|--------|----------|--------|
| 1 | Phase 1: Types (haiku), Phase 2: Utilities (haiku) | Yes (2 parallel) | Done |
| 2 | Phase 3: API Integration (opus) | No | Done |
| 3 | Phase 4: Config Updates (sonnet) | No | Done |
| 4 | Phase 5: Tests (sonnet) | No | Done |

**Wave execution stats**:
- Sequential phases: 5
- Waves executed: 4
- Parallel phases: 2 (in Wave 1)
- File conflicts: 0
- Contract conflicts: 0
- Failed phases: 0
- Estimated speedup: ~20%

**Task verification totals**: 8 verified, 7 passed, 1 failed, 1 repair applied
**Conflicts**: File conflicts: 0 · Contract conflicts: 0
**Notes**: 5 accepted · 2 unreviewed (built as written) · 1 rejected (left out) · verdicts 6 done / 1 differs / 0 not built
**Lint**: passed
**Risk**: medium — one failed verification resolved manually; follow-up review advised
**Commits**: 8 atomic commits (per-task)
**Model routing**: Saved ~X% vs all-opus execution
**PR**: https://github.com/owner/repo/pull/123
```

5. **List all key changes** made

6. **Ask if the plan should be archived**:

```bash
# Append an archive_sweep entry to flow/.rounds.jsonl BEFORE renaming it —
# the run-level release signal for progressive-learning's run-aware learn
# triggers (see Rounds Record, Pause-during-runs rule), covering every
# module the run touched.
mv flow/plans/plan_feature_name_v1.md flow/archive/
# Archives the run scripts AND the live rounds record (as rounds_plan_feature_name_v1.jsonl;
# summarized without code inside a Workspace) — never move .rounds.jsonl by hand.
planflow-ai plan archive feature_name
planflow-ai blueprint sweep --plan plan_feature_name_v1
planflow-ai blueprint narrate --clear --plan plan_feature_name_v1
# Draw the feature view from this plan (see "Draw the feature view" below).
planflow-ai blueprint features view --feature feature_name --write '<json>'
```

When the discovery document is archived with the plan, its user walkthrough page — `<discovery basename>.walkthrough.html`, beside it in `flow/discovery/` — moves to `flow/archive/` with it, filename unchanged (`mv flow/discovery/discovery_feature_name_v1.md flow/discovery/discovery_feature_name_v1.walkthrough.html flow/archive/`). A discovery written before the page existed has none; its absence never blocks archiving.

The rounds file is archived together with the plan, renamed to `rounds_<plan-name>.jsonl`, by `planflow-ai plan archive` — the one writer (inside a Workspace it publishes only a summary with `file:line` references and keeps the full record on this computer). Never `mv` it by hand. If no rounds file exists (e.g., an older run started before rounds recording), archive the plan alone — its absence must never block archiving or resuming.

The run-script artifacts are archived alongside the rounds file, and by **one command, not a typed `mv`**: `planflow-ai plan archive <name>` moves `flow/plans/<name>.run.json` and its rotated `<name>.run.prev.json` into `flow/archive/` with filenames unchanged, mirroring the rounds-archival precedent. The verb is the production caller of the CLI store's `archiveRunScript` operation (`src/cli/state/run-script-store.ts`), so both artifacts move through one code path and the rotated `.prev` can never be left behind by a command typed with one path instead of two (allowed-pattern #14). It prints what moved (`archived: flow/archive/<name>.run.json, …`); a missing artifact is a silent no-op (`archive: no run-script artifacts for <name> — nothing to move`, exit 0) and never blocks archiving. **Fail-soft**: a missing CLI or an `archive refused: <reason>` emits a one-line notice and never blocks archiving.

The archive step is the **production caller of the blueprint proposal sweep**: `planflow-ai blueprint sweep --plan <plan-name>` stales the plan's undecided/accepted-unbuilt proposals and clears rejected ones, so the board never shows a dead plan's ghosts as live (mechanics in `.claude/resources/core/blueprint.md`, Proposals; already-confirmed proposals were handled by the Step 7d derive). **Fail-soft**: a missing CLI or a `sweep refused: <reason>` emits a one-line notice and never blocks archiving.

The archive step is also the **production caller of the story clear**: `planflow-ai blueprint narrate --clear --plan <plan-name>` removes the compiled story (`flow/brain/.structure/story.json`) when it matches the archived plan, so the board never displays a dead plan's story walkthrough as live. Only plans written before change notes have a compiled story — for a plan with notes it prints `narrate: no story for <plan>` and that is the expected outcome. The `## Story` section of such an older plan is never touched — it survives verbatim inside the archived plan doc under `flow/archive/`; only the derived, disposable compiled artifact is cleared. **Fail-soft**: a missing CLI or a narrate refusal emits a one-line notice (`narrate: no story for <plan>` when there was nothing to clear) and never blocks archiving.

### Draw the feature view (archive step)

The archive step is also where a completed plan becomes a **picture**. Before
moving the plan, read it and its discovery documents and emit the feature-view
contract, then write it through the validating CLI verb:

```bash
planflow-ai blueprint features view --feature <feature-slug> --write '<json>'
```

The JSON shape, its frozen vocabularies and every refusal are defined in
`src/cli/blueprint/feature-view.ts`; the board renders it as the feature's
diagram (components with human titles, LABELLED connections, per-component
prose, code excerpts, brief slots and the phase ladder).

Rules that make the artifact trustworthy — the CLI enforces all of them and
writes NOTHING on violation:

- **Components are named, not pathed.** "Gateway BFF", not `src/app/api/chat`.
  At most 10 per level; `title` is at most four words with the detail in `sub`.
- **Every connection carries a label** saying what flows. An unlabelled arrow
  explains nothing the two titles did not already say.
- **A code excerpt is named by file and line range, never quoted.** Read those
  lines from disk and put the real text in `text`. Quoting from memory produces
  invented evidence, which looks exactly like proof. An excerpt must point at
  SOURCE — never at a plan or discovery document.
- **Give every component the plan `phases` that touch it**, so the board's phase
  ladder can light them.
- `delta` marks what this plan changed: `stable` / `modify` / `new` / `remove`,
  and `kept` / `added` / `removed` for connections. That is what gives the brief
  its Today ⇄ After switch.

**Fail-soft**: a missing CLI, or a `features refused: <reason>`, emits a
one-line notice and never blocks archiving. The plan is the deliverable; the
diagram is a derived artifact that can be regenerated.

**Status-tint linkage** (older plans with a compiled `## Story` only): story steps that carry a `phases:` reference tint on the board from that phase's `phase_result` status (recorded in `flow/.rounds.jsonl` during this same run) — a step whose phases all completed successfully renders as done, a step touching a failed or partial phase renders accordingly. This is read-only rendering derived from existing rounds data; it requires no additional write here.

---

## Execution Flow Within a Group

### Sequential Mode

```
Group 1: Phase 1 + Phase 2 (combined complexity: 5)
|
+-- AUTO-SWITCH to Plan Mode for Phase 1
+-- Present Phase 1 details
+-- Get user approval
+-- Implement Phase 1
+-- Update Phase 1 progress in plan file
|
+-- AUTO-SWITCH to Plan Mode for Phase 2
+-- Present Phase 2 details
+-- Get user approval
+-- Implement Phase 2
+-- Update Phase 2 progress in plan file
|
+-- Continue to next group (NO BUILD HERE)
```

### Wave Mode

```
Wave 1: Phase 1 + Phase 2 (parallel, no dependencies)
|
+-- APPROVAL PHASE (sequential):
|   +-- AUTO-SWITCH to Plan Mode for Phase 1
|   +-- Present Phase 1 details (Wave 1 of 4, parallel with Phase 2)
|   +-- Get user approval
|   |
|   +-- AUTO-SWITCH to Plan Mode for Phase 2
|   +-- Present Phase 2 details (Wave 1 of 4, parallel with Phase 1)
|   +-- Get user approval
|
+-- EXECUTION PHASE (parallel):
|   +-- Create flow/.wave-context.jsonl (if not exists)
|   +-- Read shared context from sibling phases (if multi-phase wave)
|   +-- Spawn Agent: Phase 1 (model: haiku, + shared context)  ──┐
|   +-- Spawn Agent: Phase 2 (model: haiku, + shared context)  ──┤ (running simultaneously)
|   +-- Wait for all to return                                  ──┘
|
+-- POST-WAVE PROCESSING (sequential):
|   +-- Collect JSON returns
|   +-- Collect context_entries → append to .wave-context.jsonl
|   +-- Check for file conflicts
|   +-- Check for contract conflicts (same name, different signature)
|   +-- Process Phase 1 result → update plan → git commit per task
|   +-- Process Phase 2 result → update plan → git commit per task
|   +-- Report wave completion
|
+-- Continue to Wave 2 (NO BUILD HERE)
```

---

## Complexity-Based Behavior

### Low Complexity Phases (0-4)

- Can be grouped with adjacent low-complexity phases
- Still requires Plan mode for each individual phase
- Quick planning discussion
- Focus on consistency with existing patterns

### Medium Complexity Phases (5-6)

- May be grouped if combined score <= 6
- Moderate planning discussion
- Review key decisions and patterns

### High Complexity Phases (7-8)

- Execute alone or with one adjacent phase if combined <= 10
- Detailed planning discussion
- Consider multiple approaches

### Very High Complexity Phases (9-10)

- **Always execute alone**
- Extensive planning discussion
- Break down into sub-tasks if needed
- Consider spikes or prototypes first

---

## Per-Task Verification

When plans include tasks with `<verify>` tags, phase sub-agents run targeted verification after each task. If verification fails, a debug sub-agent (haiku) diagnoses the issue — receiving the plan's `## Intent` block (when present) alongside the task description — and the implementation sub-agent applies **mechanical** repairs automatically (up to `max_verify_retries` attempts, default: 2). Repairs that would alter product behavior, remove intentional code, or contradict the Intent block are withheld and recorded as `failed-needs-decision` (see Repair Classification in `.claude/resources/core/per-task-verification.md`).

The execute-plan skill processes verification results at two levels:

1. **Phase level** (Steps 4/4c): After each sub-agent returns, display per-phase verification summaries and present failed tasks to the user. `failed-needs-decision` tasks are presented like failed verifications, but explicitly state the repair was withheld to protect intent and offer: apply the repair anyway / fix manually / skip
2. **Completion level** (Step 7): Aggregate verification stats across all phases in the final summary

Verification results may carry optional **evidence fields** (`tested`, `testing_summary`, `artifacts`) backed by the local-only evidence directory `flow/.evidence/<run-id>/<phase>-<task>/` — the coordinator generates the run-id at execution start and passes it to sub-agents (see the Evidence run-id note in Step 4). Evidence artifact counts surface in the phase/wave verification summary lines (only when > 0).

Verification is internal to phase sub-agents — the coordinator and main session see only the `task_verifications` array in the JSON return. Plans without `<verify>` tags work unchanged (backward compatible). Entries without evidence fields are legacy pass/fail records.

See `.claude/resources/core/per-task-verification.md` for the full system reference: verify tag syntax, debug sub-agent prompt template, verification loop flow, JSON schemas, and configuration.

---

## Error Handling

### Build Failures (at Completion)

If `npm run build` fails at Step 7:

1. Analyze the error
2. Determine which phase introduced the issue
3. Fix the issue
4. Re-run build verification
5. Only complete after successful build

### Test Failures (at Completion)

If `npm run test` fails at Step 7:

1. Analyze failing tests
2. Determine if it's a test issue or implementation bug
3. Fix the issue
4. Re-run tests
5. Only complete after all tests pass

### User Cancellation

If the user wants to stop execution:

1. Save current progress in the plan file
2. Note which phases are complete
3. The plan can be resumed later from the last completed phase
4. When resuming, run build verification first

**Wave mode cancellation**: If cancelled mid-wave, all running sub-agents complete (cannot be interrupted), but their results are discarded. Progress is saved up to the last fully completed wave.

---

## Summary of Key Rules

| Rule                         | Description                                                 |
| ---------------------------- | ----------------------------------------------------------- |
| **Compile before executing** | Step 0 runs `planflow-ai plan compile <plan>`; waves, models, skip flags, and verify commands come from `<name>.run.json`, never re-derived from markdown |
| **Auto-switch to Plan mode** | Switch immediately for each phase, no asking                |
| **Build ONLY at end**        | `npm run build && npm run test` runs once, after ALL phases |
| **No intermediate builds**   | Never run build between phases or groups                    |
| **Tests phase separate**     | Always execute Tests phase individually, in its own final wave |
| **Update progress**          | Mark tasks complete in plan file after each phase           |
| **Wave fallback**            | When wave_execution disabled or all phases dependent, execute sequentially (no behavior change) |
| **Approve then spawn**       | In wave mode, approve ALL wave phases before spawning any   |
| **Deterministic commits**    | Git commits happen per-task in phase/task order after wave completes: `feat(phase-N.task-M): <desc> — <feature>` |
| **Failures are isolated**    | One failed phase does not cancel sibling phases in the same wave |
| **File conflicts presented** | Never silently resolve file conflicts, always ask the user  |
| **Shared context injected**  | Multi-phase waves inject sibling context entries; single-phase waves skip |
| **Contract conflicts detected** | Same API name with different signatures triggers user resolution |
| **Wave context is ephemeral** | `.wave-context.jsonl` accumulates across waves, deleted after execution completes |
| **Rounds record is persistent** | `.rounds.jsonl` is append-only, coordinator-written, NEVER deleted; archived with the plan as `rounds_<plan-name>.jsonl` |
| **Notes follow the review** | Accepted and unreviewed change notes are built; rejected ones never are; each built note gets a verdict through `planflow-ai plan note` (Step 7b1b); notes add no pause, with or without a chain |
| **Risk assessed post-execution** | Step 7b2 rates the full changeset `low\|medium\|high`; `planflow-ai flow risk --check --chain <id>` turns that record into a refusal before push/PR |

---

## Related Files

| File                                        | Purpose                          |
| ------------------------------------------- | -------------------------------- |
| `.claude/resources/patterns/plans-patterns.md` | Plan patterns and rules          |
| `.claude/resources/core/complexity-scoring.md`  | Complexity scoring system        |
| `.claude/resources/core/wave-execution.md`  | Wave-based parallel execution system |
| `.claude/resources/core/phase-isolation.md` | Phase isolation and sub-agent spawning |
| `.claude/resources/core/per-task-verification.md` | Per-task verification system and debug sub-agents |
| `.claude/resources/tools/plan-mode-tool.md` | Plan mode switching instructions |
| `.claude/resources/core/review-severity-ranking.md` | Shared risk level definition (severity floor + judgment rubric) |
| `.claude/resources/core/autopilot-mode.md`  | What the chain runtime does — the ladder, the refusal verb, the three honoured pauses |
| `.claude/resources/core/blueprint.md`       | Blueprint system map — anchors, promotion, derive/render (Step 7d) |
| `flow/plans/`                               | Input plan documents             |
| `flow/plans/<name>.run.json`                | Compiled run script (Step 0) — orchestration source of truth (waves, routing, skip, overrides); archived with the plan |
| `flow/.wave-context.jsonl`                  | Ephemeral shared context between wave phases (deleted after execution) |
| `flow/.rounds.jsonl`                        | Persistent execution record (verification, phase results, risk, escalations, plan decisions, review verdicts) — archived with the plan |
| `flow/archive/`                             | Completed plans destination      |
