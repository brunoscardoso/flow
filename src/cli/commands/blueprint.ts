/**
 * Blueprint CLI command
 *
 * `blueprint derive` — rebuilds the system map at `flow/brain/.structure/graph.json`
 * from the native extractors (plus the graphify backbone merge and enrichment
 * when the graphify engine is enabled — dual-source), then relinks
 * annotations and promotes anchored run records.
 *
 * `blueprint context <node>` — emits capped JSON context for one graph node:
 * the node itself, its direct edges with neighbor labels, and the effective
 * annotations anchored to it.
 *
 * `blueprint render` — renders the derived graph, annotations, and run
 * timeline into the self-contained title sheet at
 * `flow/brain/.structure/blueprint.html` (deterministic template — no narration).
 *
 * `blueprint observe` — the ONLY write path into the investigation store
 * (`flow/brain/.structure/investigations.jsonl`): heat ticks (always accepted) and
 * investigation notes (validated — anchors must parse and resolve, anchored
 * files are hash-stamped, an anchor already carrying active notes REFUSES
 * the write unless the entry corroborates or supersedes-with-reason, and a
 * supersede pointer that would close a cycle is refused at write time).
 * Derive additionally runs the store's threshold-gated compaction
 * (`maybeCompactInvestigations`) as its maintenance step.
 *
 * `blueprint propose` — the ONLY write path into the proposal store
 * (`flow/brain/.structure/proposals.jsonl`): records predicted graph nodes
 * ("ghosts") named by a plan, and `--decide accepted|rejected` decision
 * events against them. Predicted ids are validated against the extractor id
 * grammar; recording is silent (no board, no graph required — terminal
 * fallback is a silent record). graph.json is never touched — ghost→real
 * confirmation happens mechanically in derive: after relink/promotion, every
 * effective `proposed|accepted` proposal whose EXACT predictedNodeId exists
 * in the freshly derived graph gets a `confirmed` event (provenance
 * `derive:confirm`), reported as `proposals: N confirmed` when N > 0.
 *
 * `blueprint sweep --plan <p>` — end-of-plan proposal maintenance for one
 * plan: `accepted` (accepted-unbuilt) and `proposed` (undecided) proposals
 * are staled, `rejected` proposals are cleared; terminal/swept states
 * (confirmed/stale/cleared) are untouched, so a double sweep is idempotent.
 * Production caller: the execute-plan archive step (Step 8 skill wiring,
 * documented in Phase 6) invokes this when a plan is archived.
 *
 * Structure comes only from extractors/graphify — no LLM narration. Output is
 * deterministic for the same inputs.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative as relative_, resolve } from 'node:path';
import { fileMatchesNode, resolveAnchor } from '../blueprint/anchors.js';
import { mergeGraphifyBackbone, type BackboneResult } from '../blueprint/backbone.js';
import { readMustReviewAcks } from '../blueprint/mustreview-acks.js';
import { buildSurface, writeSurface, readSiblingSurfaces } from '../blueprint/surface.js';
import { WorkspaceRefusal, workspaceContextOf } from '../handlers/workspace-model.js';
import { linkFromSide, readWorkspaceLinks } from '../handlers/workspace-links.js';
import { extractOutbound, writeOutbound } from '../blueprint/extractors/outbound.js';
import { emitCodeCards } from '../blueprint/extractors/code-cards.js';
import { appendCrossLinkEvents, crossDriftItems, matchAgainstSurface, readCrossLinks, reconcileCrossLinks } from '../blueprint/cross-links.js';
import { getVaultDir } from '../utils/files.js';
import { runExtractors } from '../blueprint/extractors/index.js';
import { enrichWithGraphify } from '../blueprint/graphify-enrich.js';
import {
  appendHeatTick,
  appendInvestigationNote,
  investigationFingerprint,
  maybeCompactInvestigations,
  readInvestigations,
  wouldCreateSupersedeCycle,
} from '../blueprint/investigation-store.js';
import { promoteRunRecords } from '../blueprint/promote.js';
import { computeBriefDelta, computeFeatureBrief } from '../blueprint/brief-model.js';
import { bootstrapFeatures, confirmCandidate, describeBootstrap } from '../blueprint/feature-bootstrap.js';
import {
  excerptFreshness,
  healFeatureView,
  inspectFeatureViews,
  readFeatureView,
  writeFeatureView,
  type FeatureView,
  type ViewCode,
} from '../blueprint/feature-view.js';
import { buildCorpusIndex, readCorpusIndex, writeCorpusIndex, type CorpusDocRecord } from '../blueprint/corpus-index.js';
import { discoverFeatures, readCandidates, writeCandidates } from '../blueprint/feature-discover.js';
import { buildFeatureGraph, buildFeatureIndexMarkdown, buildFeatureRoster, computeCoverage, FEATURE_INDEX_RELPATH, moduleOfAnchor, resolveAnchors } from '../blueprint/feature-graph.js';
import { readPartsBySlug, readProjectFeatureGraphPrefetched } from '../blueprint/feature-graph-read.js';
import { buildWorkspaceGraph, describeWorkspaceGraph } from '../blueprint/workspace-graph.js';
import { featureNodeIds } from '../blueprint/brief-model.js';
import { computeDocTouches, siblingResolution } from '../blueprint/doc-touches.js';
import { anchorTarget } from '../blueprint/feature-size.js';
import {
  describeEdge,
  findFeatureByRef,
  mintFeatureId,
  sameFeatureId,
  parseLearnings,
  edgeKey,
  readFeatures,
  splitLearned,
  writeLearned,
  type Learning,
  reclassFeatures,
  seedDomains,
  seedFeatures,
  writeFeature,
  type FeatureDomainSeed,
  type FeatureReclass,
  readParts,
  writeParts,
  writeEdges,
  type FeatureEdge,
  type FeaturePart,
  type FeatureNode,
} from '../blueprint/feature-store.js';
import { describeForget, forgetLearning } from '../blueprint/forget-learning.js';
import { deriveFeatureMap } from '../blueprint/feature-map.js';
import { canonicalKey, mineSurfaces, parentKeyFor } from '../blueprint/feature-surfaces.js';
import { parseFlowItem } from '../blueprint/story-grammar.js';
import { computeTouchedSets, phaseCoverageGaps } from '../blueprint/simulation-model.js';
import { ensureBaselineFresh, readSimulationBaseline } from '../blueprint/simulation-baseline.js';
import { reconcile, surpriseNodes, type ActualTouched } from '../blueprint/reconcile-model.js';
import { resolveStoryAnchors } from '../blueprint/anchors.js';
import { readRoundsEntries } from '../state/rounds-reader.js';
import { hashPlanContent } from '../state/run-compiler.js';
import { parsePlan } from '../state/plan-parser.js';
import {
  appendProposalEvent,
  attachProposals,
  confirmableProposals,
  countProposals,
  formatProposalsRecorded,
  formatProposalsStaled,
  formatProposeRefusal,
  proposalsForFeature,
  proposalsWithMissingSource,
  readEffectiveProposals,
  readProposalSourceIndex,
  readProposalsWithChange,
  validateProposalDecision,
  validateProposalRecord,
  type EffectiveProposal,
  type ProposalEvent,
  type ProposalKind,
  type ProposalWithChange,
} from '../blueprint/proposal-store.js';
import { relinkAnnotations } from '../blueprint/relink.js';
import { computeStaleCheckReport, computeStaleEdges, staleEdgeKeys } from '../blueprint/stale-check.js';
import { runStorylineVerb } from '../blueprint/storyline-verb.js';
import { storylineCacheDir, warmProjectImportIndex } from '../blueprint/storyline-imports.js';
import { requestImportIndexWarm } from '../blueprint/storyline-index-warm.js';
import { StorylineReaders } from '../blueprint/storyline-reader.js';
import { runFeaturePortsVerb } from '../blueprint/feature-ports.js';
import { runFeatureHomeVerb } from '../blueprint/feature-home.js';
import { runFeatureRoleVerb } from '../blueprint/feature-learned-role.js';
import { computeDrift } from '../blueprint/drift-check.js';
import { advanceFileStamps, computeFileStamps, establishFileStampsIfMissing, readFileStamps, stampEdgeVias, writeFileStamps, type FileStamp } from '../blueprint/file-stamps.js';
import { walkRepo } from '../blueprint/extractors/scan.js';
import { computeFileTiers, readFileTiers, recordVerdict,
  type VerdictClaim,
  type VerdictProvenance, TIER_VERDICT_KINDS, tierTallies, verdictIsStale, writeFileTiers } from '../blueprint/file-tiers.js';
import { promoteDoc } from '../blueprint/verify-doc.js';
import type { TierVerdictKind } from '../blueprint/file-tiers.js';
import {
  clearCompiledStory,
  compileStory,
  derivePlanName,
  inferMode,
  readCompiledStory,
  writeCompiledStory,
  type StoryMode,
} from '../blueprint/story-compile.js';
import { layoutTitleSheet } from '../blueprint/render/layout.js';
import { computeMustReview, parseRoundsFile, readRoundsRecords } from '../blueprint/render/must-review.js';
import { renderProseReport } from '../blueprint/render/prose-report.js';
import { renderBlueprintHtml, type RenderTimelineEntry } from '../blueprint/render/template.js';
import { BLUEPRINT_DIRNAME, BLUEPRINT_GRAPH_DISPLAY_PATH, ensureBlueprintDir, hashRepoFile, isValidAnchor, readAnnotations, readGraph, writeGraph } from '../blueprint/store.js';
import type {
  Anchor,
  AnchorHashStamp,
  AnchorKind,
  AnnotationEntry,
  BlueprintGraph,
  BlueprintNode,
  CompiledStory,
  HeatCounter,
  InvestigationEntry,
  InvestigationStatus,
} from '../blueprint/types.js';
import { validateCanonicalGraph } from '../blueprint/validate.js';

/** Schema version written into `graph.json`. */
const GRAPH_VERSION = 1;

/** Hard cap on `blueprint context` output (~1500 tokens). Never exceeded. */
const CONTEXT_CHAR_CAP = 4500;

/**
 * Display cap on `meta.graphifyIds` in context output. The FULL set stays in
 * graph.json (anchor resolution needs it — see graphify-enrich.ts); this is
 * pure display capping so a symbol-dense folder node's id list cannot crowd
 * the node's edges and annotations out of the capped context.
 */
const CONTEXT_GRAPHIFY_ID_CAP = 8;

/** Display cap on investigation notes in `blueprint context` output. */
const INVESTIGATION_CONTEXT_NOTE_CAP = 5;

/** The five anchor granularities accepted by `blueprint observe`. */
const OBSERVE_ANCHOR_KINDS: readonly AnchorKind[] = ['symbol', 'file', 'table', 'endpoint', 'module'];

/** Visitor kinds accepted by `--visit`. */
const OBSERVE_VISITORS: ReadonlyArray<'agent' | 'human'> = ['agent', 'human'];

/** Fingerprints shown in the contradiction refusal (never the full list). */
const CONTRADICTION_FINGERPRINT_PREVIEW = 3;

/** Provenance recorded when the caller supplies none. */
const DEFAULT_OBSERVE_PROVENANCE = 'blueprint observe';

const JSON_INDENT = 2;

/** Filename of the prose report inside `<flowDir>/brain/` (brain-indexed). */
const PROSE_REPORT_FILENAME = 'blueprint-report.md';

/**
 * Run the full derive pipeline against a repo root and return the report
 * lines to print (deterministic ordering). Shared by the CLI action and the
 * post-init hook. Throws when `<repoRoot>/flow` does not exist, when the
 * derived graph violates the canonical contract (hard error — the thrown
 * message lists EVERY violation, one per line, and nothing is written:
 * graph.json/graph.prev.json stay untouched, relink/promotion never run), or
 * when a zero-file scan would overwrite a non-empty graph (see the guard
 * below; `options.force` overrides).
 */
export function deriveBlueprint(
  repoRoot: string,
  runId: string | null,
  options: { force?: boolean } = {},
): string[] {
  const flowDir = join(repoRoot, 'flow');
  if (!existsSync(flowDir)) {
    throw new Error(`No flow/ directory found at ${flowDir} — run \`planflow-ai init\` first`);
  }

  // ONE repo walk for the whole derive pipeline: extractors, convention
  // packs, spine discovery, file tiers, file stamps, and code cards all
  // consume this shared scan instead of re-walking the tree (~10 walks
  // before). The walk is sorted, so determinism is unchanged.
  const repoScan = walkRepo(repoRoot);

  const extraction = runExtractors(repoRoot, repoScan);
  const nativeGraph: BlueprintGraph = {
    version: GRAPH_VERSION,
    derivedAt: new Date().toISOString(),
    // Root provenance: two roots can share one store through symlinked flow/
    // directories, and without this a wrong-root derive is untraceable.
    root: resolve(repoRoot),
    coverage: extraction.coverage,
    nodes: extraction.nodes,
    edges: extraction.edges,
  };

  // Backbone BEFORE enrichment: when the graphify engine is enabled and its
  // graph loads, graphify modules/deps become a structural SOURCE (the merge
  // sets coverage.extractorsRun to the dual-source set — otherwise the native
  // set is left untouched). Enrichment then adds degree/community metrics on
  // top, covering synthesized backbone modules too.
  //
  // Always-on (#142): backbone + enrichment always run. When graphify isn't
  // installed both no-op and enrichment surfaces a single native-only notice —
  // there is no consent/pending gate anymore.
  const backbone: BackboneResult = mergeGraphifyBackbone(nativeGraph, repoRoot);
  if (backbone.ignoredSynthesisFileCount > 0) {
    // No-silent-caps (#901): name what the ignore vocabulary kept off the map.
    extraction.coverageNotes.push(
      `backbone: ${backbone.ignoredSynthesisFileCount} file(s) in ignored dirs (dot-dirs/mocks/tests/public) excluded from synthesized modules`,
    );
  }
  const enriched = enrichWithGraphify(repoRoot, backbone.graph);
  const graph = enriched.graph;
  const notice = enriched.notice;
  // Surface the background code-graph build state (#535) in coverage so the board
  // can show a "structure limited — building…/build failed" banner rather than a
  // silent near-empty sheet. Absent once a graph exists (the common case).
  if (enriched.build !== undefined) {
    graph.coverage.graphifyBuild = enriched.build;
  }

  // Must-review baseline: graph.json still holds the PREVIOUS derive at this
  // point — writeGraph below rotates it to graph.prev.json. Rounds signals
  // apply only when the current run id is known (null → graph signals only).
  const prevGraph = readGraph(flowDir);

  // Wrong-root guard: a derive that saw NO candidate files AND produced an
  // EMPTY graph is a scan of the wrong place, not a refreshed map. Observed
  // live: a vault root symlinked to the same flow/ store as its code repo ran
  // its first-provision derive and replaced a 70-node graph with an empty one —
  // every learning surface then read "no modules" for a week. Both conditions
  // matter: a python-only repo also scans 0 "source" files but still derives
  // its folder spine, and a first derive or genuinely empty repo has no
  // non-empty previous graph to protect.
  if (options.force !== true && graph.coverage.filesTotal === 0 && graph.nodes.length === 0 && prevGraph !== null && prevGraph.nodes.length > 0) {
    const prevOrigin =
      typeof prevGraph.root === 'string' && prevGraph.root !== resolve(repoRoot)
        ? ` (it was derived from ${prevGraph.root})`
        : '';
    throw new Error(
      `derive refused: scanned 0 candidate files under ${resolve(repoRoot)}, but the existing graph carries ${prevGraph.nodes.length} node(s)${prevOrigin} — this derive is likely running from the wrong root, so nothing was written. Re-run from the repo root, or pass --force to overwrite.`,
    );
  }
  const currentRounds =
    runId === null ? [] : readRoundsRecords(flowDir).filter((record) => record.run_id === runId);
  // Acked items never resurface (#910 follow-up): "Mark reviewed" appends the
  // item's title to mustreview-acks.jsonl; filtering here makes acknowledgment
  // durable instead of hostage to graph.prev rotation timing.
  const ackedTitles = readMustReviewAcks(join(flowDir, 'brain', '.structure'));
  // Cross-drift (federation Phase 4): confirmed cross-links checked against
  // sibling surfaces join the same ranked list — and the same ack filter.
  let crossDrift: ReturnType<typeof crossDriftItems> = [];
  try {
    crossDrift = crossDriftItems(
      readCrossLinks(join(flowDir, 'brain', '.structure')),
      readSiblingSurfaces(getVaultDir(), repoRoot).surfaces,
    );
  } catch {
    crossDrift = []; // fail-soft — federation issues never break a derive
  }
  const ranked = computeMustReview({ graph, prevGraph, rounds: currentRounds });
  graph.mustReview = [
    ...ranked,
    ...crossDrift.map((item, index) => ({ ...item, rank: ranked.length + index + 1 })),
  ].filter((item) => !ackedTitles.has(item.title));

  // Canonical contract gate — the ONE exception to fail-soft (plan decision:
  // hard-error, not warn-and-write). An invalid graph is never persisted: the
  // previous graph.json/graph.prev.json stay untouched and relink/promotion
  // never run against it. All violations surface at once, one per line.
  const validation = validateCanonicalGraph(graph);
  if (!validation.ok) {
    throw new Error(
      validation.errors
        .map((violation) => `canonical contract violation: ${violation}`)
        .join('\n'),
    );
  }

  writeGraph(flowDir, graph);

  // Federation (cross-project-blueprint Phase 1): publish this project's
  // exposed surface beside the graph — through the vault symlink this lands in
  // ~/plan-flow/brain/projects/<name>/, where sibling derives match against it.
  // repoPath rides inside the file, so a sibling refresh needs no registry.
  {
    const structureDir = join(flowDir, 'brain', '.structure');
    const surfaceNote = writeSurface(structureDir, buildSurface(graph, repoRoot));
    if (surfaceNote !== null) {
      extraction.coverageNotes.push(surfaceNote);
    }
    // Consumer half (Phase 2): what this project calls elsewhere — the
    // sidecar the federation matcher pairs against sibling surfaces.
    const { outbound, coverageNotes: outboundNotes } = extractOutbound(repoRoot);
    extraction.coverageNotes.push(...outboundNotes);
    const outboundNote = writeOutbound(structureDir, outbound);
    if (outboundNote !== null) {
      extraction.coverageNotes.push(outboundNote);
    }
    // Federation matching (Phase 3): pair this project's outbound calls with
    // every sibling's published surface; fresh matches PROPOSE cross-links,
    // confirmed links whose source call vanished go stale. Fail-soft (NFR2).
    try {
      const { surfaces, skipped } = readSiblingSurfaces(getVaultDir(), repoRoot);
      const allMatches = surfaces.flatMap((sibling) => matchAgainstSurface(outbound, sibling));
      const reconciled = reconcileCrossLinks(readCrossLinks(structureDir), allMatches, outbound, new Date().toISOString());
      appendCrossLinkEvents(structureDir, reconciled.events);
      if (surfaces.length > 0 || skipped.length > 0) {
        extraction.coverageNotes.push(
          `cross-links: ${allMatches.length} match(es) across ${surfaces.length} sibling(s) — ${reconciled.autoConfirmedCount} auto-confirmed, ${reconciled.proposedCount} proposed, ${reconciled.shapeOnlyCount} shape-only (not linked), ${reconciled.staleCount} gone stale` +
            (skipped.length > 0 ? ` · skipped: ${skipped.join(', ')}` : ''),
        );
      }
    } catch (error) {
      extraction.coverageNotes.push(
        `cross-links: matching skipped (${error instanceof Error ? error.message : String(error)})`,
      );
    }
  }

  // Full-graph drift BASELINE (Phase 1): stamp the source file of every node so
  // `blueprint drift-check` can detect a change to a never-learned module, not
  // just files carried by narrated investigation notes. Established ONCE — never
  // clobbered on re-derive, so a change that already drifted survives a derive
  // after a pull (`drift-reset`/`drift-ack` are the only ways to advance the
  // last-seen reference). Fail-soft (sanctioned): the write swallows I/O errors,
  // a stamp failure must never fail an otherwise-successful derive.
  establishFileStampsIfMissing(repoRoot, flowDir, graph, repoScan);

  // Stat pre-filter hints for the passes below (forbidden-pattern #10
  // discipline): the baseline's stamps carry mtime+size taken at hash time —
  // a file whose stat still matches its OWN stamp may reuse the stamp's
  // stored hash without a read; any mismatch re-hashes content (the truth).
  const stampHints = new Map<string, FileStamp>();
  for (const stamp of readFileStamps(flowDir)?.stamps ?? []) {
    stampHints.set(stamp.path, stamp);
  }

  // Trust-tier sidecar (trust-tiers Phase 1): classify every repo file into
  // code/own/claim/other. Unlike the drift baseline's establish-once, the tier
  // map RECOMPUTES on every derive — classification is derived/disposable;
  // what is precious (claim-file adjudication verdicts) merges forward inside
  // `computeFileTiers`, and a changed doc voids its verdict. Fail-soft
  // (sanctioned): a tier failure must never fail an otherwise-successful
  // derive (`writeFileTiers` additionally swallows its own I/O errors).
  try {
    writeFileTiers(flowDir, computeFileTiers(repoRoot, graph, readFileTiers(flowDir), { repoScan, stampHints }));
  } catch {
    // Sanctioned fail-soft: derive proceeds without a fresh tier map — the
    // `tiers` verb keeps reading the last-known-good store.
  }

  // Code cards + symbol sidecar (brain-first-retrieval Phase 1): the eager
  // per-file code-knowledge layer — one markdown card per module under
  // `flow/brain/code/` (part of the searched markdown corpus) plus
  // `symbols.jsonl` for exact-name lookup. Hash-gated through `hashRepoFile`
  // (the one hashing path), so an unchanged repo regenerates nothing. Both
  // outputs are derived/disposable. Fail-soft (sanctioned): a card failure
  // becomes a one-line notice and never fails an otherwise-successful derive.
  try {
    extraction.coverageNotes.push(...emitCodeCards(repoRoot, flowDir, { repoScan, stampHints }));
  } catch (error) {
    extraction.coverageNotes.push(
      `code-cards: skipped (${error instanceof Error ? error.message : String(error)})`,
    );
  }

  const relink = relinkAnnotations(flowDir, graph);
  const promotion = promoteRunRecords(flowDir, runId);

  // Ghost→real confirmation (Phase 3 wiring): derive is the named production
  // caller of the confirm pass. MECHANICAL only — an effective
  // `proposed|accepted` proposal (any plan) is confirmed when its EXACT
  // predictedNodeId exists among the fresh graph's node ids; no fuzzy match,
  // no LLM judgment. The confirmed event re-carries the proposal's payload so
  // every store line stays self-describing. Fail-soft (sanctioned): lock
  // contention or a store I/O error skips the remainder silently — derive
  // never fails on proposal maintenance; confirmations already appended
  // before the failure still count.
  let confirmedCount = 0;
  try {
    const confirmTs = new Date().toISOString();
    // PER-KIND, because there is more than one graph. The extractor kinds are
    // matched against the graph just derived; a `part` never appears there at
    // all — it is built from a feature's `## Parts` markdown — so matching one
    // against `graph.json` could only ever miss, leaving every proposed part
    // unconfirmed until the next sweep quietly staled it while this line went
    // on reporting a healthy derive. The id sets differ; the match does not.
    const sources = {
      graphNodeIds: new Set(graph.nodes.map((node) => node.id)),
      partNodeIds: readPartNodeIds(flowDir),
    };
    for (const proposal of confirmableProposals(readEffectiveProposals(flowDir), sources)) {
      appendProposalEvent(flowDir, proposalLifecycleEvent(proposal, 'confirmed', confirmTs, DERIVE_CONFIRM_PROVENANCE));
      confirmedCount += 1;
    }
  } catch {
    // Sanctioned fail-soft: proposal store busy/unreadable — confirm pass skipped this derive
  }

  // Investigation-store maintenance (C3 wiring): derive is the named
  // production caller of compaction. `maybeCompactInvestigations` compacts
  // only past its thresholds (COMPACT_DROPPED_RATIO / COMPACT_MIN_BYTES) and
  // preserves totals — non-superseded notes and aggregated heat counts are
  // never lost. Fail-soft (sanctioned): lock contention or an I/O error
  // skips maintenance silently — never fails an otherwise-successful derive.
  let compactionLine: string | null = null;
  try {
    const compaction = maybeCompactInvestigations(flowDir);
    if (compaction !== null) {
      const folded =
        compaction.notesDropped + (compaction.heatLinesBefore - compaction.heatLinesAfter);
      compactionLine = `compaction: ${folded} folded`;
    }
  } catch {
    // Sanctioned fail-soft: store busy/locked — skipped this derive, line omitted
  }

  // FIRST-RUN FEATURE BOOTSTRAP (feature-blueprint): the board's level 1 is
  // features, so a project whose store was never bootstrapped opens on an
  // empty board telling the user to go run a CLI verb — which is not an answer
  // for someone who just added a project in the IDE.
  //
  // `init` already did this, but IDE-managed projects never call init: they are
  // provisioned and derived. DERIVE is the one path every entry point shares,
  // so the adoption belongs here rather than duplicated per caller
  // (allowed-pattern #14).
  //
  // EMPTY STORE ONLY. This adopts; it never re-adopts. Running it on every
  // derive would resurrect a feature the user deliberately deleted — and the
  // feature files are PRECIOUS (semantic tier), so derive gets exactly one
  // chance to seed them and no license to keep rewriting.
  //
  // Fail-soft (sanctioned): bootstrapping must never fail an otherwise-good
  // derive.
  let featureLine: string | null = null;
  try {
    if (readFeatures(flowDir).length === 0) {
      const bootstrap = bootstrapFeatures(
        repoRoot,
        flowDir,
        join(flowDir, 'brain', '.structure'),
        graph,
      );
      // Report only when something was actually adopted. A repo that names no
      // capability has nothing to say here, and saying it on every first derive
      // would put a line in front of every plain repo forever — the empty board
      // already explains itself. This is not a silent cap: nothing was skipped,
      // there was nothing to find.
      if (bootstrap.cores > 0 || bootstrap.adopted > 0) {
        featureLine = describeBootstrap(bootstrap);
      }
    }
  } catch (error) {
    featureLine = `features: bootstrap skipped (${error instanceof Error ? error.message : String(error)})`;
  }

  // Prose report AFTER the graph/relink/promotion writes succeed — a brain-
  // indexed markdown bridge at flow/brain/blueprint-report.md. Fail-soft
  // (sanctioned): a write failure appends a one-line notice instead of
  // failing an otherwise-successful derive.
  let proseReportLine: string;
  try {
    const brainDir = join(flowDir, 'brain');
    mkdirSync(brainDir, { recursive: true });
    writeFileSync(join(brainDir, PROSE_REPORT_FILENAME), renderProseReport(graph), 'utf-8');
    proseReportLine = `prose report: flow/brain/${PROSE_REPORT_FILENAME}`;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    proseReportLine = `prose report: skipped (${message})`;
  }

  // The generated feature index, rebuilt with the rest of the derived layer.
  // It belongs HERE and not on its own schedule for the reason every derived
  // artifact does: an index rebuilt at a different moment than the graph is an
  // index that can disagree with it, and a search answering from a projection
  // nobody refreshed is exactly the "quietly finds less" failure this whole
  // change is being measured against. Fail-soft (sanctioned) and SILENT on
  // success — the derive tail is a fixed-order line list callers read
  // positionally, so a new line on the happy path would shift every one of them.
  let featureIndexLine: string | null = null;
  try {
    writeFeatureIndex(flowDir, readFeatures(flowDir));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    featureIndexLine = `feature index: skipped (${message})`;
  }

  const lines: string[] = [];
  if (notice !== null) {
    lines.push(notice);
  }
  lines.push(...extraction.coverageNotes);
  if (backbone.notice !== null) {
    lines.push(backbone.notice);
  } else if (backbone.merged) {
    lines.push(
      `backbone: graphify modules merged (${backbone.synthesizedModuleCount} synthesized module(s), ${backbone.crossModuleEdgeCount} cross-module edge(s))`,
    );
  }
  // ABOVE the summary block on purpose. The trailing lines (graph → must-review
  // → relink → promotion → [compaction] → [proposals] → prose report) are a
  // documented fixed-order tail that callers and tests read positionally;
  // slipping a conditional line into it shifts everything below by one. The
  // bootstrap is an aside about a first run, not part of that summary.
  if (featureLine !== null) {
    lines.push(featureLine);
  }
  // Same region, same reason: a failure notice is an aside, and the tail below
  // is positional.
  if (featureIndexLine !== null) {
    lines.push(featureIndexLine);
  }
  lines.push('validation: ok');
  lines.push(
    `graph: ${graph.nodes.length} node(s), ${graph.edges.length} edge(s) → ${BLUEPRINT_GRAPH_DISPLAY_PATH}`,
  );
  lines.push(`must-review: ${graph.mustReview.length} item(s)`);
  lines.push(`relink: ${relink.staled} staled, ${relink.recovered} recovered`);
  lines.push(`promotion: ${promotion.promoted} promoted, ${promotion.skipped} skipped`);
  if (compactionLine !== null) {
    lines.push(compactionLine);
  }
  // Conditional like `compaction:` — omitted when nothing confirmed, so the
  // existing tail-order assertions (…relink, promotion, prose report) hold.
  if (confirmedCount > 0) {
    lines.push(`proposals: ${confirmedCount} confirmed`);
  }
  lines.push(proseReportLine);
  return lines;
}

