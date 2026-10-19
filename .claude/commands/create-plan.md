---
description: This command creates a structured implementation plan based on a discovery document or user input. T
---

# Create Implementation Plan

## Command Description

This command creates a structured implementation plan based on a discovery document or user input. The command validates inputs and orchestrates the planning process by invoking the `create-plan` skill.

**Output**: A markdown file at `flow/plans/plan_<feature_name>_v<version>.md`

---


## Help

**If the user invokes this command with `-help`, display only this section and stop:**

```
/create-plan - Create Implementation Plan

DESCRIPTION:
  Creates a structured implementation plan with phases, complexity scores,
  and tasks based on a discovery document or user input.

USAGE:
  /create-plan <discovery_document>
  /create-plan <feature_description>
  /create-plan -help

ARGUMENTS:
  discovery_document   Path to discovery document (recommended)
  feature_description  Direct description of feature to plan (if no discovery)

EXAMPLES:
  /create-plan @flow/discovery/discovery_user_auth_v1.md
  /create-plan "Add dark mode toggle to settings page"
  /create-plan @flow/contracts/api_contract.md

OUTPUT:
  Creates: flow/plans/plan_<feature_name>_v<version>.md

WORKFLOW:
  1. Validates discovery document exists (or prompts for discovery first)
  2. Extracts requirements from discovery document
  3. Creates phases with complexity scores (0-10)
  4. Assigns tasks to each phase
  5. Generates condensed Intent block (Goal/Constraints/Ruled Out) from discovery
  6. Change notes — only the main changes (3–8 per plan, one note per key function), checked
     against today's code (you review them before /execute-plan builds them)
  7. Tests phase is always last

RECOMMENDED MODEL:
  Claude Opus 4.6 or Sonnet 4.5 for best results

RELATED COMMANDS:
  /discovery-plan    Run discovery first (recommended)
  /execute-plan      Execute the created plan
```

---

> **Autopilot chains this for you.** When a chain is driving, the harness issues the next stage from observable state — no command decides on its own whether to continue, and before it issues one it runs `planflow-ai flow stage <stage> --check --feature <slug> --chain <id>`, which refuses a stage whose predecessor left no proof for this run's feature — a refusal stops the chain, it never advances past it. The message that started you names the slug to write your document under; name it anything else and the next stage is refused. Three pauses are honoured and no others: `high` risk before anything is published (`planflow-ai flow risk --check`), the guard classifier's `ask`, and a branch nobody has bound at publish time. Outside a chain the standard rules below apply — stop and wait for the user.

## Critical Rules

| Rule                     | Description                                              |
| ------------------------ | -------------------------------------------------------- |
| **Discovery Required**   | NEVER create a plan without a discovery document. If none exists, run `/discovery-plan` first. No exceptions. |
| **No Auto-Chaining**     | NEVER auto-invoke /execute-plan — a user invokes it, or a chain issues it |
| **File Only**            | Save the `.md` file and report its path. Do NOT show full content in chat. |
| **Complete and Stop**    | After presenting results, STOP. Under a chain, the harness decides what follows |

---

## Instructions

### Step 1: Validate Inputs

| Input                | Required | Description                                        |
| -------------------- | -------- | -------------------------------------------------- |
| `discovery_document` | Optional | Path to discovery document (recommended)           |
| `feature_description`| Optional | Direct description of feature (if no discovery)    |

**At least one must be provided.**

---

### Step 2: Validate Discovery Phase Completion (HARD BLOCK)

**A discovery document is REQUIRED before creating any plan. No exceptions.**

1. Check user input for a discovery document reference (`@flow/discovery/...`)
2. If no reference provided, search `flow/discovery/` for a matching discovery document
3. **If NO discovery document exists**: **STOP immediately.** Do NOT create a plan. Instead:
   - Inform the user that discovery is required before planning
   - Invoke `/discovery-plan` to start the discovery process
   - Example response:
     ```
     A discovery document is required before creating a plan. Discovery refines your idea,
     gathers requirements, and identifies risks — skipping it leads to incomplete plans.

     Starting discovery now...
     ```
   - Then run the discovery process for the user's feature
4. If a discovery document IS found: Proceed with plan creation using that document

**Important**: NEVER read or reference files in `flow/archive/` - these are outdated.
**Important**: NEVER create a plan without a discovery document. This rule has NO exceptions.

---

### Step 3: Determine Plan Version

Check `flow/plans/` for existing plans with the same feature name:

