/**
 * READY CHECKS for a Run step — "a port answers" and "a line appears".
 *
 * Both are bounded and cancellable, and both cost nothing once they settle
 * (allowed-patterns #17, #19):
 *   - the port probe is an async connect on an interval, stopped the moment
 *     it answers, times out or is cancelled — never a busy loop, never sync;
 *   - the line matcher registers an output observer for ONE terminal only
 *     while it waits, and removes it on match, time-out or cancel. The
 *     terminal manager's observer path costs nothing when no one watches, so
 *     a Run that is not waiting adds no work per output chunk.
 *
 * Everything that touches the world (connect, the timer, the observer) is
 * injected so the tests use fakes only.
 */
import type { StampedTerminalChunk, TerminalOutputObserver } from '../../shared/terminal-stamp'

export type ReadyOutcome = 'ready' | 'timed-out' | 'cancelled'

export interface ReadyWait {
  readonly result: Promise<ReadyOutcome>
  cancel(): void
}

export interface ReadyClock {
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

export const realClock: ReadyClock = {
  setTimeout: (fn, ms) => {
    const handle = setTimeout(fn, ms)
    handle.unref?.()
    return handle
  },
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

/** True when something on this machine accepts a connection on the port. */
export type PortConnect = (port: number) => Promise<boolean>

export const DEFAULT_PORT_INTERVAL_MS = 500

/** A settle-once wait: the first of ready / timed-out / cancelled wins and runs `cleanup`. */
function settleOnce(cleanup: () => void): { result: Promise<ReadyOutcome>; settle: (outcome: ReadyOutcome) => void; settled: () => boolean } {
  let done = false
  let resolve: (outcome: ReadyOutcome) => void = () => undefined
  const result = new Promise<ReadyOutcome>((r) => {
    resolve = r
  })
  return {
    result,
    settled: () => done,
    settle: (outcome) => {
      if (done) return
      done = true
      cleanup()
      resolve(outcome)
    },
  }
}

/**
 * Wait until `connect(port)` answers true, probing every `intervalMs`, for at
 * most `timeoutMs`. One probe is in flight at a time.
 */
export function waitForPort(
  port: number,
  options: { timeoutMs: number; intervalMs?: number; connect: PortConnect; clock?: ReadyClock },
): ReadyWait {
  const clock = options.clock ?? realClock
  const interval = options.intervalMs ?? DEFAULT_PORT_INTERVAL_MS
  let probeTimer: unknown = null
  let limitTimer: unknown = null
  const wait = settleOnce(() => {
    if (probeTimer !== null) clock.clearTimeout(probeTimer)
    if (limitTimer !== null) clock.clearTimeout(limitTimer)
    probeTimer = null
    limitTimer = null
  })

  const probe = (): void => {
    probeTimer = null
    if (wait.settled()) return
    options.connect(port).then(
      (answered) => {
        if (wait.settled()) return
        if (answered) wait.settle('ready')
        else probeTimer = clock.setTimeout(probe, interval)
      },
      () => {
        if (!wait.settled()) probeTimer = clock.setTimeout(probe, interval)
      },
    )
  }

  limitTimer = clock.setTimeout(() => wait.settle('timed-out'), options.timeoutMs)
  probe()
  return { result: wait.result, cancel: () => wait.settle('cancelled') }
}

/**
 * Wait until a port STOPS answering (the previous process let go of it), for
 * at most `timeoutMs`. Resolves true when it is free.
 */
export function waitForPortFree(
  port: number,
  options: { timeoutMs: number; intervalMs?: number; connect: PortConnect; clock?: ReadyClock },
): Promise<boolean> {
  const inverted: PortConnect = async (p) => !(await options.connect(p))
  return waitForPort(port, { ...options, connect: inverted }).result.then((outcome) => outcome === 'ready')
}

/** ANSI CSI/OSC sequences and carriage returns out — a ready line is matched on plain text. */
export function stripAnsi(text: string): string {
  return (
    text
      // eslint-disable-next-line no-control-regex
      .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
      // eslint-disable-next-line no-control-regex
      .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
      .replace(/\r/g, '')
  )
}

export type ObserveOutput = (observer: TerminalOutputObserver) => () => void

/**
 * Wait until `text` appears in one terminal's output (case-insensitive, ANSI
 * stripped, matched across chunk boundaries). The observer is registered only
 * for the life of the wait.
 */
export function waitForLine(
  terminalId: string,
  text: string,
  options: { timeoutMs: number; observe: ObserveOutput; clock?: ReadyClock },
): ReadyWait {
  const clock = options.clock ?? realClock
  const needle = text.toLowerCase()
  const keep = Math.max(0, needle.length - 1)
  let tail = ''
  let unobserve: (() => void) | null = null
  let limitTimer: unknown = null
  const wait = settleOnce(() => {
    unobserve?.()
    unobserve = null
    if (limitTimer !== null) clock.clearTimeout(limitTimer)
    limitTimer = null
  })

  unobserve = options.observe((chunk: StampedTerminalChunk) => {
    if (chunk.terminalId !== terminalId || wait.settled()) return
    const window = tail + stripAnsi(chunk.data).toLowerCase()
    if (window.includes(needle)) {
      wait.settle('ready')
      return
    }
    tail = keep === 0 ? '' : window.slice(-keep)
  })
  limitTimer = clock.setTimeout(() => wait.settle('timed-out'), options.timeoutMs)
  return { result: wait.result, cancel: () => wait.settle('cancelled') }
}

/**
 * The real connect: does anything accept on localhost — IPv4 or IPv6 (a dev
 * server reached as `localhost` may listen on either)? Each attempt is bounded.
 */
export function createTcpConnect(attemptTimeoutMs = 400): PortConnect {
  const attempt = async (host: string, port: number): Promise<boolean> => {
    const net = await import('node:net')
    return new Promise<boolean>((resolve) => {
      const socket = net.connect({ host, port })
      let settled = false
      const finish = (answered: boolean): void => {
        if (settled) return
        settled = true
        socket.destroy()
        resolve(answered)
      }
      socket.setTimeout(attemptTimeoutMs, () => finish(false))
      socket.once('connect', () => finish(true))
      socket.once('error', () => finish(false))
    })
  }
  return async (port) => (await attempt('127.0.0.1', port)) || (await attempt('::1', port))
}
