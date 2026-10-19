// WHICH THREADS CHAIN — the asymmetry, proven with both drivers running.
//
// The board's loop used to open every card's thread with a sentence: "Autopilot
// is ON for this thread: chain the flow's commands through to the end." That was
// an instruction, and it was one because `autopilot` is a PROJECT-WIDE key —
// switching it on so that loop cards chain would have changed how the person's
// own conversations behave, which nobody asked for.
//
// The sentence is gone and the runner does it instead, so the asymmetry it was
// working around had to become code:
//
//   · a BOARD-LOOP thread is autonomous by definition — somebody pressed play on
//     cards they ticked — and is chained whatever the project's switch says;
//   · an ORDINARY conversation is chained only when the project has autopilot on.
//
// Both halves are asserted here against a project whose switch is OFF, which is
// the only configuration in which the two answers differ. The third test is the
// regression the hand-off exists for: a card is finished when its CHAIN ends,
// not when one of the chain's stages does.

import { AutopilotChain, AUTOPILOT_OFF } from './autopilot-chain'
import { ThreadClaims } from './turn-driver'
import { BoardLoop } from '../tasks/board-loop'
import type { TaskRecord, TaskStore } from '../store/task-store'
import type { ThreadStore } from '../store/thread-store'

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

interface Harness {
  loop: BoardLoop
  chain: AutopilotChain
  /** Every message that reached a thread, in order. */
  sent: Array<{ threadId: string; content: string }>
  /** Route a finished turn exactly as `index.ts` does. */
  turnComplete: (threadId: string, success?: boolean) => void
}

/** Both drivers, one claims registry, on a project with autopilot OFF. */
function harness(seed: TaskRecord[]): Harness {
  const tasks = new Map(seed.map((record) => [record.id, record]))
  const sent: Array<{ threadId: string; content: string }> = []
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
  const threadStore = {
    markAsLoopRun: () => {},
    setThreadChain: () => {},
    getThread: (id: string) => ({
      id,
      title: 'Card',
      projectRoot: ROOT,
      status: 'working' as const,
    }),
  } as unknown as ThreadStore
  const claims = new ThreadClaims()
  const sendMessage = async (threadId: string, content: string): Promise<void> => {
    sent.push({ threadId, content })
  }
  const chain = new AutopilotChain({
    threadStore,
    claims,
    sendMessage,
    // THE SWITCH IS OFF. Everything below turns on what each caller does about
    // that, which is the whole point of the file.
    readProjectSettings: async () => ({
      autopilot: false,
      tail: { commit: false, push: false, pr: false },
    }),
    // The ladder's gate, answering yes — every case here is about something
    // else, and a gate that refused would stop the chain before it got there.
    checkStage: async () => ({ ok: true, detail: 'The step before this one left what it should have.' }),
    tail: {
      checkRisk: async () => ({ ok: true, detail: 'fine' }),
      push: async () => ({ ok: true, detail: 'pushed' }),
      openPullRequest: async () => ({ ok: true, detail: 'opened' }),
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
  return {
    loop,
    chain,
    sent,
    // Exactly the aggregator in `index.ts`: both drivers hear every turn, and
    // the claims registry is what decides which of them acts on it.
    turnComplete: (threadId, success = true) => {
      loop.onTurnComplete(threadId, success)
      chain.onTurnComplete(threadId, success)
    },
  }
}

describe('a board-loop thread is chained by the runner', () => {
  it('chains the card even though the project has autopilot off', async () => {
    const h = harness([task()])

    await h.loop.start(ROOT)

    expect(h.chain.isRunning('th1')).toBe(true)
    // The first message is the chain's first rung, not the loop's one-shot
    // brief — and it carries the ticket's own words as the aim.
    expect(h.sent).toHaveLength(1)
    expect(h.sent[0]!.threadId).toBe('th1')
    expect(h.sent[0]!.content).toContain('/discovery-plan')
    expect(h.sent[0]!.content).toContain('Fix the thing')
    // THE SENTENCE IS GONE. Nothing tells the thread to chain itself.
    expect(h.sent[0]!.content).not.toContain('Autopilot is ON')
  })

  it('leaves the card in flight until the CHAIN ends, not one of its stages', async () => {
    const h = harness([task(), task({ id: 'c2', threadId: 'th2', createdAt: '2026-09-02T00:00:00.000Z' })])

    await h.loop.start(ROOT)
    expect(h.loop.status(ROOT).taskId).toBe('c1')

    // The discovery rung finished. The chain issues its next rung; the loop
    // must not conclude its card is done and take the second one.
    h.turnComplete('th1')
    await Promise.resolve()

    expect(h.loop.status(ROOT).taskId).toBe('c1')
    expect(h.sent.every((message) => message.threadId === 'th1')).toBe(true)
  })

  it('takes the next card when the chain itself ends', async () => {
    const h = harness([task(), task({ id: 'c2', threadId: 'th2', createdAt: '2026-09-02T00:00:00.000Z' })])
    await h.loop.start(ROOT)

    // A rung that did not finish cleanly stops the chain, which is an ENDING —
    // the hook the loop hangs on.
    h.turnComplete('th1', false)
    await new Promise((resolve) => setTimeout(resolve, 5))

    expect(h.chain.isRunning('th1')).toBe(false)
    expect(h.sent.some((message) => message.threadId === 'th2')).toBe(true)
  })
})

describe('an ordinary thread in an autopilot-off project is not chained', () => {
  it('refuses, says why, and sends nothing', async () => {
    const h = harness([task()])

    const status = await h.chain.begin('th9')

    expect(status.running).toBe(false)
    expect(status.stoppedReason).toBe(AUTOPILOT_OFF)
    expect(h.sent).toEqual([])
  })
})
