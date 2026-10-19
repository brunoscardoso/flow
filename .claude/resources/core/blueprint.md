
# Blueprint (Living System Map)

## Purpose

Single-source spec for the **Blueprint** — a derived, always-rebuildable map of the project's system surface (integrations, endpoints, data stores, modules) plus an anchored, append-only annotation layer that attaches plan-flow decisions, rules, and claims to specific points in that map. Consumers: `/execute-plan` (post-run derive + render, anchors on run records, archive-time story clear), `/create-plan` (advisory before-overlay input, `## Story` authoring + strict narrate + story review — see Story Layer), `/discovery-plan` and `/brainstorm` (draft `## Story` authoring), `/review-code` and `/review-pr` (anchors on verdicts, capped node context).

Everything lives under `flow/brain/.structure/`:

| File | Role |
|------|------|
| `graph.json` | The derived system graph — rebuilt in full on every derive, never patched |
| `graph.prev.json` | The previous derive, rotated on write (delta baseline for must-review) |
| `annotations.jsonl` | Append-only annotation stream (decisions / rules / claims / pins) |
| `status-events.jsonl` | Append-only status transitions (active ↔ stale) targeting annotations by fingerprint |
| `investigations.jsonl` | Investigation store — notes + heat ticks with a supersede/compaction lifecycle (see Investigation Store) |
| `proposals.jsonl` | Proposal store — predicted "ghost" nodes named by a plan, with an event-fold lifecycle (see Proposals) |
| `learning-state.jsonl` | Module learning status (learning / learned / stale) with timestamps; deduped by module, updated by progressive-learning (see Progressive Learning) |
| `story.json` | Compiled story — the `## Story` section of one plan/discovery/brainstorm doc, resolved against the graph + ghosts; derived/disposable (see Story Layer) |
| `symbols.jsonl` | Symbol sidecar — one row per extracted top-level symbol (`{name, kind, path, line, language, fileHash}`) for exact/prefix name lookup; derived/disposable, rewritten atomically on every derive |
| `blueprint.html` | Deterministic self-contained title sheet rendered from the stores |

Two derived artifacts live outside `flow/brain/.structure/`: the prose report at `flow/brain/blueprint-report.md` (see Prose Report), written by every successful derive so the graph enters the searched markdown corpus, and the code cards at `flow/brain/code/<module-slug>.md` — one markdown card per module (per-file H2 sections with symbols/imports/one-liner + content hash), derived/disposable like the graph, hash-gated so unchanged files regenerate nothing, and searched as ordinary markdown.

**The board's default sheet is the Territory** (Flow IDE, `blueprint-board.ts`) — see Feature Board: the Territory, below. The old **code map** (the derived graph as a module treemap behind its own header button) is gone, replaced by the **code storyline**: pressing a TS/JS file on the Territory, or *Read as a story* on a feature or part, opens the file's real code laid out left to right from the entry point other files use most — the storyline has its own camera (drag, wheel, `0` refits). It is compiled by `planflow-ai blueprint storyline` with the TypeScript compiler and cached by content hash; the app passes its own TypeScript via `FLOW_TYPESCRIPT_PATH`. The derived graph still feeds a feature brief's scoped stage (module cards, node popovers with their Files section and the peek drawer), proposal ghosts and coverage. The compiled story (see Story Layer) no longer lives on the board itself — it renders as an interactive card in the chat thread.

Skills reference this file; they never restate it.

---

## Feature Vocabulary: Three Words, One Meaning Each

The board's **default** view is the feature blueprint — what this project does — and it is built from three node kinds that must never share a word. Calling any of them by another's name is the bug this vocabulary exists to prevent (a board that drew change records as parts reported "2 parts" for a capability that had ten).

