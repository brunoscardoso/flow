---
description: This command reviews a Pull Request from GitHub or Azure DevOps by invoking the `review-pr` skill. T
---

# Review PR Command

## Command Description

This command reviews a Pull Request from GitHub or Azure DevOps by invoking the `review-pr` skill. The command validates inputs and orchestrates the review process.

---


## Help

**If the user invokes this command with `-help`, display only this section and stop:**

```
/review-pr - Review Pull Request

DESCRIPTION:
  Reviews a Pull Request from GitHub or Azure DevOps. Authenticates,
  fetches PR details, and generates a detailed review document.

USAGE:
  /review-pr <pr_url>
  /review-pr <pr_url> --rabbit
  /review-pr -help

ARGUMENTS:
  pr_url     URL of the Pull Request to review
  --rabbit   CodeRabbit triage mode: fetch the PR's ACTIVE CodeRabbit
             comments, verify each as valid / not valid against the current
             code, and write a summary. For the NOT-valid ones it drafts
             replies (never posts without asking). For the VALID ones it can
             seed a discovery document so the fixes run through the normal
             /discovery-plan → /create-plan → /execute-plan pipeline.

EXAMPLES:
  /review-pr https://github.com/org/repo/pull/123
  /review-pr https://github.com/org/repo/pull/123 --rabbit
  /review-pr https://dev.azure.com/org/project/_git/repo/pullrequest/456
  /review-pr https://github.com/myorg/myrepo/pull/789

SUPPORTED PLATFORMS:
  - GitHub (github.com)
  - Azure DevOps (dev.azure.com, visualstudio.com)

OUTPUT:
  Default:   Creates: flow/reviewed-pr/<pr_identifier>.md
  --rabbit:  Creates: flow/reviewed-pr/coderabbit-triage-<pr_identifier>.md
             (optionally) flow/discovery/discovery_coderabbit-<pr_identifier>_v1.md

WORKFLOW:
  1. Validates PR URL format
  2. Authenticates using auth-pr tool
  3. Fetches PR information and diff
  4. Loads review patterns from project rules
  5. Analyzes code changes
  6. Generates review document

ADAPTIVE DEPTH:
  < 50 lines    Lightweight (security, logic bugs, breaking changes only)
  50-500 lines  Standard (full review)
  500+ lines    Deep (multi-pass, severity-grouped, executive summary)

REVIEW INCLUDES:
  - Summary of changes
  - Pattern compliance check
  - Code quality issues
  - Suggestions for improvement
  - Approval recommendation

RECOMMENDED MODEL:
  Claude Opus 4.6 or Sonnet 4.5 for best results

RELATED COMMANDS:
  /review-code   Review local changes instead
```

---

## Critical Rules

| Rule                     | Description                                              |
| ------------------------ | -------------------------------------------------------- |
| **Read-Only Analysis**   | This command ONLY produces a review document. **Exceptions** (both consent-gated): `--rabbit` mode may post reply comments (only after explicit user approval); and `--rabbit` mode may write a discovery-seed document to `flow/discovery/` (only after explicit user approval). Neither ever modifies source code. |
| **Never auto-reply**     | In `--rabbit` mode, NEVER post a reply automatically. Always ask the user first via the interactive question tool. |
| **Fix path is Discovery-First** | In `--rabbit` mode, VALID findings are NEVER fixed by editing source directly. They are routed through the standard `/discovery-plan` → `/create-plan` → `/execute-plan` pipeline via a seeded discovery document — honoring the project's Discovery-First rule. |
| **Complete and Stop**    | After presenting results, STOP and wait for user         |

---

## Instructions

### Step 1: Validate Inputs

| Input | Required | Description |
|-------|----------|-------------|
| `pr_link` | Yes | The URL of the Pull Request to review |
| `--rabbit` | Optional | Flag. When present, run **CodeRabbit Triage Mode** instead of a full code review (see below). |
| `language` | Optional | Primary language (auto-detected if not provided) |

**Mode routing**: URL validation (Step 2) and skill invocation (Step 3) run in both modes. When `--rabbit` is present, pass the flag through to the skill, which routes to its **CodeRabbit Triage Mode** workflow instead of a fresh review. The output path in Step 4 becomes `flow/reviewed-pr/coderabbit-triage-<pr_identifier>.md`.

