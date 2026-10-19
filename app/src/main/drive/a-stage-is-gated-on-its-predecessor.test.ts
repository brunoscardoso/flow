// THE SEAM, ASSERTED ON THE ABSENCE OF A MESSAGE (#1915 C2).
//
// The refusal verb, its ladder and its 122 tests shipped with nothing calling
// them: no caller under `app/src/main`, no skill telling an agent to run it,
// and four command files describing the refusal in the passive as though
// something did. The chain advanced on `lastTurnSucceeded` alone, so a stage
// whose turn ended cleanly having written NOTHING carried it to the next rung.
//
// A LOUD REFUSAL THAT DISPATCHES ANYWAY IS THE BUG (allowed-pattern #24). So
// every case here reads `sent` — the messages the chain actually issued — and
// the refusal cases assert that nothing was added to it. A test that only
// checked `stoppedReason` would pass for a chain that stopped after talking.

import { AutopilotChain } from './autopilot-chain'
import { STAGE_UNCHECKED, edgeToProve, stageGateReason } from './stage-gate'
import type { StageGateInput, StageGateStep } from './stage-gate'
import type { ThreadRecord, ThreadStore } from '../store/thread-store'

interface Harness {
  chain: AutopilotChain
  sent: string[]
  gateCalls: StageGateInput[]
  ended: Array<{ threadId: string; success: boolean }>
}

function harness(
  gate: (input: StageGateInput) => Promise<StageGateStep> = async () => ({
    ok: true,
    detail: 'The step before this one left what it should have.',
  }),
): Harness {
  const sent: string[] = []
  const gateCalls: StageGateInput[] = []
  const ended: Array<{ threadId: string; success: boolean }> = []
  const threadStore = {
    getThread: (id: string) =>
      ({ id, projectRoot: '/repo', title: 'A conversation', status: 'idle' }) as ThreadRecord,
    setThreadChain: () => {},
  } as unknown as ThreadStore
  const chain = new AutopilotChain({
    threadStore,
    sendMessage: async (_threadId, content) => {
      sent.push(content)
    },
    readProjectSettings: async () => ({
      autopilot: true,
      tail: { commit: false, push: false, pr: false },
    }),
    checkStage: async (input) => {
      gateCalls.push(input)
      return gate(input)
    },
    tail: {
      checkRisk: async () => ({ ok: true, detail: 'This work may be published.' }),
      push: async () => ({ ok: true, detail: 'The work is published.' }),
      openPullRequest: async () => ({ ok: true, detail: 'Opened.' }),
    },
    onChange: () => {},
    onChainEnd: (threadId, success) => ended.push({ threadId, success }),
    mintChainId: () => 'chain-test',
  })
  return { chain, sent, gateCalls, ended }
}

/** Let the driver's fire-and-forget pump settle. */
const settle = (): Promise<unknown> => new Promise((resolve) => setTimeout(resolve, 0))

/** The command each issued message opens with — what was actually run. */
const commands = (sent: string[]): string[] => sent.map((message) => message.split('\n')[0])

