
# Brain Patterns

## Brain Directory Structure

```
flow/brain/                            # Per-project brain
├── index.md                           # L1 cache - always loaded; GENERATED (`planflow-ai brain index`)
├── patterns-index.md                  # Matched global patterns (GLB-* codes)
├── features/                          # Feature history and context
│   └── {feature-name}.md
├── errors/                            # Reusable error patterns
│   └── {error-name}.md
└── learning/                          # Teaching curricula from /learn about
    └── {topic-kebab}.md

~/plan-flow/brain/notes/               # Notes (cross-project)
└── {YYYY-MM-DD}.md
```

---

## File Naming Conventions

| File Type | Pattern | Example | Wiki-Link |
|-----------|---------|---------|-----------|
| Feature | `features/{kebab-case}.md` | `features/contact-enrichment.md` | `[[contact-enrichment]]` |
| Error | `errors/{kebab-case}.md` | `errors/prisma-connection-pooling.md` | `[[prisma-connection-pooling]]` |
| Notes | `~/plan-flow/brain/notes/{YYYY-MM-DD}.md` | `notes/2026-03-03.md` | `[[2026-03-03]]` |

**Rules**:
- Always use kebab-case for file names
- File name must match the `[[wiki-link]]` reference exactly (without path)
- Derive feature names from discovery/plan file names: `discovery_contact_enrichment_v1.md` → `contact-enrichment`
- Derive error names from the error description: "Prisma connection pooling timeout" → `prisma-connection-pooling`

---

## Wiki-Link Patterns

### Linking to Brain Files

```markdown
Feature: [[contact-enrichment]]
Error: [[prisma-connection-pooling]]
Session: [[2026-03-03]]
```

### Linking to Plan-Flow Artifacts

```markdown
Discovery: [[discovery_contact_enrichment_v1]]
Plan: [[plan_contact_enrichment_v1]]
Review: [[review_contact_enrichment]]
Contract: [[api_contract]]
```

### Linking to Technologies

```markdown
Stack: [[TypeScript]], [[Next.js]], [[Prisma]]
```

---

## Brain-Capture Block per Skill

### /setup

```html
<!-- brain-capture
skill: setup
feature: project-initialization
phase: na
status: completed
errors: []
decisions: []
files_changed: [".claude/rules/core/allowed-patterns.md"]
user_prompts: ["/setup"]
artifacts: ["flow/references/project-analysis.md"]
-->
```

### /discovery-plan

```html
<!-- brain-capture
skill: discovery-plan
feature: {feature-name}
phase: na
status: completed
errors: []
decisions: []
files_changed: []
user_prompts: ["{original user prompt}"]
artifacts: ["flow/discovery/discovery_{feature}_v1.md"]
-->
```

### /create-plan

```html
<!-- brain-capture
skill: create-plan
feature: {feature-name}
phase: na
status: completed
errors: []
decisions: ["{key planning decisions}"]
files_changed: []
user_prompts: ["{original user prompt}"]
artifacts: ["flow/plans/plan_{feature}_v1.md"]
-->
```

### /execute-plan

```html
<!-- brain-capture
skill: execute-plan
feature: {feature-name}
phase: {phase-number}
status: {completed|in-progress|failed}
errors: ["{error description - resolution}"]
decisions: ["{implementation decisions}"]
files_changed: ["{list of files modified}"]
user_prompts: ["{user corrections or inputs during execution}"]
artifacts: ["flow/plans/plan_{feature}_v1.md"]
-->
```

### /review-code

```html
<!-- brain-capture
skill: review-code
feature: {scope}
phase: na
status: completed
errors: []
decisions: []
files_changed: []
user_prompts: ["/review-code"]
artifacts: ["flow/reviewed-code/review_{scope}.md"]
-->
```

### /review-pr

```html
<!-- brain-capture
skill: review-pr
feature: pr-{number}
phase: na
status: completed
errors: []
decisions: []
files_changed: []
user_prompts: ["/review-pr {number}"]
artifacts: ["flow/reviewed-pr/pr_{number}.md"]
-->
```

### /write-tests

```html
<!-- brain-capture
skill: write-tests
feature: {scope}
phase: na
status: completed
errors: ["{test failures and fixes}"]
decisions: []
files_changed: ["{test files created/modified}"]
user_prompts: ["/write-tests {coverage}"]
artifacts: []
-->
```

### /create-contract

```html
<!-- brain-capture
skill: create-contract
feature: {service-name}
phase: na
status: completed
errors: []
decisions: []
files_changed: []
user_prompts: ["/create-contract {url}"]
artifacts: ["flow/contracts/{service}_contract.md"]
-->
```

---

## Feature Status Lifecycle

```
active → completed → (archived)
active → discarded (with reason)
```

| Status | Meaning | In Index |
|--------|---------|----------|
| `active` | Currently being worked on | Full entry with progress |
| `completed` | Feature shipped | One-liner summary |
| `discarded` | Abandoned (with reason WHY) | One-liner with reason |

When a feature status changes to `discarded`, always include the reason:

```markdown
**Status**: discarded
**Reason**: Team decided OAuth was overkill for MVP - will revisit in Q3
```

---

## Index Update Rules

`flow/brain/index.md` is **generated** — never edit it by hand. Change the notes, then run `planflow-ai brain index`:

- **Adding or completing a feature**: set `status:` (and `description:` for the one-line summary) in the note's frontmatter. `active` / `in-progress` notes are listed as active; any other status is listed struck through (at most 10). A note with no `status:` counts as active while a plan or discovery of the same name is live, archived when only an archived one exists, and is otherwise listed under Capabilities.
- **Adding an error**: write the note in `errors/`; the newest 5 are listed.
- **Adding a decision**: write the note in `decisions/`; the newest 3 are listed.
- Any other `## ` section of the index (e.g. `## Global Patterns`, `## Global Learns`) is carried over unchanged by the rebuild.

