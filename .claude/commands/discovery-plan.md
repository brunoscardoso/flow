---
description: This command creates a discovery document for gathering and clarifying requirements before creating 
---

# Create Discovery Document

## Command Description

This command creates a discovery document for gathering and clarifying requirements before creating an implementation plan. The command validates inputs and orchestrates the discovery process by invoking the `discovery` skill.

**Output**: A markdown file at `flow/discovery/discovery_<feature_name>_v<version>.md`

---

> **Autopilot chains this for you.** When a chain is driving, the harness issues the next stage from observable state — no command decides on its own whether to continue, and before it issues one it runs `planflow-ai flow stage <stage> --check --feature <slug> --chain <id>`, which refuses a stage whose predecessor left no proof for this run's feature — a refusal stops the chain, it never advances past it. The message that started you names the slug to write your document under; name it anything else and the next stage is refused. Three pauses are honoured and no others: `high` risk before anything is published (`planflow-ai flow risk --check`), the guard classifier's `ask`, and a branch nobody has bound at publish time. Outside a chain the standard rules below apply — stop and wait for the user.

> ⚠️ **IMPORTANT - DISCOVERY ONLY**
>
> This command ONLY creates a discovery document. It does NOT:
> - Create implementation plans (use `/create-plan` for that)
> - Execute code or implementation steps (use `/execute-plan` for that)
> - Write any source code files
> - Auto-chain to the next command — a chain, when one is driving, issues the next stage itself
>
> After creating the discovery document, the command STOPS. Under a chain, what happens next is the harness’s decision, not this command’s.

---


## Help

**If the user invokes this command with `-help`, display only this section and stop:**

```
/discovery-plan - Create Discovery Document

DESCRIPTION:
  Creates a discovery document for gathering and clarifying requirements
  before creating an implementation plan. This is the recommended first step.

USAGE:
  /discovery-plan <reference_document>
  /discovery-plan <feature_description>
  /discovery-plan -help

ARGUMENTS:
  reference_document   Contract, spec, or any document to analyze
  feature_description  Description of what you want to build

EXAMPLES:
  /discovery-plan @flow/contracts/api_contract.md
  /discovery-plan "User authentication with OAuth2"
  /discovery-plan @docs/feature-spec.md "Focus on the payment flow"
  /discovery-plan @flow/brainstorms/brainstorm_plugin-system_v1.md

OUTPUT:
  Creates: flow/discovery/discovery_<feature_name>_v<version>.md

WORKFLOW:
  1. Reads all referenced documents
  2. Finds all related code references in codebase
  3. Asks clarifying questions (via Plan mode Questions UI)
  4. Documents requirements (FR, NFR, Constraints)
  5. Proposes high-level approach (no code)
  6. Creates discovery document for review
  7. Asks user if they want to proceed to /create-plan
  8. Waits for user confirmation before proceeding

RECOMMENDED MODEL:
  Claude Opus 4.6 or Sonnet 4.5 for best results

RELATED COMMANDS:
  /create-contract   Create contract from API docs first
  /create-plan       Create plan from discovery document
```

---

## Critical Rules

These rules are mandatory. For detailed patterns and guidelines, see `.claude/resources/patterns/discovery-patterns.md`.

| Rule                     | Description                                              |
| ------------------------ | -------------------------------------------------------- |
| **No Code**              | NEVER write, edit, or generate code during discovery     |
| **Only Markdown Output** | The ONLY deliverable is the discovery markdown file. Do NOT display it in chat. |
| **Ask Questions**        | When in doubt, ask - don't assume                        |
| **Read First**           | Read all referenced documents before asking questions    |
| **High-Level Only**      | Technical considerations are conceptual, not code        |
| **Allow Refinement**     | User reviews and refines discovery before plan creation  |
| **Ask Before Proceeding**| ASK user if they want to proceed to /create-plan. Under a chain, do not ask and do not continue — the harness issues the next stage |
| **No Auto-Execution**    | Do NOT auto-invoke commands without user confirmation. This holds under a chain too: the harness invokes, never this command |
| **NO PLANNING**          | Do NOT create implementation plans during discovery      |
| **NO EXECUTION**         | Do NOT execute any implementation steps                  |
| **File Only**            | Save the `.md` file and report its path. Do NOT show full content in chat. |

---

## Instructions

### Step 1: Validate Inputs

