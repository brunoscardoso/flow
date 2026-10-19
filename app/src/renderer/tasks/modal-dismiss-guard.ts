// New-task modal backdrop-dismiss guard (#443). The New-task overlay is
// position:fixed; inset:0 — after the first click opens it, the overlay covers the
// "+ New task" button. On a DOUBLE-click the second mousedown lands on that fresh
// backdrop and its dismiss handler (target === overlay → close) instantly closes the
// modal, so the primary board CTA looks like a dead click. A re-entrancy guard on
// OPEN alone can't fix this — the second click never re-opens the modal, it dismisses
// the one just opened. Instead, ignore a backdrop dismiss that arrives within the
// double-click window of opening. DOM-free → unit-testable.

/**
 * Window (ms) after opening during which a backdrop mousedown is treated as the
 * stray second press of a double-click, not a deliberate dismiss. Covers the OS
 * double-click ceiling (~500ms); a real backdrop dismiss is always slower.
 */
export const MODAL_DISMISS_GUARD_MS = 500

/**
 * Whether a backdrop mousedown at `now` should dismiss a modal opened at `openedAt`.
 * False during the guard window (the double-click follow-through); true afterwards.
 */
export function backdropDismissAllowed(openedAt: number, now: number): boolean {
  return now - openedAt >= MODAL_DISMISS_GUARD_MS
}
