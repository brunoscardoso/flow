/**
 * Manual node arrangement for the blueprint stage (#1304) — "maybe we can just
 * add some features to drag and drop the [nodes] so the user can just organize
 * the [nodes] on the UI and see that pattern manually".
 *
 * `layoutStage` is deterministic and knows nothing about intent: it ranks by
 * degree and fills bands. That is the right default and a poor final answer for
 * a reader who has a mental picture of their own system. This layer records the
 * positions a user drags nodes to and applies them OVER the computed layout, so
 * the automatic result stays the starting point rather than the only one.
 *
 * Pure and DOM-free (the repo's model-module convention) so the merge rules —
 * what survives a re-layout, what a stale override does — are unit-tested
 * rather than inferred from the board.
 */
import type { FlowPosition } from './flow-model'

/** A user-placed node position, in layout space. */
export interface NodeOverride {
  x: number
  y: number
}

/** Overrides for one root, keyed by node id. */
export type NodeArrangement = Record<string, NodeOverride>

/** localStorage key prefix; one entry per project root. */
export const ARRANGEMENT_KEY_PREFIX = 'flow.blueprint.arrangement:'

export function arrangementKey(rootId: string): string {
  return `${ARRANGEMENT_KEY_PREFIX}${rootId}`
}

/** A coordinate we are willing to place a card at. */
function isFinitePoint(value: unknown): value is NodeOverride {
  if (value === null || typeof value !== 'object') return false
  const point = value as { x?: unknown; y?: unknown }
  return (
    typeof point.x === 'number' &&
    typeof point.y === 'number' &&
    Number.isFinite(point.x) &&
    Number.isFinite(point.y)
  )
}

/**
 * Parse a persisted arrangement, dropping anything malformed. Never throws — a
 * corrupt entry costs the user their arrangement, never the board.
 */
export function parseArrangement(raw: string | null): NodeArrangement {
  if (raw === null) return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out: NodeArrangement = {}
    for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (isFinitePoint(value)) out[id] = { x: value.x, y: value.y }
    }
    return out
  } catch {
    return {}
  }
}

/**
 * Apply an arrangement over a computed layout. Only nodes the layout ACTUALLY
 * placed can be overridden — an override for a node that has since disappeared
 * (a module that was deleted, a ghost that resolved) is ignored rather than
 * conjuring a card, and sizes always come from the layout, never the store.
 */
export function applyArrangement(
  positions: readonly FlowPosition[],
  arrangement: NodeArrangement,
): FlowPosition[] {
  return positions.map((position) => {
    const override = arrangement[position.id]
    if (override === undefined) return position
    return { ...position, x: override.x, y: override.y }
  })
}

/** Record where a node was dropped. Returns a new object — never mutates. */
export function withOverride(
  arrangement: NodeArrangement,
  id: string,
  point: NodeOverride,
): NodeArrangement {
  return { ...arrangement, [id]: { x: point.x, y: point.y } }
}

/**
 * Drop overrides for nodes the graph no longer has. Kept explicit (called on
 * load) rather than done during apply, so a node that vanishes for one derive
 * and returns — a flapping extractor — doesn't silently lose its place.
 */
export function pruneArrangement(
  arrangement: NodeArrangement,
  knownIds: ReadonlySet<string>,
): NodeArrangement {
  const out: NodeArrangement = {}
  for (const [id, point] of Object.entries(arrangement)) {
    if (knownIds.has(id)) out[id] = point
  }
  return out
}

/** Whether anything is arranged — drives the "Reset arrangement" affordance,
 *  which must exist: a manual layout with no way back is a trap. */
export function hasArrangement(arrangement: NodeArrangement): boolean {
  return Object.keys(arrangement).length > 0
}

/**
 * Wire endpoints recomputed from (possibly overridden) positions — a dragged
 * node whose edges stayed behind would be worse than not dragging at all.
 */
export function recomputeWireEndpoints(
  wires: ReadonlyArray<{ from: string; to: string }>,
  positions: readonly FlowPosition[],
): Array<{ from: string; to: string; x1: number; y1: number; x2: number; y2: number }> {
  const byId = new Map(positions.map((position) => [position.id, position]))
  const endpoints: Array<{ from: string; to: string; x1: number; y1: number; x2: number; y2: number }> = []
  for (const wire of wires) {
    const a = byId.get(wire.from)
    const b = byId.get(wire.to)
    if (a === undefined || b === undefined) continue
    endpoints.push({
      from: wire.from,
      to: wire.to,
      x1: a.x + a.w / 2,
      y1: a.y + a.h / 2,
      x2: b.x + b.w / 2,
      y2: b.y + b.h / 2,
    })
  }
  return endpoints
}
