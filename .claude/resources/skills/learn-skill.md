
# Learn Skill

## Purpose

Extract reusable patterns from the current session and save them as learned pattern files in `flow/resources/`. This skill analyzes the conversation for error resolutions, debugging techniques, workarounds, and project-specific conventions worth preserving.

This skill **only writes to `flow/resources/`**. It does NOT:

- Write any source code
- Modify any configuration files
- Execute any commands
- Create files outside `flow/resources/`

---

## Restrictions

### Allowed Actions

| Action | Purpose |
|--------|---------|
| Read conversation history | Identify extractable patterns |
| Read `flow/resources/learned-*.md` | Check for duplicates |
| Read `flow/brain/index.md` | Context for wiki-links |
| Write to `flow/resources/learned-*.md` | Save approved patterns |

### Forbidden Actions

| Action | Reason |
|--------|--------|
| Write source code | Learn is for knowledge capture, not code |
| Create files outside `flow/resources/` | Learned patterns only go to resources |
| Save without user approval | User must confirm every pattern |
| Save trivial patterns | Only non-obvious, reusable knowledge |

---

## Extraction Criteria

### What to Extract (Priority Order)

| Priority | Category | Trigger | Example |
|----------|----------|---------|---------|
| **High** | `error-resolution` | Fixed a non-obvious error | "ESM imports require `.js` extension in ts-jest" |
| **High** | `debugging` | Multi-step diagnosis | "Memory leak found by comparing heap snapshots" |
| **Medium** | `workaround` | Bypassed a limitation | "Used `jest.unstable_mockModule` for ESM mocking" |
| **Medium** | `convention` | Discovered project pattern | "All API routes follow `/api/v1/{resource}` pattern" |
| **Low** | `architecture` | Structural decision made | "Chose event-driven over polling for real-time updates" |
| **Low** | `integration` | Service connection pattern | "OAuth2 token refresh uses interceptor pattern" |

### What NOT to Extract

- **Trivial fixes**: typos, missing imports, unused variables, obvious syntax errors
- **One-time issues**: environment-specific problems (wrong Node version, missing env var)
- **Generic knowledge**: standard language/framework features in official docs
- **Already captured**: check `flow/resources/learned-*.md` for existing patterns

---

## Workflow

### Step 1: Session Analysis

Scan the conversation for:

1. **Errors encountered** — Was the resolution non-obvious?
2. **Multiple attempts** — Did you try several approaches before finding the right one?
3. **User corrections** — Did the user redirect your approach?
4. **Configuration discoveries** — Did you learn something about how the project is configured?
5. **Tool-specific tricks** — Did you use a tool in a non-standard way?

### Step 2: Pattern Drafting

For each candidate pattern:

1. Verify it passes extraction criteria (not trivial, not one-time, not generic)
2. Check `flow/resources/learned-*.md` for duplicates
3. Draft using the output template
4. Add `[[wiki-links]]` to related brain entries and features

### Step 3: User Confirmation

Present each drafted pattern to the user. Accept revisions or rejection.

### Step 4: Save

Write approved patterns to `flow/resources/learned-{kebab-case-name}.md`.

---

## Output Format

### Pattern File Template

```markdown
# {Pattern Name}

**Project**: [[{project-name}]]
**Learned**: {YYYY-MM-DD}
**Category**: {error-resolution|debugging|workaround|convention|architecture|integration}

## Problem
{What problem this solves}

## Solution
{The pattern/technique/workaround}

## Example
{Code example if applicable}

## When to Use
{Trigger conditions - when should the LLM apply this pattern}

## Related
- [[{feature-name}]]
- [[{brain-entry}]]
```

### File Naming

- Format: `learned-{kebab-case-name}.md`
- Location: `flow/resources/`
- Examples: `learned-esm-jest-mocking.md`, `learned-api-rate-limit-retry.md`

---

## Validation Checklist

- [ ] Pattern is non-trivial and reusable across sessions
- [ ] User explicitly approved the pattern before saving
- [ ] File saved to `flow/resources/learned-{name}.md`
- [ ] All `[[wiki-links]]` reference valid kebab-case names
- [ ] No duplicate of existing `learned-*.md` file
- [ ] No source code written
- [ ] No files created outside `flow/resources/`

---

## Teaching Mode

When `/learn <topic>` is invoked (any text after `/learn`), the skill switches to teaching mode. This mode intelligently classifies the topic, asks the user about their preferred learning approach, and delivers an adaptive curriculum.

### Restrictions

| Action | Allowed |
|--------|---------|
| Read project context (brain index, tech foundation) | Yes |
| Read existing learns index (`~/plan-flow/brain/learns/_index.md`) | Yes |
| Use web search for up-to-date docs and info | Yes |
| Generate curriculum in `~/plan-flow/brain/learns/` | Yes |
| Update learns index with `LRN-*` reference codes | No — retired; saving the file is enough |
| Add to the `## Global Learns` / `## Project Learns` section of the brain index (carried over by `planflow-ai brain index`; the generated sections are never hand-edited) | Yes |
| Present step-by-step content | Yes |
| Write source code | No |
| Modify configuration files | No |
| Write outside `~/plan-flow/brain/learns/` and `flow/brain/` | No |

