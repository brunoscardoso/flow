
# Brainstorm Skill

## Purpose

Facilitate a **free-form, conversational exploration** of an idea through collaborative dialogue. The LLM acts as a sharp coworker at a whiteboard — asking one question at a time, challenging assumptions, suggesting angles, and silently tracking the emerging structure.

This skill is the **pre-discovery phase** — pure ideation before requirements formalization. It does NOT:

- Write any source code
- Modify any source files
- Create implementation plans
- Execute any implementation
- Scan the codebase (unless user explicitly asks)
- Write to `flow/brain/` or `flow/memory.md`
- Automatically update `flow/tasklist.md`

---

## Restrictions

### Allowed Actions

| Action | Purpose |
|--------|---------|
| Conversational dialogue | Core brainstorm interaction |
| Read codebase files | **Only when user explicitly asks** (e.g., "check how X works") |
| Write to `flow/brainstorms/` | Save brainstorm output document |
| Read `flow/brainstorms/` | Check for existing brainstorms on same topic |
| Edit `flow/tasklist.md` | **Only when user explicitly requests** at the end |

### Forbidden Actions

| Action | Reason |
|--------|--------|
| Write source code | Brainstorm is ideation only |
| Write to `flow/brain/` | No brain integration |
| Write to `flow/memory.md` | No memory integration |
| Auto-update `flow/tasklist.md` | Only on explicit user request |
| Deep codebase scanning | That's discovery's job — brainstorm stays in idea space |
| Create plans or discovery docs | Brainstorm only produces brainstorm files |
| Run build/test commands | No execution commands |

---

## Inputs

| Input | Required | Description |
|-------|----------|-------------|
| `idea` | Yes | Free-text description of the idea to explore |
| `topic_name` | Optional | Short name for the topic (derived from idea if not provided) |

---

## Workflow

### Step 1: Parse Idea and Open the Conversation

1. Read the user's idea
2. **Show understanding** — restate the core concept in your own words to confirm alignment
3. **Add an initial insight** — offer a first reaction, angle, or connection
4. **Ask one focused question** — the first question that would most help shape the idea

**Tone**: Casual, collaborative, curious. Like a coworker who just heard your idea and is genuinely interested.

**Example**:

```
User: /brainstorm I want to add a plugin system to plan-flow

LLM: A plugin system — so users could extend plan-flow with custom skills
or hooks without forking the repo. That could unlock a whole ecosystem.

The first thing I'd want to understand: are you thinking plugins that
add new slash commands, or something lower-level like middleware that
hooks into the existing skill execution pipeline?
```

---

### Step 2: Structured Exploration Loop

This is the core of the brainstorm. After the open-ended first round (Step 1), switch to structured batched questions using the `AskUserQuestion` tool. Repeat until the user signals they're done.

**Per Round Behavior**:

1. **Formulate questions** — create 3-4 questions based on the current state of the brainstorm, each with 2-4 options
2. **Present via `AskUserQuestion`** — call the tool with the batch of questions (see `.claude/resources/tools/interactive-questions-tool.md` for tool usage)
3. **Wait for responses** — user picks options or types custom answers via "Other"
4. **Process answers** — update silent tracking with the user's choices
5. **Commentary** — react to the answers in regular chat: connect dots, surface insights, challenge assumptions, make suggestions. This is what keeps it feeling like a brainstorm, not a form.
6. **Check for end signals** — if user typed "done", "wrap up", etc. in any "Other" field or in response to commentary, proceed to Step 3
7. **Repeat** — formulate next batch based on what was learned

**Question Formulation Rules**:

- Each question must have a **recommended option** as the first option with "(Recommended)" suffix on the label
- Mix question types across each batch — don't ask 4 clarifying questions in a row
- When the idea is too vague for structured options on a particular point, ask that question as regular chat within the commentary instead — not everything needs to go through `AskUserQuestion`
- Cap at **3-4 questions per `AskUserQuestion` call** (tool limit is 4)
- Each option needs a `label` (1-5 words) and `description` (explanation of what it means)

