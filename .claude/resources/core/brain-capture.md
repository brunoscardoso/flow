
# Brain Capture System

## Purpose

Automatic knowledge capture that builds a secondary brain during plan-flow skill execution. The brain captures prompts, errors, decisions, and file changes into Obsidian-compatible markdown files with `[[wiki-links]]`.

**Location**: `flow/brain/`
**Global Brain**: `~/plan-flow/brain/`

---

## Behavior

### On Session Start

1. Check if `flow/brain/index.md` exists
2. If it exists: read it silently and internalize the content
3. Apply awareness of active features and recent errors naturally during work
4. Do NOT announce that you read the brain index
5. When a user request relates to an indexed entry, read the specific brain file for targeted context (e.g., `flow/brain/features/{feature}.md`)
6. Find knowledge with `planflow-ai brain search "<question>"`, and expand a catalogued section with `planflow-ai brain ref <code>` — see `brain-first.md`

> **GLB-\* and LRN-\* reference codes are RETIRED, and so is `/pattern-validate`.**
>
> Until `0135380f` this file described an eligibility gate: a pattern or learn
> without reference codes in an `_index.md` "MUST NOT be loaded", and
> `/pattern-validate` was how you indexed one. That command does not exist —
> there is no `.claude/commands/pattern-validate.md` — and the `_index.md` files
> it maintained are actively DELETED by the v2→v3 migration in
> `src/cli/handlers/claude.ts`. Nothing reads a GLB-\* or LRN-\* code anywhere
> in the codebase.
>
> The gate therefore said "you may not load this until you run X", where X was
> gone: an unopenable door in front of a file that was always readable. Removed
> rather than repaired, because the corpus search replaced the mechanism
> wholesale.
>
> **One thing the removal did not replace**: the central vault
> (`~/plan-flow/brain/patterns/` and `/learns/`) is outside every corpus root
> in `brain-file-search.ts`, so no search scope reaches it. The reference-code
> index was that tier's only retrieval path. Cross-project knowledge has to be
> copied into a project to be findable, until that is decided properly.

### After Any Plan-Flow Skill Completes

When any plan-flow skill (`/setup`, `/discovery-plan`, `/create-plan`, `/execute-plan`, `/review-code`, `/review-pr`, `/write-tests`, `/create-contract`) completes and outputs a `<!-- brain-capture -->` comment block:

1. **Parse** the brain-capture block
2. **Write** to the appropriate brain files
3. **Rebuild** `flow/brain/index.md` with `planflow-ai brain index` — the index is GENERATED from the notes; never edit it by hand
4. **Append** a memory entry to `flow/memory.md` (see `.claude/resources/core/project-memory.md`)
5. **Sync** relevant patterns to `~/plan-flow/brain/` (central vault)

---

## Brain-Capture Block Format

Skills output this block at the end of their execution:

```html
<!-- brain-capture
skill: <skill-name>
feature: <feature-name>
phase: <phase-number-or-na>
status: <completed|in-progress|failed|discarded>
errors: ["<error description - resolution>"]
decisions: ["<choice made - reasoning>"]
files_changed: ["<file-path>"]
user_prompts: ["<what the user asked>"]
artifacts: ["<flow/discovery/discovery_x.md>"]
-->
```

---

## Processing Rules

### 1. Feature Files (`flow/brain/features/{feature-name}.md`)

**When**: Every brain-capture block creates or updates a feature file.

**File naming**: kebab-case matching the feature name. Example: `contact-enrichment.md`

**If file exists**: Append to the Timeline section. Update Status if changed.

> **`capture: brain` is mandatory.** `flow/brain/features/` is shared with two
> other populations — the features themselves, and the auto-captured working
> sets. A file here is read as a **capability on the Blueprint board** unless it
> says otherwise, and this template's own output was drawn as one on a real
> project: a note about a ticket became a province next to Chats and Playbooks.
> The key is how the store tells a note from a feature, and it is checked for
> what the file HAS — a note without it is indistinguishable from a capability
> somebody wrote by hand, and the store will (correctly) admit it.

**Template**:

```markdown
---
capture: brain
status: {active|completed|discarded}
created: {YYYY-MM-DD}
---

# [[{feature-name}]]

**Project**: [[{project-name}]]
**Status**: {active|completed|discarded}
**Created**: {YYYY-MM-DD}
**Last Updated**: {YYYY-MM-DD}

## Links

- Discovery: [[{discovery_doc_name}]]
- Plan: [[{plan_doc_name}]]
- Reviews: [[{review_doc_name}]]

## Timeline

### {YYYY-MM-DD} - {skill-name}
- **Prompt**: {user prompt}
- **Outcome**: {what happened}
- **Errors**: {any errors and resolutions}
- **Decisions**: {any decisions made}
- **Files Changed**: {list of files}

## Errors Encountered

- [[{error-name}]] - {brief description}

## Decisions Made

- [[{decision-name}]] - {brief description}
```

