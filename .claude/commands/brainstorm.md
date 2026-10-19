---
description: Free-form conversational exploration of an idea. The LLM collaborates one-question-at-a-time to crystallize vague ideas before discovery. Optionally generates an MD file for /discovery-plan.
---

# Brainstorm

## Command Description

This command starts a free-form brainstorm session where the LLM collaborates conversationally to explore an idea. Unlike `/discovery-plan` (structured, project-aware), brainstorm is pure ideation — exploring the what and why through rapid back-and-forth dialogue.

**Output**: Conversational exploration, plus an optional markdown file at `flow/brainstorms/brainstorm_{topic}_v{version}.md`

---


## Help

**If the user invokes this command with `-help`, display only this section and stop:**

```
/brainstorm - Collaborative Idea Exploration

DESCRIPTION:
  Free-form brainstorm session where the LLM acts as a collaborative
  thinking partner. Explores ideas through one-question-at-a-time dialogue
  before formalizing into discovery.

USAGE:
  /brainstorm <idea>
  /brainstorm -help

ARGUMENTS:
  idea   Free-text description of the idea to explore

EXAMPLES:
  /brainstorm I want to add a plugin system to plan-flow
  /brainstorm "Real-time notifications triggered by user actions"
  /brainstorm We need a better way to handle error recovery in the API

OUTPUT:
  - Conversational exploration of the idea
  - Optional: flow/brainstorms/brainstorm_{topic}_v{version}.md
  - Optional: tasklist entry (only if requested)

WORKFLOW:
  1. You share your idea
  2. LLM presents batched questions with options (3-4 per round, with recommended choices)
  3. You pick options or type custom answers, LLM reacts with insights
  4. You say "done" / "wrap up" / "summarize" when ready
  5. LLM presents structured summary
  6. Optionally generates MD file for /discovery-plan
  7. Optionally adds to tasklist

WHAT IT IS:
  - A thinking partner — challenges, suggests, connects, presents structured options
  - Pure ideation — explores the what and why
  - Lightweight — no brain, no memory, no auto-tasklist

WHAT IT IS NOT:
  - Not /discovery-plan — no codebase scanning, no requirements docs
  - Not /note — no knowledge capture, no wiki-links
  - Not a plan — no phases, no complexity scores

RECOMMENDED MODEL:
  Claude Opus 4.6 or Sonnet 4.5 for best results

RELATED COMMANDS:
  /discovery-plan   Ground the brainstorm idea into the project
  /create-plan      Create plan from discovery document
  /note             Capture knowledge (different purpose)
```

---

## Critical Rules

| Rule | Description |
|------|-------------|
| **Structured Exploration** | Questions in batches of 3-4 with options via `AskUserQuestion`. Commentary between batches. |
| **No Code** | NEVER write, edit, or generate source code |
| **No Brain** | Do NOT write to `flow/brain/` or update brain index |
| **No Memory** | Do NOT write to `flow/memory.md` |
| **No Auto-Tasklist** | Only update tasklist if user explicitly requests |
| **Codebase on Request** | Only read codebase files when user explicitly asks |
| **User Ends It** | Never auto-end the brainstorm. User controls when it's done. |
| **Complete and Stop** | After completion, STOP and wait for user |

---

## Instructions

### Step 1: Validate Inputs

| Input | Required | Description |
|-------|----------|-------------|
| `idea` | Yes | Free-text description of the idea to explore |

If no idea is provided, ask:

```markdown
What idea would you like to explore? Just describe it in your own words —
it can be as vague or specific as you want.
```

---

### Step 2: Check for Existing Brainstorms

Check `flow/brainstorms/` for existing brainstorm documents on a similar topic:

1. If found, mention it: "There's an existing brainstorm on {topic} (v{N}). Want to build on that or start fresh?"
2. If starting fresh, increment version number
3. If building on existing, read it first for context

---

### Step 3: Invoke Brainstorm Skill

The skill will:

1. Parse the idea and open the conversation
2. Run the conversational loop (one question per turn)
3. Detect when the user wants to end
4. Present a structured summary
5. Offer to generate an MD file
6. Offer to add a tasklist entry

See: `.claude/resources/skills/brainstorm-skill.md`

---

### Step 3b: Link Related Projects in this Workspace (REQUIRED in a Workspace — skipped silently outside one)

Projects of one Workspace share knowledge, and the touchpoints between them are
recorded as you work — not reconstructed later.

```bash
planflow-ai workspace status --target . --json
```

`workspace: null` → skip this step and say nothing about it. Otherwise:

