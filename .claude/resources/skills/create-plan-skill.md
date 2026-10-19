
# Create Plan Skill

## Purpose

Create a structured **implementation plan** with phases, complexity scores, and tasks based on a discovery document or user requirements.

This skill **only produces a markdown file** in `flow/plans/`. It does NOT:

- Write any code
- Execute any implementation
- Modify source files
- Run build or test commands

---

## Restrictions - PLANNING ONLY

This skill is **strictly for creating plan documents**. The process:

1. **Reads** the discovery document or gathers requirements
2. **Analyzes** complexity and scope
3. **Structures** phases with complexity scores
4. **Distills** a condensed Intent block from the discovery document
5. **Analyzes** phase independence for parallel execution
6. **Generates** verify sections for applicable tasks
7. **Authors** change notes inside each phase — one per function changed or added, quoting today's code — and checks every quote resolves (`plan notes --check`)
8. **Generates** a plan markdown file

**No code, no implementation, no source file modifications.**

### NEVER Do These Actions

| Forbidden Action                    | Reason                           |
| ----------------------------------- | -------------------------------- |
| Create/edit source code files       | Planning only, no implementation |
| Write implementation code           | Plans describe what, not how     |
| Execute any plan phases             | Use /execute-plan for that       |
| Run build or test commands          | No execution commands            |
| Create files outside `flow/plans/`, `flow/brain/.structure/`, `flow/.rounds.jsonl` | Only plan documents, blueprint proposals, and plan decisions |

### Allowed Actions

| Allowed Action                         | Purpose                           |
| -------------------------------------- | --------------------------------- |
| Read discovery documents               | Extract requirements              |
| Read any project file                  | Understand existing codebase      |
| Search codebase (grep, glob, semantic) | Find existing patterns            |
| Write to `flow/plans/`                 | Save plan document                |
| Read project rule files                | Understand patterns to follow     |
| Run `planflow-ai plan notes <plan> --check --json` | Check every change note's quote resolves once in today's code (Step 6c). READ-ONLY |
| Run `planflow-ai blueprint propose` | Record predicted nodes (Blueprint Proposals). Writes `flow/brain/.structure/proposals.jsonl` |
| Append to `flow/.rounds.jsonl`         | Record `plan_decision` entries (Step 7) |

> **Important**: The ONLY writable locations are `flow/plans/` (the plan document), `flow/brain/.structure/` (proposals, via the `planflow-ai blueprint` CLI only), and `flow/.rounds.jsonl` (plan decisions). No source code or other files should be modified.

---

## Inputs

| Input                | Required | Description                                        |
| -------------------- | -------- | -------------------------------------------------- |
| `discovery_document` | **Required** | Path to discovery document. Plans cannot be created without one. |
| `feature_name`       | Yes      | Name of the feature to plan                        |
| `requirements`       | Optional | Direct requirements if no discovery document       |
| `version`            | Optional | Version number (auto-incremented if not provided)  |

---

## Workflow

### Step 1: Validate Discovery Document (HARD BLOCK)

**A discovery document is REQUIRED. No exceptions.**

1. Check if a discovery document was provided or exists in `flow/discovery/`
2. **If NO discovery document exists**: **STOP immediately.** Do NOT create a plan. Inform the user that discovery is required and run `/discovery-plan` first.
3. **If discovery document exists**: Read it and extract:
   - Feature name, description, goals
   - FR, NFR, Constraints
   - Risks identified
4. **Treat the user walkthrough page as illustration** — the discovery's
   artifact, `<discovery basename>.walkthrough.html` beside it, when one was
   generated (`/artifact`; most discoveries have none). It is **illustration for humans, not
   requirements**: a picture of what users will see, written so the person
   deciding whether the feature is right can judge it. Requirements come from
   the FR / NFR / Constraints sections, never from a mockup's pixels or sample
   copy. You do not need to read it to plan. **Never lift its HTML into the
   plan** — not as a task, not as a code block, not as an acceptance criterion.
   The page is markup styled to look right in a sandboxed frame; copying it
   would hand an implementation phase a second, unreviewed source of truth for
   UI that the Design Context and the real components already own. A UI phase
   may *reference* a walkthrough step by title when that helps a reader, and
   nothing more.

---

### Step 2: Analyze Scope and Complexity

