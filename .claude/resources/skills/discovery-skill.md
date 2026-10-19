
# Discovery Skill

## Purpose

Perform a comprehensive **requirements gathering and documentation** process that reads referenced documents, asks clarifying questions, and produces a structured discovery document.

This skill **only produces a markdown file** in `flow/discovery/`. It does NOT:

- Write any code
- Modify any source files
- Create implementation plans
- Execute any implementation

---

## Restrictions - DISCOVERY ONLY

This skill is **strictly for gathering and documenting requirements**. The process:

1. **Reads** all referenced documents and contracts
2. **Asks** clarifying questions via Interactive Questions Tool
3. **Documents** requirements (FR, NFR, Constraints)
4. **Identifies** technical considerations (high-level only)
5. **Proposes** approach (conceptual, no code)
6. **Generates** a discovery markdown file

**No code, no implementation, no source file modifications.**

### NEVER Do These Actions

| Forbidden Action                       | Reason                                    |
| -------------------------------------- | ----------------------------------------- |
| Create/edit source code files          | Discovery is requirements gathering only  |
| Write implementation code in responses | No code during discovery                  |
| Create implementation plans            | Plans come after discovery                |
| Modify configuration files             | No codebase changes                       |
| Run build or test commands             | No execution commands                     |
| Create files outside the writable list below | Only write discovery documents and the stores the steps below mandate |

### Allowed Actions

| Allowed Action                         | Purpose                              |
| -------------------------------------- | ------------------------------------ |
| Read any project file                  | Understand existing implementation   |
| Read referenced documents              | Extract requirements and constraints |
| Search codebase (grep, glob, semantic) | Find existing patterns               |
| Use Interactive Questions Tool         | Gather requirements from user        |
| Write to `flow/discovery/`             | Save the discovery document |
| Write to `flow/brain/.structure/` **via the CLI only** | `blueprint observe` (Step 1d) and `blueprint propose` (Step 6b) record findings and predicted nodes there. Never edit those files by hand — the CLI is the mediating writer that enforces the stores' invariants (allowed-pattern #14). |
| Read project rule files                | Understand patterns to follow        |

> **Important**: The writable locations are `flow/discovery/`, `flow/resources/pending-patterns.md`, `.claude/rules/core/*.md` (for approved patterns), and `flow/brain/.structure/` **through the `planflow-ai blueprint` CLI only**. No source code, configuration files, or any other project files should be modified.
>
> **Why the structure store is named here**: it was omitted for the whole life of
> this skill, while Steps 1d and 6b mandated writes to it. A run that read the
> restriction first — 300 lines before the step — correctly refused to propose,
> which is why `proposals.jsonl` had never been written in ANY project. The
> prohibition and the mandate must never disagree again: if a step tells you to
> write somewhere, this table says so too.

---

## Inputs

| Input                | Required | Description                                           |
| -------------------- | -------- | ----------------------------------------------------- |
| `feature_name`       | Yes      | Name of the feature or topic to explore               |
| `context`            | Optional | Why this discovery is needed                          |
| `referenced_docs`    | Optional | List of documents to review (@mentions, file paths)   |
| `known_requirements` | Optional | Any requirements already known                        |

---

## Workflow

### Step 1: Read All Referenced Documents

**BEFORE asking detailed questions**, read every referenced document.

**Actions**:

1. Identify references (look for @mentions, file paths, URLs)
2. Read each file using the Read tool
3. **If a brainstorm file** (`flow/brainstorms/brainstorm_*.md`): parse the "For Discovery" section — inherit resolved decisions, use open questions as investigation starting points, and skip rejected alternatives
4. Extract key information (requirements, constraints, contracts)
5. Summarize findings for each source
6. **Capture patterns**: While reading existing code and documents, watch for recurring conventions and established patterns. Silently append to `flow/resources/pending-patterns.md`. See `.claude/resources/core/pattern-capture.md` for buffer format and capture triggers.

**Document Analysis Format**:

```markdown
## Referenced Documents Analysis

### `flow/contracts/api-contract.md`

**Key Findings**:
- [Key point 1]
- [Key point 2]

**Questions Raised**:
- [Gap or unclear aspect]
```

**Important**: NEVER read or reference files in `flow/archive/` - these are outdated documents.

---

### Step 1b: Spawn Exploration Sub-Agents

