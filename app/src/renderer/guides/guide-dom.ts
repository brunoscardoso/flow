/**
 * The two DOM questions the feature guide asks, in one place.
 *
 * "ON SCREEN", NOT "IN THE DOM". Flow keeps closed editor tabs and hidden
 * panes mounted, so an element that exists is no evidence anybody can see it
 * (memory: visible is not on screen). An anchor counts only when the browser
 * would paint it, it has a size, and some of it is inside the window.
 */
import type { Rect } from '../../shared/guides'

export function isOnScreen(el: Element): boolean {
  const check = (el as Element & { checkVisibility?: (o: object) => boolean }).checkVisibility
  if (typeof check === 'function' && !check.call(el, { checkOpacity: true, checkVisibilityCSS: true })) return false
  const r = el.getBoundingClientRect()
  if (r.width < 4 || r.height < 4) return false
  return r.right > 0 && r.bottom > 0 && r.left < window.innerWidth && r.top < window.innerHeight
}

/** The first element on screen for any selector in the list, in list order. */
export function firstOnScreen(selectors: readonly string[]): HTMLElement | null {
  for (const selector of selectors) {
    for (const el of document.querySelectorAll<HTMLElement>(selector)) {
      if (isOnScreen(el)) return el
    }
  }
  return null
}

/** The part of `el` inside the window, grown by `pad` and clipped to the window. */
export function visibleRect(el: Element, pad = 4): Rect {
  const r = el.getBoundingClientRect()
  const left = Math.max(0, r.left - pad)
  const top = Math.max(0, r.top - pad)
  const right = Math.min(window.innerWidth, r.right + pad)
  const bottom = Math.min(window.innerHeight, r.bottom + pad)
  return { left, top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) }
}