Based on extracted requirements:

1. Identify the major components/areas of work
2. Group related tasks into logical phases
3. Estimate complexity for each phase using `.claude/resources/core/complexity-scoring.md`

---

### Step 3: Structure Phases

Create phases following these guidelines:

**Phase Structure**:

```markdown
### Phase X: [Phase Name]

**Scope**: [What this phase covers]
**Complexity**: X/10
**Dependencies**: [None | Phase N, Phase M | omit for sequential default]
**Files**: `path/to/file.ts`, `path/to/other.ts`

- [ ] Task 1
  <verify>npx tsc --noEmit src/path/to/file.ts</verify>
- [ ] Task 2

**Build Verification**: Run `npm run build`
```

**`**Files**:` is not decoration — it is what splits the commit.**

The Source Control panel's Phases tab groups the working tree by the phase that
produced each change, and gives each group its own message and its own "Commit
phase" button. It reads this field. A phase that declares nothing contributes
nothing, and when no phase declares anything the tab collapses into a single
"Other changes" list — a second, identical copy of the Changes tab, which is
exactly what happened while this line was missing from the template.

Rules:

- Every phase gets one, listing the files that phase will create or modify.
- Backticked, comma-separated. Project-relative paths.
- A directory (`app/src/review/`) or a glob (`app/src/review/*.ts`) is allowed
  when a phase genuinely owns a whole area — but prefer naming files.
- A phase that omits it falls back to the file paths its Description and Tasks
  name in backticks, which is a recovery, not a substitute: only full paths
  count there (a bare `helpers.ts` is read as prose), and directories and globs
  are ignored entirely.

**Standard Phase Order**:

1. Types and Schemas (usually low complexity)
2. Backend/API Implementation
3. Store/State Management
4. UI Components
5. Integration
6. Tests (ALWAYS last)

**Complexity Scoring** (per `.claude/resources/core/complexity-scoring.md`):

| Score | Level     | Description                      |
| ----- | --------- | -------------------------------- |
| 0-2   | Trivial   | Simple, mechanical changes       |
| 3-4   | Low       | Straightforward implementation   |
| 5-6   | Medium    | Moderate effort, some decisions  |
| 7-8   | High      | Complex, multiple considerations |
| 9-10  | Very High | Significant complexity/risk      |

#### Auto-Generating Verify Sections

When creating tasks within phases, auto-generate `<verify>` tags based on the task type using these heuristics:

| Task Type | Verify Command | When to Apply |
|-----------|---------------|---------------|
| File creation (`.ts`, `.tsx`) | `npx tsc --noEmit <file>` | Task creates or modifies a TypeScript source file |
| Test writing | `npx jest <test-file> --no-coverage` | Task creates or modifies a test file |
| Schema/type definition | `npx tsc --noEmit <type-file>` | Task creates or modifies type definitions or schemas |
| Config file changes | No verify | Task modifies `.flowconfig`, `tsconfig.json`, or similar config files |
| Documentation/markdown | No verify | Task creates or updates `.md` files |
| Generic/ambiguous tasks | No verify | Task description does not clearly indicate a verifiable output file |

**Rules for auto-generation:**

1. Only generate `<verify>` when the task clearly references a specific file path
2. Use the file path from the task description in the verify command
3. Prefer `npx tsc --noEmit` for source files and `npx jest --no-coverage` for test files
4. When in doubt, omit the `<verify>` tag — false verification commands are worse than no verification
5. Never generate full-build commands (`npm run build`) as verify tags — those belong in Build Verification

---

### Step 4: Generate Intent Block

Distill a condensed `## Intent` section for the plan header from the discovery document:

**Sources**:

- The discovery document's **Proposed Approach** and **Decisions** sections
- Any brainstorm document's **"Rejected (Do Not Revisit)"** items, if a brainstorm fed the discovery

**Structure** (target 150–250 tokens total):

- **Goal** — 2–3 sentences on what the user is trying to accomplish and why
- **Constraints** — bullet list of the key constraints that shape the implementation
- **Ruled Out** — bullet list of approaches deliberately rejected, each with a one-phrase reason

**Rules**:

