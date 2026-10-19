
# Review Code Skill

## Purpose

Perform a comprehensive **read-only analysis** of locally changed files (uncommitted changes) using established patterns and guidelines, then generate a structured review document.

This skill **only produces a markdown file** with findings. It does NOT:

- Modify any code
- Make commits
- Execute any scripts beyond git commands and graphify queries (Step 2d)

---

## Restrictions - READ ONLY

This skill is **strictly read-only analysis**. The review process:

1. **Reads** the local diff (staged and unstaged changes)
2. **Searches** the codebase for similar implementations as reference
3. **Analyzes** changes against patterns and guidelines
4. **Generates** a markdown file with findings and recommendations

**No code modification, no commits, no builds.**

### NEVER Do These Actions

| Forbidden Action                      | Reason                                     |
| ------------------------------------- | ------------------------------------------ |
| Edit/modify any source code           | No code changes - review produces findings |
| `git commit`                          | No commits                                 |
| `git add`                             | No staging changes                         |
| `git checkout`                        | No discarding changes                      |
| `git reset`                           | No resetting changes                       |
| `npm run build`                       | No build commands                          |
| `npm run test`                        | No test commands                           |
| Create/edit files outside `flow/` | Only the writable locations in the Important note below (reviewed-code, pending-patterns, approved rules, rounds append) |

### Allowed Actions

| Allowed Action                         | Purpose                         |
| -------------------------------------- | ------------------------------- |
| `git status`                           | List changed files              |
| `git diff`                             | View uncommitted changes        |
| `git diff --cached`                    | View staged changes             |
| `git diff --name-only`                 | List changed file names         |
| `git log` (read only)                  | View commit history for context |
| Read any project file                  | Find similar implementations    |
| Search codebase (grep, glob, semantic) | Find reference patterns         |
| Write to `flow/reviewed-code/`     | Save review notes locally       |
| Read `flow/.rounds.jsonl` + `flow/archive/rounds_*.jsonl` | Load prior review verdicts (re-review memory) |
| Append to `flow/.rounds.jsonl`         | Record `review_verdict` entries (append-only) |
| Read project rule files                | Load patterns for analysis      |
| `graphify affected` / `graphify query` / `graphify explain` | Read-only structural queries (Step 2d) |
| `graphify update .`          | Staleness refresh per graphify-engine.md — writes only to `graphify-out/` |

> **Important**: The ONLY writable locations are `flow/reviewed-code/`, `flow/resources/pending-patterns.md`, `.claude/rules/core/*.md` (for approved patterns), and `flow/.rounds.jsonl` (append-only, `review_verdict` entries only). The graphify staleness refresh (Step 2d) writes only to `graphify-out/` — done by the tool itself, never by hand. No source code, configuration files, or any other project files should be modified.

---

## Inputs

| Input       | Required | Description                                          |
| ----------- | -------- | ---------------------------------------------------- |
| `file_path` | Optional | Specific file(s) to review (defaults to all changed) |
| `language`  | Optional | Primary language (auto-detected if not provided)     |
| `scope`     | Optional | `all` (default), `staged`, or `unstaged` changes     |

---

## Workflow

### Step 1: Identify Changed Files

1. Run `git status` to identify all changed files
2. Run `git diff --name-only` to get list of unstaged changes
3. Run `git diff --cached --name-only` to get list of staged changes
4. If `file_path` is provided, filter to only those files
5. If `scope` is provided, filter to staged or unstaged only

### Step 1b: Determine Review Depth

Determine the review mode based on changeset size. See `.claude/resources/core/review-adaptive-depth.md` for full rules.

1. Count total lines changed (additions + deletions) from `git diff --stat`
2. Exclude lock files, generated files, and pure whitespace changes from the count
3. Classify into tier:
   - **Small** (< 50 lines) → **Lightweight** mode
   - **Medium** (50–500 lines) → **Standard** mode (no behavior change)
   - **Large** (500+ lines) → **Deep** mode
