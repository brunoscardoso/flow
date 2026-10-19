// THE THREE PAUSES AN ENFORCED CHAIN HONOURS — and the four it does not.
//
// An enforced run stops for exactly three things, all of them irreversible to
// somebody else: a changeset rated `high` risk (or never rated at all) before
// the publish, the guard classifier's `ask`, and a branch nobody has bound. It
// does not stop for the four quality stops — a wave file conflict, a contract
// conflict, a withheld repair, a failing lint gate — which are "the run is not
// confident", and which the feature was asked to push through (discovery D3).
//
// A REFUSAL TEST ASSERTS THE ABSENCE OF THE EFFECT, NOT JUST THE SENTENCE
// (allowed-pattern #24). Every case below checks which verbs were called, so a
// chain that reports a pause and publishes anyway fails here — a loud refusal
// that still pushes is precisely the wrong-but-valid push these pauses exist to
// stop. The `published` array IS the recorded argv of this layer: the publish
// verbs are the only path to `git push` and `gh`, and an empty array means
// nothing reached the remote.
//
// TWO OF THE THREE ARE NOT TESTED FOR THEIR LOGIC HERE, ON PURPOSE. The guard
// classifier and the unbound-push refusal are existing code with their own
// suites; Phase 4 was told to assert that the DRIVER does not advance past
// them and to add no second gate beside the working one. So what is asserted is
// the driver's behaviour in their presence, never a re-implementation of their
// decision.

import { AutopilotChain } from './autopilot-chain'
import { CHAIN_FINISHED, CHAIN_NOT_PUBLISHED } from './chain-model'
import type { TailStep } from './chain-tail'
import type { ThreadRecord, ThreadStatus, ThreadStore } from '../store/thread-store'

/** The instant the chain begins — what the publish gate scopes its read to. */
const STARTED_AT = '2026-09-11T12:00:00.000Z'

interface Harness {
  chain: AutopilotChain
  /** Every message issued, in order. */
  sent: string[]
  /** Every publish verb called, in order. The recorded argv of this layer. */
  published: string[]
  /** Every gate consultation, with what it was scoped to. */
  gateCalls: Array<{ chainId: string; since: string }>
  ended: Array<{ threadId: string; success: boolean }>
  setStatus: (status: ThreadStatus) => void
}

function harness(
  options: {
    gate?: TailStep
    publish?: TailStep
    tail?: { commit: boolean; push: boolean; pr: boolean }
  } = {},
): Harness {
  const sent: string[] = []
  const published: string[] = []
  const gateCalls: Array<{ chainId: string; since: string }> = []
  const ended: Array<{ threadId: string; success: boolean }> = []
  let status: ThreadStatus = 'idle'
  const thread = {
    id: 'th1',
    projectRoot: '/repo',
    title: 'A conversation',
    get status() {
      return status
    },
  } as unknown as ThreadRecord
  const threadStore = {
    getThread: () => thread,
    setThreadChain: () => {},
  } as unknown as ThreadStore

  const chain = new AutopilotChain({
    threadStore,
    sendMessage: async (_threadId, content) => {
      sent.push(content)
    },
    readProjectSettings: async () => ({
      autopilot: true,
      tail: options.tail ?? { commit: true, push: true, pr: true },
    }),
    // The ladder's gate, answering yes — every case here is about something
    // else, and a gate that refused would stop the chain before it got there.
    checkStage: async () => ({ ok: true, detail: 'The step before this one left what it should have.' }),
    tail: {
      checkRisk: async ({ chainId, since }) => {
        gateCalls.push({ chainId, since })
        return options.gate ?? { ok: true, detail: 'This work may be published.' }
      },
      push: async () => {
        published.push('push')
        return options.publish ?? { ok: true, detail: 'The work is published.' }
      },
      openPullRequest: async () => {
        published.push('pr')
        return options.publish === undefined
          ? { ok: true, detail: 'Opened.', url: 'https://example.test/pr/9' }
          : options.publish
      },
    },
    onChange: () => {},
    onChainEnd: (threadId, success) => ended.push({ threadId, success }),
    mintChainId: () => 'chain-test',
    now: () => new Date(STARTED_AT),
  })

  return {
    chain,
    sent,
    published,
    gateCalls,
    ended,
    setStatus: (next) => {
      status = next
    },
  }
}

