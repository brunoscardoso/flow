/**
 * THE DEBUG SESSION — a window in time, not a lifetime.
 *
 * An engineer presses Debug, reproduces the bug, presses Finish. Everything
 * between those two presses is collected from several sources at once and
 * merged onto one clock, so "what did the server print in the 400 ms after I
 * clicked Save" becomes a question the artifact can answer.
 *
 * WHY A WINDOW IS DIFFERENT FROM WHAT EXISTS. `attachCdpCapture()`/`detach()`
 * is an ATTACHMENT lifetime — it runs for as long as the browser tab does.
 * `PtySession` is a PROCESS lifetime. Neither has a start a person chose, and
 * neither can say "between these two moments", which is the only thing a
 * reproduction is.
 *
 * COSTS NOTHING WHEN NOBODY IS RECORDING. The terminal side subscribes through
 * `observeOutput`, whose empty-observer cost is one `size === 0` check
 * (measured: 68 ns/chunk at rest, 104 ns recording). Nothing here subscribes
 * until `start`, and everything unsubscribes on `stop`.
 *
 * ONE SESSION AT A TIME. Two overlapping windows would produce two artifacts
 * that each claim to be "the reproduction", and nothing could say which press
 * belonged to which.
 */

import { randomUUID } from 'node:crypto'
import type {
  DebugRecord,
  DebugSessionEnd,
  DebugSessionResult,
  DebugSourceLoss,
  DebugTerminalRef,
} from '../../shared/debug-session-types'
import { byTime, recordBytes } from '../../shared/debug-session-types'
import { SessionBuffer } from '../../shared/session-buffer'
import type { BrowserCapture } from '../../shared/browser-capture-types'
import type { StampedTerminalChunk } from '../../shared/terminal-stamp'

/**
 * The ceilings.
 *
 * Sized from what they protect rather than from a round number: the browser's
 * own buffer is 500 entries / 4 MB per kind (`rolling-buffer.ts`), and a
 * session that outlived it would be recording into a hole. Terminals are the
 * loud source — a build prints tens of thousands of lines — so records are
 * generous and bytes are the real ceiling.
 */
export interface DebugSessionLimits {
  terminal: { maxRecords: number; maxBytes: number }
  interaction: { maxRecords: number; maxBytes: number }
  /** Longest a session may run before it stops itself. */
  maxDurationMs: number
}

export const DEFAULT_DEBUG_LIMITS: DebugSessionLimits = {
  terminal: { maxRecords: 20_000, maxBytes: 8 * 1024 * 1024 },
  interaction: { maxRecords: 2_000, maxBytes: 512 * 1024 },
  // FIFTEEN MINUTES. Long enough for any reproduction somebody is actually
  // performing, short enough that a session forgotten before lunch is bounded.
  maxDurationMs: 15 * 60_000,
}

/** How many lines of untimed pre-roll each terminal contributes. */
export const PRE_ROLL_LINES = 40

export interface DebugSessionDeps {
  /**
   * Watch every terminal's output, stamped. Returns its own removal.
   *
   * REQUIRED, not optional: a session built without it would record the browser
   * and silently claim to be recording the terminals too (allowed-pattern #26).
   */
  observeTerminalOutput(observer: (chunk: StampedTerminalChunk) => void): () => void
  /** The terminals this session should name, in the thread's scope. */
  terminalsInScope(threadId: string | null): DebugTerminalRef[]
  /** The tail of a terminal's display scrollback, for the pre-roll. */
  scrollbackTail(terminalId: string, lines: number): string
  /**
   * Every browser capture the buffer still holds, newest last.
   *
   * READ AT STOP rather than subscribed: the browser already retains its own
   * window and re-implementing that here would be a second buffer to keep in
   * step. The cost is eviction — see `browserEvicted` on the result.
   */
  browserCaptures(): BrowserCapture[]
  /** Epoch ms. Injected so a test does not have to sleep. */
  now(): number
}

/** What a live session will tell you about itself. */
export interface DebugSessionStatus {
  id: string
  threadId: string | null
  startedAt: number
  terminals: DebugTerminalRef[]
  records: number
}