4. Display: `**Review mode**: {Lightweight|Standard|Deep} ({N} lines changed across {M} files)`

**If Lightweight**: Skip Steps 2–5 (pattern loading, similar implementations, full analysis, pattern conflicts). Perform abbreviated analysis checking ONLY security issues, obvious logic bugs, and breaking changes. Skip verification pass (Step 5b). Generate output using the lightweight template from `review-code-templates.md`.

**If Deep**: Activate multi-agent parallel review. See `.claude/resources/core/review-multi-agent.md`. Categorize files by type (Core Logic, Infrastructure, UI/Presentation, Tests), then spawn 4 specialized subagents in parallel (security, logic & bugs, performance, pattern compliance). The coordinator runs Step 2b (Load Plan Intent) and Step 2d (Structural Blast Radius) itself before spawning, so the Intent block (when found) and the `## Structural Context` section (when the graphify engine is enabled) are injected into every subagent prompt. The coordinator collects results, deduplicates overlapping findings, then proceeds to Step 5b (verification), Step 5c (re-ranking), Step 6b (pattern review), and Step 6 (output using deep template). Steps 2–5 are handled by subagents instead of the main agent.

**If Standard**: Proceed with all steps as defined below (no behavior change).

---

### Step 2: Load Review Patterns

1. Read `.claude/resources/patterns/review-pr-patterns.md` for general review guidelines
2. Based on the detected language(s), load the appropriate pattern file:
   - **TypeScript/JavaScript**: Load `.claude/resources/languages/typescript-patterns.md`
   - **Python**: Load `.claude/resources/languages/python-patterns.md`
3. Cross-reference with `.claude/rules/core/forbidden-patterns.md` for anti-patterns to flag
4. Cross-reference with `.claude/rules/core/allowed-patterns.md` for best practices to encourage
5. Use the [`complexity-scoring` pattern](../core/complexity-scoring.md) for fix complexity scoring

### Step 2b: Load Plan Intent (if available)

Check `flow/plans/` for an active plan matching the changeset:

1. List plan files in `flow/plans/` (never `flow/archive/`)
2. A plan **matches** when the changed files overlap the files referenced by the plan's phases/tasks, or the plan's feature name clearly corresponds to the changeset
3. If a matching plan contains an `## Intent` block (Goal / Constraints / Ruled Out — see `.claude/resources/patterns/plans-templates.md`, "Intent Section"), extract it **verbatim**
4. **Inject the Intent block verbatim** into every review sub-agent prompt (deep mode) and keep it in context during analysis (standard mode)

**Purpose**: Intent tells a deliberate decision apart from a mistake — an approach the plan explicitly ruled out is a decision, not an oversight, and a "missing" feature may be a stated constraint. This significantly reduces false-positive findings, and informs `action` classification (challenging deliberate intent → ask-user, per `.claude/resources/core/review-multi-agent.md`).

**Fallback — ad-hoc intent**: If no plan matches or the matching plan has no `## Intent` block, ask the user one question via `AskUserQuestion`:

> "What was this change trying to accomplish? One sentence is enough."

Include a **Skip** option. If the user answers, inject the answer as the Intent context for every review sub-agent prompt (deep mode) and keep it in context during analysis (standard mode) — it plays the same role as a plan Intent block (false-positive filtering, `action` classification). If the user skips, proceed without intent exactly as today (backward compatible).

### Step 2c: Load Re-Review Memory (prior verdicts)

At review start, load prior review verdicts for the current scope:

1. Read `flow/.rounds.jsonl` (if present) and any archived rounds files matching `flow/archive/rounds_*.jsonl`
2. Collect `review_verdict` entries whose `finding_fingerprint` references a file in the current changeset. The entry shape is defined once in `.claude/resources/skills/execute-plan-skill.md` (Rounds Record section) — reference it, do not redefine it
3. Build a verdict map keyed by `finding_fingerprint` (`<file>+<title>+<category>`); when multiple entries share a fingerprint, the most recent wins
4. Hold the verdict map for the verification pass (Step 5b). Suppression and re-report rules are defined in `.claude/resources/core/review-verification.md` (Re-Review Memory section)