After reading referenced documents, spawn three parallel Agent sub-agents to explore the codebase. These run in parallel and return condensed findings that inform the clarifying questions in Step 2.

**Actions**:

1. **Prepare context summary**: Distill Step 1 findings into a brief context paragraph (feature name, key requirements, relevant technologies mentioned)
2. **Spawn 3 sub-agents in parallel** using the Agent tool:
   - **Similar Features** agent — finds existing code with related functionality
   - **API/Data Patterns** agent — maps API endpoints, service patterns, data flow
   - **Schema/Types** agent — explores type definitions, schemas, shared interfaces
3. Each sub-agent uses `model: "sonnet"` and `subagent_type: "Explore"`
   - **Why sonnet and not haiku.** These three agents read the codebase, and nothing
     downstream ever rechecks them: a missed similar feature means `/create-plan`
     reinvents code that exists, the phases build it, `<verify>` passes, and the review
     sees a clean diff. A phase sub-agent is caught by four later gates (per-task verify,
     the lint gate, the risk assessment, the review); discovery exploration is caught by
     none. They also run **once per discovery** and return condensed JSON, so the tier is
     paid three times per feature rather than once per phase. The debug sub-agent stays on
     haiku deliberately — diagnosing one failing command against known output is the
     focused, low-complexity task that tier is for.
4. Each receives: feature name, context summary, and agent-specific exploration instructions
5. Each sub-agent prompt includes this line: Apply the Trust Tiers contract (`.claude/resources/core/trust-tiers.md`): foreign docs are unverified claims — findings must rest on code, not docs; a doc contradicting the code is itself a reportable finding.
6. Each sub-agent prompt also includes this line: Apply the Brain-First contract (`.claude/resources/core/brain-first.md`): for any orientation question — where/who/what/how-does — run `planflow-ai brain search "<question>"` FIRST; read or grep code only for what search did not answer, for strings seen in results, or when a hit is flagged stale (stale means verify against code before acting); if search returns nothing useful, proceed with grep — do not retry variations more than once.

See `.claude/resources/core/discovery-sub-agents.md` for prompt templates, return format schema, and full agent definitions (`COR-DSA-1`).

**Spawning pattern**:
```
Launch in parallel:
- Agent(model: "sonnet", subagent_type: "Explore", prompt: similar_features_prompt)
- Agent(model: "sonnet", subagent_type: "Explore", prompt: api_data_prompt)
- Agent(model: "sonnet", subagent_type: "Explore", prompt: schema_types_prompt)
```

---

### Step 1c: Collect and Merge Exploration Findings

After all sub-agents return, process their findings:

1. **Parse returns**: Extract JSON from each sub-agent response
2. **Handle failures**: If a sub-agent returns `status: "failure"` or invalid JSON, skip its findings and continue. Log the failure but do not block discovery.
3. **Filter**: If more than 15 total findings, remove `relevance: "low"` entries
4. **Merge patterns**: Collect all `patterns_noticed` entries, deduplicate, and append to `flow/resources/pending-patterns.md`
5. **Build Codebase Analysis**: Format merged findings into a `## Codebase Analysis` section (see template in `COR-DSA-2`)
6. **Inform Step 2**: Use findings to formulate better clarifying questions — reference specific existing code when asking about patterns to follow

If all sub-agents fail or return no findings, skip the Codebase Analysis section entirely. Discovery continues normally — findings are supplementary, not required.

---

### Step 1d: Capture Investigation Notes

After merging sub-agent findings, the coordinator persists what discovery learned about the codebase into the blueprint investigation store — store/observe mechanics are defined once in `.claude/resources/core/blueprint.md` (Investigation Store); reference it, never restate it.

1. **One condensed note per explored region** — per module directory the sub-agents actually explored, NOT per file. Notes must be condensed (one or two sentences of what was learned) and anchored:

   ```bash
   planflow-ai blueprint observe --note "<condensed finding>" --anchor module:<dir> --run-id <id>
   ```

2. **Heat ticks for visited regions**: a note write already ticks its anchors; for regions explored without a note-worthy finding, emit a heat-only visit — `planflow-ai blueprint observe --anchor module:<dir>` (agent visitor by default).
3. **Corroborate/supersede on existing notes**: when an anchor already carries active notes, `observe` refuses a plain write — follow the contradiction rule: re-confirm with `--status corroborates`, or replace with `--supersedes <fingerprint> --reason "<why>"`. Never work around a refusal by dropping anchors.
4. **Fail-soft**: an observe refusal that can't be resolved, or a missing `planflow-ai` CLI, NEVER blocks discovery — skip the note with a one-line notice (e.g. "investigation note skipped — observe refused") and continue.

