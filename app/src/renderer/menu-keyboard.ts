/**
 * Keyboard operation for popup menus (#1173, #1300) — ONE code path.
 *
 * #1173 taught the thread-sidebar row menu that a popup must be keyboard-
 * operable: arrows move, Tab is contained inside it rather than walking the
 * controls sitting BEHIND it, and Escape (or acting) returns focus to whatever
 * opened it instead of stranding the user on `<body>`.
 *
 * #1153 then re-implemented popup chrome from scratch for the board's lane
 * menu and inherited none of that — the same menu items, offering the same
 * moves for the same task, were mouse-only again. So the rules live here now
 * (allowed-pattern #14): convention restated per popup drifts, one code path
 * cannot.
 *
 * The navigation math lives in menu-keyboard-model.ts (DOM-free, unit-tested);
 * this file is the wiring, which needs a real DOM.
 */
import { nextMenuIndex } from './menu-keyboard-model'

export interface MenuKeyboardOptions {
  /** Close the menu (the caller owns teardown/removal). */
  close: () => void
  /**
   * Where focus returns on Escape — normally the control the menu was opened
   * from. Skipped when it has left the DOM, so this never focuses a detached
   * node. A surface that re-renders while its menu is open passes a LOOKUP
   * instead: a node held from open time is replaced by the re-render, and
   * Escape then had nothing to focus and dropped the user on `<body>`.
   */
  anchor?: HTMLElement | null | (() => HTMLElement | null)
  /** Stop keydowns escaping to surfaces that also listen for Escape (#1161). */
  stopPropagation?: boolean
}

/** Focusable, actually-visible items of a menu, in DOM order. */
function menuItems(menu: HTMLElement): HTMLElement[] {
  return [...menu.querySelectorAll<HTMLElement>('button:not(:disabled)')].filter(
    (element) => element.offsetParent !== null || element.getClientRects().length > 0,
  )
}

/** Move focus within the menu by one step. Exported for the open-time focus. */
export function focusMenuItem(menu: HTMLElement, delta: 1 | -1, from?: number): void {
  const items = menuItems(menu)
  if (items.length === 0) return
  const current = from ?? items.indexOf(document.activeElement as HTMLElement)
  const next = nextMenuIndex(current, delta, items.length)
  items[next]?.focus()
}

/**
 * Make `menu` keyboard-operable and focus its first item. Returns a teardown
 * the caller must run when the menu closes.
 */
export function attachMenuKeyboard(menu: HTMLElement, options: MenuKeyboardOptions): () => void {
  const onKey = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') {
      if (options.stopPropagation === true) event.stopPropagation()
      options.close()
      // Never strand the keyboard user where the popup used to be.
      const anchor = typeof options.anchor === 'function' ? options.anchor() : options.anchor
      if (anchor && anchor.isConnected) anchor.focus()
      return
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      focusMenuItem(menu, event.key === 'ArrowDown' ? 1 : -1)
      return
    }
    if (event.key === 'Tab') {
      // Contained: Tab must not reach the controls behind the popup while the
      // popup is the thing on screen.
      event.preventDefault()
      focusMenuItem(menu, event.shiftKey ? -1 : 1)
    }
  }
  document.addEventListener('keydown', onKey, true)
  // Start at the first item, so arrows and Enter have somewhere to act from.
  focusMenuItem(menu, 1, -1)
  return () => document.removeEventListener('keydown', onKey, true)
}

/**
 * Return focus after a menu ACTION, not just after Escape. Acting often
 * re-renders the surface and destroys the element the menu was opened from
 * (#1300: choosing a lane re-rendered the board, and focus landed on `<body>`
 * — the keyboard user lost their place entirely, and the next Tab restarted
 * from the top of the document). `find` re-locates the equivalent element
 * after the re-render; `fallback` is used when it is genuinely gone.
 */
export function restoreFocusAfterAction(
  find: () => HTMLElement | null,
  fallback?: HTMLElement | null,
): void {
  // After the re-render, not during it.
  requestAnimationFrame(() => {
    const target = find() ?? (fallback?.isConnected === true ? fallback : null)
    target?.focus()
  })
}
