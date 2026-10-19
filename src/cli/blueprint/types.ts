/**
 * Types for the blueprint system map (`flow/brain/.structure/`).
 *
 * These interfaces define the derived system graph (integrations, endpoints,
 * data stores, modules) produced by extractors on every run, plus the
 * append-only annotation stream that attaches plan-flow decisions/rules/claims
 * to symbol-level anchors. Structure comes only from extractors/graphify —
 * no LLM narration enters these shapes.
 */

/** Category of a node in the derived system graph. */
export type BlueprintNodeKind = 'integration' | 'endpoint' | 'datastore' | 'module';

/**
 * Optional extractor-provided metadata for a node.
 * Known enrichment fields are typed; extractors may attach additional
 * structured values under new keys.
 */
export interface BlueprintNodeMeta {
  /** Total edge count for this node (graphify enrichment). */
  degree?: number;
  /** Community/cluster identifier (graphify enrichment). */
  community?: string | number;
  /** Table names touched by a datastore node. */
  tables?: string[];
  /** HTTP method for an endpoint node (e.g. `GET`, `POST`). */
  method?: string;
  /** Route or path for an endpoint node. */
  route?: string;
  /** Folder-tree depth for a module node (1 = top-level source dir). */
  depth?: number;
  /** Count of emitted child module nodes for a module node. */
  childDirs?: number;
  /** Direct source files in a module node's directory (includes rolled-up files past the depth cap). */
  fileCount?: number;
  /** True on a depth-cap module node whose fileCount includes rolled-up deeper files. */
  rolledUp?: boolean;
  [key: string]: unknown;
}

/** A single node in the derived system graph. */
export interface BlueprintNode {
  /** Stable identifier, unique within the graph. */
  id: string;
  kind: BlueprintNodeKind;
  /** Human-readable display label. */
  label: string;
  /** Repo-relative path of the file the node was derived from. */
  sourceFile: string;
  /** Symbol name within the source file, when the node is symbol-level. */
  symbol?: string;
  meta?: BlueprintNodeMeta;
}

/** A directed relation between two graph nodes. */
export interface BlueprintEdge {
  /** `id` of the source node. */
  source: string;
  /** `id` of the target node. */
  target: string;
  /** Relation label (e.g. `imports`, `calls`, `reads`, `writes`). */
  relation: string;
}

/** The state of a never-initialized graphify graph's background build (#535). */
export type GraphifyBuildState = 'building' | 'failed';

/**
 * Coverage report for a derive run — how much of the codebase the
 * extractors actually saw, and whether graphify enrichment was applied.
 */
export interface BlueprintCoverage {
  /** Number of files scanned by extractors. */
  filesScanned: number;
  /** Total number of candidate files considered. */
  filesTotal: number;
  /** Names of the extractors that ran. */
  extractorsRun: string[];
  /** Whether graphify enrichment was applied (optional engine; false on native path). */
  graphifyEnriched: boolean;
  /**
   * Background code-graph build state when graphify is installed but this project
   * has no graph yet (#535): `'building'` while the first build runs, `'failed'`
   * if it overran without landing a graph. Absent once a graph exists or when
   * graphify is not installed. Drives the board's degraded-structure banner.
   */
  graphifyBuild?: GraphifyBuildState;
}

/** Severity of a must-review item, ordered most to least urgent. */
export type MustReviewSeverity = 'crit' | 'high' | 'ask' | 'info';

/**
 * One ranked entry in the "needs your eyes" list.
 * Computed at derive-time and persisted with the graph.
 */
export interface MustReviewItem {
  /** 1-based position in the ranked list (1 = most urgent). */
  rank: number;
  severity: MustReviewSeverity;
  title: string;
  detail: string;
  /** `id` of the related graph node, when the item is node-scoped. */
  nodeId?: string;
  /** What produced the item (e.g. extractor name, `review`, `annotation`). */
  source: string;
}

/**
 * The derived system graph persisted at `flow/brain/.structure/graph.json`.
 * Rebuilt in full on every derive run — never patched incrementally.
 */
export interface BlueprintGraph {
  /** Schema version of the graph file format. */
  version: number;
  /** ISO 8601 timestamp of the derive run that produced this graph. */
  derivedAt: string;
  /**
   * Absolute repo root the derive ran against (additive, version stays 1).
   * Two roots can reach one store through symlinked `flow/` directories, so
   * without this a derive from the wrong root clobbers the graph untraceably —
   * observed live when a vault root's empty derive erased a 70-node map.
   * Absent on graphs written before this field existed.
   */
  root?: string;
  coverage: BlueprintCoverage;
  nodes: BlueprintNode[];
  edges: BlueprintEdge[];
  /** Ranked "needs your eyes" items, computed at derive-time. */
  mustReview?: MustReviewItem[];
}