---

### Step 1e: Evaluate the Feature Map (feature-blueprint)

Discovery is the moment the project's **capabilities** get a human's eyes on
them. Mine them, show them, and let the user correct them — before any of it
hardens into a plan.

```bash
planflow-ai blueprint features discover     # mine surfaces + corpus
planflow-ai blueprint features graph        # what the board will show
```

1. **Show the core features** as a short list — this is "what this project
   does", derived from its routes, API groups, e2e suite dirs and `features/`
   roots. Do NOT dump anchors or file paths; the names are the point.
2. **Invite correction in one line**: "anything here that isn't a feature, or
   missing?" Correction is conversational by design — there is no confirmation
   gate. When the user names a wrong one, DELETE its file
   (`flow/brain/features/<slug>.md`); when they rename one, edit `name:`. Both
   are human-owned, so no sweep will undo it.
3. **Name the feature this discovery belongs to** — an existing capability, or
   a new one. Record it in the discovery doc's frontmatter as
   `feature: <slug>`. That is what parents the resulting plan's change record
   under the right capability instead of stranding it at board level 1.
4. **Confirm any brand-new capability** the work introduces:
   `planflow-ai blueprint features confirm <slug>`.
5. **Fail-soft**: no `planflow-ai` CLI, or an empty feature list (a repo whose
   conventions name nothing), NEVER blocks discovery — say so in one line and
   continue.

---

### Step 1f: Link Related Projects in this Workspace (REQUIRED in a Workspace — skipped silently outside one)

`planflow-ai workspace status --target . --json` — `workspace: null` means skip this
step silently. In a Workspace: search the siblings for the feature's endpoints, data and screens
(`planflow-ai brain search "<topic>" --scope workspace`, hits namespaced
`<project>/…`); fill the **Related projects in this Workspace** subsection of `## Codebase Analysis`: one bullet per touchpoint — `<project>/<feature-or-anchor>` — what crosses the boundary, and which side changes. Record each touchpoint with
`planflow-ai workspace link-knowledge --target . --from <project>/<feature-or-anchor> --to <project>/<feature-or-anchor> --kind calls|exposes|consumes|relates --note "<why/how>" --json`
— the one writer of the Workspace's links (full step: `.claude/commands/discovery-plan.md`).
Report `Workspace links: N recorded` (zero with its reason).

### Step 2: Ask Clarifying Questions

Ask questions about gaps identified in documents and unclear requirements.

**Question Categories**:

| Category   | Focus                              |
| ---------- | ---------------------------------- |
| Functional | What the feature must do           |
| NFR        | Performance, security, scalability |
| Technical  | Architecture, dependencies         |
| UI/UX      | User interface and experience      |
| Boundary   | What does NOT change, and how it fails (user-facing changes only) |

**Change-Brief Confirmation (only when the change is user-facing)**:

The change brief has two authored slots — `unchanged:` (what stays the same
for the user) and `fails:` (how it breaks, user-side). They are worth having
for a change a person will *experience* — a UI, a workflow, a CLI verb they
type, an output they read. For a refactor, a fix, an internal module or a
build change they are filler, and filler in `unchanged:` renders on the board
as a **guarantee**. So:

1. **Gate on user-facing.** Decide from the request and the Codebase Analysis
   whether the change alters something a user sees, types or relies on. If it
   does not, skip this entirely — leave both slots absent (narrate warns, never
   refuses; the brief renders without its band and failure slot, which is the
   honest state).
2. **Propose, do not interrogate.** When it is user-facing, draft both answers
   yourself from the codebase analysis and the request — what visibly stays as
   it is, and the honest gap in how it fails (the case genuinely *not* covered,
   not just the handled ones). Put them in front of the user as ONE
   confirmation item in the standard question batch, alongside the UI question,
   with the draft shown: *"Keep as written / Edit / Leave out"*.
3. **Record what the user confirmed, not what you drafted.** An edited answer
   is recorded in the user's words; "Leave out" leaves the slot absent. Never
   promote your own draft into the doc without the confirm — a guessed
   `unchanged:` is worse than an absent one, because the brief presents it as
   a promise.

