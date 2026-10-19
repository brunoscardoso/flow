// TWO STARTS, ONE CHAIN — and above all, one discovery.
//
// `begin()` guards on "is a chain already running here", then AWAITS the
// project's settings, then records the run unconditionally. Two calls that
// arrive together therefore both pass the guard, and the second one's run —
// a fresh `stage: null` — overwrites the first one's. Nothing goes wrong yet,
// because the driver refuses the second start. It goes wrong one turn later:
// the finished first stage is written onto the SECOND run, the model is asked
// what follows "nothing has been issued yet", and it answers with the first
// stage again — into a conversation that has already done it.
//
// The two doors that reach this: a double press of the chain control (the IPC
// verb is public and takes `run: true`), and the board's loop chaining a card's
// thread while somebody starts a chain by hand in the same conversation.
//
// The settings read is held open deliberately here. That await is the window;
// a test that let it resolve immediately would be testing a single-threaded
// sequence and would pass against the broken code.

import { AutopilotChain } from './autopilot-chain'
import type { ThreadRecord, ThreadStore } from '../store/thread-store'

function harness() {
  const sent: string[] = []
  /** Everyone waiting on the project's settings, released by hand. */
  const pending: Array<() => void> = []
  const threadStore = {
    getThread: (id: string) =>
      ({ id, projectRoot: '/repo', title: 'A conversation', status: 'working' }) as ThreadRecord,
    setThreadChain: () => {},
    markAsLoopRun: () => {},
  } as unknown as ThreadStore
  const chain = new AutopilotChain({
    threadStore,
    sendMessage: async (_threadId, content) => {
      sent.push(content)
    },
    readProjectSettings: async () =>
      new Promise((resolve) => {
        pending.push(() =>
          resolve({ autopilot: true, tail: { commit: false, push: false, pr: false } }),
        )
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
  })
  return {
    chain,
    sent,
    /** Let every settings read that is waiting finish, in the order it arrived. */
    releaseSettings: () => {
      for (const resolve of pending.splice(0)) resolve()
    },
  }
}

const settle = (): Promise<unknown> => new Promise((resolve) => setTimeout(resolve, 5))

/** The stage command each message opens with — what was actually issued. */
const commands = (sent: string[]): string[] => sent.map((message) => message.split(' ')[0]!)

describe('two begins racing on one conversation', () => {
  it('issues the first stage once, and moves on to the second when its turn ends', async () => {
    const h = harness()

    // Both calls reach the settings read before either has a run — the window.
    const first = h.chain.begin('th1', { aim: 'do the thing' })
    const second = h.chain.begin('th1', { aim: 'do the thing' })
    h.releaseSettings()
    await Promise.all([first, second])
    await settle()

    expect(commands(h.sent)).toEqual(['/discovery-plan'])

    // The turn that discovery started ends. What follows it is the NEXT stage —
    // not discovery a second time, written onto a run the race left blank.
    h.chain.onTurnComplete('th1', true)
    await settle()

    expect(commands(h.sent)).toEqual(['/discovery-plan', '/create-plan'])
  })

  it('the later call reports the live chain rather than starting a second one', async () => {
    const h = harness()

    const first = h.chain.begin('th1')
    const second = h.chain.begin('th1')
    h.releaseSettings()
    const [, later] = await Promise.all([first, second])
    await settle()

    expect(later).toMatchObject({ threadId: 'th1', running: true, step: 'Working out what is needed' })
    expect(h.chain.isRunning('th1')).toBe(true)
  })
})