If no rounds files exist or no verdicts match the scope, proceed without re-review memory (backward compatible).

### Step 2d: Structural Blast Radius (graphify engine)

Engine-gated structural analysis of the changeset. All graphify mechanics — invocation patterns, Output Token Guard, staleness check, fallback — are defined in `.claude/resources/core/graphify-engine.md`; apply them, never restate them.

1. **Gate on the engine registry** (`engines.graphify` in `flow/.flowconfig`):
   - `enabled` AND `graphify-out/graph.json` exists → proceed
   - **UNSET** and `which graphify` succeeds → this is graphify's **first use**: fire the consent flow per `.claude/resources/core/engine-registry.md` (detect → consent → record, then the consent-time build from graphify-engine.md). Enabled → proceed; declined → skip
   - `declined`, tool not installed, or no graph → **skip this step** with the standard one-line notice (graphify-engine.md, Universal Fallback Rule) and continue the review natively
2. **Staleness check**: Run the staleness check per graphify-engine.md before any query
3. **Blast radius per changed file**: Run `graphify affected "<file>" --depth 1 --relation calls --relation imports` for each changed file — issue the invocations **in parallel**
4. **Aggregate** across all results:
   - **God nodes touched** — the highest-degree nodes across results, each with its edge count (e.g. `APIRouter — 47 edges`)
   - **Communities spanned** — count of distinct communities the affected nodes fall into
   - **Affected dependents** — deduplicated list of affected nodes, grouped by changed file
5. **Cap the aggregate** with the Output Token Guard (~1,500 tokens) from graphify-engine.md, including the mandatory drill-down hint when truncated
6. **Inject** the capped aggregate as a `## Structural Context` section into every review sub-agent prompt (deep mode — alongside the Intent block from Step 2b) and keep it in context during analysis (standard mode). It feeds the risk signals in Step 5c and the `### Verify These Dependents` section in Step 6

Any graphify failure at any point → Universal Fallback Rule: native review + one-line notice. Graphify problems never block or fail a review.

### Step 3: Find Similar Implementations in Codebase

**This is a critical step that differentiates this from PR review.**

For each changed file:

1. **Identify the type of code being written**:

   - Component? Search for similar components
   - Utility function? Search for similar utilities
   - API route? Search for similar routes
   - Hook? Search for similar hooks
   - Type/interface? Search for similar type definitions

2. **Search for existing patterns in the codebase**:

   ```bash
   # Example searches to find similar code
   # For components:
   grep -r "export const" --include="*.tsx" src/components/

   # For hooks:
   grep -r "export function use" --include="*.ts" src/hooks/

   # For API routes:
   grep -r "export async function" --include="route.ts" src/app/api/
   ```

3. **Document the reference implementations found**:

   - File path of similar code
   - Key patterns used in that code
   - How the new code differs (if at all)

4. **Flag pattern inconsistencies**:
   - New code uses a different pattern than existing code
   - New code introduces a pattern not documented in rules
   - New code conflicts with established patterns

### Step 4: Analyze Code Changes

For each changed file:

1. Review the diff/changes using `git diff {file_path}`
2. Check for violations of forbidden patterns
3. Verify adherence to allowed patterns
4. Apply language-specific checks
5. **Compare against similar implementations found in Step 3**
6. Identify security, performance, and maintainability concerns
7. **Flag any pattern conflicts with existing codebase**

### Step 5: Identify Pattern Conflicts

**This is unique to local code review.**

When a pattern conflict is found:

1. **Document the conflict**:

   - What pattern the new code uses
   - What pattern exists in similar code
   - Which file(s) contain the reference pattern