describe('an edge is proved before the chain crosses it', () => {
  it('stops the chain and sends NOTHING when the gate refuses', async () => {
    const h = harness(async () => ({
      ok: false,
      detail: 'Working out what is needed left nothing behind, so planning the work was not started.',
    }))
    await h.chain.begin('th1', { aim: 'add a dark mode' })
    expect(commands(h.sent)).toEqual(['/discovery-plan add a dark mode'])

    // Discovery's turn ends cleanly — and leaves nothing behind.
    h.chain.onTurnComplete('th1', true)
    await settle()

    // THE ABSENCE IS THE ASSERTION: the second rung was never issued.
    expect(commands(h.sent)).toEqual(['/discovery-plan add a dark mode'])
    expect(h.chain.status('th1')).toMatchObject({
      running: false,
      stoppedReason:
        'Working out what is needed left nothing behind, so planning the work was not started.',
    })
  })

  it('tells whoever handed it the work that the run did not succeed', async () => {
    // The board's loop moves a card on when this says true, and the last turn
    // ended perfectly cleanly — so without this the card would go to Review on
    // the strength of a stage that produced nothing.
    const h = harness(async () => ({ ok: false, detail: 'Nothing was left behind.' }))
    await h.chain.begin('th1')
    h.chain.onTurnComplete('th1', true)
    await settle()
    expect(h.ended).toEqual([{ threadId: 'th1', success: false }])
  })

  it('issues the next stage exactly once when the gate allows', async () => {
    const h = harness()
    await h.chain.begin('th1', { aim: 'add a dark mode' })
    h.chain.onTurnComplete('th1', true)
    await settle()

    expect(commands(h.sent)).toEqual([
      '/discovery-plan add a dark mode',
      '/create-plan add a dark mode',
    ])
    expect(h.gateCalls).toHaveLength(1)
    expect(h.gateCalls[0]).toMatchObject({
      threadId: 'th1',
      chainId: 'chain-test',
      stage: 'create-plan',
      previous: 'discovery',
    })
  })

  it('asks about the subject the driver minted, under this run', async () => {
    const h = harness()
    await h.chain.begin('th1', { aim: 'Add a dark mode!' })
    h.chain.onTurnComplete('th1', true)
    await settle()
    // The same slug the message told the stage to write under — and it carries
    // the run, so last week's documents cannot answer for this chain.
    expect(h.gateCalls[0]?.feature).toBe('add-a-dark-mode-test')
    expect(h.sent[0]).toContain('discovery_add-a-dark-mode-test_v1.md')
  })

  it('does not gate the first rung — it has no predecessor', async () => {
    const h = harness(async () => ({ ok: false, detail: 'refused' }))
    await h.chain.begin('th1', { aim: 'add a dark mode' })
    // A gate that refused everything would have stopped this chain at the
    // bottom of the ladder; `discovery` is never asked about.
    expect(commands(h.sent)).toEqual(['/discovery-plan add a dark mode'])
    expect(h.gateCalls).toEqual([])
    expect(h.chain.status('th1')).toMatchObject({ running: true })
  })

  it('gates every edge it steps across, and only the edges', async () => {
    const h = harness()
    await h.chain.begin('th1')
    for (const _ of [1, 2, 3]) {
      h.chain.onTurnComplete('th1', true)
      await settle()
    }
    expect(h.gateCalls.map((call) => `${call.previous}→${call.stage}`)).toEqual([
      'discovery→create-plan',
      'create-plan→execute-plan',
      'execute-plan→review-code',
    ])
  })

  it('fails CLOSED when the gate cannot be asked at all', async () => {
    // A gate that opens when it cannot tell is not a gate, and "it could not
    // check, so it carried on" is the defect being fixed with an apology on it.
    // The failure is logged for a developer; the noise is not this suite's.
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
    const h = harness(async () => {
      throw new Error('the bundled CLI is not there')
    })
    await h.chain.begin('th1')
    h.chain.onTurnComplete('th1', true)
    await settle()

    expect(commands(h.sent)).toEqual(['/discovery-plan'])
    expect(h.chain.status('th1')).toMatchObject({
      running: false,
      stoppedReason: STAGE_UNCHECKED,
    })
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})

describe('what the chain says about a refused rung', () => {
  it('is a sentence, with no command, path or config key in it', () => {
    // forbidden-pattern #12 — the verb's payload names the document, the
    // directory and the module that read it; none of that may reach a surface.
    const sentences = [
      stageGateReason('predecessor-missing', { stage: 'create-plan', previous: 'discovery' }),
      stageGateReason('predecessor-unreadable', { stage: 'execute-plan', previous: 'create-plan' }),
      stageGateReason(null, { stage: 'review-code', previous: 'execute-plan' }),
    ]
    for (const sentence of sentences) {
      expect(sentence).not.toMatch(/planflow-ai|flow\/|\.md|--check|`/)
      expect(sentence).toMatch(/\.$/)
    }
  })

  it('names the two steps in the words a person already sees', () => {
    expect(stageGateReason('predecessor-missing', { stage: 'create-plan', previous: 'discovery' })).toBe(
      'Working out what is needed left nothing behind, so planning the work was not started.',
    )
  })
})

describe('edgeToProve: which edges are the chain’s to judge', () => {
  it('is null before anything has been issued', () => {
    expect(edgeToProve(null, 'discovery')).toBeNull()
    // Including a run started part-way up the ladder: this chain did not run
    // that predecessor and did not name its document, so refusing on it would
    // be refusing on a guess.
    expect(edgeToProve(null, 'execute-plan')).toBeNull()
  })

  it('is the rung below, for every step the chain actually takes', () => {
    expect(edgeToProve('discovery', 'create-plan')).toBe('discovery')
    expect(edgeToProve('create-plan', 'execute-plan')).toBe('create-plan')
    expect(edgeToProve('execute-plan', 'review-code')).toBe('execute-plan')
  })

  it('is null for a re-issue or a jump — neither is an edge', () => {
    expect(edgeToProve('discovery', 'discovery')).toBeNull()
    expect(edgeToProve('discovery', 'review-code')).toBeNull()
  })
})