1. If existing plans found, increment version number
2. If no existing plans, use version 1

---

### Step 4: Invoke Create Plan Skill

The skill will:

1. Extract requirements from discovery document (or user input)
2. Analyze scope and complexity
3. Structure phases with complexity scores — including advisory structural dependency suggestions (blast-radius annotations) when the optional graphify engine is enabled (`engines.graphify` in `flow/.flowconfig`)
4. Generate a condensed `## Intent` block (Goal / Constraints / Ruled Out) from the discovery document's decisions — injected verbatim into downstream execute/review prompts
5. Add key changes summary
6. Author the **change notes** inside each phase (Step 6c of the skill, and Step 4b below): notes only for the main changes — the key functions a reviewer must decide on, 3–8 per plan (never more than 10), with a repeated edit written once — words only, never the code of the change. The notes ARE the plan's review: the person accepts or rejects them note by note before `/execute-plan` builds them. Plans no longer carry a `## Story` section and no longer run strict narrate or the change-brief review — discovery keeps its own Story.
7. Generate plan document

See: `.claude/resources/skills/create-plan-skill.md`

---

### Step 4a: Record What This Plan Will Touch (REQUIRED — not optional)

Each phase that predicts a concrete node — a new integration, endpoint, datastore,
module, or a **feature part** — records it as a blueprint proposal, so the board can
show what the plan will touch before any of it exists:

```bash
planflow-ai blueprint propose --plan <plan-name> --node <predicted-id> \
  --kind integration|endpoint|datastore|module|part --label "<label>" \
  [--detail "<why>"] [--phase <n>] [--anchor file:<path>]...
```

**The trigger is NOT only new things** — it covers changes to existing ones, which is
most of what a plan does. Anchor to **files** rather than directories: a
directory-level anchor is usually claimed by so many features that it attaches to
none of them. Full grammar and lifecycle: `.claude/resources/skills/create-plan-skill.md`.

**Verification (MANDATORY before reporting completion)** — report the count, and
report zero as a number with a reason rather than staying silent:

```
Proposals: N recorded          # or: Proposals: 0 recorded — <why nothing was predicted>
```

> **Why this is in the command and not only in the skill**: the skill has permitted
> and mandated this write for its whole life, and the command never mentioned it —
> so nothing obliged a run to open the skill and find the step. `proposals.jsonl`
> was never written in ANY project by ANY plan. A step that only exists in a file
> nobody must read is a step that does not exist.

---

### Step 4b: Author Change Notes per Phase (REQUIRED — not optional)

A phase carries a `#### Change notes` block — the plan as a review of the code
change. **Notes for the main changes only** — the functions where the plan's logic or a decision lives, the points a reviewer could disagree with. Aim for 3–8 notes for the whole plan; never more than 10. A repeated, mechanical edit (the same parameter passed through several functions, a rename, imports, wiring, tests) gets **one** note on the function where it matters, naming the others in `what:` — never one note each. A phase with nothing a reviewer must decide has no notes block. A change that is not inside a function and still matters
(a config switch, a route table) gets a **file note**. **Prefer a function note**: the review draws every note on its code, and a function note lands on its function's lines. A file note quotes its place with `where:` whenever the change has one (the route table's entry, the fixture, the test's `describe`) — without it the review can only show the file's first lines. Notes are numbered across the whole plan (1, 2, 3 … never restarting per
phase). Grammar and examples: `.claude/resources/patterns/plans-templates.md`
(Change Notes).

```markdown
#### Change notes

- note: 1 · change · file:src/cli/commands/plan.ts:runPlanNotes
    where: `const result = await readPlanNotes(planArg, { target: options.target });`
    what: also report the notes' verdicts beside their status
    why: Verify shows each note's verdict next to the real diff
- note: 2 · new · file:src/cli/state/change-notes.ts:countVerdicts
    signature: countVerdicts(notes: ChangeNote[]): VerdictCounts
    purpose: one count of done / differs / not-built shared by the reader and compile
    callers: readPlanNotes, compileRunScript
- note: 3 · file · file:src/cli/index.ts
    where: `.command('notes <plan>')`
    what: register the --verdicts flag on `plan notes`
    why: the reader is reached through the CLI
```

Rules:

1. **Read the real code before you quote it.** Open the file, find the function,
   and copy a short piece of today's code into `where:` (backticked) — a line or
   part of one that occurs **exactly once inside that function** (a file note's
   optional `where:`: exactly once in the whole file). Never a line number,
   never a paraphrase, never code from memory.
