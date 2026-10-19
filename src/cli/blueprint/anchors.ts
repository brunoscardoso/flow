/**
 * Anchor construction and resolution against the blueprint graph.
 *
 * Anchors attach plan-flow annotations (decisions/rules/claims/pins) to
 * symbol-level points in the derived system map. Resolution is a pure
 * structural check — an anchor resolves when the fresh graph still contains
 * a node it refers to. Anchors that no longer resolve are stale-flagged by
 * the relink pass (`relink.ts`) — never fuzzy re-matched or deleted.
 *
 * Pure functions, no I/O.
 */

import type { EffectiveProposal } from './proposal-store.js';
import type { Anchor, BlueprintGraph, BlueprintNode } from './types.js';

/** Create a symbol-level anchor (optionally scoped to a source file). */
export function anchorFromSymbol(ref: string, file?: string): Anchor {
  return file === undefined ? { kind: 'symbol', ref } : { kind: 'symbol', ref, file };
}

/** Create a file-level anchor from a repo-relative path. */
export function anchorFromFile(path: string): Anchor {
  return { kind: 'file', ref: path };
}

/** Create a datastore-table anchor from a table name. */
export function anchorFromTable(name: string): Anchor {
  return { kind: 'table', ref: name };
}

/** Create an endpoint anchor from a method+path reference (e.g. `GET /users`). */
export function anchorFromEndpoint(methodPath: string): Anchor {
  return { kind: 'endpoint', ref: methodPath };
}

/**
 * Create a module anchor from a module reference — a path-based module id
 * suffix (`src/cli`), a directory basename (`cli`, legacy), or the module's
 * directory path.
 */
export function anchorFromModule(name: string): Anchor {
  return { kind: 'module', ref: name };
}

/**
 * Whether a repo-relative file path matches a graph node.
 *
 * Containment semantics: a path matches when it equals the node's
 * `sourceFile` exactly, OR the node is a module and the path lives under the
 * module's directory (`path.startsWith(sourceFile + '/')`). Module nodes are
 * directory-granularity (e.g. `sourceFile: 'src/cli'`) while anchors carry
 * file-level paths (e.g. `src/cli/blueprint/store.ts`), so exact equality
 * alone would leave file anchors unresolvable and falsely stale them.
 * Non-module nodes still require exact equality.
 *
 * Mirrored by the app workspace in
 * `app/src/renderer/blueprint/annotation-matching.ts` — the two copies MUST
 * stay in sync.
 */
export function fileMatchesNode(path: string, node: BlueprintNode): boolean {
  if (node.sourceFile === path) {
    return true;
  }
  return node.kind === 'module' && path.startsWith(`${node.sourceFile}/`);
}

/**
 * Read the graphify node ids attached to a node's meta, when present.
 * `graphifyIds` is enrichment-provided and untyped in `BlueprintNodeMeta`,
 * so it is validated structurally at runtime.
 */
function graphifyIdsOf(node: BlueprintNode): string[] {
  const ids = node.meta?.graphifyIds;
  if (!Array.isArray(ids)) {
    return [];
  }
  return ids.filter((id): id is string => typeof id === 'string');
}

/** Whether a symbol anchor resolves to the given node. */
function symbolAnchorMatchesNode(anchor: Anchor, node: BlueprintNode): boolean {
  if (node.symbol === anchor.ref) {
    return true;
  }
  if (graphifyIdsOf(node).includes(anchor.ref)) {
    return true;
  }
  // Fallback: the anchor's file still exists in the graph (exactly or under
  // a module's directory), even if the symbol itself is no longer tracked at
  // symbol granularity.
  return anchor.file !== undefined && fileMatchesNode(anchor.file, node);
}

/**
 * The graph node an anchor resolves to, per the resolution rules below, or
 * `undefined` when none matches. Factored out of `resolveAnchor` so
 * `resolveStoryAnchors` can report WHICH node an anchor landed on (the board
 * needs the id, not just a boolean).
 *
 * Resolution rules per anchor kind:
 * - `symbol` — a node's `symbol` matches `ref`, or a `meta.graphifyIds`
 *   entry matches `ref`, or (fallback) any node matches `anchor.file` per
 *   `fileMatchesNode` containment
 * - `file` — any node matching `ref` per `fileMatchesNode` (exact
 *   `sourceFile`, or contained in a module node's directory)
 * - `table` — any datastore node whose `meta.tables` includes `ref`
 * - `endpoint` — a node with id `endpoint:<ref>` exists
 * - `module` — a module node with id `module:<ref>` exists, OR whose label
 *   (directory basename) equals `ref`, OR whose `sourceFile` (directory path)
 *   equals `ref`. Module ids are path-based (`module:src/cli`); the label
 *   and sourceFile forms are the LEGACY-ID BRIDGE — anchors written against
 *   the old basename ids (`module:cli` → ref `cli`) keep resolving because
 *   the basename is now the node's label
 */