1. Within the 150–250 token target, **err on the side of completeness, not brevity** — a missing constraint or ruled-out approach costs more downstream than a few extra tokens
2. The block is injected **verbatim** into execute, review, and repair prompts, so it must be **self-contained** — no references like "see section 3" or "as discussed in discovery"
3. Its purpose downstream is to tell a deliberate decision apart from a mistake — capture the *why* behind rejections, not just the *what*
4. If the discovery document lacks decision/rejection content, still write the Goal and Constraints; an empty Ruled Out list is acceptable

---

### Step 5: Analyze Phase Dependencies

After structuring phases, analyze which phases are independent and can run in parallel:

1. **For each phase**, determine its data and code dependencies on other phases:
   - Does this phase use types/interfaces defined in another phase?
   - Does this phase call functions or APIs created in another phase?
   - Does this phase modify files that another phase also modifies?

2. **Mark independent phases** with `**Dependencies**: None` when they:
   - Only depend on pre-existing code (not created in this plan)
   - Have no shared file modifications with other phases in the same wave
   - Can be implemented and verified independently

3. **Mark dependent phases** with explicit dependency lists:
   - `**Dependencies**: Phase 1` — depends on one phase
   - `**Dependencies**: Phase 1, Phase 3` — depends on multiple phases
   - List only **direct** dependencies (not transitive ones)

4. **Default to sequential** (omit the field) when:
   - Unsure whether phases are truly independent
   - Phases touch overlapping files
   - The dependency relationship is ambiguous

5. **Tests phase**: Always list ALL prior phases as dependencies. The Tests phase is never parallelized.

**Common independence patterns**:
- Types/schemas phase is often `Dependencies: None` (foundational, no prior phases needed)
- Backend API and CLI commands may be independent if they don't share code
- Store and UI phases often depend on types but may be independent of each other
- Integration phases typically depend on multiple prior phases

#### Structural Dependency Suggestions (graphify engine — optional)

When the **graphify engine** is available, augment the LLM-judgment analysis above with structural predictions from the code graph. This sub-step is **annotate-only** and engine-gated: when the engine is off (absent, declined, or any fallback), this entire sub-step is absent and the analysis above stands unchanged.

**Engine gate** — check `engines.graphify` in `flow/.flowconfig` (graphify mechanics — invocation patterns, Output Token Guard, staleness check, fallback — are defined once in `.claude/resources/core/graphify-engine.md`; reference it, never restate it):

| Registry state | Action |
|----------------|--------|
| `engines.graphify: enabled` AND `graphify-out/graph.json` exists | Run the staleness check per graphify-engine.md, then the prediction flow below |
| `engines.graphify: declined` | Skip silently (never re-ask) |
| Key absent | Run the engine lifecycle from `.claude/resources/core/engine-registry.md` ONCE: detect (`which graphify`) → consent → record the answer to `flow/.flowconfig` immediately → act on it (Enable triggers the consent-time build per graphify-engine.md) |

Any failure (tool missing, no graph, staleness update failed, non-zero exit, unparsable output) follows the Universal Fallback Rule in `.claude/resources/core/graphify-engine.md`: continue with the native analysis above plus a one-line notice — never an error, never a block.

**Prediction flow** (only when enabled and the graph is fresh):

1. **Extract file lists**: for each phase, collect the file paths referenced in its task descriptions
2. **Compute blast radii**: for each file, run `graphify affected "<file>" --depth 2 --relation calls --relation imports` — invocations may run in parallel; apply the Output Token Guard from graphify-engine.md to every output
3. **Build the phase-pair overlap matrix**: intersect blast radii per phase pair — record which phases' radii intersect and via which nodes
4. **Annotate**: where two phases share blast radius AND no dependency between them is already authored (in either direction), add an italic annotation line directly under the affected (later-numbered) phase's `**Dependencies**` field:

   ```markdown
   _structural analysis: shares blast radius with Phase N via `<node>`, `<node>` — consider `Dependencies: Phase N`_
   ```

5. **Predict same-wave conflicts**: add a **Structural conflict predictions** note to the plan's `## Execution Strategy` section listing predicted same-wave file conflicts:

   ```markdown
   **Structural conflict predictions** (graphify, advisory): Phase 2 ↔ Phase 3 — overlapping blast radius via `src/services/user.ts`; if scheduled in the same wave, expect a file conflict.
   ```

**Hard rules**:

