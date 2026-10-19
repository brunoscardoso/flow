import { onThreadStatus, type TaskLaneSyncDeps } from './task-lane-sync'
import type { TaskLane, TaskRecord } from '../store/task-store'

function task(over: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: 't1',
    projectRoot: '/repo',
    title: 'Fix the thing',
    source: 'manual',
    externalKey: null,
    externalUrl: null,
    lane: 'doing' as TaskLane,
    suggestDone: false,
    threadId: 'th1',
    originThreadId: null,
    description: null,
    images: null,
    autoFix: false,
    agentBlockedFrom: null,
    prUrl: null,
    brief: null,
    briefStatus: 'idle',
    archivedAt: null,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    ...over,
  }
}

/** A deps double recording every updateTask call, resolving getTaskByThreadId
 *  from a single seeded task. */
function deps(seed: TaskRecord | null): {
  deps: TaskLaneSyncDeps
  calls: Array<{ id: string; patch: { lane?: TaskLane; agentBlockedFrom?: TaskLane | null } }>
} {
  const calls: Array<{
    id: string
    patch: { lane?: TaskLane; agentBlockedFrom?: TaskLane | null }
  }> = []
  return {
    calls,
    deps: {
      getTaskByThreadId: (threadId) => (seed && seed.threadId === threadId ? seed : null),
      updateTask: (id, patch) => {
        calls.push({ id, patch })
        return { ...(seed as TaskRecord), ...patch }
      },
    },
  }
}

describe('task-lane-sync onThreadStatus', () => {
  it('moves a working card to Blocked and remembers its lane when it needs a decision', () => {
    const { deps: d, calls } = deps(task({ lane: 'doing', agentBlockedFrom: null }))
    onThreadStatus('th1', 'needs-decision', d)
    expect(calls).toEqual([
      { id: 't1', patch: { lane: 'blocked', agentBlockedFrom: 'doing' } },
    ])
  })

  it('restores the remembered lane and clears the marker when the ask is answered', () => {
    const { deps: d, calls } = deps(task({ lane: 'blocked', agentBlockedFrom: 'todo' }))
    onThreadStatus('th1', 'working', d)
    expect(calls).toEqual([{ id: 't1', patch: { lane: 'todo', agentBlockedFrom: null } }])
  })

  it('restores on idle/done/failed too — any status that is not needs-decision', () => {
    for (const status of ['idle', 'done', 'failed'] as const) {
      const { deps: d, calls } = deps(task({ lane: 'blocked', agentBlockedFrom: 'doing' }))
      onThreadStatus('th1', status, d)
      expect(calls).toEqual([{ id: 't1', patch: { lane: 'doing', agentBlockedFrom: null } }])
    }
  })

  it('NEVER touches a human-parked Blocked card (null marker) — not on block, not on answer', () => {
    // Waiting: a card a person dragged to Blocked stays put even if its thread asks.
    const parked = deps(task({ lane: 'blocked', agentBlockedFrom: null }))
    onThreadStatus('th1', 'needs-decision', parked.deps)
    expect(parked.calls).toEqual([])
    // Answered: with no marker there is nothing of ours to restore.
    const answered = deps(task({ lane: 'blocked', agentBlockedFrom: null }))
    onThreadStatus('th1', 'working', answered.deps)
    expect(answered.calls).toEqual([])
  })

  it('does not re-record the origin when an already-agent-blocked card asks again', () => {
    // Its thread flips needs-decision again while still parked — the "from" lane
    // must not be overwritten with 'blocked'.
    const { deps: d, calls } = deps(task({ lane: 'blocked', agentBlockedFrom: 'doing' }))
    onThreadStatus('th1', 'needs-decision', d)
    expect(calls).toEqual([])
  })

  it('is a no-op for a bare thread that owns no card', () => {
    const { deps: d, calls } = deps(null)
    onThreadStatus('th-bare', 'needs-decision', d)
    onThreadStatus('th-bare', 'working', d)
    expect(calls).toEqual([])
  })
})