**Question Types to Mix**:

| Type | Purpose | Example Question |
|------|---------|---------|
| Clarifying | Understand the concept deeper | "What scope should this feature cover?" with options like "MVP only (Recommended)" / "Full feature" / "Phased rollout" |
| Challenging | Push back on assumptions | "Is this the right approach?" with options presenting alternatives |
| Expanding | Broaden scope or find connections | "What else could this enable?" with options for related features |
| Constraining | Find the MVP / simplest version | "What can we cut from v1?" with options for scope reduction |
| Connecting | Link to existing knowledge | "Which existing pattern fits best?" with options for known patterns |

**Commentary Between Batches**:

The commentary is what makes this a brainstorm and not a survey. After processing each batch of answers:

- **React** — show you understood the choices and what they mean together
- **Connect** — link answers across questions ("Your choice of X combined with Y suggests...")
- **Challenge** — if an answer seems contradictory or surprising, call it out
- **Suggest** — offer an insight the user might not have considered ("What if we also...")
- **Transition** — naturally lead into why the next batch of questions matters

Keep commentary concise (2-4 sentences). Don't lecture — think sharp coworker at a whiteboard.

**Silent Tracking**:

While processing responses and writing commentary, maintain an internal running tally of:

| Category | What to Track |
|----------|--------------|
| **Core Idea** | The central thesis — evolves as options are selected |
| **Key Decisions** | Options chosen by the user (with reasoning from descriptions) |
| **Open Questions** | Things raised but not yet resolved |
| **Constraints** | Limitations that surfaced (technical, time, scope, etc.) |
| **Inspirations / References** | Existing code, patterns, tools, or external ideas mentioned |
| **Rejected Alternatives** | Options NOT chosen — preserve as rejected alternatives with reasoning |

Do NOT show this tracking to the user during the conversation. It's used to generate the summary and output file.

---

### Step 3: End Detection

The brainstorm ends when the user signals they're done. Watch for:

**Clear End Signals** (transition immediately):
- "I'm done"
- "Let's wrap up"
- "That's enough"
- "Summarize"
- "Let's move on"
- "I think we've covered it"
- "Generate the file"

**Ambiguous Signals** (ask to confirm):
- Long pause with a short response like "yeah" or "ok"
- "I think so" or "maybe"
- Response: "Sounds like we might be reaching a natural stopping point — should I summarize what we've discussed, or is there another angle you want to explore?"

**Never End Signals** (keep going):
- User asks a new question
- User introduces a new angle
- User says "what about..." or "also..."
- User is mid-thought

**Default**: When in doubt, keep the brainstorm going. It's better to explore one more angle than to cut short.

---

### Step 4: Present Summary

When the brainstorm ends, present a structured summary of what was discussed:

```markdown
## Brainstorm Summary: {topic}

### Core Idea
{The central thesis as it evolved during the conversation}

### Key Decisions
- {Decision 1} — {reasoning}
- {Decision 2} — {reasoning}

### Open Questions
- {Question still unresolved}

### Constraints
- {Limitation that surfaced}

### Inspirations & References
- {Tool, pattern, or idea that came up}

### Rejected Alternatives
- {Alternative considered and discarded} — {why}
```

Present this as a chat message (not a file yet). Keep each item to one short line.

Write the chat summary in short, clear sentences (ASD-STE100 style); say it once; do not repeat a finished result.

---

### Step 4b: Optional Draft Story Steps

If the conversation crystallized a clear problem framing and rough shape (not required — brainstorms are pre-discovery ideation), the output file MAY include a `## Story` section with early `### Step: <title>` blocks covering just **problem** and **shape** (the two earliest beats of the problem → shape → data flow → decisions/why-nots → risks arc — see `.claude/resources/core/blueprint.md`, Story Layer). Grammar: `src/cli/blueprint/story-grammar.ts`.

