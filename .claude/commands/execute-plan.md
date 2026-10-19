---
description: This command executes an implementation plan phase by phase, using complexity scores and wave-based parallel execution to determine ex
---

# Execute Implementation Plan

## Command Description

This command executes an implementation plan phase by phase, using complexity scores to determine execution strategy. When `wave_execution: true` in `.flowconfig` (default), phases are analyzed for dependencies, grouped into **waves** of independent phases, and executed in parallel within each wave using Agent sub-agents. Tasks with `<verify>` tags are verified immediately after completion — failures are auto-diagnosed by debug sub-agents and repaired in place (up to `max_verify_retries` attempts). The command validates inputs and orchestrates the execution process by invoking the `execute-plan` skill.

**Output**: Implements all phases from the plan (sequentially or in parallel waves), updates progress, and auto-archives the completed plan and its discovery document.

---


## Help

**If the user invokes this command with `-help`, display only this section and stop:**

```
/execute-plan - Execute Implementation Plan

DESCRIPTION:
  Executes an implementation plan phase by phase, using complexity scores
  to determine execution strategy. Analyzes phase dependencies and groups
  independent phases into parallel waves for faster execution. Switches
  to Plan mode for each phase.

USAGE:
  /execute-plan <plan_file>
  /execute-plan -help

ARGUMENTS:
  plan_file   Path to the plan file in flow/plans/

EXAMPLES:
  /execute-plan @flow/plans/plan_user_auth_v1.md
  /execute-plan @flow/plans/plan_dark_mode_v2.md

OUTPUT:
  - Implements all phases from the plan
  - Updates plan file with completed tasks
  - Runs build/test verification at the end
  - Auto-archives completed plan and discovery

WORKFLOW:
  1. Reads and parses the plan file, and its change notes
     (unreviewed notes are built as written; rejected notes are left out)
  2. Groups phases by complexity score
  2b. Analyzes dependencies and groups into waves (if wave_execution enabled)
  3. Presents wave execution summary (waves, parallelism, estimated speedup)
  4. For EACH wave:
     - Approves each phase in Plan mode (sequential)
     - Executes wave phases in parallel (or sequential if single phase)
     - Collects results, detects file conflicts
     - Commits per-task in phase/task order (if git enabled)
  5. Records a verdict per change note (done / differs / not built)
  6. Runs npm run build && npm run test (ONLY at the end)
  7. Auto-archives plan and discovery to flow/archive/

EXECUTION STRATEGIES:
  Combined Score <= 6   Aggregate phases together
  Combined Score 7-10   Cautious, 1-2 phases at a time
  Combined Score > 10   Sequential, one phase at a time
  Tests Phase           Always executed separately

SAFETY:
  - Database/ORM commands are NEVER run directly
  - User is asked to execute migrations manually
  - Prevents accidental data loss

RECOMMENDED MODEL:
  Claude Opus 4.6 or Sonnet 4.5 for best results

RELATED COMMANDS:
  /create-plan       Create a plan first
  /discovery-plan    Run discovery before planning
```

---

> **Autopilot chains this for you.** When a chain is driving, the harness issues the next stage from observable state — no command decides on its own whether to continue, and before it issues one it runs `planflow-ai flow stage <stage> --check --feature <slug> --chain <id>`, which refuses a stage whose predecessor left no proof for this run's feature — a refusal stops the chain, it never advances past it. The message that started you names the slug to write your document under; name it anything else and the next stage is refused. Three pauses are honoured and no others: `high` risk before anything is published (`planflow-ai flow risk --check`), the guard classifier's `ask`, and a branch nobody has bound at publish time. Outside a chain the standard rules below apply — stop and wait for the user.
>
> **Change notes are the same under a chain.** Unreviewed notes are built as written and rejected notes are left out whether a chain is driving or a person typed the command; the notes add no pause and no question of their own, and the completion summary says how many were unreviewed.
>
> **Under a chain, the git tail is not yours.** Do not commit, push or open a pull request when the phases finish: the chain does that after the review, which is the better order (a review that runs on already-published work reviews nothing that can still be changed cheaply). One behaviour, two triggers — a manual or headless run keeps its own tail at Step 7c.
>
> **On an enforced run, the three quality stops do not pause the flow.** A wave file conflict, a wave contract conflict and a failing lint gate normally stop and ask you to choose. When this run is enforced (a `<!-- flow-chain: … -->` marker rides on the message that started it), take the safe-by-default resolution and RECORD that you went past it with `planflow-ai flow pushed-through <stop> --feature <slug> --run <run-id> --chain <id>` — the one writer, never a hand-composed line. This is not a sequencing decision and it is not conditioned on any config key: it is scoped to an enforced run and it only replaces a mid-run pause with a recorded push-through. The three honoured pauses are unchanged. See skill Step "Enforced-run quality stops" and `.claude/resources/core/autopilot-mode.md`.

