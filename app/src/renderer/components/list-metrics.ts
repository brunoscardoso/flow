/**
 * Row arithmetic for `<fl-list>` — the part that stops assuming every row is
 * the same height.
 *
 * WHY IT MOVED OUT OF THE COMPONENT. `fl-list` cannot be imported under the
 * app's jest env (it touches `customElements` at module load), so every line
 * of its geometry was untested. This is the geometry: prefix sums and two
 * binary searches, pure and DOM-free, so the window it computes can be
 * checked without a browser.
 *
 * THE UNIFORM CASE IS NOT A SPECIAL CASE. With a constant height the prefix
 * sums are `index * rowHeight` and the searches land on the same rows the old
 * `Math.floor(scrollTop / rowHeight)` did — which is what the tests pin, so
 * the surfaces that never ask for variable heights (the file tree, every git
 * panel section) keep the exact window they had.
 */

/**
 * Cumulative row tops: `offsets[i]` is row `i`'s top, `offsets[count]` is the
 * total height. One entry longer than the list on purpose — the extra entry is
 * what makes "the bottom of the last row" a lookup rather than a special case.
 *
 * A height of zero would make two rows share a top and break the searches'
 * ordering assumption, so every row is worth at least one pixel.
 */
export function rowOffsets(count: number, heightAt: (index: number) => number): number[] {
  const offsets: number[] = new Array<number>(Math.max(0, count) + 1)
  offsets[0] = 0
  for (let index = 0; index < count; index += 1) {
    const height = heightAt(index)
    offsets[index + 1] = (offsets[index] ?? 0) + (Number.isFinite(height) ? Math.max(1, height) : 1)
  }
  return offsets
}

/** Total height of every row — `offsets`' last entry, or 0 for an empty list. */
export function totalHeight(offsets: readonly number[]): number {
  return offsets[offsets.length - 1] ?? 0
}

/**
 * The last row whose top is at or above `y` — i.e. the row `y` falls in.
 *
 * Clamps rather than returning -1: a `y` above the first row is in the first
 * row as far as a scroll window is concerned, and a `y` past the end is in the
 * last one.
 */
export function rowAt(offsets: readonly number[], y: number): number {
  const count = offsets.length - 1
  if (count <= 0) return 0
  let low = 0
  let high = count - 1
  while (low < high) {
    const mid = (low + high + 1) >> 1
    if ((offsets[mid] ?? 0) <= y) low = mid
    else high = mid - 1
  }
  return low
}

/** The rows a scroller shows, widened by `overscan` on each side. */
export interface VisibleRange {
  first: number
  /** Inclusive. -1 with an empty list, so `for (i = first; i <= last)` runs zero times. */
  last: number
}

export function visibleRange(
  offsets: readonly number[],
  scrollTop: number,
  viewHeight: number,
  overscan: number,
): VisibleRange {
  const count = offsets.length - 1
  if (count <= 0) return { first: 0, last: -1 }
  const top = Math.max(0, scrollTop)
  const first = Math.max(0, rowAt(offsets, top) - overscan)
  // The last PIXEL the viewport shows, not the first one past it — otherwise a
  // viewport ending exactly on a row boundary mounts a row nobody can see.
  const last = Math.min(count - 1, rowAt(offsets, top + Math.max(0, viewHeight - 1)) + overscan)
  return { first, last }
}

/**
 * Where to scroll so row `index` is fully visible, or null when it already is.
 *
 * The row's own height decides, which is the whole point: a two-line row
 * scrolled to by `bottom - clientHeight` on the ASSUMPTION of a 28px row lands
 * with its second line still under the fold.
 */
export function scrollToReveal(
  offsets: readonly number[],
  index: number,
  scrollTop: number,
  viewHeight: number,
): number | null {
  const count = offsets.length - 1
  if (index < 0 || index >= count) return null
  const top = offsets[index] ?? 0
  const bottom = offsets[index + 1] ?? top
  if (top < scrollTop) return top
  if (bottom > scrollTop + viewHeight) return bottom - viewHeight
  return null
}
