
# Model Routing

## Purpose

Automatic model selection at phase boundaries during `/execute-plan`. Each phase is routed to the most cost-effective model tier based on its complexity score, using the Agent tool's `model` parameter to spawn implementation subagents.

**Scope**: `/execute-plan` only. Other skills (discovery, review, brainstorm) do not have pre-defined complexity scores and are not routed.

**Config**: Controlled by `model_routing` key in `flow/.flowconfig` (default: `true`). Set `model_routing: false` to run every phase on the most capable model.

**Why it defaults on.** Measured over 257 real phases in this repo’s own plans: 10% score 0-3, 38% score 4-5, and 52% score 6-10. So routing leaves the hard half of the work on the most capable model and stops paying it for the mechanical half — type aliases, config edits, boilerplate wiring. Complexity is the planner’s pre-execution estimate, so a phase that turns out harder than it scored is the known exposure; a per-phase `model` override in the run artifact is the escape hatch.

---

## Model Tiers

| Tier | Complexity Score | Description | When to Use |
|------|-----------------|-------------|-------------|
| **Fast** | 0-3 | Trivial/low tasks: type aliases, config changes, boilerplate, simple wiring | Mechanical changes following clear patterns |
| **Standard** | 4-5 | Medium tasks: moderate logic, straightforward implementation with some decisions | Standard implementation work |
| **Powerful** | 6-10 | High/complex tasks: multi-file coordination, architectural decisions, complex logic | Tasks requiring deep reasoning or careful design |

---

## Platform Mappings

Always use the **latest and most capable model**. Model names below are examples — always prefer the most recent version available at runtime. (Claude is the only provider today; other models may return later via a model router.)

| Tier | Claude Code |
|------|------------|
| Fast | `haiku` |
| Standard | `sonnet` |
| Powerful | `opus` |

**Model when routing is OFF**: Always use the most capable/recent Claude model (e.g., `opus`). This needs an explicit `model_routing: false`.

**Fallback rule**: If a platform doesn't support a tier, fall back to the next tier up (e.g., if no haiku equivalent, use Standard).

---

## Routing Rules

### At Each Phase Boundary

1. **Check config**: Read `model_routing` from `flow/.flowconfig`. Only an explicit `false` skips routing (then use the most capable session model); an absent or unset key routes, because the default is `true`.
2. **Read complexity**: Get the phase's complexity score from the plan file.
3. **Look up tier**: Map score to tier using the table above.
4. **Spawn subagent**: Use the Agent tool with `model={tier_model}` to implement the phase.

**Compiled run script**: per-phase models are baked into the artifact at compile time — `planflow-ai plan compile <plan>` writes each phase's resolved model to `phases[].model` (tier map in `routing`) in `flow/plans/<name>.run.json`, and preserved per-phase `model` overrides are already applied there. The CLI always applies complexity routing when compiling; the skill applies the `model_routing` config when reading the artifact — with an explicit `model_routing: false`, `/execute-plan` disregards the baked per-phase models and uses the most capable model for every phase.

### Agent Tool Usage

```
Agent tool call:
  model: "haiku"  |  "sonnet"  |  "opus"
  prompt: [comprehensive phase context — see below]
```

**Required context in Agent prompt**:
- Plan file path and current phase details (scope, tasks, approach)
- List of files modified in previous phases
- Key project patterns and constraints
- Reference to allowed/forbidden patterns

### Plan Mode Exception

The **planning step** (Phase presentation → user approval) always uses the current session model. Only the **implementation step** gets routed to the tier model. Planning is lightweight and benefits from the session model's full context.

---

## Aggregation Behavior

When multiple phases are aggregated (combined complexity <= 6):

- Use the **highest individual phase complexity** to determine the model tier
- Example: Phase 1 (complexity 2) + Phase 2 (complexity 3) aggregated → highest is 3 → Fast tier (haiku)
- Example: Phase 3 (complexity 3) + Phase 4 (complexity 5) aggregated → highest is 5 → Standard tier (sonnet)

**Rationale**: The aggregated group is only as easy as its hardest phase. Routing to a weaker model than the hardest phase could cause failures.

---

## Cost Impact

Assuming a typical 6-phase plan with mixed complexity:

Pricing is $ per million tokens (input/output), current generation:

| Phase Type | Count | Without Routing | With Routing | Savings |
|-----------|-------|----------------|--------------|---------|
| Trivial (0-3) | 2 | opus ($4/$20) | haiku ($0.10/$0.50) | ~97% |
| Medium (4-5) | 2 | opus ($4/$20) | sonnet ($2/$10) | ~50% |
| Complex (6+) | 2 | opus ($4/$20) | opus ($4/$20) | 0% |

**Estimated overall cost reduction**: ~45-50% per plan execution.

---

## Execution Summary Format

After all phases complete, include model routing info in the completion summary:

```markdown
| Phase | Complexity | Model | Status |
|-------|-----------|-------|--------|
| 1. Setup types | 2/10 | haiku | Done |
| 2. Core logic | 5/10 | sonnet | Done |
| 3. Integration | 7/10 | opus | Done |
| 4. Tests | 4/10 | sonnet | Done |

**Model routing**: Saved ~50% vs all-opus execution
```

---

## Related Files

| File | Purpose |
|------|---------|
| `.claude/resources/core/complexity-scoring.md` | Scoring system that drives routing |
| `.claude/resources/skills/execute-plan-skill.md` | Phase execution workflow with routing injection |
| `.claude/commands/execute-plan.md` | Command-level routing documentation |
| `.claude/commands/flow.md` | `model_routing` config setting |
| `flow/.flowconfig` | Runtime config with `model_routing` key |
