// Task-detail modal change detection (#204). tasks:updated broadcasts globally
// (any task mutation, debounced), and the board's refresh() re-rendered the open
// detail modal every time — `modal.textContent = ''` rebuilt every node and
// snapped the user's scroll back to the top mid-read, most disruptively while an
// agent is actively touching tasks. This signature captures exactly the fields
// the modal renders, so the modal can skip the rebuild when THIS task's visible
// content didn't change (an update to a different task, a lane move, or a bumped
// updatedAt never touch it). Pure + DOM-free so it unit-tests directly.

import type { TaskSummary } from '../../shared/ipc-contract'

/** The subset of a task that the detail modal actually renders. */
type RenderedTaskFields = Pick<
  TaskSummary,
  | 'title'
  | 'source'
  | 'externalKey'
  | 'externalUrl'
  | 'briefStatus'
  | 'brief'
  | 'description'
  | 'threadId'
  // Rendered by the Status row (#1153) — see #1299 above.
  | 'lane'
>

/**
 * A stable digest of the fields the detail modal renders. Two tasks with the
 * same signature produce an identical modal body, so a rerender can be skipped.
 * Deliberately excludes updatedAt / suggestDone etc. — they don't appear in the
 * modal, so changing them must not force a scroll-resetting rebuild. `lane`
 * DOES appear (the Status row), so it is included (#1299).
 */
export function taskDetailSignature(task: RenderedTaskFields): string {
  return JSON.stringify([
    task.title,
    task.source,
    task.externalKey ?? '',
    task.externalUrl ?? '',
    task.briefStatus,
    task.brief ?? '',
    task.description ?? '',
    task.threadId ?? '',
    task.lane,
  ])
}
