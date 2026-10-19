// DELETE A CHAINED CARD'S CONVERSATION AND THE NIGHT'S WORK GOES ON.
//
// The bug this pins is not a leaked map entry. A card the board's loop hands to
// a chain takes no claim of its own and is woken by the chain ENDING — so a
// chain that can never end is a project whose loop reports running for ever and
// dispatches no further cards. And a chain HELD on a question can never end by
// itself: it has no turn in flight, so nothing ever pumps it, so the thread it
// is holding is never looked at again. One deleted chat stopped everything, and
// no surface said a word.
//
// WHAT IS ASSERTED HERE IS THEREFORE THE CONSEQUENCE, not the cleanup: after
// the delete, the loop takes its NEXT card. The tidier facts (the run is gone,
// the conversation is unclaimed) are asserted too, because a loop that advanced
// while still holding a dead thread would be a different bug wearing this one's
// green tick.
//
// The delete arrives the way it does in the app — as the store's own deletion
// event, which is the one thing every door (the sidebar's delete, a card's
// delete, removing a project) passes through.

import { EventEmitter } from 'node:events'

import { AutopilotChain } from './autopilot-chain'
import { watchDeletedThreads } from './thread-gone'
import { ThreadClaims } from './turn-driver'
import { BoardLoop } from '../tasks/board-loop'
import type { TaskRecord, TaskStore } from '../store/task-store'
import {
  THREAD_STORE_CHANGE_EVENT,
  type ThreadRecord,
  type ThreadStatus,
  type ThreadStore,
} from '../store/thread-store'

const ROOT = '/repo'

