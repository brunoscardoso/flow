
## Discovery Document Template

Use this template when creating discovery documents:

**Authorship (frontmatter)**: `author` is the name from `git config user.name` (name only — never the email); `decided_by` is the person who answered the questions. When `git config user.name` is empty, leave the frontmatter out rather than inventing a name.

```markdown
---
author: {git config user.name}
decided_by: {git config user.name of the person who answered the questions}
---

# Discovery: [Feature/Topic Name]

**Project**: [[{project-name}]]

## Context

[Why this discovery is needed. What triggered it? What problem are we solving?]

## Referenced Documents

[List documents reviewed - use @mentions or file paths]

| Document                               | Key Findings                  |
| -------------------------------------- | ----------------------------- |
| `flow/references/api-contracts.md` | [Summary of relevant content] |
| `flow/references/sse-events.md`    | [Summary of relevant content] |

## Code Context Analysis

[Analysis of all code locations related to this feature]

### Components Found

| File | Usage | Line(s) |
|------|-------|---------|
| `[file_path]` | [How it's used] | [line references] |

### API Endpoints Found

| File | Endpoint | Method |
|------|----------|--------|
| `[file_path]` | `[endpoint]` | [GET/POST/PUT/DELETE] |

### State Management Found

| File | Purpose |
|------|---------|
| `[file_path]` | [Store/state description] |

### Type Definitions Found

| File | Types |
|------|-------|
| `[file_path]` | [Type names] |

### Other Related Files

| File | Purpose |
|------|---------|
| `[file_path]` | [Description] |

**Total References**: [count] files across [count] categories

### Key Patterns Observed

- [Pattern 1 observed in existing code]
- [Pattern 2 observed in existing code]

### Related projects in this Workspace

[Which sibling projects of the Workspace this feature touches, and how — e.g. "`orbit-app` calls the new endpoint from its Orders screen". Name each touchpoint as `<project>/<feature-or-file>`. Omit this subsection when the project is in no Workspace.]

## Requirements Gathered

### Functional Requirements

- [FR-1]: [Description]
- [FR-2]: [Description]

### Non-Functional Requirements

- [NFR-1]: [Description]

### Constraints

- [C-1]: [Description]

## Open Questions

| #   | Question   | Status | Answer |
| --- | ---------- | ------ | ------ |
| 1   | [Question] | Open   | -      |
| 2   | [Question] | Open   | -      |

## Technical Considerations

### Architecture

[How this fits into existing system]

### Dependencies

[What this relies on]

### Patterns to Follow

[Relevant patterns from project rules]

### Potential Challenges

[Identified difficulties]

## Design Context

> Include this section only when UI work is confirmed during discovery.

### Design Personality
{personality name} — {brief description of the visual style}

### Color Palette
| Token | Value | Usage |
|-------|-------|-------|
| Primary | #XXXXXX | Main actions, CTAs |
| Secondary | #XXXXXX | Supporting elements |
| Background | #XXXXXX | Page/card backgrounds |
| Surface | #XXXXXX | Elevated surfaces |
| Text Primary | #XXXXXX | Main body text |
| Text Secondary | #XXXXXX | Secondary/muted text |
| Error | #XXXXXX | Error states |
| Success | #XXXXXX | Success states |

### Typography
| Element | Font | Size | Weight |
|---------|------|------|--------|
| Heading 1 | {font} | {size} | {weight} |
| Heading 2 | {font} | {size} | {weight} |
| Body | {font} | {size} | {weight} |
| Caption | {font} | {size} | {weight} |

### Spacing Scale
| Token | Value |
|-------|-------|
| xs | {value} |
| sm | {value} |
| md | {value} |
| lg | {value} |
| xl | {value} |

### Component Patterns
- {Pattern 1}: {description}
- {Pattern 2}: {description}

### Design Source
- **Source**: {screenshots / Figma export / design personality / existing system.md}
- **Files**: {list of provided design files, if any}

## Proposed Approach

[High-level approach recommendation based on findings]

## Risks and Unknowns

### Risks

| Risk   | Impact          | Mitigation   |
| ------ | --------------- | ------------ |
| [Risk] | High/Medium/Low | [Mitigation] |

### Unknowns

- [ ] [Unknown that needs investigation]

## Next Steps

- [ ] Resolve open questions
- [ ] Create implementation plan: `flow/plans/plan_<feature>_v1.md`
- [ ] [Other follow-ups]

## Story

> Draft concept arc (discovery skill Step 6c). Always the LAST section.
```

