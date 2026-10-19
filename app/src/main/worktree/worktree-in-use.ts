/**
 * Whether a thread's checkout is IN USE — someone is working in it right now,
 * or is about to be.
 *
 * THE INCIDENT THIS CLOSES. The disk cap protected the one thing it thought
 * could be lost: unlanded commits. "Landed" is a question about history — clean
 * status, nothing ahead of base — and a checkout that was cut four seconds ago
 * answers it perfectly. So the most evictable entry on the list was always the
 * newest one, ranked oldest-first by its BASE commit's date, which for a fresh
 * cut is ancient.
 *
 * The rest wrote itself. Cutting a worktree kicks off the sweep, unawaited;
 * the sweep force-removed the checkout that had just been made; the agent
 * session had already been spawned with that path as its `cwd` and never
 * re-reads it, so the Claude Code process recreated the path as an empty,
 * non-git directory the moment it wrote anything. `git worktree add` then
 * refuses that path forever, because it exists and is not empty.
 *
 * Observed live on 2026-09-08: a project sitting exactly at the cap of 10, two
 * cuts a minute apart, and a thread left pointing at a directory holding
 * nothing but `.claude/.cc-writes`.
 *
 * WHY A GRACE WINDOW AND NOT JUST "HAS A SESSION". At the moment the sweep
 * runs, the session that will use the new checkout does not exist yet — the cut
 * returns, the sweep starts, and the session is spawned after. A live-session
 * check alone cannot see the very thing being destroyed. The window covers the
 * gap between a checkout appearing and something claiming it.
 *
 * Pure, so the rule is one testable function rather than a condition spelled
 * three ways across the sweep, the inventory and the next caller
 * (allowed-pattern #14).
 */
import type { ThreadStatus } from '../../shared/ipc-contract'

/**
 * How long a freshly cut checkout is protected from the cap.
 *
 * Long enough to cover a session spawn, which measured at 2.5–3.2 s for
 * `threads:prepareWorktree` on the machine that hit this. Short enough that a
 * checkout nobody ever used is reclaimable within a minute — this defends a
 * spawn, not an abandonment.
 */
export const WORKTREE_CUT_GRACE_MS = 60_000

export interface WorktreeUseFacts {
  /** An agent session is bound to this thread right now. */
  hasLiveSession: boolean
  /** The thread's turn status, or null when the thread is gone. */
  status: ThreadStatus | null
  /**
   * How long ago the checkout appeared on disk, in ms — null when unreadable.
   *
   * NULL IS PROTECTIVE. A checkout whose age cannot be read is one nothing
   * could establish is safe to delete, and this is a function whose false
   * answer removes a directory.
   */
  ageMs: number | null
  /** Override for the grace window; the default is the constant above. */
  graceMs?: number
}

/**
 * Whether the cap must leave this checkout alone.
 *
 * Three ways to be in use, and any one of them is enough:
 *
 *  1. A live session is bound to the thread. Its `cwd` was fixed at spawn and
 *     cannot be moved, so removing the directory does not redirect the agent —
 *     it strands it.
 *  2. The thread is not resting. `working` is the obvious one; `needs-decision`
 *     and `blocked` matter just as much, because a thread parked on a question
 *     resumes into the same checkout the moment it is answered.
 *  3. The checkout is younger than the grace window — the spawn gap above.
 */
export function isWorktreeInUse(facts: WorktreeUseFacts): boolean {
  if (facts.hasLiveSession) return true
  if (facts.status !== null && facts.status !== 'idle' && facts.status !== 'done') return true
  const grace = facts.graceMs ?? WORKTREE_CUT_GRACE_MS
  if (facts.ageMs === null) return true
  return facts.ageMs < grace
}