function matchingGraphNode(anchor: Anchor, graph: BlueprintGraph): BlueprintNode | undefined {
  switch (anchor.kind) {
    case 'symbol':
      return graph.nodes.find((node) => symbolAnchorMatchesNode(anchor, node));
    case 'file':
      return graph.nodes.find((node) => fileMatchesNode(anchor.ref, node));
    case 'table':
      return graph.nodes.find(
        (node) => node.kind === 'datastore' && (node.meta?.tables ?? []).includes(anchor.ref),
      );
    case 'endpoint':
      return graph.nodes.find((node) => node.id === `endpoint:${anchor.ref}`);
    case 'module':
      return graph.nodes.find(
        (node) =>
          node.kind === 'module' &&
          (node.id === `module:${anchor.ref}` ||
            node.label === anchor.ref ||
            node.sourceFile === anchor.ref),
      );
    default:
      // Unknown kind (forward-compat data) — cannot be resolved structurally
      return undefined;
  }
}

/**
 * Proposal ("ghost") lifecycle states an anchor may resolve against.
 * `proposed` and `accepted` are live predictions the board still renders as
 * ghosts. `rejected`/`stale`/`cleared` are dead. `confirmed` means a real
 * graph node now exists for the predicted id — `matchingGraphNode` already
 * covers that case, so confirmed proposals are deliberately excluded here to
 * avoid double-counting.
 */
const RESOLVABLE_PROPOSAL_STATES: ReadonlySet<EffectiveProposal['state']> = new Set([
  'proposed',
  'accepted',
]);

/**
 * Whether an anchor matches an effective proposal's `predictedNodeId`.
 * Mirrors the graph-side id conventions symmetrically: `endpoint` anchors
 * match a predicted id of `endpoint:<ref>`, `module` anchors match
 * `module:<ref>`. `table` and `symbol` anchors never match — ghosts carry no
 * table or symbol data. `file` anchors never match — proposals are not
 * files.
 */
function proposalMatchesAnchor(anchor: Anchor, proposal: EffectiveProposal): boolean {
  if (!RESOLVABLE_PROPOSAL_STATES.has(proposal.state)) {
    return false;
  }
  switch (anchor.kind) {
    case 'endpoint':
      return proposal.predictedNodeId === `endpoint:${anchor.ref}`;
    case 'module':
      return proposal.predictedNodeId === `module:${anchor.ref}`;
    default:
      return false;
  }
}

/**
 * Resolve an anchor against a fresh blueprint graph and, optionally, a set of
 * effective proposals ("ghosts"). Graph resolution is checked first (see
 * `matchingGraphNode` for the per-kind rules); when it fails, a `proposed` or
 * `accepted` proposal whose `predictedNodeId` matches the anchor also counts
 * as resolved. `proposals` defaults to empty — every existing call site
 * (two-argument, graph-only) keeps its exact prior behavior unchanged.
 */
export function resolveAnchor(
  anchor: Anchor,
  graph: BlueprintGraph,
  proposals: EffectiveProposal[] = [],
): boolean {
  if (matchingGraphNode(anchor, graph) !== undefined) {
    return true;
  }
  return proposals.some((proposal) => proposalMatchesAnchor(anchor, proposal));
}

/** Where a story anchor resolved: a confirmed graph node, or a ghost proposal. */
export type StoryAnchorTarget = 'node' | 'ghost' | null;

/** Per-anchor resolution result returned by `resolveStoryAnchors`. */
export interface StoryAnchorResolution {
  anchor: Anchor;
  resolved: boolean;
  target: StoryAnchorTarget;
  targetId: string | null;
}

/**
 * Resolve a set of story anchors (for the upcoming `blueprint narrate` verb
 * and the board) against the graph first, then ghost proposals. The 'node'
 * vs 'ghost' distinction matters to callers — the board styles ghost
 * highlights differently from confirmed-node highlights. A `null` graph (no
 * derive has run yet) skips graph resolution entirely; only ghost
 * resolution applies. Deterministic: iterates `anchors` in order, and
 * `graph.nodes` / `proposals` in their given order.
 */
export function resolveStoryAnchors(
  anchors: Anchor[],
  graph: BlueprintGraph | null,
  proposals: EffectiveProposal[],
): StoryAnchorResolution[] {
  return anchors.map((anchor) => {
    const node = graph === null ? undefined : matchingGraphNode(anchor, graph);
    if (node !== undefined) {
      return { anchor, resolved: true, target: 'node' as const, targetId: node.id };
    }
    const proposal = proposals.find((candidate) => proposalMatchesAnchor(anchor, candidate));
    if (proposal !== undefined) {
      return {
        anchor,
        resolved: true,
        target: 'ghost' as const,
        targetId: proposal.predictedNodeId,
      };
    }
    return { anchor, resolved: false, target: null, targetId: null };
  });
}