export class DebugSessionRecorder {
  readonly #deps: DebugSessionDeps
  readonly #limits: DebugSessionLimits
  #live: {
    id: string
    threadId: string | null
    startedAt: number
    terminals: DebugTerminalRef[]
    terminalBuf: SessionBuffer<DebugRecord>
    interactionBuf: SessionBuffer<DebugRecord>
    unsubscribe: () => void
  } | null = null

  constructor(deps: DebugSessionDeps, limits: DebugSessionLimits = DEFAULT_DEBUG_LIMITS) {
    this.#deps = deps
    this.#limits = limits
  }

  /** Whether a window is open right now. */
  get recording(): boolean {
    return this.#live !== null
  }

  /** What the live session is, or null. */
  status(): DebugSessionStatus | null {
    const live = this.#live
    if (live === null) return null
    return {
      id: live.id,
      threadId: live.threadId,
      startedAt: live.startedAt,
      terminals: live.terminals,
      records: live.terminalBuf.size + live.interactionBuf.size,
    }
  }

  /**
   * Open the window.
   *
   * STARTING TWICE IS NOT TWO SESSIONS. The second press returns the live one
   * untouched rather than replacing it — silently discarding a reproduction
   * somebody is halfway through is the one outcome worse than refusing.
   */
  start(threadId: string | null): DebugSessionStatus {
    const existing = this.status()
    if (existing !== null) return existing

    const terminals = this.#deps.terminalsInScope(threadId)
    const terminalBuf = new SessionBuffer<DebugRecord>(this.#limits.terminal, recordBytes)
    const interactionBuf = new SessionBuffer<DebugRecord>(this.#limits.interaction, recordBytes)
    const labels = new Map(terminals.map((t) => [t.terminalId, t.label]))

    const unsubscribe = this.#deps.observeTerminalOutput((chunk) => {
      const live = this.#live
      if (live === null) return
      // OUT OF SCOPE IS NOT RECORDED. A window may hold terminals belonging to
      // projects this conversation has nothing to do with, and an artifact that
      // swept them in would be reporting somebody else's build.
      const label = labels.get(chunk.terminalId)
      if (label === undefined) return
      live.terminalBuf.push({
        source: 'terminal',
        at: chunk.at,
        terminalId: chunk.terminalId,
        label,
        data: chunk.data,
      })
    })

    this.#live = {
      id: `dbg-${randomUUID()}`,
      threadId,
      startedAt: this.#deps.now(),
      terminals,
      terminalBuf,
      interactionBuf,
      unsubscribe,
    }
    return this.status() as DebugSessionStatus
  }

  /**
   * Record something the person did in the page.
   *
   * Dropped when no session is live — an interaction outside the window is not
   * part of the reproduction, and taking it would put a record before
   * `startedAt` on a timeline that claims to be the window.
   */
  interaction(record: Extract<DebugRecord, { source: 'interaction' }>): void {
    this.#live?.interactionBuf.push(record)
  }

  /**
   * Whether the window has outlived its ceiling.
   *
   * ASKED, NOT TIMED. A timer in main is a thing to leak and a thing to test
   * with fake clocks; the caller already has reasons to look at the session
   * (a status paint, an incoming chunk), and this is the same answer without
   * anything scheduled.
   */
  expired(): boolean {
    const live = this.#live
    if (live === null) return false
    return this.#deps.now() - live.startedAt >= this.#limits.maxDurationMs
  }

  /**
   * Close the window and hand back everything it holds.
   *
   * Null when nothing was recording — there is no empty artifact to write, and
   * a caller that pressed Finish twice should get silence rather than a second
   * file describing nothing.
   */
  stop(end: DebugSessionEnd = 'finished'): DebugSessionResult | null {
    const live = this.#live
    if (live === null) return null
    live.unsubscribe()
    this.#live = null
    const endedAt = this.#deps.now()

    // THE BROWSER'S WINDOW, CUT FROM ITS OWN BUFFER. Its entries already carry
    // `ts` on this same clock, so the window is a filter rather than a
    // subscription.
    const all = this.#deps.browserCaptures()
    const inWindow = all.filter((capture) => {
      const ts = tsOf(capture)
      return ts !== null && ts >= live.startedAt && ts <= endedAt
    })
    // Its buffer evicts oldest-first, independently of any session. If the
    // OLDEST thing it still holds began after we did, it dropped something of
    // ours — and an artifact that does not say so claims a completeness it does
    // not have.
    const oldest = all.map(tsOf).filter((ts): ts is number => ts !== null).sort((a, b) => a - b)[0]
    const browserEvicted = all.length > 0 && oldest !== undefined && oldest > live.startedAt

    const records: DebugRecord[] = [
      ...live.terminalBuf.records(),
      ...live.interactionBuf.records(),
      ...inWindow.map((capture): DebugRecord => ({
        source: 'browser',
        at: tsOf(capture) ?? live.startedAt,
        capture,
      })),
    ].sort(byTime)

    const lost: Record<string, DebugSourceLoss> = {}
    const terminalLoss = live.terminalBuf.loss()
    if (terminalLoss !== null) lost['terminal'] = terminalLoss
    const interactionLoss = live.interactionBuf.loss()
    if (interactionLoss !== null) lost['interaction'] = interactionLoss

    return {
      id: live.id,
      threadId: live.threadId,
      startedAt: live.startedAt,
      endedAt,
      end,
      terminals: live.terminals,
      records,
      // UNTIMED, AND THEREFORE NOT ON THE TIMELINE. The display scrollback
      // carries no clock, so placing it would mean inventing a position — a
      // plausible order that is not the real one, which is this feature's worst
      // possible failure.
      preRoll: live.terminals.map((terminal) => ({
        terminalId: terminal.terminalId,
        label: terminal.label,
        text: this.#deps.scrollbackTail(terminal.terminalId, PRE_ROLL_LINES),
      })),
      lost,
      browserEvicted,
    }
  }
}

/** A capture's own timestamp, or null for the one payload that has none. */
function tsOf(capture: BrowserCapture): number | null {
  const payload = capture.payload as { ts?: unknown }
  return typeof payload.ts === 'number' && Number.isFinite(payload.ts) ? payload.ts : null
}
