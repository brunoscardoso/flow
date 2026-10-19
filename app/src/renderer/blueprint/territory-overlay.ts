/**
 * WHAT AN OVERLAY LANDS ON — the join between the board's decoration state and
 * the territory sheet. PURE, no DOM.
 *
 * The board already has ONE decoration state (`#decoration`: anchors, an
 * optional flow, an optional emphasis subset) and the owners that write it —
 * a click-neighbourhood, changeset mode, a brain answer, the Learning lens. On the code map each of those resolves an anchor to a CARD
 * through the display resolver. On the territory sheet there is no resolver to
 * consult: a cell IS the node, and the only question left is which of the ids
 * an overlay named are drawn at this depth.
 *
 * That question is small, and it is the whole reason this module exists rather
 * than four `for` loops inside `blueprint-board.ts` — the file has no automated
 * DOM coverage, and the two rules below are exactly the kind that go quietly
 * wrong.
 *
 * RULE 1: AN OVERLAY THAT NAMED NOTHING HERE DECORATES NOTHING.
 * ============================================================
 * `null`, not `{ lit: [], dimOthers: true }`. A sheet where every cell is dim
 * and none is lit reads as "the answer is nowhere on this map" — a claim the
 * overlay never made. Most of the time the truth is duller: a story anchored to
 * a file path, or a changeset of module ids, simply has nothing to say about a
 * sheet of FEATURES. Dimming the whole picture to announce that is the board
 * shouting about its own plumbing.
 *
 * This is also why nothing here invents a path from a file to a feature. The
 * feature graph carries an anchor COUNT, not the anchors (the IPC contract is
 * frozen for this work), so a file→feature answer would have to be guessed.
 * A cell lights when the overlay names it and not otherwise; when the code map
 * becomes a territory, its module ids ARE cell ids and the same code lights
 * them with no new rule.
 *
 * RULE 2: A FLOW PATH DRAWS ONLY WHEN EVERY HOP IS ON SCREEN.
 * ==========================================================
 * Inherited verbatim from `#drawFlowOverlay`: a numbered path that silently
 * skips hop 3 tells the reader the flow goes 1 → 2 → 4, which is a different
 * story from the one that was narrated. One hop missing degrades the whole
 * path to lit-only, exactly as it does on the code map.
 */

import type { TerritoryView } from './territory-view'
import type { DecorateOptions } from './territory-view'

/** A point in sheet coordinates — which are stage coordinates (the sheet fills
 *  the stage and no transform stands between the two). */
export interface OverlayPoint {
  x: number
  y: number
}

/** The parts of a view an overlay reads. Narrowed so a test can hand this a
 *  literal instead of building a whole render plan. */
export type OverlaySheet = Pick<TerritoryView, 'cells' | 'groups'>

/**
 * Which of `ids` this sheet draws, as the one lit/dim vocabulary — or `null`
 * when it draws none of them (rule 1).
 *
 * Groups count: a country named by an overlay is part of the answer, and
 * `decorate` already knows a group lights when anything inside it does.
 * Deterministic order (cells in drawn order, then groups) so the same overlay
 * decorates the same sheet the same way every render.
 */
export function territoryOverlayFor(
  view: OverlaySheet,
  ids: Iterable<string>,
): DecorateOptions | null {
  const named = new Set(ids)
  if (named.size === 0) return null
  const lit: string[] = []
  for (const cell of view.cells) {
    if (named.has(cell.id)) lit.push(cell.id)
  }
  for (const group of view.groups) {
    if (named.has(group.id) && !lit.includes(group.id)) lit.push(group.id)
  }
  if (lit.length === 0) return null
  return { lit, dimOthers: true }
}

/**
 * The centres a numbered flow path joins, in order — or `null` when the path
 * must not be drawn (rule 2).
 *
 * Consecutive duplicates collapse, exactly as the card path collapses two hops
 * that roll up to one card: two numbered discs on top of each other is a
 * drawing bug, not a step. A path of fewer than two distinct hops is not a
 * path.
 */
export function territoryFlowHops(
  view: OverlaySheet,
  flow: readonly string[] | null,
): OverlayPoint[] | null {
  if (flow === null || flow.length < 2) return null
  const byId = new Map(view.cells.map((cell) => [cell.id, cell]))
  const hops: OverlayPoint[] = []
  let lastId: string | null = null
  for (const id of flow) {
    const cell = byId.get(id)
    if (cell === undefined) return null // a hop is off this sheet — lit only
    if (id === lastId) continue
    lastId = id
    hops.push({ x: cell.rect.x + cell.rect.w / 2, y: cell.rect.y + cell.rect.h / 2 })
  }
  return hops.length < 2 ? null : hops
}
