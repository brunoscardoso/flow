---
description: Manual note entry - capture meeting notes, ideas, brainstorms, and insights into the project brain
---

# Note: Manual Knowledge Capture

## Command Description

This command allows manual brain entries for capturing meeting notes, brainstorms, ad-hoc ideas, and insights that don't come from automatic skill execution. Supports two modes: free-text (default) and guided prompts.

**Output**: Brain entries in `flow/brain/` with `[[wiki-links]]` for Obsidian compatibility.

---


## Help

**If the user invokes this command with `-help`, display only this section and stop:**

```
/note - Manual Brain Entry

DESCRIPTION:
  Capture meeting notes, brainstorms, ideas, and insights into the
  project brain. Creates Obsidian-compatible markdown with [[wiki-links]].

USAGE:
  /note <free text>        Free-text mode (default)
  /note -guided            Guided mode with structured questions
  /note -help              Show this help

ARGUMENTS:
  free text     Unstructured text to parse and categorize
  -guided       Triggers structured question mode

EXAMPLES:
  /note Had a call with the team about auth flow. Decision: use JWT with refresh tokens.
  /note Discovered that the API rate limits at 100 req/min. Need to add throttling.
  /note -guided

OUTPUT:
  - Writes to appropriate flow/brain/ subdirectory
  - Creates [[wiki-links]] to related entries
  - Rebuilds flow/brain/index.md (generated) with `planflow-ai brain index`

MODES:
  Free-text:  Parses input, extracts entities, categorizes, writes entry
  Guided:     Asks structured questions about work, insights, meetings, decisions

BRAIN STRUCTURE:
  flow/brain/                          # Per-project brain
  ├── index.md                         # Brain index (generated — `planflow-ai brain index`)
  ├── features/                        # Feature history and context
  └── errors/                          # Reusable error patterns

  ~/plan-flow/brain/notes/             # Notes (cross-project)
  └── YYYY-MM-DD.md

RELATED COMMANDS:
  /setup             Creates brain directory structure
  /discovery-plan    Auto-captures to brain after completion
  /execute-plan      Auto-captures to brain after completion
```

---

## Critical Rules

| Rule                     | Description                                              |
| ------------------------ | -------------------------------------------------------- |
| **Brain Only**           | ONLY write to `flow/brain/` - no source code, no config  |
| **Wiki-Links**           | All cross-references use `[[kebab-case-name]]` format    |
| **Generated Index**      | Never edit `flow/brain/index.md`; run `planflow-ai brain index` |
| **No Code**              | Brain is for knowledge capture, never write source code   |
| **Complete and Stop**    | After writing entry, STOP and wait for user               |

---

## Instructions

### Step 1: Validate Inputs

| Input       | Required | Description                                    |
| ----------- | -------- | ---------------------------------------------- |
| `content`   | Yes      | Free-text or triggered by `-guided` flag       |
| `-guided`   | Optional | Triggers structured question mode              |

If no content and no `-guided` flag, ask:

```markdown
What would you like to capture? You can:
1. Type free text and I'll categorize it automatically
2. Use `/note -guided` for structured prompts
```

---

### Step 2: Ensure Brain Directory Exists

Check if `flow/brain/` exists. If not, create:

```bash
mkdir -p flow/brain/features flow/brain/errors
```

Do NOT create or edit `flow/brain/index.md` by hand — it is GENERATED from the notes. After writing notes (Step 3), rebuild it with `planflow-ai brain index`.

---

### Step 3: Invoke Brain Skill

The skill will handle:

**Free-text mode**:
1. Parse input text
2. Extract entities (features, technologies, people, errors, decisions)
3. Categorize into appropriate brain subdirectory
4. Create/update brain files with `[[wiki-links]]`
5. Rebuild the index with `planflow-ai brain index` if a feature, error or decision note changed

**Guided mode** (`-guided`):
1. Ask structured questions via `AskUserQuestion`
2. Gather responses and follow-up text
3. Generate properly formatted brain files
4. Link everything with `[[wiki-links]]`
5. Rebuild the index with `planflow-ai brain index`

See: `.claude/resources/skills/brain-skill.md`

---

### Step 4: Present Results

After the skill completes:

**Free-text result**:

```markdown
Note saved.
File: `flow/brain/[subdirectory]/[file].md`
Links: [[feature-1]], [[error-name]]
Index: updated        # or: Index: not changed
```

**Guided result**:

```markdown
Note saved.

- Feature: [[feature-name]] — summary
- Decision: [[decision-name]] — choice
- Meeting notes: [[YYYY-MM-DD]]

Index: updated
```

Write the chat summary in short, clear sentences (ASD-STE100 style); say it once; do not repeat a finished result.

---

## Flow Diagram

```
+------------------------------------------+
|           /note COMMAND                  |
+------------------------------------------+
                    |
                    v
+------------------------------------------+
| Step 1: Validate Inputs                  |
| - Check for content or -guided flag      |
+------------------------------------------+
                    |
                    v
+------------------------------------------+
| Step 2: Ensure Brain Directory           |
| - Create flow/brain/ if needed           |
| - Index is generated (brain index)      |
+------------------------------------------+
                    |
                    v
+------------------------------------------+
| Step 3: Invoke Brain Skill               |
| - Free-text: parse, extract, categorize  |
| - Guided: structured questions           |
| - See brain-skill.md                    |
+------------------------------------------+
                    |
                    v
+------------------------------------------+
| Step 4: Present Results                  |
| - Show files written                     |
| - Show links created                     |
| - Show whether the index was rebuilt     |
+------------------------------------------+
```

## Context Loading

This command uses the **project brain** for context retrieval. Before executing, query it for relevant documentation:

**Queries**:
- `planflow-ai state-query "brain capture" --scope resources`
- `planflow-ai state-query "brain patterns" --scope resources`

The brain returns ranked chunks from indexed markdown files. Use the top results to inform execution.

---

## Related Resources

| Resource                    | Purpose                           |
| --------------------------- | --------------------------------- |
| `brain-skill.md`           | Skill that processes brain entries |
| `brain-patterns.md`        | File naming and link conventions  |
| `brain-capture.md`         | Processing rules and templates    |
