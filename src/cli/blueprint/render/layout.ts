/**
 * Title-sheet layout — pure, deterministic selection of what one screen shows.
 *
 * Splits graph nodes into three columns (integrations | modules |
 * datastores + endpoints summary), caps each column, and reduces edges to the
 * visible node set. The module column shows only DEPTH-1 folder nodes
 * (`meta.depth === 1`, absent depth treated as 1 for pre-hierarchy graphs);
 * endpoint count chips roll up from deeper folder nodes to their depth-1
 * ancestor. Every cap is explicit: overflow surfaces as a
 * `moreCount` the renderer MUST print as an "…and K more" line — silent
 * truncation is forbidden.
 *
 * Endpoint summarization: HTTP endpoints become a count chip on their owning
 * module (via `exposes` edges) instead of individual cards; CLI endpoints
 * roll into one "CLI surface" pseudo-entry in the data column listing the top
 * commands. No I/O, no randomness, no clock — same graph in, same layout out.
 */

import type { BlueprintEdge, BlueprintGraph, BlueprintNode } from '../types.js';

/** Maximum node entries per title-sheet column. */
export const COLUMN_NODE_CAP = 8;

/** Maximum commands listed on the "CLI surface" pseudo-entry. */
export const CLI_COMMAND_CAP = 8;

/** Prefix of CLI endpoint node ids (`endpoint:cli <command>`). */
const CLI_ENDPOINT_ID_PREFIX = 'endpoint:cli ';

/** Column identifiers, in left-to-right sheet order. */
export type TitleSheetColumnKey = 'integrations' | 'modules' | 'data';

/** One node card in a column. */
export interface TitleSheetNodeEntry {
  type: 'node';
  node: BlueprintNode;
  /** For module entries: count of HTTP endpoints this module exposes. */
  endpointCount?: number;
}

/** The single "CLI surface" pseudo-entry summarizing all CLI endpoints. */
export interface TitleSheetCliSurfaceEntry {
  type: 'cli-surface';
  label: 'CLI surface';
  /** Top commands (capped at `CLI_COMMAND_CAP`). */
  commands: string[];
  /** Commands beyond the cap — renderer prints "…and K more". */
  moreCommandCount: number;
  /** Total CLI commands detected. */
  totalCommandCount: number;
}

export type TitleSheetEntry = TitleSheetNodeEntry | TitleSheetCliSurfaceEntry;

/** One capped column of the title sheet. */
export interface TitleSheetColumn {
  key: TitleSheetColumnKey;
  title: string;
  entries: TitleSheetEntry[];
  /** Nodes beyond the cap — renderer prints "…and K more". */
  moreCount: number;
  /** Total candidate nodes for this column before capping. */
  totalCount: number;
}

/** The full deterministic title-sheet layout. */
export interface TitleSheetLayout {
  columns: TitleSheetColumn[];
  /** Edges whose endpoints are both visible on the sheet. */
  visibleEdges: BlueprintEdge[];
  /** Ids of nodes visible on the sheet (column node entries). */
  visibleNodeIds: string[];
}

