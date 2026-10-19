/**
 * Extractor orchestrator — runs all four native extractors against a repo
 * root and merges their fragments into one deduplicated, stable-sorted set
 * of nodes and edges plus a coverage report.
 *
 * The native path always produces a valid graph: graphify enrichment is
 * optional and applied elsewhere (`coverage.graphifyEnriched` is false here).
 * Coverage notes are human-readable and exhaustive — frameworks detected,
 * patterns matched, files skipped — so the CLI can print them with NO
 * silent gaps.
 */

import { join } from 'node:path';
import type { BlueprintCoverage, BlueprintEdge, BlueprintNode } from '../types.js';
import { mineSurfaces } from '../feature-surfaces.js';
import { extractDatastores } from './datastores.js';
import { extractEndpoints } from './endpoints.js';
import { extractIntegrations } from './integrations.js';
import { extractModules } from './modules.js';
import { discoverSpineRoots, isSourceFile, isTestFile, readFileSafe, sortEdges, sortNodes, walkRepo, type RepoScan } from './scan.js';
import { CONVENTION_PACKS } from './conventions/pack.js';

/** Names of the native extractors, in run order (packs append their names). */
const EXTRACTOR_NAMES = ['integrations', 'endpoints', 'datastores', 'modules'];

/** Result of a full native extractor run. */
export interface ExtractorRunResult {
  /** Deduplicated nodes, stable-sorted by id. */
  nodes: BlueprintNode[];
  /** Deduplicated edges, stable-sorted by source/target/relation. */
  edges: BlueprintEdge[];
  /** Coverage report for the run (native path: graphifyEnriched false). */
  coverage: BlueprintCoverage;
  /** Human-readable coverage notes for the CLI to print — no silent gaps. */
  coverageNotes: string[];
}

/** Deduplicate nodes by id — the first occurrence wins. */
function dedupeNodes(nodes: BlueprintNode[]): BlueprintNode[] {
  const byId = new Map<string, BlueprintNode>();
  for (const node of nodes) {
    if (!byId.has(node.id)) {
      byId.set(node.id, node);
    }
  }
  return [...byId.values()];
}

/** Deduplicate edges by source + target + relation. */
function dedupeEdges(edges: BlueprintEdge[]): BlueprintEdge[] {
  const byKey = new Map<string, BlueprintEdge>();
  for (const edge of edges) {
    const key = `${edge.source}\x00${edge.target}\x00${edge.relation}`;
    if (!byKey.has(key)) {
      byKey.set(key, edge);
    }
  }
  return [...byKey.values()];
}

/**
 * Run all native extractors against `repoRoot` and merge the fragments.
 *
 * Deterministic: the same code always produces the same output. Modules run
 * last and receive the nodes detected by the other extractors so it can emit
 * module→integration/datastore/endpoint attribution edges. Edges whose
 * source or target node is missing from the merged set are dropped.
 *
 * `repoScan` (optional) reuses a pre-computed `walkRepo` result — the derive
 * pipeline walks ONCE and threads the scan through every extractor and pack;
 * omitted, the repo is walked here once and shared the same way. The walk is
 * already sorted, so determinism is identical either way.
 */
