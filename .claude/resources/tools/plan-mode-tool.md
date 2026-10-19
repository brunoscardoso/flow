# Plan Mode for Claude Code

## Purpose

Claude Code has a native plan mode that enables collaborative planning before implementation. This tool provides guidance on using plan mode effectively for structured development workflows.

## When to Use Plan Mode

### Use the `EnterPlanMode` Tool For:

1. **Implementation Tasks**: Before implementing features that require architectural decisions
2. **High Complexity Tasks**: Before tasks with complexity score >= 7
3. **Multi-File Changes**: When changes will affect multiple files
4. **New Features**: When adding new functionality that requires planning
5. **Critical Decisions**: Before making architectural or design decisions

### Don't Use Plan Mode For:

1. **Simple Fixes**: Single-line changes, typos, obvious bugs
2. **Read-Only Operations**: Reading files, searching codebase
3. **Information Gathering**: Discovery, analysis, documentation
4. **Trivial Tasks**: Tasks with complexity <= 2

---

## How to Use Plan Mode in Claude Code

### Entering Plan Mode

Use the `EnterPlanMode` tool when you need to plan before implementing:

```typescript
// When starting a non-trivial implementation task
EnterPlanMode()
```

Claude Code will then allow you to:
1. Explore the codebase using Glob, Grep, and Read tools
2. Design an implementation approach
3. Present your plan to the user for approval
4. Exit plan mode with `ExitPlanMode` when ready to implement

### Plan Mode Workflow

1. **Enter Plan Mode**: Call `EnterPlanMode` for implementation tasks
2. **Explore**: Use read-only tools to understand the codebase
3. **Design**: Create a structured implementation plan
4. **Present**: Show the plan to the user
5. **Clarify**: Use `AskUserQuestion` if you need decisions
6. **Exit**: Call `ExitPlanMode` when the plan is ready for implementation

---

## Phase Execution Pattern

When executing implementation plan phases, follow this pattern:

### Step 1: Present Phase Details

Before implementing each phase, present the details:

```markdown
## Implementing Phase X: [Phase Name]

**Complexity**: X/10
**Scope**: [Phase scope description]

### Tasks to Complete:
- [ ] Task 1
- [ ] Task 2
- [ ] Task 3

### Implementation Approach:
[Describe the approach, patterns to follow, and any decisions needed]

### Patterns to Follow:
- [Pattern 1 from project rules]
- [Pattern 2 from project rules]

**Proceeding with implementation...**
```

### Step 2: Implement

Proceed with implementation following the discussed approach.

### Step 3: Update Progress

Mark completed tasks in the plan file after completing the phase.

---

## Integration with Execute Plan Command

When executing a plan created by `/create-plan`:

1. **Read the plan file** to understand phases and complexity scores
2. **For each phase**:
   - Present phase details and approach
   - Implement the phase following project patterns
   - Update the plan file to mark tasks complete
3. **Run verification** only at the very end (not between phases)

---

## Complexity-Based Execution Strategy

Based on complexity scores from the plan:

| Combined Score | Strategy |
|---------------|----------|
| <= 6 | **Aggregate**: Execute multiple phases together |
| 7-10 | **Cautious**: Execute 1-2 phases, then verify |
| > 10 | **Sequential**: Execute one phase at a time |

---

## Presenting Plans for Approval

When presenting a plan for user approval:

```markdown
## Implementation Plan: [Feature Name]

### Phase Overview

| Phase | Name | Complexity | Description |
|-------|------|------------|-------------|
| 1 | Types and Schemas | 3/10 | Define TypeScript types and Zod schemas |
| 2 | API Implementation | 6/10 | Create API routes with validation |
| 3 | UI Components | 5/10 | Build React components |
| 4 | Tests | 4/10 | Write comprehensive tests |

### Execution Strategy

Phases 1-2 will be executed together (combined complexity: 9)
Phase 3 will be executed separately
Phase 4 (Tests) always executed separately

### Key Decisions

1. [Decision 1 and reasoning]
2. [Decision 2 and reasoning]

**Ready to proceed?**
```

---

## Benefits of Plan Mode

1. **Collaborative Design**: Discuss approach before implementation
2. **Risk Mitigation**: Catch issues early in planning
3. **User Control**: Approve approach before changes are made
4. **Better Decisions**: Time to consider alternatives and trade-offs
5. **Documentation**: Planning discussions serve as decision records

---

## Related Rules

- Plan patterns: `.claude/resources/patterns/plans-patterns.md`
- Complexity scoring: `.claude/resources/core/complexity-scoring.md`
- Execute plan skill: `.claude/skills/execute-plan/SKILL.md`
