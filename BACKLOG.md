# Feature Backlog — Reverted from main (2026-03-05)

> **Context**: `main` was reset to match `development` at commit `6bc9090` (add /learn command). All features below were previously on `main` and need to be re-introduced carefully. Some features caused Cursor to stop writing output files to `flow/` — those are marked with ⚠️.
>
> **Reference branch**: The old `main` state before reset can be found at commit `07faf2d`.

---

## Priority Legend

| Priority | Meaning |
|----------|---------|
| P0 | Critical — needed for core functionality |
| P1 | Important — significant value but not blocking |
| P2 | Nice to have — quality of life improvements |
| ⚠️ | Caused Cursor breakage — needs rework before re-introducing |

---

## 1. Auto-Infer Business Context

- **Commit**: `ff4748a`
- **Priority**: P1
- **Status**: Ready to re-apply
- **Description**: During `/setup`, infer the project's business context (domain, industry, purpose) from `package.json`, README, and directory structure instead of prompting the user interactively.
- **Files changed** (5 files, +223/-124):
  - `.claude/commands/setup.md` — Updated setup flow to auto-infer
  - `.claude/resources/skills/setup-skill.md` — Auto-inference logic
  - `rules/skills/setup-skill.mdc` — Cursor equivalent
  - `src/cli/utils/prompts.ts` — Removed interactive business context prompt
  - `src/cli/utils/prompts.test.ts` — Updated tests
- **Risk**: Low — standalone change, no known Cursor issues

---

## 2. P1a Quick Wins ⚠️

- **Commit**: `6afb56b`
- **Priority**: P1 (but needs rework)
- **Status**: ⚠️ BROKE CURSOR — needs splitting and rework
- **Description**: Bundle of 6 sub-features added in a single commit. The `> **MODE: Research**` directives caused Cursor to over-explore and never write output `.md` files to `flow/`.
- **Sub-features**:

  ### 2a. MODE Directives ⚠️ DO NOT RE-INTRODUCE
  - Added `> **MODE: Research**` and `> **MODE: Dev**` to all command files
  - **Root cause of Cursor breakage** — tells model to "Read 3x more than you write" and "Don't jump to implementation", preventing file output
  - **Decision**: Do NOT re-introduce. Cursor has no mechanism to use these productively.

  ### 2b. Search for Existing Solutions
  - Added Step 1.5 to discovery: search codebase and npm/PyPI for existing solutions before building
  - Files: `discovery-plan.md`, `discovery-skill.md`, `discovery-templates.md`
  - **Can re-introduce** if done without MODE directive

  ### 2c. Compaction Suggestions
  - After each skill completes, suggest `/compact` to free context
  - Files: `discovery-plan.md`, `create-plan.md`, `create-contract.md`
  - **Can re-introduce** if done without MODE directive

  ### 2d. Confidence-Based Filtering
  - Review findings include confidence percentages; <80% go to "Low-Confidence Notes"
  - Files: `review-code.md`, `review-pr.md`, `review-code-templates.md`, `review-pr-patterns.md`
  - **Can re-introduce** if done without MODE directive

  ### 2e. De-Sloppify Cleanup Pass
  - Auto-remove debug statements, commented-out code, unused imports after execution
  - Files: `execute-plan.md`, `execute-plan-skill.md`
  - **Can re-introduce** if done without MODE directive

  ### 2f. Model Routing
  - Suggest Haiku for low complexity, Sonnet for medium, Opus for high phases
  - Files: `complexity-scoring.md`, `create-plan-skill.md`
  - **Can re-introduce** if done without MODE directive

  ### 2g. Instincts Extraction
  - Extract personal coding preferences from ledger entries
  - Files: `project-ledger.md`
  - **Can re-introduce** if done without MODE directive

- **Files changed** (16 files, +341/-10)
- **Risk**: HIGH — must be split into individual commits and tested in Cursor individually

---

## 3. P0 Session Continuity

- **Commit**: `1237d83`
- **Priority**: P0
- **Status**: Ready to re-apply (test in Cursor)
- **Description**: Lifecycle hooks for session start/end, CI validation of rule files, and phase checkpoints during plan execution. Enables resumable execution across sessions.
- **Files changed** (15 files, +1269):
  - `.claude/resources/core/session-continuity.md` — Session start/end behavior
  - `rules/core/session-continuity.mdc` — Cursor equivalent
  - `src/cli/utils/hooks.ts` — Hook implementation
  - `src/cli/utils/hooks.test.ts` — Tests
  - Phase checkpoint logic in execute-plan skill files
  - CI validation scripts