| Input                | Required | Description                                         |
| -------------------- | -------- | --------------------------------------------------- |
| `reference_document` | Optional | Contract, spec, or any document to analyze          |
| `feature_description`| Optional | Description of what to build (if no doc provided)   |

**At least one must be provided.** If neither is clear, ask:

```markdown
To start the discovery process, I need to understand:

1. **What feature or topic are we exploring?**
2. **What triggered this need?** (new requirement, bug, enhancement)
3. **Are there any documents I should review?** (API contracts, specs, designs)
4. **What do you already know about the requirements?**
5. **Are there any constraints I should be aware of?**
```

---

### Step 2: Extract Feature Name

From the user input, extract or derive a feature name for the discovery document.

**Examples**:
- `@flow/contracts/api_contract.md` → `api_integration`
- `"User authentication with OAuth2"` → `user_authentication`

---

### Step 3: Check for Existing Discovery

Check `flow/discovery/` for existing discovery documents for this feature:

1. If found, ask if user wants to create a new version or continue existing
2. Increment version number if creating new version

**Important**: NEVER read or reference files in `flow/archive/` - these are outdated documents.

---

### Step 4: Invoke Discovery Skill

**Brainstorm files as input**: If the reference document is a brainstorm file (`flow/brainstorms/brainstorm_*.md`), the skill should:
- Treat "Resolved During Brainstorm" decisions as settled — do NOT re-ask
- Use "Still Open (Discovery Should Investigate)" as starting investigation points
- Respect "Rejected (Do Not Revisit)" — do NOT re-propose these alternatives

The skill will:

1. Read all referenced documents (including brainstorm files)
2. Find all related code references in the codebase
3. Ask clarifying questions via Interactive Questions Tool
4. Track question status
5. Document requirements (FR, NFR, Constraints)
6. Identify technical considerations
7. Propose high-level approach
8. Document risks and unknowns
9. **Record blueprint proposals** for what the work will touch (Step 6b — see 4c below)
10. Generate discovery document and save to `flow/discovery/` (no artifact page — see 4d below)

See: `.claude/resources/skills/discovery-skill.md`

---

### Step 4c: Record What This Will Touch (REQUIRED — not optional)

A discovery predicts changes to the system. Those predictions are what the board
renders as the **discovery view** — the picture of what is about to change, before
it exists. Record each one:

```bash
planflow-ai blueprint propose --plan <plan-name-this-will-get> --node <predicted-id> \
  --kind integration|endpoint|datastore|module|part --label "<label>" \
  [--detail "<why>"] [--anchor file:<path>]...
```

**The trigger is NOT only new things.** It covers **changes to existing ones**, which
is what most discoveries are — a discovery that predicts no NEW node is not a
discovery with nothing to propose. Anchor to **files** rather than directories: a
directory-level anchor is usually claimed by so many features that it attaches to
none of them.

Use the plan name the feature will get (`<feature>`, matching the discovery slug) so
create-plan decisions and the archive sweep act on the same fingerprints. Full
grammar, id rules and lifecycle: `.claude/resources/skills/discovery-skill.md`
Step 6b.

**Verification (MANDATORY before reporting completion)** — report the count, and
report zero as a number with a reason rather than staying silent:

```
Proposals: N recorded          # or: Proposals: 0 recorded — <why nothing was predicted>
```

> **Why this is in the command and not only in the skill**: it lived solely in the
> skill for its entire life, and the skill is *referenced*, not injected — so nothing
> obliged a run to open it. `proposals.jsonl` was consequently never written in ANY
> project, and no run ever said so. A step that only exists in a file nobody must
> read is a step that does not exist.

---

### Step 4d: No Artifact Page During Discovery

Discovery does **not** write the user walkthrough page — what the app calls the
discovery's **artifact** (`<discovery basename>.walkthrough.html`). Do not copy
the template, delegate it or mention it. The person can generate it from the
DISCOVERY card (**Generate artifact**, which sends `/artifact @<discovery path>`
into the thread) or by running `/artifact` — see `.claude/commands/artifact.md`.

---

### Step 4b: Author the Story (REQUIRED — not optional)

Every discovery document MUST end with a `## Story` section — nothing may follow
it — a draft concept arc
(problem → shape → data flow → decisions → risks, ≤5 steps, `### Step: <title>` blocks
with `- kicker:` / `- anchors:` / optional `- flow:` metadata; grammar reference:
`src/cli/blueprint/story-grammar.ts`, authoring guidance in
`.claude/resources/skills/discovery-skill.md`). Draft mode is lenient — anchors that
don't resolve yet are fine.

