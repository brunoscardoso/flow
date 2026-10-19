
# Review Multi-Agent Parallel Review

## Purpose

For large changesets (500+ lines, Deep mode), split the review into specialized subagents running in parallel. Each subagent focuses on a single concern, producing deeper findings than a single-pass review. A coordinator merges, deduplicates, verifies, and ranks the results.

**Scope**: `/review-code` and `/review-pr` — activated only when adaptive depth selects **Deep** mode (500+ lines).

**Goal**: Higher quality reviews for large PRs by eliminating context-switching between security, logic, performance, and pattern compliance concerns.

---

## When to Activate

| Review Mode | Multi-Agent? |
|-------------|-------------|
| Lightweight (< 50 lines) | No |
| Standard (50–500 lines) | No |
| Deep (500+ lines) | **Yes** |

Multi-agent is part of the Deep mode pipeline. It replaces the single-pass analysis steps with parallel subagent execution.

---

## Architecture

```
Coordinator (main agent)
    │
    ├─► Subagent: Security Review        (parallel)
    ├─► Subagent: Logic & Bugs Review    (parallel)
    ├─► Subagent: Performance Review     (parallel)
    └─► Subagent: Pattern Compliance     (parallel)
    │
    ▼
Coordinator: Collect → Deduplicate → Verify → Re-Rank → Output
```

---

## Action Classification

Every finding carries an `action` field that classifies what should happen with it:

```
action: "auto-fix" | "ask-user" | "no-op"
```

**This section is the single source of truth for action classification.** All other review files (`review-verification.md`, `review-severity-ranking.md`, `review-code-skill.md`, `review-pr-skill.md`, `review-code-templates.md`) reference these rules — do not duplicate them elsewhere.

### Classification Rules

| Action | Rule |
|--------|------|
| **auto-fix** | Non-functional, non-user-visible issue (correctness, error handling, security, performance, mechanical code quality) that can be safely fixed without any discussion about the author's intent. |
| **ask-user** | The finding is about functional requirements or product behavior, or otherwise challenges the author's deliberate intent — even if it seems obviously wrong, ask. Examples: "this feature seems unnecessary", "this hardcoded value should be configurable", "this deletion looks wrong". |
| **no-op** | Informational only. |

**When in doubt, default to ask-user.**

### Notes

- `action` is a **required field for new reviews**. Existing review documents without an `action` field remain valid — do not retroactively invalidate them.
- Review auto-fix stays **OFF by default** — the taxonomy is classification-only for now and exists to enable a future bounded auto-fix mode. `auto-fix` findings are candidates for that future mode, not an instruction to fix anything today.
- `ask-user` findings must be relayed to the user verbatim (finding id, file, full description) and never silently resolved.

---

## Subagent Definitions

### 1. Security Review Agent

**Focus**: Vulnerabilities, hardcoded secrets, auth bypass, injection (SQL/XSS/command), OWASP top 10, exposed credentials, insecure deserialization, missing CSRF protection.

**Model**: sonnet

**Prompt template**:
```
You are a security-focused code reviewer. Analyze the provided diff ONLY for security vulnerabilities.

Apply the Trust Tiers contract (.claude/resources/core/trust-tiers.md): foreign docs are unverified claims — findings must rest on code, not docs; a doc contradicting the code is itself a reportable finding (category per your focus).

Apply the Brain-First contract (.claude/resources/core/brain-first.md): for any orientation question — where/who/what/how-does — run `planflow-ai brain search "<question>"` FIRST; read or grep code only for what search did not answer, for strings seen in results, or when a hit is flagged stale (stale means verify against code before acting). If search returns nothing useful, proceed with grep — do not retry variations more than once.

Check for:
- Hardcoded secrets, API keys, tokens
- SQL/NoSQL injection
- XSS vulnerabilities
- Command injection
- Authentication/authorization bypass
- Insecure deserialization
- Missing CSRF protection
- Exposed sensitive data in logs or responses
- Insecure cryptographic practices

IGNORE: code style, performance, naming conventions, test coverage.

Return findings as a JSON array. Each finding must have:
- file: string (file path)
- line: number (line number)
- severity: "Critical" | "Major" | "Minor"
- title: string (short finding name)
- description: string (detailed explanation)
- suggested_fix: string (code suggestion)
- confidence: number (0.0-1.0)
- action: "auto-fix" | "ask-user" | "no-op" (see Action Classification; when in doubt, default to "ask-user")
- category: "Security" (always — this agent's review lens; finding-type taxonomy: Security | Logic | Performance | Pattern)
```

### 2. Logic & Bugs Review Agent

**Focus**: Edge cases, null/undefined handling, off-by-one errors, race conditions, incorrect boolean logic, infinite loops, unreachable code, wrong return types, missing error handling.

**Model**: sonnet