/** Let the driver's fire-and-forget pump settle. */
const settle = (): Promise<unknown> => new Promise((resolve) => setTimeout(resolve, 0))

/** Run the whole chain: four rungs, then the tail. */
async function runToTheEnd(h: Harness): Promise<void> {
  await h.chain.begin('th1', { aim: 'add a dark mode' })
  for (const _ of [1, 2, 3, 4]) {
    h.chain.onTurnComplete('th1', true)
    await settle()
  }
}

/** The sentence for a gate that refused because the work was rated high. */
const RATED_HIGH: TailStep = {
  ok: false,
  detail: 'This work was rated high risk, so it was not published — your say-so is needed.',
}

/** The sentence for a gate that refused because nothing rated the work. */
const NEVER_RATED: TailStep = {
  ok: false,
  detail: 'Nothing recorded how risky this work is, so it was not published.',
}

/** The sentence the publish verb produces for a branch nobody has bound. */
const UNBOUND: TailStep = {
  ok: false,
  detail: 'Nobody has said where this work should be published, so it was left alone.',
}

describe('pause one — a high-risk assessment before the publish', () => {
  it('stops the chain and leaves nothing on the remote', async () => {
    const h = harness({ gate: RATED_HIGH })
    await runToTheEnd(h)
    expect(h.published).toEqual([])
    expect(h.chain.status('th1')).toMatchObject({
      running: false,
      stoppedReason: CHAIN_NOT_PUBLISHED,
      prUrl: null,
    })
  })

  it('says why, in the words a person reads', async () => {
    const h = harness({ gate: RATED_HIGH })
    await runToTheEnd(h)
    expect(h.chain.status('th1').notPublished).toBe(RATED_HIGH.detail)
  })

  it('does not report the chain as a success — the board must not move it on', async () => {
    const h = harness({ gate: RATED_HIGH })
    await runToTheEnd(h)
    expect(h.ended).toEqual([{ threadId: 'th1', success: false }])
  })

  it('is consulted BEFORE the publish, and only once', async () => {
    const h = harness()
    await runToTheEnd(h)
    expect(h.gateCalls).toEqual([{ chainId: 'chain-test', since: STARTED_AT }])
    expect(h.published).toEqual(['pr'])
  })

  it('scopes its read to this chain — never to the whole record', async () => {
    const h = harness({ gate: RATED_HIGH })
    await runToTheEnd(h)
    expect(h.gateCalls[0].since).toBe(STARTED_AT)
    expect(h.gateCalls[0].chainId).toBe('chain-test')
  })

  it('never retries — a refused publish is not attempted again', async () => {
    const h = harness({ gate: RATED_HIGH })
    await runToTheEnd(h)
    const issued = h.sent.length
    h.chain.onTurnComplete('th1', true)
    await settle()
    expect(h.published).toEqual([])
    expect(h.gateCalls).toHaveLength(1)
    expect(h.sent).toHaveLength(issued)
  })

  it('a run nobody rated is withheld too, and says so in its own words', async () => {
    const h = harness({ gate: NEVER_RATED })
    await runToTheEnd(h)
    expect(h.published).toEqual([])
    expect(h.chain.status('th1').notPublished).toBe(NEVER_RATED.detail)
    expect(h.ended).toEqual([{ threadId: 'th1', success: false }])
  })

  it('a rated run publishes and finishes, which is the control for all of the above', async () => {
    const h = harness()
    await runToTheEnd(h)
    expect(h.published).toEqual(['pr'])
    expect(h.chain.status('th1')).toMatchObject({
      stoppedReason: CHAIN_FINISHED,
      notPublished: null,
      prUrl: 'https://example.test/pr/9',
    })
    expect(h.ended).toEqual([{ threadId: 'th1', success: true }])
  })

  it('is not consulted at all by a project that publishes nothing', async () => {
    const h = harness({ tail: { commit: true, push: false, pr: false } })
    await runToTheEnd(h)
    expect(h.gateCalls).toEqual([])
    expect(h.published).toEqual([])
  })
})

