// Top-level Kanban board view state (#205). When tasks:list failed, refresh()
// swallowed the error and set an empty task array, so a load failure looked
// identical to a genuinely empty board — the user thought their tasks vanished
// with no error and no retry. This pure classifier decides which top-level view
// the board renders, keeping the error state distinct from a successful-but-empty
// load; the board renders a banner + Retry for 'load-error' and lanes otherwise.

import type { TaskLane } from '../../shared/ipc-contract'

export type BoardView = 'no-project' | 'load-error' | 'board'

/**
 * The board's columns, left to right — the one place their identity and order
 * are declared. It lives here, beside the view classifier, because the column
 * set is a fact about the board and not about the DOM: kanban-board.ts builds
 * a column per entry and nothing else decides what lanes exist.
 *
 * Blocked sits BETWEEN Doing and Done because that is where it sits in the
 * work: something started, and is now waiting on a person (an item behind an
 * approval gate). It is not a failure lane and it is not a second Todo.
 *
 * Review sits just before Done: work the agent finished and opened a pull
 * request for, now waiting on a person to merge it. The board loop moves a card
 * here on a clean turn, and the card carries the PR (a link + a Merge button).
 */
export const BOARD_LANES: ReadonlyArray<{ key: TaskLane; label: string }> = [
  { key: 'todo', label: 'Todo' },
  { key: 'doing', label: 'Doing' },
  { key: 'blocked', label: 'Blocked' },
  { key: 'review', label: 'Review' },
  { key: 'done', label: 'Done' },
]

/**
 * Resolve the board's top-level view. Precedence: no open project first (a stale
 * load error from a previous project must not mask "No project open"), then a
 * load failure, otherwise the normal lanes board (which may be empty).
 */
export function resolveBoardView(hasRoot: boolean, loadError: boolean): BoardView {
  if (!hasRoot) return 'no-project'
  if (loadError) return 'load-error'
  return 'board'
}

/**
 * The failure toast for a drag whose WRITE failed (#1687). The one message
 * telling the user their move didn't happen used to read `task.lane` AFTER the
 * optimistic mutation had already set it to the TARGET — so a To Do → Done
 * drag that failed toasted "stayed in Done" while the card was restored to
 * To Do: the safety message pointed at the opposite lane. Pure and built from
 * the ORIGIN the caller captured before mutating, so the words cannot depend
 * on when the optimistic update ran.
 */
export function moveFailureMessage(title: string, fromLaneLabel: string, detail: string): string {
  return `${title || 'The task'} stayed in ${fromLaneLabel} — ${detail}`
}