2. **No code of the change, ever.** `what:` / `why:` / `purpose:` are one or two
   sentences of words. A code block in a note is the plan writing the
   implementation, which is `/execute-plan`'s job.
3. **A new function** names its `signature:`, `purpose:` and `callers:` (the
   existing functions that will call it, comma-separated).
4. **A sibling project's code** (inside a Workspace) is addressed with its slug:
   `api/file:src/routes/orders.ts:createOrder`.
5. **Leave `status:` out.** A note without one is proposed; the person accepts or
   rejects it in review, and only the `plan note` verb writes a status or a verdict.

**Verification (MANDATORY before reporting completion)** — every quote must resolve
once in today's code and every note must be readable:

```bash
planflow-ai plan notes <plan-path> --check --json
```

A `plan refused: notes — …` line (its JSON payload names each failing note and why:
the quote is not in the function, is found twice, the file or function does not
exist, or the note is unreadable) means the plan is not finished: fix the named
notes — quote more of the line, or the line that is really there — and re-run until
it passes. Then report exactly one line:

```
Notes: N written (C change, W new, F file)
```

---

### Step 4c: Link Related Projects in this Workspace (REQUIRED in a Workspace — skipped silently outside one)

Projects of one Workspace share knowledge, and the touchpoints between them are
recorded as you work — not reconstructed later.

```bash
planflow-ai workspace status --target . --json
```

`workspace: null` → skip this step and say nothing about it. Otherwise:

1. Search the sibling projects for what the plan's phases change:
   `planflow-ai brain search "<topic>" --scope workspace` — hits are namespaced
   `<project>/…`; a `link` hit is a touchpoint someone already recorded.
2. Name each cross-project touchpoint in the phase that creates or changes it (a task line such as `Consumed by frontend/file:src/screens/Checkout.tsx`), and carry over the discovery's **Related projects in this Workspace**.
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

1. **Save the plan document** to `flow/plans/plan_<feature>_v<version>.md`
2. **Report only the file path and the verification lines** — do NOT display the full plan content in chat
3. **STOP** — do NOT execute the plan, do NOT offer to build

**Output to the user** (this is the ONLY thing to show):

```markdown
Plan done.
File: `flow/plans/plan_<feature>_v<version>.md`
Notes: N written (C change, W new, F file)
Proposals: N recorded
Workspace links: N recorded        # this line only in a Workspace
Next: review the file. Then run `/execute-plan`.
```

Write the chat summary in short, clear sentences (ASD-STE100 style); say it once; do not repeat a finished result.

⚠️ **CRITICAL**: After saving the file, the command is DONE. Do NOT:
- Show the full plan content in chat
- Auto-invoke `/execute-plan`
- Offer to start building or implementing
- Show implementation steps or code

The user will read the `.md` file themselves and decide when to proceed.

---

## Flow Diagram

```
+------------------------------------------+
|         /create-plan COMMAND             |
+------------------------------------------+
                    |
                    v
+------------------------------------------+
| Step 1: Validate Inputs                  |
| - Check for discovery doc or description |
+------------------------------------------+
                    |
                    v
+------------------------------------------+
| Step 2: Validate Discovery Completion    |
| - Check for discovery indicators         |
| - Recommend /discovery-plan if missing   |
+------------------------------------------+
                    |
                    v
+------------------------------------------+
| Step 3: Determine Plan Version           |
| - Check existing plans                   |
| - Increment version if needed            |
+------------------------------------------+
                    |
                    v
+------------------------------------------+
| Step 4: Invoke Create Plan Skill         |
| - Skill handles all planning logic       |
| - See create-plan-skill.md              |
+------------------------------------------+
                    |
                    v
+------------------------------------------+
| Step 5: Save File and Stop               |
| - Save .md file to flow/plans/           |
| - Report file path only                  |
| - STOP (no execute, no build)            |
+------------------------------------------+
```

---

## Example Usage

**User**: `/create-plan @flow/discovery/discovery_user_auth_v1.md`

**Execution**:

1. Validate input: discovery document provided
2. Verify discovery was completed
3. Check for existing plans, determine version
4. Invoke create-plan skill
5. Present plan summary
6. User reviews and proceeds to `/execute-plan`

## Context Loading

This command uses the **project brain** for context retrieval. Before executing, query it for relevant documentation:

**Queries**:
- `planflow-ai state-query "plan creation" --scope resources`
- `planflow-ai state-query "complexity scoring" --scope resources`
- `planflow-ai state-query "phase structure" --scope resources`