describe('pause two — the guard classifier asking', () => {
  // The classifier's `ask` reaches this layer as a QUESTION on the thread: the
  // run pauses and the thread's status becomes `needs-decision`. Nothing is
  // re-implemented here; what is asserted is that the driver holds.
  it('holds the chain — nothing more is issued while a person is being asked', async () => {
    const h = harness()
    await h.chain.begin('th1')
    expect(h.sent).toHaveLength(1)
    h.setStatus('needs-decision')
    h.chain.onTurnComplete('th1', true)
    await settle()
    expect(h.sent).toHaveLength(1)
    expect(h.chain.status('th1')).toMatchObject({ running: true, waitingOnYou: false })
  })

  it('never publishes while the question is open', async () => {
    const h = harness()
    await h.chain.begin('th1')
    h.setStatus('needs-decision')
    for (const _ of [1, 2, 3, 4]) {
      h.chain.onTurnComplete('th1', true)
      await settle()
    }
    expect(h.published).toEqual([])
    expect(h.gateCalls).toEqual([])
  })

  it('the answer resumes it — a hold is not a stop', async () => {
    const h = harness()
    await h.chain.begin('th1')
    h.setStatus('needs-decision')
    h.chain.onTurnComplete('th1', true)
    await settle()
    h.setStatus('idle')
    h.chain.onTurnComplete('th1', true)
    await settle()
    expect(h.sent).toHaveLength(2)
  })

  it('holds for a blocked thread on the same terms', async () => {
    const h = harness()
    await h.chain.begin('th1')
    h.setStatus('blocked')
    h.chain.onTurnComplete('th1', true)
    await settle()
    expect(h.sent).toHaveLength(1)
    expect(h.published).toEqual([])
  })
})

describe('pause three — a branch nobody has bound', () => {
  it('the refusal stands: the verb is called once and nothing else happens', async () => {
    const h = harness({ publish: UNBOUND })
    await runToTheEnd(h)
    expect(h.published).toEqual(['pr'])
    expect(h.chain.status('th1')).toMatchObject({
      running: false,
      stoppedReason: CHAIN_NOT_PUBLISHED,
      prUrl: null,
    })
  })

  it('is never guessed past — no second attempt, by any route', async () => {
    const h = harness({ publish: UNBOUND })
    await runToTheEnd(h)
    h.chain.onTurnComplete('th1', true)
    await settle()
    expect(h.published).toEqual(['pr'])
  })

  it('does not report the chain as a success', async () => {
    const h = harness({ publish: UNBOUND })
    await runToTheEnd(h)
    expect(h.ended).toEqual([{ threadId: 'th1', success: false }])
    expect(h.chain.status('th1').notPublished).toBe(UNBOUND.detail)
  })

  it('publishes through push, not the pull request, when the project only pushes', async () => {
    const h = harness({ publish: UNBOUND, tail: { commit: true, push: true, pr: false } })
    await runToTheEnd(h)
    expect(h.published).toEqual(['push'])
    expect(h.chain.status('th1').notPublished).toBe(UNBOUND.detail)
  })
})

describe('the four quality stops are pushed through', () => {
  // None of the four exists in code — they are steps of the `/execute-plan`
  // SKILL — so what this layer can be held to is that it introduces no stop of
  // its own for them: a rung whose turn ended terminally advances, whatever the
  // run was unsure about, and the chain reaches the publish gate.
  it('a terminal build turn advances to the review and on to the publish', async () => {
    const h = harness()
    await runToTheEnd(h)
    expect(h.sent.map((message) => message.split('\n')[0])).toEqual([
      '/discovery-plan add a dark mode',
      '/create-plan add a dark mode',
      '/execute-plan add a dark mode',
      '/review-code add a dark mode',
    ])
    expect(h.published).toEqual(['pr'])
  })

  it('nothing but the three pauses stops it — a clean run ends clean', async () => {
    const h = harness()
    await runToTheEnd(h)
    expect(h.chain.status('th1').stoppedReason).toBe(CHAIN_FINISHED)
  })
})

describe('no sentence a person reads names a command, a path or a config key', () => {
  it.each([
    ['rated high', RATED_HIGH],
    ['never rated', NEVER_RATED],
    ['unbound', UNBOUND],
  ])('%s', async (_name, step) => {
    const h = harness(_name === 'unbound' ? { publish: step } : { gate: step })
    await runToTheEnd(h)
    const status = h.chain.status('th1')
    for (const sentence of [status.notPublished, status.stoppedReason]) {
      if (sentence === null) continue
      expect(sentence).not.toMatch(/planflow-ai|flowconfig|\.rounds\.jsonl|`/)
    }
  })
})
