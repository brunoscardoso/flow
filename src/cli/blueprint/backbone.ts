/**
 * Graphify BACKBONE merge for the blueprint system map.
 *
 * Promotes graphify's graph from enrichment to a structural SOURCE: when
 * graphify is INSTALLED and `graphify-out/graph.json` loads, graphify
 * symbols/files roll up into the module backbone alongside the native
 * extractors (dual-source — `DUAL_SOURCE_EXTRACTORS` in `validate.ts`).
 *
 * BACKBONE GRANULARITY is directory-only rollup (bound plan decision):
 * graphify symbols/files roll up to the deepest containing module directory —
 * NO file-level nodes are ever created.
 *
 * 1. Files covered by a native module directory roll up to the DEEPEST native
 *    module node — no new nodes.
 * 2. Files outside every native module (e.g. non-TS/JS languages the native
 *    extractors missed entirely) synthesize module nodes for their directory
 *    chains, following ALL module conventions the canonical validator
 *    enforces: id `module:<dir>`, `sourceFile` = dir, label = basename,
 *    `meta.depth` per spine-root semantics (the top-level directory becomes
 *    its own depth-1 root, `contains` chains give child.depth =
 *    parent.depth + 1, depth capped at `MODULE_TREE_DEPTH_CAP` with rollup —
 *    mirroring `extractors/modules.ts`).
 * 3. Graphify `calls`/`imports` edges between files owned by DIFFERENT
 *    modules become cross-module blueprint edges (deduplicated, sorted).
 *
 * Everything is deterministic (stable sorts everywhere) and the input graph
 * is never mutated. Fail-soft applies on every path except none: engine not
 * enabled → silent no-op; missing/corrupt graphify graph → input returned
 * unchanged plus a one-line notice. The merged graph must still pass
 * `validateCanonicalGraph` — that is the acceptance bar, enforced by the
 * derive pipeline's hard validation gate.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { graphifyAvailable } from './graphify-available.js';
import { MODULE_TREE_DEPTH_CAP } from './extractors/modules.js';
import { gitIgnoredDirs, isTestFile, isUnderIgnoredDir } from './extractors/scan.js';
import {
  edgeKey,
  GRAPHIFY_GRAPH_RELPATH,
  MODULE_EDGE_RELATIONS,
  moduleDirOf,
  moduleForFile,
  readGraphifyGraph,
  type GraphifyGraph,
  type ModuleDirRef,
} from './graphify-enrich.js';
import type { BlueprintEdge, BlueprintGraph, BlueprintNode } from './types.js';
import { CONVENTION_PACK_EXTRACTORS, DUAL_SOURCE_EXTRACTORS, MODULE_ID_PREFIX } from './validate.js';

/** Result of a backbone merge attempt. */
export interface BackboneResult {
  /** The (possibly merged) blueprint graph — the input when nothing merged. */
  graph: BlueprintGraph;
  /** Non-null only on the fail-soft path — the one-line user-facing notice. */
  notice: string | null;
  /** True only when the graphify graph loaded and the backbone merge ran. */
  merged: boolean;
  /** Module nodes synthesized for directories the native extractors missed. */
  synthesizedModuleCount: number;
  /** Files excluded from synthesis by the ignore vocabulary (#901) — loud, never silent. */
  ignoredSynthesisFileCount: number;
  /** Cross-module `imports`/`calls` edges appended from graphify edges. */
  crossModuleEdgeCount: number;
}

/** A synthesized module directory with its accumulated file counts. */
interface SynthesizedDirInfo {
  /** Repo-relative posix path of the module directory. */
  dir: string;
  /** Folder-tree depth: 1 = the directory's own top-level root. */
  depth: number;
  /** Graphify source files sitting directly in this directory (post-cap). */
  directFiles: number;
  /** Graphify source files rolled up from beyond the depth cap. */
  rolledUpFiles: number;
}

/**
 * Build the universal fail-soft result: input graph unmodified + one-line
 * notice. This IS the sanctioned handling for every backbone failure path.
 */
