// Guard for the Review "reject → revert + ask the agent to redo" action (#397).
// Rejecting reverts the file to HEAD (destroying the uncommitted edit) AND asks
// the active thread's agent to redo it. With NO active thread the redo is
// undeliverable, so the revert must NOT happen — otherwise the user silently
// loses uncommitted work while believing a redo was queued. Pure so it's
// unit-testable under node-env jest.

export interface RejectGuard {
  /** Whether the reject (revert + redo) may proceed. */
  allowed: boolean
  /** User-facing reason when blocked (null when allowed). */
  blockedReason: string | null
}

/**
 * Decide whether a reject may proceed given whether a thread is active. The
 * redo needs a thread to receive it, so with none we refuse BEFORE reverting —
 * nothing is destroyed and the user is told why.
 */
export function rejectGuard(hasActiveThread: boolean): RejectGuard {
  if (hasActiveThread) {
    return { allowed: true, blockedReason: null }
  }
  return {
    allowed: false,
    blockedReason: 'Open or select a thread to request a redo — nothing was reverted.',
  }
}