2. **Determine the correct resolution**:

   - If existing pattern is better -> recommend changing new code
   - If new pattern is better -> recommend updating rules AND existing code
   - If unclear -> flag for team discussion

3. **Generate rule update recommendations**:
   - Suggest additions to `.claude/rules/core/allowed-patterns.md`
   - Suggest additions to `.claude/rules/core/forbidden-patterns.md`

4. **Buffer patterns for capture**: Silently append identified patterns (both good patterns and anti-patterns found during review) to `flow/resources/pending-patterns.md`. See `.claude/resources/core/pattern-capture.md` for buffer format and capture triggers.

---

### Step 5b: Verify Findings

After collecting all findings from Steps 4 and 5, run a second-pass verification to filter false positives. See `.claude/resources/core/review-verification.md` for full logic.

**For each finding**:

1. **Re-read surrounding context** — Read 15 lines above and 15 below the flagged line
2. **Ask 3 standard questions**:
   - Is this actually a bug, or does surrounding code handle it?
   - Is there a test that covers this case?
   - Would a senior developer agree this is a real issue?
3. **Ask 1 category-specific question** (security → exploit path, logic → reachability, performance → hot path, etc.)
4. **Classify**:
   - **Confirmed** — Clear issue, 2+ standard questions support it. Keep as-is.
   - **Likely** — Ambiguous, 1 question supports. Tag with `[Likely]` in output.
   - **Dismissed** — False positive, all questions fail. Remove from output.
5. **Assign or confirm `action`**: Classify each surviving finding as `auto-fix` / `ask-user` / `no-op` per the Action Classification rules in `.claude/resources/core/review-multi-agent.md`. When in doubt, default to `ask-user`.
6. **Check prior verdicts** (re-review memory): Compare the finding's fingerprint (`<file>+<title>+<category>`) against the verdict map from Step 2c, per the Re-Review Memory rules in `.claude/resources/core/review-verification.md`:
   - Prior `dismissed` verdict → **suppress** (do not re-report), **unless the code at that location materially changed** since the verdict
   - Prior `deferred` verdict → re-report, tagged `[previously deferred]`
   - **ask-user findings are EXEMPT from suppression** — always relayed to the user, regardless of any prior verdict
   - Fingerprint matching is conservative: when unsure whether a finding matches a prior verdict, treat it as NEW (report it)

**Rules**:
- When in doubt between Likely and Dismissed → choose **Likely**
- NEVER dismiss a Critical severity finding (downgrade to Likely at most)

**After verification**: Remove Dismissed findings, remove suppressed findings (counting them in the Verification Summary), tag Likely and `[previously deferred]` findings, generate Verification Summary stats. Dismissed findings are not silently dropped — each gets a `review_verdict` rounds entry per `.claude/resources/core/review-verification.md` (audit trail rule); suppressed findings need no new entry (the prior verdict already is their audit trail).

### Step 5c: Re-Rank and Group Findings

After verification, re-rank all remaining findings by impact. See `.claude/resources/core/review-severity-ranking.md` for full rules.

1. **Sort findings**: Severity (Critical → Major → Minor → Suggestion), then Action class (ask-user → auto-fix → no-op), then Confidence (Confirmed → Likely), then Fix Complexity (lower first)
2. **Group related findings**: Scan for same issue type across files, same root cause, or causal chains. Only group when genuinely related (≥ 2 findings). Skip grouping for small reviews (1-3 findings).
3. **Executive summary**: If total findings ≥ 5 (standard mode) or always (deep mode), prepend an executive summary with risk level and top 3 findings. Skip for lightweight mode.
4. **Structure output by severity**: Use severity-grouped sections (Critical → Major → Minor → Suggestions) instead of per-file ordering. Omit empty severity sections.
5. **Structural risk signals** (only when Step 2d produced a `## Structural Context` section): the risk-level judgment gains two **raise-only** negative signals:
   - `touches god node <X> (<N> edges)`
   - `spans <M> communities`

   Blast radius can only RAISE the risk judgment, never lower it — the severity floor and the `max(floor, judgment)` rule from `.claude/resources/core/review-severity-ranking.md` are unchanged. The executive summary and individual findings may cite god nodes directly (e.g. "touches APIRouter — 47 edges"). When the engine is off, risk is judged exactly as today.