When Step 4c recorded two or more proposals, the Story MUST also declare how they
connect: a `- flow_after:` line naming the proposal ids in order, with a hop label
before each arrow (`feature:chats/stream -persists->, datastore:messages`). It is the
only source of the discovery view's arrows — the predicted pieces mostly do not exist
yet, so the code map has no edges for them (skill Step 6c, item 2b).

After writing the document, compile the draft so the board and the chat story card pick
it up:

```bash
planflow-ai blueprint narrate --from <discovery-doc-path>
```

**Verification (MANDATORY before reporting completion)**:

```bash
grep -c "^## Story" <discovery-doc-path>   # must be >= 1
grep "^## " <discovery-doc-path> | tail -1  # must be "## Story" — it is the last section
```

If the grep returns 0, the discovery is NOT complete — go back and author the section.
A discovery without a story leaves the user with no visual walkthrough of what was
discovered (the board stays silent and the chat shows no story card).

---

### Step 4e: Link Related Projects in this Workspace (REQUIRED in a Workspace — skipped silently outside one)

Projects of one Workspace share knowledge, and the touchpoints between them are
recorded as you work — not reconstructed later.

```bash
planflow-ai workspace status --target . --json
```

`workspace: null` → skip this step and say nothing about it. Otherwise:

1. Search the sibling projects for the feature's endpoints, data and screens:
   `planflow-ai brain search "<topic>" --scope workspace` — hits are namespaced
   `<project>/…`; a `link` hit is a touchpoint someone already recorded.
2. Fill the **Related projects in this Workspace** subsection of `## Codebase Analysis`: one bullet per touchpoint — `<project>/<feature-or-anchor>` — what crosses the boundary, and which side changes.
3. Record each touchpoint (the one writer — never edit `links.jsonl` by hand):

   ```bash
   planflow-ai workspace link-knowledge --target . \
     --from <project>/<feature-or-anchor> --to <project>/<feature-or-anchor> \
     --kind calls|exposes|consumes|relates --note "<one line of why/how>" --json
   ```

   `<project>` is a slug from `workspace status` (`project.slug`, `siblings[].slug`);
   the ref is a feature slug or an anchor (`endpoint:POST /api/orders`,
   `file:src/screens/Orders.tsx`, `module:src/api`). Example: a new backend endpoint the frontend checkout screen calls → `--from backend/endpoint:POST /api/orders --to frontend/file:src/screens/Checkout.tsx --kind exposes`. Recording the same
   link twice is a no-op. A `workspace refused: <reason>` line comes with a JSON
   payload naming the valid slugs or kinds — correct the address from it once, or
   report the refusal verbatim.

**Verification (MANDATORY in a Workspace)**:

```
Workspace links: N recorded    # or: Workspace links: 0 recorded — <why no project was touched>
```

---

### Step 5: Save File and Stop

After the skill completes:

1. **Save the discovery document** to `flow/discovery/discovery_<feature>_v<version>.md`
2. **Report only the file path and the verification lines** — do NOT display the full document content in chat
3. **STOP** — do NOT create a plan, do NOT offer to build, do NOT show implementation steps

**Output to the user** (this is the ONLY thing to show):

```markdown
Discovery done.
File: `flow/discovery/discovery_<feature>_v<version>.md`
Proposals: N recorded
Workspace links: N recorded        # this line only in a Workspace
Next: review the file. Then run `/create-plan`.
```

Write the chat summary in short, clear sentences (ASD-STE100 style); say it once; do not repeat a finished result.

⚠️ **CRITICAL**: After saving the file, the command is DONE. Do NOT:
- Show the full discovery document content in chat
- Create or suggest an implementation plan
- Offer to build or execute anything
- Auto-invoke `/create-plan`

The user will read the `.md` file themselves and decide when to proceed.

---

## Flow Diagram

```
+------------------------------------------+
|        /discovery-plan COMMAND           |
+------------------------------------------+
                    |
                    v
+------------------------------------------+
| Step 1: Validate Inputs                  |
| - Check for reference doc or description |
| - Ask clarifying questions if needed     |
+------------------------------------------+
                    |
                    v
+------------------------------------------+
| Step 2-3: Extract Feature & Check Exists |
| - Derive feature name                    |
| - Check for existing discovery docs      |
+------------------------------------------+
                    |
                    v
+------------------------------------------+
| Step 4: Invoke Discovery Skill           |
| - Skill handles all gathering logic      |
| - See discovery-skill.md                |
+------------------------------------------+
                    |
                    v
+------------------------------------------+
| Step 5: Save File and Stop               |
| - Save .md file to flow/discovery/       |
| - Report file path only                  |
| - STOP (no plan, no build)               |
+------------------------------------------+
```

