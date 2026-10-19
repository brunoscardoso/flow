/**
 * Focus ownership across a settings-overlay open/close cycle (#1199).
 *
 * Closing Settings left `document.activeElement` on `<body>`: everything typed
 * next — including Enter — was silently discarded until the user clicked
 * something. The caret is still visibly in the composer, which is what makes it
 * so disorienting.
 *
 * This is exactly #1100, which fixed it for the command palette and left behind
 * the reusable rule (`palette/palette-focus.ts`: capture before, restore after,
 * never onto the overlay itself, never onto a detached node). The settings
 * FAMILY — Settings, Flow settings, Integrations — never joined it. Their own
 * focus trap made it worse: `overlay-focus-trap.ts` pulls focus INTO the
 * overlay while it is open and has no counterpart on close, so it reliably took
 * the keyboard and reliably never gave it back.
 *
 * This is a thin binding of that rule to a plain overlay, so the three views
 * share one implementation rather than three near-copies.
 */
import { focusToCapture, focusToRestore } from '../palette/palette-focus'

export class OverlayFocusReturn {
  #captured: HTMLElement | null = null

  /** Remember where the keyboard was, just before the overlay takes it. */
  capture(overlay: HTMLElement): void {
    const active = document.activeElement
    this.#captured = focusToCapture<HTMLElement>({
      active: active instanceof HTMLElement ? active : null,
      body: document.body,
      // Re-entrant opens must not "restore" onto the overlay's own controls.
      insidePalette: active instanceof Node ? overlay.contains(active) : false,
    })
  }

  /**
   * Hand the keyboard back to whoever had it. Silently does nothing when there
   * was nothing worth restoring to, or when that element has since left the
   * document (a rebuild, a closed tab) — an unfocusable target is not a target.
   */
  restore(relocate?: (lost: HTMLElement) => HTMLElement | null): void {
    const captured = this.#captured
    const target = focusToRestore(captured, 'cancel')
    this.#captured = null
    if (target !== null) {
      target.focus()
      return
    }
    // The element left the document while the overlay was up — a surface that
    // re-renders (a board refreshing its cards) replaces the very node the
    // keyboard was on. The caller may know its successor; without one the
    // keyboard falls to <body> and the next Tab restarts at the top (#1300).
    if (captured !== null && !captured.isConnected && relocate !== undefined) {
      relocate(captured)?.focus()
    }
  }
}