---

## CodeRabbit Triage Mode (`--rabbit`)

When invoked with `--rabbit`, the command does NOT perform a fresh code review. Instead it triages the **existing CodeRabbit bot comments** already on the PR and produces two actionable outputs — one for the not-valid comments, one for the valid ones:

1. **Fetch active CodeRabbit comments** — only the bot's currently-active comments (unresolved AND not outdated); resolved/outdated ones are ignored.
2. **Verify each** against the current code and reuse the verification pass (Step 3b) to classify each as **VALID** (Confirmed/Likely) or **INVALID** (Dismissed) — with a concrete reason grounded in the code.
3. **Write the summary MD** to `flow/reviewed-pr/coderabbit-triage-<pr_identifier>.md`. Each finding **preserves CodeRabbit's own category label line** (e.g. `🎯 Functional Correctness | 🟡 Minor | ⚡ Quick win`) and is titled `{title} - VALID` / `{title} - INVALID`. Every INVALID finding carries a `Comment PR:` block — the ready-to-post reply explaining, politely and technically, why it does not apply. Example:

   ```
   🎯 Functional Correctness | 🟡 Minor | ⚡ Quick win
   Gate Lite access on feature-flag readiness - INVALID
   Comment PR:
   Thanks! This is already handled — the guard keeps the shell pending until
   isReady is true, so a Lite tenant never sees the blocked screen.
   ```
4. **Ask before posting (INVALID replies)** — present the count of drafted `Comment PR:` replies and use the interactive question tool (`AskUserQuestion`) to ask whether to post them automatically. **Never post without an explicit "yes".** If declined, the replies stay in the MD for the user to copy manually.
5. **Seed the fix pipeline (VALID findings)** — the VALID findings are the real work. After triage, ask (via `AskUserQuestion`) whether to seed a **discovery document** from them at `flow/discovery/discovery_coderabbit-<pr_identifier>_v1.md`. This routes the fixes through the standard **Discovery-First** pipeline: the user then runs `/create-plan` and `/execute-plan` to fix them with full verification, risk assessment, and per-task commits. The review skill itself NEVER edits source code — it only writes the discovery seed, and only with consent.

The skill owns the exact commands and templates. See: `.claude/resources/skills/review-pr-skill.md` (CodeRabbit Triage Mode section).

### Step 2: Validate PR URL Format

- **GitHub**: Must contain `github.com` and `/pull/`
- **Azure DevOps**: Must contain `dev.azure.com` or `visualstudio.com` and `pullrequest`

### Step 3: Invoke Review PR Skill

The skill will:
1. Authenticate using the `auth-pr` tool
2. Fetch PR information
3. Load review patterns
4. Analyze code changes
5. Generate review document

See: `.claude/resources/skills/review-pr-skill.md`

### Step 4: Present Results

```markdown
Review done.
File: `flow/reviewed-pr/{filename}.md`
Findings: C critical · H high · M medium · L low
```

Write the chat summary in short, clear sentences (ASD-STE100 style); say it once; do not repeat a finished result.

---

## Example Usage

```bash
# Review a GitHub PR
review-pr https://github.com/org/repo/pull/123

# Review an Azure DevOps PR
review-pr https://dev.azure.com/org/project/_git/repo/pullrequest/456
```

## Context Loading

This command uses the **project brain** for context retrieval. Before executing, query it for relevant documentation:

**Queries**:
- `planflow-ai state-query "PR review workflow" --scope resources`
- `planflow-ai state-query "adaptive depth" --scope resources`
- `planflow-ai state-query "severity ranking" --scope resources`
- `planflow-ai state-query "PR authentication" --scope resources`

The brain returns ranked chunks from indexed markdown files. Use the top results to inform execution.

---

## Related Resources

| Resource                       | Purpose                                |
| ------------------------------ | -------------------------------------- |
| `review-pr-skill.md`          | Skill that executes the review         |
| `auth-pr-tool.md`             | Authentication tool for PR platforms   |
| `review-pr-patterns.md`       | Review patterns and guidelines         |

---

## Tasklist Updates