Both confirmed answers flow into the discovery doc's `## Story` section
(Step 6c) as `- unchanged:` and `- fails:` metadata. `/create-plan` reads them
there and never asks for them again (plans carry change notes, not a Story).

**Design Awareness Questions**:

After standard clarifying questions, check for UI work. See `.claude/resources/core/design-awareness.md` for the full question flow.

1. **Always ask** (as part of the standard question batch): "Does this feature involve any UI or visual interface work?"
   - If **Yes** or **Partially**: Add a follow-up question batch via `AskUserQuestion`:
     - "Do you have an existing design to follow?" (screenshots/mockups, existing design system, or need new design direction)
     - "What design personality fits this feature?" (only if no existing design — Stark, Aura, Neo, Zen, Flux, Terra)
     - "What's the primary layout pattern?" (dashboard, content+sidebar, form workflow, data table)
   - If **No**: Skip design questions entirely.
   - A `## Design Context`, when written, is what the artifact's mockups are styled from, if one is generated later (`/artifact`, Step 6d)
2. **If user provides screenshots**: Analyze visually and extract structured design tokens (colors, typography, spacing, component patterns). See token extraction rules in `.claude/resources/core/design-awareness.md`.
3. **If user picks a personality**: Use the personality's default tokens from `.claude/resources/core/design-awareness.md`.
4. **Plugin detection**: Check if `.interface-design/system.md` exists. If found, offer to use it as the design source.

**Use Interactive Questions Tool**:

Follow `.claude/resources/tools/interactive-questions-tool.md`:

1. Call `SwitchMode` tool to enter Plan mode
2. Call `AskQuestion` tool for each question (2-6 options, A/B/C/D format)
3. Wait for responses
4. Call `SwitchMode` tool to return to Agent mode

**Skip Interactive Questions If**:

- All questions answered in chat already
- User confirmed all assumptions
- No blocked or open questions remain

---

### Step 3: Track Question Status

Maintain a question tracking table:

```markdown
## Open Questions

| #   | Category   | Question                   | Status   | Answer            |
| --- | ---------- | -------------------------- | -------- | ----------------- |
| 1   | Functional | Max steps per workflow?    | Answered | 20 steps maximum  |
| 2   | Technical  | Use existing store or new? | Open     | -                 |
| 3   | NFR        | Required response time?    | Assumed  | <500ms (validate) |
```

**Status Legend**:

- **Open**: Awaiting answer
- **Answered**: Response received
- **Assumed**: Made assumption (needs validation)
- **Blocked**: Cannot proceed without answer

---

### Step 4: Document Requirements

Categorize requirements as they are gathered:

```markdown
## Requirements Gathered

### Functional Requirements
- [FR-1]: [Description] (Source: [document or user])

### Non-Functional Requirements
- [NFR-1]: [Description]

### Constraints
- [C-1]: [Description]
```

---

### Step 5: Identify Technical Considerations

Document high-level technical insights (NO implementation code).

**While analyzing technical considerations**, watch for conventions in the existing codebase that should be captured as patterns. Silently append to `flow/resources/pending-patterns.md`.

```markdown
## Technical Considerations

### Architecture Fit
- [How this fits into existing system]

### Dependencies
- [What this relies on]

### Patterns to Apply
- [Relevant patterns from rules]

### Challenges Identified
- [Potential difficulties]
```

---

### Step 6: Propose High-Level Approach

Suggest an approach based on findings (NO implementation code):

```markdown
## Proposed Approach

Based on the requirements gathered, I recommend:

1. [High-level approach point 1]
2. [High-level approach point 2]

### Alternative Approaches Considered

| Approach | Pros | Cons | Recommendation |
| -------- | ---- | ---- | -------------- |
| [A]      | ...  | ...  | Yes/No         |
```

---

### Step 6b: Blueprint Proposals

When a crystallizing decision concerns a **concrete integration, datastore, endpoint, module, or feature part**, record it as a blueprint proposal so it renders as a ghost on the board while being discussed. Store mechanics, lifecycle, and fold rules are defined once in `.claude/resources/core/blueprint.md` (Proposals) — reference it, never restate it.

