/**
 * Canonical schema validator — turns the L0 taxonomy into a SELF-VALIDATED
 * contract instead of a docs-only convention.
 *
 * `validateCanonicalGraph` is a pure function: it inspects a fully-built
 * `BlueprintGraph` (post-extraction, post-enrichment, post-must-review) and
 * returns every violation of the frozen contract. It never mutates the graph
 * and never touches the filesystem. Error ordering is deterministic (sorted),
 * so the same graph always produces the same error list.
 *
 * Validation failure is a HARD derive error — the ONE exception to the
 * blueprint's fail-soft philosophy (plan decision: hard-error, not
 * warn-and-write). An invalid graph is never written: `graph.json` and
 * `graph.prev.json` stay untouched, and relink/promotion never run against it.
 *
 * The frozen constants below ARE the contract. Extending them is a deliberate
 * schema-version decision, never a drive-by edit.
 */

import type { BlueprintGraph, BlueprintNode } from './types.js';

/** The frozen L0 node taxonomy. Sorted; compared as a set. */
export const FROZEN_NODE_KINDS: readonly string[] = Object.freeze([
  'datastore',
  'endpoint',
  'integration',
  'module',
]);

/** The frozen edge-relation vocabulary. Sorted; compared as a set. */
export const FROZEN_EDGE_RELATIONS: readonly string[] = Object.freeze([
  'calls',
  'contains',
  'exposes',
  'imports',
  'uses',
]);

/** The canonical native extractor set (CLI derive path), in run order. */
export const FROZEN_EXTRACTORS: readonly string[] = Object.freeze([
  'integrations',
  'endpoints',
  'datastores',
  'modules',
]);

/**
 * The app-workspace fallback extractor set. The app's embedded derive path
 * runs one consolidated extractor named `basic` instead of the four native
 * CLI extractors; the graphs it emits obey the same node/edge contract, so
 * canonical parity is preserved by accepting either set — never a mixture.
 */
export const FALLBACK_EXTRACTORS: readonly string[] = Object.freeze(['basic']);

/**
 * The dual-source backbone extractor set: the four native extractors PLUS the
 * graphify backbone merge. When the graphify engine is enabled and its graph
 * loads at derive time, graphify's modules/deps are promoted from enrichment
 * to a structural source alongside the native extractors — the coverage
 * report records that both sources built the graph. Accepted as a third legal
 * set (never mixed with `basic`); an additive canonical-contract extension,
 * the graph schema stays version 1.
 */
export const DUAL_SOURCE_EXTRACTORS: readonly string[] = Object.freeze([
  'graphify',
  'integrations',
  'endpoints',
  'datastores',
  'modules',
]);

/**
 * Convention-pack extractor names (#901): framework-dialect endpoint packs
 * (Next.js file conventions, GraphQL operations, FastAPI mounts). Additive canonical-contract
 * extension in the DUAL_SOURCE_EXTRACTORS tradition: the native and dual-source
 * sets each gain a pack-extended variant as legal `extractorsRun` values, so
 * graphs derived before the packs existed stay valid AND pack-carrying graphs
 * pass. Graph schema stays version 1. Must stay in lockstep with
 * `extractors/conventions/pack.ts` (`CONVENTION_PACKS` names) — a shape test
 * enforces it.
 */
export const CONVENTION_PACK_EXTRACTORS: readonly string[] = Object.freeze(['nextjs', 'graphql', 'fastapi']);

/** FROZEN_EXTRACTORS + convention packs — the native derive path today. */
export const FROZEN_WITH_PACKS_EXTRACTORS: readonly string[] = Object.freeze([
  ...FROZEN_EXTRACTORS,
  ...CONVENTION_PACK_EXTRACTORS,
]);

/** DUAL_SOURCE_EXTRACTORS + convention packs — the backbone-merged path today. */
export const DUAL_SOURCE_WITH_PACKS_EXTRACTORS: readonly string[] = Object.freeze([
  ...DUAL_SOURCE_EXTRACTORS,
  ...CONVENTION_PACK_EXTRACTORS,
]);

/** Module node id convention: `id === MODULE_ID_PREFIX + sourceFile`. */
export const MODULE_ID_PREFIX = 'module:';

/** Minimum legal `meta.depth` for a module node (1 = top-level source dir). */
export const MODULE_DEPTH_MIN = 1;

/**
 * Maximum legal `meta.depth` for a module node — a CORRUPTION bound, not a
 * policy one.
 *
 * It used to mirror `MODULE_TREE_DEPTH_CAP` (4) exactly. That coupling was
 * wrong in a way only real data showed: capability directories are pinned past
 * the cap on purpose (`src/app/app/(protected)/playbooks` is depth 5,
 * `src/app/api/external/playbooks` likewise), so the extractor legitimately
 * emits deeper nodes than the default cap. Mirroring turned that into 29
 * `canonical contract violation:` errors — and since contract violations are
 * the one place derive fails HARD, the whole graph was written as nothing.
 *
 * A ceiling that encodes the extractor's default policy cannot express a
 * deliberate exception to that policy. So this now bounds only the absurd —
 * runaway recursion or a corrupted chain — and leaves depth policy to the
 * extractor. The invariants that actually protect the graph are structural and
 * unchanged: the `module:<sourceFile>` id convention, child directories lying
 * strictly under their parent, and child depth being exactly parent depth + 1.
 */
