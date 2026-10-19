# Brain search: `.brain.sqlite` vs the file-based path

**This was the gate for the index's removal, and the gate passed with a documented
cost.** Phase 6 of `plan_file-based-brain_v1.md` removed `.brain.sqlite`,
`@xenova/transformers`, `onnxruntime-node` and `sqlite-vec` (~250 MB of `node_modules`
once transitive deps are counted, plus 70 MB of index in this project alone). The
discovery's highest-severity risk was that retrieval **quietly gets worse** — nothing
errors, no test fails, the agent simply finds less and nobody notices for weeks. The
only defence against a silent regression is measuring it while both paths still exist,
which is what this records.

**The measurement is now history, not a reproducible run.** `scripts/brain-search-compare.mjs`
and the `--engine index` seam it drove were deleted with the index, so re-running this
is not possible without restoring both. The numbers below stand as the record of what
was traded away, deliberately, with the trade accepted.

**What was given up, in one line:** every question the index won was
**vocabulary-bridging** — the query's words and the answer's words were different
("fails twice" → *Retry Behavior*; "know a module is stale" → *The Staleness
Authority*). That is what the embeddings bought. The file path matches the words the
corpus actually uses, so questions must be phrased in the project's own vocabulary;
this is written into the `brain-first.md` contract rather than left for each agent to
rediscover.

## Method