function task(over: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: 'c1',
    projectRoot: ROOT,
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

/** A thread store that can really lose a thread, and says so the way the app's does. */
class Threads extends EventEmitter {
  readonly #status = new Map<string, ThreadStatus>()
  readonly #gone = new Set<string>()

  getThread(id: string): ThreadRecord | null {
    if (this.#gone.has(id)) return null
    return {
      id,
      projectRoot: ROOT,
      title: 'A conversation',
      status: this.#status.get(id) ?? 'working',
    } as ThreadRecord
  }

  setStatus(id: string, status: ThreadStatus): void {
    this.#status.set(id, status)
  }

  markAsLoopRun(): void {}
  setThreadChain(id: string): void {
    if (this.#gone.has(id)) throw new Error('no such thread')
  }

  /** The one door every delete in the app goes through. */
  deleteThread(id: string): void {
    this.#gone.add(id)
    this.emit(THREAD_STORE_CHANGE_EVENT, { entity: 'thread', action: 'deleted', threadId: id })
  }
}

function harness(seed: TaskRecord[]) {
  const tasks = new Map(seed.map((record) => [record.id, record]))
  const sent: Array<{ threadId: string; content: string }> = []
  const threads = new Threads()
  const threadStore = threads as unknown as ThreadStore
  const taskStore = {
    getTask: (id: string) => tasks.get(id) ?? null,
    getTaskByThreadId: (tid: string) =>
      [...tasks.values()].find((candidate) => candidate.threadId === tid) ?? null,
    listTasks: () => [...tasks.values()],
    updateTask: (id: string, patch: Partial<TaskRecord>) => {
      const next = { ...tasks.get(id)!, ...patch }
      tasks.set(id, next)
      return next
    },
  } as unknown as TaskStore
  const claims = new ThreadClaims()
  const sendMessage = async (threadId: string, content: string): Promise<void> => {
    sent.push({ threadId, content })
  }
  const chain = new AutopilotChain({
    threadStore,
    claims,
    sendMessage,
    readProjectSettings: async () => ({
      autopilot: false,
      tail: { commit: false, push: false, pr: false },
    }),
    // The ladder's gate, answering yes — every case here is about something
    // else, and a gate that refused would stop the chain before it got there.
    checkStage: async () => ({ ok: true, detail: 'The step before this one left what it should have.' }),
    tail: {
      checkRisk: async () => ({ ok: true, detail: 'This work may be published.' }),
      push: async () => ({ ok: true, detail: 'The work is published.' }),
      openPullRequest: async () => ({ ok: true, detail: 'Opened.' }),
    },
    onChange: () => {},
    onChainEnd: (threadId, success) => loop.onTurnComplete(threadId, success),
  })
  const loop = new BoardLoop({
    claims,
    taskStore,
    threadStore,
    ensureThread: (id: string) => tasks.get(id)!,
    sendMessage,
    onChange: () => {},
    beginChain: async (threadId, brief) => {
      const status = await chain.begin(threadId, { aim: brief, autonomous: true })
      return status.running
    },
  })
  // Exactly the app's wiring: the drivers hear about a deletion from the store.
  const unwatch = watchDeletedThreads(threads, { autopilotChain: chain, boardLoop: loop })
  return { chain, claims, loop, sent, tasks, threads, unwatch }
}

const settle = (): Promise<unknown> => new Promise((resolve) => setTimeout(resolve, 5))

describe('a chain held on a question, in a conversation somebody deletes', () => {
  it('lets the board loop take its next card', async () => {
    const h = harness([
      task(),
      task({ id: 'c2', threadId: 'th2', createdAt: '2026-09-02T00:00:00.000Z' }),
    ])
    await h.loop.start(ROOT)

    // The chain is running the first card's conversation, and is now waiting on
    // a person — no turn in flight, so nothing will pump it ever again.
    h.threads.setStatus('th1', 'needs-decision')
    h.chain.onThreadStatus('th1', 'needs-decision')
    h.chain.onTurnComplete('th1', true)
    await settle()
    expect(h.chain.status('th1')).toMatchObject({ running: true, waitingOnYou: true })
    expect(h.loop.status(ROOT).taskId).toBe('c1')
    expect(h.sent.filter((message) => message.threadId === 'th2')).toEqual([])

    h.threads.deleteThread('th1')
    await settle()

    // THE CONSEQUENCE. The night's work goes on.
    expect(h.sent.some((message) => message.threadId === 'th2')).toBe(true)
    expect(h.loop.status(ROOT).taskId).toBe('c2')
    // …and it went on because the first card was let go of, not in spite of it.
    expect(h.chain.isRunning('th1')).toBe(false)
    expect(h.claims.ownerOf('th1')).toBeNull()
  })

  it('does not carry the deleted card on to Review — a conversation nobody can open is not finished work', async () => {
    const h = harness([task()])
    await h.loop.start(ROOT)
    h.threads.setStatus('th1', 'needs-decision')
    h.chain.onThreadStatus('th1', 'needs-decision')
    h.chain.onTurnComplete('th1', true)
    await settle()

    h.threads.deleteThread('th1')
    await settle()

    expect(h.tasks.get('c1')).toMatchObject({ lane: 'todo', prUrl: null })
  })
})

describe('a conversation the board loop is working itself', () => {
  it('takes the next card when that conversation is deleted mid-turn', async () => {
    const h = harness([
      task(),
      task({ id: 'c2', threadId: 'th2', createdAt: '2026-09-02T00:00:00.000Z' }),
    ])
    // No chain takes this one: the loop holds the claim and waits on the turn.
    const loopOnly = new BoardLoop({
      claims: h.claims,
      taskStore: {
        getTask: (id: string) => h.tasks.get(id) ?? null,
        getTaskByThreadId: (tid: string) =>
          [...h.tasks.values()].find((candidate) => candidate.threadId === tid) ?? null,
        listTasks: () => [...h.tasks.values()],
        updateTask: (id: string, patch: Partial<TaskRecord>) => {
          const next = { ...h.tasks.get(id)!, ...patch }
          h.tasks.set(id, next)
          return next
        },
      } as unknown as TaskStore,
      threadStore: h.threads as unknown as ThreadStore,
      ensureThread: (id: string) => h.tasks.get(id)!,
      sendMessage: async (threadId, content) => {
        h.sent.push({ threadId, content })
      },
      onChange: () => {},
    })
    h.unwatch()
    const unwatch = watchDeletedThreads(h.threads, { autopilotChain: null, boardLoop: loopOnly })

    await loopOnly.start(ROOT)
    expect(loopOnly.status(ROOT).taskId).toBe('c1')

    h.threads.deleteThread('th1')
    await settle()

    expect(loopOnly.status(ROOT).taskId).toBe('c2')
    expect(h.claims.ownerOf('th1')).toBeNull()
    unwatch()
  })
})