1. **NEVER modify authored `Dependencies` fields.** Human/LLM-authored dependencies ALWAYS win — structural coupling is not an execution-order dependency. The annotation is a suggestion, never an edit.
2. Annotations must be clearly labeled as structural analysis and are purely advisory — `/execute-plan` wave computation reads only the `Dependencies` field and ignores annotation lines.
3. Skip the annotation when a dependency between the two phases is already authored — the suggestion adds nothing.

#### Blueprint as Advisory Input (optional)

When `flow/brain/.structure/graph.json` exists, it may be read as an **advisory before-overlay input** for the dependency analysis above: the derived system map (integrations, endpoints, datastores, modules and their `imports`/`exposes`/`uses` edges) helps spot which phases touch the same modules or datastores. Purely advisory — the same hard rules apply (never modify authored `Dependencies`; suggestions only). When the file is absent, skip silently — the native analysis above stands unchanged (no engine, no consent, no notice needed).

Additionally, when a `plan_decision` rounds entry concerns identifiable code (a specific file, symbol, table, endpoint, or module), attach an `anchors` array to it so the decision is promoted into the blueprint annotation stream on the next derive. Envelope, resolution kinds, and promotion rules are defined once in `.claude/resources/core/blueprint.md` — reference it, never restate it.

#### Blueprint Proposals

When a crystallizing decision concerns a **concrete integration, datastore, endpoint, module, or feature part**, record it as a blueprint proposal so it renders as a ghost on the board while being discussed. Store mechanics, lifecycle, and fold rules are defined once in `.claude/resources/core/blueprint.md` (Proposals) — reference it, never restate it.

The trigger covers **new nodes AND changes to existing ones**. It used to fire only for a new concrete node ("we'll add a Stripe integration", "this needs a `sessions` table", "a new CLI verb"), which excluded most real work by the instruction's own terms — and is one of the reasons this store went un-written in every project for its entire lifetime.

**The ordinary case has no new node in it at all.** A discovery that says "reconnect the SSE stream after a dropped connection, and show a banner while it retries" adds nothing — and still names two things worth proposing: `feature:chats/sse-events-endpoint` and `feature:chats/chat-ui`, both of which already exist. Propose them. A run that predicts no NEW node is not a run with nothing to propose.

**Never declare new vs changed** — there is no `--state` flag and there must not be one. A proposal whose anchors already resolve is a CHANGE to what they name; one whose anchors resolve to nothing is NEW; the CLI derives that from the code each time it is asked, so it cannot disagree with reality. Anchor the proposal (`--anchor file:<path>`, `--anchor module:<dir>`) and the distinction takes care of itself — an unanchored proposal can only ever read as new.

When the proposal's phase will add or change a function you can name, add it as an anchor too — `--anchor symbol:<path>#<name>` (or `--anchor file:<path>:<name>`). Optional and never invented: a proposal's anchors are checked for shape only, so this is the place to name a function that does not exist yet. The function itself is described by its change note (Step 6c).

1. **Emit** one proposal per predicted node, using the plan document name as `--plan` and the phase that predicts it as `--phase`:

   ```bash
   planflow-ai blueprint propose --plan <plan-name> --node <predicted-id> --kind <kind> --label "<label>" [--detail "<text>"] [--phase <n>] [--anchor <kind>:<ref>]...
   ```

   The predicted id MUST match the id grammar for its kind (the CLI refuses otherwise, naming the grammar it expected):

   | Kind | Predicted id grammar |
   |------|---------------------|
   | `integration` | `integration:<name>` or `integration:webhook:</path>` |
   | `endpoint` | `endpoint:<METHOD> /<path>` or `endpoint:cli <command>` |
   | `datastore` | `datastore:<name>` (incl. `datastore:migrations:<dir>`) |
   | `module` | `module:<repo-relative-dir>` |
   | `part` | `feature:<slug>/<part-slug>` — e.g. `feature:chats/sse-events-endpoint`; inside a Workspace the feature is namespaced: `feature:<project>::<slug>/<part-slug>` |

   The first four are **extractor** ids: the node the extractors derive once the code exists, confirmed against `graph.json`. `part` is not — a part is a piece of a feature (one `## Parts` entry), it lives in the feature graph, and it confirms there. Both halves of the id are lowercase slugs: the owning feature's slug, then the part's name slugified (`SSE events endpoint` → `sse-events-endpoint`). `part:<name>` is NOT the grammar and is refused.

