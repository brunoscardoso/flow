
# Project Memory

## Purpose

A persistent artifact tracker that records every completed skill execution. The memory ensures plan-flow never loses knowledge across sessions by maintaining a structured log of all work done.

**Location**: `flow/memory.md`

---

## Behavior

### On Session Start

1. Check if `flow/memory.md` exists
2. If it exists: read it silently
3. Filter entries to the **last 7 days** based on the Date column
4. Internalize recent activity — know what was worked on recently without announcing it
5. Do NOT read the full memory aloud — only reference it when relevant to the current task

### After Skill Completion

When any plan-flow skill completes successfully, append a new row to the memory table in `flow/memory.md`:

1. Parse the brain-capture block for skill name, feature, artifacts, and status
2. Append a new row to the `## Memory` table
3. Keep the table sorted by date (newest first)

---

## Entry Format

The memory file uses a markdown table for parseability and compact representation:

```markdown
# Project Memory

**Project**: [[{project-name}]]
**Last Updated**: {YYYY-MM-DD}

## Memory

| Date | Skill | Feature | Artifact | Summary |
|------|-------|---------|----------|---------|
| {YYYY-MM-DD} | {skill-name} | [[{feature-name}]] | `{artifact-path}` | {1-line summary of what was done} |
```

### Field Descriptions

| Field | Description | Example |
|-------|-------------|---------|
| Date | Completion date | 2026-03-06 |
| Skill | Skill that completed | execute-plan |
| Feature | Feature wiki-link | [[contact-enrichment]] |
| Artifact | Primary output file path | `flow/plans/plan_contact_enrichment_v1.md` |
| Summary | Max 1 line describing outcome | Implemented phases 1-3 of contact enrichment |

---

## Vault Sync

The project memory is linked into the central Obsidian vault at `~/plan-flow/brain/projects/{project}/memory.md` (symlink). A **global memory** at `~/plan-flow/brain/memory.md` aggregates all projects, showing recent skill completions for a cross-project activity view.

### When Global Updates Happen

The global memory MUST be synced **every time** `flow/memory.md` is modified. This is not optional.

#### Sync Trigger

After **every** Edit or Write to `flow/memory.md`, you MUST also update the global memory at `~/plan-flow/brain/memory.md`:

1. **Read** `~/plan-flow/brain/memory.md`
2. **Count** total entries (rows matching `| YYYY-` pattern) in this project's memory
3. **Extract** the 5 most recent entries (first 5 data rows) for the preview table
4. **Update** only the current project's section with new counts and preview rows
5. **Update** the `**Last Updated**` date to today

#### Sync Rules

- **Always sync**: Every memory edit triggers a sync — no exceptions
- **Only update your project**: Do not recalculate data for other projects
- **Preview table**: Show Date, Skill, Feature, Summary (skip Artifact column for brevity)
- **Preserve format**: Keep the existing global memory format (wiki-links, table, see-link)
- **Create if missing**: If `~/plan-flow/brain/memory.md` doesn't exist, create it with the standard format

#### Example Sync

After editing `flow/memory.md` for project `parcels` with 12 total entries:

```markdown
### [[parcels]]

**Total entries**: 12

| Date | Skill | Feature | Summary |
|------|-------|---------|---------|
| 2026-03-09 | create-plan | [[saved-search-alerts]] | Created 5-phase plan for alerts |
| 2026-03-08 | discovery-plan | [[saved-search-alerts]] | Gathered requirements for alerts |

> See: [[parcels/memory.md|Full Memory]]
```

---

## Rules

1. **Append-only**: Never modify or delete existing entries
2. **One row per skill completion**: Each skill invocation gets exactly one row
3. **7-day window at session start**: Only internalize the last 7 days for context
4. **Wiki-links**: Feature names use `[[kebab-case]]` format
5. **Artifact paths**: Use backtick-wrapped relative paths from project root
6. **Summary brevity**: Max 1 line, focus on outcome not process
7. **Auto-create**: If `flow/memory.md` doesn't exist when needed, create it using the template above
8. **Vault sync**: Every memory update MUST also update `~/plan-flow/brain/memory.md` — see Vault Sync section
