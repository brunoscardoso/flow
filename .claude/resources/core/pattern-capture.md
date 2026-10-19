
# Pattern Capture System

## Purpose

Silent, automatic capture of coding patterns and anti-patterns during skill execution. Patterns are buffered during work and presented for user approval at the end of the skill. Approved patterns are written to `.claude/rules/core/allowed-patterns.md` or `.claude/rules/core/forbidden-patterns.md`.

**Buffer Location**: `flow/resources/pending-patterns.md`
**Target Files**: `.claude/rules/core/allowed-patterns.md` (allowed) | `.claude/rules/core/forbidden-patterns.md` (forbidden)

---

## Behavior

### During Skill Execution (Silent Capture)

While executing `/execute-plan`, `/discovery-plan`, or `/review-code`, watch for patterns that meet the capture triggers below. When you identify a pattern worth capturing:

1. **Do NOT interrupt the user** — continue the current work
2. **Append the pattern** to `flow/resources/pending-patterns.md` using the buffer format below
3. **Skip trivially obvious patterns** (e.g., "use semicolons") and patterns already documented in the target files

### Capture Triggers

| Trigger | Category | Example |
|---------|----------|---------|
| Recurring convention across 3+ files | allowed | All API routes use `withAuth()` wrapper |
| Anti-pattern found during code review | forbidden | Nested callbacks in async code |
| Workaround applied during execution | forbidden | Manual type assertion to fix broken generic |
| User correction of approach | allowed/forbidden | "Don't use `any` here, use the generic" |
| Pattern conflict between new and existing code | either | New code uses barrel exports, existing doesn't |
| Convention discovered in existing codebase | allowed | All hooks follow `useXxx` naming with return tuple |

### What NOT to Capture

- Patterns already in `allowed-patterns.md` or `forbidden-patterns.md`
- Generic language/framework best practices (these belong in `/setup` pattern files)
- One-off decisions that won't recur
- Patterns with no clear code example

---

## Buffer Format

File: `flow/resources/pending-patterns.md`

```markdown
# Pending Patterns

Patterns captured during skill execution. Review at end of skill.

---

## Entry: {pattern-name}

- **Category**: allowed | forbidden
- **Confidence**: high | medium | low
- **Source**: {skill-name} {phase or step}
- **Description**: {one-line description}

### Code Example

\`\`\`{language}
// {GOOD or BAD} - {brief explanation}
{code example}
\`\`\`

### Rationale

{Why this pattern matters for this project}

---
```

Each entry is separated by `---`. Multiple entries accumulate during execution.

---

## End-of-Skill Review Protocol

After a skill completes its primary work (but before brain-capture), run the pattern review:

### Step 1: Check Buffer

Read `flow/resources/pending-patterns.md`. If empty or doesn't exist, skip the review entirely.

### Step 2: Group and Present

Group entries by category (allowed / forbidden) and present a numbered list:

```markdown
## Pattern Review

The following patterns were identified during execution:

### Allowed Patterns (to add to allowed-patterns.md)

1. **{pattern-name}** — {description} (Confidence: {level})
2. **{pattern-name}** — {description} (Confidence: {level})

### Forbidden Patterns (to add to forbidden-patterns.md)

3. **{pattern-name}** — {description} (Confidence: {level})

**Options**: Enter numbers to approve (e.g., "1,3"), "all" to approve all, or "none" to skip.
```

### Step 3: Process User Selection

- **"all"**: Write all patterns to their target files
- **"none"**: Clear the buffer and continue
- **Numbers (e.g., "1,3")**: Write only selected patterns
- **Skip/ignore**: Treat as "none"

### Step 4: Write Approved Patterns

For each approved pattern:

1. **Run conflict detection** (see below)
2. **Append** to the `## Project Patterns` or `## Project Anti-Patterns` section of the target file
3. **Use the auto-captured entry format** (see below)

### Step 5: Clear Buffer

After review (regardless of outcome), clear `flow/resources/pending-patterns.md` by writing an empty file with just the header:

```markdown
# Pending Patterns

Patterns captured during skill execution. Review at end of skill.
```

---

## Auto-Captured Entry Format

Patterns written to the target files use the same structure as existing patterns, plus a metadata footer:

### For `allowed-patterns.md`

```markdown
### {Pattern Name}

{Description of what this pattern accomplishes.}

\`\`\`{language}
// GOOD - {brief explanation}
{code example}
\`\`\`

**Why**: {Explanation of benefits.}

_Auto-captured on {YYYY-MM-DD} from {source skill/phase}. Confidence: {level}._
```

### For `forbidden-patterns.md`

```markdown
### DON'T: {Pattern Name}

**Problem**: {Brief description of why this is problematic.}

\`\`\`{language}
// BAD - {brief explanation}
{code example}
\`\`\`

**Why This is Wrong**:

- {Reason 1}
- {Reason 2}

**Fix**: {Description of the correct approach.}

_Auto-captured on {YYYY-MM-DD} from {source skill/phase}. Confidence: {level}._
```

---

## Conflict Detection

Before writing an approved pattern, scan the target file for contradictions:

### Detection Rules

1. **Name match**: Pattern with the same or very similar name already exists
2. **Semantic contradiction**: New pattern says "do X", existing pattern says "don't do X" (or vice versa)
3. **Overlapping scope**: Both patterns address the same code construct but recommend different approaches

### When Conflict Found

Present the conflict to the user:

```markdown
**Conflict detected** with existing pattern "{existing pattern name}":

- **Existing**: {summary of existing pattern}
- **New**: {summary of new pattern}

**Options**:
1. **Add + Deprecate old** — Add new pattern and deprecate the existing one
2. **Skip** — Don't add the new pattern
3. **Add both** — Keep both patterns (they may apply in different contexts)
```

### Deprecation Format

When deprecating a pattern, modify the existing entry's heading:

```markdown
### ~~Pattern Name~~ (DEPRECATED: {YYYY-MM-DD} — Superseded by "{new pattern name}")
```

The heading gets strikethrough. The body stays intact for historical reference. Do NOT delete deprecated patterns.

---

## Rules

1. **Silent during execution**: Never interrupt work to discuss a captured pattern
2. **Buffer is a file**: Always write to `flow/resources/pending-patterns.md` — never keep patterns only in conversation memory
3. **User gate required**: Every pattern needs explicit user approval before being written to rule files
4. **Check before capture**: Read target files before adding to buffer — skip already-documented patterns
5. **One review per skill**: Present the review once at the end, not after each phase
6. **Never delete rule entries**: Deprecated patterns stay with strikethrough for history
7. **Metadata footer required**: Every auto-captured entry must include the `_Auto-captured on...` line
8. **Clean buffer after review**: Always clear pending-patterns.md after the review step
