
# STATE.md Format

## Purpose

`flow/STATE.md` is the handoff between one run and the next — a `/discovery-plan` that finishes, an `/execute-plan` that resumes, a headless loop run asking what is in flight. **The writer is a language model** (the skills in `.claude/commands/`) and **the reader is a strict regex** (`src/cli/state/state-md-parser.ts`). Nothing arbitrates between them at runtime: `parseStateMd` never throws, never warns, and returns `null` fields for everything it did not recognize. A file that drifts one character from the grammar below parses to an empty state, and every consumer downstream reports "nothing in flight" — confidently, and wrongly.

**Core principle**: This document is the grammar, derived from the reader. Write what is here, exactly as it is here. When the grammar and the parser disagree, the parser wins and this file is the bug.

The binding is mechanical, not conventional (allowed-pattern #14): `src/cli/state/state-md-parser.test.ts` extracts every STATE.md example shipped in `.claude/commands/**` and in this file, feeds each one to `parseStateMd`, and fails if `active_skill` or `active_plan` comes back empty. An example that drifts breaks the build.

---

## Canonical Example

This block is the reference. Everything the parser reads is in it.

```markdown
# Session State

**Updated**: 2026-08-14T09:12:00.000Z

## Execution State
- **Active Skill**: execute-plan
- **Active Plan**: flow/plans/plan_user_auth_v1.md
- **Current Phase**: 3 — API Integration
- **Current Task**: Create the API route handler
- **Completed Phases**:
  - Phase 1: Types and Schemas — done
  - Phase 2: Backend Setup — done with warnings

## Decisions
- Chose JWT over sessions (reason: discovery DR-4 specified stateless auth)
- Used Zod for validation (reason: consistent with the existing codebase pattern)

## Blockers
- Missing @auth/core dependency (status: resolved, tried: installed via npm)

## Files Modified
- src/types/auth.ts
- src/api/routes.ts

## Next Action
Continue with Phase 3, Task 2: add rate limiting to the API routes
```

---

## The Grammar

### Frame

| Line | Rule |
|------|------|
| `# Session State` | H1 title. Ignored by the parser, expected by humans — keep it. |
| `**Updated**: <timestamp>` | Bold literal `Updated`, colon, then the value verbatim (ISO-8601 by convention). Must be the whole line. Recognized anywhere in the file; write it once, directly under the H1. |
| `## <Section>` | Section heading — **exactly two `#`**. An H3 (`### …`) does not open a known section and silently ends the one above it. |

Section names are exact and case-sensitive: `Execution State`, `Decisions`, `Blockers`, `Files Modified`, `Next Action`. Any other heading closes the previous section and contributes nothing. Sections may be omitted; their fields then read as empty.

### `## Execution State`

Every field is one bullet of the form `- **<Key>**: <value>` — a hyphen, one space, the key wrapped in `**`, a colon, the value. An asterisk bullet (`* **Key**: …`), a missing `- `, or an unbolded key matches nothing and the field is dropped.

| Key | Value grammar | Parsed as |
|-----|---------------|-----------|
| `Active Skill` | The command name, bare: `execute-plan`, `discovery-plan`, `create-plan`, `review-code`, `review-pr` | String, verbatim |
| `Active Plan` | The plan path or plan name, bare: `flow/plans/plan_user_auth_v1.md` | String, verbatim |
| `Current Phase` | `<number> — <name>`, separated by an **em dash** (`—`, U+2014) | `{ number, name }` |
| `Current Task` | Free prose, one line | String, verbatim |
| `Completed Phases` | Empty value, followed by the sub-list below | List |

Sub-list under `Completed Phases` — indented **two spaces or more**, each line its own bullet:

```markdown
- **Completed Phases**:
  - Phase 1: Types and Schemas — done
  - Phase 2: Backend Setup — done with warnings
```

Each entry is `Phase <number>: <name> — <outcome>`, again with an em dash before the outcome.

Three ways this section goes silently wrong:

1. **A hyphen where an em dash belongs.** `Current Phase: 3 - API Integration` parses to `null`, not to phase 3. Same for a completed-phase outcome.
2. **`Completed Phases` is not last.** Any `- **Key**: value` bullet written *after* the sub-list is consumed as part of it and dropped. `Completed Phases` is always the final field of the section.
3. **Decoration in the value.** Backticks, bold, or quotes are kept verbatim and become part of the string, so `` - **Active Plan**: `flow/plans/plan_x_v1.md` `` yields a plan name no lookup will match. Write values bare.

### `## Decisions`

One bullet per decision: `- <text>` , with an optional `(reason: <why>)`.

```markdown
- Chose JWT over sessions (reason: discovery DR-4 specified stateless auth)
- Kept the parser fail-soft (reason: raising strands in-flight work (see NFR-1); deferred)
```

The reason's closing paren is the one that **balances** the opener, so a reason may itself contain parentheses. Prose after the parenthetical stays on the decision. A bullet with no `(reason:` is recorded whole, with an empty reason.

A bullet may wrap: continuation lines are indented and carry **no** `- ` of their own, and are joined back onto the bullet before parsing.

```markdown
- Rename was identifier-targeted, not a substring pass (reason: `heartbeat`
  contains `beat` 238 times; a blind replace produces `hearrun`)
```

### `## Blockers`

One bullet per blocker: `- <issue> (status: <status>, tried: <what was tried>)`. The parenthetical must close the bullet — nothing after it. A bullet without it is still recorded, with `status: unknown` and an empty `tried`. Wrapping works exactly as it does for decisions.

### `## Files Modified`

One bare repo-relative path per bullet: `- src/types/auth.ts`. No backticks, no annotations — the bullet text is taken as the path.

### `## Next Action`

The **first non-empty line** of the section, as plain prose. Not a bullet: a leading `- ` is kept verbatim and ends up inside the value. One line; anything after the first is ignored.

---

## Placeholders and Absence

A field with nothing to say is written as `none` — the parser stores the literal string, it does not translate it to absence:

```markdown
- **Active Skill**: discovery-plan
- **Active Plan**: none
```

Consumers treat `none`, `null`, `n/a` and `-` (case-insensitive) as "no plan named" (`normalizePlanName` in `src/cli/loop/pipeline-state.ts`). Omitting the bullet entirely also works — the field reads as `null`. Prefer the explicit `none`: it says a skill considered the field, rather than leaving a reader to guess whether the writer forgot.

Write the real value whenever one exists. `Active Plan: none` on a run that *has* a plan is how a live pipeline becomes invisible to the next run (#1599).

---

## Rules

1. **The parser is the spec** — this document describes what `src/cli/state/state-md-parser.ts` accepts. Change the parser and this file changes with it, in the same commit.
2. **Em dash, never hyphen** — `Current Phase` and completed-phase outcomes are separated by `—` (U+2014).
3. **Hyphen bullet, bold key, colon** — `- ` then the key wrapped in `**`. No other bullet marker parses.
4. **H2 for sections** — exactly `## `, with the exact section name.
5. **`Completed Phases` last** — fields after its sub-list are swallowed.
6. **Bare values** — no backticks, bold or quotes around a value; they survive into the parsed string.
7. **`none`, not blank** — an empty field is written `none`, and a field with a real value never says `none`.
8. **Never delete the file to signal completion** — a finished skill writes what finished; the next stage reads it. Deleting it destroys the handoff.
9. **Examples are tested** — any STATE.md example added to a skill doc must parse; the guard test in `state-md-parser.test.ts` extracts and checks it.

---

## Related Files

| File | Purpose |
|------|---------|
| `src/cli/state/state-md-parser.ts` | The reader — the authority for this grammar |
| `src/cli/state/state-md-parser.test.ts` | The guard binding every shipped example to the reader |
| `src/cli/loop/pipeline-state.ts` | Derives the loop's pipeline stage from `Active Skill` / `Active Plan` |
| `.claude/commands/resume-work.md` | Reads STATE.md to reconstruct session context |
| `.claude/resources/core/session-scratchpad.md` | The informal counterpart — notes, not execution position |