/**
 * Whether an anchor references a graph node. An anchor matches when its ref
 * equals the node id (raw or kind-prefixed, mirroring `resolveAnchor`), the
 * node symbol, the node source file, or one of the node's datastore tables.
 * File refs and symbol-anchor `file` scopes use `fileMatchesNode` containment
 * (exact `sourceFile`, or under a module node's directory).
 *
 * Mirrored by the app workspace in
 * `app/src/renderer/blueprint/annotation-matching.ts` — keep in sync.
 */
function anchorReferencesNode(anchor: Anchor, node: BlueprintNode): boolean {
  if (anchor.ref === node.id || `${anchor.kind}:${anchor.ref}` === node.id) {
    return true;
  }
  // Legacy module-id bridge (mirrors `resolveAnchor`): module ids are
  // path-based (`module:src/cli`) but old anchors carry the basename
  // (`cli`) — the basename is now the node's label
  if (anchor.kind === 'module' && node.kind === 'module' && anchor.ref === node.label) {
    return true;
  }
  if (node.symbol !== undefined && anchor.ref === node.symbol) {
    return true;
  }
  if (anchor.kind === 'file' && fileMatchesNode(anchor.ref, node)) {
    return true;
  }
  if (anchor.file !== undefined && fileMatchesNode(anchor.file, node)) {
    return true;
  }
  if (anchor.ref === node.sourceFile) {
    return true;
  }
  const tables = node.meta?.tables;
  return Array.isArray(tables) && tables.includes(anchor.ref);
}

/**
 * Find the context target node: exact id match first, then case-insensitive
 * substring match on id/label (first match in the graph's stable node order).
 */
function findNode(
  graph: BlueprintGraph,
  query: string,
): { node: BlueprintNode; otherMatches: string[] } | null {
  const exact = graph.nodes.find((node) => node.id === query);
  if (exact !== undefined) {
    return { node: exact, otherMatches: [] };
  }

  const lowered = query.toLowerCase();
  const matches = graph.nodes.filter(
    (node) =>
      node.id.toLowerCase().includes(lowered) || node.label.toLowerCase().includes(lowered),
  );
  if (matches.length === 0) {
    return null;
  }
  return { node: matches[0], otherMatches: matches.slice(1).map((node) => node.id) };
}

/** One direct edge of the context node, with the neighbor's display label. */
interface ContextEdgeView {
  source: string;
  target: string;
  relation: string;
  neighborLabel: string;
}

/** Collect the node's direct edges with neighbor labels, in graph edge order. */
function collectEdgeViews(graph: BlueprintGraph, node: BlueprintNode): ContextEdgeView[] {
  const labelById = new Map(graph.nodes.map((candidate) => [candidate.id, candidate.label]));
  const views: ContextEdgeView[] = [];
  for (const edge of graph.edges) {
    if (edge.source !== node.id && edge.target !== node.id) {
      continue;
    }
    const neighborId = edge.source === node.id ? edge.target : edge.source;
    views.push({
      source: edge.source,
      target: edge.target,
      relation: edge.relation,
      neighborLabel: labelById.get(neighborId) ?? neighborId,
    });
  }
  return views;
}

/** The mandatory drill-down hint appended whenever output is truncated. */
function truncationHint(droppedCount: number): string {
  return `… and ${droppedCount} more — run \`planflow-ai blueprint context <other-node>\` or open ${BLUEPRINT_GRAPH_DISPLAY_PATH} for detail`;
}

/**
 * The node as shown in context output: `meta.graphifyIds` capped at
 * `CONTEXT_GRAPHIFY_ID_CAP` with an explicit `graphifyIdsMore` overflow count
 * — never a silent cut. Matching (edges, annotations) always uses the full
 * node; this view is display-only.
 */
function contextNodeView(node: BlueprintNode): BlueprintNode {
  const ids = node.meta?.graphifyIds;
  if (!Array.isArray(ids) || ids.length <= CONTEXT_GRAPHIFY_ID_CAP) {
    return node;
  }
  return {
    ...node,
    meta: {
      ...node.meta,
      graphifyIds: ids.slice(0, CONTEXT_GRAPHIFY_ID_CAP),
      graphifyIdsMore: ids.length - CONTEXT_GRAPHIFY_ID_CAP,
    },
  };
}

/**
 * Whether a heat counter's anchor ref references a graph node. Heat ticks
 * carry a bare ref with no anchor kind, so the ref is tried under every
 * anchor kind against the same matching rules annotations use.
 */
function heatCounterReferencesNode(counter: HeatCounter, node: BlueprintNode): boolean {
  return OBSERVE_ANCHOR_KINDS.some((kind) =>
    anchorReferencesNode({ kind, ref: counter.anchorRef }, node),
  );
}

/** Section a context item belongs to, in truncation priority order. */
type ContextSection = 'annotations' | 'investigationNotes' | 'workspaceLinks' | 'investigationHeat' | 'edges';

/** One cross-project link touching a node, read from the node's own side. */
interface ContextWorkspaceLink {
  kind: string;
  /** This project's end — what matched the node. */
  own: string;
  /** The sibling project's end (`<project>/<ref>`). */
  other: string;
  note?: string;
  author: string | null;
  ts: string;
}

/**
 * The Workspace links whose THIS-project end is an anchor referencing the node
 * (workspaces-knowledge-hub Phase 5): the backend endpoint's context names the
 * frontend screen that consumes it, with the note someone left. Empty outside a
 * Workspace — and fail-soft, like every other context section.
 */
function workspaceLinksForNode(repoRoot: string, node: BlueprintNode): ContextWorkspaceLink[] {
  const status = workspaceContextOf(repoRoot);
  if (status === null || status.workspace === null || status.project === null) return [];
  const selfSlug = status.project.slug;
  const out: ContextWorkspaceLink[] = [];
  for (const link of readWorkspaceLinks(status.workspace.path).links) {
    const side = linkFromSide(link, selfSlug);
    if (side === null || side.own.type !== 'anchor' || side.own.anchorKind === undefined || side.own.anchorRef === undefined) continue;
    if (!anchorReferencesNode({ kind: side.own.anchorKind, ref: side.own.anchorRef }, node)) continue;
    out.push({
      kind: side.kind,
      own: side.own.ref,
      other: side.other.address,
      ...(link.note === undefined ? {} : { note: link.note }),
      author: link.author,
      ts: link.ts,
    });
  }
  return out;
}

/**
 * Emit capped JSON context for one node. Truncation drops whole ITEMS from
 * the end of the priority order — annotations outrank investigation notes,
 * which outrank heat counters, which outrank edges (annotations and notes are
 * the precious narrated layers; heat and edges are re-derivable from their
 * stores), so edges fall away first and annotations last. Investigation notes
 * are additionally pre-capped at the `INVESTIGATION_CONTEXT_NOTE_CAP` most
 * recent with an explicit `notesMore` overflow count — never a silent cut.
 * Every char-cap drop is surfaced by the mandatory drill-down hint — never a
 * silent mid-JSON cut. The node itself is never cut. Returns the process
 * exit code.
 */
function emitContext(flowDir: string, query: string, repoRoot: string = dirname(flowDir)): number {
  const graph = readGraph(flowDir);
  if (graph === null) {
    process.stdout.write('no blueprint — run `planflow-ai blueprint derive` first\n');
    return 1;
  }

  const found = findNode(graph, query);
  if (found === null) {
    process.stdout.write(
      `no node matching '${query}' — open ${BLUEPRINT_GRAPH_DISPLAY_PATH} for the full node list\n`,
    );
    return 1;
  }

  const edgeViews = collectEdgeViews(graph, found.node);
  const annotations = readAnnotations(flowDir).filter((entry: AnnotationEntry) =>
    entry.anchors.some((anchor) => anchorReferencesNode(anchor, found.node)),
  );

  // Investigation layer: active (fold-on-read) notes anchored to the node,
  // pre-capped at the most recent N (store order is ts-ascending, so the
  // tail slice is the most recent), plus the node's aggregated heat counters.
  const investigations = readInvestigations(flowDir);
  const matchingNotes = investigations.notes.filter((note) =>
    note.anchors.some((anchor) => anchorReferencesNode(anchor, found.node)),
  );
  const cappedNotes = matchingNotes.slice(-INVESTIGATION_CONTEXT_NOTE_CAP);
  const notesMore = matchingNotes.length - cappedNotes.length;
  const matchingHeat = investigations.heat.filter((counter) =>
    heatCounterReferencesNode(counter, found.node),
  );
  const linkedAcross = workspaceLinksForNode(repoRoot, found.node);

  // Items in priority order. Truncation removes from the END of this list,
  // so edges drop first, then heat, then notes, then trailing annotations.
  const orderedItems: Array<{ section: ContextSection; item: unknown }> = [
    ...annotations.map((item) => ({ section: 'annotations' as const, item })),
    ...cappedNotes.map((item) => ({ section: 'investigationNotes' as const, item })),
    ...linkedAcross.map((item) => ({ section: 'workspaceLinks' as const, item })),
    ...matchingHeat.map((item) => ({ section: 'investigationHeat' as const, item })),
    ...edgeViews.map((item) => ({ section: 'edges' as const, item })),
  ];

  for (let includedCount = orderedItems.length; ; includedCount -= 1) {
    const output: Record<string, unknown> = { node: contextNodeView(found.node) };
    if (found.otherMatches.length > 0) {
      output.note = `ambiguous match — also matched: ${found.otherMatches.join(', ')}`;
    }
    const itemsBySection: Record<ContextSection, unknown[]> = {
      annotations: [],
      investigationNotes: [],
      workspaceLinks: [],
      investigationHeat: [],
      edges: [],
    };
    for (let index = 0; index < includedCount; index += 1) {
      itemsBySection[orderedItems[index].section].push(orderedItems[index].item);
    }
    if (itemsBySection.annotations.length > 0) {
      output.annotations = itemsBySection.annotations;
    }
    if (itemsBySection.investigationNotes.length > 0 || itemsBySection.investigationHeat.length > 0) {
      const investigation: Record<string, unknown> = {};
      if (itemsBySection.investigationNotes.length > 0) {
        investigation.notes = itemsBySection.investigationNotes;
      }
      if (notesMore > 0) {
        investigation.notesMore = notesMore;
      }
      if (itemsBySection.investigationHeat.length > 0) {
        investigation.heat = itemsBySection.investigationHeat;
      }
      output.investigation = investigation;
    }
    if (itemsBySection.workspaceLinks.length > 0) {
      output.workspaceLinks = itemsBySection.workspaceLinks;
    }
    if (itemsBySection.edges.length > 0) {
      output.edges = itemsBySection.edges;
    }

    const droppedCount = orderedItems.length - includedCount;
    const hint = droppedCount > 0 ? `\n${truncationHint(droppedCount)}` : '';
    let body = JSON.stringify(output, null, JSON_INDENT);
    if (body.length + hint.length <= CONTEXT_CHAR_CAP) {
      process.stdout.write(`${body}${hint}\n`);
      return 0;
    }

    if (includedCount === 0) {
      // Node alone exceeds the cap with pretty-printing — fall back to
      // compact serialization rather than exceeding the hard cap.
      body = JSON.stringify(output);
      process.stdout.write(`${body}${hint}\n`);
      return 0;
    }
  }
}

/** Filename of the rendered title sheet inside `<flowDir>/brain/.structure/`. */
const BLUEPRINT_HTML_FILENAME = 'blueprint.html';

/** Archived rounds files: `rounds_<plan>.jsonl` under `<flowDir>/archive/`. */
const ARCHIVED_ROUNDS_PATTERN = /^rounds_(.+)\.jsonl$/;

/**
 * Read the previous derive from `graph.prev.json`, mirroring `readGraph`
 * fail-soft semantics: missing/corrupt/shape-invalid → null, never throw.
 */
function readPrevGraph(flowDir: string): BlueprintGraph | null {
  const filePath = join(flowDir, BLUEPRINT_DIRNAME, 'graph.prev.json');
  if (!existsSync(filePath)) {
    return null;
  }
  try {
    const content = readFileSync(filePath, 'utf-8').trim();
    if (content.length === 0) {
      return null;
    }
    const parsed = JSON.parse(content) as BlueprintGraph;
    if (!Array.isArray(parsed.nodes) || !Array.isArray(parsed.edges)) {
      return null;
    }
    return parsed;
  } catch {
    // Corrupt previous graph — render proceeds without a delta baseline
    return null;
  }
}

/** The last non-empty `run_id` in a rounds file, or null when none exists. */
function lastRunIdOf(records: ReturnType<typeof parseRoundsFile>): string | null {
  let lastRunId: string | null = null;
  for (const record of records) {
    if (typeof record.run_id === 'string' && record.run_id.length > 0) {
      lastRunId = record.run_id;
    }
  }
  return lastRunId;
}

/**
 * Build the run timeline: archived rounds files (sorted by filename, labeled
 * by plan name) followed by the current run from `.rounds.jsonl` when its
 * run id is derivable — the template marks the last entry as current.
 */
function buildTimeline(flowDir: string): RenderTimelineEntry[] {
  const entries: RenderTimelineEntry[] = [];

  const archiveDir = join(flowDir, 'archive');
  let archiveFiles: string[] = [];
  try {
    archiveFiles = readdirSync(archiveDir).sort();
  } catch {
    // No archive directory — timeline starts at the current run
  }
  for (const fileName of archiveFiles) {
    const match = ARCHIVED_ROUNDS_PATTERN.exec(fileName);
    if (match === null) {
      continue;
    }
    entries.push({
      runId: lastRunIdOf(parseRoundsFile(join(archiveDir, fileName))) ?? '—',
      label: match[1],
    });
  }

  const currentRunId = lastRunIdOf(readRoundsRecords(flowDir));
  if (currentRunId !== null) {
    entries.push({ runId: currentRunId, label: 'current' });
  }
  return entries;
}

/** Project display name: package.json `name`, else the repo dir basename. */
function readProjectName(repoRoot: string): string {
  try {
    const parsed = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf-8')) as {
      name?: unknown;
    };
    if (typeof parsed.name === 'string' && parsed.name.length > 0) {
      return parsed.name;
    }
  } catch {
    // Missing/unparsable package.json — fall through to the dir basename
  }
  return basename(repoRoot);
}

/**
 * Render the title sheet to `<flowDir>/brain/.structure/blueprint.html` from the
 * persisted graph, annotations, and run timeline. Deterministic for the same
 * on-disk inputs. Returns the process exit code.
 */
function emitRender(repoRoot: string): number {
  const flowDir = join(repoRoot, 'flow');
  const graph = readGraph(flowDir);
  if (graph === null) {
    process.stdout.write('no blueprint — run `planflow-ai blueprint derive` first\n');
    return 1;
  }

  const html = renderBlueprintHtml({
    graph,
    prevGraph: readPrevGraph(flowDir),
    annotations: readAnnotations(flowDir),
    layout: layoutTitleSheet(graph),
    projectName: readProjectName(repoRoot),
    planContext: null, // future wiring: plan lifecycle context
    timeline: buildTimeline(flowDir),
  });

  const outputPath = join(ensureBlueprintDir(flowDir), BLUEPRINT_HTML_FILENAME);
  writeFileSync(outputPath, html, 'utf-8');
  process.stdout.write(`blueprint: ${join('flow', BLUEPRINT_DIRNAME, BLUEPRINT_HTML_FILENAME)}\n`);
  return 0;
}




// ── observe ──────────────────────────────────────────────

/** CLI options accepted by the blueprint command (observe/propose add most). */
export interface BlueprintCommandOptions {
  runId?: string;
  /** workspace graph: the repo whose Workspace to map (default: the working directory). */
  target?: string;
  /** workspace graph: which Workspace, when the repo is in more than one. */
  workspace?: string;
  /** derive: overwrite a non-empty graph even when the scan saw zero files. */
  force?: boolean;
  note?: string;
  anchor?: string[];
  status?: string;
  reason?: string;
  supersedes?: string;
  ambiguous?: boolean;
  /** observe: drop unresolvable EXTRA anchors instead of refusing, as long as
   *  at least one anchor resolves (learn passes — a decorative symbol anchor
   *  must never sink the module note). Dropped anchors are printed, never silent. */
  lenientAnchors?: boolean;
  /** observe: which anchors the contradiction rule considers — `any` (default,
   *  every anchor) or `primary` (the identity anchor only, for learn writes
   *  whose decorative anchors legitimately overlap other notes). */
  conflictScope?: string;
  /** link/unlink: the sibling project name. */
  project?: string;
  /** link/unlink: `<METHOD> /path` or `query Name`. */
  endpoint?: string;
  visit?: string;
  /**
   * Dual duty: observe's inline JSON entry payload (a string), OR
   * stale-check's JSON-output flag (`true` when passed bare, no value).
   */
  json?: string | boolean;
  /** `--dry-run` — report what WOULD change, write nothing (features seed). */
  dryRun?: boolean;
  /** `--all` — act on every staged candidate (features confirm). */
  all?: boolean;
  /** `--feature <id|slug>` — scope the brief to a feature instead of a plan. */
  feature?: string;
  /** Repeatable JSON learning entry (`features learned` only). */
  entry?: string | string[];
  /** JSON array of proposed `relates` edges (`features learned` only). */
  relates?: string;
  /** JSON view artifact to validate + persist (`features view` only). */
  write?: string;
  plan?: string;
  /** `--expired` — sweep every plan whose source doc is gone (sweep only). */
  expired?: boolean;
  node?: string;
  kind?: string;
  label?: string;
  detail?: string;
  phase?: string;
  decide?: string;
  from?: string;
  draft?: boolean;
  strict?: boolean;
  clear?: boolean;
  story?: boolean;
  /** Module path filter (stale-check only). */
  module?: string;
  /** Comma-separated repo-relative paths to acknowledge (drift-ack only). */
  paths?: string;
  /** Repo-relative doc path being adjudicated (adjudicate only). */
  path?: string;
  /** Adjudication outcome: corroborated|contradicted|unverifiable (adjudicate only). */
  verdict?: string;
  /** Comma-separated code paths the verdict was verified against (adjudicate only). */
  against?: string;
  /** Per-claim JSON payload (adjudicate/verify-doc — doc-verification). */
  claimsJson?: string;
  /** Verdict origin: user|learn-pass|verify-agent|auto (adjudicate only). */
  provenance?: string;
  /** One-line evidence note recorded with the verdict (adjudicate only). */
  evidence?: string;
  /** storyline: the project file to read as a story. */
  file?: string;
  /** features home: the project folder to pin as the feature's home. */
  folder?: string;
  /** storyline: the feature or part whose files to read as one story; features role: the part, by name. */
  part?: string;
  /** features role: the role a learn pass decided. */
  learned?: string;
  /** storyline --plan: the plan's starting commit, when the caller names it. */
  base?: string;
}

/** How the new entry relates to any existing notes on its anchors. */
type ObserveIntent = 'observed' | 'corroborates' | 'supersedes';

/** A validated observe request, normalized from flags or `--json`. */
interface ObserveRequest {
  text: string;
  anchors: Anchor[];
  intent: ObserveIntent;
  supersedes: string | null;
  reason: string | null;
  ambiguous: boolean;
  runId: string | null;
  provenance: string;
}

/** Refuse an observe write: one-line reason on stderr, exit code 1, nothing written. */
function refuseObserve(reason: string): number {
  process.stderr.write(`observe refused: ${reason}\n`);
  return 1;
}

/**
 * Parse one `--anchor <kind>:<ref>` flag value. Returns null when the value
 * has no `kind:ref` shape or the kind is not one of the five anchor kinds.
 * The ref keeps any further colons (endpoint refs like `GET /users` never
 * contain one, but symbol ids may).
 */
function parseAnchorFlag(value: string): Anchor | null {
  const separator = value.indexOf(':');
  if (separator <= 0 || separator === value.length - 1) {
    return null;
  }
  const kind = value.slice(0, separator);
  if (!OBSERVE_ANCHOR_KINDS.includes(kind as AnchorKind)) {
    return null;
  }
  const ref = value.slice(separator + 1);
  // `symbol:<file>#<name>` form: split so the resolver's file fallback can
  // resolve the anchor (a bare joined ref matches neither node.symbol nor a
  // graphify id and would sink the whole observe write — live-E2E finding,
  // run progressive-learning-20260715-234855). Symbol-kind only; `#` in
  // other kinds stays part of the ref.
  if (kind === 'symbol') {
    const hash = ref.indexOf('#');
    if (hash > 0 && hash < ref.length - 1) {
      return { kind: 'symbol', ref: ref.slice(hash + 1), file: ref.slice(0, hash) };
    }
  }
  return { kind: kind as AnchorKind, ref };
}

/**
 * Normalize a status value into an observe intent. Accepts the flag forms
 * (`observed|corroborates|supersedes`) plus the entry-status spelling
 * `corroborated` on the `--json` path. Returns null for anything else.
 */