---

### Step 5d: Link Related Projects in this Workspace (REQUIRED in a Workspace — skipped silently outside one)

`planflow-ai workspace status --target . --json` — `workspace: null` means skip this
step silently. In a Workspace: search the siblings for the changed endpoints, payloads and shared types
(`planflow-ai brain search "<topic>" --scope workspace`, hits namespaced
`<project>/…`); in the review document, list under **Related projects in this Workspace** each sibling that consumes or provides what the change touches — a changed payload with a consumer in another project is a finding, not a footnote. Record each touchpoint with
`planflow-ai workspace link-knowledge --target . --from <project>/<feature-or-anchor> --to <project>/<feature-or-anchor> --kind calls|exposes|consumes|relates --note "<why/how>" --json`
— the one writer of the Workspace's links (full step: `.claude/commands/review-code.md`).
Report `Workspace links: N recorded` (zero with its reason).

### Step 6b: Pattern Review

After analysis but before generating the review document, run the pattern review protocol:

1. Read `flow/resources/pending-patterns.md`
2. If the buffer has entries, present grouped patterns for user approval
3. Write approved patterns to `.claude/rules/core/allowed-patterns.md` or `.claude/rules/core/forbidden-patterns.md`
4. Clear the buffer

See `.claude/resources/core/pattern-capture.md` for the full end-of-skill review protocol.

---

### Step 6: Generate Review Document

**Important**: Only include Confirmed and Likely findings in the output. Dismissed findings are excluded. Add the Verification Summary section after the Review Summary.

Create a markdown file in `flow/reviewed-code/` with the naming convention:

```
code-review-{date}-{sanitized-description}.md
```

**Example**: For changes related to user authentication:

```
flow/reviewed-code/code-review-2026-01-14-user-authentication.md
```

**Output Format**: Use the templates from `.claude/resources/patterns/review-code-templates.md`

**Structural section** (only when Step 2d ran with the engine enabled): append a `### Verify These Dependents` section to the review document, rendering the capped affected-node list from Step 2d — dependents grouped by changed file, god nodes flagged with their edge counts, and the truncation hint preserved when the Output Token Guard capped the list. **Omit the section entirely when the engine is off, declined, or unavailable** — reviews without graphify look exactly like today's output.

---

### Step 7: Record Review Verdicts

After the user acts on the review findings (fixes, dismisses, or defers them), append **one `review_verdict` entry per finding** to `flow/.rounds.jsonl`:

- `classification: "kept"` — the user accepted the finding (fixed it, or acknowledged it as real)
- `classification: "dismissed"` — the user rejected the finding (not an issue / intentional)
- `classification: "deferred"` — the user postponed the finding (real, but not now)
- Always include a short `reason`

The entry shape is defined once in `.claude/resources/skills/execute-plan-skill.md` (Rounds Record section) — reference it, do not redefine it. For `run_id`: reuse the matching plan's execution run-id when the review covers work from an active run (visible in recent `flow/.rounds.jsonl` entries); otherwise use `review-<YYYYMMDD-HHMMSS>`.

Findings dismissed during the verification pass (Step 5b) also get a `review_verdict` entry with `classification: "dismissed"` and the dismissal reason — written at document generation time, not deferred to user action. See `.claude/resources/core/review-verification.md` (audit trail rule).

The rounds file is **append-only**: never edit or delete existing entries. This is the ONE exception to the read-only rule — appending `review_verdict` entries to `flow/.rounds.jsonl` is allowed; nothing else in that file may be touched.

### Blueprint Anchors & Node Context

