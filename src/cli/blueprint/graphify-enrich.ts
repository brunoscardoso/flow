/**
 * Graphify enrichment for the blueprint system map.
 *
 * When graphify is INSTALLED — availability, not a config key, has been the
 * gate since #142 (#1808) — this module reads `graphify-out/graph.json` at the
 * repo root DIRECTLY (plan decision — no `graphify affected/query` invocation)
 * and folds structural signals into a copy of the native blueprint graph:
 * per-module degree/community metrics (subtree-aggregated up the folder
 * hierarchy — a parent folder node's degree counts every graphify edge
 * touching a file in its subtree), cross-module edges between the deepest
 * containing folder nodes, and canonical graphify node ids as anchor hints
 * (attached to the deepest containing folder node for module nodes).
 *
 * Staleness is CONTENT-BASED, not mtime-vs-last-commit alone: the graph is
 * stale when the working tree has uncommitted SOURCE-file changes (`git
 * status --porcelain`) OR the last commit is newer than the graph file. A
 * FAILED stale refresh means STALE, NOT ABSENT — enrichment keeps the
 * last-known-good graph and proceeds with a loud notice. A never-initialized
 * graph (no file at all) gets ONE build attempt; only when that fails does
 * enrichment fall back native with the install/build instruction.
 *
 * Engine-registry fail-soft applies on every path: tool missing, graph file
 * absent after a build attempt, unparsable JSON — all return the input graph
 * UNCHANGED plus a one-line notice string. Enrichment never throws and never
 * blocks the native derive path. See
 * `.claude/resources/core/graphify-engine.md`.
 */

import { execSync, spawn } from 'node:child_process';

import { backgroundWorkDisabled } from '../utils/background-work.js';
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isSourceFile } from './extractors/scan.js';
import { ensureGraphifyOutLocal } from './graphify-out-symlink.js';
import { graphifyAvailable } from './graphify-available.js';
import type { BlueprintEdge, BlueprintGraph, BlueprintNode, GraphifyBuildState } from './types.js';

/** Timeout for the incremental `graphify update .` refresh (AST-only, 2-5s typical). */
const GRAPHIFY_UPDATE_TIMEOUT_MS = 30_000;

/** Timeout for cheap detection commands (`which graphify`, `git log`, `git status`). */
const DETECTION_TIMEOUT_MS = 5_000;

/** The incremental graphify refresh/build command. */
const GRAPHIFY_UPDATE_COMMAND = 'graphify update .';

/** Working-tree dirtiness probe — the content-based staleness signal. */
const GIT_STATUS_COMMAND = 'git status --porcelain';

/** Graphify edge relations that produce blueprint module→module edges. */
export const MODULE_EDGE_RELATIONS: readonly string[] = ['calls', 'imports'];

/** Repo-relative location of the graphify graph state. */
export const GRAPHIFY_GRAPH_RELPATH = join('graphify-out', 'graph.json');

/**
 * Repo-relative marker written when a never-initialized graph's FIRST build is
 * launched in the background (#535). Its presence + freshness lets subsequent
 * derives distinguish "a build is already running" from "no build launched yet"
 * without ever spawning a second concurrent build.
 */
export const GRAPHIFY_BUILD_MARKER_RELPATH = join('graphify-out', '.pf-building');

/**
 * How long a build marker stays "fresh" (#535). A first graph build on a large
 * repo (tens of thousands of nodes) runs for minutes, so the window is generous;
 * once it elapses with the graph still absent, the last build is treated as
 * failed — the marker is cleared so the next derive (a Refresh/retry) relaunches.
 */
export const GRAPHIFY_BUILD_MARKER_TTL_MS = 15 * 60 * 1000;