function unavailable(graph: BlueprintGraph, reason: string): BackboneResult {
  return {
    graph,
    notice: `graphify backbone unavailable (${reason}) — continuing with native structure.`,
    merged: false,
    synthesizedModuleCount: 0,
    ignoredSynthesisFileCount: 0,
    crossModuleEdgeCount: 0,
  };
}

/** The silent no-op result — engine not enabled, nothing to report. */
function silentNoop(graph: BlueprintGraph): BackboneResult {
  return {
    graph,
    notice: null,
    merged: false,
    synthesizedModuleCount: 0,
    ignoredSynthesisFileCount: 0,
    crossModuleEdgeCount: 0,
  };
}

/** The parent directory of a repo-relative posix path, or null at the top. */
function parentDirOf(dir: string): string | null {
  const lastSlash = dir.lastIndexOf('/');
  return lastSlash === -1 ? null : dir.slice(0, lastSlash);
}

/** The basename of a repo-relative posix path. */
function basenameOf(dir: string): string {
  const lastSlash = dir.lastIndexOf('/');
  return lastSlash === -1 ? dir : dir.slice(lastSlash + 1);
}

/**
 * The UNCAPPED directory chain of a repo-relative file outside every native
 * module: its top-level directory (the synthesized depth-1 root, mirroring
 * the legacy spine-root fallback in `scan.ts`), then every directory down to
 * the file's parent. Returns null for files sitting directly at the repo root
 * — there is no directory to synthesize a module for.
 */
/**
 * Directory names that must never become synthesized module nodes (#901):
 * the native spine's ignore vocabulary applied to the graphify rollup. Test/
 * mock/fixture paths reuse scan's isTestFile; dot-dirs and static-asset dirs
 * are named here. Without this, `__mocks__` / `.github` / `public` render as
 * top-level board modules on any repo graphify covers more broadly than the
 * native extractors.
 */
const SYNTHESIS_IGNORED_SEGMENTS = new Set(['public', 'static', 'assets']);

export function isIgnoredSynthesisPath(relPath: string): boolean {
  if (isTestFile(relPath)) {
    return true;
  }
  return relPath
    .split('/')
    .slice(0, -1)
    .some((segment) => segment.startsWith('.') || SYNTHESIS_IGNORED_SEGMENTS.has(segment));
}

function synthesizedChainOf(relPath: string): string[] | null {
  const segments = relPath.split('/');
  if (segments.length < 2) {
    return null; // Repo-root file — no containing directory
  }
  const chain: string[] = [];
  // Every segment but the last (the filename) extends the chain
  for (let end = 1; end < segments.length; end += 1) {
    chain.push(segments.slice(0, end).join('/'));
  }
  return chain;
}

/**
 * Index the graphify export: node id → source_file, plus the sorted set of
 * distinct source files (sorted for deterministic synthesis/attribution).
 */
function indexGraphifyFiles(graphify: GraphifyGraph): {
  fileById: Map<string, string>;
  sortedFiles: string[];
} {
  const fileById = new Map<string, string>();
  const files = new Set<string>();
  for (const node of graphify.nodes) {
    if (typeof node.id !== 'string' || typeof node.source_file !== 'string') {
      continue;
    }
    fileById.set(node.id, node.source_file);
    files.add(node.source_file);
  }
  return { fileById, sortedFiles: [...files].sort() };
}

/**
 * Merge the graphify graph into a deep copy of the blueprint graph as a
 * structural backbone source. The input graph is never mutated. The merged
 * copy's `coverage.extractorsRun` becomes the dual-source set — the graph now
 * genuinely has two structural sources.
 */