- This is optional and lightweight — skip it entirely when the idea hasn't crystallized enough for even a rough shape.
- Running `planflow-ai blueprint narrate --from <brainstorm-doc> --draft` afterward is also optional (fail-soft, never blocks the brainstorm) — `/discovery-plan` is where the story arc gets real investment.

---

### Step 4c: Link Related Projects in this Workspace (REQUIRED in a Workspace — skipped silently outside one)

`planflow-ai workspace status --target . --json` — `workspace: null` means skip this
step silently. In a Workspace: search the siblings for the idea's subject
(`planflow-ai brain search "<topic>" --scope workspace`, hits namespaced
`<project>/…`); name the sibling projects the idea would touch in the brainstorm summary (and in the MD file when one is generated), under **Related projects in this Workspace**. Record each touchpoint with
`planflow-ai workspace link-knowledge --target . --from <project>/<feature-or-anchor> --to <project>/<feature-or-anchor> --kind calls|exposes|consumes|relates --note "<why/how>" --json`
— the one writer of the Workspace's links (full step: `.claude/commands/brainstorm.md`).
Report `Workspace links: N recorded` (zero with its reason).

### Step 5: Offer MD File Generation

After presenting the summary, ask:

```markdown
Would you like me to save this as a brainstorm document? It can be used as
input for `/discovery-plan` later.
```

- **If yes**: Proceed to Step 6
- **If no**: Proceed to Step 7 (skip file generation)

---

### Step 6: Generate Output File

**Location**: `flow/brainstorms/brainstorm_{topic}_v{version}.md`

**Topic naming**: kebab-case derived from the idea (e.g., "plugin system" → `plugin-system`)

**Versioning**: Check `flow/brainstorms/` for existing files with the same topic. Increment version if found.

**Template**: Use the template from `.claude/resources/patterns/brainstorm-templates.md`

The output file must include all tracked categories plus the **"For Discovery" bridge section** that makes the handoff to `/discovery-plan` seamless.

After writing, report:

```markdown
Brainstorm saved.
File: `flow/brainstorms/brainstorm_{topic}_v{version}.md`
Next: run `/discovery-plan @flow/brainstorms/brainstorm_{topic}_v{version}.md`.
```

---

### Step 7: Offer Tasklist Entry (Optional)

After the brainstorm completes (whether or not an MD file was generated):

```markdown
Want me to add this to the tasklist?
```

- **If yes**: Add "Discovery: {topic}" to the **To Do** section of `flow/tasklist.md`
- **If no**: Done — do not add anything

---

## Output Format

See `.claude/resources/patterns/brainstorm-templates.md` for the full output template.

---

## Validation Checklist

Before completing the brainstorm, verify:

- [ ] Questions presented in batches with options via `AskUserQuestion`
- [ ] Commentary provided between question batches
- [ ] Open-ended first round (Step 1) before structured batches
- [ ] User signaled end (not auto-ended by LLM)
- [ ] Summary presented before offering file generation
- [ ] If file generated: saved to `flow/brainstorms/` with correct naming
- [ ] If file generated: includes "For Discovery" bridge section
- [ ] Tasklist only updated if user explicitly requested
- [ ] No source code written
- [ ] No brain entries created
- [ ] No memory entries created
- [ ] Codebase only read when user explicitly asked

---

## Related Files

| File | Purpose |
|------|---------|
| `.claude/commands/brainstorm.md` | Command file that invokes this skill |
| `.claude/resources/patterns/brainstorm-templates.md` | Output file template |
| `.claude/resources/skills/discovery-skill.md` | Discovery skill that consumes brainstorm output |
| `.claude/resources/core/blueprint.md` | Story Layer — grammar, narrate modes, arc convention |
| `flow/brainstorms/` | Output directory for brainstorm documents |
