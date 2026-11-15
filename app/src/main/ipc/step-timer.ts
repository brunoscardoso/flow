// Named stretches inside ONE slow operation, written as one line to slow.log.
//
// The IPC timer (`timed`) says a handler took 12 s; it cannot say which of its
// awaits spent them. A new thread's first wait was measured at 9.6–12.5 s with
// 4–6 s nobody could attribute, because the steps between the CLI returning and
// the handler returning had no clock on them. This puts one on each.
//
// ONE LINE, ONLY WHEN THE WHOLE IS SLOW. Steps are listed in the order they
// started, each with its own duration; concurrent steps overlap, so the parts
// may sum to more than the total. Nothing is written for an operation under
// the slow-handler threshold, so a fast path costs a few `performance.now()`
// calls and no I/O.

import { SLOW_HANDLER_MS, recordSlow } from './slow-handler'

export class StepTimer {
  readonly #label: string
  readonly #clock: () => number
  readonly #started: number
  readonly #steps: { name: string; ms: number | null }[] = []

  constructor(label: string, clock: () => number = () => performance.now()) {
    this.#label = label
    this.#clock = clock
    this.#started = clock()
  }

  /** Time one awaited step. The step's own result (or throw) passes through untouched. */
  async step<T>(name: string, work: () => Promise<T>): Promise<T> {
    const entry: { name: string; ms: number | null } = { name, ms: null }
    this.#steps.push(entry)
    const at = this.#clock()
    try {
      return await work()
    } finally {
      entry.ms = Math.round(this.#clock() - at)
    }
  }

  /** Milliseconds since the timer was made. */
  elapsed(): number {
    return Math.round(this.#clock() - this.#started)
  }

  /** `[label] 1234ms — a 10ms, b 900ms, c (unfinished)`. */
  line(): string {
    const parts = this.#steps.map((step) =>
      step.ms === null ? `${step.name} (unfinished)` : `${step.name} ${String(step.ms)}ms`,
    )
    const head = `[${this.#label}] ${String(this.elapsed())}ms`
    return parts.length === 0 ? head : `${head} — ${parts.join(', ')}`
  }

  /** Write the line when the whole took at least `thresholdMs`. Returns whether it did. */
  recordIfSlow(write: (line: string) => void = recordSlow, thresholdMs = SLOW_HANDLER_MS): boolean {
    if (this.elapsed() < thresholdMs) return false
    write(this.line())
    return true
  }
}
