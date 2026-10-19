// A STOP THAT LANDS WHILE A MESSAGE IS ON ITS WAY OUT.
//
// `pump` takes the conversation's claim BEFORE it dispatches, which is the
// whole point of the registry: the refusal has to happen before a word goes
// out. But a dispatch is not an instant — `AgentManager.sendMessage` resolves
// when the turn STARTS, not when it finishes — and a stop landing inside that
// window used to release the claim and delete the run. The message was already
// gone; nobody was watching the turn it started; and the conversation was
// advertised as free while its first turn was still streaming, so the next
// driver to ask for it got it and spoke into it too.
//
// So: the stop takes effect immediately in every way a person asked for — the
// run is gone, nothing more is ever issued — and the ONE thing it defers is
// handing the conversation to somebody else, until the send it cannot see the
// end of has come back.
//
// The window is held open by hand here. Let the dispatch resolve first and
// there is no window, and the test passes against the broken code.

import { AutopilotChain } from './autopilot-chain'
import { ThreadClaims, TurnDriver, ALREADY_DRIVEN, type DriveStep } from './turn-driver'
import type { ThreadRecord, ThreadStore } from '../store/thread-store'

/** A driver whose dispatch hangs until the test lets it go. */
function hangingDriver(
  name: string,
  claims: ThreadClaims,
  threadId: string,
): {
  driver: TurnDriver<string>
  sent: string[]
  /** Resolves once the dispatch has actually been entered. */
  sending: Promise<void>
  release: () => void
} {
  const sent: string[] = []
  let entered = (): void => {}
  let release = (): void => {}
  const sending = new Promise<void>((resolve) => {
    entered = resolve
  })
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  const driver = new TurnDriver<string>({
    name,
    claims,
    decide: (): DriveStep<string> => ({ kind: 'work', work: 'a' }),
    threadFor: () => threadId,
    dispatch: async (_key, work) => {
      sent.push(work)
      entered()
      await held
      return { threadId, detail: work }
    },
    onChange: () => {},
  })
  return { driver, sent, sending, release }
}

const settle = (): Promise<unknown> => new Promise((resolve) => setTimeout(resolve, 5))

describe('a run stopped while its dispatch is still in flight', () => {
  it('does not hand the conversation to another driver before its own message has gone out', async () => {
    const claims = new ThreadClaims()
    const first = hangingDriver('board-loop', claims, 'th1')
    void first.driver.start('run')
    await first.sending

    // A person presses stop while the message is on its way.
    first.driver.stop('run')

    // The stop is complete in every sense that matters to them…
    expect(first.driver.status('run')).toMatchObject({ running: false, stoppedReason: null })
    // …and the conversation is still spoken for, because something IS speaking
    // into it right now.
    expect(claims.ownerOf('th1')).toMatchObject({ driver: 'board-loop', key: 'run' })

    // So the next driver to want it is refused, before a word of its own.
    const second = hangingDriver('autopilot-chain', claims, 'th1')
    await second.driver.start('chain')
    expect(second.sent).toEqual([])
    expect(second.driver.status('chain')).toMatchObject({
      running: false,
      stoppedReason: ALREADY_DRIVEN,
    })

    // When the send finally comes back, the thread is free again — the deferral
    // is a window, not a hostage-taking.
    first.release()
    await settle()
    expect(claims.ownerOf('th1')).toBeNull()
  })

  it('frees the conversation even when the dispatch fails', async () => {
    const claims = new ThreadClaims()
    let entered = (): void => {}
    const sending = new Promise<void>((resolve) => {
      entered = resolve
    })
    let fail = (): void => {}
    const thrown = new Promise<never>((_resolve, reject) => {
      fail = () => reject(new Error('Could not open a chat.'))
    })
    const driver = new TurnDriver<string>({
      name: 'board-loop',
      claims,
      decide: (): DriveStep<string> => ({ kind: 'work', work: 'a' }),
      threadFor: () => 'th1',
      dispatch: async () => {
        entered()
        return thrown
      },
      onChange: () => {},
    })
    void driver.start('run')
    await sending

    driver.stop('run')
    expect(claims.ownerOf('th1')).toMatchObject({ driver: 'board-loop' })

    fail()
    await settle()
    // A send that never arrived leaves nothing behind either.
    expect(claims.ownerOf('th1')).toBeNull()
  })
})

describe('a chain ended mid-send', () => {
  it('keeps its conversation until the stage it was issuing has gone out', async () => {
    const claims = new ThreadClaims()
    let entered = (): void => {}
    const sending = new Promise<void>((resolve) => {
      entered = resolve
    })
    let release = (): void => {}
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const chain = new AutopilotChain({
      threadStore: {
        getThread: (id: string) =>
          ({ id, projectRoot: '/repo', title: 'A conversation', status: 'working' }) as ThreadRecord,
        setThreadChain: () => {},
      } as unknown as ThreadStore,
      claims,
      sendMessage: async () => {
        entered()
        await held
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
        push: async () => ({ ok: true, detail: 'The work is published.' }),
        openPullRequest: async () => ({ ok: true, detail: 'Opened.' }),
      },
      onChange: () => {},
    })

    void chain.begin('th1', { aim: 'do the thing' })
    await sending

    chain.end('th1')
    expect(chain.isRunning('th1')).toBe(false)
    expect(claims.ownerOf('th1')).toMatchObject({ driver: 'autopilot-chain', key: 'th1' })

    release()
    await settle()
    expect(claims.ownerOf('th1')).toBeNull()
  })
})