> **Section order is load-bearing.** The template's `## Design Context` block
> shows the section's shape; in a finished document it moves down to sit just
> above the story. Nothing follows `## Story` — its grammar reads to the next
> level-2 heading, and `/discovery-plan` verifies the story is last.

---

## User Walkthrough Page (the Artifact)

A discovery does **not** write its user walkthrough page. The page — what Flow
calls the discovery's **artifact** — is a separate, self-contained HTML file
beside the document, with the same basename and `.walkthrough.html` in place of
`.md` (`discovery_<feature>_v<N>.walkthrough.html`), written on request from the
DISCOVERY card's **Generate artifact** button or with `/artifact`. Structure,
rules and verification: `.claude/resources/skills/artifact-skill.md`.

---

## Spike Template

Use this template for technical investigation spikes:

```markdown
# Spike: [Technical Topic]

## Objective

[What we're trying to learn or prove]

## Time Box

[Maximum time allocated for this spike: e.g., 2 hours, 1 day]

## Hypothesis

[What we expect to find or prove]

## Investigation

### Approach 1: [Name]

**Description**: [What was tried]

**Results**: [What was found]

**Pros**:

- [Pro 1]
- [Pro 2]

**Cons**:

- [Con 1]
- [Con 2]

### Approach 2: [Name]

[Same structure as Approach 1]

## Findings

### Key Learnings

1. [Learning 1]
2. [Learning 2]

### Performance Results

[If applicable: benchmarks, metrics]

### Code Samples

[If applicable: minimal code examples that demonstrate findings]

## Recommendation

[Which approach to use and why]

## Next Steps

- [ ] Document findings in discovery or plan
- [ ] [Other follow-ups]
```

---

## Question Format Examples

### Functional Requirements Questions

```markdown
Questions

1. Should workflow steps be editable after creation?
   A Yes, users can edit title and content at any time
   B Yes, but only before the workflow is published
   C No, steps are immutable once created

2. What is the maximum number of steps per workflow?
   A 10 steps
   B 20 steps
   C Unlimited
   D Other (please specify)
```

### Technical Questions

```markdown
Questions

1. Which real-time update mechanism should we use?
   A SSE (Server-Sent Events) - simpler, one-way
   B WebSocket - full duplex, more complex
   C Polling - simple but less efficient

2. Should we use optimistic updates for better UX?
   A Yes, with rollback on failure
   B No, wait for server confirmation
```

### UI/UX Questions

```markdown
Questions

1. Where should this feature live in the UI?
   A New dedicated page
   B Sidebar panel
   C Modal dialog
   D Inline in existing page

2. What loading state should we show?
   A Skeleton loader
   B Spinner
   C Progress bar
```

---

## Referenced Documents Analysis Example

```markdown
## Referenced Documents Analysis

I've reviewed the following documents:

### API Contract (`flow/references/api-contracts.md`)

- Endpoint: POST /api/agents/{agentId}/workflow
- Request schema: WorkflowStepInput[]
- Response: WorkflowStep[]
- Authentication: Bearer token required

### SSE Events (`flow/references/sse-events.md`)

- Event types: plan_start, plan_step, plan_complete
- Payload structure: { stepId, status, content }

## Questions Based on Documents

1. The API contract shows `WorkflowStepInput` but doesn't define the `condition` field. Is this optional?
2. SSE events mention `plan_step` but not error handling. What happens on failure?
```

---

## Requirements Gathering Example

```markdown
## Requirements Gathered

### From API Contract (`flow/references/api-contracts.md`)

**Functional Requirements**:

- [FR-1]: Create workflow steps via POST /api/agents/{agentId}/workflow
- [FR-2]: Each step must have title, content, and sequence
- [FR-3]: Steps can have optional connectors and actions

**Non-Functional Requirements**:

- [NFR-1]: API response time < 500ms
- [NFR-2]: Support concurrent editing (optimistic updates)

**Constraints**:

- [C-1]: Maximum 20 steps per workflow
- [C-2]: Must use existing authentication flow

### From SSE Events (`flow/references/sse-events.md`)

**Functional Requirements**:

- [FR-4]: Real-time updates via SSE events
- [FR-5]: Events include: plan_start, plan_step, plan_complete

**Non-Functional Requirements**:

- [NFR-3]: SSE connection must auto-reconnect on failure
```