- **Risk**: Medium — large commit, test thoroughly in Cursor

---

## 4. Multi-Language Detection

- **Commit**: `746f810`
- **Priority**: P1
- **Status**: Ready to re-apply
- **Description**: Added Go and Rust pattern files, tech-detection directive for `/setup`, and made skill files language-agnostic (referencing detected stack instead of hardcoding TypeScript/Python).
- **Files changed** (13 files, +1378/-45):
  - `rules/languages/go-patterns.mdc`, `rust-patterns.mdc` — New language patterns
  - `.claude/resources/languages/` — Claude equivalents
  - Skills updated to reference detected language dynamically
- **Risk**: Low — additive change

---

## 5. Brain Knowledge Capture Activation

- **Commit**: `7c5bd2a`
- **Priority**: P0
- **Status**: Ready to re-apply
- **Description**: Activated brain-capture blocks across all skills (discovery, create-plan, execute-plan, review-code, review-pr, create-contract). Each skill writes to `flow/brain/` after completing.
- **Files changed** (14 files, +158/-9):
  - All skill `.md` and `.mdc` files — Added brain-capture integration
  - `src/cli/utils/files.ts` — File utility updates
- **Risk**: Low — additive change

---

## 6. P1b Features & Multi-Platform Hooks

- **Commit**: `d8388e3`
- **Priority**: P1
- **Status**: Ready to re-apply (test in Cursor)
- **Description**: Session storage utilities, stack detection (auto-detect languages/frameworks), phase hooks, and platform-specific hook scripts.
- **Files changed** (38 files, +3077/-35):
  - `src/cli/utils/sessions.ts` — Session storage and listing
  - `src/cli/utils/detect-stack.ts` — Stack/language auto-detection
  - `src/cli/handlers/` — Platform hook generation
  - `scripts/hooks/` — Hook scripts for session start/end
  - `templates/shared/hooks.json.example` — Hook configuration template
- **Risk**: Medium — large commit, touches many files

---

## 7. Auto-Extract Instincts

- **Commit**: `e415433`
- **Priority**: P2
- **Status**: Ready to re-apply
- **Description**: Utility to extract coding instincts/preferences from ledger entries. Includes `writeInstinct()` function and integration into execute-plan skill.
- **Files changed** (4 files, +517):
  - `src/cli/utils/ledger.ts` — Instinct extraction functions
  - `src/cli/utils/ledger.test.ts` — Tests (282 lines)
  - Execute-plan skill files — Integration
- **Risk**: Low — self-contained utility

---

## 8. Phase Checkpoint Commits

- **Commits**: `7899c89`, `2aa599d`
- **Priority**: P1
- **Status**: Ready to re-apply
- **Description**: Auto-commit after each phase in autopilot mode. Uses `AskUserQuestion` tool for commit confirmation prompt.
- **Files changed** (4 files, +51/-12):
  - Execute-plan skill `.md` and `.mdc` — Checkpoint commit logic
- **Risk**: Low — small focused change

---

## 9. Agent Profiles ⚠️

- **Commits**: `d530aa2`, `78b29c7`
- **Priority**: P1 (but needs rework)
- **Status**: ⚠️ BROKE CURSOR — needs rework
- **Description**: Structured tool access boundaries for all skills (read-only, write-restricted, full-access profiles). Replaced explicit forbidden/allowed tables with a reference to `agent-profiles.mdc`.
- **Root cause of breakage**: The `agent-profiles.mdc` file has `alwaysApply: false`, so Cursor never loads it. The skill files said "Edit/Write/Bash(write) forbidden" which the model interpreted literally, refusing to write output files.
- **Fix needed**: Keep `agent-profiles.mdc` as a reference document but **always include explicit NEVER/Allowed tables inline** in each skill file (like v1.0.7 had). The profile reference can be an additional note, not a replacement.
- **Files changed** (35 files, +392/-503 for profiles; 1 file, +247 for tests):
  - `rules/core/agent-profiles.mdc` — Profile definitions
  - `.claude/resources/core/agent-profiles.md` — Claude equivalent
  - All skill `.md` and `.mdc` files — Tool Access sections replaced
  - `src/cli/utils/agent-profiles.test.ts` — Validation tests
- **Risk**: HIGH — must preserve explicit inline tables

---

## 10. Orchestration Workflows

