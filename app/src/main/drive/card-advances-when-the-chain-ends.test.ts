// A CARD IS FINISHED WHEN ITS CHAIN ENDS — and only if the chain ended well.
//
// The board's loop hands a card's conversation to the chain and takes no claim
// of its own (`Dispatched.drivenElsewhere`), so the only thing that can settle
// the card is `onChainEnd`. Two behaviours meet in that hand-off, and both have
// already been got wrong once:
//
//   · a card must not be settled by a STAGE ending. If the loop kept its claim,
//     every rung's turn would settle the card — the loop would move it to
//     Review after the discovery and take the next card while the chain was
//     still running in the first one's thread.
//   · a REFUSED publish must not settle it either. Phase 4 found a tail that
//     reported the chain finished after its publish had been refused, which
//     moved the card to Review with nothing published behind it.
//
// `board-loop-chaining.test.ts` proves WHICH threads chain and that the card
// stays in flight across a rung; what is asserted here is the other end — what
// reaches the CARD when the chain finally does end, with the tail wired so a
// refusal can actually happen. The third case is the plainest thing anybody not
// using this feature relies on: when no chain takes the thread, the loop works
// the card exactly as it did before chains existed.
//
// WHAT THIS FILE DELIBERATELY DOES NOT RE-CREATE: the app wires the loop's
// review move to skip opening a second pull request when the chain's tail
// already opened one, by reading `chain.status(threadId).prUrl` after the chain
// has ended (`index.ts`). Rebuilding that closure here would assert the
// harness rather than the app; what it rests on — that the URL survives the end
// on success and is null on a refusal — is asserted in `honoured-pauses.test.ts`.

import { AutopilotChain } from './autopilot-chain'
import type { TailStep } from './chain-tail'
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
  /** Every review move the loop asked for — the card's own publish path. */
  reviewCalls: string[]
  /** Every publish verb the CHAIN's tail called. */
  published: string[]
  tasks: Map<string, TaskRecord>
  /** Route a finished turn exactly as `index.ts` does: both drivers hear it. */
  turnComplete: (threadId: string, success?: boolean) => void
}

function harness(
  seed: TaskRecord[],
  options: {
    /** What the chain's publish gate answers. Satisfied unless a case says so. */
    gate?: TailStep
    /** What the chain's publish verb answers. Satisfied unless a case says so. */
    publish?: TailStep
    tail?: { commit: boolean; push: boolean; pr: boolean }
    /** False → no chain takes the thread and the loop works the card itself. */
    chainTakesTheThread?: boolean
  } = {},
): Harness {
  const tasks = new Map(seed.map((record) => [record.id, record]))
  const sent: Array<{ threadId: string; content: string }> = []
  const reviewCalls: string[] = []
  const published: string[] = []
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
    getThread: (id: string) => ({ id, title: 'Card', projectRoot: ROOT, status: 'working' as const }),
  } as unknown as ThreadStore
  const claims = new ThreadClaims()
  const sendMessage = async (threadId: string, content: string): Promise<void> => {
    sent.push({ threadId, content })
  }
  const chain = new AutopilotChain({
    threadStore,
    claims,
    sendMessage,
    // OFF, as it is for almost everybody: a board-loop card is chained by the
    // runner's own consent (somebody pressed play), never by this key.
    readProjectSettings: async () => ({
      autopilot: false,
      tail: options.tail ?? { commit: false, push: false, pr: false },
    }),
    // The ladder's gate, answering yes — every case here is about something
    // else, and a gate that refused would stop the chain before it got there.
    checkStage: async () => ({ ok: true, detail: 'The step before this one left what it should have.' }),
    tail: {
      checkRisk: async () => options.gate ?? { ok: true, detail: 'This work may be published.' },
      push: async () => {
        published.push('push')
        return options.publish ?? { ok: true, detail: 'The work is published.' }
      },
      openPullRequest: async () => {
        published.push('pr')
        return options.publish ?? { ok: true, detail: 'Opened.', url: 'https://example.test/pr/9' }
      },
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
      if (options.chainTakesTheThread === false) return false
      const status = await chain.begin(threadId, { aim: brief, autonomous: true })
      return status.running
    },
    // The card's own publish path, as `board-loop.test.ts` fakes it: a spy that
    // says a pull request could be opened. WHEN it is called is the question.
    openPullRequestForReview: async (threadId) => {
      reviewCalls.push(threadId)
      return { url: `https://example.test/card/${threadId}` }
    },
  })
  return {
    loop,
    chain,
    sent,
    reviewCalls,
    published,
    tasks,
    turnComplete: (threadId, success = true) => {
      loop.onTurnComplete(threadId, success)
      chain.onTurnComplete(threadId, success)
    },
  }
}

/** Let the fire-and-forget pumps and the review move settle. */
const settle = (): Promise<unknown> => new Promise((resolve) => setTimeout(resolve, 5))

/** Finish the chain's four rungs. The tail runs after the last one. */
async function runTheChain(h: Harness, threadId = 'th1'): Promise<void> {
  for (const _ of [1, 2, 3, 4]) {
    h.turnComplete(threadId, true)
    await settle()
  }
}

