---
description: This command reviews local uncommitted changes by invoking the `review-code` skill. The command vali
---

# Review Code Command

## Command Description

This command reviews local uncommitted changes by invoking the `review-code` skill. The command validates inputs and orchestrates the review process.

---


## Help

**If the user invokes this command with `-help`, display only this section and stop:**

```
/review-code - Review Local Code Changes

DESCRIPTION:
  Reviews local uncommitted changes against project patterns and best
  practices. Generates a detailed review document.

USAGE:
  /review-code [file_path] [--scope <staged|unstaged>]
  /review-code -help

ARGUMENTS:
  file_path   Optional. Specific file to review (reviews all if not provided)
  --scope     Optional. "staged" or "unstaged" (reviews both if not provided)

EXAMPLES:
  /review-code                              # Review all changes
  /review-code --scope staged               # Review only staged changes
  /review-code src/services/userService.ts  # Review specific file
  /review-code src/api --scope unstaged     # Review unstaged in directory

OUTPUT:
  Creates: flow/reviewed-code/<filename>.md

WORKFLOW:
  1. Identifies changed files via git diff
  2. Loads review patterns from project rules
  3. Finds similar implementations in codebase
  4. Compares against existing patterns
  5. Generates review document with findings

ADAPTIVE DEPTH:
  < 50 lines    Lightweight (security, logic bugs, breaking changes only)
  50-500 lines  Standard (full review)
  500+ lines    Deep (multi-pass, severity-grouped, executive summary)

REVIEW CATEGORIES:
  - Pattern compliance
  - Code quality issues
  - Potential bugs
  - Performance concerns
  - Security considerations

RECOMMENDED MODEL:
  Claude Opus 4.6 or Sonnet 4.5 for best results

RELATED COMMANDS:
  /review-pr    Review a Pull Request instead
```

---

> **Autopilot chains this for you.** When a chain is driving, the harness issues the next stage from observable state — no command decides on its own whether to continue, and before it issues one it runs `planflow-ai flow stage <stage> --check --feature <slug> --chain <id>`, which refuses a stage whose predecessor left no proof for this run's feature — a refusal stops the chain, it never advances past it. The message that started you names the slug to write your document under; name it anything else and the next stage is refused. Three pauses are honoured and no others: `high` risk before anything is published (`planflow-ai flow risk --check`), the guard classifier's `ask`, and a branch nobody has bound at publish time. Outside a chain the standard rules below apply — stop and wait for the user.

## Critical Rules

| Rule                     | Description                                              |
| ------------------------ | -------------------------------------------------------- |
| **Read-Only Analysis**   | This command ONLY produces a review document             |
| **Complete and Stop**    | After presenting results, STOP. Under a chain, the harness decides what follows |

---

## Instructions

### Step 1: Validate Inputs

| Input | Required | Description |
|-------|----------|-------------|
| `file_path` | No | Specific file to review (if not provided, reviews all changes) |
| `scope` | No | `staged` or `unstaged` (if not provided, reviews both) |
| `language` | No | Primary language (auto-detected if not provided) |

### Step 2: Check for Changes

Verify there are changes to review using `git diff`.

### Step 3: Invoke Review Code Skill

The skill will:
1. Identify changed files
2. Load review patterns
3. Find similar implementations in codebase
4. Compare patterns against existing code
5. Generate review document

See: `.claude/resources/skills/review-code-skill.md`

### Step 3b: Link Related Projects in this Workspace (REQUIRED in a Workspace — skipped silently outside one)

Projects of one Workspace share knowledge, and the touchpoints between them are
recorded as you work — not reconstructed later.

```bash
planflow-ai workspace status --target . --json
```

`workspace: null` → skip this step and say nothing about it. Otherwise:

1. Search the sibling projects for the changed endpoints, payloads and shared types:
   `planflow-ai brain search "<topic>" --scope workspace` — hits are namespaced
   `<project>/…`; a `link` hit is a touchpoint someone already recorded.
2. In the review document, list under **Related projects in this Workspace** each sibling that consumes or provides what the change touches — a changed payload with a consumer in another project is a finding, not a footnote.
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

### Step 4: Present Results

```markdown
Review done.
File: `flow/reviewed-code/{filename}.md`
Findings: C critical · H high · M medium · L low
Workspace links: N recorded        # this line only in a Workspace
```

Write the chat summary in short, clear sentences (ASD-STE100 style); say it once; do not repeat a finished result.

---

## Example Usage

```bash
# Review all changes
review-code

# Review only staged changes
review-code --scope staged

# Review a specific file
review-code src/services/userService.ts
```

## Context Loading

This command uses the **project brain** for context retrieval. Before executing, query it for relevant documentation:

**Queries**:
- `planflow-ai state-query "code review workflow" --scope resources`
- `planflow-ai state-query "adaptive depth" --scope resources`
- `planflow-ai state-query "severity ranking" --scope resources`
- `planflow-ai state-query "multi-agent review" --scope resources`

The brain returns ranked chunks from indexed markdown files. Use the top results to inform execution.

---

## Related Resources

| Resource                       | Purpose                                |
| ------------------------------ | -------------------------------------- |
| `review-code-skill.md`        | Skill that executes the review         |
| `review-pr-patterns.md`       | Review patterns and guidelines         |

---

## Tasklist Updates

Update `flow/tasklist.md` at these points. See `.claude/resources/core/project-tasklist.md` for full rules.

1. **On start**: Add "Review: {scope}" to **In Progress** (or move it from To Do if it already exists)
2. **On complete**: Move "Review: {scope}" to **Done** with today's date

---

## Learn Recommendations

After the review completes, check for learning opportunities. See `.claude/resources/core/learn-recommendations.md` for the full system.

