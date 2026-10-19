// Pure fold tests for the sidebar's promoted sub-agent child rows (#1931
// follow-up): the disclosure lives on the PARENT THREAD ROW and is the row's
// ONE caret — default collapsed means ZERO extra rows; live children always
// show; and the fold never hides the active thread. `disclosure` is the only
// fold control the plan emits (the old separate agent-tasks caret is gone),
// and `visibleAgentTasks` takes NO collapse input at all: live agent-task
// rows are dedupe-filtered, never folded.

import type { BackgroundTaskInfo } from '../../shared/ipc-contract'
import { subagentRunState } from './background-activity-model'
import { canDismissChildRow, planChildRows, visibleAgentTasks } from './sidebar-child-rows'

const child = (id: string): { id: string } => ({ id })

function plan(options: {
  children: string[]
  running?: string[]
  expanded?: boolean
  activeThreadId?: string | null
}): ReturnType<typeof planChildRows<{ id: string }>> {
  const running = new Set(options.running ?? [])
  return planChildRows({
    children: options.children.map(child),
    originRunning: (id) => running.has(id),
    expanded: options.expanded ?? false,
    activeThreadId: options.activeThreadId ?? null,
  })
}

describe('planChildRows', () => {
  it('returns nothing at all for a parent with no children', () => {
    expect(plan({ children: [] })).toEqual({ rows: [], disclosure: null })
  })

  it('collapsed by default: ZERO rows, and a collapsed chevron on the parent', () => {
    expect(plan({ children: ['a', 'b'] })).toEqual({
      rows: [],
      disclosure: { count: 2, expanded: false },
    })
  })

  it('keeps LIVE children visible even while collapsed, in their given order', () => {
    expect(plan({ children: ['a', 'b', 'c'], running: ['a', 'c'] })).toEqual({
      rows: [
        { thread: { id: 'a' }, originRunning: true },
        { thread: { id: 'c' }, originRunning: true },
      ],
      disclosure: { count: 1, expanded: false },
    })
  })

  it('offers no disclosure when every child is live — nothing is foldable', () => {
    expect(plan({ children: ['a'], running: ['a'] })).toEqual({
      rows: [{ thread: { id: 'a' }, originRunning: true }],
      disclosure: null,
    })
  })

  it('expanding reveals all children beneath the live ones', () => {
    expect(plan({ children: ['a', 'b'], expanded: true })).toEqual({
      rows: [
        { thread: { id: 'a' }, originRunning: false },
        { thread: { id: 'b' }, originRunning: false },
      ],
      disclosure: { count: 2, expanded: true },
    })
  })

  it('NEVER hides the selection: a collapsed group holding the active thread renders expanded', () => {
    expect(plan({ children: ['a', 'b'], activeThreadId: 'b' })).toEqual({
      rows: [
        { thread: { id: 'a' }, originRunning: false },
        { thread: { id: 'b' }, originRunning: false },
      ],
      disclosure: { count: 2, expanded: true },
    })
  })

  it('a selection elsewhere does not force the group open', () => {
    expect(plan({ children: ['a'], activeThreadId: 'other' })).toEqual({
      rows: [],
      disclosure: { count: 1, expanded: false },
    })
  })

  it('a LIVE selected child needs no override — it is already visible', () => {
    expect(plan({ children: ['a', 'b'], running: ['a'], activeThreadId: 'a' })).toEqual({
      rows: [{ thread: { id: 'a' }, originRunning: true }],
      disclosure: { count: 1, expanded: false },
    })
  })

  it('ONE caret: toggling the single state only moves the FINISHED rows — live rows render in both states', () => {
    const live = { thread: { id: 'live' }, originRunning: true }
    const collapsed = plan({ children: ['live', 'done'], running: ['live'], expanded: false })
    const expanded = plan({ children: ['live', 'done'], running: ['live'], expanded: true })
    expect(collapsed).toEqual({ rows: [live], disclosure: { count: 1, expanded: false } })
    expect(expanded).toEqual({
      rows: [live, { thread: { id: 'done' }, originRunning: false }],
      disclosure: { count: 1, expanded: true },
    })
  })

  it('the hover ✕ offers on FINISHED rows only — never on a running child (canDismissChildRow)', () => {
    // Dismiss = archive, and a running child's next redirected row would
    // un-archive it straight back (proof-of-life) — the control never shows.
    expect(canDismissChildRow({ originRunning: false })).toBe(true)
    expect(canDismissChildRow({ originRunning: true })).toBe(false)
    // The plan's own rows carry the exact fact the renderer feeds it with.
    const { rows } = plan({ children: ['live', 'done'], running: ['live'], expanded: true })
    expect(rows.map((row) => ({ id: row.thread.id, dismissable: canDismissChildRow(row) }))).toEqual(
      [
        { id: 'live', dismissable: false },
        { id: 'done', dismissable: true },
      ],
    )
  })
})

