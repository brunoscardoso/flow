// BackgroundTaskTracker — the live set of work a thread is still owed after its
// turn ended. The level (`background_tasks_changed`) is the truth; the edges
// (`task_started` / `task_progress` / `task_notification`) only decorate.

import { BackgroundTaskTracker } from './background-tasks'

const T0 = new Date('2026-09-08T10:00:00.000Z')

/** A tracker on a clock the test moves by hand. */
function trackerAt(start = T0): { tracker: BackgroundTaskTracker; advance(ms: number): void } {
  let now = start.getTime()
  const tracker = new BackgroundTaskTracker(() => new Date(now))
  return { tracker, advance: (ms) => void (now += ms) }
}

// 'local_agent' is the task_type SDK 0.3.204's background-task events actually carry.
const review = { task_id: 't1', task_type: 'local_agent', description: 'security review pass' }
const perf = { task_id: 't2', task_type: 'local_agent', description: 'performance review pass' }

describe('BackgroundTaskTracker', () => {
  it('reports a thread’s live tasks from the level payload', () => {
    const { tracker } = trackerAt()
    expect(tracker.applyLevel('th', [review, perf])).toBe(true)
    expect(tracker.list('th').map((t) => t.description)).toEqual([
      'security review pass',
      'performance review pass',
    ])
  })

  it('REPLACES rather than merges, so a task the level drops is gone', () => {
    // The guarantee the SDK's level signal exists to give: a dropped edge
    // cannot wedge a spinner on forever, because the next level is authority.
    const { tracker } = trackerAt()
    tracker.applyLevel('th', [review, perf])
    tracker.applyLevel('th', [perf])
    expect(tracker.list('th').map((t) => t.id)).toEqual(['t2'])
  })

  it('keeps detail the edges taught it for a task the level still lists', () => {
    // The level carries ids only. Re-admitting a task from it must not blank
    // the sub-agent type and elapsed time progress reports filled in, or the
    // row loses its name and its clock every few seconds.
    const { tracker } = trackerAt()
    tracker.applyLevel('th', [review])
    tracker.applyProgress('th', {
      task_id: 't1',
      subagent_type: 'security-reviewer',
      last_tool_name: 'Grep',
      usage: { duration_ms: 21_000 },
    })
    tracker.applyLevel('th', [review, perf])
    expect(tracker.list('th')[0]).toMatchObject({
      agentType: 'security-reviewer',
      lastTool: 'Grep',
      elapsedMs: 21_000,
    })
  })

  it('keeps a task’s original start time across level updates', () => {
    // The elapsed clock ticks from this between progress reports; restamping it
    // on every membership change would reset every sibling's timer to zero
    // whenever any one task started or finished.
    const { tracker, advance } = trackerAt()
    tracker.applyLevel('th', [review])
    const first = tracker.list('th')[0]?.startedAt
    advance(30_000)
    tracker.applyLevel('th', [review, perf])
    expect(tracker.list('th')[0]?.startedAt).toBe(first)
    expect(tracker.list('th')[1]?.startedAt).not.toBe(first)
  })

  it('ignores an edge for a task the level has never admitted', () => {
    // The two message families race by design ("ordering … is unspecified"), and
    // an edge that arrives first must not create a task the level does not
    // list — that is exactly how a phantom row outlives the work.
    const { tracker } = trackerAt()
    expect(tracker.applyStarted('th', { task_id: 'ghost', description: 'nope' })).toBe(false)
    expect(tracker.applyProgress('th', { task_id: 'ghost' })).toBe(false)
    expect(tracker.list('th')).toEqual([])
  })

  it('drops a settled task even if its level update never arrives', () => {
    const { tracker } = trackerAt()
    tracker.applyLevel('th', [review, perf])
    expect(tracker.applySettled('th', 't1')).toBe(true)
    expect(tracker.list('th').map((t) => t.id)).toEqual(['t2'])
  })

  it('reports no change when a level repeats what it already said', () => {
    // The level fires on every membership change anywhere in the session; a
    // payload that draws identically must not cost a broadcast and a repaint.
    const { tracker } = trackerAt()
    tracker.applyLevel('th', [review])
    expect(tracker.applyLevel('th', [review])).toBe(false)
  })

  it('reports a change when a progress report moves the clock', () => {
    const { tracker } = trackerAt()
    tracker.applyLevel('th', [review])
    expect(tracker.applyProgress('th', { task_id: 't1', usage: { duration_ms: 4000 } })).toBe(true)
    expect(tracker.applyProgress('th', { task_id: 't1', usage: { duration_ms: 4000 } })).toBe(false)
  })

  it('has no elapsed time until the runtime reports one', () => {
    // A task that just started has no measured duration. Showing 0s would be a
    // measurement; showing nothing is the absence of one.
    const { tracker } = trackerAt()
    tracker.applyLevel('th', [review])
    expect(tracker.list('th')[0]?.elapsedMs).toBeUndefined()
  })

  it('empties a thread when its last task settles, and forgets it', () => {
    const { tracker } = trackerAt()
    tracker.applyLevel('th', [review])
    tracker.applySettled('th', 't1')
    expect(tracker.list('th')).toEqual([])
    expect(tracker.snapshot()).toEqual({})
  })

  it('resets a thread whose CLI process restarted', () => {
    // The level is per-process and emits nothing at startup, so a survivor from
    // the previous process would spin forever with nothing left to clear it.
    const { tracker } = trackerAt()
    tracker.applyLevel('th', [review])
    expect(tracker.reset('th')).toBe(true)
    expect(tracker.list('th')).toEqual([])
  })

  it('carries the resolved spawn record id from the edges (#1931)', () => {
    // The bridge resolves a task event's tool_use_id to the persisted
    // ToolCallRecord id and hands it over as `toolCallId` — the deterministic
    // join a click uses to open the sub-agent's child-thread chat.
    const { tracker } = trackerAt()
    tracker.applyLevel('th', [review])
    expect(tracker.applyStarted('th', { task_id: 't1', toolCallId: 'rec-9' })).toBe(true)
    expect(tracker.list('th')[0]?.toolCallId).toBe('rec-9')
  })

  it('keeps the spawn record id across level updates and silent edges (#1931)', () => {
    // The level carries ids only, and later progress reports may omit the
    // tool_use_id — neither may blank a join already learned, or every click
    // falls back to the progress view mid-run.
    const { tracker } = trackerAt()
    tracker.applyLevel('th', [review])
    tracker.applyStarted('th', { task_id: 't1', toolCallId: 'rec-9' })
    tracker.applyLevel('th', [review, perf])
    tracker.applyProgress('th', { task_id: 't1', last_tool_name: 'Read' })
    expect(tracker.list('th').find((t) => t.id === 't1')?.toolCallId).toBe('rec-9')
  })

  it('reports a change when a task learns its spawn record id (#1931)', () => {
    // Not drawn, but it decides WHERE a click goes — surfaces must rebroadcast.
    const { tracker } = trackerAt()
    tracker.applyLevel('th', [review])
    tracker.applyStarted('th', { task_id: 't1' })
    expect(tracker.applyProgress('th', { task_id: 't1', toolCallId: 'rec-9' })).toBe(true)
    expect(tracker.applyProgress('th', { task_id: 't1', toolCallId: 'rec-9' })).toBe(false)
  })

  it('keeps threads apart', () => {
    const { tracker } = trackerAt()
    tracker.applyLevel('a', [review])
    tracker.applyLevel('b', [perf])
    expect(tracker.list('a').map((t) => t.id)).toEqual(['t1'])
    expect(tracker.list('b').map((t) => t.id)).toEqual(['t2'])
    expect(Object.keys(tracker.snapshot()).sort()).toEqual(['a', 'b'])
  })
})