---

## Risks and Unknowns Example

```markdown
## Risks and Unknowns

### Technical Risks

| Risk                       | Impact | Mitigation                                            |
| -------------------------- | ------ | ----------------------------------------------------- |
| SSE connection instability | High   | Implement reconnection with exponential backoff       |
| State sync issues          | Medium | Use server as source of truth, reconcile on reconnect |

### Requirements Risks

| Risk                        | Impact | Mitigation                        |
| --------------------------- | ------ | --------------------------------- |
| Scope creep on step editing | Medium | Define MVP scope clearly in plan  |
| Unclear error handling      | High   | Clarify with user before planning |

### Unknowns (Need Investigation)

- [ ] Backend pagination support for large workflows
- [ ] Mobile responsiveness requirements
- [ ] Accessibility requirements for drag-and-drop
```

---

## Code Context Analysis Example

```markdown
## Code Context Analysis

I performed a comprehensive search for all code related to "user profile" functionality:

### Components Found

| File | Usage | Line(s) |
|------|-------|---------|
| `src/components/UserProfile/index.tsx` | Main profile display component | - |
| `src/components/UserProfile/EditForm.tsx` | Profile editing form | - |
| `src/components/Settings/ProfileSettings.tsx` | Settings page integration | - |
| `src/components/Dashboard/UserCard.tsx` | Dashboard summary card | 45-78 |
| `src/components/Navigation/UserMenu.tsx` | Navigation menu with profile link | 23-35 |

### API Endpoints Found

| File | Endpoint | Method |
|------|----------|--------|
| `src/app/api/user/profile/route.ts` | `/api/user/profile` | GET, PUT |
| `src/app/api/user/avatar/route.ts` | `/api/user/avatar` | POST |
| `src/app/api/user/settings/route.ts` | `/api/user/settings` | GET, PATCH |

### State Management Found

| File | Purpose |
|------|---------|
| `src/stores/userStore.ts` | User profile state with actions |
| `src/stores/authStore.ts` | Includes user profile data from auth |

### Type Definitions Found

| File | Types |
|------|-------|
| `src/types/user.ts` | `User`, `UserProfile`, `UpdateProfileInput` |
| `src/types/rest-inputs.ts` | `UpdateProfileRequestSchema` (Zod) |

### Other Related Files

| File | Purpose |
|------|---------|
| `src/utils/userValidation.ts` | Profile data validation utilities |
| `src/hooks/useUserProfile.ts` | Custom hook for profile management |

**Total References**: 12 files across 5 categories

### Key Patterns Observed

- **View/Logic Separation**: Components use separate logic hooks (e.g., `useUserProfileLogic.internal.ts`)
- **Zod Validation**: All API inputs validated with Zod schemas in `types/rest-inputs.ts`
- **State Management**: Using Zustand stores with immer for immutable updates
- **Error Handling**: Consistent use of custom error types (`BadRequestError`, `UnauthorizedError`)
- **Testing**: Each component has co-located `*.client.test.ts` file
```

---

## Proposed Approach Example

```markdown
## Proposed Approach

Based on the requirements gathered, the recommended approach is:

1. **Extend existing agent section**: Build on `AgentPlanSection` rather than creating new component
2. **Use SSE for real-time updates**: Leverage existing streaming infrastructure
3. **Implement optimistic updates**: Better UX with immediate feedback
4. **Follow view/logic separation**: As per codebase patterns

### Approach Alternatives Considered

| Approach  | Pros                   | Cons                       | Recommendation  |
| --------- | ---------------------- | -------------------------- | --------------- |
| WebSocket | Full duplex            | Overkill for this use case | Not recommended |
| SSE       | Simple, existing infra | One-way only               | Recommended     |
| Polling   | Simple                 | Poor UX, wasteful          | Not recommended |
```
