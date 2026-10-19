/**
 * A chunk of terminal output, with the moment it arrived.
 *
 * WHY THIS EXISTS. The embedded browser stamps every console and network entry
 * with `ts` — epoch milliseconds on the host clock, measured and pinned by
 * `e2e/ux/browser-capture-clock.spec.ts`. Terminal output had no time at all:
 * `ScrollbackBuffer` keeps a string, a line count and a char count, because it
 * is a DISPLAY buffer. So there was nothing to put a server log beside a failed
 * request against, and correlating the two was a person reading two panes.
 *
 * THE SAME CLOCK, DELIBERATELY. `at` is `Date.now()` taken in main when the
 * chunk arrives, which is the clock the browser's `ts` was measured to agree
 * with (console 0–1 ms, network 2 ms). Merging the two is therefore a sort, and
 * it is only that simple because both numbers mean the same thing.
 *
 * DOM-FREE AND PTY-FREE, so the merge that consumes these can be tested without
 * a terminal, a renderer, or a running shell.
 */

/** One chunk of output from one terminal, stamped on arrival. */
export interface StampedTerminalChunk {
  /** Which terminal produced it. */
  terminalId: string
  /**
   * Epoch milliseconds when main received the chunk.
   *
   * ARRIVAL, NOT EMISSION. A process can buffer for milliseconds before its
   * output reaches the pty, so this is when Flow saw it — the same thing the
   * browser's `ts` is, and the only one either side can actually observe.
   */
  at: number
  /** The raw bytes as the terminal received them, escape sequences included. */
  data: string
}

/**
 * Anything that wants stamped output, for as long as it wants it.
 *
 * A FUNCTION, NOT AN EVENT. `TERMINAL_DATA_EVENT` is how the renderer learns
 * what to draw, and widening it would put a timestamp on every chunk crossing
 * IPC for every window, forever, to serve a recording almost nobody is making.
 * An observer list costs one `length === 0` check when it is empty, which is
 * the whole of the at-rest cost.
 */
export type TerminalOutputObserver = (chunk: StampedTerminalChunk) => void
