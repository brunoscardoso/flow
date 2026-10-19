
## Plan Template

Use this template when creating new implementation plans:

**Authorship (frontmatter)**: `author` is the name from `git config user.name` (name only — never the email); `decided_by` is the person who approved the plan. When `git config user.name` is empty, leave the frontmatter out rather than inventing a name.

```markdown
---
author: {git config user.name}
decided_by: {git config user.name of the person who approved the plan}
---

# Plan: [Feature Name]

**Project**: [[{project-name}]]

## Overview

[Brief description of the feature and its purpose]

**Based on Discovery**: `flow/discovery/discovery_<feature>_v1.md` (or "Discovery skipped")

## Intent

**Goal**: [2–3 sentences: what the user is trying to accomplish and why]

**Constraints**:

- [Key constraint that shapes the implementation]
- [Key constraint that shapes the implementation]

**Ruled Out**:

- [Approach deliberately rejected] — [one-phrase reason]
- [Approach deliberately rejected] — [one-phrase reason]

## Goals

- [Goal 1]
- [Goal 2]
- [Goal 3]

## Non-Goals

- [What this plan explicitly does NOT cover]

## Requirements Summary

### Functional Requirements

- [FR-1]: [Description]
- [FR-2]: [Description]

### Non-Functional Requirements

- [NFR-1]: [Description]

### Constraints

- [C-1]: [Description]

## Risks

| Risk     | Impact          | Mitigation           |
| -------- | --------------- | -------------------- |
| [Risk 1] | High/Medium/Low | [Mitigation strategy]|

## Phases

### Phase 1: [Phase Name]

**Scope**: [What this phase covers]
**Complexity**: X/10
**Dependencies**: None
**Files**: `path/to/file.ts`, `path/to/other.ts`

- [ ] Task 1
  <verify>npx tsc --noEmit src/path/to/file.ts</verify>
- [ ] Task 2

#### Change notes

- note: 1 · change · file:path/to/file.ts:existingFunction
    where: `[a short piece of today's code inside existingFunction]`
    what: [what changes, one or two sentences]
    why: [why]

**Build Verification**: Run `npm run build`

### Phase 2: [Phase Name]

**Scope**: [What this phase covers]
**Complexity**: X/10
**Dependencies**: Phase 1
**Files**: `path/to/file.ts`, `path/to/other.ts`

- [ ] Task 1
- [ ] Task 2

#### Change notes

- note: 2 · new · file:path/to/other.ts:newFunction
    signature: [newFunction(arg: Type): Result]
    purpose: [what it is for]
    callers: [existingFunction]

**Build Verification**: Run `npm run build`

### Phase N: Tests (Final)

**Scope**: Write comprehensive tests
**Complexity**: X/10
**Dependencies**: Phase 1, Phase 2, ..., Phase N-1
**Files**: `path/to/file.test.ts`, `path/to/other.test.ts`

- [ ] Unit tests for logic hooks
- [ ] Unit tests for utilities
- [ ] Integration tests

#### Change notes

- note: 3 · file · file:path/to/file.test.ts
    where: `[a short piece of today's code where the cases go, found once in the file]`
    what: [the cases this file adds]
    why: [what they guard]

**Build Verification**: Run `npm run build && npm run test`

## Key Changes

1. **[Category]**: [Description of change]
2. **[Category]**: [Description of change]
3. **[Category]**: [Description of change]
```

A plan has **no `## Story` section** — the change notes inside each phase are the
plan's review. Older plans that carry one still parse and run unchanged.

---

## Change Notes

Every phase carries a `#### Change notes` block: the plan as a review of the code
change, in words. The person accepts or rejects each note (with comments) in the
code story before `/execute-plan` builds it; execution builds accepted and
unreviewed notes, never rejected ones, and records a verdict per note afterwards.
One parser reads the block (`src/cli/state/change-notes.ts`) for the CLI,
`plan compile` and the app.

### Grammar

```markdown
#### Change notes

- note: 4 · change · file:src/cli/commands/plan.ts:runPlanNotes
    where: `const result = await readPlanNotes(planArg, { target: options.target });`
    what: also report how many notes carry each verdict
    why: the completion summary and Verify read one count instead of recounting
- note: 5 · new · file:src/cli/state/change-notes.ts:countVerdicts
    signature: countVerdicts(notes: ChangeNote[]): VerdictCounts
    purpose: one count of done / differs / not-built shared by the reader and compile
    callers: readPlanNotes, compileRunScript
- note: 6 · file · file:src/cli/commands/plan.test.ts
    where: `describe('readPlanNotes — the reader', () => {`
    what: cases for a plan with every verdict and with none
    why: the count is what the completion summary prints
```

| Kind | Target | Fields |
|------|--------|--------|
| `change` | `file:<path>:<function>` (`Class.method` allowed) | `where:` (backticked quote of today's code inside the function), `what:`, `why:` |
| `new` | `file:<path>:<function>` | `signature:`, `purpose:`, `callers:` (comma-separated existing functions) |
| `file` | `file:<path>` | `what:`, `why:`, and `where:` (optional: a backticked quote of today's code found once in the whole file — give it whenever the change has a place) |

A target may carry a sibling Workspace project's slug: `api/file:src/routes/orders.ts:createOrder`.

Written later, never by the plan's author:

| Field | Written by | Values |
|-------|-----------|--------|
| `status:` | the person's review, through `planflow-ai plan note` | `proposed` (also what a missing line means), `accepted`, `rejected — <reason>` |
| `comments:` + `- <text>` lines | the agent revising the plan after a review | in order |
| `verdict:` | `/execute-plan`, through `planflow-ai plan note` | `done`, `differs`, `not-built` — each with ` — <one sentence why>` |

### Rules

1. **Notes for the main changes only** — the functions where the plan's logic or a decision lives, the points a reviewer could disagree with. Aim for 3–8 notes for the whole plan; never more than 10. A repeated, mechanical edit (the same parameter passed through several functions, a rename, imports, wiring, tests) gets **one** note on the function where it matters, naming the others in `what:` — never one note each. A phase with nothing a reviewer must decide has no notes block. A change outside any function that still matters is a `file` note.
   **Prefer a function note.** The review draws each note on its code: a `change` note lands on its function's lines, a `file` note on the place its `where:` quotes. A file note whose change has a place (a route table's entry, a fixture, a test's `describe`) quotes it with `where:` — without one the review can only show the file's first lines.
2. **Numbered across the plan**, in phase order — never restarting per phase.
3. **The quote is a place, not a line number.** Copy a short piece of today's code from the real file that occurs exactly once inside that function (a file note's: exactly once in the whole file). `planflow-ai plan notes <plan> --check --json` refuses a quote found zero or two-plus times, and `/create-plan` must pass it before finishing.
4. **No code of the change, ever** — notes are words. A function that does not exist yet is a `new` note.
5. **Never hand-write `status:` or `verdict:`** — `planflow-ai plan note` is the one writer.

---

## Intent Section

The optional `## Intent` section is a condensed statement of the user's intent, distilled from the discovery document. Downstream execute, review, and repair prompts inject this block **verbatim** so agents can tell a deliberate decision apart from a mistake — an approach listed under "Ruled Out" should never be re-suggested as a fix or flagged as an oversight.

### Structure

- **Goal** — 2–3 sentences on what the user is trying to accomplish and why
- **Constraints** — bullet list of the key constraints that shape the implementation
- **Ruled Out** — bullet list of approaches deliberately rejected, each with a one-phrase reason

### Rules

1. **Optional**: Plans without an `## Intent` section execute unchanged (backward compatible)
2. **Target 150–250 tokens total** — condensed, but complete
3. **Self-contained**: The block is injected verbatim into other prompts, so it must stand alone — no references like "see section 3" or "as discussed in discovery"
4. **Placement**: Directly after `**Based on Discovery**`, before `## Goals`

---

## Dependencies Field

The optional `**Dependencies**` field declares which phases must complete before a phase can start. This enables wave-based parallel execution.

### Syntax

- `**Dependencies**: None` — Phase has no dependencies and can run in the first wave (parallel with other independent phases)
- `**Dependencies**: Phase 1, Phase 3` — Phase depends on Phases 1 and 3 completing first
- **Omitting the field entirely** — Backward-compatible default; phase depends on the immediately previous phase (sequential execution)

### Rules

1. The Tests phase (always last) depends on ALL prior phases — it is never parallelized
2. Phases with `Dependencies: None` form the first execution wave
3. A phase cannot depend on itself or on phases that come after it
4. When in doubt, omit the field to default to sequential execution

### Example

```markdown
### Phase 1: Types and Schemas
**Scope**: Define TypeScript types
**Complexity**: 3/10
**Dependencies**: None

### Phase 2: Config Parser
**Scope**: Implement config parsing
**Complexity**: 4/10
**Dependencies**: Phase 1

### Phase 3: CLI Commands
**Scope**: Implement CLI interface
**Complexity**: 4/10
**Dependencies**: Phase 1

### Phase 4: Integration
**Scope**: Connect all pieces
**Complexity**: 5/10
**Dependencies**: Phase 2, Phase 3

### Phase 5: Tests (Final)
**Scope**: Write comprehensive tests
**Complexity**: 5/10
**Dependencies**: Phase 1, Phase 2, Phase 3, Phase 4
```

In this example, Phases 2 and 3 can run in parallel (both only depend on Phase 1). Phase 4 waits for both 2 and 3. Phase 5 (tests) waits for everything.

### Structural Analysis Annotations (engine-dependent)

When the optional **graphify engine** is enabled (`engines.graphify: enabled` in `flow/.flowconfig` — mechanics in `.claude/resources/core/graphify-engine.md`), `/create-plan` may add **purely advisory** structural-analysis annotations. Plans created without the engine never contain them.

**Italic-line convention** — placed directly under a phase's `**Dependencies**` field when that phase shares blast radius with an earlier phase and no dependency between them is authored:

```markdown
### Phase 3: CLI Commands
**Scope**: Implement CLI interface
**Complexity**: 4/10
**Dependencies**: Phase 1
_structural analysis: shares blast radius with Phase 2 via `src/config/parser.ts` — consider `Dependencies: Phase 2`_
```

**Execution Strategy note** — a `**Structural conflict predictions**` line in the `## Execution Strategy` section listing predicted same-wave file conflicts:

```markdown
**Structural conflict predictions** (graphify, advisory): Phase 2 ↔ Phase 3 — overlapping blast radius via `src/config/parser.ts`; if scheduled in the same wave, expect a file conflict.
```

**Rules**:

1. **Advisory only**: annotations are suggestions from structural analysis — structural coupling is not an execution-order dependency
2. **Authored fields always win**: annotations never replace or modify a `**Dependencies**` field; `/execute-plan` wave computation reads only the `Dependencies` field and ignores annotation lines
3. **Engine-dependent**: absent, declined, or failed engine means no annotations — the plan format is otherwise unchanged (backward compatible)

---

## Verify Tag

The optional `<verify>` tag allows tasks to include a verification command that runs immediately after the task completes. This enables early error detection — failures are caught per-task instead of waiting until the final build step.

### Syntax

Add a `<verify>` tag indented under a task checkbox:

```markdown
- [ ] Create type definitions in `/src/types/workflow.ts`
  <verify>npx tsc --noEmit src/types/workflow.ts</verify>
```

The `<verify>` tag contains a single shell command that validates the task's output. The command should be **targeted** (single file or narrow scope) rather than a full build.

### Rules

1. **Optional**: Tasks without a `<verify>` tag skip verification entirely (backward compatible)
2. **One command per tag**: Each `<verify>` tag contains exactly one shell command
3. **Targeted checks only**: Use single-file or narrow-scope commands — never full builds
4. **Indented under the task**: The `<verify>` tag must be indented under its parent task checkbox
5. **No verify for manual-review tasks**: Config files, documentation, and other tasks requiring human judgment should omit `<verify>`

### Examples

**Task with verification:**

```markdown
- [ ] Create `UserProfile` type in `/src/types/user.ts`
  <verify>npx tsc --noEmit src/types/user.ts</verify>
- [ ] Write unit tests for user validation
  <verify>npx jest src/types/__tests__/user.test.ts --no-coverage</verify>
```

**Task without verification (backward compatible):**

```markdown
- [ ] Update `.flowconfig` with new setting
- [ ] Add documentation for the new feature
```

**Mixed phase (some tasks verified, some not):**

```markdown
### Phase 2: Backend Implementation

**Scope**: Implement API routes and data layer.
**Complexity**: 6/10
**Dependencies**: Phase 1

- [ ] Create API route handler in `/src/routes/workflow.ts`
  <verify>npx tsc --noEmit src/routes/workflow.ts</verify>
- [ ] Add database migration for `workflow_steps` table
- [ ] Create service layer in `/src/services/workflow.ts`
  <verify>npx tsc --noEmit src/services/workflow.ts</verify>

**Build Verification**: Run `npm run build`
```

### Heuristic Reference

When writing plans, use these heuristics to decide which tasks get `<verify>` tags:

| Task Type | Verify Command | Example |
|-----------|---------------|---------|
| File creation (`.ts`) | `npx tsc --noEmit <file>` | `npx tsc --noEmit src/types/user.ts` |
| Test writing | `npx jest <test-file> --no-coverage` | `npx jest src/__tests__/user.test.ts --no-coverage` |
| Schema/type definition | `npx tsc --noEmit <type-file>` | `npx tsc --noEmit src/types/schema.ts` |
| Config file changes | No verify (manual review) | — |
| Documentation | No verify (manual review) | — |
| Generic/ambiguous tasks | No verify (default) | — |

---

## Phase Templates

### Types and Schemas Phase

```markdown
### Phase 1: Types and Schemas

**Scope**: Define all TypeScript types and Zod schemas needed for the feature.
**Complexity**: 3/10
**Dependencies**: None

- [ ] Create type definitions in `/src/types/`
  <verify>npx tsc --noEmit src/types/feature.ts</verify>
- [ ] Create Zod validation schemas in `/src/types/rest-inputs.ts`
  <verify>npx tsc --noEmit src/types/rest-inputs.ts</verify>

**Build Verification**: Run `npm run build`
```

### Backend Implementation Phase

```markdown
### Phase 2: Backend Implementation

**Scope**: Implement API routes and commands.
**Complexity**: 7/10
**Dependencies**: Phase 1

- [ ] Create command in `/src/commands/`
  <verify>npx tsc --noEmit src/commands/feature.ts</verify>
- [ ] Create API route in `/src/app/api/`
  <verify>npx tsc --noEmit src/app/api/feature/route.ts</verify>
- [ ] Add database operations if needed

**Build Verification**: Run `npm run build`
```

### Store and State Management Phase

```markdown
### Phase 3: Store and State Management

**Scope**: Implement Zustand stores for state management.
**Complexity**: 5/10
**Dependencies**: Phase 1

- [ ] Create or extend store in `/src/stores/`
  <verify>npx tsc --noEmit src/stores/featureStore.ts</verify>
- [ ] Add actions and selectors

**Build Verification**: Run `npm run build`
```

### UI Components Phase

```markdown
### Phase 4: UI Components

**Scope**: Build the user interface components.
**Complexity**: 6/10
**Dependencies**: Phase 3

- [ ] Create logic hook (`useFeatureLogic.internal.ts`)
  <verify>npx tsc --noEmit src/components/feature/useFeatureLogic.internal.ts</verify>
- [ ] Create view component (`index.tsx`)
  <verify>npx tsc --noEmit src/components/feature/index.tsx</verify>
- [ ] Follow view/logic separation pattern

**Build Verification**: Run `npm run build`
```

### Integration Phase

```markdown
### Phase 5: Integration

**Scope**: Connect all pieces and verify functionality.
**Complexity**: 4/10
**Dependencies**: Phase 2, Phase 4

- [ ] Integrate components with pages
- [ ] Connect to API endpoints
- [ ] Verify end-to-end flow

**Build Verification**: Run `npm run build`
```

### Tests Phase (Always Last)

```markdown
### Phase N: Tests (Final)

**Scope**: Write comprehensive tests for all new code.
**Complexity**: 5/10
**Dependencies**: Phase 1, Phase 2, Phase 3, Phase 4, Phase 5

- [ ] Unit tests for logic hooks (`*.client.test.ts`)
  <verify>npx jest src/components/feature/__tests__/useFeatureLogic.test.ts --no-coverage</verify>
- [ ] Unit tests for utility functions
  <verify>npx jest src/utils/__tests__/feature.test.ts --no-coverage</verify>
- [ ] Integration tests for API routes
  <verify>npx jest src/app/api/feature/__tests__/route.test.ts --no-coverage</verify>
- [ ] Command tests
  <verify>npx jest src/commands/__tests__/feature.test.ts --no-coverage</verify>

**Build Verification**: Run `npm run build && npm run test`
```

---

## Key Changes Examples

```markdown
## Key Changes

1. **New API Endpoint**: Added `/api/v1/agents/workflow` for workflow management
2. **Database Schema**: New `workflow_steps` table with foreign key to `agents`
3. **Store Update**: Extended `agentStore` with workflow state management
4. **Component Addition**: New `WorkflowEditor` component in `/src/components/agent/`
5. **Type Definitions**: Added `WorkflowStep` and `WorkflowConfig` types in `/src/types/workflow.ts`
```

---

## Complexity Summary Example

```markdown
## Complexity Summary

| Phase | Complexity | Description               |
| ----- | ---------- | ------------------------- |
| 1     | 3/10       | Types and schemas         |
| 2     | 7/10       | Backend implementation    |
| 3     | 5/10       | Store and state           |
| 4     | 6/10       | UI components             |
| 5     | 4/10       | Integration               |
| 6     | 5/10       | Tests                     |

**Total Phases**: 6
**Average Complexity**: 5/10
**Highest Complexity**: Phase 2 at 7/10
```

---

## Execution Strategy Example

```markdown
## Execution Strategy

Based on complexity scores (per `.claude/resources/core/complexity-scoring.md`):

- **Phases 1-2**: Execute separately (Phase 2 is 7/10)
- **Phases 3-4**: Can be aggregated (combined complexity: 11, but cautious)
- **Phase 5**: Can aggregate with Phase 6 if simple
- **Phase 6**: Tests - always execute separately

Based on dependency graph (when Dependencies fields are present):

- **Wave 1**: Phase 1 (no dependencies)
- **Wave 2**: Phases 2, 3 (both depend only on Phase 1 — run in parallel)
- **Wave 3**: Phases 4, 5 (depend on earlier waves)
- **Wave 4**: Phase 6 (Tests — always sequential, always last)
```
