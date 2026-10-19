/**
 * GETTING IT OFF THE MACHINE WITHOUT ANYONE NOTICING.
 *
 * Between the door and the network: a bounded queue, a timer, and a POST that
 * nobody waits for. The whole design follows from one sentence in the plan — a
 * lost event costs nothing — which is unusual enough to be worth saying plainly,
 * because almost every instinct a delivery mechanism trains you to have is wrong
 * here:
 *
 *   - NO RETRY STORM. A failed batch is dropped, not requeued. Retrying is how a
 *     dead endpoint turns into a loop that runs for the life of the process, and
 *     the thing being protected is a usage count.
 *   - NO GROWTH. A laptop offline for a fortnight must not accumulate a queue.
 *     The bound is on the queue, not on the outage.
 *   - NO NOISE. No dialog, no toast, and no log line per failure — a log spam
 *     loop is a user-visible symptom of a subsystem that promised to be
 *     invisible. One line the first time, then silence.
 *   - NOTHING BLOCKS. Enqueue is synchronous and does nothing but append; the
 *     send happens on a timer, off the path every window waits on
 *     (allowed-pattern #19).
 *
 * The bound itself reuses `SessionBuffer` — two hard ceilings, oldest-first
 * eviction, honest loss accounting — rather than growing a second
 * implementation of the same rule (allowed-pattern #14). Oldest-first is right
 * here for the same reason it is right there: when something has to go, the
 * stale thing goes.
 */

import { SessionBuffer } from '../../shared/session-buffer'
import type { TelemetryPayload } from './telemetry-boundary'

/**
 * How much unsent telemetry is worth holding.
 *
 * Small on purpose. These are counts and durations, a few hundred bytes each;
 * a queue that can hold two hundred of them covers any plausible outage a
 * running app survives, and anything longer is a laptop that was asleep, whose
 * week-old session counts nobody will miss.
 */
export const QUEUE_LIMITS = { maxRecords: 200, maxBytes: 256 * 1024 }

/** How often the queue is drained. Sparse, because none of this is urgent. */
export const FLUSH_INTERVAL_MS = 60_000

/** The most events in one request, so a burst cannot build an unbounded body. */
export const MAX_BATCH = 50

export interface TelemetrySenderDeps {
  /**
   * Where a batch goes. ABSENT MEANS THERE IS NOWHERE — the sender still
   * accepts and bounds events, and drops them at the point of sending.
   *
   * This is what a build with no configured endpoint does, and it is the
   * default: see `telemetry-endpoint.ts`.
   */
  post?: (batch: TelemetryPayload[]) => Promise<void>
  /** Injected so a test needs no timer. */
  setInterval?: (fn: () => void, ms: number) => { unref?: () => void }
  clearInterval?: (handle: unknown) => void
  /** Told ONCE when sending starts failing. Wired to a console line in dev. */
  onUnreachable?: () => void
}

export interface TelemetrySender {
  /** Take an event. Synchronous, bounded, and never throws. */
  enqueue(payload: TelemetryPayload): void
  /** Send what is queued. Safe to call at any time; never rejects. */
  flush(): Promise<void>
  /** Stop the timer. */
  stop(): void
  /** How many events are waiting — for tests and for nothing else. */
  pending(): number
}

export function createTelemetrySender(deps: TelemetrySenderDeps = {}): TelemetrySender {
  // Sized by the serialized event, which is what actually crosses the wire.
  const queue = new SessionBuffer<TelemetryPayload>(QUEUE_LIMITS, (payload) => {
    try {
      return JSON.stringify(payload).length
    } catch {
      // A payload that will not serialize cannot be sent either; give it a
      // nominal size so it is bounded like everything else rather than
      // counting as free.
      return 256
    }
  })

  let timer: { unref?: () => void } | null = null
  let sending = false
  let reportedUnreachable = false

  const start = deps.setInterval ?? ((fn, ms) => setInterval(fn, ms))
  const stopTimer = deps.clearInterval ?? ((handle) => clearInterval(handle as never))

  async function flush(): Promise<void> {
    // ONE FLIGHT AT A TIME. Without this a slow endpoint and a fast timer
    // overlap until the process runs out of sockets — the retry storm's quieter
    // cousin.
    if (sending) return
    const all = queue.records()
    if (all.length === 0) return

    const batch = all.slice(0, MAX_BATCH)
    // TAKEN OUT BEFORE THE ATTEMPT, never put back. A failed batch is gone,
    // which is the whole "a lost event costs nothing" bargain: the alternative
    // is a queue that only empties when the network is healthy, i.e. exactly
    // when it did not need to.
    queue.take(batch.length)

    if (deps.post === undefined) return

    sending = true
    try {
      await deps.post(batch)
      reportedUnreachable = false
    } catch {
      // ONCE, THEN SILENCE. A line per failed batch is log spam on a laptop
      // that is simply offline.
      if (!reportedUnreachable) {
        reportedUnreachable = true
        try {
          deps.onUnreachable?.()
        } catch {
          // Reporting a failure must not become one.
        }
      }
    } finally {
      sending = false
    }
  }

  timer = start(() => {
    void flush()
  }, FLUSH_INTERVAL_MS)
  // Never hold the process open for a usage count.
  timer?.unref?.()

  return {
    enqueue(payload: TelemetryPayload): void {
      try {
        queue.push(payload)
      } catch {
        // Bounded append cannot fail in practice; it must not be able to in
        // principle either, because its caller is a feature doing its job.
      }
    },
    flush,
    stop(): void {
      if (timer !== null) stopTimer(timer)
      timer = null
    },
    pending(): number {
      return queue.size
    },
  }
}
