/**
 * WHAT A DEBUG SESSION RECORDS, as data — DOM-free, PTY-free, CDP-free.
 *
 * The session is a WINDOW: a start, a stop, and everything that happened
 * between them from several sources at once. These are the shapes that travel
 * between those sources and the merge, so the merge can be tested with plain
 * objects and no machinery at all.
 *
 * ONE CLOCK. Every record here carries `at`, epoch milliseconds on the host
 * clock. That is not a convention, it is a measured fact: the browser's CDP
 * timestamps were checked against `Date.now()` and agree to within 2 ms
 * (`e2e/ux/browser-capture-clock.spec.ts`), and terminal chunks are stamped in
 * main. Correlating them is therefore a sort, and it is only that simple
 * because both numbers mean the same thing.
 */

import type { BrowserCapture } from './browser-capture-types'

/** Why a session stopped. */
export type DebugSessionEnd =
  /** A person pressed Finish. */
  | 'finished'
  /**
   * It hit a limit and stopped itself.
   *
   * A SESSION LEFT RUNNING IS THE FAILURE MODE this exists for — somebody
   * presses Debug and goes to lunch. Stopping is the right answer; saying so in
   * the artifact is what stops the artifact from lying about its own window.
   */
  | 'capped'
  /** The window it belonged to went away. */
  | 'abandoned'

/** What a source gave up when it hit its ceiling. */
export interface DebugSourceLoss {
  /** Records dropped to stay inside the caps. */
  droppedRecords: number
  /** Bytes dropped with them. */
  droppedBytes: number
}

/**
 * One row of the timeline, whatever produced it.
 *
 * A DISCRIMINATED UNION RATHER THAN A BAG OF OPTIONAL FIELDS, so a reader
 * (and the compiler) can tell a click from a log line without asking which
 * fields happen to be set.
 */
export type DebugRecord =
  | { source: 'terminal'; at: number; terminalId: string; label: string; data: string }
  | { source: 'browser'; at: number; capture: BrowserCapture }
  | {
      source: 'interaction'
      at: number
      /** What was interacted with, in the reader's terms — never its text. */
      target: string
      kind: 'click' | 'navigate' | 'load'
      url?: string
    }

/** A terminal the session is listening to, as the artifact names it. */
export interface DebugTerminalRef {
  terminalId: string
  /** What a person calls it — the project it belongs to, usually. */
  label: string
  projectRoot: string | undefined
}

/**
 * Everything one session collected, ready to merge.
 *
 * The PRE-ROLL is deliberately separate from `records`. It comes from the
 * display scrollback, which carries no time (that is what Phase 2 was about),
 * so it cannot be placed on the timeline without inventing a position for it.
 * Inventing one would be the feature's worst failure — a plausible order that
 * is not the real one — so it is offered as context and never merged.
 */
export interface DebugSessionResult {
  id: string
  threadId: string | null
  startedAt: number
  endedAt: number
  end: DebugSessionEnd
  terminals: DebugTerminalRef[]
  records: DebugRecord[]
  /** Untimed output from before recording began, per terminal. */
  preRoll: { terminalId: string; label: string; text: string }[]
  /** What each source dropped, by source key. Empty means nothing was lost. */
  lost: Record<string, DebugSourceLoss>
  /**
   * True when the browser's own buffer had already evicted entries from inside
   * this window before the session read it.
   *
   * The browser's rolling buffer is capped at 500 entries and 4 MB per kind and
   * evicts oldest-first, independently of any session. A long or noisy session
   * can therefore lose its own early browser records — and an artifact that
   * does not say so is claiming a completeness it does not have.
   */
  browserEvicted: boolean
}

/** The size of one record, for the byte ceilings. */
export function recordBytes(record: DebugRecord): number {
  if (record.source === 'terminal') return record.data.length
  if (record.source === 'interaction') return record.target.length + (record.url?.length ?? 0)
  // A browser capture's cost is dominated by bodies and stack traces; JSON is
  // the honest measure and this runs once per record, not per byte.
  try {
    return JSON.stringify(record.capture).length
  } catch {
    return 0
  }
}

/** Ordered by when it happened — the whole point of the feature. */
export function byTime(a: DebugRecord, b: DebugRecord): number {
  return a.at - b.at
}
