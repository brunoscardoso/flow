
# Compaction Guide

## COR-CG-1: Purpose

When a plan-flow session runs `/compact`, the compaction model summarizes the conversation history. Without guidance, it may discard critical state (phase progress, decisions) or keep low-value tokens (old file reads, resolved searches).

**Core principle**: Preserve decisions, discard outputs.

### When to Compact

- At **phase boundaries** during `/execute-plan` (between phases, never mid-phase)
- When context feels heavy (many tool calls, large file reads accumulated)
- Before starting a complex phase (complexity >= 6)
- During long `/review-code` or `/discovery-plan` sessions with many file reads

---

## COR-CG-2: Preserve Rules (High-Signal Tokens)

Always include these in the compact summary:

| Category | What to Keep | Examples |
|----------|-------------|----------|
| **Execution state** | Current skill, phase number, plan slug, completed vs pending phases | "Executing plan_user_auth_v1.md, phase 3 of 5 complete" |
| **Decision log** | Architecture choices, pattern selections, user preferences, rejected alternatives | "Chose JWT over sessions (discovery DR-4). User rejected Redis caching." |
| **Error context** | Unresolved errors, failed attempts, workarounds in progress, retry count | "Build fails on type mismatch in auth.ts:42 — tried 2 approaches" |
| **User requirements** | Original request, clarified constraints, acceptance criteria | "User wants OAuth2 with Google only, no email/password" |
| **Tasklist state** | Current in-progress items from `flow/tasklist.md` | "In progress: Execute user-auth" |
| **Pattern buffer** | Pending pattern captures not yet saved | "Buffered: async error handling pattern for approval" |
| **Active file list** | Files created or modified during the session | "Modified: src/auth/middleware.ts, src/auth/types.ts" |
| **Scratchpad notes** | Contents of `flow/.scratchpad.md` — ephemeral session notes not yet promoted | "Scratchpad: 3 notes, 1 open question" |

---

## COR-CG-3: Discard Rules (Low-Signal Tokens)

Safe to drop from the compact summary:

| Category | What to Drop | Why |
|----------|-------------|-----|
| **Completed tool results** | File reads from resolved steps, grep results already acted on | Can be re-read if needed |
| **Superseded content** | Earlier versions of files that were subsequently edited | Only the final state matters |
| **Verbose output** | Full build logs, test output — keep only pass/fail + error messages | Details can be regenerated |
| **Exploration dead-ends** | Files read but found irrelevant, abandoned approaches | No future value |
| **Redundant context** | Content repeated across multiple tool calls | One copy is enough |
| **Index file contents** | `_index.md` files read for navigation | Re-read on demand |

---

## COR-CG-4: Compact Summary Template

When crafting `/compact` instructions, use this structure:

```
## Session State
- **Active skill**: {skill name — e.g., execute-plan, review-code, discovery}
- **Active plan**: {plan file path or "none"}
- **Current phase**: {N of M} — {phase name}
- **Completed phases**: {list with brief outcomes}

## Decisions Made
- {decision}: {choice} (reason: {why})

## Unresolved Issues
- {error/issue}: {status, what was tried}

## Files Modified
- {file path}: {what changed}

## Next Action
{What to do immediately after compaction}
```

---

## Skill-Specific Examples

### Execute-Plan Compaction

```
/compact Executing plan_user_auth_v1.md. Completed: Phase 1 (types — done),
Phase 2 (API endpoints — done). Next: Phase 3 of 5 (Frontend UI, complexity 6).
Decisions: JWT auth (not sessions), Zod validation. Files modified:
src/auth/types.ts, src/api/auth.ts. Resume from Phase 3.
```

### Review-Code Compaction

```
/compact Reviewing 47 changed files. Completed: file categorization, security scan
(2 findings), logic analysis (3 findings). Next: performance scan. Findings so far:
1 critical (SQL injection in query.ts), 4 minor. Resume with performance analysis.
```

### Discovery Compaction

```
/compact Discovery for payment-integration. Questions answered: 5 of 8.
Key requirements: Stripe only, webhook verification required, idempotency keys.
Open questions: retry policy, refund flow. Resume with remaining questions.
```

---

## STATE.md Integration

Before compaction, write current execution state to `flow/STATE.md` using the standard state format (skill, phase, status, decisions, errors). This ensures that even if the compaction summary loses detail, the full execution position is recoverable from the file.

After compaction, re-read `flow/STATE.md` to restore execution context. This supplements the compaction summary with structured state that the summary format may not fully capture (phase numbers, file lists, decision references).

**Workflow**:
1. Before `/compact`: Update `flow/STATE.md` with current state (or create it if it doesn't exist)
2. Run `/compact` with the summary
3. After compaction: Re-read `flow/STATE.md` and the active plan file to restore full context

---

## Rules

1. **Never compact mid-phase** — only at phase boundaries
2. **Always include enough context to resume** — the model after compaction should know exactly what to do next
3. **After compaction, re-read the plan file** — don't rely on memory of plan contents
4. **After compaction, re-read STATE.md** — restore structured execution state that the summary may not fully capture
5. **Default to preserving** — when in doubt, keep it. It's better to preserve something unnecessary than lose something critical.