export function runExtractors(repoRoot: string, repoScan?: RepoScan): ExtractorRunResult {
  const scan = repoScan ?? walkRepo(repoRoot);
  const integrations = extractIntegrations(repoRoot, scan);
  const endpoints = extractEndpoints(repoRoot, scan);
  const datastores = extractDatastores(repoRoot, scan);
  // Convention packs (#901): framework-dialect endpoints (Next.js file
  // conventions, GraphQL operations, …) — additive, run before modules so
  // their nodes get the same deepest-dir attribution edges.
  const packFragments = CONVENTION_PACKS.map((pack) => pack.extract(repoRoot, scan));
  const detectedNodes = [
    ...integrations.nodes,
    ...endpoints.nodes,
    ...datastores.nodes,
    ...packFragments.flatMap((fragment) => fragment.nodes),
  ];
  // Discover the spine roots once and seed the module extractor with them —
  // the folder tree is built per root (e.g. `src` AND `app/src`), so nodes
  // detected outside the primary src/ tree still land in a real folder home
  const spineRoots = discoverSpineRoots(repoRoot, scan);
  // Capability directories (feature-blueprint) are PINNED into the spine: a
  // directory the repo names after a feature — `e2e/tests/playbooks`,
  // `src/app/app/(protected)/playbooks` — is a real boundary, and the depth
  // cap is only a guess about where meaning stops. Without this the feature
  // board anchors at nodes the graph never emits, and every brief reports its
  // own feature as unverified. Fail-soft: mining is best-effort, and an empty
  // result simply leaves the spine exactly as it was.
  let pinnedDirs: string[] = [];
  try {
    pinnedDirs = [
      ...new Set(
        mineSurfaces(repoRoot).flatMap((candidate) =>
          candidate.signals.map((signal) => signal.path),
        ),
      ),
    ].sort();
  } catch {
    pinnedDirs = [];
  }
  const modules = extractModules(repoRoot, detectedNodes, spineRoots, scan, pinnedDirs);

  const nodes = sortNodes(dedupeNodes([...detectedNodes, ...modules.nodes]));
  const nodeIds = new Set(nodes.map((node) => node.id));
  const mergedEdges = dedupeEdges([
    ...integrations.edges,
    ...endpoints.edges,
    ...datastores.edges,
    ...packFragments.flatMap((fragment) => fragment.edges),
    ...modules.edges,
  ]);
  const edges = sortEdges(
    mergedEdges.filter((edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target)),
  );

  // Coverage — the same shared scan for the file counts, so filesScanned and
  // filesTotal reflect exactly what the extractors could see
  const candidateFiles = scan.files.filter(isSourceFile);
  // Test/fixture files the integration + endpoint extractors skip (#538) — reported
  // below so the exclusion is never a silent gap.
  const excludedTestFiles = candidateFiles.filter(isTestFile).length;
  let filesScanned = 0;
  for (const relPath of candidateFiles) {
    if (readFileSafe(join(repoRoot, relPath)) !== null) {
      filesScanned += 1;
    }
  }

  const coverage: BlueprintCoverage = {
    filesScanned,
    filesTotal: candidateFiles.length,
    extractorsRun: [...EXTRACTOR_NAMES, ...CONVENTION_PACKS.map((pack) => pack.name)],
    graphifyEnriched: false,
  };

  const coverageNotes: string[] = [
    ...integrations.coverageNotes,
    ...endpoints.coverageNotes,
    ...datastores.coverageNotes,
    ...packFragments.flatMap((fragment) => fragment.coverageNotes),
    ...modules.coverageNotes,
    `scan: spine roots: ${spineRoots.join(', ') || 'none'}`,
    `scan: ${filesScanned}/${candidateFiles.length} source file(s) readable (${scan.files.length} files walked)`,
    ...(excludedTestFiles > 0
      ? [`extractors: ${excludedTestFiles} test/fixture file(s) excluded from integration/endpoint detection (#538)`]
      : []),
  ];
  if (filesScanned < candidateFiles.length) {
    coverageNotes.push(`scan: ${candidateFiles.length - filesScanned} unreadable source file(s) skipped`);
  }
  if (scan.unreadableDirs.length > 0) {
    coverageNotes.push(`scan: ${scan.unreadableDirs.length} unreadable director(ies) skipped: ${scan.unreadableDirs.join(', ')}`);
  }

  return { nodes, edges, coverage, coverageNotes };
}

export { extractIntegrations } from './integrations.js';
export { extractEndpoints } from './endpoints.js';
export { extractDatastores } from './datastores.js';
export { extractModules } from './modules.js';
export { discoverSpineRoots } from './scan.js';
export type { ExtractorFragment } from './scan.js';