/** Result of an enrichment attempt: the (possibly enriched) graph plus an optional fallback notice. */
export interface GraphifyEnrichResult {
  graph: BlueprintGraph;
  /**
   * Non-null on the fail-soft path (graph returned unchanged) AND on the
   * last-known-good path (enrichment applied on a stale graph after a failed
   * refresh) — the one-line user-facing notice.
   */
  notice: string | null;
  /**
   * Set on the never-initialized path (#535): a first graph build is running in
   * the BACKGROUND (`'building'`) or the last background build overran its window
   * without producing a graph (`'failed'`). Undefined whenever a graph is present
   * (enriched or last-known-good) — the build lifecycle only applies before the
   * first graph exists. The derive surfaces this in `coverage.graphifyBuild` so
   * the board can show a degraded-structure banner instead of a silent empty sheet.
   */
  build?: GraphifyBuildState;
}

/** One node in the graphify NetworkX JSON export. */
export interface GraphifyNode {
  id?: unknown;
  source_file?: unknown;
  /** Community identifier — exported as `community` (older exports used `community_id`). */
  community?: unknown;
  community_id?: unknown;
}

/** One edge in the graphify NetworkX JSON export. */
export interface GraphifyEdge {
  source?: unknown;
  target?: unknown;
  relation?: unknown;
}

/** Parsed shape of `graphify-out/graph.json` after validation. */
export interface GraphifyGraph {
  nodes: GraphifyNode[];
  edges: GraphifyEdge[];
}

/**
 * Build the universal fallback result: input graph unmodified + one-line notice.
 * This IS the sanctioned handling for every graphify failure path.
 */
function unavailable(graph: BlueprintGraph, reason: string): GraphifyEnrichResult {
  return {
    graph,
    notice: `graphify unavailable (${reason}) — continuing with native structure.`,
  };
}

/**
 * Read the epoch seconds of the last commit, or null when it cannot be
 * determined (not a git repo, git missing). A null result skips the
 * staleness refresh rather than failing enrichment.
 */