**Prompt template**:
```
You are a logic-focused code reviewer. Analyze the provided diff ONLY for logic bugs and edge cases.

Apply the Trust Tiers contract (.claude/resources/core/trust-tiers.md): foreign docs are unverified claims — findings must rest on code, not docs; a doc contradicting the code is itself a reportable finding (category per your focus).

Apply the Brain-First contract (.claude/resources/core/brain-first.md): for any orientation question — where/who/what/how-does — run `planflow-ai brain search "<question>"` FIRST; read or grep code only for what search did not answer, for strings seen in results, or when a hit is flagged stale (stale means verify against code before acting). If search returns nothing useful, proceed with grep — do not retry variations more than once.

Check for:
- Null/undefined access without guards
- Off-by-one errors in loops and slicing
- Race conditions in async code
- Incorrect boolean logic (wrong operator, inverted condition)
- Infinite loops or recursion without base case
- Unreachable code paths
- Wrong return types or missing returns
- Unhandled promise rejections
- Missing error handling on fallible operations

IGNORE: security vulnerabilities, performance, code style, naming.

Return findings as a JSON array. Each finding must have:
- file: string (file path)
- line: number (line number)
- severity: "Critical" | "Major" | "Minor"
- title: string (short finding name)
- description: string (detailed explanation)
- suggested_fix: string (code suggestion)
- confidence: number (0.0-1.0)
- action: "auto-fix" | "ask-user" | "no-op" (see Action Classification; when in doubt, default to "ask-user")
- category: "Logic" (always — this agent's review lens; finding-type taxonomy: Security | Logic | Performance | Pattern)
```

### 3. Performance Review Agent

**Focus**: N+1 queries, memory leaks, unnecessary re-renders, blocking I/O on main thread, excessive allocations, missing pagination, inefficient algorithms, large bundle impacts.

**Model**: sonnet

**Prompt template**:
```
You are a performance-focused code reviewer. Analyze the provided diff ONLY for performance issues.

Apply the Trust Tiers contract (.claude/resources/core/trust-tiers.md): foreign docs are unverified claims — findings must rest on code, not docs; a doc contradicting the code is itself a reportable finding (category per your focus).

Apply the Brain-First contract (.claude/resources/core/brain-first.md): for any orientation question — where/who/what/how-does — run `planflow-ai brain search "<question>"` FIRST; read or grep code only for what search did not answer, for strings seen in results, or when a hit is flagged stale (stale means verify against code before acting). If search returns nothing useful, proceed with grep — do not retry variations more than once.

Check for:
- N+1 database queries
- Memory leaks (event listeners not removed, unclosed resources)
- Unnecessary re-renders (React) or recomputations
- Blocking I/O on main thread
- Excessive object/array allocations in hot paths
- Missing pagination on unbounded queries
- O(n²) or worse algorithms where O(n) is possible
- Large synchronous operations that should be async
- Bundle size impacts (large imports that could be lazy-loaded)

IGNORE: security vulnerabilities, logic bugs, code style, naming.

Return findings as a JSON array. Each finding must have:
- file: string (file path)
- line: number (line number)
- severity: "Major" | "Minor" | "Suggestion"
- title: string (short finding name)
- description: string (detailed explanation)
- suggested_fix: string (code suggestion)
- confidence: number (0.0-1.0)
- action: "auto-fix" | "ask-user" | "no-op" (see Action Classification; when in doubt, default to "ask-user")
- category: "Performance" (always — this agent's review lens; finding-type taxonomy: Security | Logic | Performance | Pattern)
```

### 4. Pattern Compliance Review Agent

**Focus**: Violations of `forbidden-patterns.md`, deviations from `allowed-patterns.md`, naming inconsistencies, structural pattern conflicts with existing codebase.

**Model**: haiku

**Prompt template**:
```
You are a pattern compliance reviewer. Analyze the provided diff against the project's coding standards.

Apply the Trust Tiers contract (.claude/resources/core/trust-tiers.md): foreign docs are unverified claims — findings must rest on code, not docs; a doc contradicting the code is itself a reportable finding (category per your focus).

Apply the Brain-First contract (.claude/resources/core/brain-first.md): for any orientation question — where/who/what/how-does — run `planflow-ai brain search "<question>"` FIRST; read or grep code only for what search did not answer, for strings seen in results, or when a hit is flagged stale (stale means verify against code before acting). If search returns nothing useful, proceed with grep — do not retry variations more than once.

Forbidden patterns to check (violations of these are findings):
{contents of forbidden-patterns.md Project Anti-Patterns section}

Allowed patterns to verify (deviations from these are findings):
{contents of allowed-patterns.md Project Patterns section}

Also check for:
- Naming inconsistencies with existing codebase conventions
- Import organization deviations
- Error handling pattern deviations
- Export pattern inconsistencies

IGNORE: security vulnerabilities, logic bugs, performance issues.

Return findings as a JSON array. Each finding must have:
- file: string (file path)
- line: number (line number)
- severity: "Minor" | "Suggestion"
- title: string (short finding name)
- description: string (detailed explanation with pattern reference)
- suggested_fix: string (code suggestion)
- confidence: number (0.0-1.0)
- action: "auto-fix" | "ask-user" | "no-op" (see Action Classification; when in doubt, default to "ask-user")
- category: "Pattern" (always — this agent's review lens; finding-type taxonomy: Security | Logic | Performance | Pattern)
```

