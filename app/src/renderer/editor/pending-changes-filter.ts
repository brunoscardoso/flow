// Scope the pending-changes review to the ACTIVE thread. The main-side tracker
// reports every thread's unreviewed edits for a project root (keyed by
// thread + file), but the review surface must show only the thread the user is
// looking at — otherwise it lists files from other threads (#42) and doesn't
// change when you switch threads (#38). DOM-free so it unit-tests directly.

import type { PendingFileChange } from '../../shared/ipc-contract'

/**
 * Keep only the changes belonging to `activeThreadId`. With no active thread
 * (nothing selected), the review is empty — a pending change always belongs to
 * a thread, so there's nothing to review out of thread context.
 */
export function filterByActiveThread(
  changes: PendingFileChange[],
  activeThreadId: string | null,
): PendingFileChange[] {
  if (!activeThreadId) return []
  return changes.filter((change) => change.threadId === activeThreadId)
}
