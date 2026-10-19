// Focus containment for the shared `.fl-settings-overlay` modal chrome (#1006).
//
// The overlays were modal for the MOUSE (the backdrop intercepts pointer
// events) but nothing trapped the KEYBOARD: three Tab presses walked focus out
// of the first-run wizard into the shell behind the backdrop, Enter activated
// invisible controls (the sidebar rail swapped panels silently), and at ~Tab 19
// keystrokes reached the live terminal's xterm textarea — whose stopPropagation
// also swallowed the wizard's document-level Escape (the #683/#525 dead-end,
// reached with no shortcut at all).
//
// One DOCUMENT-level trap here, installed once, so EVERY overlay consumer
// (Settings, Flow settings, Integrations, command palette, onboarding wizard)
// inherits it — the invariant lives in one code path, not per-consumer
// convention. Two layers:
//   1. keydown (capture): Tab/Shift+Tab cycle only through the topmost open
//      overlay's own focusable controls, wrapping at the ends.
//   2. focusin (capture): a defensive backstop — programmatic focus (e.g. the
//      terminal auto-start) or click-through paths that land focus OUTSIDE the
//      topmost overlay get pulled back to its panel, so Escape can never be
//      swallowed by xterm while a modal is open.

import { nextFocusIndex } from './overlay-focus-model'
import { topmostModalOverlay } from '../modal-overlay'

export { nextFocusIndex }

const PANEL_SELECTOR = '.fl-settings-panel'
const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(', ')

/**
 * Pure wrap rule for a Tab press inside a trap of `count` focusable controls.
 * `currentIndex` is -1 when focus is not on any of them (e.g. on the panel
 * itself, or escaped outside): forward enters at the first control, backward at
 * the last. Returns -1 only for an empty trap.
 */

/** The overlay's tabbable controls, in document order, excluding hidden ones. */
function focusablesIn(overlay: HTMLElement): HTMLElement[] {
  return [...overlay.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)].filter(
    (el) => el.getClientRects().length > 0,
  )
}

/** The control the user was last on INSIDE an open overlay, so a focus steal can
 *  be undone without moving them (#1032: a toast/prompt appearing mid-typing
 *  pulled focus out; re-anchoring to the PANEL then dropped every following
 *  keystroke and the half-typed field cleared itself on the next patch). */
let lastFocusedInOverlay: HTMLElement | null = null

/** Re-anchor focus inside the overlay: the control the user was actually on when
 *  focus was stolen, else its panel (tabIndex -1) when it has one (settings-style
 *  chrome), else its first control (the command palette's input — no panel). */
function refocusOverlay(overlay: HTMLElement): void {
  const previous = lastFocusedInOverlay
  if (previous !== null && overlay.contains(previous) && previous.isConnected) {
    previous.focus()
    return
  }
  const panel = overlay.querySelector<HTMLElement>(PANEL_SELECTOR)
  if (panel) {
    panel.focus()
    return
  }
  focusablesIn(overlay)[0]?.focus()
}

let installed = false

/** Install the document-level focus trap. Idempotent; called once at boot. */
export function installOverlayFocusTrap(): void {
  if (installed) return
  installed = true

  document.addEventListener(
    'keydown',
    (event) => {
      if (event.key !== 'Tab') return
      const overlay = topmostModalOverlay()
      if (!overlay) return
      // The overlay owns Tab entirely: handled here so focus can never step
      // outside, matching the backdrop already blocking the mouse.
      event.preventDefault()
      const items = focusablesIn(overlay)
      if (items.length === 0) {
        refocusOverlay(overlay)
        return
      }
      const active = document.activeElement
      const current = active instanceof HTMLElement ? items.indexOf(active) : -1
      items[nextFocusIndex(current, items.length, event.shiftKey)]?.focus()
    },
    true,
  )

  document.addEventListener(
    'focusin',
    (event) => {
      const overlay = topmostModalOverlay()
      if (!overlay) return
      if (event.target instanceof Node && overlay.contains(event.target)) {
        // Remember where the user is, so an external steal can be undone
        // exactly — not approximated by jumping to the panel.
        if (event.target instanceof HTMLElement) lastFocusedInOverlay = event.target
        return
      }
      refocusOverlay(overlay)
    },
    true,
  )
}