function parseObserveIntent(value: string): ObserveIntent | null {
  if (value === 'observed' || value === 'corroborates' || value === 'supersedes') {
    return value;
  }
  if (value === 'corroborated') {
    return 'corroborates';
  }
  return null;
}

/**
 * Build an `ObserveRequest` from the `--json` payload. The payload carries
 * the whole entry (plus an optional top-level `reason` mirroring `--reason`)
 * and runs through the SAME validation pipeline as flags — no bypass.
 * Returns a refusal reason string instead of a request when the payload is
 * structurally invalid.
 */
function requestFromJson(payload: string, options: BlueprintCommandOptions): ObserveRequest | string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return 'invalid --json payload — not parseable JSON';
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return 'invalid --json payload — expected a JSON object';
  }
  const record = parsed as Record<string, unknown>;
  if (typeof record.text !== 'string' || record.text.length === 0) {
    return 'invalid --json payload — a non-empty "text" is required';
  }

  const anchors: Anchor[] = [];
  const rawAnchors = Array.isArray(record.anchors) ? record.anchors : [];
  for (const candidate of rawAnchors) {
    if (!isValidAnchor(candidate)) {
      return `invalid anchor ${JSON.stringify(candidate)} — expected {kind, ref} with kind in ${OBSERVE_ANCHOR_KINDS.join('|')}`;
    }
    anchors.push(candidate);
  }

  let intent: ObserveIntent = 'observed';
  if (record.status !== undefined) {
    if (typeof record.status !== 'string') {
      return 'invalid --json payload — "status" must be a string';
    }
    const parsedIntent = parseObserveIntent(record.status);
    if (parsedIntent === null) {
      return `invalid status '${record.status}' — expected observed|corroborates|supersedes`;
    }
    intent = parsedIntent;
  }

  const supersedes = typeof record.supersedes === 'string' ? record.supersedes : null;
  const reason = typeof record.reason === 'string' ? record.reason : (options.reason ?? null);
  return {
    text: record.text,
    anchors,
    intent,
    supersedes: supersedes ?? options.supersedes ?? null,
    reason,
    ambiguous: record.ambiguous === true || options.ambiguous === true,
    runId: typeof record.runId === 'string' ? record.runId : (options.runId ?? null),
    provenance:
      typeof record.provenance === 'string' && record.provenance.length > 0
        ? record.provenance
        : DEFAULT_OBSERVE_PROVENANCE,
  };
}

/** Build an `ObserveRequest` from plain flags, or a refusal reason string. */
function requestFromFlags(options: BlueprintCommandOptions): ObserveRequest | string {
  const anchors: Anchor[] = [];
  for (const raw of options.anchor ?? []) {
    const anchor = parseAnchorFlag(raw);
    if (anchor === null) {
      return `invalid anchor '${raw}' — expected <kind>:<ref> with kind in ${OBSERVE_ANCHOR_KINDS.join('|')}`;
    }
    anchors.push(anchor);
  }

  let intent: ObserveIntent = 'observed';
  if (options.status !== undefined) {
    const parsedIntent = parseObserveIntent(options.status);
    if (parsedIntent === null) {
      return `invalid --status '${options.status}' — expected observed|corroborates|supersedes`;
    }
    intent = parsedIntent;
  }

  return {
    text: options.note ?? '',
    anchors,
    intent,
    supersedes: options.supersedes ?? null,
    reason: options.reason ?? null,
    ambiguous: options.ambiguous === true,
    runId: options.runId ?? null,
    provenance: DEFAULT_OBSERVE_PROVENANCE,
  };
}

/**
 * Append heat ticks in heat-only mode (`observe` without `--note`/`--json`).
 * Heat is NEVER refused by the contradiction rule — the only failure modes
 * are malformed input (missing anchors, bad `--visit`). Returns the exit code.
 */
function runHeatOnlyObserve(flowDir: string, options: BlueprintCommandOptions): number {
  const anchors: Anchor[] = [];
  for (const raw of options.anchor ?? []) {
    const anchor = parseAnchorFlag(raw);
    if (anchor === null) {
      return refuseObserve(
        `invalid anchor '${raw}' — expected <kind>:<ref> with kind in ${OBSERVE_ANCHOR_KINDS.join('|')}`,
      );
    }
    anchors.push(anchor);
  }
  if (anchors.length === 0) {
    return refuseObserve('heat observation requires at least one --anchor <kind:ref>');
  }
  const visitor = options.visit ?? 'agent';
  if (!OBSERVE_VISITORS.includes(visitor as 'agent' | 'human')) {
    return refuseObserve(`invalid --visit '${visitor}' — expected agent|human`);
  }

  const ts = new Date().toISOString();
  for (const anchor of anchors) {
    appendHeatTick(flowDir, { ts, anchorRef: anchor.ref, visitor: visitor as 'agent' | 'human' });
  }
  process.stdout.write(`observed: heat +${anchors.length} anchor(s)\n`);
  return 0;
}

/**
 * `blueprint observe` — the mediated write path into the investigation store.
 *
 * Heat-only mode (no `--note`/`--json`) appends one HeatTick per anchor and
 * is always accepted. Note mode runs the validation pipeline in order —
 * anchors parse, graph exists and every anchor resolves, anchored files
 * hash-stamp, contradiction rule (BOUND DECISION, strict refuse: an anchor
 * already carrying active notes refuses the write unless the entry
 * corroborates or supersedes-with-reason; `--conflict-scope primary` narrows
 * "an anchor" to the identity anchor) — and any failure exits 1 with a
 * one-line `observe refused: <reason>` on stderr with NOTHING written.
 * Returns the process exit code.
 */
function runObserve(repoRoot: string, options: BlueprintCommandOptions): number {
  const flowDir = join(repoRoot, 'flow');

  if (options.note === undefined && options.json === undefined) {
    return runHeatOnlyObserve(flowDir, options);
  }
  // `--json` is shared with stale-check's bare boolean flag (see
  // `BlueprintCommandOptions.json`) — observe always requires an inline
  // payload string.
  if (options.json !== undefined && typeof options.json !== 'string') {
    return refuseObserve('--json requires an inline JSON payload');
  }

  const request =
    options.json !== undefined ? requestFromJson(options.json, options) : requestFromFlags(options);
  if (typeof request === 'string') {
    return refuseObserve(request);
  }
  if (request.text.length === 0) {
    return refuseObserve('a note requires non-empty --note text');
  }
  if (request.anchors.length === 0) {
    return refuseObserve('a note requires at least one --anchor <kind:ref>');
  }

  // Supersede intent is coherent regardless of which flag expressed it.
  if (request.intent === 'supersedes' && request.supersedes === null) {
    return refuseObserve('--status supersedes requires --supersedes <fingerprint>');
  }
  if (request.supersedes !== null && request.reason === null) {
    return refuseObserve('--supersedes requires --reason "<why>"');
  }
  const conflictScope = options.conflictScope ?? 'any';
  if (conflictScope !== 'any' && conflictScope !== 'primary') {
    return refuseObserve(`invalid --conflict-scope '${conflictScope}' — expected any|primary`);
  }

  // Every anchor must resolve against the CURRENT graph. With
  // --lenient-anchors, unresolvable ones are DROPPED (loudly) as long as at
  // least one anchor survives — a learn pass's decorative symbol anchors must
  // never sink the module note it exists to write.
  const graph = readGraph(flowDir);
  if (graph === null) {
    return refuseObserve('no blueprint graph — run `planflow-ai blueprint derive` first');
  }
  if (options.lenientAnchors === true) {
    // The FIRST anchor is the note's IDENTITY (the module/node the note is
    // about); the rest are decoration. Leniency applies to decoration ONLY —
    // dropping the identity anchor writes an orphan note that no re-learn can
    // ever find to supersede, which the contradiction rule then refuses
    // forever (live orbit-app failure 2026-07-30: `module:endpoint:GET
    // /api/...` never resolved, so the endpoint could not be re-learned).
    const identity = request.anchors[0];
    if (!resolveAnchor(identity, graph)) {
      return refuseObserve(
        `identity anchor '${identity.kind}:${identity.ref}' does not resolve against the blueprint graph — run \`planflow-ai blueprint derive\``,
      );
    }
    const resolvable = request.anchors.filter((anchor) => resolveAnchor(anchor, graph));
    const dropped = request.anchors.filter((anchor) => !resolveAnchor(anchor, graph));
    if (resolvable.length === 0) {
      return refuseObserve(
        `none of the ${request.anchors.length} anchor(s) resolve against the blueprint graph — run \`planflow-ai blueprint derive\``,
      );
    }
    if (dropped.length > 0) {
      process.stdout.write(
        `observe: dropped ${dropped.length} unresolvable anchor(s): ${dropped
          .map((anchor) => `${anchor.kind}:${anchor.ref}`)
          .join(', ')}\n`,
      );
    }
    request.anchors = resolvable;
  } else {
    for (const anchor of request.anchors) {
      if (!resolveAnchor(anchor, graph)) {
        return refuseObserve(
          `anchor '${anchor.kind}:${anchor.ref}' does not resolve against the blueprint graph — run \`planflow-ai blueprint derive\``,
        );
      }
    }
  }

  // Hash-stamp every file-backed anchor with the file content as of NOW.
  // Containment (W1): a symbol anchor can resolve by symbol name alone, so
  // its caller-supplied `file` field is never validated by graph resolution —
  // `hashRepoFile` resolves the path and requires it to stay under the repo
  // root before reading, otherwise the stamp becomes a hash oracle over
  // arbitrary files. Shared with `blueprint stale-check`'s re-hash pass
  // (allowed-pattern #14) — the ONE file-hashing code path.
  // The identity anchor (see the lenient block above) survives every drop
  // path, so it is stable for the contradiction rule's `primary` scope.
  const identityAnchor = request.anchors[0];
  const hashStamps: AnchorHashStamp[] = [];
  const stampFailed: string[] = [];
  for (const anchor of request.anchors) {
    const relPath = anchor.kind === 'file' ? anchor.ref : anchor.kind === 'symbol' ? anchor.file : undefined;
    if (relPath === undefined) {
      continue;
    }
    const hashResult = hashRepoFile(repoRoot, relPath);
    if (hashResult.status === 'escapes') {
      // Containment violations refuse even in lenient mode — an escaping path
      // is a caller bug worth failing loudly, never a droppable garnish.
      return refuseObserve(
        `anchor file '${relPath}' escapes the repository root — refusing to hash-stamp`,
      );
    }
    if (hashResult.status === 'missing') {
      // With --lenient-anchors an unstampable EXTRA anchor (directory path,
      // deleted file — live learn failure 2026-07-24: 'src/types/ontology')
      // is dropped like an unresolvable one, as long as an anchor survives.
      // The identity anchor is never droppable (an orphan note can never be
      // superseded) — it refuses even in lenient mode.
      if (options.lenientAnchors === true && anchor !== identityAnchor) {
        stampFailed.push(`${anchor.kind}:${anchor.ref}`);
        continue;
      }
      return refuseObserve(`file '${relPath}' is missing — cannot hash-stamp anchor '${anchor.ref}'`);
    }
    hashStamps.push({ ref: anchor.ref, contentHash: hashResult.contentHash });
  }
  if (stampFailed.length > 0) {
    const failedSet = new Set(stampFailed);
    request.anchors = request.anchors.filter(
      (anchor) => !failedSet.has(`${anchor.kind}:${anchor.ref}`),
    );
    if (request.anchors.length === 0) {
      return refuseObserve(
        `none of the anchor(s) could be hash-stamped — nothing to attach the note to`,
      );
    }
    process.stdout.write(
      `observe: dropped ${stampFailed.length} unstampable anchor(s): ${stampFailed.join(', ')}\n`,
    );
  }

  // CONTRADICTION RULE — active notes sharing ANY anchor ref with the entry.
  //
  // `--conflict-scope primary` narrows that to the IDENTITY anchor only. Notes
  // that merely share a decorative anchor are about a DIFFERENT subject and
  // never contradict this one: a learn note for `module:src/app/addins`
  // legitimately anchors files its parent `module:src/app` note also anchors,
  // and bare symbol refs (`GET`, `main`) collide across unrelated modules —
  // under the default scope those collisions refused first-time learns
  // outright (live orbit-app failure 2026-07-30).
  const activeNotes = readInvestigations(flowDir).notes;
  const newRefs =
    conflictScope === 'primary'
      ? new Set([identityAnchor.ref])
      : new Set(request.anchors.map((anchor) => anchor.ref));
  const conflicting = activeNotes.filter((note) => note.anchors.some((anchor) => newRefs.has(anchor.ref)));

  let status: InvestigationStatus = 'observed';
  let text = request.text;
  let supersedes: string | undefined;
  if (conflicting.length > 0) {
    const conflictFingerprints = conflicting.map((note) => investigationFingerprint(note));
    if (request.supersedes !== null) {
      // The target must be a LIVE note — but not necessarily one of the
      // conflicting ones. Superseding a note that shares no anchor with this
      // entry is the healing path for orphaned notes (e.g. a pre-fix learn
      // note written without its identity anchor), and the no-conflict branch
      // below already keeps such pointers verbatim.
      const isActiveTarget = activeNotes.some(
        (note) => investigationFingerprint(note) === request.supersedes,
      );
      if (!isActiveTarget) {
        return refuseObserve(
          `--supersedes '${request.supersedes}' does not match any active note on these anchors (existing fingerprints: ${conflictFingerprints.slice(0, CONTRADICTION_FINGERPRINT_PREVIEW).join(', ')})`,
        );
      }
      supersedes = request.supersedes;
      text = `${text} [supersedes: ${request.reason}]`;
    } else if (request.intent === 'corroborates') {
      status = 'corroborated';
    } else {
      const conflictRefs = new Set(
        conflicting.flatMap((note) => note.anchors.map((anchor) => anchor.ref)),
      );
      const sharedRef =
        request.anchors.find((anchor) => conflictRefs.has(anchor.ref))?.ref ?? request.anchors[0].ref;
      return refuseObserve(
        `anchor '${sharedRef}' already carries ${conflicting.length} active note(s) — pass --status corroborates, or --supersedes <fingerprint> --reason "<why>" (existing fingerprints: ${conflictFingerprints.slice(0, CONTRADICTION_FINGERPRINT_PREVIEW).join(', ')})`,
      );
    }
  } else {
    // No prior notes on any shared anchor — accept as-is. A corroborates flag
    // with nothing to corroborate is honored and noted on stdout below; a
    // supersede pointer targeting a note on OTHER anchors is kept verbatim.
    if (request.intent === 'corroborates') {
      status = 'corroborated';
    }
    if (request.supersedes !== null) {
      supersedes = request.supersedes;
      text = `${text} [supersedes: ${request.reason}]`;
    }
  }

  // CYCLE GUARD (C1 write-time half): a supersede pointer whose target chain
  // walks back to THIS entry's fingerprint would close a cycle — the naive
  // fold would then hide every member. Refuse at write time; the fold's
  // cycle tolerance only exists for pre-existing bad data.
  if (supersedes !== undefined) {
    const entryFingerprint = investigationFingerprint({ text, anchors: request.anchors });
    if (wouldCreateSupersedeCycle(flowDir, entryFingerprint, supersedes)) {
      return refuseObserve(
        `--supersedes '${supersedes}' would create a supersede cycle back to this note — restate the note so its text differs, or supersede the newest note in the chain`,
      );
    }
  }

  // All validations passed — the ONLY writes happen from here on.
  const ts = new Date().toISOString();
  const entry: InvestigationEntry = {
    ts,
    runId: request.runId,
    anchors: request.anchors,
    text,
    provenance: request.provenance,
    status,
    hashStamps,
  };
  if (request.ambiguous) {
    entry.ambiguous = true;
  }
  if (supersedes !== undefined) {
    entry.supersedes = supersedes;
  }
  appendInvestigationNote(flowDir, entry);
  for (const anchor of request.anchors) {
    appendHeatTick(flowDir, { ts, anchorRef: anchor.ref, visitor: 'agent' });
  }

  const suffix =
    conflicting.length === 0 && request.intent === 'corroborates'
      ? ' — no prior notes to corroborate'
      : '';
  process.stdout.write(
    `observed: note ${investigationFingerprint(entry)} (${status}) on ${request.anchors.length} anchor(s)${suffix}\n`,
  );
  return 0;
}

// ── propose ──────────────────────────────────────────────

/** Provenance recorded on every event written by `blueprint propose`. */
const PROPOSE_PROVENANCE = 'cli:propose';

/** Provenance recorded on `confirmed` events appended by derive's confirm pass. */
const DERIVE_CONFIRM_PROVENANCE = 'derive:confirm';

/** Provenance recorded on every event written by `blueprint sweep`. */
const SWEEP_PROVENANCE = 'cli:sweep';

/** The two decisions `--decide` accepts. */
const PROPOSAL_DECISIONS: ReadonlyArray<'accepted' | 'rejected'> = ['accepted', 'rejected'];

/**
 * Build a lifecycle event against an existing effective proposal, re-carrying
 * its payload (kind/label/detail/phase/anchors) so every store line is
 * self-describing — the fold ignores the re-carried payload in favor of the
 * first `proposed` event's. Shared by decide, derive's confirm pass, and sweep.
 */
function proposalLifecycleEvent(
  proposal: EffectiveProposal,
  eventName: ProposalEvent['event'],
  ts: string,
  provenance: string,
): ProposalEvent {
  const event: ProposalEvent = {
    ts,
    plan: proposal.plan,
    predictedNodeId: proposal.predictedNodeId,
    kind: proposal.kind,
    label: proposal.label,
    event: eventName,
    provenance,
  };
  if (proposal.phase !== undefined) {
    event.phase = proposal.phase;
  }
  if (proposal.detail !== undefined) {
    event.detail = proposal.detail;
  }
  if (proposal.anchors.length > 0) {
    event.anchors = proposal.anchors;
  }
  return event;
}

/**
 * The FEATURE graph's part-node ids — the id set `part` proposals confirm
 * against, since no part is ever in `graph.json`.
 *
 * Built through `buildFeatureGraph` rather than by joining slugs here, so the
 * ids compared against a proposal are minted by the same code that mints the
 * ones on the board — including the deterministic `-2` suffix a duplicate part
 * name gets. A second minting rule would let a part confirm on one surface and
 * not the other, which is worse than not confirming at all.
 *
 * Fail-soft on its OWN, not on derive's blanket catch: an unreadable feature
 * store costs the parts their confirmation, never the extractor kinds theirs.
 */
function readPartNodeIds(flowDir: string): Set<string> {
  try {
    const features = readFeatures(flowDir);
    const partsBySlug = new Map<string, FeaturePart[]>();
    for (const feature of features) {
      try {
        const parts = readParts(flowDir, feature.slug);
        if (parts.length > 0) partsBySlug.set(feature.slug, parts);
      } catch {
        continue; // one unreadable `## Parts` costs that feature its parts, never the rest
      }
    }
    const featureGraph = buildFeatureGraph(features, new Map(), new Set(), new Set(), partsBySlug);
    return new Set(
      featureGraph.nodes.filter((node) => node.kind === 'part').map((node) => node.id),
    );
  } catch {
    return new Set(); // no feature store — no parts to confirm against
  }
}

/** Refuse a propose write: one-line reason on stderr, exit code 1, nothing written. */
function refusePropose(reason: string): number {
  process.stderr.write(`${formatProposeRefusal(reason)}\n`);
  return 1;
}

/**
 * Report the plan's resulting store state after a mediated write, so a caller
 * reads back what landed instead of inferring it from the exit code. Printed
 * on EVERY successful record and decide — including when the plan's store is
 * empty, which is exactly the case that went unnoticed for the store's whole
 * lifetime.
 */
function reportProposalCounts(flowDir: string, plan: string): void {
  const counts = countProposals(readEffectiveProposals(flowDir, plan));
  process.stdout.write(`${formatProposalsRecorded(counts)}\n`);
}

/**
 * Parse repeatable `--anchor <kind>:<ref>` flags for propose. Anchors here
 * point at existing code RELATED to the prediction, so they are validated
 * structurally only — never resolved against the graph (silent-record
 * semantics: propose works with no graph at all). Returns a refusal reason
 * string when any flag is malformed.
 */
function parseProposeAnchors(options: BlueprintCommandOptions): Anchor[] | string {
  const anchors: Anchor[] = [];
  for (const raw of options.anchor ?? []) {
    const anchor = parseAnchorFlag(raw);
    if (anchor === null) {
      return `invalid anchor '${raw}' — expected <kind>:<ref> with kind in ${OBSERVE_ANCHOR_KINDS.join('|')}`;
    }
    anchors.push(anchor);
  }
  return anchors;
}

/**
 * `blueprint propose --decide accepted|rejected --plan <p> --node <id>` —
 * append one decision event against an existing effective proposal. Refuses
 * (one line, nothing written) when no effective proposal exists for the
 * fingerprint, or when its state is not `proposed` — already-decided
 * proposals refuse a second decision, and terminal states
 * (confirmed/cleared) or swept `stale` proposals cannot be decided at all.
 * The decision line re-carries the proposal's payload so every store line is
 * self-describing; the fold ignores it in favor of the first `proposed`
 * payload. Returns the process exit code.
 */
function runProposeDecide(flowDir: string, options: BlueprintCommandOptions): number {
  const decision = options.decide as 'accepted' | 'rejected';
  const plan = options.plan ?? '';
  const node = options.node ?? '';
  if (plan.length === 0) {
    return refusePropose('--decide requires --plan <plan>');
  }
  if (node.length === 0) {
    return refusePropose('--decide requires --node <predicted-id>');
  }

  const proposal: EffectiveProposal | undefined = readEffectiveProposals(flowDir, plan).find(
    (candidate) => candidate.predictedNodeId === node,
  );
  const refusal = validateProposalDecision(proposal, plan, node);
  if (refusal !== null || proposal === undefined) {
    return refusePropose(refusal ?? `no proposal '${node}' recorded for plan '${plan}'`);
  }

  appendProposalEvent(
    flowDir,
    proposalLifecycleEvent(proposal, decision, new Date().toISOString(), PROPOSE_PROVENANCE),
  );
  process.stdout.write(`proposal ${node}: ${decision}\n`);
  reportProposalCounts(flowDir, plan);
  return 0;
}

// ── sweep ────────────────────────────────────────────────

/** Refuse a sweep: one-line reason on stderr, exit code 1, nothing written. */
function refuseSweep(reason: string): number {
  process.stderr.write(`sweep refused: ${reason}\n`);
  return 1;
}

/**
 * `blueprint sweep --plan <p>` — end-of-plan maintenance over ONE plan's
 * effective proposals: `accepted` (accepted but never built) → `stale`,
 * `proposed` (never decided) → `stale`, `rejected` → `cleared`. Terminal or
 * already-swept states (confirmed/stale/cleared) are untouched, which makes a
 * double sweep idempotent (`0 staled, 0 cleared`). Every event re-carries the
 * proposal's payload (self-describing lines) with provenance `cli:sweep`.
 *
 * Production caller: the execute-plan archive step — when a completed or
 * abandoned plan is archived, the skill wiring (documented in Phase 6) runs
 * this sweep so the board never shows ghosts of a dead plan as live. Returns
 * the process exit code.
 */
/**
 * `blueprint sweep --expired` — the STORE-WIDE expiry pass, over every plan
 * rather than one.
 *
 * The plan-scoped sweep fires only at plan archive, so it can only ever clean up
 * after work that finished; an exploration that was abandoned is never archived
 * and so is never swept. This pass asks the one question that separates the two
 * (`isProposalSourceLive`) and stales what has no source left — stale, never
 * deleted, mirroring the annotations layer. Reports its count in the sweep
 * vocabulary; `0 staled (source gone)` is a legitimate, expected line.
 */
function runExpirySweep(flowDir: string): number {
  const index = readProposalSourceIndex(flowDir);
  const ts = new Date().toISOString();
  let staled = 0;
  for (const proposal of proposalsWithMissingSource(readEffectiveProposals(flowDir), index)) {
    appendProposalEvent(flowDir, proposalLifecycleEvent(proposal, 'stale', ts, SWEEP_PROVENANCE));
    staled += 1;
  }
  process.stdout.write(`${formatProposalsStaled(staled)}\n`);
  return 0;
}

function runSweep(flowDir: string, options: BlueprintCommandOptions): number {
  const plan = options.plan ?? '';
  if (options.expired === true) {
    if (plan.length > 0) {
      return refuseSweep('--expired sweeps every plan — it cannot be combined with --plan');
    }
    return runExpirySweep(flowDir);
  }
  if (plan.length === 0) {
    return refuseSweep('sweep requires --plan <plan>, or --expired to sweep sources that are gone');
  }

  const ts = new Date().toISOString();
  let staled = 0;
  let cleared = 0;
  for (const proposal of readEffectiveProposals(flowDir, plan)) {
    if (proposal.state === 'accepted' || proposal.state === 'proposed') {
      appendProposalEvent(flowDir, proposalLifecycleEvent(proposal, 'stale', ts, SWEEP_PROVENANCE));
      staled += 1;
    } else if (proposal.state === 'rejected') {
      appendProposalEvent(flowDir, proposalLifecycleEvent(proposal, 'cleared', ts, SWEEP_PROVENANCE));
      cleared += 1;
    }
  }
  process.stdout.write(`sweep ${plan}: ${staled} staled, ${cleared} cleared\n`);
  return 0;
}

