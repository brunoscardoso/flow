// Bounded pre-attach output buffer for terminal tabs (#208). Main broadcasts
// terminal:data for EVERY live terminal, but a tab's xterm is only created when
// the tab is first activated. Output for a tab that's never opened (agent tabs
// the user never clicks are the common case) piled into an uncapped string[]
// forever, leaking renderer memory over a long session. This caps the buffer to
// a char budget, dropping the oldest chunks — the visible history a user needs
// on first attach is bounded anyway. Parallels the main-side scrollback cap
// (#171). Pure + DOM-free so the eviction unit-tests directly.

/** Char (≈byte) ceiling for retained pre-attach output per terminal (~256 KB). */
export const PENDING_MAX_CHARS = 256 * 1024

/** ANSI dim marker prepended on drain when older output was dropped. */
export const TRUNCATION_MARKER = '\r\n\x1b[2m[…scrollback truncated…]\x1b[0m\r\n'

/**
 * A char-bounded FIFO of raw terminal output chunks held until an xterm attaches.
 * Oldest chunks are evicted once the budget is exceeded; a single over-budget
 * chunk is trimmed to its newest tail. drain() returns the retained chunks (with
 * a truncation marker if anything was dropped) and empties the buffer.
 */
export class PendingBuffer {
  #chunks: string[] = []
  #chars = 0
  #truncated = false
  readonly #maxChars: number

  constructor(maxChars: number = PENDING_MAX_CHARS) {
    this.#maxChars = maxChars
  }

  push(chunk: string): void {
    if (chunk.length === 0) return
    this.#chunks.push(chunk)
    this.#chars += chunk.length
    // Evict whole oldest chunks while over budget (keep at least the newest).
    while (this.#chars > this.#maxChars && this.#chunks.length > 1) {
      this.#chars -= this.#chunks.shift()?.length ?? 0
      this.#truncated = true
    }
    // One chunk larger than the whole budget can't be evicted above — trim it
    // to the most-recent tail so the bound is hard.
    if (this.#chunks.length === 1 && this.#chars > this.#maxChars) {
      const only = this.#chunks[0]
      const trimmed = only.slice(only.length - this.#maxChars)
      this.#chunks[0] = trimmed
      this.#chars = trimmed.length
      this.#truncated = true
    }
  }

  /** Retained chunks (truncation marker first if any were dropped), and CLEAR. */
  drain(): string[] {
    const out = this.#chunks
    if (this.#truncated) out.unshift(TRUNCATION_MARKER)
    this.#chunks = []
    this.#chars = 0
    this.#truncated = false
    return out
  }

  /** Retained size in chars (≈bytes) — for the memory-bound test. */
  get charCount(): number {
    return this.#chars
  }
}