export const MODULE_DEPTH_MAX = 16;

/** Result of a canonical contract validation run. */
export interface ValidationResult {
  /** True when the graph satisfies every frozen invariant. */
  ok: boolean;
  /** All violations found, sorted lexicographically (deterministic). */
  errors: string[];
}

/** Whether two string arrays contain the same members, order-insensitive. */
function sameMembers(actual: readonly string[], expected: readonly string[]): boolean {
  if (actual.length !== expected.length) {
    return false;
  }
  const sortedActual = [...actual].sort();
  const sortedExpected = [...expected].sort();
  return sortedActual.every((value, index) => value === sortedExpected[index]);
}

/** Human-readable rendering of a frozen set for error messages. */
function renderSet(values: readonly string[]): string {
  return `[${values.join(', ')}]`;
}

/**
 * Whether a module node's `meta.depth` is a legal integer depth. Depth-pair
 * checks on `contains` edges only run when BOTH endpoints pass this, so one
 * bad depth value yields one error — not a cascade.
 */
function hasValidDepth(node: BlueprintNode): boolean {
  const depth = node.meta?.depth;
  return (
    typeof depth === 'number' &&
    Number.isInteger(depth) &&
    depth >= MODULE_DEPTH_MIN &&
    depth <= MODULE_DEPTH_MAX
  );
}

/** Coverage invariant: extractorsRun is exactly one of the three frozen sets. */
function validateCoverage(graph: BlueprintGraph, errors: string[]): void {
  const extractorsRun = graph.coverage.extractorsRun;
  const isLegalSet =
    sameMembers(extractorsRun, FROZEN_EXTRACTORS) ||
    sameMembers(extractorsRun, DUAL_SOURCE_EXTRACTORS) ||
    sameMembers(extractorsRun, FALLBACK_EXTRACTORS) ||
    sameMembers(extractorsRun, FROZEN_WITH_PACKS_EXTRACTORS) ||
    sameMembers(extractorsRun, DUAL_SOURCE_WITH_PACKS_EXTRACTORS);
  if (!isLegalSet) {
    errors.push(
      `coverage.extractorsRun ${renderSet(extractorsRun)} matches none of the frozen extractor set ${renderSet(FROZEN_EXTRACTORS)}, the dual-source backbone set ${renderSet(DUAL_SOURCE_EXTRACTORS)}, the fallback set ${renderSet(FALLBACK_EXTRACTORS)}, or their convention-pack extensions (+ ${renderSet(CONVENTION_PACK_EXTRACTORS)})`,
    );
  }
}

/** Node invariants: frozen kinds and unique ids. */
function validateNodes(graph: BlueprintGraph, errors: string[]): void {
  const idCounts = new Map<string, number>();
  for (const node of graph.nodes) {
    if (!FROZEN_NODE_KINDS.includes(node.kind)) {
      errors.push(
        `node '${node.id}' has kind '${node.kind}' outside the frozen enum ${renderSet(FROZEN_NODE_KINDS)}`,
      );
    }
    idCounts.set(node.id, (idCounts.get(node.id) ?? 0) + 1);
  }
  for (const [id, count] of idCounts) {
    if (count > 1) {
      errors.push(`duplicate node id '${id}' (${count} occurrences)`);
    }
  }
}

/** Edge invariants: no dangling endpoints, frozen relation vocabulary. */
function validateEdges(
  graph: BlueprintGraph,
  nodeById: Map<string, BlueprintNode>,
  errors: string[],
): void {
  for (const edge of graph.edges) {
    const edgeLabel = `edge '${edge.source} -> ${edge.target}' (${edge.relation})`;
    if (!nodeById.has(edge.source)) {
      errors.push(`${edgeLabel} references missing source node '${edge.source}'`);
    }
    if (!nodeById.has(edge.target)) {
      errors.push(`${edgeLabel} references missing target node '${edge.target}'`);
    }
    if (!FROZEN_EDGE_RELATIONS.includes(edge.relation)) {
      errors.push(
        `${edgeLabel} has relation '${edge.relation}' outside the frozen set ${renderSet(FROZEN_EDGE_RELATIONS)}`,
      );
    }
  }
}

