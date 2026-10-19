# Review Adaptive Depth

## Purpose

`/review-code` and `/review-pr` pick their depth from the size of the changeset
rather than running one fixed pipeline. A three-line fix does not need four
parallel sub-agents, and a 2,000-line changeset is not served by a single pass.
The mode is decided in Step 1b of both skills, before any analysis runs, and is
shown to the reader.

> **Written, not recovered (#1959 / #1949 guard).** Six shipped files pointed
> here "for full rules" and this file did not exist. Its content is
> consolidated from the surfaces that already stated the rules — Step 1b of
> `review-code-skill.md` and `review-pr-skill.md`, and the mode table in
> `.claude/commands/review-code.md` — not invented.

---

## Thresholds

Counted as **additions + deletions** over the changeset.

| Lines changed | Mode | What runs |
|---------------|------|-----------|
| < 50 | **Lightweight** | Security issues, obvious logic bugs and breaking changes only. Skips pattern loading, similar implementations, full analysis, pattern conflicts and the verification pass. Lightweight output template. |
| 50–500 | **Standard** | The full single-pass review. This is the behaviour that existed before modes did, unchanged. |
| 500+ | **Deep** | Multi-agent parallel review with file categorization, severity-grouped output, an executive summary and a **mandatory** verification pass. Deep output template. |

**Thresholds are hardcoded.** They are not a config key, and nothing reads them
from `flow/.flowconfig`.

---

## Counting the Changeset

The count decides the mode, so what it excludes matters more than the number:

1. Take `git diff --stat` (`/review-code`), or `gh pr diff --stat` / the Azure
   DevOps diff API (`/review-pr`).
2. **Exclude** lock files, generated files, and pure-whitespace changes.
3. Classify by the table above.
4. Display before reviewing anything:

   ```
   **Review mode**: {Lightweight|Standard|Deep} ({N} lines changed across {M} files)
   ```

Step 2 is what keeps the mode honest. A regenerated lock file or a reformat can
be thousands of lines that nobody wrote, and counting them would send a trivial
change into Deep mode — paying for four sub-agents to review a diff with no
human decisions in it. The reverse matters too: a reviewer who sees "Deep" for a
whitespace commit stops trusting the label.

---

## What Each Mode Changes

**Lightweight** skips Steps 2–5 of the review skill. It is deliberately not "a
faster full review": it looks for the three classes of finding that are worth
interrupting someone over at any size, and does not pretend to have checked
pattern compliance.

**Standard** is the baseline. No step is added or removed.

**Deep** replaces the single-pass analysis steps with parallel sub-agents — see
`.claude/resources/core/review-multi-agent.md`, which is a *consumer* of this
file: Deep mode is its prerequisite, and it never activates on its own. The
coordinator runs Step 2b (Load Plan Intent) and Step 2d (Structural Blast
Radius) itself before spawning, so the Intent block and the
`## Structural Context` section reach every sub-agent prompt, then collects,
deduplicates, verifies and re-ranks.

The verification pass is **optional in Lightweight (skipped), optional in
Standard, and mandatory in Deep**. A large changeset is where an unverified
finding costs the most, because there are enough findings that nobody checks
them individually.

---

## Severity Is Not Depth

Depth decides *how much work the review does*; severity decides *how much a
finding matters*. They are independent, and neither bounds the other: a
Lightweight review can produce a Critical finding, and a Deep review can
produce nothing but informational ones. See
`.claude/resources/core/review-severity-ranking.md` — Deep mode already groups
output by severity, which is a presentation of the ranking, not a change to it.

---

## Related Files

| File | Purpose |
|------|---------|
| `.claude/resources/skills/review-code-skill.md` | Step 1b — where the mode is decided for local changes |
| `.claude/resources/skills/review-pr-skill.md` | Step 1b — the same, for a PR |
| `.claude/resources/core/review-multi-agent.md` | The Deep-mode pipeline this triggers |
| `.claude/resources/core/review-severity-ranking.md` | Severity, which depth does not affect |
| `.claude/resources/core/review-verification.md` | The verification pass, mandatory in Deep |
| `.claude/resources/patterns/review-code-templates.md` | The lightweight and deep output templates |