Where a finding maps to identifiable code (a specific file, symbol, table, endpoint, or module), attach an `anchors` array to its `review_verdict` entry — anchored verdicts are promoted into the blueprint annotation stream on the next derive; entries without anchors behave exactly as before. During analysis, `planflow-ai blueprint context <node>` may be used for structural context around a changed node (node + direct edges + anchored annotations); output is hard-capped at ~1,500 tokens with a mandatory drill-down hint, so it is safe to inject as-is. Anchor envelope, resolution kinds, and promotion rules are defined once in `.claude/resources/core/blueprint.md` — reference it, never restate it.

---

## Severity Levels

| Level      | Description                                              |
| ---------- | -------------------------------------------------------- |
| Critical   | Security vulnerabilities, data loss risks, blocking bugs |
| Major      | Significant issues affecting functionality or quality    |
| Minor      | Code style, minor improvements, non-critical concerns    |
| Suggestion | Nice-to-have improvements, optional enhancements         |

---

## Action Classification

Every finding also carries an `action` field: `auto-fix` | `ask-user` | `no-op`. The classification rules are defined once in `.claude/resources/core/review-multi-agent.md` (Action Classification section) — apply them, do not redefine them here. **When in doubt, default to ask-user.**

**Presentation rules**:

- **ask-user findings are relayed to the user verbatim** — include the finding id, file, and full description. They must NEVER be silently resolved, summarized away, or dropped.
- Within each severity section, present ask-user findings first, then auto-fix, then no-op (see `.claude/resources/core/review-severity-ranking.md`).
- **Review auto-fix stays OFF by default** — the taxonomy is classification-only for now and exists to enable a future bounded auto-fix mode. This skill remains strictly read-only regardless of action class.
- `action` is required for new reviews; existing review documents without it remain valid.

---

## Pattern Conflict Resolution

When a conflict is found between new code and existing patterns:

### Option 1: Update New Code (Recommended for established patterns)

If the existing pattern is:

- Documented in rules files
- Used consistently across the codebase
- Has clear benefits

**Action**: Update the new code to match the existing pattern.

### Option 2: Update Rules (For better new patterns)

If the new pattern is:

- Demonstrably better than existing
- More maintainable or readable
- Follows best practices that existing code doesn't

**Action**:

1. Document the new pattern in `allowed-patterns.md`
2. Add the old pattern to `forbidden-patterns.md`
3. Create a task to refactor existing code (optional)

### Option 3: Team Discussion (For unclear cases)

If:

- Both patterns have valid trade-offs
- Team preference is unclear
- Architectural decision is required

**Action**: Flag for team discussion before committing.

---

## Finding Similar Implementations

### Search Strategies by Code Type

| Code Type       | Search Strategy                                          |
| --------------- | -------------------------------------------------------- |
| React Component | Search `src/components/` for similar component structure |
| Custom Hook     | Search `src/hooks/` for similar hook patterns            |
| Utility         | Search `src/utils/` for similar utility functions        |
| API Route       | Search `src/app/api/` for similar route handlers         |
| Type Definition | Search `src/types/` for similar type structures          |
| Store/State     | Search `src/stores/` for similar state management        |
| Test File       | Search `__tests__/` for similar test patterns            |

### Key Aspects to Compare

When comparing new code with reference implementations:

1. **Naming Conventions**: Do variable/function names follow the same pattern?
2. **Error Handling**: Is error handling consistent?
3. **Type Definitions**: Are types structured similarly?
4. **Code Organization**: Is the file structure consistent?
5. **Comments/Documentation**: Does documentation follow the same style?
6. **Import Structure**: Are imports organized the same way?
7. **Export Patterns**: Default vs named exports consistency?

---

## Quick Reference Commands

```bash
# Review all uncommitted changes
review-code

# Review specific file
review-code src/services/userService.ts

# Review only staged changes
review-code --scope staged

# Review only unstaged changes
review-code --scope unstaged

# Review with explicit language
review-code --language typescript
```