/**
 * `blueprint propose` — the mediated write path into the proposal store.
 *
 * Record mode (`--plan --node --kind --label [--detail --phase --anchor]…`)
 * validates the predicted id against the extractor id grammar (kind must
 * agree with the id prefix) and appends one `proposed` event. Silent-record
 * semantics: no board and no graph are required — chat decides, the board
 * merely mirrors; in a terminal-only session the record is simply silent.
 * Decide mode (`--decide accepted|rejected`) appends a decision event
 * against an existing effective proposal. Any validation failure exits 1
 * with a one-line `propose refused: <reason>` on stderr and NOTHING written.
 * Returns the process exit code.
 */
function runPropose(repoRoot: string, options: BlueprintCommandOptions): number {
  const flowDir = join(repoRoot, 'flow');

  if (options.decide !== undefined) {
    if (!PROPOSAL_DECISIONS.includes(options.decide as 'accepted' | 'rejected')) {
      return refusePropose(`invalid --decide '${options.decide}' — expected accepted|rejected`);
    }
    return runProposeDecide(flowDir, options);
  }

  const plan = options.plan ?? '';
  const node = options.node ?? '';
  const label = options.label ?? '';
  const refusal = validateProposalRecord({ plan, node, kind: options.kind, label });
  if (refusal !== null) {
    return refusePropose(refusal);
  }
  const kind = options.kind as ProposalKind;

  let phase: number | undefined;
  if (options.phase !== undefined) {
    phase = Number(options.phase);
    if (!Number.isInteger(phase) || phase < 1) {
      return refusePropose(`invalid --phase '${options.phase}' — expected a positive integer`);
    }
  }

  const anchors = parseProposeAnchors(options);
  if (typeof anchors === 'string') {
    return refusePropose(anchors);
  }

  const event: ProposalEvent = {
    ts: new Date().toISOString(),
    plan,
    predictedNodeId: node,
    kind,
    label,
    event: 'proposed',
    provenance: PROPOSE_PROVENANCE,
  };
  if (phase !== undefined) {
    event.phase = phase;
  }
  if (options.detail !== undefined && options.detail.length > 0) {
    event.detail = options.detail;
  }
  if (anchors.length > 0) {
    event.anchors = anchors;
  }
  appendProposalEvent(flowDir, event);
  process.stdout.write(`proposal recorded: ${node} (${plan})\n`);
  reportProposalCounts(flowDir, plan);
  return 0;
}

// ── narrate ──────────────────────────────────────────────

/** Refuse a narrate: one-line reason(s) on stderr, exit code 1, nothing written. */
function refuseNarrate(reason: string): number {
  process.stderr.write(`narrate refused: ${reason}\n`);
  return 1;
}

/**
 * `blueprint narrate` — the single mediated write path producing the compiled
 * story at `flow/brain/.structure/story.json`.
 *
 * Clear mode (`--clear --plan <name>`) deletes the story ONLY when its plan
 * matches — printing `narrate: cleared story for <plan>` or
 * `narrate: no story for <plan>`.
 *
 * Compile mode (`--from <doc> [--plan] [--draft|--strict]`) infers the mode
 * from the doc's location (flags override), derives the plan name from
 * `--plan` or the filename, parses the doc's `## Story` section, resolves
 * anchors/flow ids against the current graph (null-tolerant) and effective
 * proposals, and writes the compiled story. Strict-mode resolution gaps (or a
 * missing graph, or an absent `## Story` section) refuse with ALL violations
 * listed (sorted, one per line) — NOTHING written. Returns the exit code.
 */
function runNarrate(repoRoot: string, options: BlueprintCommandOptions): number {
  const flowDir = join(repoRoot, 'flow');
  const structureDir = join(flowDir, BLUEPRINT_DIRNAME);

  if (options.clear === true) {
    const plan = options.plan ?? '';
    if (plan.length === 0) {
      return refuseNarrate('--clear requires --plan <plan>');
    }
    const result = clearCompiledStory(structureDir, plan);
    process.stdout.write(
      result.cleared ? `narrate: cleared story for ${plan}\n` : `narrate: no story for ${plan}\n`,
    );
    return 0;
  }

  const from = options.from ?? '';
  if (from.length === 0) {
    return refuseNarrate('narrate requires --from <doc>');
  }

  if (options.draft === true && options.strict === true) {
    return refuseNarrate('--draft and --strict are mutually exclusive');
  }
  const flag: StoryMode | undefined = options.draft === true ? 'draft' : options.strict === true ? 'strict' : undefined;
  const mode = inferMode(from, flag);
  if (mode === null) {
    return refuseNarrate(
      `cannot infer mode for '${from}' — pass --draft or --strict (only flow/plans, flow/discovery, flow/brainstorms docs infer a mode)`,
    );
  }

  const plan = derivePlanName(from, options.plan);
  if (plan === null) {
    return refuseNarrate(`cannot derive plan name from '${from}' — pass --plan <name>`);
  }

  let markdown: string;
  try {
    markdown = readFileSync(resolve(repoRoot, from), 'utf-8');
  } catch {
    return refuseNarrate(`cannot read doc '${from}'`);
  }

  // Fail-soft reads: a missing/corrupt graph returns null (strict then refuses
  // via compileStory); proposals read never locks and never throws.
  const graph = readGraph(flowDir);
  const proposals = readEffectiveProposals(flowDir);

  const result = compileStory({ markdown, sourcePath: from, plan, mode, graph, proposals });
  if (result.status === 'refused') {
    return refuseNarrate(result.reasons.join('\n'));
  }
  // A STORY WITH NO STEPS IS NEVER WRITTEN (2026-10-08). The compiled story is
  // one file per project, so writing an empty one replaced the story the
  // board and the chat were showing — a thread's card then named another
  // plan's doc with "0 steps", and the success line hid it.
  if (result.story.steps.length === 0) {
    return refuseNarrate(
      `'${from}' has no story steps — each step is a '### Step: <title>' heading (numbered is fine) inside its '## Story' section; the story already compiled is kept`,
    );
  }

  writeCompiledStory(structureDir, result.story);
  const draftCount = result.story.steps.filter((step) => step.draft).length;
  const draftSuffix = draftCount > 0 ? ` (${draftCount} draft)` : '';
  process.stdout.write(
    `narrate: ${plan} — ${result.story.steps.length} steps compiled${draftSuffix}\n`,
  );
  // Warnings were previously written to story.json and never shown, which made
  // every "never a silent truncation" guarantee in the compile pass silent in
  // practice — including the step cap and the change brief's missing authored
  // slots. One line each, after the success line so the outcome still leads.
  for (const warning of result.story.warnings) {
    process.stdout.write(`narrate warning: ${warning}\n`);
  }
  return 0;
}

// ── gate-check (anchor-coverage gate) ────────────────────

/** Refuse a gate-check: one-line reason on stdout (logger convention), exit 1. */
function refuseGateCheck(reason: string): number {
  process.stdout.write(`gate-check refused: ${reason}\n`);
  return 1;
}

/**
 * Resolve the highest-versioned plan doc for a feature name:
 * `flow/plans/plan_<plan>_v<N>.md`. Returns null when none exists.
 */
function resolvePlanPath(flowDir: string, plan: string): string | null {
  const plansDir = join(flowDir, 'plans');
  if (!existsSync(plansDir)) return null;
  const prefix = `plan_${plan}_v`;
  let best: { version: number; path: string } | null = null;
  for (const name of readdirSync(plansDir)) {
    if (!name.startsWith(prefix) || !name.endsWith('.md')) continue;
    const version = Number.parseInt(name.slice(prefix.length, name.length - '.md'.length), 10);
    if (!Number.isFinite(version)) continue;
    if (best === null || version > best.version) {
      best = { version, path: join(plansDir, name) };
    }
  }
  return best?.path ?? null;
}

/**
 * The anchor-coverage gate (FR3, decision #8). Refuse when any plan phase has
 * NO resolvable anchor — either the plan was never narrated, its live story
 * belongs to a different plan, or a phase's covering steps all fail to resolve.
 * The whole simulation's fidelity rests on this: an uncovered phase renders as
 * *unmapped*, never as "no changes", so the plan must not finalize with gaps.
 */
/** Refuse a features action: one-line reason on stdout, exit 1. */
function refuseFeatures(reason: string): number {
  process.stdout.write(`features refused: ${reason}\n`);
  return 1;
}

/**
 * `blueprint features seed [--dry-run]` — adopt every existing feature file in
 * place, adding frontmatter and leaving prose untouched.
 *
 * The 27 files already in `flow/brain/features/` are human-named boundaries;
 * adopting them is the cheapest possible feature discovery (discovery decision
 * #12) and costs no LLM. Idempotent — an already-adopted file is skipped, not
 * rewritten.
 */
function runFeatures(repoRoot: string, options: BlueprintCommandOptions): number {
  const flowDir = join(repoRoot, 'flow');
  const dryRun = options.dryRun === true;
  const adopted = seedFeatures(flowDir, { dryRun });
  const total = readFeatures(flowDir).length;
  if (adopted.length === 0) {
    process.stdout.write(`features: nothing to adopt — ${total} feature(s) already in the store\n`);
    return 0;
  }
  process.stdout.write(
    `features: ${dryRun ? 'would adopt' : 'adopted'} ${adopted.length} of ${total} — ${adopted.join(', ')}\n`,
  );
  return 0;
}

/**
 * `blueprint features discover [--dry-run]` — run a discovery pass and APPLY it.
 *
 * Matches update anchors through `feature-store` (which preserves every
 * human-owned field); misses are STAGED as candidates and never authored. This
 * is the verb that closes the loop: phase 2 computes the intent, this writes it.
 */
function runFeaturesDiscover(repoRoot: string, options: BlueprintCommandOptions): number {
  const flowDir = join(repoRoot, 'flow');
  const structureDir = join(flowDir, BLUEPRINT_DIRNAME);
  const existing = readFeatures(flowDir);
  const result = discoverFeatures(flowDir, existing, readGraph(flowDir), repoRoot);
  const dryRun = options.dryRun === true;

  if (!dryRun) {
    for (const update of result.updated) {
      writeFeature(flowDir, update.feature, { anchors: update.anchors });
    }
    writeCandidates(structureDir, result.candidates);
    // Corpus index (#1532) — derived, disposable, and fail-soft by contract:
    // a write failure is a one-line notice, never a failed discover.
    try {
      writeMinedCorpusIndex(flowDir, repoRoot, result.corpusDocs);
    } catch (indexError) {
      const reason = indexError instanceof Error ? indexError.message : String(indexError);
      process.stdout.write(`features: corpus index not written — ${reason}\n`);
    }
  }
  const cores = result.candidates.filter((candidate) => candidate.kind === 'core');
  const children = result.candidates.filter((candidate) => candidate.kind === 'child');
  process.stdout.write(
    `features: ${dryRun ? 'would update' : 'updated'} anchors on ${result.updated.length} of ` +
      `${existing.length} · ${result.candidates.length} new candidate(s) ` +
      `(${cores.length} core, ${children.length} child)\n`,
  );
  if (cores.length > 0) {
    process.stdout.write(`features: core candidates — ${cores.map((c) => c.slug).join(', ')}\n`);
  }
  if (children.length > 0) {
    const orphans = children.filter((candidate) => candidate.parentSlug === undefined).length;
    process.stdout.write(
      `features: child candidates — ${children.length} (${children.length - orphans} parented, ${orphans} unparented)\n`,
    );
  }
  return 0;
}

/**
 * `blueprint features confirm <slug>` — promote a staged candidate into a real
 * feature file.
 *
 * This is the EXECUTION half of "plan proposes, execution confirms"
 * (discovery decision #13). A plan's new feature appears as a candidate the
 * moment its doc lands (the corpus miner sees it); it becomes a real feature
 * only when the work is done, so an abandoned plan never leaves a feature that
 * was never built.
 */
function runFeaturesConfirm(repoRoot: string, slug: string, options: BlueprintCommandOptions): number {
  const flowDir = join(repoRoot, 'flow');
  const structureDir = join(flowDir, BLUEPRINT_DIRNAME);
  const all = options.all === true;
  if (!all && slug.length === 0) return refuseFeatures('confirm requires a candidate slug (or --all)');

  const candidates = readCandidates(structureDir);
  const kindFilter = options.kind;
  if (kindFilter !== undefined && kindFilter !== 'core' && kindFilter !== 'child') {
    return refuseFeatures(`--kind must be core|child, got '${kindFilter}'`);
  }
  const wanted = all
    ? candidates.filter((entry) => kindFilter === undefined || entry.kind === kindFilter)
    : candidates.filter((entry) => entry.slug === slug);
  if (wanted.length === 0) {
    return refuseFeatures(
      all
        ? 'no staged candidates — run `blueprint features discover` first'
        : `no staged candidate '${slug}' — run \`blueprint features discover\` first`,
    );
  }
  const taken = new Set(readFeatures(flowDir).map((feature) => feature.slug));
  if (!all && taken.has(slug)) return refuseFeatures(`feature '${slug}' already exists`);

  // Cores first: a child's parent must exist before the child points at it.
  const ordered = [...wanted].sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'core' ? -1 : 1));
  const confirmed: string[] = [];
  for (const candidate of ordered) {
    if (taken.has(candidate.slug)) continue;
    if (options.dryRun === true) {
      confirmed.push(candidate.slug);
      continue;
    }
    // Same code path init's bootstrap uses — one definition of what a confirmed
    // feature looks like, rather than two that drift.
    if (!confirmCandidate(flowDir, candidate, taken)) continue;
    taken.add(candidate.slug);
    confirmed.push(candidate.slug);
  }
  if (options.dryRun !== true) {
    const done = new Set(confirmed);
    writeCandidates(structureDir, candidates.filter((entry) => !done.has(entry.slug)));
  }
  const verb = options.dryRun === true ? 'would confirm' : 'confirmed';
  process.stdout.write(
    all
      ? `features: ${verb} ${confirmed.length} candidate(s)${kindFilter === undefined ? '' : ` (kind ${kindFilter})`}\n`
      : `features: ${verb} '${slug}' (${wanted[0].anchors.length} anchors)\n`,
  );
  return 0;
}

/**
 * `blueprint features reclass [--dry-run]` — re-level the store against the
 * current capability set: corpus-derived features become children of the
 * capability they touch, capabilities stay core.
 *
 * Explicit and separate from `discover` on purpose (see `reclassFeatures`):
 * `kind`/`parent` are human-owned, so re-levelling happens when a human asks,
 * never as a side effect of a sweep.
 */
/**
 * `blueprint features learned --feature <id|slug> --entry '<json>' [...]` —
 * write a feature's machine-owned `## Learned` section.
 *
 * WHY THIS IS A CLI VERB. The app performs the learn pass but must not own the
 * section format: the boundary parser is what stands between a learn and an
 * unrecoverable overwrite of somebody's prose, and an invariant enforced in two
 * places drifts (allowed-pattern #14). So the app proposes entries and this
 * verb — the store's owner — decides whether they can be written at all.
 *
 * REFUSES, writing nothing, when the section boundary is ambiguous or the
 * existing section was hand-edited. Those refusals are the feature, not an
 * inconvenience: they are the reason a machine may write inside a human file.
 */
function runFeaturesLearned(repoRoot: string, options: BlueprintCommandOptions): number {
  const flowDir = join(repoRoot, 'flow');
  const ref = typeof options.feature === 'string' ? options.feature.trim() : '';
  if (ref.length === 0) {
    return refuseFeatures('a learned write requires --feature <id|slug>');
  }
  const feature = findFeatureByRef(readFeatures(flowDir), ref);
  if (feature === undefined) {
    return refuseFeatures(`no feature '${ref}'`);
  }

  const rawEntries = Array.isArray(options.entry)
    ? options.entry
    : typeof options.entry === 'string'
      ? [options.entry]
      : [];
  const rawRelates = typeof options.relates === 'string' ? options.relates.trim() : '';
  if (rawEntries.length === 0 && rawRelates.length === 0) {
    return refuseFeatures("a learned write requires at least one --entry '<json>' or --relates '<json>'");
  }

  const entries: Learning[] = [];
  for (const raw of rawEntries) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return refuseFeatures(`--entry is not valid JSON: ${raw.slice(0, 60)}`);
    }
    const candidate = parsed as Record<string, unknown>;
    if (typeof candidate.text !== 'string' || candidate.text.trim().length === 0) {
      return refuseFeatures('every --entry needs a non-empty "text"');
    }
    if (typeof candidate.provenance !== 'string' || candidate.provenance.length === 0) {
      return refuseFeatures('every --entry needs a "provenance" (code | human | plan:<name>)');
    }
    if (typeof candidate.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(candidate.date)) {
      return refuseFeatures('every --entry needs a "date" as YYYY-MM-DD');
    }
    // A learning is ONE line: a newline would break the entry grammar on the
    // next parse, silently splitting or swallowing it.
    const entry: Learning = {
      text: candidate.text.replace(/\s*\n\s*/g, ' ').trim(),
      provenance: candidate.provenance,
      date: candidate.date,
    };
    if (candidate.pinned === true) entry.pinned = true;
    if (typeof candidate.supersededReason === 'string' && candidate.supersededReason.length > 0) {
      entry.supersededReason = candidate.supersededReason;
    }
    entries.push(entry);
  }

  if (entries.length > 0) {
    try {
      writeLearned(flowDir, feature.slug, entries);
    } catch (error) {
      // The refusal text already explains itself (see AmbiguousLearnedSectionError).
      return refuseFeatures(error instanceof Error ? error.message : String(error));
    }
    const current = entries.filter((entry) => entry.supersededReason === undefined).length;
    process.stdout.write(
      `features: ${feature.name} — ${current} learning(s)` +
        (entries.length > current ? `, ${entries.length - current} superseded` : '') +
        '\n',
    );
  }

  if (rawRelates.length > 0) {
    const code = writeProposedEdges(repoRoot, flowDir, feature, rawRelates);
    if (code !== 0) return code;
  }
  return 0;
}

/**
 * Write the `relates` half of a learned write.
 *
 * The proposals arrive from a model that was handed the roster and asked to
 * name the other side, so the ONE thing that must not happen is an id nobody
 * can resolve being written as though somebody verified it. `writeEdges` is
 * the store's own path and does the judging; this reports its verdict —
 * accepted edges and REFUSED ones with their reason, one line each, because a
 * refusal the caller never sees is indistinguishable from a write.
 */
function writeProposedEdges(
  repoRoot: string,
  flowDir: string,
  feature: FeatureNode,
  rawRelates: string,
): number {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawRelates);
  } catch {
    return refuseFeatures(`--relates is not valid JSON: ${rawRelates.slice(0, 60)}`);
  }
  if (!Array.isArray(parsed)) {
    return refuseFeatures('--relates must be a JSON array of {target, via, note} edges');
  }
  const proposals: FeatureEdge[] = [];
  for (const item of parsed) {
    if (typeof item !== 'object' || item === null) {
      return refuseFeatures('every --relates entry must be an object with a "target"');
    }
    const candidate = item as Record<string, unknown>;
    if (typeof candidate.target !== 'string' || candidate.target.trim().length === 0) {
      return refuseFeatures('every --relates entry needs a non-empty "target"');
    }
    const edge: FeatureEdge = { target: candidate.target };
    if (typeof candidate.via === 'string' && candidate.via.trim().length > 0) edge.via = candidate.via;
    if (typeof candidate.note === 'string' && candidate.note.trim().length > 0) edge.note = candidate.note;
    proposals.push(edge);
  }

  // STAMPED BEFORE WRITTEN: an edge whose `via` names a source file carries
  // that file's content hash, so the same staleness pass that re-hashes an
  // investigation note's stamps can tell a live mechanism from a changed one
  // (`blueprint stale-check`). An edge with no file-backed `via` is written
  // unstamped and simply never claims to be fresh.
  const result = writeEdges(flowDir, feature.slug, stampEdgeVias(repoRoot, proposals));
  for (const edge of result.accepted) {
    process.stdout.write(`features: ${feature.name} relates ${describeEdge(edge)}\n`);
  }
  for (const refusal of result.refused) {
    process.stdout.write(`features: refused edge to ${refusal.target} — ${refusal.reason}\n`);
  }
  process.stdout.write(
    `features: ${feature.name} — ${result.accepted.length} edge(s) written` +
      (result.refused.length > 0 ? `, ${result.refused.length} refused` : '') +
      '\n',
  );
  return 0;
}

/**
 * `blueprint features roster [--json]` — the vocabulary an edge writer may use.
 *
 * THE PRODUCER FOR THE ROSTER THE LEARN PROMPTS ALREADY CARRY. The app cannot
 * import the CLI's sources, so `buildFeatureRoster` reaches a learn pass the
 * same way every other store fact does: through a CLI verb the app spawns. A
 * pass that cannot see this list writes prose about a mechanism and no edge at
 * all — which is exactly the state `relates` has been in across all 101
 * features in three projects.
 */
function runFeaturesRoster(repoRoot: string, options: BlueprintCommandOptions): number {
  const flowDir = join(repoRoot, 'flow');
  const roster = buildFeatureRoster(readFeatures(flowDir));
  if (options.json === true) {
    process.stdout.write(`${JSON.stringify({ roster })}\n`);
    return 0;
  }
  if (roster.length === 0) {
    process.stdout.write('features: no roster — this project has no features yet\n');
    return 0;
  }
  for (const entry of roster) {
    process.stdout.write(
      `${entry.id} — ${entry.name}${entry.kind === 'child' ? ' (change record)' : ''}` +
        (entry.summary.length > 0 ? `: ${entry.summary}` : '') +
        '\n',
    );
  }
  process.stdout.write(`features: ${roster.length} in the roster\n`);
  return 0;
}


/**
 * Write the generated feature index, returning its repo-relative path.
 *
 * REBUILT IN FULL, never patched — the file is a projection of the store, and
 * a projection that is merged into rather than replaced drifts from its source
 * one stale line at a time. Written through a temp file + rename so a reader
 * (or a search) never observes a half-written index, and skipped entirely when
 * the bytes are unchanged, so a rebuild on a store nobody touched does not move
 * an mtime and invalidate every cache keyed on one.
 */
export function writeFeatureIndex(flowDir: string, features: readonly FeatureNode[]): string {
  const markdown = buildFeatureIndexMarkdown(features, readPartsBySlug(flowDir, features));
  const indexPath = join(flowDir, FEATURE_INDEX_RELPATH);
  mkdirSync(dirname(indexPath), { recursive: true });
  if (existsSync(indexPath)) {
    try {
      if (readFileSync(indexPath, 'utf-8') === markdown) return indexPath;
    } catch {
      // Unreadable — fall through and replace it, which is the fix either way.
    }
  }
  const temp = `${indexPath}.tmp`;
  writeFileSync(temp, markdown, 'utf-8');
  renameSync(temp, indexPath);
  return indexPath;
}

/**
 * `blueprint features index` — rebuild the generated feature index.
 *
 * DERIVED, DISPOSABLE, AND DELIBERATELY NOT IN `flow/brain/`. See the essay on
 * `buildFeatureIndexMarkdown`: `flow/brain/` is precious and Obsidian-visible,
 * so a generated file placed there gets edited and then silently eaten by the
 * next rebuild. `flow/brain/.derived/` holds only regenerable bytes, which is
 * what makes overwriting it in full a non-event.
 */
/**
 * Mine the corpus and persist flow/brain/.derived/corpus-index.json (#1716).
 *
 * ONE code path for both writers (allowed-pattern #14): `features discover`
 * writes the index as part of adopting candidates, and `features index`
 * writes it alone — a store populated BEFORE the index existed (#1532) never
 * discovers again (auto-discovery fires only on an empty board, #1307), so
 * the Changes & discoveries browser sat on "no corpus index yet" forever,
 * promising a pass that could never run. Fail-soft by the same contract as
 * the discover site: a write failure is a one-line notice, never a failure.
 */
function writeMinedCorpusIndex(flowDir: string, repoRoot: string, corpusDocs: CorpusDocRecord[]): number {
  const previous = readCorpusIndex(flowDir);
  const index = buildCorpusIndex(corpusDocs, previous, new Date().toISOString(), repoRoot);
  writeCorpusIndex(flowDir, index);
  return index.entries.length;
}

