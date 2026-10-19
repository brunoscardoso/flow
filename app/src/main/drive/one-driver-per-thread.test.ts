// ONE CONVERSATION, ONE DRIVER — the failure this phase was told to prevent.
//
// The board's loop and the autopilot chain are the same machine with different
// questions. If both could advance the same conversation, one finished turn
// would be answered twice: two messages, from two runners neither of which
// knows about the other. This proves they cannot, by running both over one
// thread and counting what was actually sent.

import { AutopilotChain } from './autopilot-chain'
import { ThreadClaims } from './turn-driver'
import { BoardLoop } from '../tasks/board-loop'
import type { TaskRecord, TaskStore } from '../store/task-store'
import type { ThreadRecord, ThreadStore } from '../store/thread-store'

function card(over: Partial<TaskRecord> = {}): TaskRecord {
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

function world() {
  const claims = new ThreadClaims()
  const sent: Array<{ threadId: string; content: string }> = []
  const cards = new Map<string, TaskRecord>([['c1', card()], ['c2', card({ id: 'c2', threadId: 'th2' })]])
  const taskStore = {
    getTask: (id: string) => cards.get(id) ?? null,
    getTaskByThreadId: (tid: string) =>
      [...cards.values()].find((entry) => entry.threadId === tid) ?? null,
    listTasks: () => [...cards.values()],
    updateTask: (id: string, patch: Partial<TaskRecord>) => {
      const next = { ...cards.get(id)!, ...patch }
      cards.set(id, next)
      return next
    },
  } as unknown as TaskStore
  const threadStore = {
    markAsLoopRun: () => {},
    setThreadChain: () => {},
    getThread: (id: string) =>
      ({ id, projectRoot: '/repo', title: 'A conversation', status: 'idle' }) as ThreadRecord,
  } as unknown as ThreadStore
  const loop = new BoardLoop({
    claims,
    taskStore,
    threadStore,
    ensureThread: (id: string) => cards.get(id)!,
    sendMessage: async (threadId, content) => {
      sent.push({ threadId, content })
    },
    onChange: () => {},
  })
  const chain = new AutopilotChain({
    threadStore,
    claims,
    sendMessage: async (threadId, content) => {
      sent.push({ threadId, content })
    },
    readProjectSettings: async () => ({
      autopilot: true,
      tail: { commit: false, push: false, pr: false },
    }),
    // The ladder's gate, answering yes — every case here is about something
    // else, and a gate that refused would stop the chain before it got there.
    checkStage: async () => ({ ok: true, detail: 'The step before this one left what it should have.' }),
    tail: {
      checkRisk: async () => ({ ok: true, detail: 'This work may be published.' }),
      push: async () => ({ ok: true, detail: 'published' }),
      openPullRequest: async () => ({ ok: true, detail: 'opened' }),
    },
    onChange: () => {},
    onChainEnd: (threadId, success) => loop.onTurnComplete(threadId, success),
    mintChainId: () => 'chain-test',
  })
  return { claims, loop, chain, sent, cards }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('a conversation the board loop is working', () => {
  it('refuses a chain on it — and sends nothing into it', async () => {
    const w = world()
    await w.loop.start('/repo')
    const before = w.sent.length
    const status = await w.chain.begin('th1')
    expect(status.running).toBe(false)
    expect(w.sent).toHaveLength(before)
  })

  it('one finished turn is answered once, by the loop alone', async () => {
    const w = world()
    await w.loop.start('/repo')
    w.sent.length = 0
    w.loop.onTurnComplete('th1', true)
    w.chain.onTurnComplete('th1', true)
    await settle()
    // The loop took its next card, and nothing else spoke into either thread.
    expect(w.sent).toHaveLength(1)
    expect(w.sent[0]?.threadId).toBe('th2')
  })
})

describe('a conversation a chain is running', () => {
  it('the board loop does not answer its finished turns', async () => {
    const w = world()
    await w.chain.begin('th1', { aim: 'do the thing' })
    w.sent.length = 0
    // Both are told; only the chain's run holds the claim.
    w.loop.onTurnComplete('th1', true)
    w.chain.onTurnComplete('th1', true)
    await settle()
    expect(w.sent).toHaveLength(1)
    expect(w.sent[0]?.content.split('\n')[0]).toBe('/create-plan do the thing')
  })

  it('releases the conversation when it ends, so the board may take it again', async () => {
    const w = world()
    await w.chain.begin('th1')
    expect(w.claims.ownerOf('th1')).toMatchObject({ driver: 'autopilot-chain' })
    w.chain.end('th1')
    expect(w.claims.ownerOf('th1')).toBeNull()
  })
})
