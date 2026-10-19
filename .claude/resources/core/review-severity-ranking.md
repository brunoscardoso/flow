
# Review Severity Re-Ranking

## Purpose

After all findings are collected and verified, re-rank them by actual impact rather than listing in file order. Group related findings across files and present critical issues first. This applies to **all review modes** (lightweight findings are already minimal, but if multiple issues are found, they should still be severity-ordered).

**Scope**: `/review-code` (Step 5c) and `/review-pr` (Step 3c). Applied after verification, before generating the output document.

**Goal**: Ensure the most impactful findings appear first. Reviewers should never have to scan past 10 minor style issues to find a critical security bug.

---

## Ranking Algorithm

After verification classifies findings as Confirmed or Likely, sort using this priority:

1. **Severity** (primary): Critical → Major → Minor → Suggestion
2. **Action class** (secondary, within same severity): ask-user → auto-fix → no-op
3. **Confidence** (tertiary, within same action class): Confirmed → Likely
4. **Fix complexity** (quaternary, within same confidence): Lower complexity first (quick wins surface earlier)

This ranking applies regardless of which file the finding came from.

### Action Class Grouping

Within each severity section, group presentation by the finding's `action` field (see the Action Classification rules in `.claude/resources/core/review-multi-agent.md`):

1. **ask-user** findings first — they need the developer's judgment and must never be buried or silently resolved
2. **auto-fix** findings next — mechanical issues safe to fix without discussing intent
3. **no-op** findings last — informational only

Findings without an `action` field (older review documents) sort as if `ask-user` — surface them for human judgment.

---

## Grouping Related Findings

Before final output, scan the sorted findings for groupable patterns:

| Pattern | Group Condition | Example Group Title |
|---------|----------------|---------------------|
| Same issue type in multiple files | ≥ 2 findings with matching issue category | "Missing input validation in 3 API endpoints" |
| Same root cause | ≥ 2 findings traceable to one underlying problem | "Inconsistent error handling (5 occurrences)" |
| Causal chain | Findings where one enables/causes another | "Auth bypass: missing check → unprotected route → data exposure" |

### Grouping Rules

- **Only group when genuinely related** — don't force-group unrelated findings just because they share a severity level
- **Small reviews (1-3 findings)**: No grouping. Keep findings individual.
- **Use the highest severity in the group** as the group's severity level
- **Show individual occurrences** within the group with `file:line` references
- **Provide a single suggested fix** that addresses all occurrences when possible

### Grouped Finding Format

```markdown
### Finding N: {Group Title} ({count} occurrences)

| Field          | Value                                            |
| -------------- | ------------------------------------------------ |
| Severity       | {Highest severity in group}                      |
| Action         | {Most conservative action in group: ask-user → auto-fix → no-op} |
| Fix Complexity | {Average complexity}/10 - {Level}                |
| Pattern        | {Reference to pattern from rules, if applicable} |

**Occurrences**:

| # | File | Line | Status |
|---|------|------|--------|
| 1 | `{file_path}` | {line} | {Confirmed/Likely} |
| 2 | `{file_path}` | {line} | {Confirmed/Likely} |
| 3 | `{file_path}` | {line} | {Confirmed/Likely} |

**Description**:
{Explanation of the shared issue pattern}

**Suggested Fix**:
\`\`\`{language}
// Single fix pattern that addresses all occurrences
\`\`\`
```

---

## Executive Summary Trigger

| Review Mode | Trigger |
|-------------|---------|
| **Lightweight** | Never (too few findings to warrant) |
| **Standard** | When total findings ≥ 5 |
| **Deep** | Always (built into deep template) |

When triggered in standard mode, prepend this before the findings section:

```markdown
## Executive Summary

**Risk level**: {Low | Medium | High}

**Top issues to address**:

1. {Finding title} ({Severity}) — `{file}:{line}`
2. {Finding title} ({Severity}) — `{file}:{line}`
3. {Finding title} ({Severity}) — `{file}:{line}`
```

Show up to 3 top findings. Derive risk level from the **severity floor** (see Risk Level: Shared Definition below):
- **High**: Any Critical finding, or ≥ 3 Major findings
- **Medium**: Any Major finding, or ≥ 5 Minor findings
- **Low**: Only Minor/Suggestion findings, fewer than 5 total

---

## Risk Level: Shared Definition

Plan-flow has **ONE** risk definition (`low | medium | high`), shared by the review flows (this file) and the Post-Execution Risk Assessment in `.claude/resources/skills/execute-plan-skill.md` (Step 7b2). It has two layers:

### Layer 1 — Severity Floor (objective input)

Derived mechanically from finding counts. Risk is **at least** this level when the thresholds hit:

| Floor | Threshold |
|-------|-----------|
| **High** | Any Critical finding, or ≥ 3 Major findings |
| **Medium** | Any Major finding, or ≥ 5 Minor findings |
| **Low** | Only Minor/Suggestion findings, fewer than 5 total |

### Layer 2 — Judgment Rubric (on top of the floor)

The assessor's holistic judgment of the changeset:

| Level | Meaning |
|-------|---------|
| `low` | Well-bounded, mostly cosmetic, or straightforward with little ambiguity |
| `medium` | Room to improve, but safe to merge first with concerns addressed as follow-ups |
| `high` | Should not be merged without explicit human approval — fundamental, risky, ambiguous, or carrying strong negative signals |

Strong negative signals — failed verifications, withheld repairs (`failed-needs-decision`), unresolved escalations (recorded in `flow/.rounds.jsonl` during execution) — push the judgment toward `high`.

### Reconciliation Rule

**Final risk = max(severity floor, judgment).** A changeset's risk is **never lower than its severity floor** — judgment may only raise the level, never lower it below the floor. This guarantees the review flow and the execute-plan risk step cannot contradict each other: whichever flow assesses the changeset, the same floor applies underneath the same rubric.

---

## Output Structure

All review modes now use severity-grouped output instead of per-file ordering:

```markdown
## Critical Findings
### 1. {Finding title}
...

## Major Findings
### 2. {Finding title}
...

## Minor Findings
### 3. {Finding title}
...

## Suggestions
### 4. {Finding title}
...
```

**Empty sections**: Omit severity sections that have no findings (e.g., if no Critical findings, skip the "Critical Findings" heading entirely).

**Action ordering within sections**: Inside each severity section, list ask-user findings first, then auto-fix, then no-op (see Action Class Grouping above).

---

## Insertion Points

### For review-code-skill.md

Insert as **Step 5c: Re-Rank and Group Findings** — after Step 5b (Verify Findings), before Step 6b (Pattern Review).

### For review-pr-skill.md

Insert as **Step 3c: Re-Rank and Group Findings** — after Step 3b (Verify Findings), before Step 4 (Generate Document).

---

## Related Files

| File | Purpose |
|------|---------|
| `.claude/resources/skills/review-code-skill.md` | Add Step 5c (Re-Rank and Group) |
| `.claude/resources/skills/review-pr-skill.md` | Add Step 3c (Re-Rank and Group) |
| `.claude/resources/patterns/review-code-templates.md` | Standard template uses severity grouping |
| `.claude/resources/core/review-adaptive-depth.md` | Deep mode already severity-groups; this extends to standard |
| `.claude/resources/core/review-verification.md` | Verification runs before re-ranking |
| `.claude/resources/core/review-multi-agent.md` | Action Classification rules (source of truth for the `action` field) |
| `.claude/resources/skills/execute-plan-skill.md` | Post-Execution Risk Assessment (Step 7b2) — consumes the shared risk definition (severity floor + judgment rubric) |