**Review-specific checks** (scan the diff for):
- **New imports** from packages not previously used in the project
- **Pattern changes** (different state management, different API patterns, new testing approaches)
- **New configuration files** for tools not previously in the project (Docker, CI/CD, etc.)

Present recommendations at the end of the review document, after the summary:

```markdown
## Learn Opportunities

The following new technologies/patterns were detected in this changeset:

- `/learn zustand` — New state management library introduced (replaces Redux)
- `/learn` — Non-trivial error patterns worth capturing as reusable knowledge

Run any of these to build structured understanding before or after merging.
```

---

## STATE.md Updates

Update `flow/STATE.md` at these transition points to enable session resumability.

**Format**: the exact syntax — bullet grammar, section headings, em dashes, field order — is pinned in `.claude/resources/core/state-md.md`. The reader is a strict regex; a file that drifts from that grammar parses to an empty state, silently.

| Transition Point | Action |
|-----------------|--------|
| **Review start** | Create `flow/STATE.md` with `- **Active Skill**: review-code`, `- **Active Plan**: {feature}` — the plan under review, or `none` only when the review has no plan context — `- **Current Phase**: none`, `- **Current Task**: reviewing {scope}`, and `## Next Action`: `Analyze changes and generate review` |
| **Review complete** | Rewrite `flow/STATE.md` with `- **Active Skill**: review-code`, `- **Active Plan**: {feature}` (unchanged), `- **Current Phase**: none`, `- **Current Task**: review complete`, and `## Next Action`: `Address findings in flow/reviewed-code/review_{scope}.md` |

**Never delete `flow/STATE.md` on completion.** The state exists for whoever comes next: a review is one stage of a pipeline, and an absent file reads as nothing in flight. Completion is a write, not a cleanup. If `Active Plan` already names a *different* feature when the review finishes, another pipeline is mid-flight — leave the Execution State fields as they are and record the completion under `## Decisions` instead of blanking a live handoff.

**Field syntax**: every field is a bullet under a `## Execution State` heading — `- **Active Skill**: {value}` — with a top-level `**Updated**: {ISO-8601}` line above it and the next step on its own line under `## Next Action`. `Active Plan` is the plan's `{feature}` name, never a path. The reader (`src/cli/state/state-md-parser.ts`) is a strict line parser: a field written any other way is dropped silently.

---

## Brain Capture

After code review completes, append a brain-capture block. See `.claude/resources/core/brain-capture.md` for processing rules.

**Capture the following**:

```
<!-- brain-capture
skill: review-code
feature: [feature or scope reviewed]
status: completed
data:
  files_reviewed: [count]
  issues_found: [total count]
  severity_critical: [count]
  severity_warning: [count]
  severity_info: [count]
  pattern_conflicts: [list of pattern conflicts found, if any]
-->
```

Update `flow/brain/features/[feature-name].md` if reviewing a known feature. Log to `flow/brain/sessions/YYYY-MM-DD.md` otherwise.

The file MUST carry `capture: brain` in its frontmatter — that key is how the store tells a captured note from a capability, and a note without it is drawn on the Blueprint board as a feature of the product.

---

## Resource Capture

During this skill's execution, watch for valuable reference materials worth preserving. See `.claude/resources/core/resource-capture.md` for capture rules, file format, and naming conventions.

At natural break points, if you encounter information that could be useful for future development (API specs, architecture notes, config references, domain knowledge, etc.), ask the user: "I found something that could be useful for future reference: _{brief description}_. Should I save it to `flow/resources/`?"

Only save if the user approves. Do not re-ask if declined.

---

## Multi-Agent Parallel Review

For Deep mode reviews (500+ lines), the review is split into 4 specialized subagents running in parallel:

| Agent | Focus | Model |
|-------|-------|-------|
| Security | Vulnerabilities, secrets, injection, auth bypass | sonnet |
| Logic & Bugs | Edge cases, null handling, race conditions, wrong logic | sonnet |
| Performance | N+1 queries, memory leaks, blocking I/O, re-renders | sonnet |
| Pattern Compliance | Forbidden/allowed patterns, naming, consistency | haiku |

The coordinator merges results, deduplicates overlapping findings, then runs verification and re-ranking.

See `.claude/resources/core/review-multi-agent.md` for full rules.

---

## Adaptive Depth

Review depth scales automatically based on changeset size:

| Lines Changed | Mode | Behavior |
|--------------|------|----------|
| < 50 | **Lightweight** | Quick-scan for security, logic bugs, breaking changes only. Skips pattern loading, similar implementations, verification pass. |
| 50–500 | **Standard** | Full review (current behavior, no changes). |
| 500+ | **Deep** | Multi-pass review with file categorization, severity-grouped output, executive summary, and mandatory verification pass. |

Thresholds are hardcoded. The detected mode is displayed before the review starts.

See `.claude/resources/core/review-adaptive-depth.md` for full rules and `.claude/resources/patterns/review-code-templates.md` for lightweight and deep templates.

---

## Verification Pass

After initial analysis, all findings undergo a second-pass verification. Each finding is re-examined against 15 lines of surrounding context and classified as Confirmed, Likely, or Dismissed. False positives are filtered before output. A Verification Summary shows filter stats.

See `.claude/resources/core/review-verification.md` for classification criteria, category-specific questions, and output format.

---

## Pattern Capture

During code review, silently watch for anti-patterns found in changed code, good patterns that should be documented, and pattern conflicts between new and existing code. Append captured patterns to `flow/resources/pending-patterns.md` without interrupting work.

After analysis, present any buffered patterns for user approval. Approved patterns are written to `.claude/rules/core/allowed-patterns.md` or `.claude/rules/core/forbidden-patterns.md`.

See `.claude/resources/core/pattern-capture.md` for buffer format, capture triggers, conflict detection, and the full review protocol.
