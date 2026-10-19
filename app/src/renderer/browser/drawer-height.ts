/**
 * How tall the browser debug drawer is.
 *
 * DOM-FREE so it can be tested: the drawer itself builds elements and cannot be
 * imported under this app's node-environment jest, and the arithmetic — what a
 * drag clamps to, what a corrupt stored value falls back to — is the part worth
 * pinning.
 */

/** The bounds, in px. Below the minimum nothing is readable; above the maximum
 *  the drawer is the window. */
export const MIN_DRAWER_HEIGHT = 80
export const MAX_DRAWER_HEIGHT = 900
/** What it opens at when nobody has said otherwise — the old fixed value. */
export const DEFAULT_DRAWER_HEIGHT = 180
/** Where a person's choice is remembered. Per-viewer convenience, so
 *  localStorage is the right home and losing it costs a drag. */
export const HEIGHT_KEY = 'flow.browser.debugDrawerHeight'

/**
 * Inside the bounds, whatever a drag or a stored value says.
 *
 * A STORED VALUE IS UNTRUSTED INPUT. It survives upgrades, it can be edited by
 * hand, and `Number(null)` is 0 — a drawer that opens at zero height looks
 * exactly like a drawer that failed to open.
 */
export function clampDrawerHeight(px: number): number {
  if (!Number.isFinite(px)) return DEFAULT_DRAWER_HEIGHT
  return Math.min(MAX_DRAWER_HEIGHT, Math.max(MIN_DRAWER_HEIGHT, Math.round(px)))
}
