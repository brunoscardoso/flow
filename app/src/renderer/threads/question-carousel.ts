// Pure carousel/pager state for the AskUserQuestion card (#400). A request with
// multiple questions is shown ONE at a time (like Claude's question carousel)
// with a Back / "i of N" / Next pager, instead of a long stacked list. DOM-free
// so it's unit-testable under the node-env jest that can't import the card.

export interface CarouselView {
  /** True when there is more than one question — the pager is shown only then. */
  isCarousel: boolean
  /** The current index, clamped into [0, total-1] (0 when there are none). */
  index: number
  /** At the first question — Back is disabled. */
  atStart: boolean
  /** At the last question — Next is disabled. */
  atEnd: boolean
  /** Human-readable position, e.g. "2 of 4". */
  position: string
}

/** Clamp an index into the valid range for `total` questions. */
export function clampIndex(index: number, total: number): number {
  if (total <= 0) return 0
  return Math.max(0, Math.min(index, total - 1))
}

/** Derive the pager view for showing question `index` of `total`. */
export function carouselView(index: number, total: number): CarouselView {
  const clamped = clampIndex(index, total)
  return {
    isCarousel: total > 1,
    index: clamped,
    atStart: clamped <= 0,
    atEnd: total <= 0 || clamped >= total - 1,
    position: total > 0 ? `${clamped + 1} of ${total}` : '0 of 0',
  }
}