The trigger covers **new nodes AND changes to existing ones**. It used to fire only for a new concrete node ("we'll add a Stripe integration", "this needs a `sessions` table", "a new CLI verb"), which excluded most real work by the instruction's own terms — and is one of the reasons this store went un-written in every project for its entire lifetime.

**The ordinary case has no new node in it at all.** A discovery that says "reconnect the SSE stream after a dropped connection, and show a banner while it retries" adds nothing — and still names two things worth proposing: `feature:chats/sse-events-endpoint` and `feature:chats/chat-ui`, both of which already exist. Propose them. A run that predicts no NEW node is not a run with nothing to propose.

**Never declare new vs changed** — there is no `--state` flag and there must not be one. A proposal whose anchors already resolve is a CHANGE to what they name; one whose anchors resolve to nothing is NEW; the CLI derives that from the code each time it is asked, so it cannot disagree with reality. Anchor the proposal (`--anchor file:<path>`, `--anchor module:<dir>`) and the distinction takes care of itself — an unanchored proposal can only ever read as new.

1. **Emit** when the prediction crystallizes:

   ```bash
   planflow-ai blueprint propose --plan <plan> --node <predicted-id> --kind <kind> --label "<label>" [--detail "<text>"] [--anchor <kind>:<ref>]...
   ```

   Use the plan name the feature will get (e.g. `plan_<feature>_v1`) as `--plan` so create-plan decisions and the archive sweep act on the same fingerprints. The predicted id MUST match the id grammar for its kind (the CLI refuses otherwise, naming the grammar it expected):

   | Kind | Predicted id grammar |
   |------|---------------------|
   | `integration` | `integration:<name>` or `integration:webhook:</path>` |
   | `endpoint` | `endpoint:<METHOD> /<path>` or `endpoint:cli <command>` |
   | `datastore` | `datastore:<name>` (incl. `datastore:migrations:<dir>`) |
   | `module` | `module:<repo-relative-dir>` |
   | `part` | `feature:<slug>/<part-slug>` — e.g. `feature:chats/sse-events-endpoint`; inside a Workspace the feature is namespaced: `feature:<project>::<slug>/<part-slug>` |

   The first four are **extractor** ids: the node the extractors derive once the code exists, confirmed against `graph.json`. `part` is not — a part is a piece of a feature (one `## Parts` entry), it lives in the feature graph, and it confirms there. Both halves of the id are lowercase slugs: the owning feature's slug, then the part's name slugified (`SSE events endpoint` → `sse-events-endpoint`). `part:<name>` is NOT the grammar and is refused.

2. **Decide** when the user settles the decision (e.g. an `AskUserQuestion` answer resolves it):

   ```bash
   planflow-ai blueprint propose --decide accepted|rejected --plan <plan> --node <predicted-id>
   ```

3. **Fail-soft, never silent**: a missing `planflow-ai` CLI or a refusal (one-line `propose refused: <reason>` on stderr) NEVER blocks this step — continue without it. No board and no graph are required. What a refusal must NOT do is vanish: every successful write prints the plan's resulting store state (`proposals: N recorded`) and every refusal prints its reason, so both are read back rather than assumed.

4. **Report what was recorded** — MANDATORY, no silent form. The completion summary carries exactly one line:

   `Proposals: N recorded`

   `Proposals: 0 recorded` is a legitimate outcome and MUST still be stated, with its reason on the same line — `Proposals: 0 recorded — nothing concrete predicted`, or, when the CLI refused, `Proposals: 0 recorded — propose refused: <reason verbatim>`. Deciding whether anything is worth proposing stays a judgment; leaving that judgment unreported does not. This store went un-written in every project for its entire lifetime because nothing was ever obliged to say it had recorded nothing.

---

### Step 6c: Author the Draft Story Arc

As the proposed approach and its supporting sections resolve, author a `## Story` section in the discovery document itself — a first draft of the concept arc that `/create-plan` will later lift and tighten into the final plan story. Grammar reference: `src/cli/blueprint/story-grammar.ts` (doc comment has the full spec — `### Step: <title>` blocks with optional `- key:` metadata: `kicker`, `anchors`, `flow`/`flow_before`/`flow_after`, `phases`, `source`, `unchanged`, `decisions`/`rejected`/`questions`/`fails`).