## Critical Rules

| Rule                     | Description                                              |
| ------------------------ | -------------------------------------------------------- |
| **Build ONLY at End**    | Do NOT run build after each phase - only at the very end |
| **No Direct DB/ORM**     | NEVER run ORM or database commands directly              |
| **Compact at Boundaries**| After each phase, if context is heavy, run `/compact` with execution state (see Step 5b in skill) |
| **Complete and Stop**    | After execution, STOP. Under a chain, the harness decides what follows |
| **No Plan Mode**         | Never enter the agent's built-in plan mode. The plan is already written and reviewed; execute it |

---

## CRITICAL RULE: No Direct Database or ORM Commands

**NEVER execute any of the following commands directly:**

- `prisma migrate`
- `prisma db push`
- `prisma db seed`
- `prisma generate` (allowed - this is safe)
- `npx prisma ...` (except generate)
- `python manage.py migrate`
- `alembic upgrade`
- `sequelize db:migrate`
- `typeorm migration:run`
- `drizzle-kit push`
- Any direct SQL execution
- Any database connection/query commands

**ALWAYS ask the user to execute these commands manually:**

```markdown
## Action Required: Database Migration

The following command needs to be executed manually:

\`\`\`bash
npx prisma migrate dev --name add_user_table
\`\`\`

**Why manual execution is required:**
- Database operations can be destructive
- User should verify the migration before applying
- Prevents accidental data loss

Please run this command and let me know when it's complete.
```

**Safe commands (can be executed directly):**
- `prisma generate` - Only generates client, no DB changes
- `prisma format` - Only formats schema file
- Reading schema files

---

## CRITICAL RULE: Build Verification ONLY at the End

**DO NOT run `npm run build` after each phase or group.**

**`npm run build` and `npm run test` MUST ONLY be executed at the very end, after ALL phases (including Tests) are complete.**

---

## Per-Task Verification

When plan phases include tasks with `<verify>` tags, each task is verified immediately after completion using targeted commands (e.g., `npx tsc --noEmit <file>`). Failed verifications trigger a debug sub-agent (haiku) for diagnosis, and the implementation sub-agent applies repairs automatically.

### Configuration

| Setting | Default | Range | Description |
|---------|---------|-------|-------------|
| `max_verify_retries` | `2` | `1-5` | Max repair attempts per task verification failure |

Set via `/flow max_verify_retries=3` or directly in `flow/.flowconfig`.

Plans without `<verify>` tags work unchanged — verification is fully backward compatible.

See `.claude/resources/core/per-task-verification.md` for verify tag syntax, debug sub-agent details, and JSON schemas.

---

## Git Control

On execution start, check if `flow/.flowconfig` exists — if yes, read git control settings (`commit`, `push`, `branch`) from it. Fallback: check `flow/.gitcontrol` for backward compatibility. If neither exists, no git operations are performed.

Commits are made directly. **Publishing and PR creation are not** — they go through the worktree verbs (`planflow-ai worktree push` / `worktree pr`), the same code path the IDE's landing flow uses. A branch's **local** name and the **remote branch it publishes to** are separate: the local name is ours, the remote side belongs to the project's conventions, and nothing here guesses it. A branch nobody has aimed yet is refused, and `/execute-plan` asks once (skill Step 7c).

### Git Control Settings

```yaml
# flow/.gitcontrol
commit: true     # Auto-commit after each completed task (per-task atomic commits)
push: true       # Publish after all phases complete (requires commit: true)
branch: develop  # Default BASE — the branch a PR opens against (optional)
pr: true         # Auto-create PR after publishing (requires push: true)

# flow/.flowconfig only — these shape the SUGGESTION offered when a branch is
# unaimed; neither is ever applied without a person confirming it
remote: origin               # Default remote offered first (default: origin)
remote_branch_pattern: ...   # Optional naming template, e.g. release/{ticket}
```