---

## Example Usage

**User**: `/discovery-plan @flow/contracts/api-contract.md`

**Execution**:

1. Validate input: reference document provided
2. Extract feature name: `api_integration`
3. Check `flow/discovery/` for existing versions
4. Invoke discovery skill
5. Present discovery document and summary
6. User reviews and requests refinements (if any)
7. User invokes `/create-plan` when ready

## Context Loading

This command uses the **project brain** for context retrieval. Before executing, query it for relevant documentation:

**Queries**:
- `planflow-ai state-query "discovery workflow" --scope resources`
- `planflow-ai state-query "requirements gathering" --scope resources`
- `planflow-ai state-query "codebase analysis" --scope resources`

The brain returns ranked chunks from indexed markdown files. Use the top results to inform execution.

---

## Related Resources

| Resource                       | Purpose                                |
| ------------------------------ | -------------------------------------- |
| `discovery-skill.md`          | Skill that executes the discovery      |
| `discovery-patterns.md`       | Rules and patterns for discovery       |
| `discovery-templates.md`      | Document templates                     |
| `interactive-questions-tool.md` | Interactive Questions UI workflow    |
| `/create-plan` command         | Creates plan from discovery document   |

---

## Tasklist Updates

Update `flow/tasklist.md` at these points. See `.claude/resources/core/project-tasklist.md` for full rules.

1. **On start**: Add "Discovery: {feature}" to **In Progress** (or move it from To Do if it already exists)
2. **On complete**: Move "Discovery: {feature}" to **Done** with today's date
3. **Next step**: Add "Create plan for {feature}" to **To Do**

---

## Learn Recommendations

After discovery completes, check for learning opportunities. See `.claude/resources/core/learn-recommendations.md` for the full system.

**Discovery-specific checks**:
- Does the proposed approach introduce **new technologies** the project hasn't used before?
- Are there **unfamiliar APIs or services** in the requirements?
- Did the user mention switching from one pattern/tool to another?

**If new tech is detected**, add a "Suggested Learning" section to the discovery document:

```markdown
## Suggested Learning

The following topics are new to this project and may benefit from structured learning before implementation:

| Topic | Why | Suggested Command |
|-------|-----|-------------------|
| Langfuse | New observability tool not previously used | `/learn langfuse` |
| WebSocket | Real-time communication pattern new to project | `/learn websockets` |

These are optional but recommended to reduce implementation friction.
```

**Detection**: Compare proposed technologies against `flow/references/tech-foundation.md` and existing `package.json` / `pyproject.toml` dependencies. If a technology is not in the current stack, flag it.

**Presentation**: Include the section in the discovery document itself (not as a chat message). This ensures the learning suggestion persists and is visible when the user reviews the document.

---

## STATE.md Updates

Update `flow/STATE.md` at these transition points to enable session resumability.

**Format**: the exact syntax — bullet grammar, section headings, em dashes, field order — is pinned in `.claude/resources/core/state-md.md`. The reader is a strict regex; a file that drifts from that grammar parses to an empty state, silently.

| Transition Point | Action |
|-----------------|--------|
| **Discovery start** | Create `flow/STATE.md` with `- **Active Skill**: discovery-plan`, `- **Active Plan**: {feature}` — the slug the discovery document will be named with, never `none` — `- **Current Phase**: none`, `- **Current Task**: gathering requirements`, and `## Next Action`: `Read references and ask clarifying questions` |
| **Question batch complete** | Append answered questions to `## Decisions`: `{question} → {answer} (reason: user response)` |
| **Discovery complete** | Rewrite `flow/STATE.md` with `- **Active Skill**: discovery-plan`, `- **Active Plan**: {feature}` (the `{feature}` in `discovery_{feature}_v{N}.md`), `- **Current Phase**: none`, `- **Current Task**: discovery complete`, and `## Next Action`: `Run /create-plan for {feature}` |

**Never delete `flow/STATE.md` on completion.** The state exists for whoever comes next: the run that picks up `/create-plan` reads `Active Plan` to find this pipeline, and an absent file reads as nothing in flight. Completion is a write, not a cleanup. If `Active Plan` already names a *different* feature when discovery finishes, another pipeline is mid-flight — leave the Execution State fields as they are and record the completion under `## Decisions` instead of blanking a live handoff.