1. **Follow the concept arc convention**: problem → shape → data flow → decisions/why-nots → risks. Intuition before details. Cap at 5 steps (`STORY_STEP_CAP`).
1b. **Carry the confirmed change-brief answers into the story** (from Step 2,
   present only for user-facing changes): the confirmed "what does NOT change"
   answer becomes `- unchanged: <verbatim>` on the step that frames the shape,
   and each confirmed failure mode becomes an item under `- fails:`. If Step 2
   was skipped or the user chose "Leave out", omit both keys. **Write `fails:` in the INDENTED form**, never inline —
   chip lists split on commas, so a failure mode written as prose on the
   `- fails:` line shatters into fragments:

   ```markdown
   - fails:
     - Authoritative-write with dual-write off loses the row, silently.
     - The engine read can fail, and the fallback hides it.
   ``` These are AUTHORED claims — nothing in the code can prove
   them, and the brief's verification ledger labels them as such. Omitting
   them is legal (narrate warns, never refuses), but the brief then renders
   without its negative-space band and its failure-modes slot.
2. **Draft mode is lenient by design** — at discovery time, code that would satisfy an `anchors:`/`flow:` reference may not exist yet. Write the anchors you expect (`module:src/cli/blueprint`, `integration:stripe`, etc.) even if they don't resolve today.
1c. **An anchor is a typed reference, never prose.** Every `anchors:` item is `<kind>:<ref>` — `file:<repo-relative path>`, `module:<dir>`, `symbol:<path>:<name>`, `endpoint:<METHOD> </path>`, `integration:<name>`, `datastore:<name>`, `table:<name>`; in a Workspace, prefix a sibling project's path with its slug (`file:orbit-app/src/components/artifacts/ArtifactViewer.tsx`). Anchors are how the board finds the feature a discovery is about and opens its diagram; a prose anchor ( `` `ArtifactViewer.handleRefresh` ``, "the query relay") points at nothing and is dropped with a warning:

   ```markdown
   - anchors: file:orbit-app/src/components/artifacts/ArtifactViewer.tsx, symbol:orbit-app/src/components/artifacts/ArtifactViewer.tsx:handleRefresh
   ```

   Step headings read `### Step: <title>` (a number — `### Step 1: <title>` — is fine). Read narrate's warnings and fix every `invalid anchor` before finishing; a story that compiles to 0 steps is refused, never "a tooling quirk".
2b. **Declare how the predicted pieces connect** — REQUIRED whenever Step 6b recorded two or more proposals. On the step that frames the shape (or the data flow), add a `- flow_after:` line naming the proposal ids in the order work or data moves between them, with a short hop label saying what crosses:

   ```markdown
   - flow_after: endpoint:POST /api/chat -streams->, feature:chats/sse-events-endpoint -persists->, datastore:messages
   ```

   Use the exact predicted ids from `blueprint propose` (including `feature:<slug>/<part>` parts), and put a space before each `-label->`. This is the ONLY source of the discovery view's arrows: the pieces a discovery predicts mostly do not exist yet, so the code map has no edges for them, and without a declared flow the view is a grid of unconnected boxes. If there are several independent paths, write one `flow_after:` per step that describes each. Do not invent a connection you cannot state a reason for — an unconnected box is honest, a guessed arrow is not.
3. **After story edits**, compile it to catch parse warnings (not resolution gaps — those are fine in draft):

   ```bash
   planflow-ai blueprint narrate --from <discovery-doc-path>
   ```

   Discovery docs live under `flow/discovery/`, so mode inference selects `--draft` automatically (see mode-inference rule in `.claude/resources/core/blueprint.md`, Story Layer). Unresolved anchors are expected and fine — only parse warnings (malformed step blocks) need fixing.
4. **Fail-soft**: a missing `planflow-ai` CLI or a compile that can't run for any reason NEVER blocks discovery — skip with a one-line notice and continue. The `## Story` section itself is still saved in the document either way; it is markdown, not a side effect.

---

### Step 6d: The Artifact Is Not Written Here

A discovery does **not** write its user walkthrough page — the page the app
calls the **artifact** (`<discovery basename>.walkthrough.html`). It is written
on request: the DISCOVERY card offers **Generate artifact**, which sends
`/artifact @<discovery path>` into the thread, or a person runs `/artifact`.
Structure, rules and verification live in
`.claude/resources/skills/artifact-skill.md`.

