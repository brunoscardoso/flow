/**
 * The DOM half of the column scroll guard (column-scroll-guard.ts): which
 * boxes around the chat column can be scrolled. Kept apart so the guard's
 * rules test without a DOM.
 */

/** One step up the composed tree: a slot it is assigned to, its parent, or its shadow host. */
function composedParent(el: Element): Element | null {
  const slot = (el as HTMLElement).assignedSlot
  if (slot) return slot
  if (el.parentElement) return el.parentElement
  const root = el.getRootNode()
  return root instanceof ShadowRoot ? root.host : null
}

/**
 * The clipping boxes from `start` (exclusive) up to and including the first
 * one `isLast` accepts. A box with `overflow: visible` cannot be scrolled and
 * is skipped.
 */
export function columnScrollBoxes(
  start: Element,
  isLast: (el: Element) => boolean,
): Array<{ box: HTMLElement; name: string }> {
  const out: Array<{ box: HTMLElement; name: string }> = []
  let el = composedParent(start)
  while (el) {
    const style = getComputedStyle(el)
    if (style.overflowY !== 'visible' || style.overflowX !== 'visible') {
      const cls = typeof el.className === 'string' && el.className ? `.${el.className.split(' ')[0]}` : ''
      out.push({ box: el as HTMLElement, name: `${el.tagName.toLowerCase()}${cls}` })
    }
    if (isLast(el)) break
    el = composedParent(el)
  }
  return out
}