/**
 * Module spine invariants — validated STRUCTURALLY, with no single-root
 * assumption: multiple depth-1 roots are legal (e.g. `module:src` and
 * `module:app/src` may both carry depth 1 in a multi-root repo).
 *
 * Per module node: id convention (`module:<sourceFile>`) and legal depth.
 * Per `contains` edge (skipping endpoints already reported as dangling):
 * modules only, child directory strictly under the parent directory
 * (roll-up allowed — any depth of nesting under the parent path), and
 * child depth exactly parent depth + 1.
 */
function validateModuleSpine(
  graph: BlueprintGraph,
  nodeById: Map<string, BlueprintNode>,
  errors: string[],
): void {
  for (const node of graph.nodes) {
    if (node.kind !== 'module') {
      continue;
    }
    const expectedId = `${MODULE_ID_PREFIX}${node.sourceFile}`;
    if (node.id !== expectedId) {
      errors.push(`module node '${node.id}' violates the id convention — expected '${expectedId}'`);
    }
    if (!hasValidDepth(node)) {
      errors.push(
        `module node '${node.id}' has invalid meta.depth ${JSON.stringify(node.meta?.depth)} — expected an integer in ${MODULE_DEPTH_MIN}..${MODULE_DEPTH_MAX}`,
      );
    }
  }

  for (const edge of graph.edges) {
    if (edge.relation !== 'contains') {
      continue;
    }
    const parent = nodeById.get(edge.source);
    const child = nodeById.get(edge.target);
    if (parent === undefined || child === undefined) {
      continue; // Dangling endpoint — already reported by validateEdges
    }
    const edgeLabel = `contains edge '${edge.source} -> ${edge.target}'`;
    if (parent.kind !== 'module' || child.kind !== 'module') {
      errors.push(`${edgeLabel} connects non-module node(s) — contains is module-to-module only`);
      continue;
    }
    if (!child.sourceFile.startsWith(`${parent.sourceFile}/`)) {
      errors.push(
        `${edgeLabel} child directory '${child.sourceFile}' is not under parent directory '${parent.sourceFile}'`,
      );
    }
    if (hasValidDepth(parent) && hasValidDepth(child)) {
      const parentDepth = parent.meta?.depth as number;
      const childDepth = child.meta?.depth as number;
      if (childDepth !== parentDepth + 1) {
        errors.push(
          `${edgeLabel} child depth ${childDepth} is not parent depth ${parentDepth} + 1`,
        );
      }
    }
  }
}

/**
 * Acyclicity of the `contains` spine, via Kahn's algorithm: peel indegree-0
 * modules repeatedly; every module left over sits on (or downstream inside)
 * a cycle. Reporting per stuck NODE (sorted), not per traversal path, keeps
 * the error set deterministic regardless of iteration order.
 */
function validateContainsAcyclic(
  graph: BlueprintGraph,
  nodeById: Map<string, BlueprintNode>,
  errors: string[],
): void {
  const adjacency = new Map<string, string[]>();
  const indegree = new Map<string, number>();

  for (const edge of graph.edges) {
    if (edge.relation !== 'contains') {
      continue;
    }
    const parent = nodeById.get(edge.source);
    const child = nodeById.get(edge.target);
    if (parent?.kind !== 'module' || child?.kind !== 'module') {
      continue; // Dangling/non-module contains — already reported elsewhere
    }
    if (!adjacency.has(edge.source)) {
      adjacency.set(edge.source, []);
    }
    (adjacency.get(edge.source) as string[]).push(edge.target);
    indegree.set(edge.source, indegree.get(edge.source) ?? 0);
    indegree.set(edge.target, (indegree.get(edge.target) ?? 0) + 1);
  }

  const queue = [...indegree.keys()].filter((id) => indegree.get(id) === 0);
  const remaining = new Set(indegree.keys());
  while (queue.length > 0) {
    const id = queue.pop() as string;
    remaining.delete(id);
    for (const childId of adjacency.get(id) ?? []) {
      const nextIndegree = (indegree.get(childId) as number) - 1;
      indegree.set(childId, nextIndegree);
      if (nextIndegree === 0) {
        queue.push(childId);
      }
    }
  }

  for (const id of [...remaining].sort()) {
    errors.push(`contains cycle detected — module '${id}' is on or downstream of a cycle`);
  }
}

/**
 * Validate a derived graph against the frozen canonical contract.
 *
 * Pure and deterministic: no I/O, no mutation, and `errors` is sorted so the
 * same graph always yields byte-identical output. An empty error list means
 * the graph may be written; ANY error means the derive must hard-fail with
 * nothing written (see `deriveBlueprint`).
 */
export function validateCanonicalGraph(graph: BlueprintGraph): ValidationResult {
  const errors: string[] = [];
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));

  validateCoverage(graph, errors);
  validateNodes(graph, errors);
  validateEdges(graph, nodeById, errors);
  validateModuleSpine(graph, nodeById, errors);
  validateContainsAcyclic(graph, nodeById, errors);

  errors.sort();
  return { ok: errors.length === 0, errors };
}