Do not create, copy or mention the page during discovery. When the discovery
has UI work, the `## Design Context` (Step 2, Design Awareness Questions) is what the artifact's mockups
will be styled from.

---

### Step 7: Document Risks and Unknowns

Capture risks discovered:

```markdown
## Risks and Unknowns

### Risks

| Risk | Impact | Likelihood | Mitigation |
| ---- | ------ | ---------- | ---------- |
| ...  | ...    | ...        | ...        |

### Unknowns (Require Further Investigation)
- [ ] [Unknown item]
```

---

### Step 8b: Pattern Review

After generating the discovery document but before completing the skill, run the pattern review protocol:

1. Read `flow/resources/pending-patterns.md`
2. If the buffer has entries, present grouped patterns for user approval
3. Write approved patterns to `.claude/rules/core/allowed-patterns.md` or `.claude/rules/core/forbidden-patterns.md`
4. Clear the buffer

See `.claude/resources/core/pattern-capture.md` for the full end-of-skill review protocol.

---

### Step 8: Generate Discovery Document

Create the discovery markdown file:

**Location**: `flow/discovery/discovery_<feature_name>_v<version>.md`

**Use Template**: See `.claude/resources/patterns/discovery-templates.md`

**Required Sections**:

1. Context
2. Referenced Documents
3. Codebase Analysis (from Step 1c — omit if no findings)
4. Requirements Gathered (FR, NFR, Constraints)
5. Open Questions (all answered)
6. Technical Considerations
7. Proposed Approach
8. Risks and Unknowns
9. Next Steps
10. Design Context (only when UI work was confirmed)
11. Story (draft concept arc — see Step 6c) — **always the last section**

`## Story` ends the document: its grammar reads from its heading to the next
level-2 heading or EOF, and `/discovery-plan` verifies the doc ends with the
story.

**Codebase Analysis**: Include the merged findings from Step 1c. Use the Codebase Analysis section format from `.claude/resources/core/discovery-sub-agents.md` (`COR-DSA-2`). Omit this section if all sub-agents failed or returned no findings.

**Design Context**: If UI work was confirmed during questioning, add a `## Design Context` section to the discovery document (before the story) using the template from `.claude/resources/core/design-awareness.md`. Populate with extracted tokens (from screenshots), personality defaults, or existing design system values.

---

## Output Format

The discovery document should follow the template in `.claude/resources/patterns/discovery-templates.md`.

**Naming Convention**: `discovery_<feature_name>_v<version>.md`

**Examples**:
- `discovery_workflow_editor_v1.md`
- `discovery_user_authentication_v1.md`

---

## Validation Checklist

Before completing discovery, verify:

- [ ] All referenced documents have been read
- [ ] Document is saved in `flow/discovery/` folder
- [ ] File uses correct naming convention
- [ ] Open questions table has no "Blocked" status
- [ ] Requirements are categorized (FR, NFR, Constraints)
- [ ] Technical considerations are documented
- [ ] Risks and unknowns are identified
- [ ] Proposed approach is documented (high-level only)
- [ ] If a `## Story` draft was authored: `blueprint narrate --from <doc>` ran (draft mode) — parse warnings resolved, resolution gaps are fine
- [ ] `Proposals: N recorded` is stated in the completion summary — including `Proposals: 0 recorded` with its reason (never omitted, never silent)
- [ ] Next steps are defined (pointing to `/create-plan`)
- [ ] If UI work detected: `## Design Context` section included with structured tokens
- [ ] `## Story` is the LAST section of the document
- [ ] **NO implementation code is included**
- [ ] **NO source files were created or modified**

---

## Related Files

| File                                              | Purpose                           |
| ------------------------------------------------- | --------------------------------- |
| `.claude/resources/patterns/discovery-patterns.md` | Rules and patterns for discovery  |
| `.claude/resources/patterns/discovery-templates.md` | Document templates                |
| `.claude/resources/tools/interactive-questions-tool.md` | Interactive Questions UI workflow |
| `.claude/resources/core/blueprint.md`             | Story Layer — grammar, narrate modes, arc convention |
| `.claude/resources/core/design-awareness.md`      | Design Context — the tokens the artifact's mockups are styled from |
| `.claude/resources/skills/artifact-skill.md`      | The artifact — written on request with `/artifact`, never by discovery |
| `flow/discovery/`                                 | Output folder for discovery docs  |