/** Granularity of an annotation anchor. */
export type AnchorKind = 'symbol' | 'file' | 'table' | 'endpoint' | 'module';

/**
 * A symbol-level attachment point for an annotation.
 * Lost anchors are stale-flagged via status events — never deleted.
 */
export interface Anchor {
  kind: AnchorKind;
  /** The anchored reference (symbol name, file path, table name, route, or module id). */
  ref: string;
  /** Repo-relative file path, when the anchor is narrower than a file. */
  file?: string;
}

/** Category of an annotation entry. */
export type AnnotationType = 'decision' | 'rule' | 'claim' | 'pin';

/** Effective lifecycle status of an annotation. */
export type AnnotationStatus = 'active' | 'stale';

/**
 * One record in the append-only `flow/brain/.structure/annotations.jsonl` stream.
 * Records without anchors parse unchanged (anchors default to empty).
 */
export interface AnnotationEntry {
  /** ISO 8601 timestamp of when the annotation was captured. */
  ts: string;
  /** Execution run identifier, or null when captured outside a run. */
  runId: string | null;
  type: AnnotationType;
  /** The annotation content itself. */
  text: string;
  anchors: Anchor[];
  /** Where the annotation came from (e.g. skill name, rounds entry, user pin). */
  provenance: string;
  status: AnnotationStatus;
}

/**
 * A status transition for an existing annotation, appended rather than
 * rewriting history. Targets an annotation by its fingerprint
 * (`<type>+<text>+<JSON array of sorted anchor refs>`).
 */
export interface AnnotationStatusEvent {
  /** ISO 8601 timestamp of the status change. */
  ts: string;
  /** Fingerprint of the annotation this event applies to. */
  targetFingerprint: string;
  status: AnnotationStatus;
  /** Why the status changed (e.g. `anchor lost: symbol renamed`). */
  reason: string;
}

/**
 * Epistemic status of an investigation entry — what was seen, whether a
 * later look confirmed it, or whether the evidence now points the other way.
 * Ambiguity is representable (`ambiguous` flag) — never coerced to fact.
 */
export type InvestigationStatus = 'observed' | 'corroborated' | 'contradicted';

/**
 * SHA-256 content stamp for one anchored file, taken at read time.
 * Lets later readers detect whether the anchored content has drifted since
 * the investigation entry was captured.
 */
export interface AnchorHashStamp {
  /** The anchored reference the stamp applies to (matches an anchor's `ref`). */
  ref: string;
  /** SHA-256 hex digest of the anchored file's content at read time. */
  contentHash: string;
}

/**
 * One investigation note in `flow/brain/.structure/investigations.jsonl`
 * (`kind: "note"` lines). Unlike annotations, investigation notes have a
 * SUPERSEDE/COMPACTION lifecycle: a later note may name an earlier note's
 * fingerprint in `supersedes`, and compaction drops superseded notes.
 * Written only via the mediated CLI command — never self-narrated.
 */
export interface InvestigationEntry {
  /** ISO 8601 timestamp of when the entry was captured. */
  ts: string;
  /** Execution run identifier, or null when captured outside a run. */
  runId: string | null;
  anchors: Anchor[];
  /** The investigation content itself. */
  text: string;
  /** Where the entry came from (e.g. skill name, observe command caller). */
  provenance: string;
  status: InvestigationStatus;
  /** True when the observation is ambiguous — leave it flagged, never guess. */
  ambiguous?: boolean;
  /** Content stamps of the anchored files at read time. */
  hashStamps: AnchorHashStamp[];
  /** Fingerprint of the entry this one replaces (supersede chain). */
  supersedes?: string;
}

/**
 * Aggregated visit counts for one anchor ref, folded from heat ticks on
 * read (and persisted as one aggregated line per ref by compaction —
 * total counts are never lost).
 */
export interface HeatCounter {
  /** The anchored reference the visits apply to. */
  anchorRef: string;
  /** Number of recorded human visits. */
  humanVisits: number;
  /** Number of recorded agent visits. */
  agentVisits: number;
  /** ISO 8601 timestamp of the most recent visit. */
  lastVisited: string;
}

/**
 * One raw visit event in `flow/brain/.structure/investigations.jsonl`
 * (`kind: "heat"` lines). Ticks aggregate into `HeatCounter`s on read.
 */
export interface HeatTick {
  /** ISO 8601 timestamp of the visit. */
  ts: string;
  /** The anchored reference that was visited. */
  anchorRef: string;
  /** Who visited the anchor. */
  visitor: 'human' | 'agent';
}

/**
 * Maximum number of steps surfaced from a compiled story (density rule,
 * D12/NFR4). Consumers (narrate, the board panel, the HTML walkthrough) cap
 * at this count and render an explicit "…and K more" line for the overflow —
 * this module never truncates silently.
 */