describe('a chained card is settled by the chain ending, never by a stage', () => {
  it('is not moved to Review while the chain is still running its rungs', async () => {
    const h = harness([task()])
    await h.loop.start(ROOT)

    // Three rungs have ended. Each is a finished turn on this card's thread —
    // and none of them is the card finishing.
    for (const _ of [1, 2, 3]) {
      h.turnComplete('th1', true)
      await settle()
    }

    // Said positively first, so the absence below is not the absence of a run:
    // the chain really is mid-ladder in this card's conversation, and the card
    // really is the one the loop is on.
    expect(h.chain.isRunning('th1')).toBe(true)
    expect(h.loop.status(ROOT).taskId).toBe('c1')
    expect(h.sent.map((message) => message.content.split(' ')[0])).toEqual([
      '/discovery-plan',
      '/create-plan',
      '/execute-plan',
      '/review-code',
    ])

    expect(h.reviewCalls).toEqual([])
    expect(h.tasks.get('c1')!.lane).toBe('todo')
    expect(h.tasks.get('c1')!.prUrl).toBeNull()
  })

  it('moves it to Review ONCE, when the chain itself ends', async () => {
    const h = harness([task()])
    await h.loop.start(ROOT)

    await runTheChain(h)

    // One review move for the whole chain — not one per rung.
    expect(h.reviewCalls).toEqual(['th1'])
    expect(h.tasks.get('c1')).toMatchObject({
      lane: 'review',
      prUrl: 'https://example.test/card/th1',
      suggestDone: false,
    })
  })
})

describe('a refused publish does not move the card on', () => {
  it('a run rated high risk is withheld — nothing published, and the card is not in Review', async () => {
    const h = harness([task()], {
      tail: { commit: true, push: true, pr: true },
      gate: { ok: false, detail: 'This work was rated high risk, so it was not published.' },
    })
    await h.loop.start(ROOT)

    await runTheChain(h)

    // The refusal held: no publish verb was reached…
    expect(h.published).toEqual([])
    // …and the card was not carried past it either.
    expect(h.reviewCalls).toEqual([])
    expect(h.tasks.get('c1')).toMatchObject({ lane: 'todo', prUrl: null })
  })

  it('a branch nobody has bound is refused, and the card stays where it is', async () => {
    const h = harness([task()], {
      tail: { commit: true, push: true, pr: true },
      publish: {
        ok: false,
        detail: 'Nobody has said where this work should be published, so it was left alone.',
      },
    })
    await h.loop.start(ROOT)

    await runTheChain(h)

    // The verb was called once and refused; nothing tried again by another route.
    expect(h.published).toEqual(['pr'])
    expect(h.reviewCalls).toEqual([])
    expect(h.tasks.get('c1')).toMatchObject({ lane: 'todo', prUrl: null })
  })

  it('a refused publish still frees the run to take the next card — held is not stuck', async () => {
    const h = harness([task(), task({ id: 'c2', threadId: 'th2', createdAt: '2026-09-02T00:00:00.000Z' })], {
      tail: { commit: true, push: true, pr: true },
      gate: { ok: false, detail: 'This work was rated high risk, so it was not published.' },
    })
    await h.loop.start(ROOT)

    await runTheChain(h)

    // The first card is left visibly unfinished — and the night's work goes on,
    // which is the loop's own documented rule for a card that did not succeed.
    expect(h.tasks.get('c1')!.lane).toBe('todo')
    expect(h.sent.some((message) => message.threadId === 'th2')).toBe(true)
  })
})

describe('when no chain takes the thread, the loop works the card as it always did', () => {
  it('sends the card its brief and settles it on that one turn', async () => {
    const h = harness([task()], { chainTakesTheThread: false })

    await h.loop.start(ROOT)

    expect(h.chain.isRunning('th1')).toBe(false)
    expect(h.sent).toHaveLength(1)
    expect(h.sent[0]!.content).toContain('Fix the thing')
    // No chain, so no stage command is issued into the conversation.
    expect(h.sent[0]!.content).not.toContain('/discovery-plan')

    h.turnComplete('th1', true)
    await settle()

    expect(h.reviewCalls).toEqual(['th1'])
    expect(h.tasks.get('c1')).toMatchObject({ lane: 'review', prUrl: 'https://example.test/card/th1' })
  })

  it('takes the next card on that turn, rather than waiting for a chain that never started', async () => {
    const h = harness([task(), task({ id: 'c2', threadId: 'th2', createdAt: '2026-09-02T00:00:00.000Z' })], {
      chainTakesTheThread: false,
    })
    await h.loop.start(ROOT)
    expect(h.loop.status(ROOT).taskId).toBe('c1')

    h.turnComplete('th1', true)
    await settle()

    expect(h.loop.status(ROOT).taskId).toBe('c2')
    expect(h.sent.some((message) => message.threadId === 'th2')).toBe(true)
  })
})
