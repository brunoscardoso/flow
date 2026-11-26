/**
 * WHOSE DATA IS RUNNING — the thread list's mark for the thread whose own
 * Docker data is live (a green dot and "Data running"). DOM-free: the tracker
 * gets its reads, its clock and its visibility injected.
 *
 * Cost (allowed-pattern #17, forbidden-pattern #14): the list asks main only
 * while it is on screen, and only when a Run change could move the answer — a
 * Run state that carries a Docker service or a Docker notice. Those arrive on
 * transitions, never per output line, and a burst of them is folded into one
 * read. An off-screen list owes one read and pays it on the way back in.
 */
import type { RunGroupState } from '../../shared/run-setup'

export const THREAD_DATA_STRINGS = {
  running: 'Data running',
  runningTitle: "This thread's own data is the one running now.",
} as const

/** How long a burst of Run changes is folded before one read. */
export const LIVE_DATA_DEBOUNCE_MS = 400

/** The row's mark for one thread, or null when its data is not the live one. */
export function threadDataFace(threadId: string, live: ReadonlySet<string>): { label: string; title: string } | null {
  return live.has(threadId) ? { label: THREAD_DATA_STRINGS.running, title: THREAD_DATA_STRINGS.runningTitle } : null
}

/** True when a Run change could move whose data is live. */
export function runStateTouchesData(state: RunGroupState): boolean {
  return state.steps.some((step) => step.docker !== undefined) || (state.dockerNotices?.length ?? 0) > 0
}

/** True when two answers name the same threads. */
export function sameLiveSet(current: ReadonlySet<string>, next: readonly string[]): boolean {
  if (current.size !== new Set(next).size) return false
  return next.every((id) => current.has(id))
}

export interface LiveDataDeps {
  read: () => Promise<string[]>
  isVisible: () => boolean
  /** The answer changed: repaint the rows. */
  onChange: () => void
  setTimer?: (run: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
}

export class LiveDataTracker {
  readonly #deps: LiveDataDeps
  #live = new Set<string>()
  /** A read is owed: never read yet, or a change arrived while hidden. */
  #owed = true
  #timer: unknown = null
  #inflight = false
  #again = false
  #disposed = false

  constructor(deps: LiveDataDeps) {
    this.#deps = deps
  }

  get live(): ReadonlySet<string> {
    return this.#live
  }

  /** A Run changed somewhere: read again soon if it could matter and the list is on screen. */
  runUpdated(state: RunGroupState): void {
    if (!runStateTouchesData(state)) return
    this.#owed = true
    if (this.#deps.isVisible()) this.#schedule()
  }

  /** The list came on screen (or was first drawn): pay a read it owes. */
  shown(): void {
    if (this.#owed && this.#deps.isVisible()) this.#schedule()
  }

  dispose(): void {
    this.#disposed = true
    if (this.#timer !== null) (this.#deps.clearTimer ?? clearTimeout)(this.#timer as ReturnType<typeof setTimeout>)
    this.#timer = null
  }

  #schedule(): void {
    if (this.#disposed || this.#timer !== null) return
    const set = this.#deps.setTimer ?? ((run: () => void, ms: number) => setTimeout(run, ms))
    this.#timer = set(() => {
      this.#timer = null
      void this.#read()
    }, LIVE_DATA_DEBOUNCE_MS)
  }

  async #read(): Promise<void> {
    if (this.#disposed) return
    if (this.#inflight) {
      this.#again = true
      return
    }
    if (!this.#deps.isVisible()) return // still owed; paid on the way back in
    this.#inflight = true
    this.#owed = false
    try {
      const ids = await this.#deps.read()
      if (this.#disposed) return
      if (!sameLiveSet(this.#live, ids)) {
        this.#live = new Set(ids)
        this.#deps.onChange()
      }
    } catch {
      // Docker or main did not answer: keep the last answer, owe a read.
      this.#owed = true
    } finally {
      this.#inflight = false
      if (this.#again) {
        this.#again = false
        this.#schedule()
      }
    }
  }
}
