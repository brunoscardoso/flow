/**
 * #1443 — teardown must ask the renderer to persist and WAIT, instead of racing
 * its own disposal against the renderer's beforeunload.
 *
 * The property that matters is two-sided: the wait has to be real (a quit that
 * doesn't wait is the bug), and it has to be bounded (a wait that can hang is a
 * worse bug — the user pressed ⌘Q). Both are asserted here.
 */
import {
  FLUSH_TIMEOUT_MS,
  flushEditorContext,
  notifyEditorContextFlushed,
  type FlushTarget,
} from './editor-context-flush'

function windowThat(options: { destroyed?: boolean; throws?: boolean } = {}): {
  target: FlushTarget
  sent: string[]
} {
  const sent: string[] = []
  return {
    sent,
    target: {
      isDestroyed: () => options.destroyed === true,
      webContents: {
        send: (channel: string) => {
          if (options.throws === true) throw new Error('window went away')
          sent.push(channel)
        },
      },
    },
  }
}

/** Resolved-or-not without waiting on it — `Promise.race` against a sentinel. */
async function isSettled(promise: Promise<void>): Promise<boolean> {
  const pending = Symbol('pending')
  const result = await Promise.race([promise.then(() => 'done'), Promise.resolve(pending)])
  return result !== pending
}

describe('flushEditorContext (#1443)', () => {
  beforeEach(() => {
    jest.useFakeTimers()
  })
  afterEach(() => {
    jest.runOnlyPendingTimers()
    jest.useRealTimers()
    notifyEditorContextFlushed() // drop any waiter a failing test left behind
  })

  it('asks every live window to persist', () => {
    const a = windowThat()
    const b = windowThat()
    void flushEditorContext([a.target, b.target])
    expect(a.sent).toEqual(['project:flushEditorContext'])
    expect(b.sent).toEqual(['project:flushEditorContext'])
  })

  it('WAITS — it does not resolve before the renderer acks', async () => {
    const win = windowThat()
    const flushed = flushEditorContext([win.target])
    // The whole point: teardown is still blocked here. Before the fix, disposal
    // simply ran on, and the write landed on a torn-down receiver.
    expect(await isSettled(flushed)).toBe(false)

    notifyEditorContextFlushed()
    await expect(flushed).resolves.toBeUndefined()
  })

  it('gives up on its deadline — a wedged renderer never costs the user their quit', async () => {
    const win = windowThat()
    const flushed = flushEditorContext([win.target])
    expect(await isSettled(flushed)).toBe(false)

    jest.advanceTimersByTime(FLUSH_TIMEOUT_MS)
    await expect(flushed).resolves.toBeUndefined()
  })

  it('resolves immediately when no window can answer', async () => {
    await expect(flushEditorContext([])).resolves.toBeUndefined()
    await expect(flushEditorContext([windowThat({ destroyed: true }).target])).resolves.toBeUndefined()
  })

  it('survives a window that dies mid-request', async () => {
    const dying = windowThat({ throws: true })
    const healthy = windowThat()
    const flushed = flushEditorContext([dying.target, healthy.target])
    expect(healthy.sent).toEqual(['project:flushEditorContext'])
    notifyEditorContextFlushed()
    await expect(flushed).resolves.toBeUndefined()
  })

  it('ignores an ack nobody is waiting for', () => {
    expect(() => notifyEditorContextFlushed()).not.toThrow()
  })

  it('does not let a stale ack settle the NEXT flush', async () => {
    const first = flushEditorContext([windowThat().target])
    jest.advanceTimersByTime(FLUSH_TIMEOUT_MS)
    await first

    const second = flushEditorContext([windowThat().target])
    expect(await isSettled(second)).toBe(false)
    notifyEditorContextFlushed()
    await expect(second).resolves.toBeUndefined()
  })
})
