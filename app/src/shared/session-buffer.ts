/**
 * A BOUNDED RECORD OF ONE SOURCE — and an honest account of what it dropped.
 *
 * `rolling-buffer.ts` already solves this for the browser, and this is the same
 * idea for a debug session's several sources. What is different is the second
 * half: a session's artifact is read by someone deciding what happened, so a
 * buffer that silently forgot the first thirty seconds is worse than one that
 * says it did.
 *
 * TWO CEILINGS, BOTH HARD. Records alone do not bound memory — one 4 MB
 * response body is not one 40-byte log line — and bytes alone let a flood of
 * tiny records cost more in overhead than content. `rolling-buffer.ts` reached
 * the same conclusion; this states it in one place for every source.
 *
 * OLDEST FIRST, because a session is a reproduction: the end is the failure and
 * the beginning is setup. When something has to go, the setup goes.
 *
 * Pure and DOM-free — no clock, no IO, no knowledge of what it holds.
 */

import type { DebugSourceLoss } from './debug-session-types'

export interface SessionBufferLimits {
  /** Hard ceiling on retained records. */
  maxRecords: number
  /** Hard ceiling on retained bytes, by whatever measure the caller supplies. */
  maxBytes: number
}

/**
 * One source's slice of a session.
 *
 * Generic over the record so the terminal, browser and interaction sources
 * share one implementation and one set of tests — the alternative is three
 * buffers that agree until the day one of them is edited.
 */
export class SessionBuffer<T> {
  readonly #limits: SessionBufferLimits
  readonly #sizeOf: (record: T) => number
  #records: T[] = []
  #bytes = 0
  #droppedRecords = 0
  #droppedBytes = 0

  constructor(limits: SessionBufferLimits, sizeOf: (record: T) => number) {
    this.#limits = limits
    this.#sizeOf = sizeOf
  }

  /**
   * Take one record, evicting from the front until both ceilings hold.
   *
   * A RECORD LARGER THAN THE WHOLE CEILING is still taken, and then it is the
   * only thing in the buffer. Refusing it would silently drop precisely the
   * biggest response body — which on a debugging surface is usually the one
   * somebody wanted.
   */
  push(record: T): void {
    const size = Math.max(0, this.#sizeOf(record))
    this.#records.push(record)
    this.#bytes += size
    while (
      this.#records.length > 1 &&
      (this.#records.length > this.#limits.maxRecords || this.#bytes > this.#limits.maxBytes)
    ) {
      const evicted = this.#records.shift()
      if (evicted === undefined) break
      const evictedSize = Math.max(0, this.#sizeOf(evicted))
      this.#bytes -= evictedSize
      this.#droppedRecords += 1
      this.#droppedBytes += evictedSize
    }
  }

  /** What it is holding, oldest first. A copy — callers sort and merge. */
  records(): T[] {
    return [...this.#records]
  }

  /**
   * Remove the oldest `count` records and return them.
   *
   * TAKING IS NOT LOSING. A record handed to a caller that asked for it was
   * delivered, so this does NOT touch the drop counters — `loss()` must keep
   * meaning "the ceilings evicted this", which is the only thing a reader of a
   * debug artifact can act on. A drain that inflated the loss figure would make
   * every healthy queue look like a lossy one.
   *
   * Added for the telemetry queue, which needs the same two ceilings and the
   * same oldest-first rule as a recording but empties as it goes. The debug
   * sources never call it.
   */
  take(count: number): T[] {
    const taken = this.#records.splice(0, Math.max(0, count))
    for (const record of taken) this.#bytes -= Math.max(0, this.#sizeOf(record))
    // Floating drift is impossible here (integers), but a negative byte count
    // would be a lie about the buffer's state either way.
    if (this.#bytes < 0) this.#bytes = 0
    return taken
  }

  /** How many it holds now. */
  get size(): number {
    return this.#records.length
  }

  /** How many bytes it holds now. */
  get bytes(): number {
    return this.#bytes
  }

  /**
   * What was lost, or null when nothing was.
   *
   * NULL RATHER THAN ZEROES, so a caller writing the artifact can say nothing
   * at all about a source that lost nothing — instead of printing a reassuring
   * "0 dropped" line on every one of them.
   */
  loss(): DebugSourceLoss | null {
    if (this.#droppedRecords === 0) return null
    return { droppedRecords: this.#droppedRecords, droppedBytes: this.#droppedBytes }
  }
}