### Topic Classification

Before designing the curriculum, classify the topic:

- **Integrable tool/library** (Langfuse, Sentry, Prisma, Redis) → Ask: general knowledge, project implementation, or both?
- **Platform/service** (AWS, Docker, Kubernetes) → Ask: general knowledge, project implementation, or both?
- **Concept/pattern** (MCP, event sourcing, CQRS) → Teach as general knowledge with project-contextualized examples
- **Language/framework feature** (TypeScript generics, React Server Components) → Teach with project examples

### Curriculum Generation

1. Classify the topic type (see above)
2. For integrable topics: ask the user their preferred approach
3. Read `~/plan-flow/brain/learns/_index.md` to check if the topic already exists
4. If it exists, offer to resume, expand, or start fresh
5. Use web search for official docs and up-to-date information
6. Read `flow/brain/index.md` and `flow/references/tech-foundation.md` for project context
7. Design 3-7 steps based on the chosen approach (general / implementation / hybrid)
8. Present the full outline for user approval before starting

### Adaptive Teaching

During teaching, respond dynamically to the user:

- **"I already know this"** → Skip step, offer to adjust remaining curriculum
- **"Go deeper"** → Expand with more detail, edge cases, advanced examples
- **"Show me in my project"** → Switch to project-contextualized explanation
- **Tangent questions** → Answer, then offer to continue or explore further
- **Confusion** → Rephrase simpler, add analogies, break into sub-steps
- **"Done" / "That's enough"** → Save what's completed with `partial` status

### Storage

Storage location depends on the user's chosen approach:

| Approach | Location | Indexed? |
|----------|----------|----------|
| General knowledge | `~/plan-flow/brain/learns/{topic}.md` (global) | Yes, `LRN-*` codes |
| Project implementation | `flow/brain/learning/{topic}.md` (project-local) | No (project-only) |
| Both | Global + `flow/brain/learning/{topic}-implementation.md` | Global part only |
| Concept/pattern | `~/plan-flow/brain/learns/{topic}.md` (global) | Yes, `LRN-*` codes |

- **Directories**: Created automatically if they don't exist
- **Format**: Uses the curriculum template from the command definition
- **Wiki-links**: Links to project name(s) and related brain entries
- **Cross-project**: Global learns track all projects using them in `## Projects Using This`
- **Linked files**: "Both" approach creates two files linked via `[[wiki-links]]`

### How a learn is found again

**There is no index step, and no eligibility gate.** A learn is a markdown file;
saving it IS indexing it.

`LRN-*` reference codes, the `_index.md` that mapped them to line ranges, and
`/pattern-validate` are all retired — that command does not exist, and the
migration in `src/cli/handlers/claude.ts` deletes leftover `_index.md` files.
Nothing in the codebase reads an `LRN-*` code.

1. A learn saved under a project's `flow/brain/` is in the searched corpus
   immediately — `planflow-ai brain search "<question>"` finds it.
2. A learn worth treating as the canonical answer on its subject gets a line in
   `flow/brain/catalog.md`, addressed by HEADING, and is expanded whole with
   `planflow-ai brain ref <code>`. See `brain-first.md`.
3. **A learn saved to the central vault (`~/plan-flow/brain/learns/`) is
   reachable by nothing.** That path is outside every corpus root, and the
   reference-code index was its only reader. Prefer the project's own
   `flow/brain/` until that gap is closed.

---

## Related Files

| File | Purpose |
|------|---------|
| `.claude/commands/learn.md` | Command definition |
| `flow/resources/` | Where learned patterns are saved |
| `~/plan-flow/brain/learns/` | Where teaching curricula are saved (global) |
| `flow/brain/index.md` | Brain index for wiki-link context |

## Target: features, not modules (feature-blueprint)

`/learn <feature>` is the form. Feature learning REPLACED the module tier —
the feature is the unit anyone cares about being current, and a module-first
index makes an agent read structure to find meaning.

- **Resolve the target** with `blueprint features graph --json`; the argument
  matches a feature `id` or `slug`.
- **Read only what the feature claims** — its `anchors`, plus their
  descendants. That scoping is the token argument this whole layer exists for.
- **Ask how to re-learn** rather than assuming: patch only the changed files,
  unless the drift backstop forces a full re-read (never fully read, ≥10
  accumulated patches, or ≥40% of referenced files changed — tunable via
  `feature_full_relearn_pct` / `feature_full_relearn_patches`).
- **Existing `flow/brain/modules/*.md` notes fold in**, they are not deleted:
  when learning a feature, cite the module notes its anchors cover rather than
  re-deriving them.
- **Un-referenced code** has no feature and therefore no `/learn` target. Use
  `blueprint coverage` to find it — that gap is computed, never stored.

---
