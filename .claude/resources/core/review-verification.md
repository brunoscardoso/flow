
# Review Verification

## Purpose

Second-pass verification step for `/review-code` and `/review-pr`. After the initial analysis produces findings, each finding is re-examined against surrounding code context to filter false positives. Reduces noise, improves trust in the final review output.

Also defines **Re-Review Memory**: prior finding verdicts (`review_verdict` entries in `flow/.rounds.jsonl`) suppress re-reporting of findings the user already dismissed, and every finding outcome leaves an audit trail — nothing is silently dropped.

**Scope**: `/review-code` (Step 5b) and `/review-pr` (Step 3b). Applied after analysis, before document generation.

**Goal**: Surface only actionable findings. A review that cries wolf on false positives trains developers to ignore it. Verification ensures every reported finding is worth the developer's attention.

---

## Verification Step Definition

For each finding from the initial analysis:

1. Re-read **15 lines above and 15 lines below** the flagged line (30 lines of context total)
2. Evaluate **3 standard verification questions** (same for every finding)
3. Evaluate **1 category-specific question** (based on the finding's category)
4. Classify the finding as **Confirmed**, **Likely**, or **Dismissed**
5. Assign or confirm the finding's `action` field (`auto-fix` | `ask-user` | `no-op`) per the Action Classification rules in `.claude/resources/core/review-multi-agent.md`. If the initial analysis assigned one, confirm it against the context just re-read; if missing, assign it now. When in doubt, default to `ask-user`.
6. Check the finding against prior review verdicts loaded at review start — see the **Re-Review Memory** section below for the suppression and re-report rules.

Apply this process to every finding before generating the review document.

---

## Standard Verification Questions

Ask these three questions for every finding, regardless of category:

**Q1 — Is this actually a bug/issue, or does the surrounding code handle it?**
Check if adjacent code (error handling, guards, fallbacks, input validation) already addresses the concern raised. Look 15 lines above for upstream guards and 15 lines below for downstream handling.

**Q2 — Is there a test that covers this case?**
Look for test files related to the flagged code. If a test explicitly covers the scenario being flagged, the finding may be a false positive — the behavior is intentional and validated.

**Q3 — Would a senior developer agree this is a real issue?**
Apply the experienced developer filter. Trivial style preferences, subjective choices, or extremely minor nits that would not appear in a real code review should be dismissed. If the concern is valid but low-stakes, it may still qualify as a Suggestion.

---

## Category-Specific Verification Questions

After the three standard questions, evaluate one additional question based on the finding's category:

| Category | Verification Question |
|----------|----------------------|
| Security | Is there actually an exploit path, or is this internal-only code with no user input reaching the flagged point? |
| Logic bug | Can this code path actually be reached with the flagged state? Trace the call chain from entry points. |
| Performance | Is this in a hot path (called per-request, inside a loop, on every render), or is it called once during init/setup? |
| Pattern violation | Does the surrounding code intentionally deviate for a documented reason (comment, TODO, legacy marker, explicit override)? |
| Missing test | Is this logic already covered by integration or e2e tests, even if no unit test exists for this specific function? |
| Error handling | Is the error actually possible at this point, or is it prevented by upstream validation or type constraints? |
| Type safety | Does the runtime context guarantee the type, even if TypeScript cannot prove it statically? |

---

## Classification Criteria

| Classification | Criteria | Action |
|---------------|----------|--------|
| **Confirmed** | Clear issue with evidence from context. At least 2 of 3 standard questions support the finding. | Keep in output as-is |
| **Likely** | Probable issue but context is ambiguous. 1 of 3 standard questions supports; others are uncertain. | Keep in output with `[Likely]` tag |
| **Dismissed** | False positive. Context clearly shows the code is correct. All 3 standard questions fail to support the finding. | Remove from output |

### Conservative Classification Rules

**Rule 1 — When in doubt, choose Likely over Dismissed.**
It is better to show an ambiguous finding to the user than to hide a real issue. Only dismiss when context clearly resolves the concern.

**Rule 2 — Never dismiss a Critical severity finding.**
Critical findings can be downgraded to Likely at most. A Critical finding that appears to be a false positive should be tagged `[Likely]` and explained — never silently removed.

---

## Re-Review Memory (Prior Verdicts)

Re-reviews of the same scope must not re-report findings the user already dismissed. At review start, the review skill loads `review_verdict` entries from `flow/.rounds.jsonl` (and archived `flow/archive/rounds_*.jsonl`) matching the current scope (`/review-code` Step 2c, `/review-pr` Step 2c) and applies these rules during the verification pass.

### Audit Trail Rule — No Silent Drops

**Dismissed findings are no longer silently dropped.** Every finding outcome gets a `review_verdict` rounds entry appended to `flow/.rounds.jsonl`:

- Findings dismissed **during the verification pass** → entry with `classification: "dismissed"` and the dismissal reason, written at document generation time
- Findings the **user acts on** after reading the review → one entry per finding with `classification: "kept" | "dismissed" | "deferred"` and a short reason
- Findings **suppressed by a prior verdict** → no new entry; the prior verdict already is their audit trail

The entry shape is defined once in `.claude/resources/skills/execute-plan-skill.md` (Rounds Record section): `{ts, run_id, type: "review_verdict", phase: null, finding_fingerprint, classification, reason}` — reference it, do not redefine it. The rounds file is append-only and skill-written; never edit or delete existing entries.

### Finding Fingerprint

The fingerprint identifies a finding across reviews:

```
finding_fingerprint = "<file>+<title>+<category>"
```

The `<category>` component is the finding's `category` field — the finding-type taxonomy (`Security | Logic | Performance | Pattern`, as emitted by the review sub-agents in `.claude/resources/core/review-multi-agent.md`). It is NOT the file categorization from adaptive depth (Core Logic / Infrastructure / UI / Tests).

Example: `src/auth/token.ts+Missing expiry check+Logic`

**Known coarseness** — the fingerprint is deliberately coarse:

- Line numbers are excluded because they drift between reviews as code moves
- Titles may vary slightly between review runs (rephrasing of the same issue)
- Two distinct issues in the same file could, in rare cases, produce similar titles

**Conservative matching rule**: fingerprint matching is conservative — when unsure whether a current finding matches a prior verdict (title rephrased, category shifted, file renamed), treat it as **NEW and report it**. A duplicate report is a minor annoyance; a hidden real issue is not.

### Suppression Rules

For each finding that survives classification (Confirmed or Likely), compare its fingerprint against prior verdicts. When multiple verdicts share a fingerprint, the most recent wins.

| Prior verdict | Behavior |
|---------------|----------|
| `dismissed` | **Suppress** — do not re-report, **unless the code at that location materially changed** since the verdict |
| `deferred` | Re-report, tagged `[previously deferred]` in the title |
| `kept` | Re-report normally (if still present, it was not fixed — worth repeating) |
| No match | Report normally (new finding) |

**Materially changed**: the code at the finding's location (the function/block containing it) has been edited since the verdict's timestamp — e.g. the current diff touches those lines, or the surrounding logic differs from what the dismissal reasoned about. A dismissal verdict covers the code as it was; new code at the same spot gets a fresh look. When unsure whether the change is material, report the finding.

**ask-user exemption**: findings with `action: ask-user` are **EXEMPT from suppression — always relayed to the user**, regardless of any prior verdict. Ask-user findings challenge deliberate intent or require human judgment; hiding them based on a coarse fingerprint match risks silently resolving exactly the class of finding that must never be silently resolved (see `.claude/resources/core/review-multi-agent.md`).

Suppressed findings are counted in the Verification Summary (see below) so the suppression is visible, not silent.

---

## Output Format

### Verification Summary Template

Include this block in the review document, after the Review Summary metrics table:

```markdown
## Verification Summary

| Metric | Count |
|--------|-------|
| Initial findings | {N} |
| Confirmed | {N} |
| Likely (needs human judgment) | {N} |
| Dismissed (false positives filtered) | {N} |
| Suppressed (prior dismissed verdict) | {N} |
| **False positive rate** | **{N}%** |
```

> Omit the Suppressed row when re-review memory found no matching prior verdicts (first review of a scope).

### Finding Tag Format

Likely findings get `[Likely]` prepended to their title:

```markdown
### [Likely] Finding Title
```

Findings re-reported after a prior `deferred` verdict get `[previously deferred]` prepended to their title (after `[Likely]`, if both apply):

```markdown
### [previously deferred] Finding Title
```

Confirmed findings have no special tag — they are the default and need no marker.

Dismissed findings are removed from the review document — but they are **not silently dropped**: each gets a `review_verdict` rounds entry with `classification: "dismissed"` and the reason (see the Audit Trail Rule above). Suppressed findings are likewise absent from the document and counted in the Verification Summary.

### Verified Finding Schema

Every finding that survives verification (Confirmed or Likely) carries both a classification and an action:

```
- classification: "Confirmed" | "Likely"
- action: "auto-fix" | "ask-user" | "no-op"
```

The `action` field is assigned or confirmed during the verification pass (step 5 above) per the Action Classification rules in `.claude/resources/core/review-multi-agent.md`. It is required for new reviews; older review documents without it remain valid.

### Review Summary Metrics Update

The existing Review Summary metrics table should reflect post-verification counts:

```markdown
| Metric | Value |
|--------|-------|
| Total findings (before verification) | {N} |
| **Findings after verification** | **{N}** |
| Critical | {N} |
| Major | {N} |
| Minor | {N} |
| Suggestion | {N} |
```

---

## Insertion Points

### For review-code-skill.md

Insert as **Step 5b: Verify Findings** — after Step 5 (Pattern Conflicts), before Step 6b (Pattern Review).

### For review-pr-skill.md

Insert as **Step 3b: Verify Findings** — after Step 3 (Analyze Code Changes), before Step 4 (Generate Document).

### Logic (same for both)

```
1. Collect all findings from the analysis step
2. For each finding:
   a. Re-read surrounding context (15 lines above + 15 lines below)
   b. Evaluate 3 standard verification questions
   c. Evaluate 1 category-specific question
   d. Classify as Confirmed / Likely / Dismissed
   e. Assign or confirm the action field (auto-fix / ask-user / no-op) per review-multi-agent.md
   f. Check prior verdicts (Re-Review Memory): suppress on a dismissed-verdict match
      unless the code materially changed; tag [previously deferred] on a deferred match;
      NEVER suppress ask-user findings; when unsure of a match, treat as NEW
3. Remove Dismissed and suppressed findings from the findings list
4. Append a review_verdict rounds entry (classification: "dismissed") for each finding
   dismissed in this pass — no silent drops
5. Tag Likely findings with [Likely] and re-reported deferred findings with
   [previously deferred] in their titles
6. Generate Verification Summary stats (including suppressed count)
7. Proceed to document generation with the filtered findings list
8. After the user acts on the findings, append one review_verdict entry per finding
   (kept / dismissed / deferred + reason) — see the review skills' recording steps
```

---

## Related Files

| File | Purpose |
|------|---------|
| `.claude/resources/skills/review-code-skill.md` | Add Step 5b (Verify Findings); loads prior verdicts (Step 2c), records verdicts (Step 7) |
| `.claude/resources/skills/review-pr-skill.md` | Add Step 3b (Verify Findings); loads prior verdicts (Step 2c), records verdicts (Step 5) |
| `.claude/resources/skills/execute-plan-skill.md` | Rounds Record section — `review_verdict` entry shape (single source of truth) |
| `.claude/resources/core/review-multi-agent.md` | Action Classification — ask-user findings are never silently resolved (suppression exemption) |
| `flow/.rounds.jsonl` + `flow/archive/rounds_*.jsonl` | Durable store of `review_verdict` entries (re-review memory) |
| `.claude/resources/patterns/review-code-templates.md` | Add Verification Summary to review document template |
| `.claude/commands/review-code.md` | Add verification reference |
| `.claude/commands/review-pr.md` | Add verification reference |