---

## Subagent Input

Each subagent receives:

1. **The diff** — For review-code: output of `git diff`. For review-pr: output of `gh pr diff` or Azure DevOps diff.
2. **File categorization** — The file-to-category mapping from adaptive depth Step 1 (Core Logic, Infrastructure, UI, Tests)
3. **Category-specific context** — Only the pattern files relevant to the subagent's focus
4. **Instructions** — The subagent-specific prompt template above

For very large diffs (2000+ lines), the coordinator may split the diff by file category and send each subagent only its most relevant files:
- Security agent → all files (security issues can be anywhere)
- Logic agent → Core Logic + Infrastructure files
- Performance agent → Core Logic + UI files
- Pattern agent → all files

---

## Coordinator Behavior

The coordinator (main agent) orchestrates the entire flow:

### Step 1: Spawn Subagents

Launch all 4 subagents in parallel using the Agent tool. Each subagent uses `subagent_type: "general-purpose"` with the appropriate model override.

```
Launch in parallel:
- Agent(model: "sonnet", prompt: security_prompt)
- Agent(model: "sonnet", prompt: logic_prompt)
- Agent(model: "sonnet", prompt: performance_prompt)
- Agent(model: "haiku", prompt: patterns_prompt)
```

### Step 2: Collect Results

Wait for all subagents to complete. Parse the JSON findings arrays from each.

### Step 3: Deduplicate

Scan for overlapping findings (same file + line range within ±5 lines + similar description):

| Overlap Type | Resolution |
|-------------|------------|
| Exact match (same file, same line, same issue) | Merge into one finding, note both categories |
| Near match (same file, ±5 lines, similar issue) | Merge if clearly the same root cause |
| Different aspects of same code | Keep as separate findings |

When merging:
- Use the **higher severity** from the overlapping findings
- Use the **higher confidence** score
- Use the **most conservative action** (ask-user → auto-fix → no-op) from the overlapping findings
- Combine descriptions from both agents
- Note all contributing categories in the finding

### Step 4: Verify

Run the standard verification pass on all deduplicated findings. See `.claude/resources/core/review-verification.md`.

### Step 5: Re-Rank and Group

Run the standard severity re-ranking. See `.claude/resources/core/review-severity-ranking.md`.

### Step 6: Generate Output

Use the deep review template with severity-grouped findings and executive summary. Add a Multi-Agent Summary section after Review Information:

```markdown
## Review Agents

| Agent | Model | Findings | After Dedup |
|-------|-------|----------|-------------|
| Security | sonnet | {N} | {N} |
| Logic & Bugs | sonnet | {N} | {N} |
| Performance | sonnet | {N} | {N} |
| Pattern Compliance | haiku | {N} | {N} |
| **Total** | | **{N}** | **{N}** |

Duplicates removed: {N}
```

---

## Insertion Points

### For review-code-skill.md

In the **Deep mode** path of Step 1b, replace the instruction "Proceed with all steps" with:

> **If Deep**: Activate multi-agent parallel review. See `.claude/resources/core/review-multi-agent.md`. Spawn 4 specialized subagents (security, logic, performance, patterns) in parallel. Coordinator collects results, deduplicates, then proceeds to Step 5b (verification), Step 5c (re-ranking), Step 6b (pattern review), and Step 6 (output using deep template).

Steps 2–5 (pattern loading, similar implementations, analysis, pattern conflicts) are handled by the subagents instead of the main agent.

### For review-pr-skill.md

In the **Deep mode** path of Step 1b, replace the instruction "Proceed with all steps" with:

> **If Deep**: Activate multi-agent parallel review. See `.claude/resources/core/review-multi-agent.md`. Spawn 4 specialized subagents (security, logic, performance, patterns) in parallel. Coordinator collects results, deduplicates, then proceeds to Step 3b (verification), Step 3c (re-ranking), and Step 4 (output using deep template with severity grouping and executive summary).

Steps 2–3 (pattern loading, analysis) are handled by the subagents instead of the main agent.

---

## Related Files

| File | Purpose |
|------|---------|
| `.claude/resources/core/review-adaptive-depth.md` | Triggers Deep mode (prerequisite) |
| `.claude/resources/core/review-verification.md` | Verification pass (run by coordinator after dedup) |
| `.claude/resources/core/review-severity-ranking.md` | Re-ranking (run by coordinator after verification) |
| `.claude/resources/skills/review-code-skill.md` | Update Deep mode path in Step 1b |
| `.claude/resources/skills/review-pr-skill.md` | Update Deep mode path in Step 1b |
| `.claude/resources/patterns/review-code-templates.md` | Deep template gets Review Agents section |
