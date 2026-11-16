// BLOCKS · DIAGRAM — one feature, two views, one switch (user, 2026-11-15:
// "the experience should be just one — if the user is seeing the blocks, keep
// on the blocks; if it's seeing the diagram keep using that").
//
// A feature can be read as BLOCKS (the territory one level in: its parts as
// provinces) or as its DIAGRAM (its curated level, full size). The board used
// to have a one-way glyph from blocks to diagram and nothing back. Now a
// two-state switch shows on both views of the same feature; the current view
// is pressed, and pressing the other swaps it for the same focus.
//
// SAME PLACE, DIFFERENT VIEW. A swap is not a step: Back from either view
// leaves the feature for where the reader came from, never toggles between its
// two views. The swap does that by handing the diagram the PARENT as its
// return point (and the blocks get the parent below them on the stack), so the
// history entry the brief pushes leads out of the feature, not sideways.
//
// The last chosen view is remembered per viewer: a cell press opens a feature
// in it. The pinned card's Open always opens the diagram — that is what the
// card shows.
//
// DOM-free so it runs under the CJS node jest.

export type FeatureView = 'blocks' | 'diagram'

/** Where the last chosen view is remembered — this viewer's own preference. */
export const FEATURE_VIEW_PREF = 'flow.blueprint.featureView'

export function readFeatureViewPref(stored: string | null): FeatureView {
  return stored === 'diagram' ? 'diagram' : 'blocks'
}

/**
 * Whether the switch is offered for this focus. Only a FEATURE has both views:
 * a domain has no diagram of its own, and a part reads as its code story. The
 * same rule as the old control's `hasControlFor`, minus the part (whose level
 * is its story, not a diagram) — so the switch never offers a dead view.
 */
export function viewSwitchOffered(focus: { kind: string } | null | undefined): boolean {
  return focus !== null && focus !== undefined && focus.kind === 'feature'
}

/** What a plain press on a cell opens: the remembered view for a feature, else the cell's own press. */
export function cellPressOpens(input: { pref: FeatureView; cellKind: string; hasNode: boolean }): 'diagram' | 'press' {
  return input.pref === 'diagram' && input.cellKind === 'feature' && input.hasNode ? 'diagram' : 'press'
}

export interface SwapPlan<T> {
  to: FeatureView
  /** The stack the DIAGRAM returns to — the feature's parent, never the feature itself. */
  returnStack: T[]
  /** The stack the BLOCKS stand on — the parent with the feature on top. */
  blocksStack: T[]
  /**
   * The history the swap leaves. 'push' — the diagram records its own entry so
   * Back has somewhere to go — but the entry's way out is the PARENT, so Back
   * leaves the feature instead of stepping to its other view.
   */
  history: 'push'
}

/**
 * Swap the view of `focus`. `stack` is where the reader stands now: on the
 * blocks, the territory stack with the feature on top; on the diagram, the
 * stack it returns to.
 */
export function planSwap<T extends { id: string }>(input: { from: FeatureView; stack: readonly T[]; focus: T }): SwapPlan<T> {
  const top = input.stack.at(-1)
  const parent = top !== undefined && top.id === input.focus.id ? input.stack.slice(0, -1) : [...input.stack]
  return {
    to: input.from === 'blocks' ? 'diagram' : 'blocks',
    returnStack: parent,
    blocksStack: [...parent, input.focus],
    history: 'push',
  }
}