- **Commits**: `d1aa90b`, `07faf2d`
- **Priority**: P1
- **Status**: Ready to re-apply
- **Description**: 4 workflow types for autopilot (feature, bugfix, refactor, security), each with different step sequences. Added workflow type flags to commands and auto-detect mode.
- **Files changed** (19 files, +1285/-251):
  - `rules/core/orchestration-workflows.mdc` — Workflow definitions
  - `.claude/resources/core/orchestration-workflows.md` — Claude equivalent
  - Command files — Workflow type awareness
  - `src/cli/utils/orchestration-workflows.test.ts` — Tests
  - `skills/plan-flow/flow/SKILL.md` — Updated SKILL manifest
- **Risk**: Medium — depends on autopilot-mode working correctly

---

## 11. Handoff Documents

- **Commit**: `080ae47`
- **Priority**: P1
- **Status**: Ready to re-apply
- **Description**: Structured context transfer documents between commands (e.g., discovery → plan, plan → execute, execute → review). Reduces context loss between workflow steps.
- **Files changed** (19 files, +1107/-128):
  - `rules/patterns/handoff-patterns.mdc` — Handoff templates
  - `.claude/resources/patterns/handoff-patterns.md` — Claude equivalent
  - All skill files — Handoff production/consumption
  - `src/cli/utils/handoff-documents.test.ts` — Tests
- **Risk**: Medium — touches many skill files

---

## 12. Execution Audit Trail

- **Commit**: `7e77366`
- **Priority**: P2
- **Status**: Ready to re-apply
- **Description**: JSONL event logging (`flow/audit.log`) for workflow observability. Logs command_start, file_created, phase_start, phase_end, command_end events.
- **Files changed** (19 files, +734/-4):
  - `rules/core/audit-trail.mdc` — Event type definitions
  - `.claude/resources/core/audit-trail.md` — Claude equivalent
  - All skill/command files — Audit trail sections
  - `src/cli/utils/audit-trail.test.ts` — Tests
- **Risk**: Low — additive, non-breaking

---

## 13. Shared Task Notes for Autopilot

- **Commit**: `b88915b`
- **Priority**: P2
- **Status**: Ready to re-apply
- **Description**: Persistent workflow progress tracking via `flow/state/autopilot-progress.md`. Survives session restarts so the flow can resume.
- **Files changed** (9 files, +644/-2):
  - Autopilot mode files — Progress tracking
  - `scripts/hooks/session-start.cjs` — Resume detection
  - `src/cli/utils/autopilot-progress.test.ts` — Tests
- **Risk**: Low — self-contained

---

## 14. Per-Phase Tool Restrictions