| | |
|---|---|
| Corpus | This repo's real knowledge — 234 markdown files, plus the symbols sidecar and the real `.brain.sqlite` (70 MB), copied to a temp root so nothing was written to the vault |
| Questions | 12, **fixed in the (now deleted) `scripts/brain-search-compare.mjs` before any result was seen** |
| Both engines | The same `layeredBrainSearch` front door, so merge, dedupe, cap, hit shape and freshness are identical and only the retrieval legs differ |
| Limit | 5 hits, the contract's cap |
| Judgment | By hand, per question, on whether the top 5 contains something that answers it. No automated relevance score — that would be this harness marking its own homework (forbidden-pattern #7) |

## Result

**Even. 5 questions to the file path, 5 to the index, 2 ties.**

| Question | Better | Why |
|---|---|---|
| where does a turn get persisted | tie | Both reach `turn-failure.ts` / `turn-completion.ts`; files adds the card, index adds symbols |
| what enforces the `.raw` boundary | **files** | Index returned 0 of 5 relevant. Files returned the literal sentence at `CLAUDE.md:108` |
| how does propose reach the store | **files** | Files found `proposal-store.ts` and the "written ONLY via `blueprint propose`" rule; index found the *test* file |
| how do skills impact playbooks | **index** | Index found the `skills` module doc. Files returned five documents that *quote the question* |
| who writes annotations.jsonl | **index** | Index's top hit was the exact section ("Two Stores, Two Lifecycles") |
| what decides which model a phase runs on | **files** | Index 0 of 5. Files got the owning module and the compile step. **Neither found `model-routing.md`** |
| how is a wave of parallel phases sequenced | **files** | Both correct; index spent 2 of 5 slots on duplicates, files spent 0 |
| where is the gitignore block generated | **files** | Index 0 of 5. Files returned the docs naming `shared.ts` `buildGitignoreBlock`; neither returned the code |
| what happens when verification fails twice | **index** | Index found "Retry Behavior" and "Phase-Level Impact". Files got the area right, the section wrong |
| how does the board know a module is stale | **index** | Index found "The Staleness Authority: `blueprint stale-check`" exactly |
| why was the lavish engine retired | **index** | Index reached the sentence that says it was absorbed by the change brief; files reached only the surrounding docs |
| difference between complexity and risk | tie | Both found "Complexity vs Risk"; index at rank 1, files at rank 3 |

Measured on the same run: **index 881 ms, files 541 ms** across the 12 questions
(73 ms vs 45 ms each) — and the file path opens no database and loads no model.

## What the file path is better at

- **Precision on literal, named things.** Every question the index lost (`.raw` boundary,
  gitignore block, model routing) is one where the corpus states the answer plainly and
  the vector leg wandered off. On three of twelve questions the index returned **nothing
  relevant at all**.
- **Pointers.** Every file hit carries `file:line`. Under the index only *symbol* hits
  could — chunks came out of a database that never recorded where in a file they began,
  so the contract's `file:line` promise was three-quarters unmet.
- **Corpus hygiene.** **19 of the index's 60 hits (32%) were duplicate copies of the same
  document** under `app/resources/cli/**` and `app/dist/mac-arm64/Flow.app/**` — build
  artifacts that were never in the specified corpus (`.claude/resources`, `.claude/rules`,
  `flow/brain`, `flow/plans`, `flow/discovery`, `CLAUDE.md`). One more hit was
  `docs/flow-ide-features.md`, Tier-2 foreign documentation that
  `brain-index-boundary.test.ts` exists to keep *out* of Tier-1 retrieval. The file path
  walks the specified roots, so it cannot drift this way.
- **Speed and cost.** 1.6× faster, with 137 MB of dependencies and 70 MB of index removed.

## What the file path is worse at — the honest part

**Vocabulary bridging.** Every question the index won has the same shape: the question's
words and the document's words differ, and the embedding leg crossed the gap where
lexical matching could not.

- "verification fails **twice**" → the answer is under "**Retry Behavior**", which never
  uses the word *twice*.
- "how does the board **know** a module is **stale**" → "The **Staleness Authority**".
- "how do **skills impact playbooks**" → the `skills` module's *Integration Points*.

This is what the vectors were for, and losing it is a real loss, not a wash. Three known
regressions on twelve questions is the price of the 137 MB.

**Two further caveats, stated rather than buried:**

1. **Parity was reached partly by tuning.** The first run scored 4 / 3 / 5 — already even —
   and this run scores 5 / 5 / 2 after two changes the comparison itself caught: an IDF
   ceiling (one rare, incidental word — *twice* — was outvoting the rest of the question)
   and eleven auxiliary stopwords (*where does a turn* ***get*** *persisted* ranked a
   `GET /users` contract example first). Both are principled, and both were made against
   this measured set, so read the post-tuning number as the weaker of the two.
2. **The relational layer is untested by this comparison, because it is empty.** `INDEX.md`
   carries every feature's summary, parts and edges — but all 33 features in this project
   have `relates: []`. Phase 2 shipped the writer; no learn pass has recorded an edge yet.
   Until one does, `INDEX.md` contributes a searchable feature roster and **no
   relationships**, which is exactly why "how do skills impact playbooks" returned five
   documents *about* the question instead of an answer to it. The capability the whole
   feature is for is present in the code and absent from the data.

## Verdict

**Yes — the file path is good enough to remove the index, and Phase 6 may proceed.**
Retrieval quality is even; speed, pointers, corpus hygiene and 137 MB all favour the file
path; and the one genuine loss is narrow and named.

It is **not free**. Record the vocabulary-bridging regression as a known cost rather than
denying it, and expect the relational answer to stay weak until edges are actually
written.

---

## Raw results

Both result sets in full, so a later reader can disagree with the judgment above without
re-running anything.

### where does a turn get persisted

_A correct answer points at: turn-completion / the thread store_

**index** (308 ms)

  1. `code` flow/brain/code/app-src-shared.md › app/src/shared/turn-failure.ts
  2. `symbol` app/src/main/agent/turn-completion.ts:14 › isTurnResultTerminal
  3. `symbol` app/src/shared/turn-failure.ts:27 › isTurnFailureNote
  4. `symbol` app/src/shared/turn-failure.ts:20 › TURN_FAILURE_PREFIX
  5. `symbol` app/src/main/agent/auto-attach.ts:87 › TurnAttachTracker

**files** (69 ms)

  1. `note` CLAUDE.md:294 › Flow Directory Structure
  2. `code` flow/brain/code/app-src-shared.md:553 › app/src/shared/turn-failure.ts
  3. `code` flow/brain/code/app-src-main-agent.md:630 › app/src/main/agent/turn-completion.ts
  4. `symbol` app/src/main/agent/turn-completion.ts:14 › isTurnResultTerminal
  5. `symbol` app/src/shared/turn-failure.ts:27 › isTurnFailureNote

### what enforces the .raw boundary

_A correct answer points at: the tier boundary — .raw is never indexed_

**index** (52 ms)

  1. `discovery` flow/discovery/discovery_learnings_v1.md › Risks
  2. `module` flow/brain/modules/app-src-main-brain.md › Responsibilities
  3. `plan` flow/plans/plan_learnings_v1.md › Step: The brief IS the learning
  4. `resource` .claude/resources/skills/write-tests-skill.md › What to Test
  5. `resource` .claude/resources/core/autopilot-mode.md › Transition Summary Format

**files** (52 ms)

  1. `note` CLAUDE.md:108 › Brain (Unified Knowledge Store)
  2. `module` flow/brain/modules/app-src-main-brain.md:5 › Responsibilities
  3. `resource` .claude/resources/core/blueprint.md:475 › Arc Convention (bound decision)
  4. `resource` .claude/resources/core/auto-provisioning.md:79 › `refresh` — Owned Assets Update
  5. `resource` .claude/resources/core/blueprint.md:139 › Dual-Source Backbone

### how does propose reach the store

_A correct answer points at: blueprint propose / proposal-store.ts_

**index** (46 ms)

  1. `code` flow/brain/code/src-cli-blueprint.md › src/cli/blueprint/proposal-store.test.ts
  2. `resource` .claude/resources/skills/discovery-skill.md › Step 6b: Blueprint Proposals
  3. `discovery` flow/discovery/discovery_discovery-view_v1.md › Measured Data (2026-08-10, this machine)
  4. `resource` .claude/resources/core/blueprint.md › Envelope & Fingerprint
  5. `resource` .claude/resources/core/blueprint.md › Fold Rules

**files** (46 ms)

  1. `resource` .claude/resources/core/blueprint.md:4 › Purpose
  2. `code` flow/brain/code/src-cli-blueprint.md:797 › src/cli/blueprint/proposal-store.ts
  3. `symbol` src/cli/blueprint/proposal-store.ts:194 › DATASTORE_ID_PATTERN
  4. `discovery` flow/discovery/discovery_change-record-parts_v1.md:267 › Open Questions
  5. `resource` .claude/resources/skills/create-plan-skill.md:255 › Blueprint Proposals

### how do skills impact playbooks

_A correct answer points at: a relationship between two features_

**index** (51 ms)

  1. `module` flow/brain/modules/skills.md › Integration Points
  2. `module` flow/brain/modules/skills.md › Overview
  3. `resource` .claude/resources/core/pattern-capture.md › Pending Patterns
  4. `resource` .claude/resources/skills/discovery-skill.md › Risks
  5. `note` app/resources/cli/.claude/resources/core/pattern-capture.md › Pending Patterns

**files** (41 ms)

  1. `plan` flow/plans/plan_file-based-brain_v1.md:116 › Phase 2: The learn pass records relationships
  2. `note` flow/brainstorms/brainstorm_file-based-brain_v1.md:57 › Problem 2 (quiet, real): nothing can answer a relational question
  3. `discovery` flow/discovery/discovery_file-based-brain_v1.md:11 › Problem Statement
  4. `discovery` flow/discovery/discovery_file-based-brain_v1.md:308 › Step: A database that cannot answer the question
  5. `plan` flow/plans/plan_file-based-brain_v1.md:314 › Step: A brain that cannot answer the question

### who writes annotations.jsonl

_A correct answer points at: the blueprint annotation store, single writer_

**index** (43 ms)

  1. `resource` .claude/resources/core/blueprint.md › Two Stores, Two Lifecycles
  2. `note` app/resources/cli/.claude/resources/core/blueprint.md › Two Stores, Two Lifecycles
  3. `note` app/dist/mac-arm64/Flow.app/Contents/Resources/cli/.claude/resources/core/blueprint.md › Two Stores, Two Lifecycles
  4. `note` CLAUDE.md › Blueprint (Living System Map)
  5. `symbol` app/src/shared/ipc-contract.ts:907 › BlueprintAnnotationStatus

**files** (48 ms)

  1. `note` CLAUDE.md:129 › Blueprint (Living System Map)
  2. `resource` .claude/resources/skills/execute-plan-skill.md:306 › Rounds Record (`flow/.rounds.jsonl`)
  3. `resource` .claude/resources/core/blueprint.md:4 › Purpose
  4. `note` CLAUDE.md:294 › Flow Directory Structure
  5. `module` flow/brain/modules/app-resources.md:30 › Major internal subsystems

### what decides which model a phase runs on

_A correct answer points at: model routing by complexity_

**index** (71 ms)

  1. `resource` .claude/resources/patterns/plans-patterns.md › 13. Declare Phase Dependencies for Parallel Execution
  2. `note` app/resources/cli/.claude/resources/patterns/plans-patterns.md › 13. Declare Phase Dependencies for Parallel Execution
  3. `resource` .claude/resources/patterns/plans-patterns.md › 6. Structure Plans with Scoped Phases
  4. `note` app/dist/mac-arm64/Flow.app/Contents/Resources/cli/.claude/resources/patterns/plans-patterns.md › 13. Declare Phase Dependencies for Parallel Execution
  5. `note` app/resources/cli/.claude/resources/patterns/plans-patterns.md › 6. Structure Plans with Scoped Phases

**files** (52 ms)

  1. `module` flow/brain/modules/src-cli-state.md:5 › Responsibilities
  2. `note` CLAUDE.md:129 › Blueprint (Living System Map)
  3. `note` flow/brainstorms/brainstorm_changeset-on-the-map_v1.md:11 › Resolved During Brainstorm
  4. `resource` .claude/resources/skills/execute-plan-skill.md:306 › Rounds Record (`flow/.rounds.jsonl`)
  5. `resource` .claude/resources/skills/execute-plan-skill.md:105 › Step 0: Compile the Run Script

### how is a wave of parallel phases sequenced

_A correct answer points at: wave-execution / topological sort_

**index** (68 ms)

  1. `resource` .claude/resources/core/wave-execution.md › Wave Execution Plan
  2. `note` app/resources/cli/.claude/resources/core/wave-execution.md › Wave Execution Plan
  3. `resource` .claude/resources/skills/execute-plan-skill.md › Rounds Record (`flow/.rounds.jsonl`)
  4. `resource` .claude/resources/core/phase-isolation.md › Wave Failure Isolation
  5. `note` app/dist/mac-arm64/Flow.app/Contents/Resources/cli/.claude/resources/core/wave-execution.md › Wave Execution Plan

**files** (44 ms)

  1. `note` CLAUDE.md:77 › Wave-Based Parallel Execution
  2. `resource` .claude/resources/core/wave-execution.md:388 › Rules
  3. `resource` .claude/resources/core/wave-execution.md:205 › Wave Execution Plan
  4. `resource` .claude/resources/skills/execute-plan-skill.md:1070 › Wave Mode
  5. `resource` .claude/resources/skills/execute-plan-skill.md:243 › Wave Execution Plan:

### where is the gitignore block generated

_A correct answer points at: shared.ts buildGitignoreBlock_

**index** (45 ms)

  1. `resource` .claude/resources/core/per-task-verification.md › Evidence Directory
  2. `note` flow/brainstorms/brainstorm_merge-conflict-resolution_v1.md › Next Step
  3. `note` app/resources/cli/.claude/resources/core/per-task-verification.md › Evidence Directory
  4. `code` flow/brain/code/app-src-renderer-git.md › app/src/renderer/git/diff-lifecycle.ts
  5. `note` app/dist/mac-arm64/Flow.app/Contents/Resources/cli/.claude/resources/core/per-task-verification.md › Evidence Directory

**files** (36 ms)

  1. `discovery` flow/discovery/discovery_file-based-brain_v1.md:68 › Settled Decisions (DO NOT re-litigate)
  2. `discovery` flow/discovery/discovery_file-based-brain_v1.md:193 › C. Sharing
  3. `discovery` flow/discovery/discovery_file-based-brain_v1.md:246 › Constraints
  4. `plan` flow/plans/plan_file-based-brain_v1.md:14 › Intent
  5. `plan` flow/plans/plan_file-based-brain_v1.md:148 › Phase 3: Setup asks, and the ignore block is generated from the answer

### what happens when verification fails twice

_A correct answer points at: per-task verification repair loop_

**index** (39 ms)

  1. `resource` .claude/resources/core/per-task-verification.md › Phase-Level Impact
  2. `note` app/resources/cli/.claude/resources/core/per-task-verification.md › Phase-Level Impact
  3. `note` app/dist/mac-arm64/Flow.app/Contents/Resources/cli/.claude/resources/core/per-task-verification.md › Phase-Level Impact
  4. `resource` .claude/resources/core/per-task-verification.md › Retry Behavior
  5. `note` app/resources/cli/.claude/resources/core/per-task-verification.md › Retry Behavior

**files** (38 ms)

  1. `note` CLAUDE.md:192 › Per-Task Verification
  2. `plan` flow/plans/plan_change-brief_v1.md:14 › Intent
  3. `note` flow/brainstorms/brainstorm_merge-conflict-resolution_v1.md:40 › Key Insights
  4. `discovery` flow/discovery/discovery_change-record-parts_v2.md:321 › Open Questions
  5. `resource` .claude/resources/skills/execute-plan-skill.md:1135 › Per-Task Verification

### how does the board know a module is stale

_A correct answer points at: stale-check / learning state_

**index** (67 ms)

  1. `note` docs/flow-ide-features.md › Progressive learning — institutional knowledge that knows when it's stale
  2. `resource` .claude/resources/core/progressive-learning.md › Module Deleted
  3. `note` app/resources/cli/.claude/resources/core/progressive-learning.md › Module Deleted
  4. `note` app/dist/mac-arm64/Flow.app/Contents/Resources/cli/.claude/resources/core/progressive-learning.md › Module Deleted
  5. `resource` .claude/resources/core/progressive-learning.md › The Staleness Authority: `blueprint stale-check`

**files** (44 ms)

  1. `note` CLAUDE.md:129 › Blueprint (Living System Map)
  2. `note` CLAUDE.md:173 › Progressive Learning
  3. `resource` .claude/resources/core/progressive-learning.md:68 › T2 — Per-Node Learn (Manual)
  4. `resource` .claude/resources/core/progressive-learning.md:4 › Purpose
  5. `note` flow/brainstorms/brainstorm_trust-tiers_v1.md:15 › Why This Matters

### why was the lavish engine retired

_A correct answer points at: absorbed by the change brief_

**index** (45 ms)

  1. `resource` .claude/resources/core/engine-registry.md › Purpose
  2. `note` app/resources/cli/.claude/resources/core/engine-registry.md › Purpose
  3. `note` app/dist/mac-arm64/Flow.app/Contents/Resources/cli/.claude/resources/core/engine-registry.md › Purpose
  4. `note` CLAUDE.md › Blueprint (Living System Map)
  5. `note` flow/tasklist.md › Done

**files** (30 ms)

  1. `note` CLAUDE.md:248 › Engine Registry
  2. `symbol` src/cli/state/flowconfig-parser.ts:66 › extractEngines
  3. `symbol` src/cli/state/types.ts:23 › EngineStatus
  4. `resource` .claude/resources/core/engine-registry.md:4 › Purpose
  5. `resource` .claude/resources/core/engine-registry.md:79 › Engine Catalog

### what is the difference between complexity and risk

_A correct answer points at: estimate vs post-execution judgment_

**index** (46 ms)

  1. `resource` .claude/resources/core/complexity-scoring.md › Complexity vs Risk
  2. `note` app/resources/cli/.claude/resources/core/complexity-scoring.md › Complexity vs Risk
  3. `note` app/dist/mac-arm64/Flow.app/Contents/Resources/cli/.claude/resources/core/complexity-scoring.md › Complexity vs Risk
  4. `note` CLAUDE.md › Complexity Scoring
  5. `symbol` app/src/main/git/merge-summary.ts:71 › overallRisk

**files** (41 ms)

  1. `note` CLAUDE.md:282 › Complexity Scoring
  2. `resource` .claude/resources/skills/execute-plan-skill.md:1187 › Summary of Key Rules
  3. `resource` .claude/resources/core/complexity-scoring.md:229 › Complexity vs Risk
  4. `resource` .claude/resources/skills/execute-plan-skill.md:673 › Step 7b1a: Change-Simulation Reconciliation (blueprint-simulation)
  5. `resource` .claude/resources/skills/execute-plan-skill.md:1210 › Related Files

_Totals across 12 questions: index 881 ms · files 541 ms_