function mergeBackbone(
  graph: BlueprintGraph,
  graphify: GraphifyGraph,
  ignoredDirs: ReadonlySet<string>,
): BackboneResult {
  // Deep copy via JSON round-trip — the graph is plain JSON data by contract,
  // and this guarantees the input parameter is never mutated
  const merged = JSON.parse(JSON.stringify(graph)) as BlueprintGraph;

  const nativeModules: ModuleDirRef[] = merged.nodes
    .filter((node) => node.kind === 'module')
    .map((node) => ({ node, dir: moduleDirOf(node) }));

  const { fileById, sortedFiles } = indexGraphifyFiles(graphify);

  // Attribute every graphify file to its owning module id: the DEEPEST native
  // module when one contains it (directory-only rollup — no new nodes), else
  // a synthesized module directory registered from the file's capped chain.
  const synthesizedByDir = new Map<string, SynthesizedDirInfo>();
  const ownerIdByFile = new Map<string, string>();
  let ignoredSynthesisFiles = 0;

  for (const file of sortedFiles) {
    const nativeOwner = moduleForFile(file, nativeModules);
    if (nativeOwner !== null) {
      ownerIdByFile.set(file, nativeOwner.node.id);
      continue;
    }
    if (isIgnoredSynthesisPath(file) || isUnderIgnoredDir(file, ignoredDirs)) {
      ignoredSynthesisFiles += 1;
      // Ignore vocabulary (#901) — never synthesize junk modules — PLUS the
      // repo's own `.gitignore`, which is the same question asked of the file
      // whose job it is (#1800). The native walk has consulted git since #1588;
      // the backbone had not, so directories the native side deliberately
      // skipped came back in through the other source. `app/resources/cli` —
      // generated by `build-cli-bundle.mjs`, zero tracked files, a copy of
      // `src/` — arrived as the map's highest-degree node at 5,545 edges, so
      // blast-radius signals were computed partly against a shadow codebase and
      // coverage had a floor no feature could honestly lift.
      continue;
    }
    const chain = synthesizedChainOf(file);
    if (chain === null) {
      continue; // Repo-root file — no directory home, no attribution
    }
    const capped = chain.slice(0, MODULE_TREE_DEPTH_CAP);
    for (let index = 0; index < capped.length; index += 1) {
      if (!synthesizedByDir.has(capped[index])) {
        synthesizedByDir.set(capped[index], {
          dir: capped[index],
          depth: index + 1,
          directFiles: 0,
          rolledUpFiles: 0,
        });
      }
    }
    const owner = synthesizedByDir.get(capped[capped.length - 1]) as SynthesizedDirInfo;
    if (chain.length > MODULE_TREE_DEPTH_CAP) {
      owner.rolledUpFiles += 1; // File deeper than the cap — rolls up
    } else {
      owner.directFiles += 1; // Chain ends at the file's parent directory
    }
    ownerIdByFile.set(file, `${MODULE_ID_PREFIX}${capped[capped.length - 1]}`);
  }

  // Synthesized module nodes, mirroring the modules.ts node conventions.
  // A chain crossing a native module dir is impossible (the file would have
  // been covered), but existing ids are skipped defensively anyway.
  const existingNodeIds = new Set(merged.nodes.map((node) => node.id));
  const synthesizedInfos = [...synthesizedByDir.values()]
    .filter((info) => !existingNodeIds.has(`${MODULE_ID_PREFIX}${info.dir}`))
    .sort((a, b) => a.dir.localeCompare(b.dir));

  const synthesizedNodes: BlueprintNode[] = synthesizedInfos.map((info) => {
    const childDirs = synthesizedInfos.filter(
      (candidate) => parentDirOf(candidate.dir) === info.dir,
    ).length;
    const node: BlueprintNode = {
      id: `${MODULE_ID_PREFIX}${info.dir}`,
      kind: 'module',
      label: basenameOf(info.dir),
      sourceFile: info.dir,
      meta: {
        depth: info.depth,
        childDirs,
        fileCount: info.directFiles + info.rolledUpFiles,
        backbone: true,
      },
    };
    if (info.rolledUpFiles > 0 && node.meta !== undefined) {
      node.meta.rolledUp = true;
    }
    return node;
  });

  // `contains` spine for the synthesized chains (parent → child)
  const containsCandidates: BlueprintEdge[] = [];
  for (const info of synthesizedInfos) {
    const parentDir = parentDirOf(info.dir);
    if (parentDir === null || !synthesizedByDir.has(parentDir)) {
      continue; // Synthesized depth-1 root — no parent
    }
    containsCandidates.push({
      source: `${MODULE_ID_PREFIX}${parentDir}`,
      target: `${MODULE_ID_PREFIX}${info.dir}`,
      relation: 'contains',
    });
  }

  // Cross-module edges: graphify calls/imports whose endpoint files belong to
  // DIFFERENT owning modules (native or synthesized)
  const crossCandidates: BlueprintEdge[] = [];
  for (const edge of graphify.edges) {
    if (typeof edge.source !== 'string' || typeof edge.target !== 'string') {
      continue;
    }
    const relation = typeof edge.relation === 'string' ? edge.relation : '';
    if (!MODULE_EDGE_RELATIONS.includes(relation)) {
      continue;
    }
    const sourceFile = fileById.get(edge.source);
    const targetFile = fileById.get(edge.target);
    const sourceOwner = sourceFile === undefined ? undefined : ownerIdByFile.get(sourceFile);
    const targetOwner = targetFile === undefined ? undefined : ownerIdByFile.get(targetFile);
    if (sourceOwner === undefined || targetOwner === undefined || sourceOwner === targetOwner) {
      continue;
    }
    crossCandidates.push({ source: sourceOwner, target: targetOwner, relation });
  }

  // Append new nodes, keeping the graph's stable id sort
  merged.nodes = [...merged.nodes, ...synthesizedNodes].sort((a, b) => a.id.localeCompare(b.id));

  // Append deduplicated new edges in stable (sorted) order — contains first,
  // then cross-module; both deduped against the existing edge set
  const seenEdges = new Set(merged.edges.map(edgeKey));
  const appendUnique = (candidates: BlueprintEdge[]): BlueprintEdge[] => {
    const unique: BlueprintEdge[] = [];
    for (const candidate of candidates) {
      const key = edgeKey(candidate);
      if (seenEdges.has(key)) {
        continue;
      }
      seenEdges.add(key);
      unique.push(candidate);
    }
    unique.sort((a, b) => edgeKey(a).localeCompare(edgeKey(b)));
    return unique;
  };
  const newContains = appendUnique(containsCandidates);
  const newCross = appendUnique(crossCandidates);
  merged.edges.push(...newContains, ...newCross);

  // The graph now has two structural sources — record the dual-source set,
  // preserving any convention-pack names the native run contributed (#901).
  const packNames = graph.coverage.extractorsRun.filter((name) =>
    CONVENTION_PACK_EXTRACTORS.includes(name),
  );
  merged.coverage.extractorsRun = [...DUAL_SOURCE_EXTRACTORS, ...packNames];

  return {
    graph: merged,
    notice: null,
    merged: true,
    synthesizedModuleCount: synthesizedNodes.length,
    ignoredSynthesisFileCount: ignoredSynthesisFiles,
    crossModuleEdgeCount: newCross.length,
  };
}