### Git Behavior During Execution

| Setting | Behavior |
|---------|----------|
| `commit: true` | After each task completes successfully, commit: `git add -A && git commit -m "feat(phase-N.task-M): <desc> — <feature>"` |
| `commit: false` or no `.gitcontrol` | No automatic git operations (default behavior) |
| `push: true` | After ALL phases complete AND build/test pass, publish through the worktree push verb — the local branch goes to the remote branch it is bound to. If nothing has said where it publishes, the run asks once (interactively, or via the pending-input file when headless), records the answer, binds and retries. It never falls back to the local name |
| `push: false` or not set | No automatic publishing |
| `branch: <name>` | The project's default **base** — the branch a PR opens against, and the branch a worktree is cut from. It is NOT a push destination (default: the repository's detected default branch) |
| `pr: true` | After publishing, open a PR through the worktree pr verb — head is the bound **remote** branch, base is `branch`. PR body = five sections (Intent / What Changed / Risk Assessment / Testing / Pipeline) regenerated deterministically from `flow/.rounds.jsonl` + the plan file (see skill Step 7c) |
| `pr: false` or not set | No automatic PR creation |
| `remote: <name>` | The remote offered first when a binding is being decided (default: `origin`). A default for the question, never for the answer |
| `remote_branch_pattern: <template>` | An optional naming template (`{ticket}`, `{slug}`, `{local}`, `{user}`) used to propose a remote branch name. Proposed only — a person still confirms it |

### Git Safety Rules

| Rule | Description |
|------|-------------|
| **Commit only on success** | Only commit after a phase completes successfully. Never commit broken code. |
| **Push only after build+test** | Push only after `npm run build && npm run test` pass at the very end. |
| **No force push** | NEVER use `--force`. If push fails, stop and ask the user. |
| **Commit message format** | `feat(phase-N.task-M): <desc> — <feature>` (e.g., "feat(phase-2.task-1): Implement auth middleware — user-auth") |
| **Final commit** | After build+test pass, make one final commit: `Complete: <feature> — all phases done, build passing` |
| **Include flow artifacts** | Commits should include updated plan files with progress markers |
| **PR best-effort** | If PR creation fails, warn and continue — say the branch is published and where. Never block completion. |
| **Branch naming** | LOCAL feature branches use feat/<sanitized-feature-name> (lowercase, hyphens only). The REMOTE branch is whatever the binding says — never derived from the local name |
| **Never guess a destination** | An unaimed branch is a question, not a default. Ask once, record the answer, bind, retry. No fallback push |

### Example Flow with `commit=true push=true pr=true`

```
Phase 1: Setup types (2 tasks)
  → git commit "feat(phase-1.task-1): Define user and session types — user-auth"
  → git commit "feat(phase-1.task-2): Create user schema with Prisma — user-auth"
Phase 2: API endpoints (2 tasks)
  → git commit "feat(phase-2.task-1): Implement auth middleware — user-auth"
  → git commit "feat(phase-2.task-2): Add rate limiting to API routes — user-auth"
Phase 3: Frontend UI (1 task)
  → git commit "feat(phase-3.task-1): Create login form component — user-auth"
Phase 4: Tests (1 task)
  → git commit "feat(phase-4.task-1): Add unit tests for auth flow — user-auth"
Build + Test → pass → git commit "Complete: user-auth — all phases done, build passing (vX.Y.Z)"
                     → git checkout -b feat/user-auth          (LOCAL branch)
                     → planflow-ai worktree push --here --pr-base development --plan user-auth --json
                          refused: unbound — nobody has said where 'feat/user-auth' publishes to
                          suggestion: release/ACME-2446  (source: pattern)
                       ask once → user picks release/ACME-2446 on origin
                          escalation recorded: "remote binding for feat/user-auth" → origin/release/ACME-2446
                     → planflow-ai worktree bind --here --remote origin \
                          --branch release/ACME-2446 --json
                          (no --pr-base: a --here bind refuses it — nowhere to
                           record it — and `pr` below carries the base instead)
                     → planflow-ai worktree push --here --pr-base development --plan user-auth --json
                          pushed: feat/user-auth → origin/release/ACME-2446
                     → planflow-ai worktree pr --here --pr-base development \
                          --title "feat: user-auth" \
                          --body "<five-section body regenerated from flow/.rounds.jsonl + the plan:
                                   Intent / What Changed / Risk Assessment / Testing / Pipeline>"
                          opened: origin/release/ACME-2446 → development
```

