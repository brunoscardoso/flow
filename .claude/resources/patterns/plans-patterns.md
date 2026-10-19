
## Workflow Folder Structure

```
flow/
├── archive/      # IGNORE - Completed/abandoned plans
├── discovery/    # Research, spikes, and exploration
├── plans/        # Active implementation plans
└── references/   # Reference materials (API contracts, specs, designs)
```

| Folder              | Purpose                                    | When to Use                  |
| ------------------- | ------------------------------------------ | ---------------------------- |
| `flow/plans/`       | Active implementation plans                | Creating new feature plans   |
| `flow/discovery/`   | Research, spikes, exploration documents    | Investigating before planning|
| `flow/references/`  | Reference materials (API contracts, specs) | Storing documentation        |
| `flow/archive/`     | Completed or abandoned plans               | After plan completion        |

---

## Critical Rule: Ignore Archived Plans

**NEVER consider or reference files inside the `flow/archive/` folder.** These are outdated, superseded, or abandoned plans that should not influence current development.

---

## Allowed Patterns

### 1. Store Plans with Snake Case Naming

All implementation plans must be created inside `flow/plans/` using snake_case naming with incremental versioning.

**Naming Convention**: `plan_<feature_name>_v<version>.md`

---

### 2. Discovery is Required Before Planning

A discovery document in `flow/discovery/` is **required** before creating any plan. Plans cannot be created without a completed discovery document. If no discovery exists, run `/discovery-plan` first. No exceptions. See `.claude/resources/patterns/discovery-patterns.md` for details.

---

### 3. Create Markdown Files with Required Sections

Every plan must include:

- **Overview**: Brief description
- **Goals**: Main objectives
- **Phases**: Implementation steps with complexity scores, each with a `#### Change notes` block (notes for the main changes only — 3–8 per plan, never more than 10 — see `plans-templates.md`, Change Notes)
- **Key Changes**: Summary of modifications

Plans do not carry a `## Story` section — the change notes are the plan's review.

See `.claude/resources/patterns/plans-templates.md` for the full template.

---

### 4. Include Key Changes Summary

Every plan must end with a "Key Changes" section summarizing the most important modifications.

---

### 5. Follow All Project Rules During Execution

On every execution of each phase, ensure compliance with all project rules:

- `.claude/rules/core/allowed-patterns.md` - Follow allowed patterns
- `.claude/rules/core/forbidden-patterns.md` - Avoid forbidden patterns

---

### 6. Structure Plans with Scoped Phases

Every plan must be divided into implementation phases with clear scope boundaries:

- **Scope**: What this phase covers
- **Complexity**: Score from 0-10
- **Dependencies**: (Optional) Which phases must complete first
- **Tasks**: Checkboxes for tracking
- **Build Verification**: Command to verify

---

### 7. Tests Must Be the Last Phase

Always schedule testing as the final phase of implementation. Tests validate complete implementation and avoid rewriting during development.

---

### 8. Verify Build Success After Each Phase

At the end of each phase, run `npm run build` to ensure no build errors.

---

### 9. Minimize Code in Plan Documents

Plans should describe what to implement, not how to code it. Only include code when it serves as an important reference example. Change notes are words: a `where:` quote of TODAY's code marks the place, but a note never carries the code of the change.

---

### 10. Move Completed Plans to Archive

When a plan is fully implemented or no longer relevant:

```bash
mv flow/plans/plan_feature_name_v1.md flow/archive/
```

---

### 11. Assign Complexity Scores to Each Phase

Every phase must include a **Complexity Score** from 0-10.

See `.claude/resources/core/complexity-scoring.md` for the complete scoring system.

---

### 12. Execute Phases Using Plan Mode

When executing a plan, each phase must trigger **Plan mode** before implementation:

1. Use the [Plan Mode Tool](.claude/resources/tools/plan-mode-tool.md) to switch to Plan mode automatically
2. Present phase details and approach
3. Get user approval
4. Implement
5. Verify build
6. Update progress in plan file

**Reference**: See `.claude/resources/tools/plan-mode-tool.md` for complete instructions on switching to Plan mode.

---

