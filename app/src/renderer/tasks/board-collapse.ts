// The board's lane-collapse decision layer (#1902) — DOM-free, like every other
// model on this board. It answers three questions and touches nothing:
//
//   · where a project's minimized-lanes preference is stored,
//   · which stored lane keys are real (validated, never trusted), and
//   · which minimized lanes must reveal themselves because work just landed in
//     them (the auto-reveal rule the ticket asked for).
//
// kanban-board.ts holds the Set, reads/writes localStorage and toggles the CSS
// class; it asks THIS module what the answer is. Keeping the rule here is what
// lets a unit test pin the auto-reveal edge cases (no baseline, a card leaving)
// without a browser.

import type { TaskLane } from '../../shared/ipc-contract'
import { BOARD_LANES } from './board-view'

/**
 * Where a project's minimized-lanes preference lives.
 *
 * PER PROJECT AND ON THIS MACHINE, the same reasoning as the Remote column's
 * `remoteListStorageKey`: which lanes a person folds away is a view preference,
 * not something to commit or write into a directive the whole team reads.
 */
export function laneCollapseStorageKey(projectRoot: string): string {
  return `flow.board.collapsed:${projectRoot}`
}

/** The lane keys the board actually has — the allow-list the parser validates against. */
const LANE_KEYS: ReadonlySet<TaskLane> = new Set(BOARD_LANES.map((lane) => lane.key))

/**
 * The minimized-lanes set, read back from storage.
 *
 * VALIDATED, NEVER TRUSTED — the stored string can come from a newer build that
 * knows a lane this one does not, or a hand edit. An unrecognised token is
 * dropped rather than carried as a lane nothing can render; duplicates collapse
 * to one.
 */
export function parseCollapsedLanes(raw: string | null): Set<TaskLane> {
  const out = new Set<TaskLane>()
  if (raw === null) return out
  for (const token of raw.split(',')) {
    const key = token.trim()
    if (LANE_KEYS.has(key as TaskLane)) out.add(key as TaskLane)
  }
  return out
}

/**
 * The minimized-lanes set, written to storage.
 *
 * IN BOARD ORDER, so the stored value is deterministic — the same set always
 * serialises to the same string, whatever order the entries were added, which
 * keeps a stored preference stable across renders and easy to reason about in a
 * test.
 */
export function serializeCollapsedLanes(lanes: ReadonlySet<TaskLane>): string {
  return BOARD_LANES.map((lane) => lane.key)
    .filter((key) => lanes.has(key))
    .join(',')
}

export interface CollapseReconcileInput {
  /** The lanes currently minimized. */
  collapsed: ReadonlySet<TaskLane>
  /**
   * Each lane's card count at the LAST render — the baseline the reveal rule
   * compares against. A lane absent here has no baseline yet (first render, or
   * just after a project switch), so it cannot be said to have grown.
   */
  prevCounts: ReadonlyMap<TaskLane, number>
  /** Each lane's card count at THIS render. */
  counts: ReadonlyMap<TaskLane, number>
}

export interface CollapseReconcile {
  /** The next minimized set — a NEW set, the input is never mutated. */
  collapsed: Set<TaskLane>
  /** The lanes auto-revealed this pass — for persistence and any notice. */
  expanded: TaskLane[]
}

/**
 * Reveal a minimized lane the moment work lands in it (#1902).
 *
 * THE RULE IS "COUNT ROSE AGAINST A KNOWN BASELINE", and every word earns its
 * place:
 *   · ROSE, not merely changed — a card LEAVING a minimized lane must not pop it
 *     open, only a card arriving (the ticket's "moved into review" case).
 *   · KNOWN BASELINE — a lane with no prior count is the first render or a fresh
 *     project, and treating "undefined → 3" as growth would fling open every lane
 *     the person deliberately minimized the instant the board loaded. NFR-4.
 *
 * Returns a new set so the caller can compare and persist only on a real change.
 */
export function reconcileCollapsedLanes(input: CollapseReconcileInput): CollapseReconcile {
  const collapsed = new Set(input.collapsed)
  const expanded: TaskLane[] = []
  for (const lane of collapsed) {
    const prev = input.prevCounts.get(lane)
    const now = input.counts.get(lane) ?? 0
    if (prev !== undefined && now > prev) expanded.push(lane)
  }
  for (const lane of expanded) collapsed.delete(lane)
  return { collapsed, expanded }
}