1. Search the sibling projects for the idea's subject:
   `planflow-ai brain search "<topic>" --scope workspace` — hits are namespaced
   `<project>/…`; a `link` hit is a touchpoint someone already recorded.
2. Name the sibling projects the idea would touch in the brainstorm summary (and in the MD file when one is generated), under **Related projects in this Workspace**.
3. Record each touchpoint (the one writer — never edit `links.jsonl` by hand):

   ```bash
   planflow-ai workspace link-knowledge --target . \
     --from <project>/<feature-or-anchor> --to <project>/<feature-or-anchor> \
     --kind calls|exposes|consumes|relates --note "<one line of why/how>" --json
   ```

   `<project>` is a slug from `workspace status` (`project.slug`, `siblings[].slug`);
   the ref is a feature slug or an anchor (`endpoint:POST /api/orders`,
   `file:src/screens/Orders.tsx`, `module:src/api`). Example: a new backend endpoint the frontend checkout screen calls → `--from backend/endpoint:POST /api/orders --to frontend/file:src/screens/Checkout.tsx --kind exposes`. Use `--kind relates` when the idea only connects two features. Recording the same
   link twice is a no-op. A `workspace refused: <reason>` line comes with a JSON
   payload naming the valid slugs or kinds — correct the address from it once, or
   report the refusal verbatim.

**Verification (MANDATORY in a Workspace)**:

```
Workspace links: N recorded    # or: Workspace links: 0 recorded — <why no project was touched>
```

---

### Step 4: Handle Completion

After the skill completes:

- If MD file was generated: report the file path
- If no MD file: just acknowledge completion
- Do NOT auto-chain to `/discovery-plan`

**Output to the user**:

```markdown
Brainstorm saved.
File: `flow/brainstorms/brainstorm_<topic>_v<version>.md`     # or: Brainstorm done. No file saved.
Workspace links: N recorded        # this line only in a Workspace
Next: run `/discovery-plan @<file>`.
```

Write the chat summary in short, clear sentences (ASD-STE100 style); say it once; do not repeat a finished result.

---

## Flow Diagram

```
+------------------------------------------+
|        /brainstorm COMMAND               |
+------------------------------------------+
                    |
                    v
+------------------------------------------+
| Step 1: Validate Inputs                  |
| - Check for idea text                    |
| - Ask if not provided                    |
+------------------------------------------+
                    |
                    v
+------------------------------------------+
| Step 2: Check Existing Brainstorms       |
| - Look in flow/brainstorms/              |
| - Offer to build on or start fresh       |
+------------------------------------------+
                    |
                    v
+------------------------------------------+
| Step 3: Invoke Brainstorm Skill          |
| - Conversational loop                    |
| - One question per turn                  |
| - Silent thread tracking                 |
| - See brainstorm-skill.md              |
+------------------------------------------+
                    |
                    v
+------------------------------------------+
| Step 4: Handle Completion                |
| - Summary presented                      |
| - Optional MD file generated             |
| - Optional tasklist entry                |
| - STOP (no auto-chain)                   |
+------------------------------------------+
```

## Context Loading

This command uses the **project brain** for context retrieval. Before executing, query it for relevant documentation:

**Queries**:
- `planflow-ai state-query "brainstorm workflow" --scope resources`
- `planflow-ai state-query "interactive questions" --scope resources`

The brain returns ranked chunks from indexed markdown files. Use the top results to inform execution.

---

## Related Resources

| Resource | Purpose |
|----------|---------|
| `brainstorm-skill.md` | Skill that runs the brainstorm |
| `brainstorm-templates.md` | Output file template |
| `/discovery-plan` command | Next step after brainstorm |

---

## Resource Capture

During this skill's execution, watch for valuable reference materials worth preserving. See `.claude/resources/core/resource-capture.md` for capture rules, file format, and naming conventions.

At natural break points, if you encounter information that could be useful for future development (API specs, architecture notes, config references, domain knowledge, etc.), ask the user: "I found something that could be useful for future reference: _{brief description}_. Should I save it to `flow/resources/`?"

Only save if the user approves. Do not re-ask if declined.

---

## Pattern Capture

During the brainstorm, silently watch for conventions, anti-patterns, and patterns that emerge from the discussion. Append captured patterns to `flow/resources/pending-patterns.md` without interrupting the conversation.

After the brainstorm completes, present any buffered patterns for user approval. Approved patterns are written to `.claude/rules/core/allowed-patterns.md` or `.claude/rules/core/forbidden-patterns.md`.

See `.claude/resources/core/pattern-capture.md` for buffer format, capture triggers, conflict detection, and the full review protocol.
