/**
 * WHAT A FEATURE TOUCHES — pure, DOM-free.
 *
 * The store records 22 `relates` edges on a real project and the Territory drew
 * none of them: nineteen rectangles, no relationships, on a sheet whose whole
 * claim is to be a map of the system. This is the join that lights them.
 *
 * THE SHAPE ONLY, AND THAT IS DELIBERATE. Each `relates` entry in the markdown
 * also carries a `via` (the symbol that couples the two) and a hand-written
 * `note` saying why — and `feature-graph.ts` keeps both OUT of the graph on
 * purpose: "they are for a reader of the FEATURE, and the graph is a shape."
 * That rule is not worked around here. The sheet lights which features are
 * connected; the prose stays where a reader asks about one feature.
 *
 * UNDIRECTED. The CLI stores one edge per unordered pair (whichever feature's
 * file happened to name the other), so "what does Auth touch" has to look at
 * both ends or half the answers vanish depending on who wrote whom down.
 */

/** An edge exactly as `blueprint features graph` emits it. */
export interface RelationEdge {
  from: string
  to: string
  /** The mechanism moved since the edge was recorded — a claim to verify. */
  stale?: boolean
}

/** One end of a relationship, from the asking feature's point of view. */
export interface Relation {
  /** The feature at the other end. */
  id: string
  /** True when the coupling's mechanism has moved since it was recorded. */
  stale: boolean
}

/**
 * Everything `id` is related to, in id order.
 *
 * A self-edge is dropped rather than reported: a feature relating to itself is
 * a store that needs fixing, not a connection a reader can act on.
 */
export function relationsOf(id: string, edges: readonly RelationEdge[]): Relation[] {
  const out = new Map<string, Relation>()
  for (const edge of edges) {
    const other = edge.from === id ? edge.to : edge.to === id ? edge.from : null
    if (other === null || other === id) continue
    const stale = edge.stale === true
    const seen = out.get(other)
    // A pair recorded twice keeps the WORSE verdict: if either says the
    // mechanism moved, the reader needs to hear that, not the reassuring half.
    if (seen === undefined || (!seen.stale && stale)) out.set(other, { id: other, stale })
  }
  return [...out.values()].sort((a, b) => a.id.localeCompare(b.id))
}

/**
 * How many features each one touches — for the count a cell prints without
 * anyone having to hover it.
 *
 * Counted from the same `relationsOf` join rather than from edge endpoints, so
 * a cell's number and the set its hover lights can never disagree: one is the
 * length of the other.
 */
export function relationCounts(
  ids: readonly string[],
  edges: readonly RelationEdge[],
): Map<string, number> {
  const out = new Map<string, number>()
  for (const id of ids) out.set(id, relationsOf(id, edges).length)
  return out
}

/**
 * What a hover should light: the feature under the pointer AND everything it
 * touches.
 *
 * THE SUBJECT IS IN THE SET. Lighting only the neighbours would dim the cell
 * the reader is pointing at, which reads as "not this one" at the exact moment
 * they are asking about it.
 *
 * An id with no relations lights nothing at all — an empty set, not a set of
 * one. A sheet that dimmed eighteen cells to announce that the nineteenth is
 * unconnected has spent the whole picture on a non-answer.
 */
export function relationHighlight(id: string, edges: readonly RelationEdge[]): string[] {
  const related = relationsOf(id, edges)
  return related.length === 0 ? [] : [id, ...related.map((relation) => relation.id)]
}