Update `flow/tasklist.md` at these points. See `.claude/resources/core/project-tasklist.md` for full rules.

1. **On start**: Add "Review PR: #{number}" to **In Progress** (or move it from To Do if it already exists)
2. **On complete**: Move "Review PR: #{number}" to **Done** with today's date

---

## Learn Recommendations

After the PR review completes, check for learning opportunities. See `.claude/resources/core/learn-recommendations.md` for the full system.

**PR review-specific checks** (scan the diff for):
- **New imports** from packages not previously used in the project
- **Pattern changes** (different state management, different API patterns, new testing approaches)
- **New configuration files** for tools not previously in the project (Docker, CI/CD, etc.)
- **Framework migrations** (major version upgrades, framework switches)

Present recommendations at the end of the review document, after the summary:

```markdown
## Learn Opportunities

The following new technologies/patterns were detected in this PR:

- `/learn zustand` — New state management library introduced (replaces Redux)
- `/learn docker` — Docker configuration added to the project for the first time

Run any of these to build structured understanding before or after merging.
```

---

## STATE.md Updates

Update `flow/STATE.md` at these transition points to enable session resumability.

**Format**: the exact syntax — bullet grammar, section headings, em dashes, field order — is pinned in `.claude/resources/core/state-md.md`. The reader is a strict regex; a file that drifts from that grammar parses to an empty state, silently.

| Transition Point | Action |
|-----------------|--------|
| **Review start** | Create `flow/STATE.md` with `- **Active Skill**: review-pr`, `- **Active Plan**: {feature}` — the plan the PR implements, or `none` only when the PR has no plan context — `- **Current Phase**: none`, `- **Current Task**: reviewing PR #{number}`, and `## Next Action`: `Authenticate, fetch PR, and analyze` |
| **Review complete** | Rewrite `flow/STATE.md` with `- **Active Skill**: review-pr`, `- **Active Plan**: {feature}` (unchanged), `- **Current Phase**: none`, `- **Current Task**: review complete`, and `## Next Action`: `Address findings in flow/reviewed-pr/pr_{number}.md` |

**Never delete `flow/STATE.md` on completion.** The state exists for whoever comes next: a review is one stage of a pipeline, and an absent file reads as nothing in flight. Completion is a write, not a cleanup. If `Active Plan` already names a *different* feature when the review finishes, another pipeline is mid-flight — leave the Execution State fields as they are and record the completion under `## Decisions` instead of blanking a live handoff.

**Field syntax**: every field is a bullet under a `## Execution State` heading — `- **Active Skill**: {value}` — with a top-level `**Updated**: {ISO-8601}` line above it and the next step on its own line under `## Next Action`. `Active Plan` is the plan's `{feature}` name, never a path. The reader (`src/cli/state/state-md-parser.ts`) is a strict line parser: a field written any other way is dropped silently.

---

## Brain Capture

After PR review completes, append a brain-capture block. See `.claude/resources/core/brain-capture.md` for processing rules.

**Capture the following**:

```
<!-- brain-capture
skill: review-pr
feature: [PR title or scope]
status: completed
data:
  pr_number: [PR number]
  pr_platform: [github/azure-devops]
  issues_found: [total count]
  review_outcome: [approved/changes-requested/commented]
  severity_critical: [count]
  severity_warning: [count]
-->
```

Log to `flow/brain/sessions/YYYY-MM-DD.md` with PR review summary.

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
| < 50 | **Lightweight** | Quick-scan for security, logic bugs, breaking changes only. Skips pattern loading, full analysis, verification pass. |
| 50–500 | **Standard** | Full review (current behavior, no changes). |
| 500+ | **Deep** | Multi-pass review with file categorization, severity-grouped output, executive summary, and mandatory verification pass. |

Thresholds are hardcoded. The detected mode is displayed before the review starts.

See `.claude/resources/core/review-adaptive-depth.md` for full rules.

---

## Verification Pass

After initial analysis, all findings undergo a second-pass verification. Each finding is re-examined against 15 lines of surrounding context and classified as Confirmed, Likely, or Dismissed. False positives are filtered before output. A Verification Summary shows filter stats.

See `.claude/resources/core/review-verification.md` for classification criteria, category-specific questions, and output format.