function runFeaturesIndex(repoRoot: string, options: BlueprintCommandOptions): number {
  const flowDir = join(repoRoot, 'flow');
  const features = readFeatures(flowDir);
  const indexPath = writeFeatureIndex(flowDir, features);
  const edges = features.reduce((sum, feature) => sum + feature.relates.length, 0);
  const relative = relative_(repoRoot, indexPath);
  // BOTH derived indexes (#1716): the corpus index rides the same verb, so a
  // project can (re)gain the Changes & discoveries data without a discover
  // pass mutating anchors or candidates — discoverFeatures COMPUTES only; its
  // writes belong to the discover verb, none of which run here.
  let corpusDocCount: number | null = null;
  try {
    const mined = discoverFeatures(flowDir, features, readGraph(flowDir), repoRoot);
    corpusDocCount = writeMinedCorpusIndex(flowDir, repoRoot, mined.corpusDocs);
  } catch (indexError) {
    const reason = indexError instanceof Error ? indexError.message : String(indexError);
    process.stdout.write(`features: corpus index not written — ${reason}\n`);
  }
  if (options.json === true) {
    process.stdout.write(
      `${JSON.stringify({ path: relative, features: features.length, edges, corpusDocs: corpusDocCount })}\n`,
    );
    return 0;
  }
  process.stdout.write(
    `features: index written — ${relative} (${String(features.length)} feature(s), ` +
      `${String(edges)} relationship(s))` +
      (corpusDocCount === null ? '\n' : ` · corpus index: ${String(corpusDocCount)} doc(s)\n`),
  );
  return 0;
}

/**
 * `blueprint features view --feature <ref> [--json]` — read a generated view.
 * `blueprint features view --feature <ref> --write '<json>'` — validate + persist.
 *
 * The store owns validation because this artifact is DRAWN AS EVIDENCE: a line
 * from a component that is not there asserts a relationship the reader cannot
 * check, and a code excerpt claiming lines a file does not have looks exactly
 * like proof. Both refuse the whole write; nothing is persisted.
 */
/**
 * `blueprint features parts --feature <ref> [--write <json>]`
 *
 * A feature's PARTS: the pieces it is made of, each with its own anchors and
 * its own learnings. A part is NOT a change record — a change (`kind: 'child'`)
 * is a plan or issue that touched the feature, and lives in the store, not
 * here. This is the writer — the one code path that decides what a part is, so
 * a pass cannot invent a shape the reader will not understand.
 *
 * The refusals matter more than the write. A part with no name is a box nobody
 * can talk about; a part with no anchors can never be learned or re-checked for
 * staleness, so it would sit there claiming knowledge that nothing keeps
 * honest.
 */
function runFeaturesParts(repoRoot: string, options: BlueprintCommandOptions): number {
  const flowDir = join(repoRoot, 'flow');
  const ref = typeof options.feature === 'string' ? options.feature.trim() : '';
  if (ref.length === 0) {
    return refuseFeatures('parts need --feature <id|slug>');
  }
  const feature = findFeatureByRef(readFeatures(flowDir), ref);
  if (feature === undefined) {
    return refuseFeatures(`no feature '${ref}'`);
  }

  const write = typeof options.write === 'string' ? options.write : '';
  if (write.length === 0) {
    const parts = readParts(flowDir, feature.slug);
    if (options.json === true) {
      process.stdout.write(`${JSON.stringify({ feature: feature.slug, parts }, null, 2)}\n`);
      return 0;
    }
    if (parts.length === 0) {
      process.stdout.write(`features: ${feature.name} — no parts\n`);
      return 0;
    }
    process.stdout.write(`features: ${feature.name} — ${String(parts.length)} part(s)\n`);
    for (const part of parts) {
      const learned = part.learnings.filter((entry) => entry.supersededReason === undefined).length;
      process.stdout.write(`  ${part.name} — ${String(part.anchors.length)} anchor(s) · ${String(learned)} learning(s)\n`);
    }
    return 0;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(write);
  } catch {
    return refuseFeatures('--write is not valid JSON');
  }
  if (!Array.isArray(parsed)) {
    return refuseFeatures('--write must be an array of parts');
  }

  const parts: FeaturePart[] = [];
  const errors: string[] = [];
  parsed.forEach((entry, index) => {
    if (typeof entry !== 'object' || entry === null) {
      errors.push(`part ${String(index)} is not an object`);
      return;
    }
    const record = entry as Record<string, unknown>;
    const name = typeof record['name'] === 'string' ? record['name'].trim() : '';
    if (name.length === 0) {
      errors.push(`part ${String(index)} has no name — a box nobody can talk about`);
      return;
    }
    const anchors = Array.isArray(record['anchors'])
      ? (record['anchors'] as unknown[]).filter((a): a is string => typeof a === 'string' && a.trim().length > 0)
      : [];
    if (anchors.length === 0) {
      errors.push(
        `part '${name}' names no anchors — nothing to learn it from, and nothing to re-check when the code drifts`,
      );
      return;
    }
    const learnings = Array.isArray(record['learnings'])
      ? (record['learnings'] as unknown[]).flatMap((raw) => {
          if (typeof raw !== 'object' || raw === null) return [];
          const item = raw as Record<string, unknown>;
          const text = typeof item['text'] === 'string' ? item['text'].trim() : '';
          if (text.length === 0) return [];
          return [
            {
              text,
              provenance: typeof item['provenance'] === 'string' ? item['provenance'] : 'code',
              date: typeof item['date'] === 'string' ? item['date'] : new Date().toISOString().slice(0, 10),
              ...(item['pinned'] === true ? { pinned: true as const } : {}),
              ...(typeof item['supersededReason'] === 'string'
                ? { supersededReason: item['supersededReason'] }
                : {}),
            },
          ];
        })
      : [];
    parts.push({
      name,
      summary: typeof record['summary'] === 'string' ? record['summary'].trim() : '',
      anchors: anchors.map((a) => a.trim()),
      learnings,
    });
  });

  if (errors.length > 0) {
    for (const error of errors) process.stderr.write(`features refused: ${error}\n`);
    return 1;
  }

  try {
    writeParts(flowDir, feature.slug, parts);
  } catch (error) {
    return refuseFeatures(error instanceof Error ? error.message : String(error));
  }
  const learned = parts.reduce((sum, part) => sum + part.learnings.length, 0);
  process.stdout.write(`features: ${feature.name} — ${String(parts.length)} part(s) written, ${String(learned)} learning(s)\n`);
  return 0;
}

function runFeaturesView(repoRoot: string, options: BlueprintCommandOptions): number {
  const flowDir = join(repoRoot, 'flow');
  const ref = typeof options.feature === 'string' ? options.feature.trim() : '';
  if (ref.length === 0) {
    return refuseFeatures('a view needs --feature <id|slug>');
  }
  const feature = findFeatureByRef(readFeatures(flowDir), ref);
  if (feature === undefined) {
    return refuseFeatures(`no feature '${ref}'`);
  }

  const write = typeof options.write === 'string' ? options.write : '';
  if (write.length > 0) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(write);
    } catch {
      return refuseFeatures('--write is not valid JSON');
    }
    const candidate = { ...(parsed as Record<string, unknown>), feature: feature.slug } as FeatureView;
    const result = writeFeatureView(flowDir, candidate, repoRoot);
    if (!result.ok) {
      // Every error, not the first: a generator fixing one at a time would
      // burn a pass per mistake.
      for (const error of result.errors) {
        process.stderr.write(`features refused: ${error}\n`);
      }
      return 1;
    }
    const levels = Object.keys(candidate.views).length;
    const components = Object.values(candidate.views).reduce((sum, level) => sum + level.nodes.length, 0);
    process.stdout.write(
      `features: ${feature.name} — view written (${String(components)} component(s) across ${String(levels)} level(s))\n`,
    );
    return 0;
  }

  const view = readFeatureView(flowDir, feature.slug);
  if (options.json === true) {
    process.stdout.write(`${JSON.stringify(view)}\n`);
    return 0;
  }
  if (view === null) {
    process.stdout.write(`features: ${feature.name} — no generated view\n`);
    return 0;
  }
  const components = Object.values(view.views).reduce((sum, level) => sum + level.nodes.length, 0);
  process.stdout.write(
    `features: ${feature.name} — ${String(components)} component(s), generated ${view.generatedAt} from ${view.provenance}\n`,
  );
  return 0;
}

/**
 * `blueprint features heal [--feature <ref>]` — re-anchor drifted excerpts on
 * demand (#1435).
 *
 * The brief heals before it emits, so a reader normally never meets a shifted
 * citation — but a brief only runs when somebody opens that feature. This verb
 * is the maintenance handle for everything else: one feature by ref, or every
 * stored artifact when no ref is given, each excerpt's address moved to where
 * its text sits NOW. The mechanics (what heals, what is only counted, when the
 * file is written) are entirely `healFeatureView`'s — this function phrases.
 *
 * A view with nothing to say — no artifact, an invalid one, or all-fresh
 * excerpts — is a report, never a refusal: maintenance that finds nothing to
 * do has succeeded.
 */
function runFeaturesHeal(repoRoot: string, options: BlueprintCommandOptions): number {
  const flowDir = join(repoRoot, 'flow');
  const ref = typeof options.feature === 'string' ? options.feature.trim() : '';

  const phrase = (counts: { healed: number; gone: number; unknown: number }): string =>
    `healed ${String(counts.healed)} · gone ${String(counts.gone)}` +
    // `unknown` is the artifact's own silence (no stored text to compare), not
    // a finding about the code — it earns a mention only when it is non-zero.
    (counts.unknown > 0 ? ` · unknown ${String(counts.unknown)}` : '');

  if (ref.length > 0) {
    const feature = findFeatureByRef(readFeatures(flowDir), ref);
    if (feature === undefined) {
      return refuseFeatures(`no feature '${ref}'`);
    }
    const counts = healFeatureView(flowDir, feature.slug, repoRoot);
    if (counts === null) {
      process.stdout.write(`heal: ${feature.name} — no healable view\n`);
      return 0;
    }
    process.stdout.write(`heal: ${feature.name} — ${phrase(counts)}\n`);
    return 0;
  }

  // No ref: every stored artifact, filed slug order. Enumeration scans the
  // DIRECTORY (via inspection), never the feature store — an orphaned artifact
  // is reachable from no feature, and a store-driven walk would leave exactly
  // the file nobody else opens to rot forever.
  const slugs = inspectFeatureViews(flowDir).map((inspection) => inspection.slug);
  if (slugs.length === 0) {
    process.stdout.write('heal: nothing to heal\n');
    return 0;
  }
  const total = { healed: 0, gone: 0, unknown: 0 };
  for (const slug of slugs) {
    const counts = healFeatureView(flowDir, slug, repoRoot);
    // Only a view with something to say earns a line — a null (unhealable) or
    // an all-zero walk would print noise the summary already covers.
    if (counts === null || counts.healed + counts.gone + counts.unknown === 0) continue;
    total.healed += counts.healed;
    total.gone += counts.gone;
    total.unknown += counts.unknown;
    process.stdout.write(`heal: ${slug} — ${phrase(counts)}\n`);
  }
  process.stdout.write(`heal: ${String(slugs.length)} view(s) — ${phrase(total)}\n`);
  return 0;
}

function runFeaturesReclass(repoRoot: string, options: BlueprintCommandOptions): number {
  const flowDir = join(repoRoot, 'flow');
  const existing = readFeatures(flowDir);
  if (existing.length === 0) return refuseFeatures('no features in the store');

  const surfaces = mineSurfaces(repoRoot);
  if (surfaces.length === 0) {
    process.stdout.write(
      'features: no capability surfaces found (no route, test-suite or feature-root conventions) — nothing to re-level against\n',
    );
    return 0;
  }
  const coreSlugs = new Set(surfaces.map((surface) => surface.slug));
  const coreKeys = surfaces.map((surface) => canonicalKey(surface.slug));
  const slugByKey = new Map(surfaces.map((surface) => [canonicalKey(surface.slug), surface.slug]));

  const changes: FeatureReclass[] = [];
  for (const feature of existing) {
    if (coreSlugs.has(feature.slug)) {
      changes.push({ slug: feature.slug, kind: 'core' });
      continue;
    }
    const parentKey = parentKeyFor(feature.slug, coreKeys);
    const parentSlug = parentKey === null ? undefined : slugByKey.get(parentKey);
    changes.push({
      slug: feature.slug,
      kind: 'child',
      ...(parentSlug !== undefined && parentSlug !== feature.slug
        ? { parent: mintFeatureId(parentSlug) }
        : {}),
    });
  }
  const applied = reclassFeatures(flowDir, changes, { dryRun: options.dryRun === true });
  const parented = changes.filter((change) => change.parent !== undefined).length;
  process.stdout.write(
    `features: ${options.dryRun === true ? 'would re-level' : 're-levelled'} ${applied.length} of ` +
      `${existing.length} · ${coreSlugs.size} capability surface(s) · ${parented} parented\n`,
  );
  const orphans = changes.filter((change) => change.kind === 'child' && change.parent === undefined);
  if (orphans.length > 0) {
    process.stdout.write(
      `features: ${orphans.length} unparented — ${orphans.map((change) => change.slug).join(', ')}\n`,
    );
  }
  return 0;
}

/**
 * `blueprint features graph [--json]` — the board's data source. Three kinds —
 * a **feature** (`core`) is a capability, a **part** is a piece of it, a
 * **change** (`child`) is a plan or issue that touched it — plus `relates`
 * edges and understanding + activity per node. Fail-soft: an empty store
 * yields an empty graph and exit 0, never an error.
 */
/**
 * ONE FEATURE'S RELATIONS, WITH THE PROSE — `blueprint features relations`.
 *
 * WHY THIS IS A SEPARATE VERB. `features graph` deliberately emits only the
 * SHAPE of a relation (from, to, stale) and keeps `via` and `note` out: "they
 * are for a reader of the FEATURE, and the graph is a shape." That rule is not
 * worked around here — it is followed. This is the reader-of-one-feature case
 * it describes, so it asks about one feature and answers with its words.
 *
 * BOTH ENDS. The store writes one edge per unordered pair, on whichever
 * feature's file happened to name the other, so "what does Auth touch" has to
 * look at every feature's `relates` and not just Auth's own — otherwise half
 * the answers vanish depending on who wrote whom down. When the pair is
 * recorded from the other side, the prose is that side's; it is still the
 * prose about this coupling, and inventing a sentence for the near side would
 * be the one thing this store does not do.
 *
 * STALENESS IS ASKED OF THE ONE AUTHORITY, the same pass `stale-check` runs,
 * so an edge is never handed to a reader as a verified fact when the mechanism
 * it names has moved.
 */
function runFeaturesRelations(repoRoot: string, options: BlueprintCommandOptions): number {
  const ref = typeof options.feature === 'string' ? options.feature.trim() : '';
  if (ref === '') {
    process.stderr.write('features refused: --feature <id|slug> is required\n');
    return 1;
  }
  const flowDir = join(repoRoot, 'flow');
  const features = readFeatures(flowDir);
  const self = findFeatureByRef(features, ref);
  if (self === undefined) {
    process.stderr.write(`features refused: no feature matching '${ref}'\n`);
    return 1;
  }
  const nameOf = new Map(features.map((feature) => [feature.id, feature.name]));
  const stale = staleEdgeKeys(computeStaleEdges(flowDir, repoRoot, undefined, features));
  const rows = new Map<string, { target: string; name: string; via?: string; note?: string; stale: boolean }>();
  const add = (target: string, edge: { via?: string; note?: string }): void => {
    if (target === self.id || !nameOf.has(target)) return;
    const isStale = stale.has(edgeKey(self.id, target)) || stale.has(edgeKey(target, self.id));
    const seen = rows.get(target);
    // A pair recorded from both sides keeps whichever half HAS prose, and the
    // worse staleness verdict — a reader needs the sentence and the warning,
    // whichever file each came from.
    if (seen === undefined) {
      // NAMED FIELDS, never a spread of the stored edge: `viaHash` is a machine
      // stamp for the staleness pass and has no business in front of a reader.
      rows.set(target, {
        target,
        name: nameOf.get(target) ?? target,
        ...(edge.via === undefined ? {} : { via: edge.via }),
        ...(edge.note === undefined ? {} : { note: edge.note }),
        stale: isStale,
      });
      return;
    }
    rows.set(target, {
      ...seen,
      via: seen.via ?? edge.via,
      note: seen.note ?? edge.note,
      stale: seen.stale || isStale,
    });
  };
  for (const edge of self.relates) add(edge.target, edge);
  for (const feature of features) {
    if (feature.id === self.id) continue;
    for (const edge of feature.relates) {
      if (edge.target === self.id) add(feature.id, edge);
    }
  }
  const relations = [...rows.values()].sort((a, b) => a.name.localeCompare(b.name));
  process.stdout.write(`${JSON.stringify({ feature: self.id, name: self.name, relations }, null, 2)}\n`);
  return 0;
}

/**
 * `blueprint features ports --feature <ref> [--target <repo>] [--workspace <w>] --json`
 * — a feature's (or part's) entries and exits, read from the connections
 * (`blueprint/feature-ports.ts`, the one assembly). One JSON line; a refusal is
 * its JSON payload then `features refused: <reason> — <sentence>`, exit 1.
 */
function runFeaturesPorts(repoRoot: string, options: BlueprintCommandOptions): number {
  const target = typeof options.target === 'string' && options.target !== '' ? resolve(options.target) : repoRoot;
  const output = runFeaturePortsVerb({
    repoRoot: target,
    ...(typeof options.feature === 'string' ? { feature: options.feature } : {}),
    ...(typeof options.workspace === 'string' && options.workspace !== '' ? { workspace: options.workspace } : {}),
    json: options.json === true,
  });
  process.stdout.write(output.stdout);
  return output.exitCode;
}

/**
 * `blueprint features home --feature <ref> (--folder <path> | --clear) [--json]`
 * — the one writer of a feature's or part's person-owned `home:`
 * (`blueprint/feature-home.ts`). A refusal is its JSON payload then
 * `features refused: <reason> — <sentence>`, exit 1, nothing written.
 */
function runFeaturesHome(repoRoot: string, options: BlueprintCommandOptions): number {
  const output = runFeatureHomeVerb({
    repoRoot,
    ...(typeof options.feature === 'string' ? { feature: options.feature } : {}),
    ...(typeof options.folder === 'string' ? { folder: options.folder } : {}),
    clear: options.clear === true,
    json: options.json === true,
  });
  process.stdout.write(output.stdout);
  return output.exitCode;
}

/**
 * `blueprint features role --feature <ref> [--part <name>] --learned <role> [--json]`
 * — the one writer of a feature's or part's learn-owned `learnedRole:`
 * (`blueprint/feature-learned-role.ts`). It never writes the person's `role:`.
 * A refusal is its JSON payload then `features refused: <reason> — <sentence>`,
 * exit 1, nothing written.
 */
function runFeaturesRole(repoRoot: string, options: BlueprintCommandOptions): number {
  const output = runFeatureRoleVerb({
    repoRoot,
    ...(typeof options.feature === 'string' ? { feature: options.feature } : {}),
    ...(typeof options.part === 'string' ? { part: options.part } : {}),
    ...(typeof options.learned === 'string' ? { learned: options.learned } : {}),
    json: options.json === true,
  });
  process.stdout.write(output.stdout);
  return output.exitCode;
}

async function runFeaturesGraph(repoRoot: string, options: BlueprintCommandOptions): Promise<number> {
  // THE ONE ASSEMBLY of a project's graph — shared with the Workspace map
  // (`blueprint workspace graph`) so the two can never disagree about a
  // feature's understanding or size (`feature-graph-read.ts`).
  const { graph, limitations, importIndex } = await readProjectFeatureGraphPrefetched(join(repoRoot, 'flow'), repoRoot);
  // A cold import index left the folder rows partial rather than block this
  // read; build it in the background so the next read is whole.
  if (importIndex === 'partial') requestImportIndexWarm(repoRoot);

  if (options.json === true) {
    process.stdout.write(`${JSON.stringify({ ...graph, limitations, importIndex })}\n`);
    return 0;
  }
  if (graph.nodes.length === 0) {
    process.stdout.write('features: none — run `blueprint features seed` to adopt existing files\n');
    return 0;
  }
  // THREE KINDS, COUNTED THREE TIMES. This line used to say
  // `nodes.length - core` for the child count, which was true only while the
  // graph held exactly two kinds — the moment parts arrived, every part was
  // reported as a change. A count derived by subtracting one kind from the
  // total is a claim that no third kind exists; count each kind by its own
  // name so a fourth one is missing from the line rather than silently
  // absorbed into another.
  const kinds = { core: 0, part: 0, child: 0 };
  const counts = { none: 0, learning: 0, learned: 0, stale: 0 };
  for (const node of graph.nodes) {
    kinds[node.kind] += 1;
    counts[node.understanding] += 1;
  }
  process.stdout.write(
    `features: ${graph.nodes.length} (${kinds.core} core, ${kinds.part} part, ${kinds.child} change) · ` +
      `${graph.edges.length} relates edge(s)\n`,
  );
  process.stdout.write(
    `features: ${counts.learned} learned · ${counts.learning} learning · ` +
      `${counts.stale} stale · ${counts.none} not learned\n`,
  );
  // THE GAPS ARE PART OF THE ANSWER. A report that lists 28 features and says
  // nothing about the 28 with no parts is a claim that they are documented.
  const { content, views } = limitations;
  process.stdout.write(
    `features: parts on ${content.withParts}/${content.features} · ` +
      `learnings on ${content.withLearned}/${content.features}` +
      (content.unreadable > 0 ? ` · ${content.unreadable} unreadable body/bodies` : '') +
      '\n',
  );
  if (views.total > 0 || views.failures.length > 0) {
    process.stdout.write(
      `views: ${views.valid}/${views.total} valid` +
        (views.orphaned > 0 ? ` · ${views.orphaned} orphaned` : '') +
        '\n',
    );
    for (const failure of views.failures) {
      const why = failure.orphaned ? `${failure.slug} ${failure.orphanReason}` : failure.slug;
      process.stdout.write(`views: ${why}\n`);
      for (const error of failure.errors) process.stdout.write(`views:   ${error}\n`);
    }
  }
  return 0;
}

/**
 * Module path → readable domain name. A SEEDING HEURISTIC ONLY — kept in this
 * one table so it is easy to find and extend, but it is not meant to be
 * exhaustive: a human is expected to correct a wrong or missing guess by
 * editing the feature's markdown directly (`domain:` is HUMAN-OWNED, the same
 * conversational-correction model as `name`/`kind`/`parent`). Longest-prefix
 * match wins; a path matching no entry falls back to its top segment.
 */
const DOMAIN_TABLE: ReadonlyArray<readonly [string, string]> = [
  ['app/src/main', 'Main Process'],
  ['app/src/preload', 'Preload'],
  ['app/src/renderer', 'Renderer'],
  ['src/cli', 'CLI'],
  ['e2e', 'End-to-End Tests'],
];

/** Map a module path to a readable domain name — see `DOMAIN_TABLE`. */
function domainForModule(modulePath: string): string {
  let best: readonly [string, string] | null = null;
  for (const entry of DOMAIN_TABLE) {
    const [prefix] = entry;
    if (modulePath !== prefix && !modulePath.startsWith(`${prefix}/`)) continue;
    if (best === null || prefix.length > best[0].length) best = entry;
  }
  if (best !== null) return best[1];
  const [top] = modulePath.split('/');
  return top.length > 0 ? `${top.charAt(0).toUpperCase()}${top.slice(1)}` : modulePath;
}

/**
 * The module path an anchor set is MOSTLY about — the most frequently
 * referenced module, ties broken alphabetically for determinism. Null when no
 * anchor resolves to a module at all (e.g. a feature anchored only to
 * endpoints or integrations).
 */
