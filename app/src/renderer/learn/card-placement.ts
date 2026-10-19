/**
 * Where the learn ask sits, so it never covers a notification.
 *
 * The ask card and the notification toasts share one fixed corner (bottom
 * right, 32px up), and the card is drawn above them — so while an ask waited,
 * every toast under it was unreachable. Live (Workspaces Phase 11 e2e): a
 * "Workspace sync paused" toast's "Review the changes" sat entirely beneath a
 * "Run a basic discovery?" ask; a click on it landed on the ask.
 *
 * The card now stands on top of the toast stack instead: its bottom edge is
 * the stack's top edge plus the stack's own gap. DOM-free so it is testable.
 */

/** The corner's distance from the window's bottom edge (both surfaces use it). */
export const CORNER_BOTTOM_PX = 32
/** The space between two cards of the stack. */
export const STACK_GAP = 'var(--fl-space-sm)'

/** The card's CSS `bottom` for a toast stack this tall (0 = no toasts showing: the corner itself). */
export function learnCardBottom(toastStackHeight: number): string {
  if (!Number.isFinite(toastStackHeight) || toastStackHeight <= 0) return `${CORNER_BOTTOM_PX}px`
  return `calc(${CORNER_BOTTOM_PX + Math.ceil(toastStackHeight)}px + ${STACK_GAP})`
}