### 2. Error Files (`flow/brain/errors/{error-name}.md`)

**When**: Brain-capture block contains non-empty `errors` array.

**File naming**: kebab-case descriptive name. Example: `prisma-connection-pooling.md`

**If file exists**: Append new occurrence to the Occurrences section.

**Template**:

```markdown
---
category: {build|runtime|test|config}
first_seen: {YYYY-MM-DD}
---

# [[{error-name}]]

**Project**: [[{project-name}]]
**Category**: {build|runtime|test|config}
**First Seen**: {YYYY-MM-DD}
**Last Seen**: {YYYY-MM-DD}
**Resolution**: {how it was fixed}

## Description

{What the error is and why it happens}

## Fix

{Step-by-step resolution}

## Occurrences

- {YYYY-MM-DD} in [[{feature-name}]] during {skill-name} phase {phase}
- {YYYY-MM-DD} in [[{feature-name-2}]] during {skill-name} phase {phase}

## Related

- Features: [[{feature-name}]]
```

### 3. Daily Session Files (`~/plan-flow/brain/notes/{YYYY-MM-DD}.md`)

**When**: Every brain-capture block appends to the notes file.

**Location**: `~/plan-flow/brain/notes/` (global, not per-project). One file per day across all projects.

**If file exists**: Append new entry to the project's section within the notes file.

**Template**:

```markdown
---
date: {YYYY-MM-DD}
---

# Daily: {YYYY-MM-DD}

## [[{project-name}]]

### {HH:MM} - {skill-name}
- **Feature**: [[{feature-name}]]
- **Status**: {status}
- **Files Changed**: {count}
- **Errors**: {count}
- **Decisions**: {count}

## [[{other-project-name}]]

### {HH:MM} - {skill-name}
- **Feature**: [[{feature-name}]]
- **Status**: {status}
```

**Rules**:
- Group entries by project using `## [[project-name]]` headings
- If the project heading already exists in the file, append under it
- If it doesn't exist, add a new `## [[project-name]]` section

---

## Index Management

### Index File (`flow/brain/index.md`)

The index is the L1 cache - always loaded at session start. It MUST stay under 30 lines.

**It is generated, never edited in place.** `planflow-ai brain index` rebuilds it from the notes in `flow/brain/features/`, `errors/` and `decisions/` (their frontmatter `status:` / `description:`, and which plans or discoveries are live or archived). Two machines editing the same lines of one file is a guaranteed conflict, so in a Workspace the index is rebuilt on each machine and never synced. To change what it says, change the notes and rebuild. A section another tool keeps in the index (e.g. `## Global Patterns`) is carried over unchanged.

**What the generator writes** (for reference — never write it yourself):

```markdown
# Brain Index

**Last Updated**: {YYYY-MM-DD}

> Generated from the brain notes on this machine — edit the notes, not this file.

## Active Features
- {feature-slug} [{status}] - {description, or the note's summary}
- ~~{feature-slug}~~ [{completed|archived|…}] - {summary}

## Capabilities
- [[{feature-slug}]], [[{feature-slug}]]

## Recent Errors (max 5)
- [[{error-name}]] - {summary}

## Recent Decisions (max 3)
- [[{decision-name}]] - {description}
```

### Cap Enforcement

