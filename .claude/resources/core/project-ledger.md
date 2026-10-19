# Project Ledger

## Purpose

A persistent, project-specific learning journal maintained across sessions. The ledger captures mistakes, corrections, discovered patterns, and hard-won knowledge about a specific codebase - building institutional memory that compounds over time.

**Location**: `flow/ledger.md`

---

## Behavior

### On Session Start

1. Check if `flow/ledger.md` exists
2. If it exists, read it and internalize the learnings silently
3. If it doesn't exist and the `flow/` directory exists, create it using the template below
4. Apply all recorded learnings naturally - never announce "I read the ledger" or reference it unless asked

### During Work

Record entries as soon as you learn something worth remembering. Don't batch updates for the end of a session - write them while the context is fresh.

**Update the ledger when you:**

- Get corrected by the user on something project-specific
- Discover an undocumented project quirk or constraint
- Find that an approach doesn't work in this codebase (and why)
- Learn a user preference for how they like things done
- Successfully navigate a tricky problem unique to this project
- Notice a gap between documented patterns and actual codebase behavior
- Encounter environment-specific gotchas (build issues, tool configs, etc.)
- Learn domain-specific terminology or business rules

### What NOT to Record

- Generic programming knowledge (that's what rules files are for)
- Patterns already documented in `.claude/rules/` files
- Temporary issues that won't recur
- Information that belongs in a discovery document or plan

---

## Entry Format

Each entry should be concise and actionable. Write entries as lessons, not as narratives.

**Good entries:**
- "The `buildWidgets` script requires Node 18+ - fails silently on Node 16"
- "User prefers explicit error types over generic Error class"
- "API responses from /legacy/* endpoints use snake_case despite the rest being camelCase"
- "Tests for streaming endpoints need a 3s timeout override - default 5s causes CI flakiness"

**Bad entries:**
- "Had a good session today" (not actionable)
- "JavaScript uses === for strict equality" (generic knowledge)
- "Fixed a bug in user service" (too vague, no lesson)

---

## Ledger Sections

### Project Quirks

Things that are unique or surprising about this specific project. Build config gotchas, undocumented dependencies between modules, services that behave differently than expected.

### What Works

Approaches and solutions that proved effective in this project. Patterns that solved recurring problems. Techniques the user approved of.

### What Didn't Work

Approaches that were tried and failed, with brief explanation of why. This prevents repeating the same mistakes across sessions.

### User Preferences

How the user likes things done. Communication style, code style preferences beyond what's in rules files, workflow preferences, conventions they care about.

### Domain Context

Business logic, domain terminology, and project-specific concepts that affect technical decisions. Things that aren't obvious from reading the code alone.

---

## Template

When creating `flow/ledger.md` for the first time, use this structure:

```markdown
# Project Ledger

> Persistent learning journal - updated automatically across sessions.
> Last updated: {date}

## Project Quirks

<!-- Unexpected behaviors, environment gotchas, undocumented constraints -->

## What Works

<!-- Proven approaches and solutions for this project -->

## What Didn't Work

<!-- Failed approaches with brief "why" so we don't repeat them -->

## User Preferences

<!-- How the user likes things done beyond what rules files capture -->

## Domain Context

<!-- Business logic, terminology, and concepts that affect decisions -->
```

---

## Maintenance Rules

1. **Keep it under 150 lines** of high-signal content
2. **Consolidate periodically**: After every 8-10 sessions, merge similar entries, remove outdated ones, and promote recurring corrections to standing guidelines
3. **Remove stale entries**: If a quirk gets fixed or a constraint is lifted, remove the entry
4. **Promote to rules**: If a preference or pattern becomes well-established, move it to the appropriate rules file and remove from the ledger
5. **No duplicates**: Before adding an entry, scan existing entries to avoid redundancy

---

## Integration with Plan-Flow Workflow

The ledger naturally captures learnings from plan-flow activities:

| Activity | What Gets Captured |
|----------|-------------------|
| `/setup` | Environment surprises, toolchain quirks |
| `/discovery-plan` | Domain context, business rules learned from user |
| `/execute-plan` | What worked/didn't during implementation |
| `/review-code` | Pattern conflicts discovered, user feedback on style |
| `/review-pr` | Recurring review issues, team conventions |

The ledger is **not** a replacement for plan-flow artifacts. Discovery documents, plans, and reviews remain in their respective folders. The ledger captures the meta-learnings that span across activities.

---

## Vault Sync

The project ledger is linked into the central Obsidian vault at `~/plan-flow/brain/projects/{project}/ledger.md` (symlink). A **global ledger** at `~/plan-flow/brain/ledger.md` aggregates all projects, showing learnings per section for a cross-project knowledge view.

### When Global Updates Happen

The global ledger MUST be synced **every time** `flow/ledger.md` is modified. This is not optional.

#### Sync Trigger

After **every** Edit or Write to `flow/ledger.md`, you MUST also update the global ledger at `~/plan-flow/brain/ledger.md`:

1. **Read** `~/plan-flow/brain/ledger.md`
2. **Count** entries per section (bullet lines starting with `-` under each `## ` heading)
3. **Update** only the current project's section with new counts
4. **Update** the `**Last Updated**` date to today

#### Sync Rules

- **Always sync**: Every ledger edit triggers a sync — no exceptions
- **Only update your project**: Do not recalculate data for other projects
- **Section counts**: Show each non-empty section with its entry count
- **Preserve format**: Keep the existing global ledger format (wiki-links, table, see-link)
- **Create if missing**: If `~/plan-flow/brain/ledger.md` doesn't exist, create it with the standard format

#### Example Sync

After editing `flow/ledger.md` for project `parcels` with entries in 3 sections:

```markdown
### [[parcels]]

| Section | Entries |
|---------|---------|
| Project Quirks | 4 |
| What Works | 3 |
| User Preferences | 2 |

> See: [[parcels/ledger.md|Full Ledger]]
```

---

## Rules

1. **Silent by default**: Never tell the user "I updated the ledger" unless they ask about it
2. **Immediate writes**: Record learnings as they happen, don't wait
3. **Lessons over logs**: Write what you learned, not what you did
4. **Project-specific only**: Only record things unique to this project
5. **Honest self-correction**: Record your own mistakes, not just user corrections
6. **Vault sync**: Every ledger update MUST also update `~/plan-flow/brain/ledger.md` — see Vault Sync section