/**
 * Merge the graphify graph into the blueprint graph as a structural backbone
 * source.
 *
 * Always-on (#142): merges whenever graphify is available and a graph exists —
 * no `engines.graphify` opt-in, and nothing writes that key any more (#1808). Silent no-op when graphify isn't installed (the
 * enrichment pass owns the single "not installed" notice, so backbone stays
 * quiet to avoid a duplicate). Every failure path returns the input graph
 * unmodified with a one-line notice; this function never throws.
 */
export function mergeGraphifyBackbone(graph: BlueprintGraph, repoRoot: string): BackboneResult {
  if (!graphifyAvailable()) {
    return silentNoop(graph);
  }

  const graphPath = join(repoRoot, GRAPHIFY_GRAPH_RELPATH);
  if (!existsSync(graphPath)) {
    return unavailable(graph, `no graph at ${GRAPHIFY_GRAPH_RELPATH}`);
  }

  const graphifyGraph = readGraphifyGraph(graphPath);
  if (graphifyGraph === null) {
    return unavailable(graph, `unparsable graph at ${GRAPHIFY_GRAPH_RELPATH}`);
  }

  try {
    // Asked ONCE per merge, like the walk asks once per walk — and inside the
    // try, so a git that errors takes the same fail-soft path everything else
    // here does rather than becoming the one thing that can stop a derive.
    return mergeBackbone(graph, graphifyGraph, gitIgnoredDirs(repoRoot));
  } catch (error) {
    // Defensive last-resort fail-soft: the backbone must never block the
    // native derive path
    const message = error instanceof Error ? error.message : String(error);
    return unavailable(graph, `backbone merge failed: ${message}`);
  }
}