2. **Decide** when the user settles the decision — an `AskUserQuestion` answer recorded as a `plan_decision` rounds entry (Step 7) — by running the decide event **alongside** that entry:

   ```bash
   planflow-ai blueprint propose --decide accepted|rejected --plan <plan-name> --node <predicted-id>
   ```

3. **Fail-soft, never silent**: a missing `planflow-ai` CLI or a refusal (one-line `propose refused: <reason>` on stderr) NEVER blocks this step — continue without it. No board and no graph are required. What a refusal must NOT do is vanish: every successful write prints the plan's resulting store state (`proposals: N recorded`) and every refusal prints its reason, so both are read back rather than assumed.

4. **Report what was recorded** — MANDATORY, no silent form. The completion summary carries exactly one line:

   `Proposals: N recorded`

   `Proposals: 0 recorded` is a legitimate outcome and MUST still be stated, with its reason on the same line — `Proposals: 0 recorded — nothing concrete predicted`, or, when the CLI refused, `Proposals: 0 recorded — propose refused: <reason verbatim>`. Deciding whether anything is worth proposing stays a judgment; leaving that judgment unreported does not. This store went un-written in every project for its entire lifetime because nothing was ever obliged to say it had recorded nothing.

---

### Step 6: Add Key Changes Summary

Document the most important modifications:

```markdown
## Key Changes

1. **[Category]**: [Description of change]
2. **[Category]**: [Description of change]
```

---

### Step 6b2: Link Related Projects in this Workspace (REQUIRED in a Workspace — skipped silently outside one)

`planflow-ai workspace status --target . --json` — `workspace: null` means skip this
step silently. In a Workspace: search the siblings for what the plan's phases change
(`planflow-ai brain search "<topic>" --scope workspace`, hits namespaced
`<project>/…`); name each cross-project touchpoint in the phase that creates or changes it (a task line such as `Consumed by frontend/file:src/screens/Checkout.tsx`), and carry over the discovery's **Related projects in this Workspace**. Record each touchpoint with
`planflow-ai workspace link-knowledge --target . --from <project>/<feature-or-anchor> --to <project>/<feature-or-anchor> --kind calls|exposes|consumes|relates --note "<why/how>" --json`
— the one writer of the Workspace's links (full step: `.claude/commands/create-plan.md`).
Report `Workspace links: N recorded` (zero with its reason).

### Step 6c: Author Change Notes per Phase

Every phase gets a `#### Change notes` block — the plan as a review of the code
change. The person reviews these notes one by one (accept / reject / comment) in
the code story before `/execute-plan` builds them, and execution reports a verdict
per note afterwards. Plans do **not** carry a `## Story` section any more, and do
not run strict narrate, the anchor-coverage gate or the change-brief review — the
notes replaced all three. Discovery keeps its own draft Story; nothing here
changes it.

Grammar (parsed by ONE parser, `src/cli/state/change-notes.ts`; full examples in
`.claude/resources/patterns/plans-templates.md`, Change Notes):

```markdown
#### Change notes

- note: <n> · change · file:<path>:<function>
    where: `<a short piece of today's code inside that function>`
    what: <what changes, one or two sentences>
    why: <why>
- note: <n> · new · file:<path>:<function>
    signature: <name(params): returns>
    purpose: <what it is for>
    callers: <existingFn>, <otherFn>
- note: <n> · file · file:<path>
    where: `<optional: a short piece of today's code found once in the file — where the change goes>`
    what: <what changes in the file — imports, config, a test file>
    why: <why>