**Field syntax**: every field is a bullet under a `## Execution State` heading — `- **Active Skill**: {value}` — with a top-level `**Updated**: {ISO-8601}` line above it and the next step on its own line under `## Next Action`. `Current Phase` is read only as `{N} — {Name}`. The reader (`src/cli/state/state-md-parser.ts`) is a strict line parser: a field written any other way is dropped silently.

---

## Brain Capture

After discovery completes successfully, append a brain-capture block. See `.claude/resources/core/brain-capture.md` for processing rules.

**Capture the following**:

```
<!-- brain-capture
skill: discovery
feature: [feature name from discovery]
status: completed
data:
  user_prompt: [original user request]
  questions_asked: [count]
  questions_answered: [count]
  requirements_fr: [count of functional requirements]
  requirements_nfr: [count of non-functional requirements]
  discovery_doc: [path to discovery document]
-->
```

Write/update `flow/brain/features/[feature-name].md` with discovery context, then rebuild the index with `planflow-ai brain index` — `flow/brain/index.md` is generated from the notes; never edit it by hand.

The file MUST carry `capture: brain` in its frontmatter — that key is how the store tells a captured note from a capability, and a note without it is drawn on the Blueprint board as a feature of the product.

---

## Resource Capture

During this skill's execution, watch for valuable reference materials worth preserving. See `.claude/resources/core/resource-capture.md` for capture rules, file format, and naming conventions.

At natural break points, if you encounter information that could be useful for future development (API specs, architecture notes, config references, domain knowledge, etc.), ask the user: "I found something that could be useful for future reference: _{brief description}_. Should I save it to `flow/resources/`?"

Only save if the user approves. Do not re-ask if declined.

---

## Discovery Sub-Agents

After reading referenced documents (Step 1), three parallel Agent sub-agents explore the codebase simultaneously: **Similar Features** (finds related existing code), **API/Data Patterns** (maps endpoints and service patterns), and **Schema/Types** (explores type definitions and schemas). All use the sonnet model.

Each sub-agent returns condensed JSON findings (under 2K tokens) that the coordinator merges into a `## Codebase Analysis` section in the discovery document. Findings also inform the clarifying questions in Step 2.

Always-on — no configuration needed. See `.claude/resources/core/discovery-sub-agents.md` for full rules.

---

## Change-Brief Confirmation (user-facing changes only)

The change brief has two authored slots no extractor can derive — `unchanged:`
(what stays the same for the user) and `fails:` (how it breaks, user-side).
They are **not asked on every discovery**:

1. **Gate**: only when the change alters something a user sees, types or relies
   on. Refactors, fixes, internal modules and build changes skip this — both
   slots stay absent and the brief renders without them (narrate warns, never
   refuses).
2. **Propose, then confirm once**: draft both answers from the codebase
   analysis and the request, and put them in the standard question batch as ONE
   confirmation item — *Keep as written / Edit / Leave out* — beside the UI
   question. Never two open-ended questions.
3. **Record the user's words**, never the unconfirmed draft. A guessed
   `unchanged:` renders on the board as a guarantee.

Confirmed answers are recorded into the discovery doc's `## Story` section;
`/create-plan` reads them from there and never asks for them again (plans carry
change notes, not a Story). See `.claude/resources/skills/discovery-skill.md` Step 2.

---

## Design Awareness

During discovery, always ask whether the feature involves UI work. If confirmed, follow the design question flow to capture structured design tokens (colors, typography, spacing, component patterns) into a `## Design Context` section in the discovery document.

The Design Context is also what the artifact's mockups are styled from, if one is generated later with `/artifact`.

See `.claude/resources/core/design-awareness.md` for the full question flow, personality options, token extraction rules, and Design Context template.

---

## Pattern Capture

During discovery, silently watch for conventions found in existing code, anti-patterns in referenced documents, and patterns identified during technical analysis. Append captured patterns to `flow/resources/pending-patterns.md` without interrupting work.

After generating the discovery document, present any buffered patterns for user approval. Approved patterns are written to `.claude/rules/core/allowed-patterns.md` or `.claude/rules/core/forbidden-patterns.md`.

See `.claude/resources/core/pattern-capture.md` for buffer format, capture triggers, conflict detection, and the full review protocol.
