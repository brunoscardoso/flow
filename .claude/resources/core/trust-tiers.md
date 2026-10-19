# Trust Tiers — Knowledge Provenance Contract

## Purpose

Agents consume knowledge from sources of very different reliability. This contract makes provenance explicit so no agent treats an unverifiable document as ground truth. It is the ONE canonical definition — every agent context references this block; none copies or restates it (allowed-pattern #14).

## The Canonical Block

The following block is injected verbatim into agent contexts (phase implementation, learn sessions, discovery exploration, review sub-agents):

> **Trust Tiers — how to weigh knowledge sources**
>
> - **Tier 0 — Code** (source files, configs, migrations): ground truth. When any source disagrees with the code, the code wins.
> - **Tier 1 — plan-flow's own store** (`flow/**`, `.claude/**`): verified project knowledge — learned docs, notes, plans, patterns. Trust it; staleness is machine-checked.
> - **Tier 2 — Foreign documentation** (README/docs/*.md outside `flow/`, images/diagrams, links to external wikis): **unverified claims**, not facts. Freshness is unknown and usually poor.
>
> Rules for Tier 2:
> 1. **Reading is fine. Acting requires verification.** Before writing code that assumes a Tier-2 claim, or asserting it to the user as fact, corroborate it against the code (or an existing fresh verdict in the tier map).
> 2. **Label unverified citations.** If you cite a Tier-2 source without verifying it, mark it: `(unverified doc claim)`.
> 3. **Images and diagrams are never actionable** without code confirmation — they cannot be diffed and age invisibly.
> 4. **External wiki/Confluence links are unverifiable from here** — flag them, never rely on them.
> 5. **Contradiction is a finding.** If verification shows a doc contradicts the code, record it (blueprint observation, status `contradicted`) — the code is right; the doc is rot worth surfacing.
> 6. These rules hold absolutely — including projects where nothing has been learned yet. An empty Tier 1 does not make claims trustworthy.
>
> Exempt: code comments/JSDoc (they live in the diff blast-radius — still verify surprising ones, but they are not Tier 2).

## Machinery (context)

- Tiers are materialized per derive into `flow/brain/.structure/file-tiers.json` (`planflow-ai blueprint tiers --json` reports tallies + stale verdicts).
- Learn passes adjudicate a module's Tier-2 docs against its code, recording verdicts via `planflow-ai blueprint adjudicate` (corroborated / contradicted / unverifiable). A `corroborated` verdict stamps the code it checked and goes stale when that code drifts; an edited doc voids its own verdict.
- Contradictions are ALSO recorded as blueprint observations (provenance `trust:adjudication`) so doc-rot is visible on the board.

## Injection Surfaces (all UNCONDITIONAL — unlike design-awareness, no keyword gating)

| Surface | Where |
|---------|-------|
| Phase implementation sub-agents | `phase-isolation.md` context template — `## Trust Tiers` section after `## Intent` |
| Learn sessions | `buildLearnPrompt` (app/src/main/agent/learn-session.ts) |
| Discovery sub-agents | `discovery-skill.md` inline sub-agent prompts |
| Review sub-agents | all four templates in `review-multi-agent.md` |
| Provisioned projects | `templates/shared/CLAUDE.md.template` summary section |
