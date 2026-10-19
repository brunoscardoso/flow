// The board's queue-read gate — WHEN a `loop list` may be spawned, decided in
// one DOM-free place (loops-on-the-board, review finding H3).
//
// THE TTL WAS NEVER THE PROBLEM; THE GAP AROUND IT WAS. `#readQueue` computed
// its freshness from a timestamp it only wrote AFTER the reads resolved, and
// nothing anywhere said "a read is happening right now". That is a check-then-act
// race, and the hot path is the one that loses it:
//
//   #claimCard → #materializeRunRecord (a DB insert) → refresh({reloadQueue:true})
//                     ↓ the same insert fires tasks:updated after a 50 ms debounce
//                       → api.tasks.onUpdated(() => void board.refresh())
//
// A `gh` round trip vastly exceeds 50 ms, so the unforced refresh reliably
// entered while the forced one was still in flight, read a timestamp from before
// the claim, and spawned its own `loop list` + `loop status` pair. ONE CLAIM,
// FOUR CLI PROCESSES — on a queue whose reads are network calls with a 30 s
// budget each.
//
// The TTL and the force/no-force design are UNCHANGED. What is added is the
// missing third state: not "fresh" or "stale" but "already being found out".
//
// WHY A FORCED CALLER DOES NOT JOIN A READ THAT HAS ALREADY STARTED. Force means
// the moments a person is asking what is on the list — Retry, project switch,
// the tail of a claim — and a read that BEGAN BEFORE they asked cannot answer
// that question: Retry would hand back the very answer being retried, and a
// project switch would settle the board on the queue of the project that just
// closed. So a forced caller gets the read AFTER, not the read in progress.
//
// It does NOT get its own read, though. A queued read has not started yet, so it
// will observe a world later than any caller now asking — which means every
// forced caller waiting behind the same in-flight read can share ONE trailing
// read. Worst case is therefore two spawn pairs (the one running plus one
// trailing), never N, however many times Retry is pressed.

/** One scheduled read: which project it is about, and whether it has begun. */
interface QueueReadLink {
  root: string
  /** False while the link is queued behind an earlier one; true once running. */
  started: boolean
  promise: Promise<void>
}

/**
 * Serializes and de-duplicates the board's queue reads.
 *
 * Holds the TTL's two halves (when the last read landed, and for which root)
 * that `KanbanBoard` used to carry as fields, plus the in-flight link the
 * finding said was missing. The read ITSELF stays in the board — this decides
 * only whether one happens and who waits on which.
 */
export class QueueReadGate {
  readonly #ttlMs: number
  readonly #now: () => number
  /** When the last completed read landed, and the root it was about. */
  #root: string | null = null
  #readAt = 0
  /** The most recently scheduled read, until it settles. */
  #link: QueueReadLink | null = null

  constructor(ttlMs: number, now: () => number = Date.now) {
    this.#ttlMs = ttlMs
    this.#now = now
  }

  /**
   * Run `perform` unless an existing or in-flight read already answers.
   *
   * Resolves when the answer this caller is entitled to has landed — joined,
   * queued or freshly run — so `await gate.read(...)` always leaves the board's
   * fields populated by a read no older than the caller's own rules allow.
   */
  read(root: string, force: boolean, perform: () => Promise<void>): Promise<void> {
    const link = this.#link
    if (link !== null && link.root === root) {
      // An unforced caller takes whatever is being read; a forced one takes it
      // only while it is still queued, because a queued read has not looked yet.
      if (!force || !link.started) return link.promise
    }
    // The TTL, unchanged — and only reachable with nothing in flight, which is
    // what makes the timestamp it reads meaningful in the first place.
    if (link === null && !force && this.#root === root && this.#now() - this.#readAt < this.#ttlMs) {
      return Promise.resolve()
    }
    const previous = link === null ? null : link.promise
    const next: QueueReadLink = { root, started: false, promise: Promise.resolve() }
    next.promise = (async () => {
      // No prior link → this body runs to here synchronously, so `started` is
      // already true by the time `read` returns and a caller can inspect it.
      //
      // A queued read needs the previous one's ORDERING, not its success: its
      // rejection already belongs to the callers who joined it. Awaiting it
      // bare would throw before the try below, so `started` would never be set
      // and the finally would never clear `#link` — every later read for this
      // root would join a settled, rejected link forever (#1705). Awaited
      // directly (not via `.catch(...)`, which would add a microtask hop and
      // reorder this body behind callers already awaiting the same settle).
      if (previous !== null) {
        try {
          await previous
        } catch {
          // The trailing read runs regardless — win or lose, it clears itself.
        }
      }
      next.started = true
      try {
        await perform()
        // Stamped only on a read that actually completed: a rejected perform
        // has measured nothing, and dating it would suppress the retry.
        this.#root = root
        this.#readAt = this.#now()
      } finally {
        if (this.#link === next) this.#link = null
      }
    })()
    this.#link = next
    return next.promise
  }

  /**
   * Drop the freshness stamp — the board has no project open, so there is no
   * last answer to reuse. Says nothing about a read already in flight: that one
   * still owns the fields it is about to write, and cancelling a promise nobody
   * can cancel would only mean lying about it here.
   */
  forget(): void {
    this.#root = null
    this.#readAt = 0
  }
}
