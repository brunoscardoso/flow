/**
 * How a parent's promoted sub-agent child rows fold in the sidebar (#1931
 * follow-up) — pure, DOM-free, so the fold rule is unit-testable and the
 * renderer never re-derives it.
 *
 * THE DISCLOSURE LIVES ON THE PARENT THREAD ROW, not on a row of its own —
 * and it is the row's ONE caret (#1931 follow-up: one level of collapse per
 * thread; the separate agent-tasks caret was absorbed into it). By default a
 * thread with FINISHED children shows NOTHING extra beneath it — zero rows —
 * and the chevron expands the nest. Live rows are never in the fold:
 *
 *   1. LIVE children — a child whose ORIGIN tool call is still running is
 *      current work, exactly like the agent-task rows beside it; both are the
 *      only trace of running work and render in every collapse state.
 *   2. THE SELECTION — when a finished child is the currently-open thread,
 *      the group renders expanded whatever the chevron's in-memory state. A
 *      list must never hide the row for the conversation on screen.
 *
 * Expansion is in-memory per parent (session-scoped) — no persistence
 * requirement.
 */

import type { BackgroundTaskInfo } from '../../shared/ipc-contract'
import { trackerTaskFor } from './background-activity-model'

/** The facts the fold needs about one child thread. */
export interface ChildRowFacts {
  id: string
}

/** The one fact the agent-task dedupe needs about a promoted child. */
export interface PromotableChildFacts {
  originToolCallId?: string | null
}

/**
 * The live agent-task rows a thread should still draw, after dropping every
 * task that RESOLVED to a promoted child of the same parent (#1931 follow-up).
 *
 * A running promoted sub-agent used to render TWICE under its parent: the
 * live agent-task row (spinner + elapsed) AND the ↳ child-thread row. One
 * piece of work gets one row — the child row, which is the richer surface (a
 * real conversation) and carries the spinner itself while the origin runs.
 * The join is the deterministic one every lifecycle consumer uses
 * (`trackerTaskFor`: task.toolCallId → child.originToolCallId, gated to
 * sub-agent task types — allowed-pattern #14), so:
 *
 *   - an UNPROMOTED task (no child claims it) keeps its agent-task row and
 *     today's click behavior (eager promotion);
 *   - a task claimed by a DIFFERENT parent's child is untouched — only THIS
 *     parent's children are consulted;
 *   - a shell/monitor task is never suppressed, whatever id it carries.
 */
export function visibleAgentTasks(
  tasks: readonly BackgroundTaskInfo[],
  children: readonly PromotableChildFacts[],
): BackgroundTaskInfo[] {
  if (tasks.length === 0 || children.length === 0) return [...tasks]
  const promoted = new Set<BackgroundTaskInfo>()
  for (const child of children) {
    const originId = child.originToolCallId
    if (originId === null || originId === undefined) continue
    const task = trackerTaskFor(originId, tasks)
    if (task !== undefined) promoted.add(task)
  }
  if (promoted.size === 0) return [...tasks]
  return tasks.filter((task) => !promoted.has(task))
}

/** One visible child row, in render order. */
export interface ChildRowPlan<T extends ChildRowFacts> {
  thread: T
  originRunning: boolean
}

/**
 * Whether a child row offers the hover ✕ (#1931 follow-up) — FINISHED rows
 * only. Dismiss = archive, and a RUNNING child's very next redirected row
 * would un-archive it straight back (the proof-of-life rule), so a ✕ there is
 * a control that cannot keep its promise — and hiding running work is the
 * failure these rows exist to prevent.
 */
export function canDismissChildRow(row: { originRunning: boolean }): boolean {
  return !row.originRunning
}

/** What the parent row's children fold shows. */
export interface ChildRowsView<T extends ChildRowFacts> {
  /** The child rows to render beneath the parent, in order: live first. */
  rows: Array<ChildRowPlan<T>>
  /**
   * The parent row's disclosure chevron, or null when there is nothing to
   * fold (no finished children — live rows never fold, so a live-only nest
   * needs no control). `expanded` is the EFFECTIVE state — the reader's
   * choice, forced open while a finished child is the selection — so the
   * caret can never point away from rows that are visibly there.
   */
  disclosure: { count: number; expanded: boolean } | null
}

/**
 * Plan one parent's children: live rows always; finished rows only when the
 * group is effectively expanded (`expanded` or the selection is one of them).
 */
export function planChildRows<T extends ChildRowFacts>(options: {
  children: readonly T[]
  originRunning: (childId: string) => boolean
  expanded: boolean
  activeThreadId: string | null
}): ChildRowsView<T> {
  const live: T[] = []
  const finished: T[] = []
  for (const child of options.children) {
    if (options.originRunning(child.id)) live.push(child)
    else finished.push(child)
  }

  const rows: Array<ChildRowPlan<T>> = live.map((thread) => ({ thread, originRunning: true }))
  if (finished.length === 0) return { rows, disclosure: null }

  const holdsSelection =
    options.activeThreadId !== null &&
    finished.some((child) => child.id === options.activeThreadId)
  const effectiveExpanded = options.expanded || holdsSelection

  if (effectiveExpanded) {
    for (const thread of finished) rows.push({ thread, originRunning: false })
  }
  return { rows, disclosure: { count: finished.length, expanded: effectiveExpanded } }
}
