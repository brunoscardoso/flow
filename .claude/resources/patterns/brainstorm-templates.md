
## Brainstorm Document Template

Use this template when generating brainstorm output files:

```markdown
# Brainstorm: {Topic Name}

**Date**: {YYYY-MM-DD}
**Participants**: User + AI
**Status**: {crystallized | exploratory | early-stage}

---

## Core Idea

{The central thesis as it evolved during the conversation. This should be
a clear, concise description of what the idea IS — not how to build it.}

---

## Key Decisions

Forks that were discussed and resolved during the brainstorm.

| # | Decision | Reasoning |
|---|----------|-----------|
| 1 | {What was decided} | {Why this choice was made} |
| 2 | {What was decided} | {Why this choice was made} |

---

## Open Questions

Things raised during the brainstorm that remain unresolved.

- {Question 1}
- {Question 2}

---

## Constraints Discovered

Limitations that surfaced during the conversation.

- {Constraint 1 — where it came from}
- {Constraint 2 — where it came from}

---

## Inspirations & References

Existing tools, patterns, code, or external ideas that came up.

- {Reference 1} — {how it relates to the idea}
- {Reference 2} — {how it relates to the idea}

---

## Rejected Alternatives

Things considered and explicitly discarded, with reasoning preserved.

| Alternative | Why Rejected |
|-------------|-------------|
| {Option A} | {Reasoning for rejection} |
| {Option B} | {Reasoning for rejection} |

---

## For Discovery

This section bridges the brainstorm into the discovery phase. Feed this file
to `/discovery-plan` to ground the idea in the project's codebase.

### Resolved During Brainstorm

These decisions are settled. Discovery should NOT re-ask them.

- {Decision 1}
- {Decision 2}

### Still Open (Discovery Should Investigate)

These questions need codebase analysis and technical grounding.

- {Question 1 — what discovery should look for}
- {Question 2 — what discovery should look for}

### Rejected (Do Not Revisit)

These were explicitly considered and rejected. Discovery should not re-propose them.

- {Rejected alternative 1}
- {Rejected alternative 2}
```

---

## Status Definitions

| Status | Meaning |
|--------|---------|
| `crystallized` | Idea is clear and well-defined — ready for discovery |
| `exploratory` | Idea has shape but still has open questions |
| `early-stage` | Initial exploration — needs more brainstorming or research |

---

## File Naming

- **Format**: `brainstorm_{kebab-case-topic}_v{version}.md`
- **Location**: `flow/brainstorms/`
- **Examples**:
  - `brainstorm_plugin-system_v1.md`
  - `brainstorm_real-time-notifications_v1.md`
  - `brainstorm_error-recovery-strategy_v2.md`

---

## Usage with Discovery

The brainstorm file is designed to be fed directly into `/discovery-plan`:

```bash
/discovery-plan @flow/brainstorms/brainstorm_plugin-system_v1.md
```

Discovery will:
1. Read the brainstorm and inherit resolved decisions
2. Use "Still Open" questions as starting points for codebase investigation
3. Respect "Rejected" alternatives and not re-propose them