- **Commit**: `ca0f3db`
- **Priority**: P1
- **Status**: Ready to re-apply (depends on #9 Agent Profiles rework)
- **Description**: Individual plan phases can have `**Access**: read-only` or `**Access**: full-access` to restrict tools during specific phases. High-complexity phases (7+) get automatic read-only verification check.
- **Files changed** (9 files, +439):
  - Execute-plan skill files — Phase access enforcement
  - Create-plan skill files — Auto-assign access levels
  - Plans-templates files — Access field in phase template
  - `src/cli/utils/tool-restrictions.test.ts` — Tests
- **Risk**: Medium — depends on agent profiles being properly implemented

---

## 15. Architecture Decision Records (ADRs)

- **Commit**: `b6d1f14`
- **Priority**: P1
- **Status**: Ready to re-apply
- **Description**: Auto-generate ADR files in `flow/brain/decisions/` when significant architectural decisions are made during discovery Q&A. Plan files reference relevant ADRs.
- **Files changed** (9 files, +408):
  - Discovery skill files — ADR generation section
  - Create-plan skill files — ADR references
  - Brain-capture files — ADR template
  - `src/cli/utils/architecture-decision-records.test.ts` — Tests
- **Risk**: Low — additive, integrates with existing brain system

---

## 16. Parallel Review Agents

- **Commit**: `982c250`
- **Priority**: P2
- **Status**: Ready to re-apply
- **Description**: For PRs with 8+ files, spawn parallel read-only review agents (one per file group). Coordinator aggregates findings into single review document.
- **Files changed** (9 files, +771):
  - Review-pr skill files — Parallel workflow section
  - `src/cli/utils/parallel-review-agents.test.ts` — Tests
- **Risk**: Low — opt-in based on file count threshold

---

## 17. Security Scan on Setup

- **Commit**: `26d4053`
- **Priority**: P1
- **Status**: Ready to re-apply
- **Description**: During `/setup`, scan for hardcoded secrets, inventory dependencies, and assess security posture. Results saved to `flow/references/security-baseline.md`.
- **Files changed** (8 files, +660):
  - Setup skill files — Security scan section
  - `src/cli/utils/security-scan-setup.test.ts` — Tests
- **Risk**: Low — additive to setup

---

## 18. Auto Security Review

- **Commit**: `c8d7caa`
- **Priority**: P1
- **Status**: Ready to re-apply
- **Description**: After plan execution, auto-scan changed files for secrets/credentials. Results added to verification report and handed off to review-code.
- **Files changed** (7 files, +342/-1):
  - Execute-plan skill files — Step 7.8 Auto Security Scan
  - `src/cli/utils/auto-security-review.test.ts` — Tests
- **Risk**: Low — non-blocking informational scan

---

## 19. Iterative Discovery Refinement

- **Commit**: `8f92bf3`
- **Priority**: P1
- **Status**: Ready to re-apply
- **Description**: After generating discovery document, user can refine it up to 3 rounds. Each round re-asks targeted questions and updates the document in-place.
- **Files changed** (6 files, +495/-10):
  - Discovery skill files — Step 9: Refinement Loop
  - Discovery command files — Refine option in results
  - `src/cli/utils/iterative-discovery.test.ts` — Tests
- **Risk**: Low — additive to discovery flow

---

## 20. Eval-Driven Development

- **Commit**: `854e621`
- **Priority**: P2
- **Status**: Ready to re-apply
- **Description**: Plans can include per-phase evals (test assertions). During execution, evals run with pass@k tracking. Verification report includes eval results.
- **Files changed** (9 files, +419/-13):
  - Plans-templates files — Evals field in phase template
  - Execute-plan skill files — Step 5.5 eval execution
  - `src/cli/utils/eval-driven-development.test.ts` — Tests
- **Risk**: Low — optional per-phase feature

---

## 21. Discovery Patterns Parity Fix

- **Commit**: `5032da0`
- **Priority**: P0
- **Status**: Ready to re-apply
- **Description**: Added missing "Code References" section to `discovery-patterns.mdc` to match the `.md` version. Ensures Cursor gets the same code search guidance as Claude Code.
- **Files changed** (1 file, +94/-4):
  - `rules/patterns/discovery-patterns.mdc`
- **Risk**: None — parity fix

---

## Suggested Re-Introduction Order

1. **#21** Discovery patterns parity fix (P0, zero risk)
2. **#5** Brain knowledge capture activation (P0, low risk)
3. **#1** Auto-infer business context (P1, low risk)
4. **#8** Phase checkpoint commits (P1, low risk)
5. **#4** Multi-language detection (P1, low risk)
6. **#19** Iterative discovery refinement (P1, low risk)
7. **#15** Architecture decision records (P1, low risk)
8. **#12** Execution audit trail (P2, low risk)
9. **#17** Security scan on setup (P1, low risk)
10. **#18** Auto security review (P1, low risk)
11. **#16** Parallel review agents (P2, low risk)
12. **#13** Shared task notes for autopilot (P2, low risk)
13. **#20** Eval-driven development (P2, low risk)
14. **#7** Auto-extract instincts (P2, low risk)
15. **#3** P0 Session continuity (P0, medium risk — test in Cursor)
16. **#6** P1b features & multi-platform hooks (P1, medium risk — test in Cursor)
17. **#10** Orchestration workflows (P1, medium risk)
18. **#11** Handoff documents (P1, medium risk)
19. **#14** Per-phase tool restrictions (P1, depends on #9)
20. **#9** Agent profiles — REWORK (P1, high risk — keep inline tables)
21. **#2** P1a quick wins — SPLIT & REWORK (P1, high risk — no MODE directives)

---

## Key Lessons Learned

1. **Never replace explicit inline restrictions with references to on-demand files in Cursor** — Cursor has no mechanism for conditional loading (`alwaysApply: false` means "never loaded unless Cursor decides to")
2. **MODE directives break Cursor output** — `> **MODE: Research**` with "Don't jump to implementation" prevents the model from writing output files
3. **Always test every commit in Cursor** before merging — Claude Code and Cursor have fundamentally different rule loading mechanisms
4. **Keep skill restriction tables inline** — The v1.0.7 pattern of explicit NEVER/Allowed tables works; the agent-profiles abstraction doesn't
5. **Split large commits** — `6afb56b` bundled 7 sub-features; if they'd been separate, we'd have isolated the problem instantly