| Word | `kind` in `blueprint features graph` | What it is | Where it comes from |
|------|--------------------------------------|------------|---------------------|
| **feature** | `core` | A capability — something the project *does* | Repo surfaces (route segments, API groups, `e2e/tests/<name>`, `features/` roots) named in ≥2 distinct surface kinds; top-level code dirs as a fallback |
| **part** | `part` (carries `partOf` = the owning feature's slug) | A **piece of** a capability | The owning feature's `## Parts` section in `flow/brain/features/<slug>.md`, written only by `blueprint features parts --feature <ref> --write <json>` |
| **change** | `child` (carries `parent` = the feature's id) | A plan or an issue that **touched** a capability — a record of past work, not a piece of it | The plan/discovery corpus, parented to the core whose name it contains |

Rules that follow from the table, all enforced in code rather than by convention:

- **A kind is read, never re-derived.** No consumer may infer one kind by negating another (`core ? feature : part` is exactly how every change became a part), and no count may be computed as `total − <one kind>`. The CLI summary counts each kind by name: `features: N (A core, B part, C change) · E relates edge(s)`.
- **Board levels follow the data, not a constant.** Features render at the root level (grouped by `domain:` when any feature carries one, drawn as countries), parts on drill-down, and a part is a leaf — there is nothing inside a single artifact. "Two levels only" was the pre-parts design and is retired.
- **A change is carried but never drawn.** Change nodes exist in the graph for their parent link (upward walks such as the in-flight learning rollup need it) and are excluded from every level at every depth in one place (`RING_KINDS` in `focus-stack.ts`). Their surface is the feature brief's `Changes:` line, the cell's second line (`M changes`), and the root footer note.
- **Counts and empty states spend each word once.** A feature's kicker counts parts only; an empty drilled level says which noun is missing, and a feature that has changes but no parts is never described as untouched.

---

## Feature Board: the Territory

The default sheet is a **map of ground**, not a diagram of dots. It replaced a ring of equal discs whose only statement was *how many*; the territory makes three statements instead, and every one of them is a property of the rectangle a reader is looking at:

- **AREA is size.** A cell's area is the code it stands on — the lines under its anchors at the root and on a domain (the CLI measures every node's `size`: files and lines, directories walked, dependency and build directories skipped), files below. The sheet is packed squarified and sorted by size, so the biggest capability is the biggest, roundest rectangle and sits first. A capability that touches two hundred files and one that touches four cannot draw the same rectangle.
- **POSITION is adjacency.** Cells keep the store's own order (`strips`, an ordered strip treemap in `territory-layout.ts`), so a feature moves only when the store moves. Squarified packing was ruled out for exactly this: rounder cells are not worth nine neighbours relocating because one value changed.
- **A LEVEL IS A ZOOM of the level above.** Diving flies one rectangle out to fill the sheet (`territory-motion.ts`); popping reverses it. There is no camera on this sheet at all — the map is packed into the measured stage, so it is always already fitted and `0` is deliberately not consumed here.

**The nesting, in one line:** *countries* (a `domain:` grouping, drawn only when some feature carries one) hold *features*; a feature drills to its *parts*; a part drills to its *files*. A part is a leaf on the root sheet — clicking one opens its brief, whose own stage is the same kind of picture one level down (`territory-level.ts`: the parts are the ground, and each component stands in the part that claims its file).

**Cell grammar**, top to bottom, and each row is a gate rather than a decoration:

| Row | What it says | When it is drawn |
|-----|--------------|------------------|
| kicker | the learn dot (`fb-learn-*`, four states), the drift diamond, the in-flight mark | whenever the underlying fact exists |
| name | the capability's own name | at the tier its rectangle can hold (`cellLabelClass`); the tooltip and the accessible name survive every tier, including the one that prints nothing |
| second line | `N parts · M changes` | only on a **roomy** cell — never on every cell, or the count becomes texture |

A cell never loses its name because a *sibling* is crowded: label density is decided per rectangle, which is the whole difference from the ring's sheet-wide answer. `territoryCaps` counts what the sheet withheld, and the limitations disclosure reports it.

**Chrome around the ground:**

- **Title strip** (top) — where you are, the level's kicker, the understood percentage, and the *Ask the brain* field. Matches from a brain query light on the map (`fb-terr-lit`) and everything else dims (`fb-terr-dim`); there is no scrim, because a scrim would hide the answer.
- **Foot** — the crumb trail (the parent crumb is the way out, along with Esc and Backspace), the root footer note naming *change records whose feature could not be identified*, and the limitations disclosure.
- **Learning lens** — a line at the foot of a cell, never a fill. A filled cell would claim the *feature* is understood; the line is about its files.
- **Dial** — sixty fine ticks, filled in the in-progress tint over a dim-ink track, beside the figure. It is the same percentage the title strip and the headline report — one number, three places, computed once (`progressFor` / `computeLearnProgress`).

**Interaction:** a cell's body dives when it has something inside and opens its brief when it is a leaf (`activationOf`); the level control in its corner is the *only* route to a feature view, at any depth. Clicking a cell also attaches a composer reference chip, exactly as a module card does.

---

## Two Stores, Two Lifecycles

**The graph is disposable.** `graph.json` is derived entirely from source code by extractors (optionally enriched by graphify). Every derive rebuilds it from scratch and rotates the previous version to `graph.prev.json`. Deleting it loses nothing — the next derive regenerates it. Corrupt or missing graph files never throw; readers return null and the CLI says `no blueprint — run \`planflow-ai blueprint derive\` first`.

**The annotations are precious.** `annotations.jsonl` and `status-events.jsonl` are append-only and never rewritten, edited, or deleted. An annotation whose anchors no longer resolve is **stale-flagged via a status event** — the record itself is untouched and can be reactivated when its anchors resolve again. Effective status is computed on read by folding `status-events.jsonl` over `annotations.jsonl` (last event per fingerprint wins).

The **fingerprint** identifying an annotation (for status events and promotion dedup) is:

```
<type>+<text>+<sorted anchor refs>
```

**The investigation store is the third store** — `investigations.jsonl` sits beside the annotation stream but has a deliberately different lifecycle: notes may be superseded and compaction drops superseded notes (annotations stay append-only-forever and untouched). See Investigation Store.

---

## Trust Model

1. **Structure is derived-only.** Nodes and edges come exclusively from the native extractors and (when enabled) the graphify engine. No LLM ever narrates structure into the graph.
2. **Narration must be anchored and attributed.** Every annotation carries `anchors` (see Anchor Envelope) and `provenance` (which skill or record produced it, e.g. `rounds:plan_decision run:<run-id>`). Unanchored records are never promoted into the annotation stream.
3. **No self-narration.** An agent must never write its own success claims into the map — annotations enter only via promotion of structured run records (rounds / wave-context entries) that the coordinator wrote during execution. This is forbidden pattern #7 (`.claude/rules/core/forbidden-patterns.md` — "DON'T: Trust the Worker's Success Summary") applied to the blueprint: the map records what happened, not what a worker said about itself.
4. **The renderer is a template, not narration.** `blueprint.html` is produced by deterministic TypeScript template code — no LLM writes or edits the renderer output.

---

## CLI Surface

| Command | Effect |
|---------|--------|
| `planflow-ai blueprint derive [--run-id <id>]` | Rebuild `graph.json` (rotating the old one), relink annotations, promote anchored run records. `--run-id` attributes promoted records and enables rounds-based must-review signals for that run; without it, graph-delta signals only |
| `planflow-ai blueprint context <node>` | Capped JSON context for one node: the node, its direct edges with neighbor labels, and the annotations anchored to it (see Output Token Guard). Exact id match first, then case-insensitive substring on id/label (ambiguity is reported in a `note`) |
| `planflow-ai blueprint render` | Render the title sheet to `flow/brain/.structure/blueprint.html` from the persisted stores |
| `planflow-ai blueprint brief --plan <name> [--json]` | Compute the change brief for a plan — the Today ⇄ After delta. READ-ONLY: computes and prints, writes nothing (see Change Brief) |
| `planflow-ai blueprint observe …` | The ONLY write path into the investigation store — heat ticks and validated investigation notes (see Investigation Store) |
| `planflow-ai blueprint propose …` | The ONLY write path into the proposal store — records predicted "ghost" nodes and `--decide accepted\|rejected` events against them (see Proposals) |
| `planflow-ai blueprint sweep --plan <p>` | End-of-plan proposal maintenance — stales undecided/accepted-unbuilt proposals, clears rejected ones (see Proposals) |
| `planflow-ai blueprint narrate --from <doc> [--plan <name>] [--draft\|--strict]` | The ONLY write path into the story store — compiles a doc's `## Story` section to `story.json` (see Story Layer) |
| `planflow-ai blueprint narrate --clear --plan <name>` | Removes the compiled story for a matching plan (production caller: `/execute-plan` archive step) |
| `planflow-ai blueprint stale-check [--module <m>] [--json]` | Read-only staleness authority for progressive-learning: re-hashes files stamped in investigation notes and reports drift. The app's learn-triggers spawn this to detect stale modules; users can call it ad-hoc to audit learning-state freshness (see Progressive Learning) |

`planflow-ai init` runs a fire-and-forget first derive in the background (same pattern as the brain-index rebuild) — a derive failure logs a warning and never blocks init.

### Derive Pipeline

Each derive runs, in order:

1. **runExtractors** — four native extractors (integrations, endpoints, datastores, modules) scan the repo and merge into a deduplicated, stable-sorted node/edge set with a coverage report
2. **BlueprintGraph v1** — `{ version: 1, derivedAt, coverage, nodes, edges }`
3. **Pending gate** — when `flow/.flowconfig` has `engines.graphify: pending` (consented via the init install rails, not yet installed), the backbone merge AND enrichment are both skipped here (the single gate — neither entry point has its own pending branch) and the derive runs native-only with the persistent notice: `graphify pending install — blueprint runs native-only until graphify is installed (uv tool install graphifyy)`
4. **mergeGraphifyBackbone** — fail-soft dual-source backbone merge, BEFORE enrichment (see Dual-Source Backbone below)
5. **enrichWithGraphify** — fail-soft graphify enrichment on top of the (possibly merged) graph, covering synthesized backbone modules too (see Graphify Enrichment below)
6. **computeMustReview** — ranked "needs your eyes" list, persisted as `graph.mustReview` (baseline: the on-disk `graph.json`, which still holds the previous derive at this point)
7. **validateCanonicalGraph** — the canonical contract gate (see Canonical Contract). ANY violation hard-fails the derive with nothing written; steps 8-11 never run against an invalid graph
8. **writeGraph** — rotates existing `graph.json` → `graph.prev.json`, writes the new graph
9. **relinkAnnotations** — stale/recover status events against the fresh graph (see Stale Policy)
10. **promoteRunRecords** — anchored rounds/wave-context records → annotations (see Promotion Rules)
11. **Proposal confirm pass** — every effective `proposed|accepted` proposal whose EXACT `predictedNodeId` exists in the fresh graph gets a `confirmed` event, reported as `proposals: N confirmed` when N > 0 (see Proposals). Fail-soft: a busy/unreadable proposal store skips the pass silently
12. **Prose report** — renders `flow/brain/blueprint-report.md` AFTER the graph/relink/promotion writes succeed (see Prose Report). Fail-soft: a write failure reports `prose report: skipped (<reason>)` instead of failing an otherwise-successful derive

Derive prints, in deterministic order: any graphify/pending notice, the extractor coverage notes (including spine roots and files-scanned counts), the backbone line (a fail-soft notice, or `backbone: graphify modules merged (N synthesized module(s), M cross-module edge(s))` when the merge ran), the `validation: ok` line, graph node/edge counts, must-review count, relink staled/recovered counts, promotion promoted/skipped counts, the conditional `compaction: N folded` and `proposals: N confirmed` lines (each omitted when nothing was folded/confirmed), and the prose report line (`prose report: flow/brain/blueprint-report.md`, or the skipped form above).

### Extractors & Node Conventions

Extractors are **TS/JS heuristics with explicit coverage notes** — frameworks detected, patterns matched, unreadable files/directories skipped and counted. No silent gaps: every derive prints `scan: N/M source file(s) readable`.

Node id conventions:

| Kind | Id pattern |
|------|-----------|
| Integration | `integration:<name>`, `integration:webhook:<path>` |
| Endpoint | `endpoint:<METHOD> <path>` (HTTP), `endpoint:cli <command>` (CLI) |
| Datastore | `datastore:<name>`, `datastore:migrations:<dir>` |
| Module | `module:<repo-relative dir path>` (e.g. `module:src/cli/blueprint`; legacy basename ids like `module:cli` keep resolving via the anchor bridge) |

Edge relations (native): `imports` (module→module), `exposes` (module→endpoint), `uses` (module→integration/datastore), `contains` (module→module, the folder spine). Graphify enrichment adds cross-module `calls`/`imports` edges.

### Spine Roots

The module extractor builds its folder tree per **spine root** — discovered once per derive by `discoverSpineRoots(repoRoot)` (`src/cli/blueprint/extractors/scan.ts`). Deterministic: sorted repo-relative posix paths.

**Candidates**, in gathering order:

1. **package.json `workspaces` globs** (`string[]` shorthand or `{ packages: string[] }` object form; `*` matches a single path segment): each matched directory contributes `<match>/src` when that nested dir contains source files, else the match itself.
2. **Conventional roots**: `src`, `app/src`, `lib`, `packages/*/src`, `apps/*/src`.

**Selection**: a candidate must exist and contain at least one source file in its subtree (the repo walk's ignore rules apply — node_modules, build outputs, and hidden dirs never count); duplicates collapse; candidates nested inside an already-selected root are dropped (**outermost wins** — shallower roots are considered first). **Fallback**: when nothing matches, every repo-root directory containing source files becomes a root — the legacy single-spine behavior, with identical ids and depths to before.

**Root-as-depth-1 semantics**: every spine root is itself a depth-1 module node (`module:src`, `module:app/src` — multiple depth-1 roots are legal); its child directories are depth 2, and the depth cap (`MODULE_TREE_DEPTH_CAP = 4`) applies **per root** — deeper directories roll up into their depth-cap ancestor. Files sitting directly in a root count as the root node's own files. Deepest-folder attribution considers the module nodes of ALL roots, so nodes detected anywhere (e.g. a datastore under `app/src/main/store`) attach to a real folder home. Every derive prints the coverage note `scan: spine roots: <roots>`.

### Dual-Source Backbone

When the graphify engine is `enabled` and `graphify-out/graph.json` loads at derive time, graphify is promoted from enrichment-only to a **structural backbone source** alongside the native extractors: `mergeGraphifyBackbone` (`src/cli/blueprint/backbone.ts`) runs before enrichment and sets `coverage.extractorsRun` to the dual-source set — the coverage report records that both sources built the graph.

**Backbone granularity is directory-only rollup** (bound plan decision): graphify symbols/files roll up to the deepest containing module directory — NO file-level nodes are ever created.

1. Files covered by a native module directory roll up to the **deepest native module node** — no new nodes.
2. Files outside every native module (e.g. non-TS/JS languages the native extractors missed entirely) **synthesize module nodes** for their directory chains, following ALL module conventions the canonical validator enforces: id `module:<dir>`, `sourceFile` = dir, label = basename, `meta.depth` per spine-root semantics (the file's top-level directory becomes its own depth-1 root, `contains` chains give child.depth = parent.depth + 1, depth capped at `MODULE_TREE_DEPTH_CAP` with rollup — mirroring `extractors/modules.ts`). Synthesized nodes carry `meta.backbone: true` (plus `meta.rolledUp: true` when files rolled up past the cap); files sitting directly at the repo root have no directory home and are never attributed.
3. Graphify `calls`/`imports` edges between files owned by DIFFERENT modules become cross-module blueprint edges (deduplicated, sorted).

Everything is deterministic (stable sorts everywhere) and the input graph is never mutated. Fail-soft: engine not `enabled` → silent no-op; missing/unparsable graphify graph or a merge error → the input graph returned unchanged plus a one-line notice:

> graphify backbone unavailable (<reason>) — continuing with native structure.

The merged graph must still pass `validateCanonicalGraph` — that is the acceptance bar, enforced by the derive pipeline's hard validation gate. The dual-source set is an **additive canonical-contract extension**: `DUAL_SOURCE_EXTRACTORS` is a third legal extractor set (see Canonical Contract) and the graph schema stays version 1.

### Graphify Enrichment

Silent no-op when `engines.graphify` is not `enabled` in `flow/.flowconfig` (declined/pending/absent engines are silent HERE, per the engine registry — the derive pipeline's pending gate owns the persistent `pending` install notice). When enabled, enrichment reads `graphify-out/graph.json` **directly** (no `graphify affected/query` invocation), applying the staleness handling first:

- **Content-based staleness** (`isGraphifyGraphStale`): the graph is stale when the working tree has uncommitted SOURCE-file changes (`git status --porcelain`, counting only files with a source extension per `isSourceFile`) OR the last commit is newer than the graph file's mtime. Staleness is null (undeterminable) when git is unavailable for both signals or the graph file cannot be stat'ed — the caller proceeds with the graph as-is.
- **Last-known-good**: a FAILED stale refresh (`graphify update .`) means STALE, NOT ABSENT — enrichment keeps the last-known-good graph and proceeds with a loud notice: `graphify refresh failed (<reason>) — using last-known-good graph from <ISO-8601 mtime>` (mtime degrades to `unknown time` when unreadable).
- **Never-initialized**: no graph file at all gets ONE build attempt (`graphify update .`); only when the file still does not exist afterwards does enrichment fall back native with the notice reason `no graph at graphify-out/graph.json — run: graphify update .`.

It folds in per-module degree/community metrics (subtree-aggregated up the folder hierarchy), cross-module `calls`/`imports` edges, and canonical graphify node ids as anchor hints (`meta.graphifyIds` — the FULL sorted id set is stored, because anchor resolution matches against it; display capping happens only in `blueprint context` output, 8 ids with an explicit `graphifyIdsMore` overflow count), then sets `coverage.graphifyEnriched: true`.

Every unavailability path (tool missing, no graph file after the one-shot build, unparsable JSON, merge error) returns the input graph **unchanged** with a one-line notice:

> graphify unavailable (<reason>) — continuing with native structure.

Enrichment never throws and never blocks the native derive. Full graphify mechanics live in `.claude/resources/core/graphify-engine.md`.

### Prose Report

Every successful derive writes a deterministic markdown report to **`flow/brain/blueprint-report.md`** (`renderProseReport`, `src/cli/blueprint/render/prose-report.ts`) — a graph→prose→search bridge that lands in the searched markdown corpus. Sections: `## Modules` (top modules ranked by `meta.degree`, falling back to `contains`-children count when enrichment didn't run; capped at `MODULE_REPORT_CAP = 15` with an explicit `…and K more module(s)` line), `## Integrations`, `## Datastores`, `## Endpoints` (one line per node, sorted by id, `_none derived_` when empty), and `## Structure` (node/edge counts by kind/relation plus the coverage line).

**Determinism**: no clock or randomness at render time, no LLM narration, and — unlike the HTML title sheet — `graph.derivedAt` is deliberately NOT embedded, so repeated derives of an unchanged repo rewrite a byte-identical file. **Fail-soft**: the report renders only after the graph/relink/promotion writes succeed, and a write failure appends `prose report: skipped (<reason>)` to the derive report instead of failing the derive.

---

## Canonical Contract

The L0 taxonomy is a **self-validated contract**, not a docs-only convention: `validateCanonicalGraph` (`src/cli/blueprint/validate.ts`) inspects every fully-built graph — post-extraction, post-enrichment, post-must-review — **before** `writeGraph`. It is pure and deterministic (no I/O, no mutation, errors sorted lexicographically: same graph → byte-identical error list).

**Hard-error behavior — the ONE exception to fail-soft** (plan decision: hard-error, not warn-and-write). Any violation fails the derive with exit code 1; ALL violations surface at once, one per line, each prefixed `canonical contract violation: `. An invalid graph is **never written**: `graph.json` and `graph.prev.json` stay untouched, and relink/promotion never run against it. On success the derive report includes the line `validation: ok`.

**Frozen constants** (exported from `validate.ts` — extending any of them is a deliberate schema-version decision, never a drive-by edit):

| Constant | Value |
|----------|-------|
| `FROZEN_NODE_KINDS` | `['datastore', 'endpoint', 'integration', 'module']` |
| `FROZEN_EDGE_RELATIONS` | `['calls', 'contains', 'exposes', 'imports', 'uses']` |
| `FROZEN_EXTRACTORS` | `['integrations', 'endpoints', 'datastores', 'modules']` (native CLI derive path) |
| `DUAL_SOURCE_EXTRACTORS` | `['graphify', 'integrations', 'endpoints', 'datastores', 'modules']` — the four native extractors PLUS the graphify backbone merge (see Dual-Source Backbone). An **additive** third legal set (never mixed with `basic`); the graph schema stays version 1 |
| `FALLBACK_EXTRACTORS` | `['basic']` — the **app-workspace fallback exception**: the app's embedded derive runs one consolidated `basic` extractor whose graphs obey the same node/edge contract, so canonical parity is preserved by accepting any one of the three legal sets |
| `MODULE_ID_PREFIX` | `'module:'` |
| `MODULE_DEPTH_MIN` / `MODULE_DEPTH_MAX` | `1` / `4` — declared independently of the extractor's `MODULE_TREE_DEPTH_CAP` so the contract cannot drift silently with the implementation |

**Validated invariants**:

- **Coverage**: `coverage.extractorsRun` equals (order-insensitive, as a set) exactly `FROZEN_EXTRACTORS`, exactly `DUAL_SOURCE_EXTRACTORS`, or exactly `FALLBACK_EXTRACTORS` — never a mixture
- **Nodes**: every `kind` is in the frozen enum; node ids are unique
- **Edges**: no dangling endpoints; every `relation` is in the frozen vocabulary
- **Module spine** (validated structurally, with NO single-root assumption — multiple depth-1 roots are legal, see Spine Roots): module `id === 'module:' + sourceFile`; `meta.depth` is an integer in 1..4; `contains` edges are module→module only, the child directory is strictly under the parent directory (roll-up nesting under the parent path is allowed), and `child.depth === parent.depth + 1`
- **Acyclicity**: the `contains` spine has no cycles (Kahn's algorithm; reported per stuck node, sorted, for deterministic output)

---

## Anchor Envelope

An anchor attaches an annotation to a point in the derived map:

```json
{ "kind": "symbol | file | table | endpoint | module", "ref": "<reference>", "file": "<repo-relative path, optional>" }
```

Anchor helper constructors live in `src/cli/blueprint/anchors.ts` (`anchorFromSymbol`, `anchorFromFile`, `anchorFromTable`, `anchorFromEndpoint`, `anchorFromModule`).

**Resolution** is a pure structural check against the fresh graph — no fuzzy matching:

| Kind | Resolves when |
|------|---------------|
| `symbol` | A node's `symbol` equals `ref`, or a node's `meta.graphifyIds` contains `ref`, or (fallback) `anchor.file` matches a node per the `file` rule below |
| `file` | Any node's `sourceFile` equals `ref`, or `ref` lives under a module node's directory |
| `table` | Any datastore node's `meta.tables` includes `ref` |
| `endpoint` | A node with id `endpoint:<ref>` exists |
| `module` | A module node with id `module:<ref>` exists, or whose `label` (directory basename — legacy basename-id bridge) or `sourceFile` (directory path) equals `ref` |

Unknown kinds (forward-compat data) never resolve.

**Where anchors ride**: `flow/.wave-context.jsonl` `contract`/`decision` payloads carry an optional `anchors?: Anchor[]` field (typed in `src/cli/state/types.ts`), and rounds entries (`plan_decision`, `review_verdict`, `risk`, `escalation`) may carry the same optional field (doc-defined — the rounds envelope lives in the Rounds Record section of `.claude/resources/skills/execute-plan-skill.md`). Records without anchors parse unchanged.

---

## Promotion Rules

`blueprint derive` promotes anchored run records into the annotation stream. Sources (both optional — absent files are treated as empty):

- **`flow/.rounds.jsonl`** — any record with a well-formed, non-empty `anchors` array:

  | Rounds type | Annotation type | Text |
  |-------------|-----------------|------|
  | `plan_decision` | `decision` | `<decision>: <choice>` |
  | `run_intent` | `decision` | `Run <plan>: <intent_goal> — <originating_request>` |
  | `phase_result` | `claim` (**selective** — see below) | `Phase <phase> (<plan>): <summary> — decisions: <a, b>; deviations: <c>` |
  | `review_verdict` | `rule` when `classification: "kept"`, else `claim` | `<finding_fingerprint>: <reason>` |
  | `escalation` | `claim` | `<what>: <choice>` |
  | `risk` | `claim` | `<risk_level>: <risk_rationale>` |
  | any other anchored type | `claim` | `<type>: <summary>` |

  **`run_intent` lineage**: missing fields are omitted gracefully (`intent_goal` and `originating_request` join with ` — `; a missing `plan` degrades the head to `Run`). Provenance is `rounds:run_intent run:<record.run_id>` — the **record's own** `run_id` (the run the intent belongs to), NOT the promotion pass's `--run-id` parameter (the ` run:` suffix is omitted when the record carries no `run_id`).

  **`phase_result` selection rule**: promoted ONLY when the record's `anchors` are non-empty AND it carries at least one decision or deviation (`decisions` or `deviations` non-empty). Text formatting: items within a section join with `, `; the `decisions: …` / `deviations: …` sections join with `; `; a present `summary` prefixes them with ` — `; empty parts are omitted gracefully. Routine phase completions — decision-less or anchorless — are **silent non-candidates**: valid records that simply aren't promotable, never skip-counted (this keeps annotation growth bounded to decision-bearing phases).

- **`flow/.wave-context.jsonl`** — only `contract` and `decision` entries whose `data.anchors` is present and well-formed (`progress` and unknown types are never promoted): contracts become `claim` (`<name>: <signature>`), decisions become `decision` (`<choice>: <reason>`).

**Provenance format**: `rounds:<type>` or `wave-context:<contract|decision>`, with ` run:<run-id>` appended when the derive was given `--run-id`.

**Dedup**: promotion is idempotent — a candidate whose fingerprint already exists in the effective annotation stream (or earlier in the same pass) is skipped. Malformed lines are skipped and counted, never silently swallowed; well-formed but unanchored records are simply not candidates (backward compatible).

---

## Stale Policy

The relink pass runs after **every** derive and keeps annotation status honest against the fresh graph:

- **Active** annotations whose anchors **all** fail to resolve → stale-flagged (status event, reason `anchors lost: <refs>`)
- **Stale** annotations whose anchors **all** resolve again → reactivated (status event, reason `anchors resolved again`)
- Annotations with **zero anchors** are never staled (nothing to lose)

Annotations are **never deleted** and never rewritten — all transitions are append-only status events. There is no fuzzy re-matching: an anchor either resolves structurally or the annotation is honestly flagged stale. Recovery is automatic — a renamed symbol that returns (or a graphify enrichment that restores an id) reactivates the annotation on the next derive.

---

## Investigation Store

### Purpose

`flow/brain/.structure/investigations.jsonl` is the **third store**: investigation-time knowledge (what an agent or human actually saw while reading code) with a **supersede/compaction lifecycle** — deliberately unlike the precious annotation stream, which stays append-only-forever and untouched. Two line shapes share the file, discriminated by a `kind` field: `{"kind":"note", …}` (an investigation note) and `{"kind":"heat", …}` (a raw visit event, or an aggregated counter written by compaction).

### Entry Shapes

An **investigation note** (`InvestigationEntry`, `src/cli/blueprint/types.ts`): `ts`, `runId` (null outside a run), `anchors` (standard Anchor Envelope), `text`, `provenance`, `status`, `hashStamps` (SHA-256 content stamps of anchored files at read time — `{ref, contentHash}` — so later readers detect drift), plus optional `ambiguous: true` and `supersedes: <fingerprint>`.

A **heat tick** (`HeatTick`): `ts`, `anchorRef`, `visitor: 'human' | 'agent'`. Ticks aggregate on read into one **`HeatCounter`** per anchor ref: `{anchorRef, humanVisits, agentVisits, lastVisited}` (counts sum; `lastVisited` is the max timestamp).

The **fingerprint** of an investigation note (supersede pointers target notes by it) is:

```
<text>+<JSON array of sorted anchor refs>
```

### Fold-on-Read & Compaction

**Fold-on-read**: readers collapse supersede chains — a note whose fingerprint is referenced by any other note's `supersedes` is dropped; the latest non-superseded note per chain wins (chains of arbitrary length collapse) — and aggregate heat ticks per anchor ref. Missing files yield empty results; corrupt lines are skipped individually, never fatal.

**Compaction** (`compactInvestigations`) rewrites the file in place as one aggregated heat line per anchor ref followed by every non-superseded note. Guarantees: TOTAL visit counts and `lastVisited` are preserved (count history is never lost — readers accept the aggregated line shape too); superseded notes are dropped (that is the point); non-superseded notes are ALWAYS kept; idempotent (compacting a compacted file is a no-op); concurrency-safe (exclusive-create lock file with stale-lock reclaim, temp-file write + atomic rename — readers never observe a partial file).

### Trust Ladder

The epistemic `status` is one of **`observed`** (seen once), **`corroborated`** (a later look confirmed it), **`contradicted`** (the evidence now points the other way). Ambiguity is representable — the `ambiguous: true` flag marks an observation as unresolved. The rule is **leave-NULL-never-guess**: an ambiguous observation stays flagged; it is never coerced to fact.

### THE WRITE RULE

**`planflow-ai blueprint observe` is the ONLY writer** into the investigation store — never self-narration, never direct file appends. Full CLI shape:

```
planflow-ai blueprint observe [--note <text>] [--anchor <kind>:<ref>]…
  [--status observed|corroborates|supersedes] [--supersedes <fingerprint>]
  [--reason <text>] [--ambiguous] [--visit agent|human]
  [--lenient-anchors] [--conflict-scope any|primary]
  [--run-id <id>] [--json <inline-json>]
```

Two modes:

- **Heat-only mode** (no `--note`/`--json`): appends one heat tick per `--anchor` (visitor from `--visit`, default `agent`). Heat is NEVER refused by the contradiction rule — the only failure modes are malformed input (unparsable anchor, zero anchors, bad `--visit`). Prints `observed: heat +N anchor(s)`.
- **Note mode** (`--note` or `--json`): runs the validation pipeline **in order** — anchors parse (`<kind>:<ref>` with kind in `symbol|file|table|endpoint|module`); non-empty text; at least one anchor; supersede coherence (`--status supersedes` requires `--supersedes <fingerprint>`; any `--supersedes` requires `--reason "<why>"`); a blueprint graph exists and EVERY anchor resolves against it; every file-backed anchor's file exists and is hash-stamped; then the contradiction rule. On success, the note is appended plus one agent heat tick per anchor, printing `observed: note <fingerprint> (<status>) on N anchor(s)`.

**Contradiction rule (bound decision — strict refuse)**: when any active note shares an anchor ref with the new entry, the write is REFUSED unless the entry corroborates (`--status corroborates` → recorded as `corroborated`) or supersedes-with-reason (`--supersedes <fingerprint> --reason "<why>"`, where the fingerprint must match an active note on those anchors; the reason is appended to the text as ` [supersedes: <reason>]`). Refusal format — one line on stderr, exit code 1, NOTHING written:

```
observe refused: <reason>
```

e.g. `observe refused: anchor '<ref>' already carries N active note(s) — pass --status corroborates, or --supersedes <fingerprint> --reason "<why>" (existing fingerprints: <up to 3>)`. The supersede target must be an ACTIVE note, but not necessarily one of the conflicting ones — superseding a note that shares no anchor with the entry is how an orphaned note gets retired.

**Identity anchor and conflict scope**: the FIRST `--anchor` is the note's **identity** (what the note is about); the rest are decoration. `--lenient-anchors` drops unresolvable/unstampable DECORATION loudly (`observe: dropped N …`) but never the identity — an identity-less note can never be found to supersede, so an unresolvable identity refuses instead. `--conflict-scope primary` narrows the contradiction rule to the identity anchor: notes that merely share a decorative anchor describe a different subject and never contradict this one. Learn passes use both — a child module's note legitimately anchors files its parent's note also anchors, and bare symbol refs (`GET`, `main`) recur across unrelated modules, so under the default scope a child module's FIRST learn was refused as a contradiction (live failure 2026-07-30). The default `any` scope (every anchor contradicts) is unchanged for every other caller.

`--json` carries the whole entry as inline JSON and runs through the SAME validation pipeline — no bypass. Default provenance when the caller supplies none: `blueprint observe`.

### Heat Semantics

Heat counters keep **separate human and agent visit counts**. Today only agents produce ticks (`observe` defaults to `--visit agent`, and note writes tick as agent); the `human` visitor exists for the planned IDE follow-up, where editor navigation will emit human ticks. Heat is re-derivable signal, not precious narration — compaction may aggregate it, and `blueprint context` drops it before notes when truncating.

### In Context Output

`blueprint context <node>` includes an `investigation` section: active notes anchored to the node, pre-capped at the **5 most recent** (`INVESTIGATION_CONTEXT_NOTE_CAP`) with an explicit `notesMore` overflow count — never a silent cut — plus the node's aggregated heat counters. See Output Token Guard for truncation priority.

---

## Proposals (Decision Surface)

### Purpose

`flow/brain/.structure/proposals.jsonl` is the **fourth store**: PREDICTED graph nodes ("ghosts") named by a plan before the code that would make the extractors derive them exists. Proposals live in their own store with their own lifecycle — `graph.json` stays derived-only and is never touched by proposals. The operating rule is **chat decides, the board mirrors**: proposals are recorded and decided via the mediated CLI during discovery/planning conversation; the Flow IDE board renders the outcome and has no decision controls.

### Envelope & Fingerprint

One line per `ProposalEvent` (`src/cli/blueprint/proposal-store.ts`): `ts`, `plan`, `predictedNodeId`, `kind` (`integration|endpoint|datastore|module`), `label`, `event`, `provenance`, plus optional `phase` (plan phase number), `detail`, and `anchors` (standard Anchor Envelope — proposal anchors point at existing code RELATED to the prediction and are validated structurally only, never resolved against the graph: propose works with no graph at all).

The **fingerprint** identifying a proposal (all lifecycle events for one prediction share it) is:

```
<plan>+<predictedNodeId>
```

### Fold Rules

Fold-on-read, deliberately simpler than the investigation store (no supersede chains, no cycle machinery): events group by fingerprint, sort ascending by `ts` (ties broken by file order), and the **LAST event's name is the state**. The payload (kind/label/detail/phase/anchors/provenance) always comes from the **FIRST `proposed` event** — decision/terminal events re-carry the payload so every store line is self-describing, but the fold ignores the re-carried copy. Fingerprints with no `proposed` event at all are dropped. A re-`proposed` event resets the state (historical `decidedAt`/`confirmedAt` timestamps are kept). Missing file yields empty results; malformed lines are skipped AND counted. Result ordering is deterministic (proposedAt, then fingerprint).

### Lifecycle

```
proposed ──(chat decides)──> accepted ──(derive: exact id derived)──> confirmed  [terminal]
   │                            └──(sweep: accepted but never built)──> stale    [re-propose to revive]
   ├──(chat decides)──> rejected ──(sweep)──> cleared                            [terminal]
   ├──(derive: exact id derived)──> confirmed                                    [terminal]
   └──(sweep: never decided)──> stale                                            [re-propose to revive]
```

- **`--decide` only from `proposed`**: an already-decided proposal refuses a second decision; terminal states (`confirmed`/`cleared`) cannot be decided at all; a `stale` proposal must be re-proposed before deciding.
- **Confirmation is mechanical only**: during every derive (after relink/promotion), each effective `proposed|accepted` proposal — any plan — whose **EXACT `predictedNodeId`** exists among the fresh graph's node ids gets a `confirmed` event (provenance `derive:confirm`) — no fuzzy match, no LLM judgment. Reported as `proposals: N confirmed` (line omitted when N = 0). Fail-soft: a busy/unreadable store skips the pass silently, never failing the derive.
- **Sweep** (`planflow-ai blueprint sweep --plan <p>`) is end-of-plan maintenance over ONE plan's proposals: `accepted` (accepted but never built) → `stale`, `proposed` (never decided) → `stale`, `rejected` → `cleared`. Terminal/swept states (confirmed/stale/cleared) are untouched, so a double sweep is idempotent (`0 staled, 0 cleared`). Provenance `cli:sweep`; prints `sweep <plan>: N staled, M cleared`. **Production caller: the `/execute-plan` archive step** — when a plan is archived, the sweep runs so the board never shows a dead plan's ghosts as live.

### THE WRITE RULE (CLI Surface)

**`planflow-ai blueprint propose` is the ONLY writer** into the proposal store (single write lock `proposals.lock`, same semantics as the sibling stores; reads never lock) — never direct file appends, never self-narration.

**Record mode** — validates the predicted id against the grammar below (the kind must agree with the id prefix) and appends one `proposed` event (provenance `cli:propose`), printing `proposal recorded: <node> (<plan>)` followed by the accounting line:

```
planflow-ai blueprint propose --plan <plan> --node <predicted-id> --kind <kind> --label <text>
  [--detail <text>] [--phase <n>] [--anchor <kind>:<ref>]…
```

**Silent-record semantics**: no board and no graph are required — in a terminal-only session the record needs no surface to land on (the terminal fallback IS the record). Silent means *no board is needed*, never *no one is told*.

**Decide mode** — appends one decision event against an existing effective proposal, printing the same accounting line:

```
planflow-ai blueprint propose --decide accepted|rejected --plan <plan> --node <predicted-id>
```

Any validation failure (either mode, and sweep alike) exits 1 with one line on stderr and NOTHING written:

```
propose refused: <reason>
```

### An Empty Store Is a REPORTABLE Outcome

**Every successful write — record and decide alike — prints one accounting line reporting the plan's resulting store state** (`countProposals` / `formatProposalsRecorded`, `src/cli/blueprint/proposal-store.ts`):

```
proposals: N recorded              # N total for that plan
proposals: N recorded (M live)     # when M (proposed|accepted|rejected) differs from N
```

**Zero is a result, not an absence.** A discovery or plan run that records nothing MUST report `Proposals: 0 recorded` with its reason — `nothing concrete predicted`, or the CLI's refusal reason verbatim. The per-state counts are zero-filled for exactly this purpose: no reader ever has to distinguish "the store said nothing" from "the store has nothing".

This rule is written down because its absence was invisible for the store's entire lifetime. The skills instructed that "recording is silent by design"; nothing counted, nothing reported, and no error could fire — so `proposals.jsonl` did not exist in a single project on disk while every layer above it looked healthy. Emission remains a judgment the agent makes (proposals are predictions, and a run may legitimately have none); **reporting that judgment is not optional.** Refusal reasons live in the store's own validators (`validateProposalRecord` / `validateProposalDecision` / `formatProposeRefusal`) rather than in the CLI, so the one code path deciding what is invalid is the one a test can interrogate (allowed-pattern #14) — a refused propose always yields a caller-surfaceable reason, never a silent non-event.

### Predicted-Id Grammar

A predicted id is valid only when it matches its kind's extractor id convention (`isValidPredictedNodeId` / `PREDICTED_ID_GRAMMAR`, `src/cli/blueprint/proposal-store.ts`):

| Kind | Grammar |
|------|---------|
| `integration` | `integration:<name>` or `integration:webhook:</path>` |
| `endpoint` | `endpoint:<METHOD> /<path>` (uppercase verb) or `endpoint:cli <command>` |
| `datastore` | `datastore:<name>` (migration dirs keep their colons — `datastore:migrations:<dir>`) |
| `module` | `module:<repo-relative-dir>` (posix path, no leading `/`) |

### Board Display

The board mirrors the store, it never decides: **`proposed`, `accepted`, and `rejected` render as ghost cards** inside their category/folder layers (dashed accent border, reduced opacity, mono predicted id, plan badge; accepted = solid-translucent, rejected = struck until swept); **`confirmed`, `stale`, and `cleared` vanish** — a confirmed ghost dissolves into the real derived node. Density discipline applies: at most `MAX_PROPOSALS_PER_LAYER = 6` ghost cards per layer placement, the rest collapsing into an explicit `…and K more proposals` overflow line. A Layer-0 REV strip summarizes per plan (`<plan> — N proposals · M decided`).

### Composer Reference Chips (Board→Chat)

Clicking a board component attaches a reference chip in the chat composer. On send, each chip serializes as a **single-line content prefix above the user text** — plain message content, no IPC or envelope changes; chips are dismissible before send:

```
[blueprint: <nodeId> — <label>]
[blueprint proposal: <predictedNodeId> — <label>]
```

Any agent receiving a message containing such lines should resolve the reference via `planflow-ai blueprint context <nodeId>` for capped structural context (see Output Token Guard).

### Trust Model Note

Ghosts are **hypotheses, not structure** — they never enter `graph.json`, and their styling keeps them visually unmistakable from derived nodes. Confirmation is mechanical only (exact predicted-id match at derive time); nothing an agent narrates can flip a ghost real.

---

## Story Layer

### Purpose

`flow/brain/.structure/story.json` is a **derived, disposable** compiled walkthrough of one plan/discovery/brainstorm doc's `## Story` section — a concept arc that turns the graph + ghosts into a guided narrative for humans reviewing a plan. Like `graph.json`, it is fully rebuildable from its source (the doc's markdown) and carries no precious data of its own — the `## Story` section in the doc is the precious copy; `story.json` is a compiled artifact.

### Grammar

A doc opts in with a `## Story` section containing `### Step: <title>` blocks plus optional `- key:` metadata (`kicker`, `anchors`, `flow`, `phases`, `source`, `decisions`/`rejected`/`questions`). Full grammar, including the anchor-item spelling rules (explicit `<kind>:<ref>` envelopes or bare predicted/graph node ids), lives in `src/cli/blueprint/story-grammar.ts` (doc comment) — reference it, never restate it here.

### THE WRITE RULE

**`planflow-ai blueprint narrate` is the ONLY writer** into the story store — never self-narration, never direct file writes (allowed-pattern #14: invariants live in one code path). Two responsibilities:

```
planflow-ai blueprint narrate --from <doc> [--plan <name>] [--draft|--strict]
planflow-ai blueprint narrate --clear --plan <name>
```

- **Compile** (`--from <doc>`): parses the doc's `## Story` section, resolves every step's `anchors`/`flow` items against the current graph AND the effective proposal set (`proposed`/`accepted` ghosts resolve too — a story can narrate a not-yet-built plan), and writes `story.json` atomically (temp file + rename, `story.lock`, same lock semantics as the sibling stores). Success prints `narrate: <plan> — N steps compiled (M draft)`.
- **Clear** (`--clear --plan <name>`): removes the compiled story when it matches the given plan — prints `narrate: cleared story for <plan>` or `narrate: no story for <plan>` when there was nothing to clear. Production caller: the `/execute-plan` archive step (alongside `blueprint sweep`), so the board never shows a dead plan's story as live.

### Draft vs Strict Mode

Mode is inferred from the source doc's path unless overridden by `--draft`/`--strict`: docs under `flow/plans/` compile **strict**, docs under `flow/discovery/` or `flow/brainstorms/` compile **draft**. Any other path requires an explicit flag.

- **Strict** refuses (nothing written, exit code 1) on ANY unresolved anchor, unknown flow id, or non-positive-integer phase reference — printing `narrate refused: <reasons>`, listing every violation at once. An absent `## Story` section is itself a strict refusal. Plans written since change notes (2026-10-08) carry no `## Story` — `/create-plan` authors change notes instead (`plan notes --check`); strict mode remains for older plans that still have one.
- **Draft** is lenient: the same problems compile anyway, with `draft: true` and a populated `unresolvedAnchors` per step, and the summary counts drafts. `/discovery-plan` and `/brainstorm` run draft — code the story references may not exist yet (see `.claude/resources/skills/discovery-skill.md`, Step 6c).

Steps are capped at `STORY_STEP_CAP` (5) in BOTH modes — overflow steps are dropped with an explicit warning listing the dropped titles, never a silent truncation.

### Arc Convention (bound decision)

Every story — draft or strict — follows the same narrative shape: **problem → shape → data flow → decisions/why-nots → risks**, intuition before details. This is a documentation convention enforced by authoring guidance in the skills (discovery/create-plan), not a parser-level rule — the grammar accepts any step order and any number of steps up to the cap.

### Rendering

**RETIRED (change-brief)**: the story walkthrough — the `--story` render flag and its `story.html` page — is gone. The compiled story is now read by the **change brief** — `planflow-ai blueprint brief --plan <name>` — which renders natively on the board as Today ⇄ After rather than as a static page. The grammar and `story.json` are unchanged; only the HTML renderer was removed. A dead page could not click through to the board, which is most of what made the walkthrough worth replacing.

The Flow IDE renders the same compiled story as an interactive card in the chat thread (`threads/story-card.ts`) rather than a board side panel: it auto-opens whenever `snapshot.story` is present (delivered via the existing blueprint watcher) and remembers its minimized/expanded choice per thread — a live view of `story.json`, not a second writer. Stepping through the card decorates the flow-first board (lit cards, an animated flow-path overlay) via a decoupled `flow:story-step` event, so the two surfaces stay in sync without a direct dependency.

### Chat Artifact Card

Before a doc even has a compiled story, the chat thread already knows about it: the moment a `.md` lands under `flow/discovery/`, `flow/plans/`, or `flow/brainstorms/`, a main-process watcher (`artifact-observer.ts`) surfaces it as a live `ArtifactCard` (`threads/artifact-card.ts`) in the active thread's feed — one card per kind, latest-wins, never persisted. The card is the chat's standing guarantee about a doc's story state: a pill reads **Story compiled** / **Story not compiled** / **No story section**, and the action row adapts to it — `Narrate` runs `learn:narrate` in place (uncompiled → compiled, no context switch to a terminal), `Ask agent` prefills the composer to author a `## Story` section (missing), and both `Open doc` / `View on board` are always present. Board/editor coupling stays import-free: every action fires the same decoupled events (`flow:open-file-path`, `flow:open-blueprint`) the rest of the shell uses.

### Peek Drawer

The board's Files section (see Purpose, above) and the story card's file-anchor lines both open the SAME peek drawer — a `flow:peek-file` document event is the one listener (`blueprint/index.ts`), so either entry point lands on identical behavior. The drawer is a second pane in the board's `fl-split`, filled by a single reused read-only Monaco instance (`peek-viewer.ts`): picking a second file swaps the model in place rather than reopening the drawer, and it fails soft — a styled notice for no-root/read-failure/binary/too-large, a plain `<pre>` if Monaco itself won't load. This is deliberately **map, not territory**: the peek is read-only and disposable, a way to confirm "is this the file I want" without leaving the board's spatial context. An "Open in editor" button (↗) in the drawer header promotes the peeked file into a real editor tab via the same `openFile` path the file tree uses, then closes the drawer — the moment the user actually wants to edit, they leave the map for the territory. Esc closes the drawer before it pops a drill level (popover → peek → drill is the full precedence chain).

### Trust Model Note

Story steps are a **narrated view over derived + hypothesis data**, not a third kind of structure: anchors resolve against `graph.json` (real) and `proposals.jsonl` ghosts (hypotheses, already visually distinguished elsewhere) — a story never adds nodes or edges of its own. `narrate` is the sole mediator (mirrors `observe`/`propose`); question chips rendered from `questions:` lists are **read-only mirrors** of what the doc says — chat decides, the board mirrors, exactly like the Proposals decision surface.

---

## Must-Review Signals

Computed at derive time from **existing structured data only** (graph delta vs `graph.prev.json`, graphify degree metrics, current-run rounds records) and persisted as `graph.mustReview`. Deterministic: same inputs → same ranked list.

| Signal | Severity | Source |
|--------|----------|--------|
| New external integration node | `crit` | graph-delta |
| New data store node | `high` | graph-delta |
| Data store gained tables | `high` | graph-delta |
| God node (module degree ≥ 50, new or degree grew) | `high` | graphify |
| Run risk assessed `high` | `crit` | rounds |
| Run risk assessed `medium` | `high` | rounds |
| Escalation (relayed verbatim: what + choice) | `ask` | rounds |
| Kept review verdict (`classification: "kept"`) | `ask` | rounds |
| Verification `failed-needs-decision` | `ask` | rounds |

Ranking: severity (`crit` > `high` > `ask` > `info`) with a stable codepoint title tie-break, then ranks 1..N. **First derive rule**: when `prevGraph` is null (no previous derive, or a missing/corrupt `graph.prev.json` baseline), delta and god-node signals are skipped entirely — flooding the list with every existing node would rank nothing. Rounds signals apply only to records matching the derive's `--run-id`; no run id → no rounds signals.

---

## Output Token Guard

`blueprint context <node>` output is **hard-capped at 4,500 characters (~1,500 tokens)** — mirroring the graphify Output Token Guard in `.claude/resources/core/graphify-engine.md`. Truncation drops **whole items** from the end of the priority order — annotations outrank investigation notes, which outrank heat counters, which outrank edges (annotations and notes are the precious narrated layers; heat and edges are re-derivable) — so edges fall away first and annotations last; the node itself is never cut (worst case it is compact-serialized). Never a silent mid-JSON cut: every drop appends the mandatory drill-down hint:

> … and N more — run `planflow-ai blueprint context <other-node>` or open flow/brain/.structure/graph.json for detail

The hint is mandatory whenever anything was dropped: the caller can always go deeper; the injected context never does.

---

## Title Sheet

`blueprint render` produces a self-contained, drafting/blueprint-styled HTML title sheet with three columns (integrations | modules | data), a must-review list, annotations, and the run timeline (archived rounds files by plan name, then the current run).

**Cap rules** (from `src/cli/blueprint/render/layout.ts`):

- `COLUMN_NODE_CAP = 8` node entries per column; `CLI_COMMAND_CAP = 8` commands on the CLI-surface entry
- Every cap surfaces an **explicit "…and K more" line** — silent truncation is forbidden
- HTTP endpoints are summarized as a count chip on their owning module (via `exposes` edges); CLI endpoints roll into one "CLI surface" pseudo-entry listing the top commands

**Renderer determinism rule**: the renderer is a deterministic TEMPLATE — same on-disk inputs → **byte-identical HTML**. No clock or randomness at render time (`derivedAt` comes from the graph), no external requests (all CSS/JS inline), every interpolated string escaped (labels and annotation text are untrusted). Dual theme: dark mode via `prefers-color-scheme` token redefinition plus `:root[data-theme=…]` overrides so the viewer's theme toggle wins both ways. No LLM writes the renderer or its output.

---

## The Board and the Feature Store, in Full

MOVED HERE FROM `CLAUDE.md` (#1949). The two always-loaded sections that
described this — Blueprint and Feature Blueprint — cost ~4,800 tokens per
session and per sub-agent, and pointed here anyway.

### The Board: Hover, Pin, and the Code Storyline

> **Blueprint = brain's structure layer + the board that renders it (#52).** After the consolidation, the blueprint is not a separate store: its derived graph and append-only stores all live under **`flow/brain/.structure/`** (relocated from the retired `flow/.blueprint/`), and the one-shot migration folded a snapshot of the precious knowledge into brain markdown (`flow/brain/decisions/blueprint-migrated.md`, queryable via `brain:query`). The IDE **board** is the interactive VIEW of this layer. Its default sheet is the **Territory** — a squarified treemap of the feature blueprint where a cell's AREA is the lines of code its anchors stand on (measured by the CLI as the node's `size`; the anchor count is a fallback for an unmeasured graph), the biggest cell sits first, and a level is a zoom of the level above (countries → features → parts); **hovering a cell** for a short pause grows THAT cell in place — no card, no overlay: the level is laid out again around it (`focusLayout` in territory-layout.ts — the same cuts in the same order, the hovered cell at ~60% of its level and still containing where it was, its neighbours shrunk to their names with a floor; on the Workspace map its project grows too), the cells slide to their new rectangles, and the grown cell draws inside itself its description and that feature's curated diagram, or a part's slice of its owner's (cell-hover-model.ts + the board's one curated-canvas builder; read only after the pause, cached per project + ref); a cell with nothing drawn yet offers *Learn this feature* in its middle instead, and leaving (or Escape) puts the map back; a click inside the diagram (or Space) **pins & explores** it — the cell stays grown with a ring, the map dims, and the diagram becomes a camera viewport (drag pans, wheel/pinch zooms, `0`/Fit shows all, a hovered component lights its neighbours, a corner toolbar zooms/fits/opens/unpins; Escape or a click outside unpins — cell-pin-model.ts); there is no diagram door on cells; **pressing** a cell with a level below zooms in, and pressing at the last level (a part, or a feature with no parts) opens the **code storyline** — the old code map and the part page are gone. The storyline lays the code out left to right from the entry point other files use most, with its own camera; *Read as a story* in a feature level's header reads the whole feature. It is compiled by the `blueprint storyline` CLI verb with the TypeScript compiler and cached by content hash; the app hands the CLI its own TypeScript via `FLOW_TYPESCRIPT_PATH`. The derived graph still feeds briefs, proposal ghosts and coverage. The CLI `blueprint derive/render/observe/propose/context/sweep` verbs remain the write/read interface to the structure layer.

### `## Story` Step Metadata and the Change Brief

**Story Layer**: plans, discovery docs, and brainstorms can carry a `## Story` section (`### Step: <title>` blocks with `kicker`/`anchors`/`flow`+`flow_before`/`flow_after`/`phases`/`source`/`unchanged`/`decisions`/`rejected`/`questions`/`fails` metadata — grammar in `src/cli/blueprint/story-grammar.ts`) narrating a concept arc — problem → shape → data flow → decisions/why-nots → risks, capped at 5 steps. `planflow-ai blueprint narrate --from <doc> [--plan <name>] [--draft|--strict]` is the ONLY writer, compiling the section to the derived/disposable `flow/brain/.structure/story.json`; mode infers from path (`flow/plans/` → strict refuses on any unresolved anchor/flow-id/phase, nothing written; `flow/discovery/`+`flow/brainstorms/` → draft compiles anyway with unresolved gaps marked). `narrate --clear --plan <name>` removes the compiled story, run at plan-archive time so the board never shows a dead plan's story as live — the `## Story` markdown itself survives untouched in the archived plan doc. `planflow-ai blueprint brief --plan <name>` computes the **change brief** — the plan's Today ⇄ After delta, rendered natively on the board (the static `story.html` walkthrough it replaced is retired); the same compiled story also renders as an interactive card in the chat thread (auto-opens when a story exists, minimizable with per-thread memory; its board decoration and Blueprint button were retired 2026-10-08 with the discovery view) rather than a board side panel. This absorbed and retired the lavish visual-plan-review engine, and was itself absorbed by the change brief. Since 2026-10-08 plans no longer carry a `## Story`: `/create-plan` authors per-function change notes instead (see Plan Change Review below); discovery and brainstorm stories are unchanged, and older plans with a Story still compile strict. Before a doc even compiles, a chat-thread artifact card already tracks it — a watcher surfaces any `flow/{discovery,plans,brainstorms}/*.md` as a kind-labeled card (DISCOVERY / PLAN / BRAINSTORM; no story-status text — the `## Story` state stays internal) with a matching action (`Narrate` / `Ask agent`).

### The Territory, in Detail

**The sheet is the Territory.** A cell's AREA is size — the lines of code under its anchors at the root and on a domain (`size.lines`, a country summing its features), files below — packed squarified and sorted by size so shape reads as size; a country's label row says what it holds (`N features · M files · P% understood`), and diving flies one rectangle out to fill the sheet. There is no camera here at all: the map is packed into the measured stage, so it is always already fitted. A cell prints its learn dot and drift mark on the kicker row, its name at whatever tier its rectangle can hold (the tooltip and the accessible name survive every tier), and `N parts · M changes` only when it is roomy — a cell never loses its name because a *sibling* is crowded. Around the ground: a title strip (where you are, the understood percentage and its dial, *Ask the brain*), a foot (crumb trail, footer note, limitations disclosure), and the Learning lens — a line at the foot of a cell, never a fill.

**Where each kind comes from** — a distinction the first cut got backwards:

| Source | Kind | Why |
|--------|------|-----|
| Repo **surfaces** — route segments, API groups, `e2e/tests/<name>`, `features/`&nbsp;roots | `core` (a feature) | These are places a developer had to type a capability's name for the framework or test runner to work. A name is kept only when it appears in **≥2 distinct surface kinds** — that rule is what separates Playbooks (a page *and* a test suite) from `telemetry` (one API route). |
| The owning feature's `## Parts` section | `part` | The pieces a capability is made of, each with its own anchors and learnings. Written only via `blueprint features parts --feature <ref> --write <json>`; carries `partOf` (the owner's slug) so no consumer has to re-derive the kind. |
| Plan / discovery **corpus** | `child` (a change) | A plan names a *change to* a capability ("Chat Session Cache Rework"), never the capability. Parented to the core whose name it contains; unparented ones stay off the root level and are counted in the board footer, never dropped. |
| Top-level code dirs | `core` (a feature) | Fallback only, when neither surfaces nor corpus says anything. |

### The Three Populations in `flow/brain/features/`

`flow/brain/features/` holds **three** populations, and only the first is a feature:

| Population | Identified by | On the board |
|---|---|---|
| **Features** (`kind: core` / `kind: child`) | written by `feature-store.ts` | drawn — a capability, or a change carried for its parent link |
| **Auto-captured working sets** | a `thread_id` frontmatter key, or a `Working set for …` body | never drawn — one file per chat thread |
| **Brain-capture notes** | a `capture: brain` frontmatter key | never drawn — a note *about* a feature, written by the skills' Brain Capture step |

Every marker is **positive** — something the file HAS. Nothing is excluded for what it lacks, because a capability someone wrote by hand carries no marker either, and a rule keyed on absence would silently swallow it. A file whose `kind:` is missing or unreadable is therefore still **admitted and drawn**, with the guess declared in the board's limitations disclosure (`featureAdvisory`) so a person can correct the file — the documented correction mechanism. Before `capture: brain` existed, the notes were admitted *and* defaulted to `core`, which put two of them on a real project's board as capabilities beside Chats and Playbooks.

```bash
planflow-ai blueprint features discover              # mine surfaces + corpus, stage candidates
planflow-ai blueprint features confirm --all --kind core
planflow-ai blueprint features reclass               # re-level an existing store (explicit, never automatic)
planflow-ai blueprint features parts --feature <ref> --write <json>   # the ONLY writer of a feature's parts
planflow-ai blueprint features graph [--json]        # the board's data source (core + part + change)
planflow-ai blueprint coverage                       # what no feature claims
```

Correction is conversational and there is no confirmation gate: editing or deleting the markdown file **is** the correction mechanism, which is why no sweep may overwrite a human-owned field.

### The Workspace Level

**The Workspace level** (decision `flow/brain/decisions/workspace-blueprint.md`). Inside a Workspace of two or more projects the board's root is the **Workspace**: one country per project, sized by the lines its features stand on, each in its own colour (a fixed 8-hue palette per theme, slot = the project's position in `workspace.json`) with a gutter between countries, a header band (`N features · lines · % understood`) and an `N connections` chip. Pressing a project zooms into it — the project's own board, unchanged, with `Workspace / project / feature` crumbs (a sibling open in Flow becomes the active project and the board reopens inside it; any other is drawn read-only from the Workspace's shared knowledge, with an *Open this project* action when this computer has the checkout). **Connections** (off by default, remembered per viewer) draws one ribbon per pair of projects through the gutter, thickness and pill = link count; a pressed feature draws only its own short lines and the foot says them in words; inside a project its links run off the right edge, named. A Workspace of one opens on the project, the Workspace one crumb up. One CLI read is the source of all of it:

```bash
planflow-ai blueprint workspace graph [--target <repo>] [--workspace <w>] --json

## Backward Compatibility

- **Annotation records without `anchors` or `status` parse unchanged** — anchors default to empty, status defaults to `active`
- **`anchors` is optional everywhere it rides** — rounds entries and wave-context payloads without it behave exactly as before; they are simply never promoted
- **Missing or corrupt store files never throw** — readers return null/empty structures; corrupt individual JSONL lines are skipped, not fatal
- **The graph is fully reconstructable** — deleting `flow/brain/.structure/graph.json` (or the whole directory minus the JSONL stores) loses nothing; annotations (and investigation notes) are the precious data
- **Engine off → fully native** — derive, context, and render work without graphify; backbone/enrichment absence is silent when the engine is not enabled, and the dual-source set is purely additive (graph schema stays version 1)
- **Investigation store is optional** — a missing or corrupt `investigations.jsonl` never throws; readers return empty structures and `blueprint context` simply omits the `investigation` section
- **Proposal store is optional** — a missing or corrupt `proposals.jsonl` never throws; readers return empty results, the board renders no ghosts, and derive's confirm pass is a no-op
- **Story store is optional and fully disposable** — a missing or corrupt `story.json` never throws; `blueprint brief` refuses with a one-line reason, the board simply does not enter brief mode, and deleting it loses nothing because the precious copy is the doc's own `## Story` section
- **Docs without a `## Story` section are unaffected** — `narrate` on such a doc parses zero steps (no crash); older plans/discovery docs predating the Story Layer keep working exactly as before
- **No existing flow file formats changed** — `.rounds.jsonl` and `.wave-context.jsonl` envelopes are untouched apart from the optional `anchors` field