### 13. Declare Phase Dependencies for Parallel Execution

Phases may include an optional `**Dependencies**` field to declare which prior phases must complete before execution can begin. This enables wave-based parallel execution where independent phases run simultaneously.

**Syntax**:

- `**Dependencies**: None` — No dependencies; can run in the first wave
- `**Dependencies**: Phase 1, Phase 3` — Depends on specific phases completing first
- **Omitting the field** — Defaults to depending on the immediately previous phase (sequential)

**Rules**:

1. Mark phases as `Dependencies: None` when they have no data or code dependency on other phases
2. When two or more phases share the same dependency set, they form a wave and can execute in parallel
3. The Tests phase always depends on ALL prior phases — never mark it as `Dependencies: None`
4. Dependencies must only reference phases with lower numbers (no forward or circular dependencies)
5. When uncertain whether phases are independent, default to sequential (omit the field)
6. The dependency declaration is metadata for the execution engine — it does not change the phase content

**Example** — independent phases forming a parallel wave:

```markdown
### Phase 1: Types and Schemas
**Dependencies**: None

### Phase 2: API Routes
**Dependencies**: Phase 1

### Phase 3: CLI Commands
**Dependencies**: Phase 1

### Phase 4: Integration
**Dependencies**: Phase 2, Phase 3

### Phase 5: Tests (Final)
**Dependencies**: Phase 1, Phase 2, Phase 3, Phase 4
```

Phases 2 and 3 can run in parallel (Wave 2). Phase 4 waits for both. Phase 5 waits for all.

---

## Forbidden Patterns

### 1. DON'T Read or Reference Archived Plans

Only reference active plans in the `flow/plans/` folder.

---

### 2. DON'T Create Plans Outside the Workflow Folder

Always create plans in the `flow/plans/` folder with proper naming.

---

### 3. DON'T Use Inconsistent Naming

Use the pattern `plan_<feature_name>_v<version>.md`.

---

### 4. DON'T Skip the Key Changes Section

Always include a "Key Changes" section at the end of the plan.

---

### 5. DON'T Ignore Project Rules During Implementation

Review and follow all project rules during each phase.

---

### 6. DON'T Create Monolithic Plans Without Phases

Break down plans into logical, scoped phases.

---

### 7. DON'T Write Tests Before Implementation

Tests should always be the last phase.

---

### 8. DON'T Skip Build Verification

Add `npm run build` verification at the end of each phase.

---

### 9. DON'T Include Full Implementation Code in Plans

Describe what to implement; let the actual code live in source files.

---

### 10. DON'T Skip Complexity Scores

Always include a complexity score for each phase.

---

### 11. DON'T Assign Arbitrary Complexity Scores

Use the scoring criteria consistently. When in doubt, score higher.

---

### 12. DON'T Execute Phases Without Plan Mode

Always switch to Plan mode before executing each phase group. Use the [Plan Mode Tool](.claude/resources/tools/plan-mode-tool.md) to ensure proper switching.

---

### 13. DON'T Mix Discovery and Plans

Keep discovery documents in `flow/discovery/` and plans in `flow/plans/`.

---

### 14. DON'T Mark the Tests Phase as Independent

The Tests phase must always depend on ALL prior phases. Never assign `Dependencies: None` to the Tests phase.

---

### 15. DON'T Create Circular or Forward Dependencies

Dependencies must only reference phases with lower numbers. A phase cannot depend on itself or on any phase that comes after it.

---

## Summary

Following these planning patterns ensures:

- **Discoverability**: All plans in `flow/plans/`, research in `flow/discovery/`
- **Traceability**: Version history and key changes documentation
- **Quality**: Project rules compliance verified at each phase
- **Reliability**: Build verification prevents accumulation of errors
- **Maintainability**: Scoped phases enable incremental, trackable progress
- **Testability**: Tests as the final phase ensure complete coverage
- **Clarity**: Archived plans are ignored, only active plans are referenced
- **Intelligent Pacing**: Complexity scores guide execution strategy
- **Collaborative Execution**: Plan mode ensures user approval before each phase
- **Parallel Execution**: Dependency declarations enable wave-based parallel phase execution
