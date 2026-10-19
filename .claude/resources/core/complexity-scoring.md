
## Complexity Scale

| Score | Level     | Description                                | Examples                                                               |
| ----- | --------- | ------------------------------------------ | ---------------------------------------------------------------------- |
| 0-2   | Trivial   | Simple, mechanical changes                 | Adding a type alias, renaming a variable, adding an import             |
| 3-4   | Low       | Straightforward implementation             | Creating a simple Zod schema, adding a basic utility function          |
| 5-6   | Medium    | Moderate complexity, some decisions        | Creating a new component with logic hook, adding a store action        |
| 7-8   | High      | Complex implementation, multiple concerns  | API route with command pattern, complex state management               |
| 9-10  | Very High | Highly complex, requires careful attention | Streaming implementation, complex algorithms, multi-system integration |

---

## Scoring Criteria

Use these modifiers to calculate the complexity score for each phase:

### Positive Modifiers (Add Points)

| Modifier                             | Points |
| ------------------------------------ | ------ |
| Each new file to create              | +1     |
| External API integration             | +1     |
| Database operations                  | +1     |
| Complex state management             | +1     |
| View/logic separation pattern        | +1     |
| Streaming or real-time features      | +2     |
| Complex business logic or algorithms | +2     |
| Multi-system integration             | +2     |
| Authentication/authorization logic   | +1     |
| Error handling with recovery         | +1     |

### Negative Modifiers (Subtract Points)

| Modifier                             | Points |
| ------------------------------------ | ------ |
| Purely mechanical/repetitive tasks   | -1     |
| Small modifications to existing code | -1     |
| Following existing patterns exactly  | -1     |
| Copy/paste with minor changes        | -1     |

---

## Execution Strategy Based on Scores

| Total Adjacent Score | Execution Strategy                                                 |
| -------------------- | ------------------------------------------------------------------ |
| ≤ 6                  | **Aggregate**: Execute multiple phases together in one pass        |
| 7-10                 | **Cautious**: Execute 1-2 phases, then verify                      |
| > 10                 | **Sequential**: Execute one phase at a time with full verification |

---

## Aggregation Rules

1. **Can aggregate** phases when their combined complexity ≤ 6
2. **Never aggregate** across a phase with complexity ≥ 8
3. **Always execute separately**: Tests phase (regardless of score)
4. **Prefer aggregation** for trivial consecutive phases (0-2 each)

---

## Examples

### Example 1: Aggregatable Phases (Combined ≤ 6)

```markdown
### Phase 1: Types and Schemas

**Complexity**: 3/10

- [ ] Create WorkflowStep type
- [ ] Create Zod schema

### Phase 2: Utility Functions

**Complexity**: 2/10

- [ ] Create transformation helper

<!-- Combined complexity: 5 → Execute together -->
```

### Example 2: Must Execute Separately (Phase ≥ 8)

```markdown
### Phase 3: API Route with Streaming

**Complexity**: 9/10

- [ ] Create streaming endpoint
- [ ] Handle SSE events
- [ ] Implement error recovery

### Phase 4: UI Components

**Complexity**: 6/10

- [ ] Create component with view/logic separation
- [ ] Integrate with store

<!-- Phase 3 is ≥ 8, execute separately. Phase 4 starts fresh. -->
```

### Example 3: Sequential Execution (Total > 10)

```markdown
### Phase 1: Database Schema

**Complexity**: 5/10

### Phase 2: Backend API

**Complexity**: 7/10

### Phase 3: Frontend Components

**Complexity**: 6/10

<!-- Adjacent totals exceed 10, execute one at a time -->
```

---

## Phase Format with Complexity

Every phase in a plan must include a complexity score:

```markdown
### Phase 1: [Phase Name]

**Scope**: [What this phase covers]
**Complexity**: X/10

- [ ] Task 1
- [ ] Task 2

**Build Verification**: Run `npm run build`
```

---

## Scoring Guidelines

### When in Doubt, Score Higher

If uncertain about complexity, err on the side of a higher score. It's better to execute cautiously than to rush through a complex phase.

### Re-evaluate During Execution

If a phase turns out to be more complex than estimated:

1. Stop execution
2. Update the complexity score in the plan
3. Adjust execution strategy accordingly

### Common Complexity Patterns

| Task Type                       | Typical Score |
| ------------------------------- | ------------- |
| Type definitions only           | 2-3           |
| Simple utility function         | 2-3           |
| Zod schema creation             | 3-4           |
| Basic React component           | 4-5           |
| Component with view/logic split | 5-6           |
| Zustand store actions           | 4-5           |
| REST API route                  | 5-6           |
| API route with command pattern  | 6-7           |
| Database operations             | 5-7           |
| Streaming/SSE implementation    | 8-9           |
| Complex algorithm               | 7-9           |
| Multi-service integration       | 8-10          |
| Unit tests                      | 3-5           |
| Integration tests               | 5-6           |

---

## Real-World Scoring Examples

### Example A: Add a New Form Field

**Scenario**: Add an email field to the user registration form.

| Modifier | Points | Reason |
|----------|--------|--------|
| Modify existing component | -1 | Small modification |
| Following existing patterns | -1 | Other fields already exist |
| Add Zod validation | +1 | Schema update |
| **Total** | **2/10** | Trivial |

**Execution**: Can be aggregated with other trivial phases.

---

### Example B: Create User Dashboard API

**Scenario**: Create an API endpoint that fetches user data with analytics.

| Modifier | Points | Reason |
|----------|--------|--------|
| New file (route.ts) | +1 | Creating API route |
| Database operations | +1 | Fetch user data |
| External API integration | +1 | Analytics service |
| Error handling with recovery | +1 | Handle service failures |
| Complex business logic | +2 | Aggregate multiple data sources |
| **Total** | **6/10** | Medium |

**Execution**: Can be aggregated if adjacent phase is ≤ 0.

---

### Example C: Implement Real-time Chat Feature

**Scenario**: Add WebSocket-based chat with message persistence.

| Modifier | Points | Reason |
|----------|--------|--------|
| New files (3 files) | +3 | Route, hook, component |
| Streaming/real-time | +2 | WebSocket handling |
| Database operations | +1 | Message persistence |
| Complex state management | +1 | Chat state with optimistic updates |
| Multi-system integration | +2 | WebSocket + DB + Auth |
| **Total** | **9/10** | Very High |

**Execution**: Must execute separately. Never aggregate with other phases.

---

## Complexity vs Risk

Complexity and risk are **distinct signals** — do not conflate them:

- **Complexity (0–10)** is a **planning-time estimate**, scored per phase *before* execution (this file).
- **Risk (`low | medium | high`)** is a **post-execution judgment** over the *whole changeset* — assessed after all phases complete, informed by what actually happened (failed verifications, withheld repairs, escalations). See the Post-Execution Risk Assessment step (7b2) in `.claude/resources/skills/execute-plan-skill.md` and the shared risk definition in `.claude/resources/core/review-severity-ranking.md`.

A low-complexity plan can still land as a high-risk changeset (e.g., verification failures surfaced during execution), and a high-complexity plan can execute cleanly into a low-risk one. The two are shown **side by side** in the PR Pipeline section.