```

1. **Notes for the main changes only** — the functions where the plan's logic or a decision lives, the points a reviewer could disagree with. Aim for 3–8 notes for the whole plan; never more than 10. A repeated, mechanical edit (the same parameter passed through several functions, a rename, imports, wiring, tests) gets **one** note on the function where it matters, naming the others in `what:` — never one note each. A phase with nothing a reviewer must decide has no notes block.
   A note is `change` (an existing function) or `new` (a function that does not
   exist yet); a change outside any function that still matters is a `file`
   note. `<function>` may be `Class.method` or `Class.#private`.
   **Prefer a function note** — the review draws every note on its code, and a
   function note lands on its function's lines. A file note quotes its place
   with `where:` whenever the change has one (a route table's entry, a fixture,
   a test's `describe`); without it the review can only show the file's first
   lines.
2. **Number across the plan** — 1, 2, 3 … in phase order, never restarting per
   phase. The numbers are how the review, the verdicts and the person's comments
   refer to a note.
3. **Read the real code before quoting it.** Open the file, find the function,
   and copy into `where:` a short piece of today's code (backticked) that occurs
   **exactly once inside that function** (a file note's: exactly once in the
   whole file) — part of one line is usually enough.
   Never a line number, never a paraphrase, never code recalled from memory. A
   function that does not exist yet is a `new` note, never a `change` note.
4. **No code of the change, ever.** `what:`, `why:` and `purpose:` are words. A
   code block in a note is the plan writing the implementation.
5. **A sibling Workspace project** is addressed by its slug prefix:
   `api/file:src/routes/orders.ts:createOrder` (slugs from
   `planflow-ai workspace status --target . --json`).
6. **Leave `status:`, `comments:` and `verdict:` out.** A note without a status
   is proposed. Status is written by the person's review and verdicts by
   `/execute-plan` — both only through `planflow-ai plan note`, never by hand.
7. **Check every note (MANDATORY)** once the plan file is written:

   ```bash
   planflow-ai plan notes <plan-path> --check --json
   ```

   `plan refused: notes — N note(s) need fixing …` comes with a JSON payload whose
   `failing` list names each note and why — the quote is not in the function
   today, is found more than once, the file or function does not exist, or the
   note is unreadable. Fix those notes (quote more of the line, or the line that is
   really there; turn a change note on a missing function into a new note) and
   re-run until it passes. **The plan is not finished while this refuses.**
8. **Report** exactly one line in the completion summary:
   `Notes: N written (C change, W new, F file)`.

---

### Step 6c2: Register New Features (feature-blueprint)

A plan that introduces a **new feature** — core or child — should say so, and
the feature blueprint picks it up automatically: the corpus miner sees the plan
doc and stages a candidate on the next `blueprint features discover`.

1. **Name the feature in the plan's Intent** so the miner has a boundary
   to read. The plan filename IS the candidate slug.
2. **Do NOT write a feature file here.** A plan proposes; execution confirms
   (`blueprint features confirm <slug>` at Step 7b of `/execute-plan`). An
   abandoned plan must never leave a feature that was never built.
3. **For a CHILD feature**, note its parent in the plan so a human can set
   `parent:` when confirming — `parent` is human-owned and no sweep will
   invent it.

---

### Step 7: Record Plan Decisions

When the user settles a question while the plan is being written (an
`AskUserQuestion` answer, a pushed-back approach), apply it to the plan body (a
phase's tasks or notes, the `## Intent` block) and append one `plan_decision`
entry per decision to `flow/.rounds.jsonl` (create the file if it doesn't exist
yet — the schema is defined once, in the Rounds Record section of
`.claude/resources/skills/execute-plan-skill.md`):

```json
{"ts": "<ISO8601>", "run_id": "<plan-slug>-plan", "type": "plan_decision", "phase": null, "decision": "<plan section / what was decided>", "choice": "<the selected answer>", "source": "create-plan"}
```

There is no walkthrough to run here: the review of the change is the person's,
note by note, after the plan is saved — never a step this skill performs or waits
for.

---

### Step 8: Generate Plan Document

Create the plan markdown file:

**Location**: `flow/plans/plan_<feature_name>_v<version>.md`

**Use Template**: See `.claude/resources/patterns/plans-templates.md`

**Required Sections**:

1. Overview (with discovery document reference)
2. Intent (condensed Goal / Constraints / Ruled Out block — see Step 4)
3. Goals
4. Non-Goals
5. Requirements Summary (FR, NFR, Constraints)
6. Risks
7. Phases (with complexity scores, optional dependency declarations, and a `#### Change notes` block per phase — see Step 6c)
8. Key Changes

No `## Story` section: plans stopped authoring one (an older plan that has one still parses and runs).

After writing the plan, `/create-plan` may run `planflow-ai plan compile <plan>` to validate the plan parses cleanly before presenting it — a `compile refused: <reason>` line means the plan needs fixing before hand-off to `/execute-plan`.

---

## Output Format

The plan document should follow the template in `.claude/resources/patterns/plans-templates.md`.

**Naming Convention**: `plan_<feature_name>_v<version>.md`

**Examples**:
- `plan_user_authentication_v1.md`
- `plan_dark_mode_v2.md`

---

## Plan Template

```markdown
# Plan: [Feature Name]

**Project**: [[{project-name}]]

## Overview

[Brief description of the feature and its purpose]

**Based on Discovery**: `flow/discovery/discovery_<feature>_v1.md` (or "Discovery skipped")

## Intent

**Goal**: [2–3 sentences: what the user is trying to accomplish and why]

**Constraints**:

- [Key constraint that shapes the implementation]

**Ruled Out**:

- [Approach deliberately rejected] — [one-phrase reason]

## Goals

- [Goal 1]
- [Goal 2]

## Non-Goals

- [What this plan explicitly does NOT cover]

## Requirements Summary

### Functional Requirements

- [FR-1]: [Description]

### Non-Functional Requirements

- [NFR-1]: [Description]

### Constraints

- [C-1]: [Description]

## Risks

| Risk     | Impact          | Mitigation            |
| -------- | --------------- | --------------------- |
| [Risk 1] | High/Medium/Low | [Mitigation strategy] |

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
    what: [what changes]
    why: [why]
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

- [ ] Unit tests
  <verify>npx jest src/path/to/test.ts --no-coverage</verify>
- [ ] Integration tests

<!-- No change notes here: tests are a mechanical edit. Give a test file a note
     only when it carries a decision a reviewer could disagree with. -->

**Build Verification**: Run `npm run build && npm run test`

## Key Changes

1. **[Category]**: [Description]
```

---

## Validation Checklist

Before completing the plan, verify:

- [ ] Plan is saved in `flow/plans/` folder
- [ ] File uses snake_case naming: `plan_<feature>_v<version>.md`
- [ ] All phases have complexity scores (X/10)
- [ ] Intent section is present (Goal + Constraints + Ruled Out, 150–250 tokens, self-contained)
- [ ] Phase dependencies are analyzed and declared where appropriate
- [ ] Structural dependency suggestions (Step 5 sub-step) ran when `engines.graphify: enabled` — annotations added without modifying any authored Dependencies field — or the sub-step fell back to native analysis
- [ ] Tests are the LAST phase with dependencies on ALL prior phases
- [ ] Key Changes section is populated
- [ ] Discovery document is referenced (discovery is required, never skipped)
- [ ] Verify sections are generated for applicable tasks (file creation, test writing, schema/type tasks)
- [ ] Verify sections are omitted for config, documentation, and generic tasks
- [ ] Phases with a change a reviewer must decide carry a `#### Change notes` block (Step 6c) — the plan has 3–8 notes, never more than 10; a repeated edit is written once; a phase with nothing to decide (often Tests) has none; numbered across the plan, no code of the change
- [ ] `planflow-ai plan notes <plan-path> --check --json` passed, and `Notes: N written (C change, W new, F file)` is in the completion summary
- [ ] No `## Story` section was written for the plan
- [ ] `Proposals: N recorded` is stated in the completion summary — including `Proposals: 0 recorded` with its reason (never omitted, never silent)
- [ ] Decisions the user settled while planning are folded into the plan and recorded as `plan_decision` rounds entries (Step 7)
- [ ] **NO implementation code is included**
- [ ] **NO source files were created or modified**

---

## Related Files

| File                                           | Purpose                          |
| ---------------------------------------------- | -------------------------------- |
| `.claude/resources/patterns/plans-patterns.md`  | Rules and patterns for plans     |
| `.claude/resources/patterns/plans-templates.md` | Plan templates                   |
| `.claude/resources/core/complexity-scoring.md`      | Complexity scoring system        |
| `.claude/resources/core/engine-registry.md`    | Engine lifecycle (detect → consent → record → use → fallback) |
| `.claude/resources/core/graphify-engine.md`    | Graphify mechanics (blast radius, token guard, staleness, fallback) |
| `.claude/resources/core/blueprint.md`          | Proposals — grammar, lifecycle, fold rules |
| `src/cli/state/change-notes.ts`                | Change-note grammar (the one parser) |
| `flow/plans/`                                  | Output folder for plan documents |
| `flow/discovery/`                              | Input discovery documents        |
