/**
 * ForeignRefreshScheduler (#1931) — when a pane re-reads its transcript after
 * somebody ELSE wrote to the open thread.
 *
 * A promoted sub-agent child's rows are written by the PARENT's streaming
 * session, so the pane bound to the child never sees them on its own stream —
 * `threads:updated` is their only way in. Two failure modes live here, both
 * found on the child pane while the parent streamed (#1931 follow-up):
 *
 *  1. STARVATION — the refetch was a plain sliding debounce: every touched
 *     batch reset the timer, and main's broadcast batcher flushes every
 *     50–250ms while a session streams, so a child receiving steady writes
 *     never refreshed at all ("while it's streaming I lose the messages on the
 *     child thread"). Same missing bound main's own `makeEventBatch` names:
 *     the debounce gets a MAX-WAIT ceiling — quiet for `debounceMs`, or at
 *     most `maxWaitMs` since the first deferred write, whichever comes first.
 *
 *  2. PERMANENT DROP — a busy/streaming pane dropped foreign refreshes on the
 *     assumption "the turn's own reconcile re-reads". True for the main chat;
 *     for a CHILD pane the parent's turn-done reconcile never fires, so the
 *     drop was forever. Busy panes now DEFER (`pending`) and the deferral is
 *     consumed when a history load settles or the stream ends — a live turn
 *     still never refetches mid-stream, which is the storm half of the bound.
 *
 * Extracted from the pane so the decision is a pure, clock-injected unit the
 * suite can drive without DOM or sleeping (the repo's `*-model` pattern).
 */

/** Quiet window before a foreign write triggers a refetch. */
export const FOREIGN_REFRESH_DEBOUNCE_MS = 300

/**
 * The longest a refetch may be postponed while touched batches keep arriving.
 * Must exceed the debounce (or the debounce never applies) and stay small
 * enough that a child pane under continuous sub-agent writes still reads live.
 */
export const FOREIGN_REFRESH_MAX_WAIT_MS = 1000

export interface ForeignRefreshHost {
  /** A turn is live on this pane (busy or streaming) — refetching now would
   *  race the live feed; the deferral is consumed when the turn settles. */
  busy(): boolean
  /** A history load is in flight — its fetch may predate the write. */
  loading(): boolean
  /** Run the refetch now. The host re-checks its own thread identity. */
  refresh(): void
}

interface SchedulerTiming {
  debounceMs: number
  maxWaitMs: number
  now: () => number
  schedule: (run: () => void, ms: number) => ReturnType<typeof setTimeout>
  cancel: (timer: ReturnType<typeof setTimeout>) => void
}

const DEFAULT_TIMING: SchedulerTiming = {
  debounceMs: FOREIGN_REFRESH_DEBOUNCE_MS,
  maxWaitMs: FOREIGN_REFRESH_MAX_WAIT_MS,
  now: () => Date.now(),
  schedule: (run, ms) => setTimeout(run, ms),
  cancel: (timer) => clearTimeout(timer),
}

export class ForeignRefreshScheduler {
  #timer: ReturnType<typeof setTimeout> | null = null
  /** When the oldest not-yet-served touched batch arrived (the max-wait base). */
  #firstAt = 0
  /** A refetch is owed but could not run (busy / loading) — consumed later. */
  #pending = false
  readonly #timing: SchedulerTiming

  constructor(
    private readonly host: ForeignRefreshHost,
    timing?: Partial<SchedulerTiming>,
  ) {
    this.#timing = { ...DEFAULT_TIMING, ...timing }
  }

  /** A foreign write touched the open thread. */
  touched(): void {
    if (this.host.busy() || this.host.loading()) {
      // Defer, never drop: for a child pane no turn-done reconcile exists to
      // make the drop safe. Consumed by consume() when the pane settles.
      this.#pending = true
      return
    }
    const now = this.#timing.now()
    if (this.#timer !== null) {
      this.#timing.cancel(this.#timer)
      this.#timer = null
      if (now - this.#firstAt >= this.#timing.maxWaitMs) {
        // The ceiling: writes have been arriving faster than the debounce for
        // the whole max-wait window — serve the reader now.
        this.#refreshGuarded()
        return
      }
    } else {
      this.#firstAt = now
    }
    this.#timer = this.#timing.schedule(() => {
      this.#timer = null
      this.#refreshGuarded()
    }, this.#timing.debounceMs)
  }

  /**
   * A history load settled or the live turn ended — run the ONE follow-up a
   * deferral asked for. Pending is KEPT (not dropped) while the pane is still
   * busy/loading: the next settle point consumes it. Bounded: a fresh load
   * clears pending at its start (loadStarted), so only a write arriving during
   * that load can re-arm it — exactly the case needing another read.
   */
  consume(): void {
    if (!this.#pending) return
    if (this.host.busy() || this.host.loading()) return
    this.#pending = false
    this.host.refresh()
  }

  /** A history load began: anything that arrived before its fetch is captured
   *  by the fetch itself. */
  loadStarted(): void {
    this.#pending = false
  }

  /** Thread switched or pane disposed — forget everything. */
  reset(): void {
    if (this.#timer !== null) {
      this.#timing.cancel(this.#timer)
      this.#timer = null
    }
    this.#pending = false
  }

  /** Exposed for the suite: whether a deferred refetch is owed. */
  get pending(): boolean {
    return this.#pending
  }

  #refreshGuarded(): void {
    if (this.host.busy() || this.host.loading()) {
      this.#pending = true
      return
    }
    this.host.refresh()
  }
}