export const STORY_STEP_CAP = 5;

/**
 * Maximum number of chips (decision/rejected/question entries, anchors,
 * flow hops) surfaced per group in a compiled story step (density rule,
 * D12/NFR4). Same explicit-overflow discipline as `STORY_STEP_CAP`.
 */
export const STORY_CHIP_CAP = 6;

/**
 * One narrated step parsed from a `## Story` section (see
 * `src/cli/blueprint/story-grammar.ts` for the grammar and parser).
 *
 * `unresolvedAnchors` and `draft` are NOT populated by the parser — they are
 * filled in later by the compile pass (`blueprint narrate`), which resolves
 * `anchors` against the derived graph and the effective proposal set. The
 * parser always emits `unresolvedAnchors: []` and `draft: false`.
 */
export interface StoryStep {
  /** Deterministic id: kebab-slug of the title, with `-2`/`-3`… collision suffixes. */
  id: string;
  title: string;
  /** Short label shown above the title in the board panel. */
  kicker?: string;
  /** Free markdown body, preserved verbatim (trimmed) from the source doc. */
  body: string;
  /** Structural attachment points — reuses the existing `Anchor` envelope. */
  anchors: Anchor[];
  /**
   * Ordered node ids describing the flow-path overlay for this step.
   * ALIAS of `flowAfter` — kept so every consumer written before the change
   * brief (simulation, board, story sheet) reads the field it always read.
   */
  flow: string[];
  /**
   * Pre-change flow path — a claim about what exists TODAY, so it resolves
   * against the derived graph ONLY (ghosts are refused in strict mode).
   * Empty for docs that describe a single world.
   */
  flowBefore: string[];
  /** Post-change flow path — resolves against graph + proposals (ghosts allowed). */
  flowAfter: string[];
  /** Plan phase numbers this step narrates. */
  phases: number[];
  decisions: string[];
  rejected: string[];
  questions: string[];
  /**
   * How the change fails, from the user's side. AUTHORED — no extractor
   * produces this, and the verification ledger must label it unverifiable.
   */
  fails: string[];
  /**
   * The negative-space claim: what explicitly does NOT change. AUTHORED.
   * Absent is legal and warns (never refuses) on plan-mode compiles.
   */
  unchanged?: string;
  /** Optional free-text source reference (e.g. a doc link or file path). */
  source?: string;
  /** Anchors that failed to resolve against the graph/proposals (compile-time only). */
  unresolvedAnchors: string[];
  /** True when the step could not be fully anchored (compile-time only). */
  draft: boolean;
}

/**
 * The compiled story for one plan/discovery doc — the parser's output shape
 * before compile-time resolution fills in `unresolvedAnchors`/`draft` on each
 * step. `mode` mirrors FR3's draft/strict distinction (inferred from the
 * source doc location by the caller, not by this parser).
 */
export interface CompiledStory {
  /** Plan or feature name the story belongs to. */
  plan: string;
  /** Repo-relative path of the doc the `## Story` section was parsed from. */
  sourcePath: string;
  mode: 'draft' | 'strict';
  steps: StoryStep[];
  /** Human-readable parse warnings — malformed blocks/fields are skipped, never silently. */
  warnings: string[];
}

// ── change simulation (blueprint-simulation) ──────────────────────────────
//
// The kind of change a plan makes to a node, DERIVED from how its anchor
// resolves — never predicted. This is the honesty spine of the simulation:
// the board only claims what resolution can prove.
//
//   'modify' — the anchor resolved to an existing graph node (it's there today)
//   'new'    — the anchor resolved to a ghost/proposal (it doesn't exist yet)
//   'remove' — NOT produced by `computeTouchedSets`: an anchor says "this step
//              touches that node", never "this step deletes it". It IS produced
//              by `computeBriefDelta` (`brief-model.ts`) from a before/after
//              flow pair — `flowBefore` minus `flowAfter`. That is sound because
//              `flow_before` resolves against the derived graph alone (ghosts
//              refused), so a node named there is provably present today; absent
//              from every after-path, it is provably gone. Derived, not guessed.

/** How a plan changes a touched node — derived from anchor resolution. */
export type TouchedChangeKind = 'modify' | 'new' | 'remove';

/** One node a plan phase touches, with the change-kind derived from its anchor. */
export interface TouchedNode {
  /** The resolved graph-node id (existing node) or ghost predictedNodeId. */
  nodeId: string;
  kind: TouchedChangeKind;
  /** The story anchor that resolved to this node (provenance). */
  anchor: Anchor;
}

/** The union of nodes a single plan phase touches (predicted, per-phase). */
export interface TouchedSet {
  phase: number;
  touched: TouchedNode[];
}
