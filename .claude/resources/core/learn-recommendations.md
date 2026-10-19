
# Learn Recommendations System

## Purpose

A cross-cutting behavior that detects learning opportunities during any plan-flow skill execution and recommends `/learn` to the user. This system ensures that when the user encounters new technologies, patterns, or resolves non-trivial errors, they're prompted to deepen their knowledge — not just fix the problem and move on.

---

## When to Recommend `/learn`

### Trigger Conditions

During execution of ANY plan-flow skill (`/execute-plan`, `/discovery-plan`, `/create-plan`, `/review-code`, `/review-pr`), watch for these triggers:

| Trigger | Example | Recommendation |
|---------|---------|----------------|
| **New library/dependency added** | Installing `langfuse`, `sentry`, `zustand` for the first time | `/learn langfuse` — general or project implementation |
| **Pattern change** | User asks to switch from Redux to Zustand, REST to GraphQL, callbacks to async/await | `/learn zustand` — understand the new pattern before adopting it |
| **New technology introduced** | Adding Docker, CI/CD, WebSockets, MCP servers to the project | `/learn docker` — project implementation approach |
| **Non-trivial error resolved** | Spent multiple attempts fixing a complex bug, configuration issue, or integration problem | `/learn` (pattern extraction) — capture the resolution as a reusable pattern |
| **User correction** | User redirected the AI's approach ("no, don't use X, use Y instead") | `/learn Y` — if Y is something the AI should understand better |
| **Architecture decision** | Choosing between approaches (monolith vs microservices, SQL vs NoSQL) | `/learn <chosen approach>` — deepen understanding of the chosen path |
| **Unfamiliar API/service** | Integrating with an external API or service for the first time | `/learn <service>` — understand the API before implementing |
| **Framework migration** | Upgrading major versions or switching frameworks | `/learn <new framework>` — understand breaking changes and new patterns |

### Detection Logic

To detect these triggers, monitor for:

1. **`npm install` / `pip install` / dependency additions** — Check if the package is new to the project (not in existing lock file)
2. **User explicitly asking to change patterns** — "Let's switch to...", "Replace X with Y", "Use Z instead"
3. **Multiple error-fix cycles** — If the same area requires 3+ attempts to fix, the topic is worth learning
4. **Brain error files** — When creating/updating `flow/brain/errors/`, check if the error category suggests a knowledge gap
5. **Tech stack changes** — Compare against `flow/references/tech-foundation.md` to detect new additions

---

## How to Recommend

When a trigger is detected, present a **brief, non-intrusive** recommendation at a natural break point (end of a phase, after an error is resolved, after a decision is made). Do NOT interrupt the current workflow.

### Recommendation Format

```markdown
**Learn opportunity detected**: You're now using **{topic}** in this project.
Would you like to run `/learn {topic}` to build a structured understanding?
(You can do this now or after we finish the current task.)
```

### Rules

| Rule | Description |
|------|-------------|
| **Non-blocking** | Never interrupt the current skill execution. Recommend at natural break points only. |
| **Once per topic** | Only recommend `/learn` for a topic ONCE per session. Track recommended topics to avoid repetition. |
| **Check existing learns** | Before recommending, check `~/plan-flow/brain/learns/_index.md` — if the topic already has a completed learn, don't recommend it again. |
| **Check brain patterns** | Before recommending, check `~/plan-flow/brain/patterns/_index.md` — if the topic is already a global pattern, recommend expanding it instead of creating a new learn. |
| **User can decline** | If the user says no or ignores the recommendation, respect it. Don't re-ask. |
| **Context-aware** | Tailor the recommendation to the situation — error → pattern extraction, new tech → teaching mode |
| **Batch recommendations** | If multiple triggers fire during one execution, batch them into a single recommendation at the end rather than interrupting multiple times. |

### Recommendation Variants

**For new tech/library (teaching mode):**
```markdown
**Learn opportunity**: You just added **Langfuse** to the project.
Run `/learn langfuse` to get a structured walkthrough (general knowledge or project-specific setup).
```

**For pattern change (teaching mode):**
```markdown
**Learn opportunity**: You're switching from **Redux** to **Zustand** for state management.
Run `/learn zustand` to understand the patterns and best practices before migrating.
```

**For error resolution (pattern extraction):**
```markdown
**Learn opportunity**: We resolved a non-trivial **{error category}** issue.
Run `/learn` (no args) to capture this as a reusable pattern for future sessions.
```

**For batched recommendations (end of execution):**
```markdown
**Learn opportunities from this session**:
- `/learn langfuse` — New dependency added, no existing learn found
- `/learn` — Non-trivial error resolution worth capturing as a pattern

Run any of these now, or come back to them later.
```

---

## Integration Points

### During `/execute-plan`

Check at the end of each phase:
- Were new dependencies added? (check `package.json` / `pyproject.toml` diffs)
- Were errors encountered and resolved? (check brain-capture `errors_hit`)
- Did the user correct the approach? (check brain-capture `user_corrections`)

Present batched recommendations at the end of execution, before the final summary.

### During `/discovery-plan`

Check when documenting technical considerations:
- Does the proposed approach introduce new technologies the team hasn't used?
- Are there unfamiliar APIs or services in the requirements?

Present recommendations in the discovery document itself as a "Suggested Learning" section.

### During `/review-code` and `/review-pr`

Check the diff for:
- New imports from unfamiliar packages
- Pattern changes (different state management, different API patterns)
- New configuration files for tools not previously used

Present recommendations at the end of the review.

### During Error Resolution (any skill)

When a non-trivial error is resolved (3+ attempts, or user had to intervene):
- Recommend `/learn` (pattern extraction) to capture the resolution
- If the error was caused by unfamiliarity with a tool/library, recommend `/learn <tool>`

---

## Discovery Document Integration

When `/discovery-plan` detects new technologies in the proposed approach, add a section to the discovery document:

```markdown
## Suggested Learning

The following topics are new to this project and may benefit from structured learning before implementation:

| Topic | Why | Suggested Command |
|-------|-----|-------------------|
| Langfuse | New observability tool not previously used | `/learn langfuse` |
| WebSocket | Real-time communication pattern new to project | `/learn websockets` |

These are optional but recommended to reduce implementation friction.
```

---

## Tracking

To avoid repeated recommendations, maintain awareness of:

1. **Session-level tracking**: Topics already recommended this session (in-memory, not persisted)
2. **Existing learns**: Check `~/plan-flow/brain/learns/_index.md` for completed curricula
3. **Existing patterns**: Check `~/plan-flow/brain/patterns/_index.md` for indexed patterns
4. **Brain errors**: Check `flow/brain/errors/` for previously resolved errors

---

## Related Files

| File | Purpose |
|------|---------|
| `.claude/commands/learn.md` | Learn command (teaching + pattern extraction) |
| `.claude/resources/skills/learn-skill.md` | Learn skill implementation |
| `.claude/commands/execute-plan.md` | Execution skill (primary integration point) |
| `.claude/commands/discovery-plan.md` | Discovery skill (detect new tech early) |
| `.claude/resources/core/brain-capture.md` | Brain capture (error and decision tracking) |
| `~/plan-flow/brain/learns/_index.md` | Existing learns index (check before recommending) |
| `~/plan-flow/brain/patterns/_index.md` | Existing patterns index (check before recommending) |
