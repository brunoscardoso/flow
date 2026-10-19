// Pure decision for what to do with the selected thread when the active project
// changes (#405). ADR-002 re-selects the new project's last-active thread; a
// project with NO active thread must CLEAR the selection (not leave it armed
// with the previous project's thread) — otherwise decoupled surfaces like the
// review reject guard (#397) fire against a stale, wrong-project thread and
// silently destroy uncommitted work. DOM-free → unit-testable.

export type ThreadSelectionAction = 'select' | 'clear' | 'none'

/**
 * Decide the selection action on an active-project change.
 * - `select` — the new project has a thread that isn't already selected → load it.
 * - `clear`  — the new project has NO thread but one is still selected → clear it
 *              (and broadcast the null active-thread signal).
 * - `none`   — nothing to do (same thread, or already cleared).
 */
export function resolveThreadSelection(
  targetThread: string | null,
  selectedThreadId: string | null,
): ThreadSelectionAction {
  if (targetThread) {
    return targetThread === selectedThreadId ? 'none' : 'select'
  }
  return selectedThreadId === null ? 'none' : 'clear'
}
