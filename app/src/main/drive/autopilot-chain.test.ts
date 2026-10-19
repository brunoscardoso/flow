// AutopilotChain — the chain running, and (above all) the chain stopping.
//
// ASSERTED ON WHAT WAS SENT, never on what a transcript says happened. Each
// case below reads the messages the chain actually issued, which is the only
// evidence that the ORDER came from code rather than from a model choosing to
// follow an instruction.

import { AUTOPILOT_OFF, AutopilotChain, THREAD_GONE } from './autopilot-chain'
import { CHAIN_FINISHED, STEP_DID_NOT_FINISH } from './chain-model'
import { ThreadClaims } from './turn-driver'
import type { ThreadRecord, ThreadStatus, ThreadStore } from '../store/thread-store'

interface Harness {
  chain: AutopilotChain
  sent: string[]
  chainWrites: Array<{ chainId: string; stage: string | null } | null>
  published: string[]
  ended: Array<{ threadId: string; success: boolean }>
  /** Every publish gate consultation, in order — what it was scoped to. */
  gateCalls: Array<{ chainId: string; since: string }>
  setStatus: (status: ThreadStatus) => void
}

function harness(
  options: {
    autopilot?: boolean
    tail?: { commit: boolean; push: boolean; pr: boolean }
    claims?: ThreadClaims
    threadMissing?: boolean
    /** What the publish gate answers. Satisfied unless a case says otherwise. */
    gate?: { ok: boolean; detail: string }
    /** What the publish verbs answer. Satisfied unless a case says otherwise. */
    publish?: { ok: boolean; detail: string }
  } = {},
): Harness {
  const sent: string[] = []
  const chainWrites: Array<{ chainId: string; stage: string | null } | null> = []
  const published: string[] = []
  const ended: Array<{ threadId: string; success: boolean }> = []
  const gateCalls: Array<{ chainId: string; since: string }> = []
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
    getThread: () => (options.threadMissing === true ? null : thread),
    setThreadChain: (_id: string, value: { chainId: string; stage: string | null } | null) => {
      chainWrites.push(value)
    },
  } as unknown as ThreadStore
  const chain = new AutopilotChain({
    threadStore,
    claims: options.claims,
    sendMessage: async (_threadId, content) => {
      sent.push(content)
    },
    readProjectSettings: async () => ({
      autopilot: options.autopilot ?? true,
      tail: options.tail ?? { commit: false, push: false, pr: false },
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
    now: () => new Date('2026-09-11T12:00:00.000Z'),
  })
  return {
    chain,
    sent,
    chainWrites,
    published,
    ended,
    gateCalls,
    setStatus: (next) => {
      status = next
    },
  }
}

/** Let the driver's fire-and-forget pump settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

/** The first line of each issued message — the command that was actually run. */
const commands = (sent: string[]): string[] => sent.map((message) => message.split('\n')[0])

describe('AutopilotChain: the chain runs because code runs it', () => {
  it('issues the four steps in order, one per finished turn', async () => {
    const h = harness()
    await h.chain.begin('th1', { aim: 'add a dark mode' })
    expect(commands(h.sent)).toEqual(['/discovery-plan add a dark mode'])
    for (const _ of [1, 2, 3]) {
      h.chain.onTurnComplete('th1', true)
      await settle()
    }
    expect(commands(h.sent)).toEqual([
      '/discovery-plan add a dark mode',
      '/create-plan add a dark mode',
      '/execute-plan add a dark mode',
      '/review-code add a dark mode',
    ])
  })

  it('records the step on the thread as it goes, and clears it at the end', async () => {
    const h = harness()
    await h.chain.begin('th1')
    expect(h.chainWrites[0]).toEqual({ chainId: 'chain-test', stage: 'discovery' })
    for (const _ of [1, 2, 3, 4]) {
      h.chain.onTurnComplete('th1', true)
      await settle()
    }
    expect(h.chainWrites.at(-1)).toBeNull()
    expect(h.chain.status('th1')).toMatchObject({ running: false, stoppedReason: CHAIN_FINISHED })
  })

  it('publishes after the review when the project publishes, and reports the pull request', async () => {
    const h = harness({ tail: { commit: true, push: true, pr: true } })
    await h.chain.begin('th1')
    for (const _ of [1, 2, 3, 4]) {
      h.chain.onTurnComplete('th1', true)
      await settle()
    }
    expect(h.published).toEqual(['pr'])
  })

  it('publishes nothing for a project that publishes nothing', async () => {
    const h = harness()
    await h.chain.begin('th1')
    for (const _ of [1, 2, 3, 4]) {
      h.chain.onTurnComplete('th1', true)
      await settle()
    }
    expect(h.published).toEqual([])
  })

  it('tells the build step the chain owns the publish — so it does not push twice', async () => {
    const h = harness()
    await h.chain.begin('th1')
    h.chain.onTurnComplete('th1', true)
    await settle()
    h.chain.onTurnComplete('th1', true)
    await settle()
    const build = h.sent.find((message) => message.startsWith('/execute-plan'))
    expect(build).toContain('Do not commit, push or open a pull request')
  })
})

describe('AutopilotChain: it stops', () => {
  it('ending it issues nothing more and leaves the turn in flight alone', async () => {
    const h = harness()
    await h.chain.begin('th1')
    expect(h.sent).toHaveLength(1)
    h.chain.end('th1')
    // The turn that was already running still finishes. Nothing follows it.
    h.chain.onTurnComplete('th1', true)
    await settle()
    expect(h.sent).toHaveLength(1)
    expect(h.chain.status('th1')).toMatchObject({ running: false, stoppedReason: null })
  })

  it('a person ending it leaves no reason behind — their own gesture explains itself', async () => {
    const h = harness()
    await h.chain.begin('th1')
    expect(h.chain.end('th1').stoppedReason).toBeNull()
  })

  it('HOLDS on a question: a waiting thread is never re-issued to', async () => {
    const h = harness()
    await h.chain.begin('th1')
    h.setStatus('needs-decision')
    h.chain.onThreadStatus('th1', 'needs-decision')
    h.chain.onTurnComplete('th1', true)
    await settle()
    expect(h.sent).toHaveLength(1)
    expect(h.chain.status('th1')).toMatchObject({ running: true, waitingOnYou: true })
  })

  it('the person’s reply resumes it', async () => {
    const h = harness()
    await h.chain.begin('th1')
    h.setStatus('needs-decision')
    h.chain.onThreadStatus('th1', 'needs-decision')
    h.chain.onTurnComplete('th1', true)
    await settle()
    h.setStatus('idle')
    h.chain.onThreadStatus('th1', 'idle')
    // Their reply starts a turn; when THAT turn ends the chain moves on.
    h.chain.onTurnComplete('th1', true)
    await settle()
    expect(commands(h.sent)).toEqual(['/discovery-plan', '/create-plan'])
  })

  it('stops rather than building on a step that did not finish', async () => {
    const h = harness()
    await h.chain.begin('th1')
    h.chain.onTurnComplete('th1', false)
    await settle()
    expect(h.sent).toHaveLength(1)
    expect(h.chain.status('th1')).toMatchObject({
      running: false,
      stoppedReason: STEP_DID_NOT_FINISH,
    })
  })

  it('tells whoever was waiting that the chain ended, once', async () => {
    const h = harness()
    await h.chain.begin('th1')
    h.chain.onTurnComplete('th1', false)
    await settle()
    expect(h.ended).toEqual([{ threadId: 'th1', success: false }])
  })
})

describe('AutopilotChain: it refuses', () => {
  it('starts nothing for a project with autopilot switched off', async () => {
    const h = harness({ autopilot: false })
    const status = await h.chain.begin('th1')
    expect(h.sent).toEqual([])
    expect(status).toMatchObject({ running: false, stoppedReason: AUTOPILOT_OFF })
  })

  it('starts nothing on a conversation that is no longer here', async () => {
    const h = harness({ threadMissing: true })
    const status = await h.chain.begin('th1')
    expect(h.sent).toEqual([])
    expect(status.stoppedReason).toBe(THREAD_GONE)
  })

  it('starts nothing on a conversation something else is already working', async () => {
    const claims = new ThreadClaims()
    claims.claim('th1', { driver: 'board-loop', key: '/repo' })
    const h = harness({ claims })
    await h.chain.begin('th1')
    expect(h.sent).toEqual([])
    expect(h.chain.status('th1').running).toBe(false)
  })

  it('reading the status starts nothing', () => {
    const h = harness()
    expect(h.chain.status('th1')).toMatchObject({ running: false, step: null })
    expect(h.sent).toEqual([])
  })

  it('beginning twice does not double up', async () => {
    const h = harness()
    await h.chain.begin('th1')
    await h.chain.begin('th1')
    expect(h.sent).toHaveLength(1)
  })

  it('no sentence it reports names a command, a path or a config key', async () => {
    const off = harness({ autopilot: false })
    const status = await off.chain.begin('th1')
    expect(status.stoppedReason).not.toMatch(/planflow-ai|flowconfig|\/flow|`/)
    const failed = harness()
    await failed.chain.begin('th1')
    failed.chain.onTurnComplete('th1', false)
    await settle()
    expect(failed.chain.status('th1').stoppedReason).not.toMatch(/planflow-ai|flowconfig|`/)
  })
})

describe('AutopilotChain: a refusal survives being read again', () => {
  it('still says why, after the press that got the answer is long gone', async () => {
    const h = harness({ autopilot: false })
    await h.chain.begin('th1')
    // A surface repainting later must not find a control that did nothing for
    // no stated reason.
    expect(h.chain.status('th1').stoppedReason).toBe(AUTOPILOT_OFF)
  })

  it('a fresh attempt clears the old refusal rather than reporting it twice', async () => {
    const h = harness({ autopilot: false })
    await h.chain.begin('th1')
    expect(h.chain.status('th1').stoppedReason).toBe(AUTOPILOT_OFF)
    const allowed = harness()
    await allowed.chain.begin('th1')
    expect(allowed.chain.status('th1')).toMatchObject({ running: true, stoppedReason: null })
  })
})