function dominantModule(anchors: readonly string[]): string | null {
  const counts = new Map<string, number>();
  for (const anchor of anchors) {
    const modulePath = moduleOfAnchor(anchor);
    if (modulePath === null) continue;
    counts.set(modulePath, (counts.get(modulePath) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestCount = -1;
  for (const modulePath of [...counts.keys()].sort()) {
    const count = counts.get(modulePath) ?? 0;
    if (count > bestCount) {
      best = modulePath;
      bestCount = count;
    }
  }
  return best;
}

/**
 * `blueprint features domains` — one-shot seed of `domain:` from the dominant
 * module path of each feature's resolved anchors.
 *
 * NEVER overwrites an existing `domain` (enforced in `seedDomains`, not here —
 * the store is the one code path allowed to write features, allowed-pattern
 * #14), which is what makes a second run idempotent. Refuses when the graph is
 * missing: without it there is nothing to resolve anchors against, so seeding
 * would either guess or silently do nothing — refusing is the honest answer.
 */
function runFeaturesDomains(repoRoot: string, options: BlueprintCommandOptions): number {
  const flowDir = join(repoRoot, 'flow');
  const graph = readGraph(flowDir);
  if (graph === null) {
    process.stdout.write('features domains refused: no derived graph — run `blueprint derive` first\n');
    return 1;
  }

  const features = readFeatures(flowDir);
  if (features.length === 0) {
    process.stdout.write('features: none — run `blueprint features seed` to adopt existing files\n');
    return 0;
  }

  const seeds: FeatureDomainSeed[] = [];
  let alreadySet = 0;
  let unresolved = 0;
  for (const feature of features) {
    if (feature.domain !== undefined) {
      alreadySet += 1;
      continue;
    }
    const modulePath = dominantModule(feature.anchors);
    if (modulePath === null) {
      unresolved += 1;
      continue;
    }
    seeds.push({ slug: feature.slug, domain: domainForModule(modulePath) });
  }

  const dryRun = options.dryRun === true;
  const applied = seedDomains(flowDir, seeds, { dryRun });
  process.stdout.write(
    `features: ${dryRun ? 'would set' : 'set'} domain on ${applied.length} of ${features.length} — ` +
      `${alreadySet} already set, ${unresolved} skipped (no resolvable module anchor)\n`,
  );
  return 0;
}

/**
 * `blueprint coverage` — what no feature covers. READ-ONLY.
 *
 * This is the blind spot the design chose not to store (decisions #5/#18):
 * replacing module learning means un-referenced code is invisible AND
 * un-learnable, so the gap is computed on demand instead of maintained.
 */
function runCoverage(repoRoot: string, options: BlueprintCommandOptions): number {
  const flowDir = join(repoRoot, 'flow');
  const report = computeCoverage(readFeatures(flowDir), readGraph(flowDir));
  if (options.json === true) {
    process.stdout.write(`${JSON.stringify(report)}\n`);
    return 0;
  }
  if (report.total === 0) {
    process.stdout.write('coverage: no derived graph — run `blueprint derive` first\n');
    return 0;
  }
  const covered = report.total - report.uncovered.length;
  const pct = Math.round((covered / report.total) * 100);
  process.stdout.write(
    `coverage: ${covered}/${report.total} module(s) covered by ${report.features} feature(s) — ${pct}%\n`,
  );
  if (report.uncovered.length > 0) {
    const CAP = 20;
    for (const id of report.uncovered.slice(0, CAP)) process.stdout.write(`  uncovered: ${id}\n`);
    if (report.uncovered.length > CAP) {
      process.stdout.write(`  …and ${report.uncovered.length - CAP} more\n`);
    }
  }
  return 0;
}

/**
 * The proposals attached to ONE feature, with their change state derived.
 *
 * Two reads that have to agree and therefore happen together: the change state
 * needs the graph and the repo (an anchor is `changed` because it RESOLVES, on
 * this disk), and attachment needs every feature's claims. The attachment
 * result is deliberately mapped back onto the derived proposals rather than
 * used directly — `ProposalAttachments` drops `anchors`, `resolvedAnchors` and
 * `state`, and the view needs all three.
 */
function attachedProposals(
  flowDir: string,
  graph: BlueprintGraph | null,
  repoRoot: string,
  features: readonly FeatureNode[],
  featureId: string,
): ProposalWithChange[] {
  const withChange = readProposalsWithChange(flowDir, graph, repoRoot);
  const attached = new Set(
    proposalsForFeature(attachProposals(withChange, features), featureId).map(
      (entry) => entry.fingerprint,
    ),
  );
  return withChange.filter((proposal) => attached.has(proposal.fingerprint));
}

/**
 * `blueprint brief --feature <id|slug>` — the feature-scoped brief.
 *
 * A plan-scoped brief dies when its plan archives; a feature-scoped one
 * outlives every plan that touched it. With no plan currently narrated for
 * this feature the result is ANATOMY (Today only); with one it is a DELTA
 * sliced to the feature.
 */
function runFeatureBrief(repoRoot: string, ref: string, options: BlueprintCommandOptions): number {
  const flowDir = join(repoRoot, 'flow');
  const structureDir = join(flowDir, BLUEPRINT_DIRNAME);
  const features = readFeatures(flowDir);
  const feature = findFeatureByRef(features, ref);
  if (feature === undefined) {
    return refuseBrief(`no feature '${ref}' — run \`blueprint features graph\` to list them`);
  }

  const graph = readGraph(flowDir);
  const proposals = readEffectiveProposals(flowDir);
  // WHAT IS PREDICTED ABOUT THIS FEATURE.
  //
  // Attachment runs over EVERY feature, not just this one, because the
  // specificity rule's claimant cap is a fact about the whole store: an anchor
  // is a commons or an identity depending on how many features claim it, which
  // cannot be judged from inside one feature. The full attachment is computed
  // and then asked the narrow question, rather than a second, cheaper-looking
  // membership test being invented here (allowed-pattern #14).
  const attached = attachedProposals(flowDir, graph, repoRoot, features, feature.id);
  const proposalDocs = readProposalSourceIndex(flowDir).liveDocs;
  // Is a compiled plan story ABOUT this feature?
  //
  // Two signals, and the second was missing. Anchor overlap says the story's
  // flows touch nodes this feature claims — precise, but it fails whenever the
  // work spans repos: `chat-session-cache-rework` anchors `orbit_core/*` paths
  // that resolve to no node in THIS graph, so its own plan's story was
  // withheld from its own brief and the reader got components with no
  // narrative while the narrative sat one file away.
  //
  // The plan being NAMED AFTER THE FEATURE is the stronger signal. A change
  // record and its plan are the same work under two spellings (`-` vs `_`),
  // and nothing else in the store shares that name by accident.
  const compiled = readCompiledStory(structureDir);
  const claimed = featureNodeIds(feature.anchors, graph);
  const normalise = (value: string): string => value.replace(/[-_]/g, '').toLowerCase();
  const namesThisFeature =
    compiled !== null && normalise(compiled.plan) === normalise(feature.slug);
  const touches =
    compiled !== null &&
    compiled.steps.some((step) =>
      [...step.flowBefore, ...step.flowAfter].some((item) => claimed.has(parseFlowItem(item).id)),
    );
  // Only ANCHOR OVERLAP makes this a delta. Switching modes on the name alone
  // was worse than the problem: `computeFeatureBrief` then scopes a delta to
  // anchors the story never mentions, and the brief lost its 24 components AND
  // gained no steps. The narrative is attached separately below, so a change
  // record keeps its anatomy and gains its plan's story.
  const story = touches ? compiled : null;
  const brief = computeFeatureBrief(feature.anchors, story, graph, proposals, {
    proposals: attached,
    docs: proposalDocs,
  });
  const children = features.filter((other) => other.parent !== undefined && sameFeatureId(other.parent, feature.id));

  if (options.json === true) {
    process.stdout.write(
      `${JSON.stringify({
        ...brief,
        feature: feature.id,
        // The feature's OWN knowledge, always — a brief whose graph anchors
        // resolve to nothing must still open with the feature's name and what
        // is written about it. Structure is what the brief DRAWS; this is what
        // it is ABOUT, and it exists before any extractor has run.
        identity: {
          name: feature.name,
          // The HUMAN region only. What the machine learned travels as
          // `learnings`, so the renderer can style, order and collapse it
          // rather than receiving one opaque blob of prose.
          prose: featureProse(readFeatureBody(feature.body).human),
          children: children.map((child) => ({ id: child.id, name: child.name })),
          learnings: readFeatureBody(feature.body).learnings,
        },
        anchors: resolveAnchors(feature.anchors, graph, repoRoot),
        // The CURATED VIEW, when one has been generated: components with human
        // titles and LABELLED connections. The board draws this instead of the
        // anchor subgraph, which can only ever show directories.
        ...(() => {
          // HEAL FIRST, THEN READ (#1435). The drawer renders this view
          // uninspected, so the brief is the last honest moment: shifted
          // excerpts are re-anchored ON DISK before the read, and what is
          // emitted is the post-heal artifact. The counts are deliberately
          // ignored here — the artifact write is the observable, and `blueprint
          // features heal` is the verb that phrases them.
          healFeatureView(flowDir, feature.slug, repoRoot);
          const curated = readFeatureView(flowDir, feature.slug);
          if (curated === null) return {};
          // WHAT THE HEAL COULD NOT FIX travels with the view. Each non-fresh
          // excerpt's `code` gains `freshness: 'shifted' | 'gone' | 'unknown'`;
          // a fresh excerpt carries NO field — absence means verified, so the
          // drawer needs no vocabulary for the common case. Annotated on a
          // COPY, never the artifact: the file on disk stays exactly the shape
          // its validator passed. 'shifted' can only survive to emission when
          // the heal could not write (a misfiled artifact) — normally healing
          // removes it.
          const annotated = structuredClone(curated);
          for (const { levelId, nodeId, kind } of excerptFreshness(annotated, repoRoot)) {
            const node = annotated.views[levelId]?.nodes.find((n) => n.id === nodeId);
            if (node?.code !== undefined) {
              (node.code as ViewCode & { freshness?: typeof kind }).freshness = kind;
            }
          }
          return { view: annotated };
        })(),
        // The feature's PARTS, so a component's drawer can show what was
        // learned about THAT piece rather than prose the drawing inferred.
        ...(() => {
          const parts = readParts(flowDir, feature.slug);
          return parts.length === 0 ? {} : { parts };
        })(),
        // THE NARRATIVE. A change record and its plan are the same work under
        // two spellings, so the plan's compiled story belongs in the change
        // record's brief — that is where the problem, the shape, the decisions
        // and the risks are written. Without it the reader gets components and
        // no account of why they matter, while the account sits one file away.
        // Attached even when the story's flows resolve to nothing in this
        // graph, which is the normal case for work that spans repos.
        ...(story === null && namesThisFeature && compiled !== null
          ? { steps: compiled.steps }
          : {}),
      })}\n`,
    );
    return 0;
  }
  if (brief.mode === 'anatomy') {
    process.stdout.write(
      `brief: ${feature.name} — anatomy · ${brief.nodes.length} component(s) · ` +
        `${brief.wires.length} connection(s) · no plan in flight\n`,
    );
  } else {
    const counts = { new: 0, modify: 0, remove: 0 };
    for (const node of brief.nodes) if (node.kind !== 'stable') counts[node.kind] += 1;
    process.stdout.write(
      `brief: ${feature.name} — delta (${compiled?.plan ?? '?'}) · ` +
        `${counts.new} new, ${counts.modify} changed, ${counts.remove} removed\n`,
    );
  }
  // The proposal layer reports on BOTH paths, empty included — a feature with
  // nothing predicted must SAY so, because that is the majority answer and an
  // omitted line is indistinguishable from a step that stopped running.
  process.stdout.write(`brief: ${brief.proposed.summary}\n`);
  for (const skipped of brief.proposed.skipped) {
    process.stdout.write(`  skipped ${skipped.fingerprint}: ${skipped.reason}\n`);
  }
  return 0;
}

/**
 * Split a feature body for READING. Fail-soft on purpose: `splitLearned`
 * refuses an ambiguous boundary because WRITING through one could destroy
 * prose — but a brief must still open. An unreadable boundary means the whole
 * body is treated as human and no learnings are claimed, which is the honest
 * reading when we cannot tell which region is which.
 */
function readFeatureBody(body: string): { human: string; learnings: Learning[] } {
  try {
    const split = splitLearned(body);
    return { human: split.human, learnings: parseLearnings(split.learned) };
  } catch {
    return { human: body, learnings: [] };
  }
}

/** Prose kept in the brief's opening step. Enough to orient, not a document. */
const FEATURE_PROSE_CHARS = 1200;

/**
 * The feature's own prose, minus its title heading and any frontmatter the
 * store already parsed off. Trimmed at a paragraph boundary so the brief never
 * opens mid-sentence.
 */
/**
 * The bootstrap stub written when a capability is first adopted from surfaces.
 * It is provenance, not knowledge — "we found this directory" — and rendering
 * it as the feature's prose is what made every brief look like it had content
 * when it had none. Suppressed so the empty case can say so honestly.
 */
const BOOTSTRAP_STUB_RE = /^Confirmed from surface:[^\n]*\.?$/;

function featureProse(body: string): string {
  // LEAD ONLY. An auto-captured feature doc carries structured sections —
  // `## Links`, `## Timeline`, a dated changelog — and dumping the whole file
  // as the brief's prose is what put a wall of `**Project**:` and
  // `### 2026-07-28 - legacy-scan` where a summary belongs. Everything from
  // the first section heading onward is reference material, not the brief.
  const lines: string[] = [];
  for (const line of body.split('\n')) {
    if (/^#{2,}\s/.test(line)) break; // a section starts — the lead is over
    if (/^#\s/.test(line)) continue; // the title, already shown above
    lines.push(line);
  }
  const text = lines
    .join('\n')
    // Markdown that nothing renders here reads as noise: emphasis markers and
    // Obsidian wiki-link brackets are stripped, the words kept.
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .replace(/\[\[(.+?)\]\]/g, '$1')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  // Provenance, not knowledge — never rendered as the feature's prose.
  if (BOOTSTRAP_STUB_RE.test(text)) return '';
  if (text.length <= FEATURE_PROSE_CHARS) return text;
  const cut = text.slice(0, FEATURE_PROSE_CHARS);
  const boundary = cut.lastIndexOf('\n\n');
  return `${boundary > 0 ? cut.slice(0, boundary) : cut}…`;
}

/** Refuse a brief: one-line reason on stdout (logger convention), exit 1. */
function refuseBrief(reason: string): number {
  process.stdout.write(`brief refused: ${reason}\n`);
  return 1;
}

/**
 * `blueprint feature-map --feature <id|slug> [--json]` — the feature's file
 * graph: anchored files as nodes, import edges between them, honest counts for
 * what did not resolve. Read-only, computed on demand (#1533) — see
 * `../blueprint/feature-map.ts` for the contract and the edge rule.
 *
 * The human form is a census, mirroring `brief`: the map's value is spatial
 * and belongs on the board, not in a terminal.
 */
function runFeatureMap(repoRoot: string, options: BlueprintCommandOptions): number {
  const ref = options.feature;
  if (ref === undefined || ref.length === 0) {
    process.stdout.write('feature-map refused: feature-map requires --feature <id|slug>\n');
    return 1;
  }
  const flowDir = join(repoRoot, 'flow');
  const feature = findFeatureByRef(readFeatures(flowDir), ref);
  if (feature === undefined) {
    process.stdout.write(
      `feature-map refused: no feature '${ref}' — run \`blueprint features graph\` to list them\n`,
    );
    return 1;
  }
  const map = deriveFeatureMap(repoRoot, feature);
  if (options.json === true) {
    process.stdout.write(`${JSON.stringify(map, null, 2)}\n`);
    return 0;
  }
  const folders = map.files.filter((node) => node.kind === 'folder').length;
  process.stdout.write(
    `feature-map: ${map.feature} — ${map.files.length} nodes (${folders} folders) · ${map.edges.length} import edges · ${map.unresolved.length} unresolved\n`,
  );
  for (const node of map.files) {
    const owner = node.part ?? 'feature';
    const badges = node.badges.length > 0 ? ` (+${node.badges.join(', +')})` : '';
    process.stdout.write(`  ${node.kind === 'folder' ? 'dir ' : 'file'} ${node.path} — ${owner}${badges}\n`);
  }
  for (const miss of map.unresolved) {
    process.stdout.write(`  unresolved ${miss.anchor} — ${miss.reason}\n`);
  }
  return 0;
}

/**
 * `blueprint brief --plan <name> [--json]` — emit the change-brief delta.
 *
 * This is the seam between the pure model and every renderer: the IDE runs it
 * through a CLI runner (the `blueprint:reconcile` pattern) and feeds the JSON
 * straight to `board.showBrief(...)`. Read-only — it computes and prints,
 * writing nothing of record, so it is safe to call on every board read. (Its
 * `touches` read may refresh the self-ignored storyline import cache, exactly
 * as every `features graph` read does.)
 *
 * The human form prints a census rather than the whole delta, because the
 * delta's value is spatial and belongs on the board, not in a terminal.
 */
function runBrief(repoRoot: string, options: BlueprintCommandOptions): number {
  const flowDir = join(repoRoot, 'flow');
  const structureDir = join(flowDir, BLUEPRINT_DIRNAME);

  // --feature is the new scope; --plan is retained for the migration.
  const featureRef = options.feature ?? '';
  if (featureRef.length > 0) return runFeatureBrief(repoRoot, featureRef, options);

  const plan = options.plan ?? '';
  if (plan.length === 0) {
    return refuseBrief('brief requires --plan <name>');
  }

  // A DOOR MAY NAME ITS DOCUMENT VERSION (`--path`). A slug has many versions
  // — a thread that regenerated its discovery eight times shows eight cards —
  // and an older version's card must describe THAT version, not the newest.
  const pinned = resolvePinnedDoc(repoRoot, plan, options.path);
  if (pinned !== null && !pinned.ok) return refuseBrief(pinned.reason);
  const pinnedPath = pinned === null ? null : pinned.path;

  const story = readCompiledStory(structureDir);
  // WHICH DOCUMENT A COMPILED STORY SPEAKS FOR. Unpinned (the legacy door, or
  // a caller that names only a slug), story.json speaks for its slug, as it
  // always did. Pinned, it speaks ONLY for the exact document it was compiled
  // from: being the newest version is not enough, because a v8 written after
  // v7 was narrated would otherwise show v7's steps under v8's name.
  //
  // A story compiled from the PLAN does not cover a discovery either, newest or
  // not. The plan folds into the newest discovery's card, but it has its own
  // door there (its own path), and the discovery's door must describe what the
  // discovery says — which the doc fallback below compiles from its own
  // `## Story` in memory. Two docs, two views, never one wearing the other's
  // name.
  const pinnedRel = pinned === null ? null : pinned.relPath;
  // story.json is read unvalidated past `plan`/`steps`; a legacy one may carry
  // no sourcePath, and then it cannot be shown to speak for a pinned version.
  const storySource: unknown = story?.sourcePath;
  const storyRel =
    typeof storySource === 'string' && storySource.length > 0 ? normalizeDocPath(repoRoot, storySource) : null;
  const storyCovers =
    story !== null && story.plan === plan && (pinnedRel === null || storyRel === pinnedRel);
  if (!storyCovers) {
    // NO COMPILED STORY FOR THIS DOC — the majority case, and NOT a dead end
    // (#1914). A discovery/plan card's "Open discovery view" must always land
    // on something like a feature view, never a bare "narrate first" band. So
    // the brief falls back to the DOCUMENT ITSELF: its title and lead prose as
    // the feature-view identity, plus any proposal layer scoped to its slug.
    // Only a slug that resolves to no doc on disk is a true refusal.
    return runDocBrief(repoRoot, plan, options, pinnedPath);
  }

  const graph = readGraph(flowDir);
  const ofVersion = proposalVersionFilter(pinnedPath);
  const proposals = readEffectiveProposals(flowDir).filter(ofVersion);
  // The same renderer at plan scope: the proposal layer is scoped to THIS
  // plan's slug inside the model, so the whole store is handed over — narrowed
  // to the pinned VERSION's own proposals when a door named one.
  const delta = computeBriefDelta(story, graph, proposals, {
    proposals: readProposalsWithChange(flowDir, graph, repoRoot).filter(ofVersion),
    docs: readProposalSourceIndex(flowDir).liveDocs,
  });
  // The document this brief describes, echoed so a caller can check that the
  // version it asked for is the one it got (an older CLI ignores `--path`).
  const docPath = pinnedRel ?? storyRel;

  // Anchors + their resolution verdict drive the verification ledger: the
  // brief NAMES what it could not prove instead of quietly omitting it.
  //
  // WHAT THE DOCUMENT TOUCHES (additive): the features its anchors land in,
  // across the Workspace. Fail-soft — `touches: []` plus a notice, never a
  // refused brief.
  const touched = computeDocTouches(repoRoot, flowDir, story.steps);
  // An anchor the derived map cannot resolve may still be a SIBLING project's
  // file (`<project>/<path>` in a Workspace doc). The derived map is this
  // project's only, so it can never contain one; when the path exists in that
  // sibling's checkout (or, with no checkout, a sibling feature claims it) it
  // is resolved — and says where.
  const anchors = story.steps.flatMap((step) =>
    step.anchors.map((anchor) => {
      const ref = `${anchor.kind}:${anchor.ref}`;
      if (!step.unresolvedAnchors.includes(ref)) return { ref, resolved: true };
      const sibling = siblingResolution(anchorPathOf(anchor), touched);
      return sibling === null ? { ref, resolved: false } : { ref, resolved: true, project: sibling };
    }),
  );
  const steps = story.steps.map((step) => ({
    title: step.title,
    ...(step.kicker !== undefined ? { kicker: step.kicker } : {}),
    body: step.body,
    decisions: step.decisions,
    rejected: step.rejected,
  }));

  if (options.json === true) {
    process.stdout.write(
      `${JSON.stringify({
        ...delta,
        anchors,
        steps,
        ...(docPath !== null ? { docPath } : {}),
        touches: touched.touches,
        ...(touched.notice !== undefined ? { touchesNotice: touched.notice } : {}),
      })}\n`,
    );
    return 0;
  }

  const counts = { stable: 0, modify: 0, new: 0, remove: 0 };
  for (const node of delta.nodes) counts[node.kind] += 1;
  const today = delta.nodes.filter((node) => node.existsToday).length;
  process.stdout.write(
    `brief: ${plan} — today ${today} component(s) · after ` +
      `${counts.new} new, ${counts.modify} changed, ${counts.remove} removed · ` +
      `${delta.wires.length} wire(s)\n`,
  );
  const unproven = (delta.unchanged !== undefined ? 1 : 0) + delta.fails.length;
  process.stdout.write(
    `brief: ${anchors.filter((a) => a.resolved).length}/${anchors.length} anchors resolved · ` +
      `${unproven} authored claim(s) nothing can prove\n`,
  );
  process.stdout.write(`brief: ${delta.proposed.summary}\n`);
  for (const skipped of delta.proposed.skipped) {
    process.stdout.write(`  skipped ${skipped.fingerprint}: ${skipped.reason}\n`);
  }
  writeTouchesCensus(touched);
  return 0;
}

/** An anchor's path as `computeDocTouches` placed it (kind and locator stripped). */
function anchorPathOf(anchor: { kind: string; ref: string }): string {
  return anchorTarget(`${anchor.kind}:${anchor.ref}`);
}

/** The human form's touches lines: one per feature, then the notice. */
function writeTouchesCensus(touched: ReturnType<typeof computeDocTouches>): void {
  for (const touch of touched.touches) {
    const where = touch.project === null ? '' : `${touch.project} · `;
    const parts = touch.parts.length > 0 ? ` (${touch.parts.map((part) => part.name).join(', ')})` : '';
    process.stdout.write(`  touches ${where}${touch.featureName}${parts} — ${touch.anchors} anchor(s)\n`);
  }
  if (touched.notice !== undefined) process.stdout.write(`  touches: ${touched.notice}\n`);
}

/**
 * Resolve a doc slug to its newest file across the corpus dirs (#1914).
 *
 * A plan supersedes the discovery it was written from, and a discovery
 * supersedes a brainstorm, so the search is ordered — the first dir that has a
 * `<kind>_<slug>_v*.md` wins, newest version within it. Mirrors
 * `resolvePlanPath`'s version pick, widened to the other two corpus kinds so
 * the discovery-view door resolves the same docs the corpus browser lists.
 */
function resolveDocPath(flowDir: string, slug: string): string | null {
  const dirs: Array<{ dir: string; prefix: string }> = [
    { dir: join(flowDir, 'plans'), prefix: `plan_${slug}_v` },
    { dir: join(flowDir, 'discovery'), prefix: `discovery_${slug}_v` },
    { dir: join(flowDir, 'brainstorms'), prefix: `brainstorm_${slug}_v` },
  ];
  for (const { dir, prefix } of dirs) {
    if (!existsSync(dir)) continue;
    let best: { version: number; path: string } | null = null;
    for (const name of readdirSync(dir)) {
      if (!name.startsWith(prefix) || !name.endsWith('.md')) continue;
      const version = Number.parseInt(name.slice(prefix.length, name.length - '.md'.length), 10);
      if (!Number.isFinite(version)) continue;
      if (best === null || version > best.version) best = { version, path: join(dir, name) };
    }
    if (best !== null) return best.path;
  }
  return null;
}

/**
 * A pinned doc's name: `<kind>_<slug>_v<N>.md`, or an unversioned
 * `<kind>_<slug>.md` (which opened by slug before doors named a path, and must
 * keep opening). The slug is lazy so `_v<N>` is read as the version, never
 * swallowed into the slug.
 */
const PINNED_DOC_PATTERN = /^(plan|discovery|brainstorm)_(.+?)(?:_v(\d+))?\.md$/;

/**
 * A doc path as one canonical string: repo-relative, posix separators, no
 * leading `./`. story.json records `sourcePath` exactly as `narrate --from` was
 * typed, so `./flow/…`, an absolute path and `flow\…` all name the same file
 * and must compare equal to the door's `flow/…`.
 */
function normalizeDocPath(repoRoot: string, path: string): string {
  const posix = path.split('\\').join('/');
  const rel = isAbsolute(posix) ? relative_(repoRoot, posix).split('\\').join('/') : posix;
  return rel.replace(/^(\.\/)+/, '');
}

/**
 * Narrow the proposal layer to ONE document version's own proposals.
 *
 * The store records a proposal under the name its author passed to
 * `blueprint propose --plan`. Two attributions follow from it:
 *
 * 1. BY NAME — a proposal recorded under a versioned doc name of the pinned
 *    doc's kind and slug belongs to THAT version: the pinned one's own are
 *    always kept, another version's are always dropped.
 * 2. BY TIME — everything else (a bare slug, legacy records, and the documented
 *    `plan_<slug>_v1` convention discovery uses, which names no discovery
 *    version at all) cannot be attributed by name. For those, a version's
 *    picture is what had been proposed by the time it was WRITTEN: a proposal
 *    recorded after an older version's file was last written belongs to a
 *    later version. The newest version of its kind applies no time cut — it is
 *    where all later proposals of the slug land, exactly as before pinning.
 *
 * Nothing unattributable disappears from the slug: it stays on the newest
 * version, and on every older version written after it was proposed. A file
 * edited after the fact moves its cut later, which can only ADD ghosts, never
 * hide one. Unpinned (no path) keeps every proposal.
 */
function proposalVersionFilter(
  pinnedPath: string | null,
): (proposal: { plan: string; proposedAt: string }) => boolean {
  if (pinnedPath === null) return () => true;
  const pinnedName = basename(pinnedPath, '.md');
  const pinnedParts = PINNED_DOC_PATTERN.exec(basename(pinnedPath));
  let writtenAt: number | null = null;
  if (!isNewestVersion(pinnedPath)) {
    try {
      writtenAt = statSync(pinnedPath).mtimeMs;
    } catch (error) {
      // The doc was validated on disk a moment ago; a vanished file costs only
      // the time cut, never the brief, and says so.
      process.stderr.write(`brief: cannot read '${pinnedPath}' mtime — ${(error as Error).message}\n`);
    }
  }
  return (proposal) => {
    if (proposal.plan === pinnedName) return true;
    const recorded = PINNED_DOC_PATTERN.exec(`${proposal.plan}.md`);
    if (
      pinnedParts !== null &&
      recorded !== null &&
      recorded[3] !== undefined &&
      recorded[1] === pinnedParts[1] &&
      recorded[2] === pinnedParts[2]
    ) {
      return false; // another version of the same document
    }
    if (writtenAt === null) return true;
    const proposedAt = Date.parse(proposal.proposedAt);
    // An unparseable timestamp is unattributable: kept, never hidden.
    return !Number.isFinite(proposedAt) || proposedAt <= writtenAt;
  };
}

/**
 * Validate a `--path` the brief was asked to describe: repo-relative, one file
 * directly inside a flow doc dir (archive included), named for THIS slug, and
 * on disk. Null when no path was given; a refusal names what was wrong.
 */
function resolvePinnedDoc(
  repoRoot: string,
  slug: string,
  given: string | undefined,
): null | { ok: true; path: string; relPath: string } | { ok: false; reason: string } {
  if (given === undefined || given.length === 0) return null;
  // `./flow/…` or an absolute path inside the repo names the same file; one
  // outside the repo normalises to a `../` path the guards below refuse.
  const relPath = normalizeDocPath(repoRoot, given);
  const match = /^flow\/(plans|discovery|brainstorms|archive)\/([^/\\]+)$/.exec(relPath);
  const name = match?.[2] ?? '';
  const parts = PINNED_DOC_PATTERN.exec(name);
  if (match === null || relPath.includes('..') || parts === null || parts[2] !== slug) {
    return { ok: false, reason: `'${given}' is not a document of '${slug}'` };
  }
  const path = join(repoRoot, relPath);
  if (!existsSync(path)) return { ok: false, reason: `no doc at '${relPath}'` };
  return { ok: true, path, relPath };
}

/** Whether no higher version of the same kind sits beside `path`. */
function isNewestVersion(path: string): boolean {
  const parts = PINNED_DOC_PATTERN.exec(basename(path));
  if (parts === null) return true;
  const prefix = `${parts[1]}_${parts[2]}_v`;
  // An unversioned doc counts as version 0: any versioned sibling is newer.
  const version = parts[3] === undefined ? 0 : Number.parseInt(parts[3], 10);
  return !readdirSync(dirname(path)).some((name) => {
    if (!name.startsWith(prefix) || !name.endsWith('.md')) return false;
    const other = Number.parseInt(name.slice(prefix.length, name.length - '.md'.length), 10);
    return Number.isFinite(other) && other > version;
  });
}

/** The doc's first ATX H1 (`# Title`), trimmed — or null when it has none. */
function docTitle(body: string): string | null {
  for (const line of body.split('\n')) {
    const match = /^#\s+(.+?)\s*$/.exec(line);
    if (match !== null && match[1].trim().length > 0) return match[1].trim();
  }
  return null;
}

/**
 * A discovery/plan doc's lead summary (#1914). NOT `featureProse`: these docs
 * open with a metadata block (`**Feature slug**:`, `**Version**:`) and a `---`
 * rule before the first section, so taking "everything before the first `##`"
 * would render that boilerplate as the summary. This skips the title, the
 * metadata block and any horizontal rules, then returns the FIRST real prose
 * paragraph — the sentence a reader actually wrote about the change — even when
 * it sits under the doc's first section heading.
 */
function docProse(body: string): string {
  const isMeta = (line: string): boolean => /^\s*\*\*[^*]+\*\*\s*:/.test(line);
  const isRule = (line: string): boolean => /^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line);
  const isHeading = (line: string): boolean => /^#{1,6}\s/.test(line);
  const para: string[] = [];
  let started = false;
  for (const raw of body.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (!started) {
      // Skip the preamble: blank lines, the title and other headings, the
      // metadata block, and separator rules — none of which is a summary.
      if (line.trim() === '' || isHeading(line) || isMeta(line) || isRule(line)) continue;
      started = true;
      para.push(line);
      continue;
    }
    // The first paragraph ends at the next blank line, heading or rule.
    if (line.trim() === '' || isHeading(line) || isRule(line)) break;
    para.push(line);
  }
  const text = para
    .join(' ')
    // The same render-nothing markdown `featureProse` strips, plus inline code
    // fences, so the summary reads as sentences rather than source.
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .replace(/\*(.+?)\*/g, '$1')
    .replace(/\[\[(.+?)\]\]/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .trim();
  return text.length <= FEATURE_PROSE_CHARS ? text : `${text.slice(0, FEATURE_PROSE_CHARS)}…`;
}

/**
 * A brief built from the DOCUMENT itself, for a slug with no compiled story
 * (#1914). This is what the discovery-view door lands on for the majority of
 * docs — the ones nobody narrated or ran `blueprint propose` against. It is a
 * feature view of what the document is ABOUT: its title as the name, its lead
 * prose as the summary, plus any proposal layer scoped to the slug so a real
 * predicted picture still overlays when one exists.
 *
 * NEVER an empty room. The board renders `identity` even when the stage draws
 * nothing (the same rule a feature with no resolvable anchors follows), so the
 * reader always meets the doc's name and summary rather than a "narrate first"
 * band. Only a slug that resolves to no doc on disk is a true refusal.
 */
function runDocBrief(
  repoRoot: string,
  slug: string,
  options: BlueprintCommandOptions,
  pinnedPath: string | null = null,
): number {
  const flowDir = join(repoRoot, 'flow');
  const docPath = pinnedPath ?? resolveDocPath(flowDir, slug);
  if (docPath === null) {
    return refuseBrief(
      `no doc for '${slug}' — expected flow/{plans,discovery,brainstorms}/<kind>_${slug}_v*.md`,
    );
  }

  const body = readFileSync(docPath, 'utf-8');
  const graph = readGraph(flowDir);

  // A story scoped to THIS slug. Its `plan` scopes the proposal layer exactly
  // as a real story would — the one code path both cases share, rather than a
  // second proposal-scoping rule invented here.
  //
  // THE DOC'S OWN WIRING RIDES IN IT. The steps are the document's `## Story`,
  // compiled in memory (nothing is written, whatever story.json holds) and cut
  // down to their FLOWS: a discovery's declared `flow_after` is the only
  // account anywhere of how the pieces it predicts will connect — none of them
  // exist, so the code map has no edges for them — and dropping it drew those
  // pieces as a grid of islands. Anchors are left out on purpose: they would
  // add file nodes to a view that is about the predicted components.
  const sourcePath = relative_(repoRoot, docPath).split(/[\\/]/).join('/');
  // A pinned version draws its OWN proposals, not the slug's every version's.
  const ofVersion = proposalVersionFilter(pinnedPath);
  const effective = readEffectiveProposals(flowDir).filter(ofVersion);
  const compiled = compileStory({
    markdown: body,
    sourcePath,
    plan: slug,
    mode: 'draft',
    graph,
    proposals: effective,
  });
  const syntheticStory: CompiledStory = {
    plan: slug,
    sourcePath,
    mode: 'draft',
    steps:
      compiled.status === 'ok'
        ? compiled.story.steps.map((step) => ({ ...step, anchors: [], unresolvedAnchors: [], phases: [] }))
        : [],
    warnings: [],
  };
  const delta = computeBriefDelta(syntheticStory, graph, effective, {
    proposals: readProposalsWithChange(flowDir, graph, repoRoot).filter(ofVersion),
    docs: readProposalSourceIndex(flowDir).liveDocs,
  });
  // WHAT THE DOCUMENT TOUCHES — from the FULL compiled steps (anchors kept),
  // unlike the synthetic story above, which drops them from the drawing.
  const touched = computeDocTouches(repoRoot, flowDir, compiled.status === 'ok' ? compiled.story.steps : []);

  if (options.json === true) {
    process.stdout.write(
      `${JSON.stringify({
        ...delta,
        // ANATOMY, not delta: with no story there is no before/after, so the
        // board must not print "Today · before this plan / After · this plan".
        // A live proposal still supplies a second world; the view model reads
        // `mode` + the proposals together to decide the time switch.
        mode: 'anatomy',
        anchors: [],
        steps: [],
        // The document described, so a caller can check its pin was honoured.
        docPath: sourcePath,
        // What this document IS about — the feature-view identity, sourced from
        // the doc rather than from a feature file. Name is the doc's own H1; the
        // slug is the honest fallback when it has none.
        identity: {
          name: docTitle(body) ?? slug,
          prose: docProse(body),
          children: [],
          learnings: [],
        },
        touches: touched.touches,
        ...(touched.notice !== undefined ? { touchesNotice: touched.notice } : {}),
      })}\n`,
    );
    return 0;
  }

  const counts = { new: 0, modify: 0, remove: 0 };
  for (const node of delta.nodes) if (node.kind !== 'stable') counts[node.kind] += 1;
  process.stdout.write(
    `brief: ${docTitle(body) ?? slug} — document · ${delta.nodes.length} component(s) predicted · ` +
      `${counts.new} new, ${counts.modify} changed\n`,
  );
  process.stdout.write(`brief: ${delta.proposed.summary}\n`);
  for (const skipped of delta.proposed.skipped) {
    process.stdout.write(`  skipped ${skipped.fingerprint}: ${skipped.reason}\n`);
  }
  writeTouchesCensus(touched);
  return 0;
}

function runGateCheck(repoRoot: string, options: BlueprintCommandOptions): number {
  const flowDir = join(repoRoot, 'flow');
  const structureDir = join(flowDir, BLUEPRINT_DIRNAME);

  const plan = options.plan ?? '';
  if (plan.length === 0) {
    return refuseGateCheck('gate-check requires --plan <name>');
  }

  const planPath = resolvePlanPath(flowDir, plan);
  if (planPath === null) {
    return refuseGateCheck(`no plan doc found for '${plan}' (flow/plans/plan_${plan}_v*.md)`);
  }

  const phaseNumbers = parsePlan(planPath).map((phase) => phase.number);
  if (phaseNumbers.length === 0) {
    return refuseGateCheck(`plan '${plan}' declares no phases`);
  }

  const story = readCompiledStory(structureDir);
  if (story === null || story.plan !== plan) {
    // No narrated story for THIS plan → every phase is unmapped.
    return refuseGateCheck(
      `no compiled story for '${plan}' — run \`blueprint narrate --from ${planPath}\` first; ` +
        `uncovered phases: ${phaseNumbers.join(', ')}`,
    );
  }

  const graph = readGraph(flowDir);
  const proposals = readEffectiveProposals(flowDir);
  const gaps = phaseCoverageGaps(phaseNumbers, story, graph, proposals);

  if (gaps.length > 0) {
    return refuseGateCheck(`uncovered phases (no resolvable anchor): ${gaps.join(', ')}`);
  }

  // Gate passed — persist the predicted baseline (FR4). The gate is the single
  // plan-time checkpoint that already holds story+graph+proposals+planHash, so
  // it is the one place the baseline is written. Auto-regenerates (append-only)
  // when the plan changed since the last baseline.
  let baselineNote = '';
  try {
    const planHash = hashPlanContent(readFileSync(planPath, 'utf-8'));
    const result = ensureBaselineFresh(
      flowDir,
      plan,
      planHash,
      () => computeTouchedSets(story, graph, proposals),
      new Date().toISOString(),
    );
    baselineNote = result.regenerated ? ' · baseline written' : ' · baseline current';
  } catch {
    // Baseline persistence is best-effort — a write failure never fails the gate.
    baselineNote = ' · baseline skipped (write error)';
  }

  process.stdout.write(`gate-check: ok — ${phaseNumbers.length} phase(s) covered${baselineNote}\n`);
  return 0;
}

// ── reconcile (predicted vs actual) ──────────────────────

/** Refuse a reconcile: one-line reason on stdout (logger convention), exit 1. */
function refuseReconcile(reason: string): number {
  process.stdout.write(`reconcile refused: ${reason}\n`);
  return 1;
}

/**
 * Resolve a phase_result entry's touched anchors to node ids, grouped by phase.
 * Anchors that don't resolve (or malformed entries) are skipped per-anchor.
 */
function actualTouchedFromRounds(
  flowDir: string,
  graph: ReturnType<typeof readGraph>,
): ActualTouched[] {
  const proposals = readEffectiveProposals(flowDir);
  const byPhase = new Map<number, string[]>();
  for (const entry of readRoundsEntries(flowDir)) {
    if (entry.type !== 'phase_result') continue;
    const phase = typeof entry.phase === 'number' ? entry.phase : Number.parseInt(String(entry.phase ?? ''), 10);
    if (!Number.isInteger(phase)) continue;
    const rawAnchors = Array.isArray(entry.anchors) ? (entry.anchors as Anchor[]) : [];
    const resolved = resolveStoryAnchors(rawAnchors, graph, proposals);
    const ids = resolved.filter((r) => r.targetId !== null).map((r) => r.targetId!);
    if (ids.length === 0) continue;
    byPhase.set(phase, [...(byPhase.get(phase) ?? []), ...ids]);
  }
  return [...byPhase.entries()].map(([phase, nodeIds]) => ({ phase, nodeIds }));
}

/**
 * Reconcile a plan's predicted baseline against what its run actually touched
 * (FR5). Reads the `simulation_baseline` for the plan's CURRENT planHash and the
 * run's `phase_result` anchors, then classifies every node confirmed / missed /
 * surprise and reports the unforeseen (`surprise`) nodes that feed risk
 * raise-only (FR6/FR7). Read-only — the coordinator logs surprises + adjusts
 * risk from this output. `--json` emits the full reconciliation for machine use.
 */
function runReconcile(repoRoot: string, options: BlueprintCommandOptions): number {
  const flowDir = join(repoRoot, 'flow');
  const plan = options.plan ?? '';
  if (plan.length === 0) {
    return refuseReconcile('reconcile requires --plan <name>');
  }

  const planPath = resolvePlanPath(flowDir, plan);
  if (planPath === null) {
    return refuseReconcile(`no plan doc found for '${plan}'`);
  }

  let planHash: string;
  try {
    planHash = hashPlanContent(readFileSync(planPath, 'utf-8'));
  } catch {
    return refuseReconcile(`cannot read plan doc '${planPath}'`);
  }

  const baseline = readSimulationBaseline(flowDir, planHash);
  if (baseline === null) {
    return refuseReconcile(
      `no simulation baseline for '${plan}' at the current plan hash — the plan changed since the baseline, or none was written`,
    );
  }

  const graph = readGraph(flowDir);
  const actual = actualTouchedFromRounds(flowDir, graph);
  const reconciliation = reconcile(baseline.touchedSets, actual);
  const surprises = surpriseNodes(baseline.touchedSets, actual);

  if (options.json === true) {
    process.stdout.write(`${JSON.stringify({ reconciliation, surprises }, null, 2)}\n`);
    return 0;
  }

  const counts = { confirmed: 0, missed: 0, surprise: 0 };
  for (const node of reconciliation) counts[node.state]++;
  process.stdout.write(
    `reconcile: ${plan} — ${counts.confirmed} confirmed, ${counts.missed} missed, ${counts.surprise} surprise\n`,
  );
  if (surprises.length > 0) {
    process.stdout.write(`reconcile: unforeseen nodes (risk raise-only): ${surprises.join(', ')}\n`);
  }
  return 0;
}

// ── stale-check ──────────────────────────────────────────

/** Refuse a stale-check: one-line reason on stderr, exit code 1. Read-only — there is nothing to leave unwritten. */
function refuseStaleCheck(reason: string): number {
  process.stderr.write(`stale-check refused: ${reason}\n`);
  return 1;
}

/**
 * Pick the anchor shown in a stale note's human-readable bracket suffix: the
 * note's `module` anchor when it carries one (most informative alongside
 * `--module`), else its first anchor. Returns `null` for the (structurally
 * impossible — observe requires ≥1 anchor per note) empty case.
 */
function staleCheckDisplayAnchor(anchors: Anchor[]): Anchor | null {
  return anchors.find((anchor) => anchor.kind === 'module') ?? anchors[0] ?? null;
}

/**
 * `blueprint stale-check [--module <path>] [--json]` — read-only re-hash pass
 * over the investigation store (`computeStaleCheckReport` does the actual
 * work; see `../blueprint/stale-check.ts`). Never writes, and staleness is a
 * REPORT, not an error: exit 0 even when stale notes are found. Exit 1 is
 * reserved for usage errors (e.g. an empty `--module`) — nothing is ever
 * "refused" about the store's contents themselves. Returns the exit code.
 */
function runStaleCheck(repoRoot: string, options: BlueprintCommandOptions): number {
  if (options.module !== undefined && options.module.trim().length === 0) {
    return refuseStaleCheck('--module requires a non-empty path');
  }

  const flowDir = join(repoRoot, 'flow');
  const report = computeStaleCheckReport(flowDir, repoRoot, options.module);

  if (options.json) {
    const jsonReport = {
      checked: report.checked,
      fresh: report.fresh,
      stale: report.stale.map(({ fingerprint, anchors, changedFiles, missingFiles }) => ({
        fingerprint,
        anchors,
        changedFiles,
        missingFiles,
      })),
      // Feature edges ride the SAME report: one verb answers "what do I no
      // longer know is true", whether the claim was a note or a relationship.
      staleEdges: report.staleEdges,
    };
    process.stdout.write(`${JSON.stringify(jsonReport, null, JSON_INDENT)}\n`);
    return 0;
  }

  for (const entry of report.stale) {
    const changedCount = entry.changedFiles.length + entry.missingFiles.length;
    const displayAnchor = staleCheckDisplayAnchor(entry.anchors);
    const suffix = displayAnchor === null ? '' : ` [${displayAnchor.kind}:${displayAnchor.ref}]`;
    process.stdout.write(
      `stale: ${entry.fingerprint} — ${changedCount} of ${entry.totalStamps} stamped files changed${suffix}\n`,
    );
  }
  for (const edge of report.staleEdges) {
    const why = edge.state === 'missing' ? 'its mechanism is gone' : 'its mechanism changed';
    process.stdout.write(
      `stale: ${edge.feature} relates ${edge.target} — ${why} (${edge.via})` +
        (edge.note !== undefined ? ` — verify: ${edge.note}` : '') +
        '\n',
    );
  }
  process.stdout.write(
    `fresh: ${report.fresh} notes` +
      (report.staleEdges.length > 0 ? ` · ${report.staleEdges.length} stale edge(s)` : '') +
      '\n',
  );
  return 0;
}

// ── notes ────────────────────────────────────────────────

/**
 * `blueprint notes --anchor <kind:ref> [--json]` — which ACTIVE notes sit on one
 * anchor, with their fingerprints.
 *
 * WHY THIS EXISTS. `blueprint observe` refuses a plain write onto an anchor that
 * already carries an active note; the caller must pass `--supersedes
 * <fingerprint>`. The app resolved that fingerprint by scanning the snapshot's
 * investigation projection — which is capped at a display limit (100). On a
 * mature project the note it needs sits past the cap (orbit-app: index 356 of
 * 362 active notes), so nothing resolves, no supersede is passed, observe
 * refuses, and EVERY re-learn fails. The failure scales with project age, which
 * is why it went unnoticed.
 *
 * The fix is not a larger cap. The investigation store is THIS process's
 * authority on the fold and the fingerprint, so the question is answered here,
 * against the whole store, and the cap goes back to being what it should always
 * have been: a display limit with no say in correctness.
 *
 * Read-only. `readInvestigations` already returns non-superseded notes only, so
 * the fold is reused rather than reimplemented (allowed-pattern #14).
 */
function runNotes(repoRoot: string, options: BlueprintCommandOptions): number {
  const flowDir = join(repoRoot, 'flow');
  const raw = typeof options.anchor === 'string' ? options.anchor : '';
  const anchors = Array.isArray(options.anchor) ? options.anchor : raw.length > 0 ? [raw] : [];
  if (anchors.length !== 1) {
    process.stderr.write('notes refused: exactly one --anchor <kind:ref> is required\n');
    return 1;
  }
  const parsed = parseAnchorFlag(anchors[0]);
  if (parsed === null) {
    process.stderr.write(
      `notes refused: invalid anchor '${anchors[0]}' — expected <kind:ref> where kind is one of ${OBSERVE_ANCHOR_KINDS.join('|')}\n`,
    );
    return 1;
  }

  // Match on the REF, exactly as the contradiction rule does (observe compares
  // `note.anchors[].ref` against the request's refs). Matching any other way
  // would answer a different question than the one that blocks the write.
  const matching = readInvestigations(flowDir).notes.filter((note) =>
    note.anchors.some((anchor) => anchor.ref === parsed.ref),
  );

  if (options.json === true) {
    process.stdout.write(
      `${JSON.stringify({
        anchor: `${parsed.kind}:${parsed.ref}`,
        notes: matching.map((note) => ({
          fingerprint: investigationFingerprint(note),
          ts: note.ts,
          status: note.status,
          provenance: note.provenance,
          text: note.text,
          anchorRefs: note.anchors.map((anchor) => anchor.ref),
        })),
      })}\n`,
    );
    return 0;
  }

  if (matching.length === 0) {
    process.stdout.write(`notes: no active note on '${parsed.ref}'\n`);
    return 0;
  }
  for (const note of matching) {
    process.stdout.write(`notes: ${note.status} ${note.ts} — ${firstLineOf(note.text)}\n`);
  }
  process.stdout.write(`notes: ${matching.length} active note(s) on '${parsed.ref}'\n`);
  return 0;
}

/** First non-empty line of a note, for the human-readable listing. */
function firstLineOf(text: string): string {
  return text.split('\n').map((line) => line.trim()).find((line) => line.length > 0) ?? '(empty)';
}

// ── drift-check ──────────────────────────────────────────

/**
 * `blueprint drift-check [--json]` — read-only diff of the full-graph baseline
 * (`file-stamps.json`, written by every derive) against current disk content
 * (`computeDrift` does the work; see `../blueprint/drift-check.ts`). Unlike
 * `stale-check`, this surfaces changes to never-learned modules too. Never
 * writes, and drift is a REPORT, not an error: exit 0 even when drift is found
 * (a cold index — no baseline — reports no drift). `--json` emits the
 * deterministic report; human mode prints one line per entry then a summary.
 * Returns the process exit code.
 */
function runDriftCheck(repoRoot: string, options: BlueprintCommandOptions): number {
  const flowDir = join(repoRoot, 'flow');
  const graph = readGraph(flowDir);
  if (graph === null) {
    process.stdout.write('no blueprint — run `planflow-ai blueprint derive` first\n');
    return 1;
  }

  const report = computeDrift(repoRoot, flowDir, graph);

  if (options.json) {
    process.stdout.write(`${JSON.stringify(report, null, JSON_INDENT)}\n`);
    return 0;
  }

  if (report.baselineAt === null) {
    process.stdout.write('drift: no baseline yet — run `planflow-ai blueprint derive` first\n');
    return 0;
  }
  for (const entry of report.entries) {
    const nodeSuffix = entry.nodeId === undefined ? '' : ` (${entry.nodeId})`;
    const fromSuffix = entry.renamedFrom === undefined ? '' : ` ← ${entry.renamedFrom}`;
    process.stdout.write(`drift: ${entry.kind} ${entry.path}${fromSuffix}${nodeSuffix}\n`);
  }
  process.stdout.write(`drift: ${report.entries.length} change(s) since baseline\n`);
  return 0;
}

// ── forget ───────────────────────────────────────────────

/**
 * `blueprint forget` — forget everything the learner knows about this project.
 *
 * The board's Reset used to clear one file, the status table, while every
 * artifact the learning produced stayed on disk: the module docs, the
 * investigation notes and their heat, the generated feature views, and the
 * machine-owned sections inside each feature. The map came back looking as
 * informed as before, which is exactly what somebody who pressed Reset did not
 * ask for.
 *
 * `--dry-run` counts and writes nothing — what the board shows before asking.
 * `--json` prints the tally for a caller that will render it itself.
 *
 * NOT the whole brain: `decisions/`, `errors/`, a feature's name and prose, and
 * every derived structure file are kept. They are not things the learner knows.
 */
function runForget(repoRoot: string, options: BlueprintCommandOptions): number {
  const flowDir = join(repoRoot, 'flow');
  if (!existsSync(flowDir)) {
    process.stdout.write('forget: no flow/ directory — nothing has been learned here\n');
    return 0;
  }
  const dryRun = options.dryRun === true;
  const tally = forgetLearning(flowDir, { dryRun });
  if (options.json === true || options.json === 'true') {
    process.stdout.write(`${JSON.stringify({ dryRun, ...tally })}\n`);
    return 0;
  }
  process.stdout.write(`${describeForget(tally, dryRun)}\n`);
  if (!dryRun) {
    process.stdout.write(
      'forget: kept every feature\u2019s name and prose, your decisions and errors, and the derived map\n',
    );
  }
  return 0;
}

// ── drift-reset ──────────────────────────────────────────

/**
 * `blueprint drift-reset` — force re-establish the drift baseline to the CURRENT
 * tree ("mark everything reviewed"). Unlike derive (which establishes the
 * baseline only when missing), this always rewrites `file-stamps.json` from the
 * current graph + disk content, clearing drift to empty. Requires a derived
 * graph — with none, exits 1 with a clear message. `writeFileStamps` is
 * fail-soft, so a stamp failure prints the summary but never throws.
 */
function runDriftReset(repoRoot: string): number {
  const flowDir = join(repoRoot, 'flow');
  const graph = readGraph(flowDir);
  if (graph === null) {
    process.stdout.write('no blueprint — run `planflow-ai blueprint derive` first\n');
    return 1;
  }
  // Stat pre-filter: the prior baseline's own stamps serve as hints — a file
  // whose mtime+size still match its stamp reuses the stored hash; changed
  // files re-hash content (the truth, forbidden-pattern #10).
  const store = computeFileStamps(repoRoot, graph, { previous: readFileStamps(flowDir) });
  writeFileStamps(flowDir, store);
  process.stdout.write(`drift: baseline reset to ${store.stamps.length} file(s) — all reviewed\n`);
  return 0;
}

// ── drift-ack ────────────────────────────────────────────

/**
 * `blueprint drift-ack --paths <comma-separated>` — advance the drift baseline
 * for specific reviewed files ("mark these files reviewed"). Each path is
 * re-stamped to its current content so it stops reading as drift;
 * now-missing files drop their stamp. Read-tolerant: an empty or absent
 * `--paths` is a no-op success (exit 0). `advanceFileStamps` is fail-soft, so a
 * baseline that cannot be advanced still exits 0 with a summary.
 */
function runDriftAck(repoRoot: string, options: BlueprintCommandOptions): number {
  const flowDir = join(repoRoot, 'flow');
  const paths = (options.paths ?? '')
    .split(',')
    .map((path) => path.trim())
    .filter((path) => path.length > 0);
  if (paths.length === 0) {
    process.stdout.write('drift: no paths to acknowledge\n');
    return 0;
  }
  advanceFileStamps(repoRoot, flowDir, paths);
  process.stdout.write(`drift: acknowledged ${paths.length} path(s)\n`);
  return 0;
}

// ── tiers ────────────────────────────────────────────────

/**
 * `blueprint tiers [--json]` — read-only report over the trust-tier sidecar
 * (`file-tiers.json`, recomputed by every derive). Prints per-tier tallies
 * plus per-verdict staleness: each recorded verdict's doc and
 * verified-against files are re-hashed via `verdictIsStale` — content hash is
 * the only truth (forbidden-pattern #10). Staleness is a REPORT, not an
 * error: exit 0 even when stale verdicts are found. Exit 1 is reserved for a
 * missing store (nothing to report on). `--json` emits the deterministic
 * report; human mode prints one summary line. Returns the exit code.
 */
function runTiers(repoRoot: string, options: BlueprintCommandOptions): number {
  const flowDir = join(repoRoot, 'flow');
  const store = readFileTiers(flowDir);
  if (store === null) {
    process.stdout.write('tiers refused: no tier store — run `planflow-ai blueprint derive` first\n');
    return 1;
  }

  const tallies = tierTallies(store);
  // Entries are already path-sorted, so this list is deterministic too.
  const staleVerdicts = store.entries
    .filter((entry) => entry.verdict !== undefined && verdictIsStale(repoRoot, entry))
    .map((entry) => entry.path);

  if (options.json) {
    const report = { derivedAt: store.derivedAt, tallies, staleVerdicts };
    process.stdout.write(`${JSON.stringify(report, null, JSON_INDENT)}\n`);
    return 0;
  }

  const verdictTotal =
    tallies.verdicts.corroborated + tallies.verdicts.contradicted + tallies.verdicts.unverifiable;
  process.stdout.write(
    `tiers: ${store.entries.length} file(s) — code ${tallies.code} · own ${tallies.own} · claim ${tallies.claim} · other ${tallies.other} · verdicts ${verdictTotal} (${staleVerdicts.length} stale)\n`,
  );
  return 0;
}

// ── adjudicate ───────────────────────────────────────────

/** Refuse an adjudicate write: one-line reason, exit code 1, nothing written. */
function refuseAdjudicate(reason: string): number {
  process.stdout.write(`adjudicate refused: ${reason}\n`);
  return 1;
}

/**
 * `blueprint adjudicate --path <doc> --verdict <verdict> [--against <paths>]
 * [--evidence <text>]` — record an adjudication verdict for a claim-tier file.
 * Thin CLI shim over `recordVerdict`, the ONE verdict write path
 * (allowed-pattern #14): flag validation happens here, store/tier/hash
 * validation happens there. `--against` is comma-separated repo-relative code
 * paths; unhashable witnesses are skipped by the store. Returns the exit code.
 */
function runAdjudicate(repoRoot: string, options: BlueprintCommandOptions): number {
  const path = options.path?.trim() ?? '';
  if (path.length === 0) {
    return refuseAdjudicate('--path requires a repo-relative doc path');
  }
  const verdict = options.verdict?.trim() ?? '';
  if (!TIER_VERDICT_KINDS.includes(verdict as TierVerdictKind)) {
    return refuseAdjudicate('--verdict must be corroborated|contradicted|unverifiable');
  }
  const against = (options.against ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  const evidence = options.evidence?.trim();

  // Per-claim breakdown (doc-verification): --claims-json '[{claim,outcome,witnesses[],note?}]'
  // — the verify-doc runner's payload. Malformed JSON refuses loudly.
  let claims: VerdictClaim[] | undefined;
  if (options.claimsJson !== undefined && options.claimsJson.trim().length > 0) {
    try {
      const parsed = JSON.parse(options.claimsJson) as VerdictClaim[];
      if (!Array.isArray(parsed) || parsed.some((claim) => typeof claim?.claim !== 'string' || !TIER_VERDICT_KINDS.includes(claim.outcome) || !Array.isArray(claim.witnesses))) {
        return refuseAdjudicate('--claims-json must be an array of {claim, outcome, witnesses[]}');
      }
      claims = parsed;
    } catch {
      return refuseAdjudicate('--claims-json is not valid JSON');
    }
  }
  const provenance = options.provenance?.trim() as VerdictProvenance | undefined;
  if (provenance !== undefined && !['user', 'learn-pass', 'verify-agent', 'auto'].includes(provenance)) {
    return refuseAdjudicate('--provenance must be user|learn-pass|verify-agent|auto');
  }

  const result = recordVerdict(repoRoot, join(repoRoot, 'flow'), {
    path,
    verdict: verdict as TierVerdictKind,
    against,
    ...(evidence !== undefined && evidence.length > 0 ? { evidence } : {}),
    ...(claims !== undefined ? { claims } : {}),
    ...(provenance !== undefined ? { provenance } : {}),
  });
  if (!result.ok) {
    return refuseAdjudicate(result.reason ?? 'verdict write failed');
  }
  process.stdout.write(`adjudicated: ${path} ${verdict}\n`);
  return 0;
}

/**
 * The consumed contract slice for one linked sibling (federation Phase 6):
 * confirmed links with their consuming files, proposed count, and the surface
 * vintage — capped, with the mandatory drill-down hint. Advisory tone: the
 * agent learns what THIS project depends on, not the sibling's whole graph.
 */
function emitProjectContext(repoRoot: string, provider: string): number {
  const structureDir = join(repoRoot, 'flow', 'brain', '.structure');
  const links = readCrossLinks(structureDir).filter((link) => link.provider === provider);
  if (links.length === 0) {
    process.stdout.write(`No cross-links recorded for '${provider}' — derive to match, or link manually: planflow-ai blueprint link --project ${provider} --endpoint "GET /path"\n`);
    return 1;
  }
  const confirmed = links.filter((link) => link.status === 'confirmed' || link.status === 'stale');
  const proposed = links.filter((link) => link.status === 'proposed');
  const surface = readSiblingSurfaces(getVaultDir(), repoRoot).surfaces.find(
    (candidate) => candidate.project === provider,
  );
  const lines: string[] = [];
  lines.push(`# Consumed surface: ${provider}`);
  lines.push(
    surface !== undefined
      ? `Surface derived ${surface.derivedAt} · ${surface.endpoints.length} endpoint(s), ${surface.graphqlOperations.length} GraphQL op(s) exposed in total · repo ${surface.repoPath}`
      : `Surface not published — freshness unknown; refresh from the peer card.`,
  );
  lines.push('');
  lines.push(`## Confirmed dependencies (${confirmed.length})`);
  for (const link of confirmed.slice(0, 40)) {
    const stale = link.status === 'stale' ? ' [stale — consumer call no longer found]' : '';
    const callers = link.files.slice(0, 3).join(', ');
    lines.push(`- ${link.endpoint}${stale}${callers !== '' ? ` — called from ${callers}` : ''}`);
  }
  if (confirmed.length > 40) {
    lines.push(`- …and ${confirmed.length - 40} more`);
  }
  if (proposed.length > 0) {
    lines.push('');
    lines.push(`## Proposed (unconfirmed — treat as hints, not facts): ${proposed.length}`);
    for (const link of proposed.slice(0, 10)) {
      lines.push(`- ${link.endpoint} (${link.confidence})`);
    }
  }
  lines.push('');
  lines.push(`Drill down: \`planflow-ai blueprint context <module>\` on a consuming module, or open ${provider}'s own blueprint for its full graph.`);
  process.stdout.write(`${lines.join('\n')}\n`);
  return 0;
}

/**
 * `blueprint workspace graph [--target <repo>] [--workspace <w>] [--json]`.
 * Refusals follow the Workspace family: the JSON payload line on stdout, then
 * one `blueprint refused: <reason> — <sentence>` line, exit 1.
 */
function runWorkspaceGraph(target: string | undefined, options: BlueprintCommandOptions): number {
  if (target !== 'graph') {
    process.stdout.write(`${JSON.stringify({ action: 'workspace-graph', refused: 'unknown-action', detail: 'expected: workspace graph' })}\n`);
    process.stdout.write(`blueprint refused: unknown-action — expected \`blueprint workspace graph\`\n`);
    return 1;
  }
  try {
    const result = buildWorkspaceGraph({
      ...(typeof options.target === 'string' && options.target !== '' ? { target: resolve(options.target) } : {}),
      ...(typeof options.workspace === 'string' && options.workspace !== '' ? { workspace: options.workspace } : {}),
    });
    process.stdout.write(options.json === true ? `${JSON.stringify(result)}\n` : `${describeWorkspaceGraph(result).join('\n')}\n`);
    return 0;
  } catch (error) {
    if (error instanceof WorkspaceRefusal) {
      process.stdout.write(`${JSON.stringify({ action: 'workspace-graph', ...error.payload })}\n`);
      process.stdout.write(`blueprint refused: ${error.reason} — ${error.sentence}\n`);
      return 1;
    }
    process.stdout.write(`blueprint refused: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

export async function runBlueprint(
  action: string,
  target: string | undefined,
  options: BlueprintCommandOptions,
): Promise<void> {
  const repoRoot = process.cwd();

  switch (action) {
    case 'derive': {
      try {
        const lines = deriveBlueprint(repoRoot, options.runId ?? null, {
          force: options.force === true,
        });
        process.stdout.write(`${lines.join('\n')}\n`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        process.stdout.write(`${message}\n`);
        process.exitCode = 1;
      }
      return;
    }

    case 'context': {
      if (target === undefined || target.trim().length === 0) {
        process.stdout.write('Usage: planflow-ai blueprint context <node>\n');
        process.exitCode = 1;
        return;
      }
      // Federation (Phase 6): `context project:<name>` emits the consumed
      // contract slice — the cross-repo awareness an attached peer card gives
      // the agent.
      if (target.startsWith('project:')) {
        process.exitCode = emitProjectContext(repoRoot, target.slice('project:'.length));
        return;
      }
      process.exitCode = emitContext(join(repoRoot, 'flow'), target, repoRoot);
      return;
    }

    case 'render': {
      try {
        // `--story` renders the story walkthrough; default (title sheet)
        // behavior is completely unchanged.
        process.exitCode = emitRender(repoRoot);
      } catch (error) {
        // Fail-soft, mirroring `derive`: one-line message, no stack trace
        const message = error instanceof Error ? error.message : String(error);
        process.stdout.write(`${message}\n`);
        process.exitCode = 1;
      }
      return;
    }

    case 'observe': {
      try {
        process.exitCode = runObserve(repoRoot, options);
      } catch (error) {
        // Fail-soft, mirroring `derive`: one-line message, no stack trace
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`observe refused: ${message}\n`);
        process.exitCode = 1;
      }
      return;
    }

    case 'propose': {
      try {
        process.exitCode = runPropose(repoRoot, options);
      } catch (error) {
        // Fail-soft, mirroring `observe`: one-line message (e.g. the store's
        // busy-lock notice), no stack trace, nothing written
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`propose refused: ${message}\n`);
        process.exitCode = 1;
      }
      return;
    }

    case 'link':
    case 'unlink': {
      // Manual cross-link decisions (Phase 3) — the ONE writer the app's ✓/✕
      // route through. `link` is born confirmed (user judgment); `unlink`
      // rejects (matcher won't re-propose a rejected fingerprint).
      const provider = options.project;
      const endpoint = options.endpoint;
      if (typeof provider !== 'string' || provider === '' || typeof endpoint !== 'string' || endpoint === '') {
        process.stderr.write(`${action} refused: --project <name> and --endpoint "<METHOD /path | query Name>" are required\n`);
        process.exitCode = 1;
        return;
      }
      try {
        const structureDir = join(repoRoot, 'flow', 'brain', '.structure');
        appendCrossLinkEvents(structureDir, [
          {
            ts: new Date().toISOString(),
            status: action === 'link' ? 'confirmed' : 'rejected',
            provider,
            endpoint,
            confidence: 'manual',
            files: [],
            surfaceDerivedAt: '',
            reason: action === 'link' ? 'declared by the user' : 'rejected by the user',
          },
        ]);
        process.stdout.write(`${action === 'link' ? 'linked' : 'unlinked'}: ${provider} ${endpoint}\n`);
      } catch (error) {
        process.stderr.write(`${action} refused: ${error instanceof Error ? error.message : String(error)}\n`);
        process.exitCode = 1;
      }
      return;
    }

    case 'sweep': {
      try {
        process.exitCode = runSweep(join(repoRoot, 'flow'), options);
      } catch (error) {
        // Fail-soft, mirroring `propose`: one-line message (e.g. the store's
        // busy-lock notice), no stack trace — already-appended events stand
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`sweep refused: ${message}\n`);
        process.exitCode = 1;
      }
      return;
    }

    case 'narrate': {
      try {
        process.exitCode = runNarrate(repoRoot, options);
      } catch (error) {
        // Fail-soft, mirroring `propose`: one-line message (e.g. the story
        // store's busy-lock notice), no stack trace — nothing written
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`narrate refused: ${message}\n`);
        process.exitCode = 1;
      }
      return;
    }

    case 'features': {
      try {
        process.exitCode =
          target === 'graph'
            ? await runFeaturesGraph(repoRoot, options)
            : target === 'discover'
              ? runFeaturesDiscover(repoRoot, options)
              : target === 'confirm'
                ? runFeaturesConfirm(repoRoot, options.plan ?? '', options)
                : target === 'reclass'
                  ? runFeaturesReclass(repoRoot, options)
                  : target === 'domains'
                    ? runFeaturesDomains(repoRoot, options)
                    : target === 'learned'
                      ? runFeaturesLearned(repoRoot, options)
                      : target === 'roster'
                        ? runFeaturesRoster(repoRoot, options)
                        : target === 'index'
                          ? runFeaturesIndex(repoRoot, options)
                          : target === 'view'
                            ? runFeaturesView(repoRoot, options)
                            : target === 'parts'
                              ? runFeaturesParts(repoRoot, options)
                              : target === 'heal'
                                ? runFeaturesHeal(repoRoot, options)
                                : target === 'relations'
                                  ? runFeaturesRelations(repoRoot, options)
                                  : target === 'ports'
                                    ? runFeaturesPorts(repoRoot, options)
                                    : target === 'home'
                                      ? runFeaturesHome(repoRoot, options)
                                      : target === 'role'
                                        ? runFeaturesRole(repoRoot, options)
                                        : runFeatures(repoRoot, options);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        process.exitCode = refuseFeatures(message);
      }
      return;
    }

    case 'workspace': {
      // `blueprint workspace graph` — the board's Workspace level: every
      // project's feature map, side by side, plus the links between them
      // (`blueprint/workspace-graph.ts`). The one source of the combined map.
      process.exitCode = runWorkspaceGraph(target, options);
      return;
    }

    case 'coverage': {
      try {
        process.exitCode = runCoverage(repoRoot, options);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        process.stdout.write(`coverage refused: ${message}\n`);
        process.exitCode = 1;
      }
      return;
    }

    case 'brief': {
      try {
        process.exitCode = runBrief(repoRoot, options);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        process.stdout.write(`brief refused: ${message}\n`);
        process.exitCode = 1;
      }
      return;
    }

    case 'feature-map': {
      try {
        process.exitCode = runFeatureMap(repoRoot, options);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        process.stdout.write(`feature-map refused: ${message}\n`);
        process.exitCode = 1;
      }
      return;
    }

    case 'gate-check': {
      try {
        process.exitCode = runGateCheck(repoRoot, options);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        process.stdout.write(`gate-check refused: ${message}\n`);
        process.exitCode = 1;
      }
      return;
    }

    case 'reconcile': {
      try {
        process.exitCode = runReconcile(repoRoot, options);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        process.stdout.write(`reconcile refused: ${message}\n`);
        process.exitCode = 1;
      }
      return;
    }

    case 'stale-check': {
      try {
        process.exitCode = runStaleCheck(repoRoot, options);
      } catch (error) {
        // Fail-soft, mirroring the other verbs — one-line message, no stack
        // trace. stale-check is read-only, so there is nothing to have
        // written partway.
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`stale-check refused: ${message}\n`);
        process.exitCode = 1;
      }
      return;
    }

    case 'notes': {
      try {
        process.exitCode = runNotes(repoRoot, options);
      } catch (error) {
        // Read-only, like stale-check — nothing can have been written partway.
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`notes refused: ${message}\n`);
        process.exitCode = 1;
      }
      return;
    }

    case 'drift-check': {
      try {
        process.exitCode = runDriftCheck(repoRoot, options);
      } catch (error) {
        // Fail-soft, mirroring the other verbs — one-line message, no stack
        // trace. drift-check is read-only, so there is nothing to have
        // written partway.
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`drift-check refused: ${message}\n`);
        process.exitCode = 1;
      }
      return;
    }

    case 'forget': {
      try {
        process.exitCode = runForget(repoRoot, options);
      } catch (error) {
        // Fail-soft, mirroring the other verbs — one line, no stack. Anything
        // already removed stays removed; the tally says what got through.
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`forget refused: ${message}\n`);
        process.exitCode = 1;
      }
      return;
    }

    case 'drift-reset': {
      try {
        process.exitCode = runDriftReset(repoRoot);
      } catch (error) {
        // Fail-soft, mirroring the other verbs — one-line message, no stack
        // trace. `writeFileStamps` is itself fail-soft; this guards the read.
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`drift-reset refused: ${message}\n`);
        process.exitCode = 1;
      }
      return;
    }

    case 'drift-ack': {
      try {
        process.exitCode = runDriftAck(repoRoot, options);
      } catch (error) {
        // Fail-soft, mirroring the other verbs — one-line message, no stack
        // trace. `advanceFileStamps` is itself fail-soft; this guards the parse.
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`drift-ack refused: ${message}\n`);
        process.exitCode = 1;
      }
      return;
    }

    case 'tiers': {
      try {
        process.exitCode = runTiers(repoRoot, options);
      } catch (error) {
        // Fail-soft, mirroring the other verbs — one-line message, no stack
        // trace. tiers is read-only, so there is nothing to have written
        // partway.
        const message = error instanceof Error ? error.message : String(error);
        process.stdout.write(`tiers refused: ${message}\n`);
        process.exitCode = 1;
      }
      return;
    }

    case 'promote-doc': {
      // doc-verification Phase 2: regenerate the promoted brain file (and
      // contradiction observations) from a doc's recorded per-claim verdict.
      const docPath = options.path?.trim() ?? '';
      if (docPath.length === 0) {
        process.stdout.write('promote refused: --path requires a repo-relative doc path\n');
        process.exitCode = 1;
        return;
      }
      const promoted = promoteDoc(repoRoot, docPath);
      if (!promoted.ok) {
        process.stdout.write(`promote refused: ${promoted.reason ?? 'unknown error'}\n`);
        process.exitCode = 1;
        return;
      }
      process.stdout.write(
        `promoted: ${docPath} — ${promoted.promotedClaims ?? 0} claim(s) → ${promoted.brainFile ?? ''}, ${promoted.contradictedObservations ?? 0} contradiction observation(s)\n`,
      );
      return;
    }

    case 'adjudicate': {
      try {
        process.exitCode = runAdjudicate(repoRoot, options);
      } catch (error) {
        // Fail-soft, mirroring the other verbs — one-line message, no stack
        // trace. `recordVerdict` refuses before writing, so nothing is left
        // half-written.
        const message = error instanceof Error ? error.message : String(error);
        process.stdout.write(`adjudicate refused: ${message}\n`);
        process.exitCode = 1;
      }
      return;
    }

    case 'index': {
      // `blueprint index warm` — build the storyline import index off every
      // interactive path (the graph read that found it cold, and the app's
      // once-per-project warm-up, start it detached). One build per project at
      // a time; a second answers `busy`. Prints one JSON line with --json.
      if (target !== 'warm') {
        process.stdout.write(`index refused: unknown sub-verb "${target ?? ''}" — the one sub-verb is warm\n`);
        process.exitCode = 1;
        return;
      }
      const warmRoot = typeof options.target === 'string' && options.target !== '' ? options.target : repoRoot;
      const result = await warmProjectImportIndex(warmRoot, new StorylineReaders(), storylineCacheDir(warmRoot));
      process.stdout.write(
        options.json === true
          ? `${JSON.stringify(result)}\n`
          : `index: ${result.status} · ${result.files} files · ${result.read} read · ${result.ms} ms\n`,
      );
      process.exitCode = 0;
      return;
    }

    case 'storyline': {
      // `blueprint storyline` — one file (or one part's files) read as a
      // story; the app's code view reads through this door only
      // (`blueprint/storyline-verb.ts`). Prints one JSON line; exit 1 only
      // for a bad question.
      const target = typeof options.target === 'string' && options.target !== '' ? options.target : repoRoot;
      // Bring the import index up to date with CONCURRENT reads first: the
      // verb's own read is serial, and on a cold checkout that was 15–20 s for
      // the first plan review (measured 17.4 s serial vs 3.8 s here on a fresh
      // 4,900-file clone). A standing index costs this a stat pass (~30 ms);
      // a build already running elsewhere (`busy`) leaves the verb to read as before.
      // Only for a question the verb will answer: a refused one writes nothing.
      const given = [options.file, options.part].filter((value) => typeof value === 'string' && value.trim() !== '').length;
      const planOnly = given === 0 && typeof options.plan === 'string' && options.plan.trim() !== '';
      if (given === 1 || planOnly) {
        await warmProjectImportIndex(target, new StorylineReaders(), storylineCacheDir(target)).catch(() => undefined);
      }
      const output = await runStorylineVerb({
        repoRoot: target,
        file: options.file,
        part: options.part,
        plan: options.plan,
        base: options.base,
      });
      process.stdout.write(output.stdout);
      process.exitCode = output.exitCode;
      return;
    }

    default:
      process.stdout.write(
        `Unknown blueprint action: "${action}". Valid actions: derive, context, render, observe, propose, sweep, narrate, gate-check, brief, feature-map, features, coverage, reconcile, stale-check, drift-check, drift-reset, drift-ack, tiers, adjudicate, index\n`,
      );
      process.exitCode = 1;
  }
}