The brain returns ranked chunks from indexed markdown files. Use the top results to inform execution.

---

## Related Resources

| Resource                    | Purpose                           |
| --------------------------- | --------------------------------- |
| `create-plan-skill.md`     | Skill that creates the plan       |
| `plans-patterns.md`        | Rules and patterns for plans      |
| `plans-templates.md`       | Plan templates                    |
| `complexity-scoring.md`    | Complexity scoring system         |
| `/discovery-plan` command   | Run discovery first               |
| `/execute-plan` command     | Execute the created plan          |

---

## Tasklist Updates

Update `flow/tasklist.md` at these points. See `.claude/resources/core/project-tasklist.md` for full rules.

1. **On start**: Add "Plan: {feature}" to **In Progress** (or move it from To Do if it already exists)
2. **On complete**: Move "Plan: {feature}" to **Done** with today's date
3. **Next step**: Add "Execute plan for {feature}" to **To Do**

---

## Learn Recommendations

After plan creation completes, check for learning opportunities. See `.claude/resources/core/learn-recommendations.md` for the full system.

**Plan-specific checks**:
- Does the plan introduce **new technologies** not in the current tech stack?
- Are there phases that require **unfamiliar APIs or services**?
- Did the discovery document flag any "Suggested Learning" topics?

Present recommendations after the plan summary.

---

## STATE.md Updates

Update `flow/STATE.md` at these transition points to enable session resumability.

**Format**: the exact syntax — bullet grammar, section headings, em dashes, field order — is pinned in `.claude/resources/core/state-md.md`. The reader is a strict regex; a file that drifts from that grammar parses to an empty state, silently.

| Transition Point | Action |
|-----------------|--------|
| **Plan creation start** | Create `flow/STATE.md` with `- **Active Skill**: create-plan`, `- **Active Plan**: {feature}` — the `{feature}` in `discovery_{feature}_v{N}.md`, never `none` — `- **Current Phase**: none`, `- **Current Task**: creating plan from discovery`, and `## Next Action`: `Extract requirements and structure phases` |
| **Plan complete** | Rewrite `flow/STATE.md` with `- **Active Skill**: create-plan`, `- **Active Plan**: {feature}` (the `{feature}` in `plan_{feature}_v{N}.md`), `- **Current Phase**: none`, `- **Current Task**: plan complete`, and `## Next Action`: `Run /execute-plan {feature}` |

**Never delete `flow/STATE.md` on completion.** The state exists for whoever comes next: the run that picks up `/execute-plan` reads `Active Plan` to find this pipeline, and an absent file reads as nothing in flight. Completion is a write, not a cleanup. If `Active Plan` already names a *different* feature when the plan is finished, another pipeline is mid-flight — leave the Execution State fields as they are and record the completion under `## Decisions` instead of blanking a live handoff.

**Field syntax**: every field is a bullet under a `## Execution State` heading — `- **Active Skill**: {value}` — with a top-level `**Updated**: {ISO-8601}` line above it and the next step on its own line under `## Next Action`. `Active Plan` is the plan's `{feature}` name, never a path. The reader (`src/cli/state/state-md-parser.ts`) is a strict line parser: a field written any other way is dropped silently.

---

## Brain Capture

After plan creation completes successfully, append a brain-capture block. See `.claude/resources/core/brain-capture.md` for processing rules.

**Capture the following**:

```
<!-- brain-capture
skill: create-plan
feature: [feature name]
status: completed
data:
  phase_count: [number of phases]
  total_complexity: [sum of complexity scores]
  highest_phase: [phase name with highest score]
  discovery_link: [[discovery-feature-name]]
  plan_doc: [path to plan document]
  note_count: [number of change notes]
-->
```

Update `flow/brain/features/[feature-name].md` with plan details and link to discovery entry.

The file MUST carry `capture: brain` in its frontmatter — that key is how the store tells a captured note from a capability, and a note without it is drawn on the Blueprint board as a feature of the product.

---

## Resource Capture

During this skill's execution, watch for valuable reference materials worth preserving. See `.claude/resources/core/resource-capture.md` for capture rules, file format, and naming conventions.

At natural break points, if you encounter information that could be useful for future development (API specs, architecture notes, config references, domain knowledge, etc.), ask the user: "I found something that could be useful for future reference: _{brief description}_. Should I save it to `flow/resources/`?"

Only save if the user approves. Do not re-ask if declined.
