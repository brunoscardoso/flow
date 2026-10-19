// BoardLoop — the auto-PR-on-clean-finish behaviour (the Review lane).
//
// The loop's card-picking policy is proven exhaustively in board-loop-model.ts;
// this covers the side of BoardLoop that model has no view of: what happens to a
// card whose turn just ENDED. A clean finish opens a pull request and moves the
// card to Review; a failed finish, or a finish nothing can open a PR from, leaves
// it where it is.

import { BoardLoop } from './board-loop'
import type { TaskRecord } from '../store/task-store'
import type { TaskStore } from '../store/task-store'
import type { ThreadStore } from '../store/thread-store'

function task(over: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: 'c1',
    projectRoot: '/repo',
    title: 'Fix the thing',
    source: 'manual',
    externalKey: null,
    externalUrl: null,
    lane: 'todo',
    suggestDone: false,
    threadId: 'th1',
    originThreadId: null,
    description: null,
    images: null,
    autoFix: true,
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

interface Setup {
  loop: BoardLoop
  updates: Array<{ id: string; patch: Partial<TaskRecord> }>
  tasks: Map<string, TaskRecord>
}

function setup(
  seed: TaskRecord,
  openPullRequestForReview: (threadId: string) => Promise<{ url: string } | null>,
): Setup {
  const tasks = new Map<string, TaskRecord>([[seed.id, seed]])
  const updates: Array<{ id: string; patch: Partial<TaskRecord> }> = []
  const taskStore = {
    getTask: (id: string) => tasks.get(id) ?? null,
    getTaskByThreadId: (tid: string) =>
      [...tasks.values()].find((candidate) => candidate.threadId === tid) ?? null,
    listTasks: () => [...tasks.values()],
    updateTask: (id: string, patch: Partial<TaskRecord>) => {
      updates.push({ id, patch })
      const next = { ...tasks.get(id)!, ...patch }
      tasks.set(id, next)
      return next
    },
  } as unknown as TaskStore
  const threadStore = { markAsLoopRun: () => {} } as unknown as ThreadStore
  const loop = new BoardLoop({
    taskStore,
    threadStore,
    ensureThread: (id: string) => tasks.get(id)!,
    sendMessage: async () => {},
    onChange: () => {},
    openPullRequestForReview,
  })
  return { loop, updates, tasks }
}

/** Let the fire-and-forget review move settle. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 5))

describe('BoardLoop: a clean turn goes to Review', () => {
  it('opens a pull request and moves the card to Review with the URL', async () => {
    const { loop, updates, tasks } = setup(task(), async () => ({
      url: 'https://github.test/pr/1',
    }))
    await loop.start('/repo')
    loop.onTurnComplete('th1', true)
    await flush()
    expect(updates).toContainEqual({
      id: 'c1',
      patch: { lane: 'review', prUrl: 'https://github.test/pr/1', suggestDone: false },
    })
    expect(tasks.get('c1')?.lane).toBe('review')
    expect(tasks.get('c1')?.prUrl).toBe('https://github.test/pr/1')
  })

  it('leaves the card alone on a FAILED turn — no PR, no Review move', async () => {
    let asked = false
    const { loop, updates } = setup(task(), async () => {
      asked = true
      return { url: 'https://github.test/pr/1' }
    })
    await loop.start('/repo')
    loop.onTurnComplete('th1', false)
    await flush()
    expect(asked).toBe(false)
    expect(updates.some((u) => u.patch.lane === 'review')).toBe(false)
  })

  it('leaves the card alone when no pull request can be opened (unbound / no gh)', async () => {
    const { loop, updates, tasks } = setup(task(), async () => null)
    await loop.start('/repo')
    loop.onTurnComplete('th1', true)
    await flush()
    expect(updates.some((u) => u.patch.lane === 'review')).toBe(false)
    expect(tasks.get('c1')?.lane).not.toBe('review')
  })
})