/** Codepoint string comparison — locale-independent, deterministic. */
function compareStrings(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/** Numeric degree from a node's meta, treating absent degree as 0. */
function degreeOf(node: BlueprintNode): number {
  const degree = node.meta?.degree;
  return typeof degree === 'number' ? degree : 0;
}

/**
 * Folder-tree depth of a module node. Absent depth means a pre-hierarchy
 * graph where every module was top-level — treated as depth 1 so old graphs
 * render identically.
 */
function depthOf(node: BlueprintNode): number {
  const depth = node.meta?.depth;
  return typeof depth === 'number' ? depth : 1;
}

/**
 * The depth-1 ancestor of a module node among the depth-1 modules, resolved
 * by directory containment on `sourceFile` (longest match wins). A depth-1
 * module is its own ancestor. Null when no depth-1 directory contains it.
 */
function depth1AncestorId(module: BlueprintNode, depth1Modules: BlueprintNode[]): string | null {
  if (depthOf(module) === 1) {
    return module.id;
  }
  let best: BlueprintNode | null = null;
  for (const candidate of depth1Modules) {
    const contained =
      module.sourceFile === candidate.sourceFile ||
      module.sourceFile.startsWith(`${candidate.sourceFile}/`);
    if (contained && (best === null || candidate.sourceFile.length > best.sourceFile.length)) {
      best = candidate;
    }
  }
  return best === null ? null : best.id;
}

/** Selection order: meta.degree descending, then id ascending. */
function byDegreeThenId(a: BlueprintNode, b: BlueprintNode): number {
  const byDegree = degreeOf(b) - degreeOf(a);
  if (byDegree !== 0) {
    return byDegree;
  }
  return compareStrings(a.id, b.id);
}

/** Whether a node is a CLI endpoint (`endpoint:cli <command>`). */
function isCliEndpoint(node: BlueprintNode): boolean {
  return node.kind === 'endpoint' && node.id.startsWith(CLI_ENDPOINT_ID_PREFIX);
}

/** The command name of a CLI endpoint node (from meta.route or its id). */
function cliCommandOf(node: BlueprintNode): string {
  const route = node.meta?.route;
  if (typeof route === 'string' && route.length > 0) {
    return route;
  }
  return node.id.slice(CLI_ENDPOINT_ID_PREFIX.length);
}

/**
 * Count HTTP (non-CLI) endpoints exposed by each DEPTH-1 module. `exposes`
 * edges attach to the deepest containing folder node, so counts roll up to
 * the depth-1 ancestor for the sheet (the module column shows only depth-1
 * folders). CLI endpoints are excluded — they roll into the CLI surface entry.
 */
function httpEndpointCountsByModule(graph: BlueprintGraph): Map<string, number> {
  const endpointById = new Map(
    graph.nodes.filter((node) => node.kind === 'endpoint').map((node) => [node.id, node]),
  );
  const modules = graph.nodes.filter((node) => node.kind === 'module');
  const moduleById = new Map(modules.map((node) => [node.id, node]));
  const depth1Modules = modules.filter((node) => depthOf(node) === 1);

  const counts = new Map<string, number>();
  for (const edge of graph.edges) {
    if (edge.relation !== 'exposes') {
      continue;
    }
    const endpoint = endpointById.get(edge.target);
    if (endpoint === undefined || isCliEndpoint(endpoint)) {
      continue;
    }
    const sourceModule = moduleById.get(edge.source);
    const countedId =
      sourceModule === undefined
        ? edge.source
        : depth1AncestorId(sourceModule, depth1Modules) ?? sourceModule.id;
    counts.set(countedId, (counts.get(countedId) ?? 0) + 1);
  }
  return counts;
}

/** Cap a sorted node list into entries + explicit overflow count. */
function capColumn(
  key: TitleSheetColumnKey,
  title: string,
  candidates: BlueprintNode[],
  decorate: (node: BlueprintNode) => TitleSheetNodeEntry,
): TitleSheetColumn {
  const sorted = [...candidates].sort(byDegreeThenId);
  const visible = sorted.slice(0, COLUMN_NODE_CAP);
  return {
    key,
    title,
    entries: visible.map(decorate),
    moreCount: sorted.length - visible.length,
    totalCount: sorted.length,
  };
}

/** Build the "CLI surface" pseudo-entry, or null when no CLI endpoints exist. */
function buildCliSurface(cliEndpoints: BlueprintNode[]): TitleSheetCliSurfaceEntry | null {
  if (cliEndpoints.length === 0) {
    return null;
  }
  const sorted = [...cliEndpoints].sort(byDegreeThenId);
  const topCommands = sorted.slice(0, CLI_COMMAND_CAP).map(cliCommandOf);
  return {
    type: 'cli-surface',
    label: 'CLI surface',
    commands: topCommands,
    moreCommandCount: sorted.length - topCommands.length,
    totalCommandCount: sorted.length,
  };
}

/**
 * Compute the title-sheet layout for a graph. Pure and deterministic:
 * three capped columns, endpoint summarization, and edges reduced to the
 * visible node set.
 */
export function layoutTitleSheet(graph: BlueprintGraph): TitleSheetLayout {
  const integrations = graph.nodes.filter((node) => node.kind === 'integration');
  // Module column shows only DEPTH-1 folders — the hierarchical folder tree
  // stays in the graph, but the title sheet keeps its top-level altitude
  // (missing depth = pre-hierarchy graph, treated as depth 1)
  const modules = graph.nodes.filter((node) => node.kind === 'module' && depthOf(node) === 1);
  const datastores = graph.nodes.filter((node) => node.kind === 'datastore');
  const cliEndpoints = graph.nodes.filter(isCliEndpoint);

  const endpointCounts = httpEndpointCountsByModule(graph);

  const integrationsColumn = capColumn('integrations', 'Integrations', integrations, (node) => ({
    type: 'node',
    node,
  }));
  const modulesColumn = capColumn('modules', 'Modules', modules, (node) => {
    const endpointCount = endpointCounts.get(node.id) ?? 0;
    return endpointCount > 0 ? { type: 'node', node, endpointCount } : { type: 'node', node };
  });

  // Data column: datastores (capped) + the CLI surface pseudo-entry.
  // The pseudo-entry summarizes (never hides) endpoints, so it sits outside
  // the node cap — its own command cap has an explicit more-count.
  const dataColumn = capColumn('data', 'Data & Surfaces', datastores, (node) => ({
    type: 'node',
    node,
  }));
  const cliSurface = buildCliSurface(cliEndpoints);
  if (cliSurface !== null) {
    dataColumn.entries.push(cliSurface);
  }

  const columns = [integrationsColumn, modulesColumn, dataColumn];

  const visibleNodeIds = columns.flatMap((column) =>
    column.entries
      .filter((entry): entry is TitleSheetNodeEntry => entry.type === 'node')
      .map((entry) => entry.node.id),
  );
  const visibleIdSet = new Set(visibleNodeIds);
  const visibleEdges = graph.edges.filter(
    (edge) => visibleIdSet.has(edge.source) && visibleIdSet.has(edge.target),
  );

  return { columns, visibleEdges, visibleNodeIds };
}
