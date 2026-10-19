// Pure usage-neighborhood computation (blueprint-connections). DOM-free so it's
// testable under the node-env jest that can't import the board view.
//
// The board's core value is answering "where is this module used?" — click a
// node and its usage neighborhood lights up. This computes that neighborhood
// from the graph's adjacency, at DISPLAY granularity: every raw edge endpoint
// is rolled up to its displayed card via the passed resolver (the same
// buildDisplayResolver the decoration path uses), so the result lines up with
// the cards actually on the board.

/** A directed usage edge: `source` uses/imports/exposes `target`. */
export interface UsageEdge {
  source: string
  target: string
  relation: string
}

/** A node's display-level usage neighborhood. */
export interface UsageNeighborhood {
  /** The clicked (focus) display id. */
  focus: string
  /** Display ids that USE the focus (an edge points AT it) — "used by". */
  dependents: string[]
  /** Display ids the focus USES (an edge points AWAY from it) — "uses". */
  dependencies: string[]
  /** Edge multiplicity per dependent display id — how many underlying edges
   *  rolled up into that connection (a usage-strength signal). */
  dependentCounts: Record<string, number>
  /** Edge multiplicity per dependency display id. */
  dependencyCounts: Record<string, number>
  /** Distinct relations behind each dependent connection (provenance signal:
   *  native `imports`/`uses`/`exposes` = fact, graphify `calls` = enrichment). */
  dependentRelations: Record<string, string[]>
  /** Distinct relations behind each dependency connection. */
  dependencyRelations: Record<string, string[]>
}

/**
 * Compute the display-level usage neighborhood of `clickedId` from raw edges.
 *
 * - `dependents`  = sources of edges whose target rolls up to the focus
 *   (who-uses-me — emphasized in the UI).
 * - `dependencies` = targets of edges whose source rolls up to the focus
 *   (what-I-use).
 *
 * `contains` (the folder spine) is layout-only and excluded. Endpoints that
 * roll up to the focus itself (intra-card edges) are dropped. Both lists are
 * de-duplicated and sorted for determinism. A node can appear in BOTH lists
 * when the usage is mutual — the caller emphasizes `dependents`.
 *
 * `resolve` maps a raw node id to its displayed card id (or null when it rolls
 * up to nothing on the board). `clickedId` is already a display id and is
 * compared directly — it is never passed through `resolve`.
 */
export function usageNeighborhood(
  edges: readonly UsageEdge[],
  clickedId: string,
  resolve: (nodeId: string) => string | null,
): UsageNeighborhood {
  const dependents = new Map<string, number>()
  const dependencies = new Map<string, number>()
  const dependentRelations = new Map<string, Set<string>>()
  const dependencyRelations = new Map<string, Set<string>>()

  const addRelation = (map: Map<string, Set<string>>, id: string, relation: string): void => {
    const set = map.get(id) ?? new Set<string>()
    set.add(relation)
    map.set(id, set)
  }

  for (const edge of edges) {
    if (edge.relation === 'contains') continue
    const source = resolve(edge.source)
    const target = resolve(edge.target)
    if (target === clickedId && source !== null && source !== clickedId) {
      dependents.set(source, (dependents.get(source) ?? 0) + 1)
      addRelation(dependentRelations, source, edge.relation)
    }
    if (source === clickedId && target !== null && target !== clickedId) {
      dependencies.set(target, (dependencies.get(target) ?? 0) + 1)
      addRelation(dependencyRelations, target, edge.relation)
    }
  }

  const relationsObject = (map: Map<string, Set<string>>): Record<string, string[]> =>
    Object.fromEntries([...map].map(([id, set]) => [id, [...set].sort()]))

  return {
    focus: clickedId,
    dependents: [...dependents.keys()].sort(),
    dependencies: [...dependencies.keys()].sort(),
    dependentCounts: Object.fromEntries(dependents),
    dependencyCounts: Object.fromEntries(dependencies),
    dependentRelations: relationsObject(dependentRelations),
    dependencyRelations: relationsObject(dependencyRelations),
  }
}