The next push of the same branch asks nothing — the binding is in git's own upstream
configuration and is simply reused. Inside a thread's worktree the verbs take
`--thread <slug>` instead of `--here`; everything else is identical.
---

## Instructions

### Step 1: Validate Inputs

| Input       | Required | Description                        |
| ----------- | -------- | ---------------------------------- |
| `plan_file` | Yes      | Path to plan file in `flow/plans/` |

If no plan is specified, list available plans in `flow/plans/` and ask user to select one.

**Important**: NEVER read or reference files in `flow/archive/` - these are outdated plans.

---

### Step 2: Validate Plan File

1. Read the specified plan file
2. Verify it contains phases with complexity scores
3. If complexity scores are missing, prompt user to add them

---

### Step 3: Invoke Execute Plan Skill

The skill will:

1. Parse the plan and extract phases
2. Read the plan's change notes once — `planflow-ai plan notes <plan> --json` — and, when it has any, say one line: `Notes: U unreviewed — built as written; R rejected — left out`. Each phase's sub-agent gets that phase's accepted and unreviewed notes as instructions and its rejected notes (with reason and comments) as "do not build" (skill Step 1b)
3. Analyze complexity and determine execution strategy
4. Present execution plan summary
5. Record where the run starts — once, at execution start, right after the run-id is generated and before the first phase: `planflow-ai flow run-start --plan <plan-slug> --run <run-id> --json`. This is the ONE writer of the start `run_intent` (it records the commit the run starts from as `base`, which the board's Today ⇄ After comparison reads) — never hand-compose that line. A refusal (no git repository, no commit yet) is reported in one line and the run continues
6. For each phase:
   - Auto-switch to Plan mode
   - Present phase details
   - Get user approval
   - Implement the phase
   - Update progress
7. After all phases, check each built note against the real diff (`planflow-ai blueprint storyline --plan <plan-slug> --file <note file>`, or the diff from the run's start) and record its verdict with `planflow-ai plan note <plan> --note <n> --verdict done|differs|not-built --why "<one sentence>"` — the one writer; rejected notes get no verdict (skill Step 7b1b). This runs before the risk assessment and the build/test gate
8. Run final build and test verification
9. Present completion summary

See: `.claude/resources/skills/execute-plan-skill.md`

---

### Step 3b: Link Related Projects in this Workspace (REQUIRED in a Workspace — skipped silently outside one)

Projects of one Workspace share knowledge, and the touchpoints between them are
recorded as you work — not reconstructed later.

```bash
planflow-ai workspace status --target . --json
```

`workspace: null` → skip this step and say nothing about it. Otherwise:

1. Search the sibling projects for each endpoint, schema or contract a phase actually changed:
   `planflow-ai brain search "<topic>" --scope workspace` — hits are namespaced
   `<project>/…`; a `link` hit is a touchpoint someone already recorded.
2. Name each touchpoint that now exists in code in the completion summary — the address as built, not as planned.
3. Record each touchpoint (the one writer — never edit `links.jsonl` by hand):

   ```bash
   planflow-ai workspace link-knowledge --target . \
     --from <project>/<feature-or-anchor> --to <project>/<feature-or-anchor> \
     --kind calls|exposes|consumes|relates --note "<one line of why/how>" --json
   ```

   `<project>` is a slug from `workspace status` (`project.slug`, `siblings[].slug`);
   the ref is a feature slug or an anchor (`endpoint:POST /api/orders`,
   `file:src/screens/Orders.tsx`, `module:src/api`). Example: a new backend endpoint the frontend checkout screen calls → `--from backend/endpoint:POST /api/orders --to frontend/file:src/screens/Checkout.tsx --kind exposes`. Record it after the phase that built it is verified, with the real path. Recording the same
   link twice is a no-op. A `workspace refused: <reason>` line comes with a JSON
   payload naming the valid slugs or kinds — correct the address from it once, or
   report the refusal verbatim.

**Verification (MANDATORY in a Workspace)**:

```
Workspace links: N recorded    # or: Workspace links: 0 recorded — <why no project was touched>
```

---

### Step 4: Handle Completion

After the skill completes:

1. Present summary of all changes made
2. Confirm all tests pass
3. **Auto-archive** the completed plan and its discovery document to `flow/archive/`:
   - Move the plan file from `flow/plans/` to `flow/archive/`
   - Find and move the matching discovery document from `flow/discovery/` to `flow/archive/`, together with its user walkthrough page (`<discovery basename>.walkthrough.html`, beside it) when present — the page is part of the discovery and is archived with it
   - Archive `flow/.rounds.jsonl` as `flow/archive/rounds_<plan-name>.jsonl` (if present) with `planflow-ai plan archive <plan-name>` — never a hand `mv` (inside a Workspace the verb publishes only a code-free summary)
   - Do NOT ask the user — archive automatically
4. Present completion summary:

```markdown
Plan done: `<plan-name>`.

- Phases: X of Y done
- Tests: passed
- Build: passed
- Notes: A accepted · U unreviewed (built as written) · R rejected (left out) · verdicts D done / X differs / N not built
- Lint: <passed | N repairs | forced | not configured>
- Risk: <low|medium|high> — <one-sentence rationale>
- Workspace links: <N recorded>
- PR: <url>        # or: PR: skipped
- Archived: plan, discovery, rounds record
```

Write the chat summary in short, clear sentences (ASD-STE100 style); say it once; do not repeat a finished result.

- Show the `Notes:` line only when the plan has change notes.
- Show the `Workspace links:` line only in a Workspace (Step 3b).
- Take `Risk:` from skill Step 7b2.
- Use `PR: skipped` when `pr` is `false`.

---

## Flow Diagram

```
+------------------------------------------+
|        /execute-plan COMMAND             |
+------------------------------------------+
                    |
                    v
+------------------------------------------+
| Step 1: Validate Inputs                  |
| - Check for plan file                    |
| - List available plans if needed         |
+------------------------------------------+
                    |
                    v
+------------------------------------------+
| Step 2: Validate Plan File               |
| - Verify phases have complexity scores   |
+------------------------------------------+
                    |
                    v
+------------------------------------------+
| Step 2b: Wave Analysis (if enabled)      |
| - Parse Dependencies from each phase     |
| - Build dependency graph                 |
| - Group independent phases into waves    |
+------------------------------------------+
                    |
                    v
+------------------------------------------+
| Step 3: Invoke Execute Plan Skill        |
| - Present wave execution summary         |
| - Execute waves (parallel or sequential) |
| - See execute-plan-skill.md             |
+------------------------------------------+
                    |
                    v
+------------------------------------------+
| Step 4: Handle Completion                |
| - Present summary with wave stats        |
| - Auto-archive plan and discovery        |
+------------------------------------------+
```

---

## Example Usage

**User**: `/execute-plan @flow/plans/plan_realtime_notifications_v1.md`

**Execution**:

1. Validate input: plan file provided
2. Verify plan has complexity scores
3. Invoke execute-plan skill
4. Skill executes all phases with Plan mode
5. Final build and test verification
6. Auto-archive plan and discovery to flow/archive/

## Context Loading

This command uses the **project brain** for context retrieval. Before executing, query it for relevant documentation:

**Queries**:
- `planflow-ai state-query "phase execution" --scope resources`
- `planflow-ai state-query "wave execution" --scope resources`
- `planflow-ai state-query "phase isolation" --scope resources`
- `planflow-ai state-query "per-task verification" --scope resources`
- `planflow-ai state-query "atomic commits" --scope resources`

The brain returns ranked chunks from indexed markdown files. Use the top results to inform execution.

---

## Related Resources

| Resource                   | Purpose                           |
| -------------------------- | --------------------------------- |
| `per-task-verification.md` | Per-task verification system, debug sub-agents, JSON schemas |
| `execute-plan-skill.md`   | Skill that executes the plan      |
| `plans-patterns.md`       | Rules and patterns for plans      |
| `complexity-scoring.md`   | Complexity scoring system         |
| `plan-mode-tool.md`       | Plan mode switching instructions  |
| `/create-plan` command     | Create a plan first               |
| `/discovery-plan` command  | Run discovery before planning     |

---

## STATE.md Updates

Update `flow/STATE.md` at these transition points to enable session resumability. Use the Edit tool for single-field updates; overwrite the file on skill start.

**Format**: the exact syntax — bullet grammar, section headings, em dashes, field order — is pinned in `.claude/resources/core/state-md.md`. The reader is a strict regex; a file that drifts from that grammar parses to an empty state, silently.

| Transition Point | Action |
|-----------------|--------|
| **Plan start** | Create `flow/STATE.md` with `- **Active Skill**: execute-plan`, `- **Active Plan**: {feature}` — the `{feature}` in `plan_{feature}_v{N}.md`, never a path — `- **Current Phase**: none`, empty Decisions/Blockers/Files Modified, and `## Next Action`: `Begin phase execution` |
| **Phase start** | Update `Current Phase: {N} — {Phase Name}`, `Current Task: first task description`, `Next Action: Implement phase {N}` |
| **Phase complete** | Append to `Completed Phases` list: `Phase N: Name — {outcome}`, set `Current Phase: none`, `Current Task: none`, `Next Action: Begin next phase` |
| **Decision made** | Append to `## Decisions`: `{description} (reason: {rationale})` |
| **Blocker encountered** | Append to `## Blockers`: `{description} (status: open, tried: {what was attempted})` |
| **Files modified** | Append new file paths to `## Files Modified` (deduplicate) |
| **Plan complete** | Rewrite `flow/STATE.md` keeping `- **Active Skill**: execute-plan`, `- **Active Plan**: {feature}` and the full `Completed Phases` list, and set `- **Current Phase**: none`, `- **Current Task**: execution complete`, `## Next Action`: `Run /review-code for {feature}` |
| **User cancellation** | Update `## Next Action` to `Resume from phase {N}`, keep STATE.md intact for resumability |

**Wave mode**: Update STATE.md before each wave starts (set current wave info) and after each wave completes (update completed phases for all wave phases).

**Never delete `flow/STATE.md` on completion.** The state exists for whoever comes next: the run that picks up the review stage reads `Active Plan` to find this pipeline, and an absent file reads as nothing in flight. Completion is a write, not a cleanup. If `Active Plan` already names a *different* feature when execution finishes, another pipeline is mid-flight — leave the Execution State fields as they are and record the completion under `## Decisions` instead of blanking a live handoff.

**Field syntax**: every field is a bullet under a `## Execution State` heading — `- **Active Skill**: {value}` — with a top-level `**Updated**: {ISO-8601}` line above it and the next step on its own line under `## Next Action`. `Current Phase` is read only as `{N} — {Name}`, and a completed phase only as `Phase {N}: {Name} — {outcome}`. The reader (`src/cli/state/state-md-parser.ts`) is a strict line parser: a field written any other way is dropped silently.

---

## Brain Capture

After each phase completes (and after full execution), append brain-capture blocks. See `.claude/resources/core/brain-capture.md` for processing rules.

**Capture the following per phase**:

```
<!-- brain-capture
skill: execute-plan
feature: [feature name]
phase: [phase number and name]
status: [completed/failed]
data:
  complexity: [phase complexity score]
  errors_hit: [list of errors encountered, if any]
  user_corrections: [any user interventions]
  files_changed: [list of files modified/created]
-->
```

**Capture at execution end**:

```
<!-- brain-capture
skill: execute-plan
feature: [feature name]
status: [completed/partial/failed]
data:
  phases_completed: [X of Y]
  build_result: [pass/fail]
  test_result: [pass/fail]
-->
```

Update `flow/brain/features/[feature-name].md` with execution results. If errors were hit, create/update `flow/brain/errors/[error-name].md`.

The file MUST carry `capture: brain` in its frontmatter — that key is how the store tells a captured note from a capability, and a note without it is drawn on the Blueprint board as a feature of the product.

---

## Tasklist Updates

Update `flow/tasklist.md` at these points. See `.claude/resources/core/project-tasklist.md` for full rules.

1. **On start**: Add "Execute: {feature}" to **In Progress** (or move it from To Do if it already exists)
2. **On complete**: Move "Execute: {feature}" to **Done** with today's date
3. **Next step**: Add "Review code for {feature}" to **To Do**

---

## Learn Recommendations

After execution completes (or at the end of each phase), check for learning opportunities. See `.claude/resources/core/learn-recommendations.md` for the full system.

**Quick checks at phase end**:
- Were new dependencies added? → Recommend `/learn <dependency>`
- Were non-trivial errors resolved (3+ attempts)? → Recommend `/learn` (pattern extraction)
- Did the user correct the approach? → Recommend `/learn <corrected-topic>`
- Was a new technology/pattern introduced? → Recommend `/learn <topic>`

**Present batched recommendations** at the end of execution, before the final summary. Do NOT interrupt phase execution.

---

## Resource Capture

During this skill's execution, watch for valuable reference materials worth preserving. See `.claude/resources/core/resource-capture.md` for capture rules, file format, and naming conventions.

At natural break points, if you encounter information that could be useful for future development (API specs, architecture notes, config references, domain knowledge, etc.), ask the user: "I found something that could be useful for future reference: _{brief description}_. Should I save it to `flow/resources/`?"

Only save if the user approves. Do not re-ask if declined.

---

## Pattern Capture

During execution, silently watch for recurring conventions, anti-patterns, workarounds, and user corrections. Append captured patterns to `flow/resources/pending-patterns.md` without interrupting work.

After all phases complete (before brain-capture), present any buffered patterns for user approval. Approved patterns are written to `.claude/rules/core/allowed-patterns.md` or `.claude/rules/core/forbidden-patterns.md`.

See `.claude/resources/core/pattern-capture.md` for buffer format, capture triggers, conflict detection, and the full review protocol.

---

## Design Awareness

During execution, when a phase involves UI work and the discovery document contains a `## Design Context` section, auto-inject the design tokens into the phase implementation prompt. This ensures UI phases follow the established design system.

See `.claude/resources/core/design-awareness.md` for UI phase detection heuristics and injection rules.

---

## Model Routing

Routing is on by default (`model_routing: true`): each phase is automatically routed to the most cost-effective model based on its complexity score. Set `model_routing: false` in `flow/.flowconfig` to run every phase on the most capable model instead:

| Complexity | Tier | Claude Code Model |
|-----------|------|-------------------|
| 0-3 | Fast | haiku |
| 4-5 | Standard | sonnet |
| 6-10 | Powerful | opus |

Routing happens at Step 4 of the execution skill — the phase implementation is spawned as an Agent subagent with the appropriate `model` parameter. Planning/approval steps always use the session model.

Disable with `/flow model_routing=false`. See `.claude/resources/core/model-routing.md` for full tier table, platform mappings, and aggregation rules.

---

## Wave Execution

When `wave_execution: true` in `flow/.flowconfig` (default), the coordinator analyzes phase dependencies, groups independent phases into **waves**, and executes phases within each wave **in parallel** using Agent sub-agents. Waves are sequenced — Wave N+1 starts only after all Wave N phases complete.

Key behaviors:
- **Planning stays sequential** — each phase is approved in Plan mode before wave execution begins
- **Tests never parallel** — tests phase always runs alone in the final wave
- **Backward compatible** — plans without `Dependencies` fields execute sequentially (no behavior change)
- **File conflict detection** — overlapping files_modified between parallel phases are flagged for user resolution
- **Deterministic commits** — git commits happen per-task in phase/task order after each wave completes: `feat(phase-N.task-M): <desc> — <feature>`

User can always choose sequential execution at the wave summary prompt. Disable globally with `/flow wave_execution=false`.

See `.claude/resources/core/wave-execution.md` for the full dependency analysis rules, wave grouping algorithm, parallel spawning rules, coordinator behavior, and configuration.

---

## Phase Isolation

When `phase_isolation: true` in `flow/.flowconfig` (default), each phase implementation runs in an **isolated Agent sub-agent** with a clean context window. The sub-agent receives only: phase spec, files modified so far, project pattern loading instructions (reuse verified supplied rules; read missing rules), and design context (if UI phase). It returns a structured JSON summary (1-2K tokens) with status, files changed, decisions, errors, and captured patterns.

This eliminates context rot — phase 7 has the same quality as phase 1. Planning/approval stays in the main session; only the implementation step is isolated.

Disable with `/flow phase_isolation=false`. See `.claude/resources/core/phase-isolation.md` for the full context template, return format schema, and coordinator processing rules.