---

## Related Files

| File                                               | Purpose                              |
| -------------------------------------------------- | ------------------------------------ |
| `.claude/resources/patterns/review-pr-patterns.md`  | Main review checklist and guidelines |
| `.claude/resources/patterns/review-code-templates.md` | Output templates for review docs     |
| `.claude/rules/core/forbidden-patterns.md`          | Anti-patterns to flag                |
| `.claude/rules/core/allowed-patterns.md`            | Best practices to encourage          |
| `.claude/resources/languages/typescript-patterns.md` | TypeScript-specific checks           |
| `.claude/resources/languages/python-patterns.md`    | Python-specific checks               |
| `.claude/resources/core/complexity-scoring.md`          | Fix complexity scoring system        |
| `.claude/resources/core/review-multi-agent.md`      | Action Classification rules (`action` field) |
| `.claude/resources/patterns/plans-templates.md`     | `## Intent` section definition (Step 2b)     |
| `flow/plans/`                                      | Active plans checked for a matching Intent block |
| `.claude/resources/core/review-verification.md`     | Verification pass + Re-Review Memory rules (Steps 2c, 5b, 7) |
| `.claude/resources/skills/execute-plan-skill.md`    | Rounds Record section — `review_verdict` entry shape (single source of truth) |
| `flow/.rounds.jsonl` + `flow/archive/rounds_*.jsonl` | Prior review verdicts read at Step 2c; verdicts appended at Step 7 |
| `.claude/resources/core/graphify-engine.md`         | Graphify mechanics — invocation, token guard, staleness, fallback (Step 2d) |
| `.claude/resources/core/engine-registry.md`         | Engine consent lifecycle — first-use consent at Step 2d |
| `graphify-out/graph.json`                          | Local AST knowledge graph queried at Step 2d |
| `flow/reviewed-code/`                              | Output folder for review documents   |

---

## Workflow Integration

After running this command:

1. **Review the generated document** in `flow/reviewed-code/`
2. **Address Critical and Major findings** before committing
3. **Resolve pattern conflicts** by choosing the appropriate resolution
4. **Update rule files** if recommended (add to allowed/forbidden patterns)
5. **Commit changes** once review concerns are addressed

> The goal is not just to review current changes, but to **improve the codebase patterns over time** by documenting good patterns and preventing anti-patterns from spreading.

### Validation Checklist

- [ ] All changed files analyzed
- [ ] Forbidden patterns checked
- [ ] Allowed patterns verified
- [ ] Similar implementations searched
- [ ] Pattern conflicts documented
- [ ] Verification pass completed — all findings classified
- [ ] Dismissed findings removed from output
- [ ] Likely findings tagged with `[Likely]`
- [ ] Verification Summary section included
- [ ] Every finding assigned an `action` (auto-fix / ask-user / no-op)
- [ ] Findings sorted by severity (Critical → Major → Minor → Suggestion)
- [ ] Within each severity, findings grouped by action (ask-user → auto-fix → no-op)
- [ ] Ask-user findings relayed verbatim (id, file, full description) — none silently resolved
- [ ] Related findings grouped when applicable (≥ 2 related)
- [ ] Executive summary included when ≥ 5 findings (standard) or always (deep)
- [ ] Prior verdicts loaded (Step 2c); findings matching a `dismissed` verdict suppressed unless the code materially changed
- [ ] Previously deferred findings re-reported with `[previously deferred]` tag
- [ ] Ask-user findings never suppressed by prior verdicts
- [ ] `review_verdict` entries appended to `flow/.rounds.jsonl` for every finding outcome (Step 7)
- [ ] Structural blast radius gathered when engine enabled (Step 2d) — or skipped with one-line notice
- [ ] Structural risk signals applied raise-only (Step 5c) — never lowered the risk level
- [ ] `### Verify These Dependents` section included when the engine ran; omitted entirely when off