The generator applies these caps (a feature completes when its note's `status:` says so, or its plan/discovery moves to `flow/archive/`):

| Section | Max Entries | Rule |
|---------|-------------|------|
| Active Features | All active; at most 10 non-active (struck through) | Newest first by frontmatter `updated`/`date`/`created`, else file time |
| Capabilities | 20 named, then "and N more" | Notes with no status and no live or archived plan/discovery |
| Recent Errors | 5 | Newest first; full detail stays in `errors/` |
| Recent Decisions | 3 | Newest first; full detail stays in `decisions/` |

### Naming Conventions

All brain files use **kebab-case** names that match their `[[wiki-link]]` reference:

- Feature: `flow/brain/features/contact-enrichment.md` → `[[contact-enrichment]]`
- Error: `flow/brain/errors/prisma-connection-pooling.md` → `[[prisma-connection-pooling]]`
- Daily: `~/plan-flow/brain/notes/2026-03-03.md` → `[[2026-03-03]]`

---

## Global Brain Sync

After processing a brain-capture block, sync relevant entries to the global brain:

### Location

`~/plan-flow/brain/`

### What Gets Synced

| Content | Synced? | Why |
|---------|---------|-----|
| Framework patterns | Yes | Generic, reusable across projects with same framework |
| Language patterns | Yes | Generic, reusable across projects with same language |
| Library patterns | Yes | Generic, reusable across projects using same library |
| Learning curricula | Yes | Generic, reusable across all projects (stored globally in ~/plan-flow/brain/learns/) |
| Cross-project patterns | Yes | By definition cross-project |
| Project-specific patterns | No | Contains project-specific paths, conventions |
| Error patterns | No | Project-specific, kept in flow/brain/errors/ |
| Feature history | No | Project-specific |
| Notes | N/A | Already global at ~/plan-flow/brain/notes/ |

### Sync Process

1. Check if `~/plan-flow/brain/` exists. If not, create it with subdirectories: `patterns/`, `projects/`, `notes/`
2. Update `~/plan-flow/brain/projects/{project-name}.md` with current summary (project name, stack, active feature count, last activity date)
3. **After `/setup` generates pattern files**: Sync generic patterns (framework, language, library) to `~/plan-flow/brain/patterns/`. See the Global Pattern Sync section below.

### Global Pattern Sync (after /setup)

When `/setup` generates pattern files, sync **generic** patterns to `~/plan-flow/brain/patterns/`:

**What qualifies as generic (sync these)**:
- Framework patterns (`.claude/resources/frameworks/<fw>-patterns.md`) — best practices, conventions, and anti-patterns that apply to ANY project using that framework
- Language patterns — TypeScript strict mode, Python PEP 8, etc.
- Library patterns (`.claude/resources/libraries/<lib>-patterns.md`) — import styles, naming conventions, and best practices for the library itself

**What is NOT generic (do NOT sync)**:
- Project patterns (`.claude/resources/project/project-patterns.md`) — contains project-specific directory structure, file paths, import aliases
- Patterns that reference project-specific file paths (e.g., `src/schemas/`, `@/lib/prisma`)

**Sync rules**:
1. Target: `~/plan-flow/brain/patterns/<name>.md` (e.g., `nextjs.md`, `typescript.md`, `zod.md`)
2. Use kebab-case file names matching the framework/library name (not `<fw>-patterns.md`, just `<fw>.md`)
3. **If pattern file already exists in global brain**: Merge by appending new sections that don't already exist. Do NOT overwrite — the global file may contain accumulated knowledge from multiple projects
4. **If pattern file does not exist**: Copy it, removing project-specific file paths and examples. Keep only the generic best practices, conventions, and anti-patterns
5. Add a `## Projects Using This` section at the bottom with `[[project-name]]` wiki-links
6. Strip project-specific code examples (paths like `src/schemas/user.schema.ts`). Keep generic examples that show the pattern without referencing specific project files

**Template for global pattern file**:

```markdown
# [Framework/Library] Patterns

## Best Practices

[Generic best practices from setup analysis]

## Allowed Patterns

[Generic allowed patterns]

## Forbidden Patterns

[Generic anti-patterns]

## Projects Using This

- [[project-name-1]]
- [[project-name-2]]
```

### Global Brain Structure (Central Vault)

The global brain at `~/plan-flow/brain/` is the Obsidian vault root. Each project gets a real directory in `projects/` with individual symlinks for each flow subdirectory. Wiki-links between brain entries, plans, and discoveries resolve correctly across all projects.

```
~/plan-flow/brain/                                    ← Open this as Obsidian vault
├── .obsidian/                                         # Pre-configured graph color groups
│   └── graph.json                                     # Uses path-based queries
├── index.md                                           # Lists all registered projects
├── patterns/                                          # Shared engineering patterns (GLB-* indexed)
│   ├── _index.md                                      # Pattern index with reference codes
│   ├── typescript.md
│   └── nextjs.md
├── learns/                                            # Shared learning curricula (LRN-* indexed)
│   ├── _index.md                                      # Learns index with reference codes
│   ├── mcp.md
│   └── docker.md
├── notes/                                             # Notes (cross-project)
│   ├── 2026-03-05.md
│   └── 2026-03-06.md
└── projects/
    ├── my-app/                                        ← real directory (not a symlink)
    │   ├── features/  → /home/user/my-app/flow/brain/features/
    │   ├── errors/    → /home/user/my-app/flow/brain/errors/
    │   ├── discovery/ → /home/user/my-app/flow/discovery/
    │   ├── plans/     → /home/user/my-app/flow/plans/
    │   ├── archive/   → /home/user/my-app/flow/archive/
    │   └── contracts/ → /home/user/my-app/flow/contracts/
    └── api/                                           ← another project
        ├── features/  → /home/user/api/flow/brain/features/
        └── ...
```

Symlinks are created automatically by `plan-flow init`. Each init registers the project with individual links per subdirectory.

---

## Brain vs Ledger

| Aspect | Ledger (`flow/ledger.md`) | Brain (`flow/brain/`) |
|--------|--------------------------|----------------------|
| Content | Curated lessons (AI judgment) | Raw history (factual record) |
| Size | One file, ~150 lines max | Many files, unlimited |
| Purpose | Quick actionable lessons | Full context recall |
| Update trigger | During work, when learning | After skill completion |
| Loaded at | Session start (always) | Session start (index only) |

Both coexist. The ledger is the AI's opinion. The brain is the record of truth. Never replace one with the other.
