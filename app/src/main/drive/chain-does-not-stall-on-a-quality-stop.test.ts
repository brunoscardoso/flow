// THE MID-EXECUTE SEAM (#1915): a quality stop pushed through does NOT hold the
// chain, and a discovery question DOES.
//
// The chain holds on exactly one thing: a thread that is `needs-decision` or
// `blocked` — somebody being asked something. The three prose-only quality stops
// (wave file conflict, wave contract conflict, lint gate) are told, under an
// enforced run, to push through and RECORD rather than ask (see the execute-plan
// skill's "Enforced-run quality stops"). So a chained execute turn that met one
// of them ends CLEANLY — its status never becomes `needs-decision` — and the
// chain advances to the review, then the tail. This test pins that at the driver:
// a clean execute turn advances, and the positive control — a real question at
// discovery — holds (allowed-pattern #28: state the positive before the absence).
//
// It does not re-implement the skill's decision. It asserts the DRIVER'S
// behaviour given the two thread states the skill can leave behind — the same
// contract `honoured-pauses.test.ts` asserts for the three pauses that DO hold.

import { AutopilotChain } from './autopilot-chain'
import type { TailStep } from './chain-tail'
import type { ThreadRecord, ThreadStatus, ThreadStore } from '../store/thread-store'

const STARTED_AT = '2026-09-11T12:00:00.000Z'

interface Harness {
  chain: AutopilotChain
  /** Every message issued, in order — one per rung. */
  sent: string[]
  /** Every publish verb called, in order. */
  published: string[]
  ended: Array<{ threadId: string; success: boolean }>
  setStatus: (status: ThreadStatus) => void
}

function harness(): Harness {
  const sent: string[] = []
  const published: string[] = []
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
      tail: { commit: true, push: true, pr: true },
    }),
    // Every edge is clean here — the point is what happens WITHIN the execute
    // rung, not at the stage gate.
    checkStage: async () => ({ ok: true, detail: 'The step before this one left what it should have.' }),
    tail: {
      checkRisk: async (): Promise<TailStep> => ({ ok: true, detail: 'This work may be published.' }),
      push: async (): Promise<TailStep> => {
        published.push('push')
        return { ok: true, detail: 'The work is published.' }
      },
      openPullRequest: async (): Promise<TailStep> => {
        published.push('pr')
        return { ok: true, detail: 'Opened.', url: 'https://example.test/pr/9' }
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
    ended,
    setStatus: (next) => {
      status = next
    },
  }
}

const settle = (): Promise<unknown> => new Promise((resolve) => setTimeout(resolve, 0))

const issued = (sent: string[], command: string): boolean =>
  sent.some((message) => message.startsWith(command))

describe('the chain does not stall on a pushed-through quality stop', () => {
  it('POSITIVE CONTROL: a question at discovery holds the chain — the review is never reached', async () => {
    const h = harness()
    await h.chain.begin('th1', { aim: 'harness autopilot' })
    expect(h.sent).toHaveLength(1)
    expect(issued(h.sent, '/discovery-plan')).toBe(true)

    // The discovery agent asks the user something: the thread waits.
    h.setStatus('needs-decision')
    for (const _ of [1, 2, 3, 4]) {
      h.chain.onTurnComplete('th1', true)
      await settle()
    }

    // Held: nothing past discovery was issued, and nothing was published.
    expect(h.sent).toHaveLength(1)
    expect(issued(h.sent, '/review-code')).toBe(false)
    expect(h.published).toEqual([])
    expect(h.chain.status('th1')).toMatchObject({ running: true })
  })

  it('a clean execute turn (a quality stop pushed through, not asked) advances to the review and publishes', async () => {
    const h = harness()
    await h.chain.begin('th1', { aim: 'harness autopilot' })

    // Four clean turns — discovery, create-plan, execute-plan, review-code. The
    // execute turn met a quality stop and PUSHED IT THROUGH, so its status stays
    // idle and the turn ends successfully, exactly as a real enforced run leaves
    // it. The chain must not hold.
    for (const _ of [1, 2, 3, 4]) {
      h.chain.onTurnComplete('th1', true)
      await settle()
    }

    // The absence, now that the positive control proved a hold is reachable: the
    // chain crossed execute → review without stopping, and ran the tail.
    expect(issued(h.sent, '/execute-plan')).toBe(true)
    expect(issued(h.sent, '/review-code')).toBe(true)
    expect(h.published).toEqual(['pr'])
    expect(h.ended).toEqual([{ threadId: 'th1', success: true }])
  })

  it('the execute rung tells the model the tail is not its own — the chain owns it after the review', async () => {
    const h = harness()
    await h.chain.begin('th1', { aim: 'harness autopilot' })
    for (const _ of [1, 2]) {
      h.chain.onTurnComplete('th1', true)
      await settle()
    }
    const executeMessage = h.sent.find((message) => message.startsWith('/execute-plan'))
    expect(executeMessage).toBeDefined()
    expect(executeMessage).toContain('Do not commit, push or open a pull request')
  })
})