function readLastCommitEpoch(repoRoot: string): number | null {
  try {
    const output = execSync('git log -1 --format=%ct', {
      cwd: repoRoot,
      encoding: 'utf-8',
      timeout: DETECTION_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const epoch = parseInt(output.trim(), 10);
    return Number.isNaN(epoch) ? null : epoch;
  } catch {
    // Staleness cannot be determined without git — proceed with the graph as-is
    return null;
  }
}

/**
 * Whether the working tree has uncommitted changes to SOURCE files — the
 * content signal mtime-vs-last-commit staleness misses entirely. Only files
 * with a source extension count (`isSourceFile` from `extractors/scan.ts` —
 * the same set the extractors scan), so touching e.g. markdown or the
 * graphify output itself never marks the graph stale. Returns null when git
 * is unavailable (not a repo, git missing) — dirtiness cannot be determined.
 */
function hasDirtySourceFiles(repoRoot: string): boolean | null {
  let output: string;
  try {
    output = execSync(GIT_STATUS_COMMAND, {
      cwd: repoRoot,
      encoding: 'utf-8',
      timeout: DETECTION_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    // Staleness cannot be determined without git — proceed with the graph as-is
    return null;
  }
  return output.split('\n').some((line) => {
    // Porcelain v1: `XY <path>`, renames as `XY <from> -> <to>` — the
    // post-rename path is the one that exists in the working tree
    if (line.length < 4) {
      return false;
    }
    const pathPart = line.slice(3);
    const arrowIndex = pathPart.indexOf(' -> ');
    const rawPath = arrowIndex === -1 ? pathPart : pathPart.slice(arrowIndex + 4);
    const path = rawPath.replace(/^"|"$/g, ''); // git quotes special-char paths
    return isSourceFile(path);
  });
}

/**
 * Content-based staleness of `graphify-out/graph.json`.
 *
 * Stale when (a) the working tree has uncommitted source-file changes, OR
 * (b) the last commit is newer than the graph file's mtime (the
 * committed-changes signal). Returns null when staleness cannot be
 * determined: git unavailable for BOTH signals (the existing sanctioned
 * fallback — the caller proceeds with the graph as-is), or the graph file
 * cannot be stat'ed.
 */
export function isGraphifyGraphStale(repoRoot: string): boolean | null {
  const graphPath = join(repoRoot, GRAPHIFY_GRAPH_RELPATH);
  let graphEpoch: number;
  try {
    graphEpoch = statSync(graphPath).mtimeMs / 1000;
  } catch {
    // No stat'able graph file — staleness is meaningless here; the caller
    // owns the never-initialized/unreadable handling
    return null;
  }

  const dirty = hasDirtySourceFiles(repoRoot);
  if (dirty === true) {
    return true;
  }
  const lastCommitEpoch = readLastCommitEpoch(repoRoot);
  if (lastCommitEpoch !== null && graphEpoch < lastCommitEpoch) {
    return true;
  }
  if (dirty === null && lastCommitEpoch === null) {
    // Staleness cannot be determined without git — proceed with the graph
    // as-is (existing sanctioned fallback)
    return null;
  }
  return false;
}

/** Outcome of a `graphify update .` invocation. */
interface GraphifyUpdateOutcome {
  ok: boolean;
  /** One-line failure reason — empty string on success. */
  reason: string;
}

/** One-line reason for a failed execSync invocation (timeout/exit/other). */
function describeExecFailure(error: unknown): string {
  const execError = error as { killed?: boolean; signal?: string; status?: number; message?: string };
  if (execError.killed === true || execError.signal === 'SIGTERM') {
    return `timed out after ${GRAPHIFY_UPDATE_TIMEOUT_MS / 1000}s`;
  }
  if (typeof execError.status === 'number') {
    return `exit code ${execError.status}`;
  }
  const message = typeof execError.message === 'string' ? execError.message : String(error);
  return message.split('\n')[0];
}

/** Run the incremental graphify refresh/build; never throws. */
function runGraphifyUpdate(repoRoot: string): GraphifyUpdateOutcome {
  // Ensure graphify-out is a real, gitignored local dir before it writes (#142)
  // — idempotent + fail-soft, so it's safe to call on every refresh.
  ensureGraphifyOutLocal(repoRoot);
  try {
    execSync(GRAPHIFY_UPDATE_COMMAND, {
      cwd: repoRoot,
      timeout: GRAPHIFY_UPDATE_TIMEOUT_MS,
      stdio: 'ignore',
    });
    return { ok: true, reason: '' };
  } catch (error) {
    // A failed refresh/build is a sanctioned condition — the caller decides
    // between last-known-good (stale graph exists) and unavailable (no graph)
    return { ok: false, reason: describeExecFailure(error) };
  }
}

/**
 * Launch `graphify update .` DETACHED in the background (#535) — the first build
 * on a large repo runs for minutes, well past any inline timeout, so it must not
 * block (or be killed by) the derive. Mirrors init's fire-and-forget first-build
 * pattern (graphify-rails' fireFirstGraphBuild): unref'd, stdio ignored, so the
 * derive process can exit while the build continues. Never throws — a spawn that
 * fails leaves no marker, so the next derive simply retries.
 */
function spawnDetachedBuild(repoRoot: string): boolean {
  // A DETACHED BUILD OUTLIVES THE TEST THAT STARTED IT (#1848). This is the
  // THIRD writer of the same temp directory, after init's daemon and the rails'
  // first build, and the last one standing: `settleInitBackgroundWork` awaits
  // the derive's promise, but the derive detaches this child and returns, so
  // the promise resolves while `graphify update` is still writing
  // `graphify-out/cache/`. Nothing is created here at all when background work
  // is off — including the directory, which is the thing cleanup tripped over.
  if (backgroundWorkDisabled()) return false;
  // Ensure graphify-out is a real, gitignored local dir before it writes (#142).
  ensureGraphifyOutLocal(repoRoot);
  try {
    const child = spawn('graphify', ['update', '.'], {
      cwd: repoRoot,
      detached: true,
      stdio: 'ignore',
    });
    child.on('error', () => undefined);
    child.unref();
    return true;
  } catch {
    return false;
  }
}

/** Absolute path to the background-build marker for a repo. */
function buildMarkerPath(repoRoot: string): string {
  return join(repoRoot, GRAPHIFY_BUILD_MARKER_RELPATH);
}

/**
 * Freshness of the background-build marker (#535), based on its mtime:
 *   - `'fresh'`  → a build was launched within the TTL and is presumed running
 *   - `'stale'`  → the marker outlived the TTL (the build died / never landed)
 *   - `'absent'` → no marker (no build launched yet, or it was cleared)
 */
function buildMarkerState(repoRoot: string, now: number): 'fresh' | 'stale' | 'absent' {
  try {
    const ageMs = now - statSync(buildMarkerPath(repoRoot)).mtimeMs;
    return ageMs < GRAPHIFY_BUILD_MARKER_TTL_MS ? 'fresh' : 'stale';
  } catch {
    return 'absent';
  }
}

/** Write/refresh the build marker; fail-soft (a marker we can't write just means the next derive re-launches). */
function writeBuildMarker(repoRoot: string): void {
  try {
    writeFileSync(buildMarkerPath(repoRoot), new Date().toISOString());
  } catch {
    // Non-fatal: without a marker the next derive re-spawns a build. Harmless.
  }
}

/** Remove the build marker (build succeeded, or a stale marker being reset for retry). */
export function clearBuildMarker(repoRoot: string): void {
  try {
    rmSync(buildMarkerPath(repoRoot), { force: true });
  } catch {
    // Non-fatal.
  }
}

/**
 * Handle a never-initialized graphify graph (no graph.json yet) by driving the
 * background-build lifecycle (#535). Returns the build state to surface, or null
 * once a graph exists (the caller falls through to enrichment). Pure w.r.t. the
 * clock via `now`; side effects (spawn, marker writes) are injectable for tests.
 */
export function resolveNeverInitializedBuild(
  repoRoot: string,
  now: number,
  deps: {
    launch: (repoRoot: string) => boolean;
    markerState: (repoRoot: string, now: number) => 'fresh' | 'stale' | 'absent';
    writeMarker: (repoRoot: string) => void;
    clearMarker: (repoRoot: string) => void;
  } = {
    launch: spawnDetachedBuild,
    markerState: buildMarkerState,
    writeMarker: writeBuildMarker,
    clearMarker: clearBuildMarker,
  },
): GraphifyBuildState {
  const marker = deps.markerState(repoRoot, now);
  if (marker === 'fresh') {
    // A build launched within the TTL is presumed still running — do NOT spawn a
    // second one; just report that structure is building.
    return 'building';
  }
  if (marker === 'stale') {
    // The last build outran its window without landing a graph — treat it as
    // failed and clear the marker so the next derive (a Refresh/retry) relaunches.
    deps.clearMarker(repoRoot);
    return 'failed';
  }
  // No build launched yet — kick one off in the background and mark it.
  if (deps.launch(repoRoot)) {
    deps.writeMarker(repoRoot);
  }
  return 'building';
}

/** ISO-8601 mtime of a file, or 'unknown time' when it cannot be stat'ed. */
function fileMtimeIso(filePath: string): string {
  try {
    return statSync(filePath).mtime.toISOString();
  } catch {
    // Notice construction must never throw — degrade the timestamp only
    return 'unknown time';
  }
}


/**
 * Parse and validate `graphify-out/graph.json`.
 * The NetworkX node_link export stores edges under `links`; older exports
 * use `edges` — both are accepted. Returns null when the file is unreadable
 * or the shape is not a node/edge graph. Shared with the backbone merge
 * (`backbone.ts`) — the single parse path for graphify exports.
 */
export function readGraphifyGraph(graphPath: string): GraphifyGraph | null {
  let parsed: { nodes?: unknown; edges?: unknown; links?: unknown };
  try {
    parsed = JSON.parse(readFileSync(graphPath, 'utf-8')) as { nodes?: unknown; edges?: unknown; links?: unknown };
  } catch {
    // Unreadable or corrupt JSON — sanctioned fallback, notice produced by caller
    return null;
  }

  const nodes = parsed.nodes;
  const edges = parsed.edges ?? parsed.links;
  if (!Array.isArray(nodes) || !Array.isArray(edges)) {
    return null;
  }
  return { nodes: nodes as GraphifyNode[], edges: edges as GraphifyEdge[] };
}

/** Extract the community identifier from a graphify node, if present. */
function communityOf(node: GraphifyNode): string | number | undefined {
  const value = node.community ?? node.community_id;
  if (typeof value === 'string' || typeof value === 'number') {
    return value;
  }
  return undefined;
}

/** A blueprint module node paired with the directory it covers. */
export interface ModuleDirRef {
  node: BlueprintNode;
  dir: string;
}

/**
 * Derive the directory a blueprint module node covers from its sourceFile.
 * A path whose last segment contains a dot is treated as a file and reduced
 * to its parent directory; otherwise the path itself is the module directory.
 * Shared with the backbone merge (`backbone.ts`).
 */
export function moduleDirOf(node: BlueprintNode): string {
  const path = node.sourceFile.replace(/\/+$/, '');
  const lastSlash = path.lastIndexOf('/');
  const lastSegment = lastSlash === -1 ? path : path.slice(lastSlash + 1);
  if (lastSegment.includes('.')) {
    return lastSlash === -1 ? '' : path.slice(0, lastSlash);
  }
  return path;
}

/** Whether a repo-relative file path falls under a module directory. */
export function fileUnderDir(file: string, dir: string): boolean {
  if (dir === '') {
    return true;
  }
  return file === dir || file.startsWith(`${dir}/`);
}

/**
 * All blueprint modules whose directory contains a file — with hierarchical
 * folder nodes this is the file's full ancestor chain (e.g. `src/cli` AND
 * `src/cli/blueprint` for `src/cli/blueprint/store.ts`).
 */
function modulesForFile(
  file: string,
  modules: Array<{ node: BlueprintNode; dir: string }>,
): Array<{ node: BlueprintNode; dir: string }> {
  return modules.filter((candidate) => fileUnderDir(file, candidate.dir));
}

/**
 * Resolve the most specific (longest-directory / deepest) blueprint module
 * covering a file, or null when no module directory contains it.
 * Shared with the backbone merge (`backbone.ts`).
 */
export function moduleForFile(
  file: string,
  modules: Array<{ node: BlueprintNode; dir: string }>,
): { node: BlueprintNode; dir: string } | null {
  let best: { node: BlueprintNode; dir: string } | null = null;
  for (const candidate of modulesForFile(file, modules)) {
    if (best === null || candidate.dir.length > best.dir.length) {
      best = candidate;
    }
  }
  return best;
}

/**
 * Sort community values deterministically: numeric values ascending first,
 * then strings lexicographically.
 */
function sortCommunities(values: Array<string | number>): Array<string | number> {
  return [...values].sort((a, b) => {
    if (typeof a === 'number' && typeof b === 'number') return a - b;
    if (typeof a === 'number') return -1;
    if (typeof b === 'number') return 1;
    return a.localeCompare(b);
  });
}

/** Dedup key for a blueprint edge. Shared with the backbone merge (`backbone.ts`). */
export function edgeKey(edge: BlueprintEdge): string {
  return `${edge.source}\x00${edge.target}\x00${edge.relation}`;
}

/**
 * Merge the graphify graph into a deep copy of the blueprint graph:
 * module degree/community metrics, cross-module edges, and graphify node id
 * anchor hints. The input graph is never mutated.
 */
function mergeGraphify(graph: BlueprintGraph, graphify: GraphifyGraph): BlueprintGraph {
  // Deep copy via JSON round-trip — the graph is plain JSON data by contract,
  // and this guarantees the input parameter is never mutated
  const enriched = JSON.parse(JSON.stringify(graph)) as BlueprintGraph;

  // Index graphify nodes: id → source_file, and source_file → [ids]
  const fileById = new Map<string, string>();
  const idsByFile = new Map<string, string[]>();
  for (const node of graphify.nodes) {
    if (typeof node.id !== 'string' || typeof node.source_file !== 'string') {
      continue;
    }
    fileById.set(node.id, node.source_file);
    const ids = idsByFile.get(node.source_file);
    if (ids === undefined) {
      idsByFile.set(node.source_file, [node.id]);
    } else {
      ids.push(node.id);
    }
  }

  const modules = enriched.nodes
    .filter((node) => node.kind === 'module')
    .map((node) => ({ node, dir: moduleDirOf(node) }));

  // Per-module metrics, SUBTREE-AGGREGATED across the folder hierarchy:
  // degree = graphify edges with an endpoint file under the module dir
  // (counted once per module — parents genuinely contain their subtree's
  // files, so this is a real aggregate, never a faked one); community span =
  // distinct community ids of graphify nodes whose file falls under the dir
  const degreeByModuleId = new Map<string, number>();
  const communitiesByModuleId = new Map<string, Set<string | number>>();

  for (const node of graphify.nodes) {
    if (typeof node.source_file !== 'string') {
      continue;
    }
    const community = communityOf(node);
    if (community === undefined) {
      continue;
    }
    for (const owner of modulesForFile(node.source_file, modules)) {
      let communities = communitiesByModuleId.get(owner.node.id);
      if (communities === undefined) {
        communities = new Set();
        communitiesByModuleId.set(owner.node.id, communities);
      }
      communities.add(community);
    }
  }

  const crossModuleCandidates: BlueprintEdge[] = [];
  for (const edge of graphify.edges) {
    if (typeof edge.source !== 'string' || typeof edge.target !== 'string') {
      continue;
    }
    const sourceFile = fileById.get(edge.source);
    const targetFile = fileById.get(edge.target);
    // Cross-module edges attach to the DEEPEST containing folder node
    const sourceModule = sourceFile === undefined ? null : moduleForFile(sourceFile, modules);
    const targetModule = targetFile === undefined ? null : moduleForFile(targetFile, modules);

    // Degree: count the edge once per module touched by either endpoint —
    // including every ANCESTOR folder node containing an endpoint file
    const touched = new Set<string>();
    if (sourceFile !== undefined) {
      for (const owner of modulesForFile(sourceFile, modules)) touched.add(owner.node.id);
    }
    if (targetFile !== undefined) {
      for (const owner of modulesForFile(targetFile, modules)) touched.add(owner.node.id);
    }
    for (const moduleId of touched) {
      degreeByModuleId.set(moduleId, (degreeByModuleId.get(moduleId) ?? 0) + 1);
    }

    // Cross-module edges: calls/imports connecting files in different module dirs
    const relation = typeof edge.relation === 'string' ? edge.relation : '';
    if (
      sourceModule !== null &&
      targetModule !== null &&
      sourceModule.node.id !== targetModule.node.id &&
      MODULE_EDGE_RELATIONS.includes(relation)
    ) {
      crossModuleCandidates.push({
        source: sourceModule.node.id,
        target: targetModule.node.id,
        relation,
      });
    }
  }

  // Write module metrics
  for (const { node } of modules) {
    const degree = degreeByModuleId.get(node.id) ?? 0;
    node.meta = { ...node.meta, degree };
    const communities = communitiesByModuleId.get(node.id);
    if (communities !== undefined && communities.size > 0) {
      const sorted = sortCommunities([...communities]);
      // Single community keeps its native type; a span joins into one string
      node.meta.community = sorted.length === 1 ? sorted[0] : sorted.join(',');
    }
  }

  // Append deduplicated cross-module edges in stable (sorted) order
  const seenEdges = new Set(enriched.edges.map(edgeKey));
  const newEdges: BlueprintEdge[] = [];
  for (const candidate of crossModuleCandidates) {
    const key = edgeKey(candidate);
    if (seenEdges.has(key)) {
      continue;
    }
    seenEdges.add(key);
    newEdges.push(candidate);
  }
  newEdges.sort((a, b) => edgeKey(a).localeCompare(edgeKey(b)));
  enriched.edges.push(...newEdges);

  // Anchor hints: canonical graphify node ids per blueprint node sourceFile.
  // The FULL sorted id set is stored — symbol-anchor resolution (`anchors.ts`)
  // matches against these ids, so capping here would falsely stale anchors on
  // symbols beyond the cap. Any display capping belongs at render time.
  for (const node of enriched.nodes) {
    const ids = idsByFile.get(node.sourceFile);
    if (ids === undefined || ids.length === 0) {
      continue;
    }
    node.meta = { ...node.meta, graphifyIds: [...ids].sort() };
  }

  // Module nodes have directory sourceFiles, so the file-keyed pass above
  // never matches them. Instead each graphify file's ids attach to the
  // DEEPEST containing folder node (bounded: files deeper than the module
  // depth cap belong to their depth-cap ancestor).
  const idsByModuleId = new Map<string, string[]>();
  for (const [file, ids] of idsByFile) {
    const owner = moduleForFile(file, modules);
    if (owner === null) {
      continue;
    }
    const existing = idsByModuleId.get(owner.node.id);
    if (existing === undefined) {
      idsByModuleId.set(owner.node.id, [...ids]);
    } else {
      existing.push(...ids);
    }
  }
  for (const { node } of modules) {
    const ids = idsByModuleId.get(node.id);
    if (ids === undefined || ids.length === 0) {
      continue;
    }
    node.meta = { ...node.meta, graphifyIds: [...ids].sort() };
  }

  enriched.coverage.graphifyEnriched = true;
  return enriched;
}

/**
 * Enrich a blueprint graph with graphify structural data.
 *
 * Always-on (#142): graphify enriches whenever the binary is available — no
 * `engines.graphify` opt-in. When graphify isn't installed, returns the input
 * graph unmodified with a one-line "not installed" notice (native-only); a
 * failed STALE refresh instead enriches on the last-known-good graph with a
 * loud notice. Never throws.
 */
export function enrichWithGraphify(
  repoRoot: string,
  graph: BlueprintGraph,
): GraphifyEnrichResult {
  if (!graphifyAvailable()) {
    return unavailable(graph, 'tool not installed — install with `uv tool install graphifyy`');
  }

  const graphPath = join(repoRoot, GRAPHIFY_GRAPH_RELPATH);
  let notice: string | null = null;

  if (!existsSync(graphPath)) {
    // Never-initialized: the first build on a large repo runs for MINUTES, well
    // past any inline timeout — a bounded execSync silently gave up here and left
    // the board a near-empty native-only sheet (#535). Instead drive a BACKGROUND
    // build and report its state; the graph fills in on a later derive (the main
    // process watches graph.json and re-derives when it lands).
    const build = resolveNeverInitializedBuild(repoRoot, Date.now());
    if (build === 'failed') {
      return {
        graph,
        notice: `graphify: code graph build did not finish — Refresh to retry, or run \`${GRAPHIFY_UPDATE_COMMAND}\`.`,
        build,
      };
    }
    return {
      graph,
      notice: 'graphify: building code graph in the background — structure will fill in shortly.',
      build,
    };
  } else if (isGraphifyGraphStale(repoRoot) === true) {
    // Content-based staleness (dirty source tree OR commit newer than the
    // graph): refresh incrementally. A FAILED refresh means STALE, NOT
    // ABSENT — keep the last-known-good graph and enrich anyway, loudly.
    const refresh = runGraphifyUpdate(repoRoot);
    if (!refresh.ok) {
      notice = `graphify refresh failed (${refresh.reason}) — using last-known-good graph from ${fileMtimeIso(graphPath)}`;
    }
  }

  // A graph now exists — any prior background-build marker (#535) has served its
  // purpose; clear it so a future never-initialized state starts a clean cycle.
  clearBuildMarker(repoRoot);

  const graphifyGraph = readGraphifyGraph(graphPath);
  if (graphifyGraph === null) {
    return unavailable(graph, `unparsable graph at ${GRAPHIFY_GRAPH_RELPATH}`);
  }

  try {
    return { graph: mergeGraphify(graph, graphifyGraph), notice };
  } catch (error) {
    // Defensive last-resort fail-soft: enrichment must never block the native path
    const message = error instanceof Error ? error.message : String(error);
    return unavailable(graph, `enrichment failed: ${message}`);
  }
}