describe('the fold over the lifecycle merge rule (#1931 follow-up)', () => {
  // The sidebar composes the two pure seams exactly like this: originRunning
  // is subagentRunState over (cached persisted status | null, the parent's
  // tracker snapshot). This pins the INSTANT re-fold: the moment the tracker
  // drops the task, the same render folds the child — no new reads needed for
  // the early-settled backgrounded case (the record cache is empty, because
  // the tracker covered the spawn the whole time).
  const tracked: BackgroundTaskInfo = {
    id: 'task-1',
    taskType: 'local_agent',
    description: 'Research',
    toolCallId: 'origin-1',
    startedAt: '2026-10-07T10:00:00.000Z',
  }
  const foldWith = (
    trackerTasks: readonly BackgroundTaskInfo[],
  ): ReturnType<typeof planChildRows<{ id: string }>> =>
    planChildRows({
      children: [{ id: 'child-1' }],
      originRunning: () => subagentRunState(null, trackerTasks, 'origin-1').running,
      expanded: false,
      activeThreadId: null,
    })

  it('tracker holds the origin → the child renders LIVE (record never read)', () => {
    expect(foldWith([tracked]).rows).toEqual([{ thread: { id: 'child-1' }, originRunning: true }])
  })

  it('the task ends → the SAME render folds the child instantly', () => {
    expect(foldWith([])).toEqual({
      rows: [],
      disclosure: { count: 1, expanded: false },
    })
  })
})

describe('visibleAgentTasks — one row per running sub-agent (#1931 follow-up)', () => {
  const liveTask = (overrides: Partial<BackgroundTaskInfo> = {}): BackgroundTaskInfo => ({
    id: 'task-1',
    taskType: 'local_agent',
    description: 'AI research and model news',
    toolCallId: 'origin-1',
    startedAt: '2026-10-07T10:00:00.000Z',
    ...overrides,
  })

  it('suppresses the agent-task row when a promoted child claims the task — the child row, flagged running, is the ONE row', () => {
    const tasks = [liveTask()]
    const children = [{ id: 'child-1', originToolCallId: 'origin-1' }]
    // No separate agent-task row…
    expect(visibleAgentTasks(tasks, children)).toEqual([])
    // …and the same tracker join renders the child row LIVE.
    const fold = planChildRows({
      children: [{ id: 'child-1' }],
      originRunning: () => subagentRunState(null, tasks, 'origin-1').running,
      expanded: false,
      activeThreadId: null,
    })
    expect(fold.rows).toEqual([{ thread: { id: 'child-1' }, originRunning: true }])
  })

  it('keeps an UNPROMOTED task (no child claims it) exactly as before', () => {
    const tasks = [liveTask({ toolCallId: 'origin-unclaimed' })]
    expect(visibleAgentTasks(tasks, [{ originToolCallId: 'origin-else' }])).toEqual(tasks)
    expect(visibleAgentTasks(tasks, [])).toEqual(tasks)
    // A task with no toolCallId at all can never be claimed.
    const anonymous = [liveTask({ toolCallId: undefined })]
    expect(visibleAgentTasks(anonymous, [{ originToolCallId: 'origin-1' }])).toEqual(anonymous)
  })

  it("a task claimed by a DIFFERENT parent's child does not suppress — only THIS parent's children are consulted", () => {
    const tasks = [liveTask()]
    // The other parent's child (origin-1) is not in THIS parent's child list.
    const thisParentsChildren = [{ id: 'c', originToolCallId: 'origin-2' }]
    expect(visibleAgentTasks(tasks, thisParentsChildren)).toEqual(tasks)
  })

  it('never suppresses a shell/monitor task, whatever id it carries', () => {
    const tasks = [liveTask({ taskType: 'shell' })]
    const children = [{ id: 'child-1', originToolCallId: 'origin-1' }]
    expect(visibleAgentTasks(tasks, children)).toEqual(tasks)
  })

  it('suppresses only the claimed task from a mixed set, preserving order', () => {
    const claimed = liveTask({ id: 'task-1', toolCallId: 'origin-1' })
    const other = liveTask({ id: 'task-2', toolCallId: 'origin-2', description: 'Other work' })
    const children = [{ id: 'child-1', originToolCallId: 'origin-1' }]
    expect(visibleAgentTasks([claimed, other], children)).toEqual([other])
  })
})
