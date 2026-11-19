/**
 * THE ONE LOG — every step's recent output, interleaved in arrival order, as
 * plain lines. DOM-free.
 *
 * Fed from the same terminal output stream the xterms are written from. It
 * keeps a bounded ring (the newest `limit` lines across every step) and one
 * unfinished line per step, so memory stays flat however long a Run goes. It
 * only splits and strips here — the cheap part; turning lines into DOM is the
 * view's job, and the view does it only while the One log is on screen
 * (allowed-pattern #17).
 */
import { PROJECT_HUE_COUNT } from '../project-accent'

export const DEFAULT_LOG_LIMIT = 2_000
/** An unfinished line longer than this is cut into a line of its own — a step that never prints a newline cannot grow memory. */
export const MAX_PARTIAL_CHARS = 4_000

/* Escape sequences a terminal understands and a plain log must not show:
   CSI (colours, cursor moves), OSC (titles, links; ended by BEL or ST), the
   other two-byte escapes, and stray C0 control characters except tab. */
// eslint-disable-next-line no-control-regex
const ANSI_PATTERN = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[PX^_][^\x1b]*\x1b\\|\x1b[@-Z\\-_]|[\x00-\x08\x0b\x0c\x0e-\x1a\x1c-\x1f\x7f]/g

/** Text without terminal control codes. */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, '')
}

/** What a line reads as once carriage returns have redrawn it: the text after the last one. */
function settle(line: string): string {
  const cleaned = stripAnsi(line)
  const at = cleaned.lastIndexOf('\r')
  if (at === -1) return cleaned
  // "50%\r100%\r" ends on a return with nothing after it — keep the last text drawn.
  const after = cleaned.slice(at + 1)
  if (after.length > 0) return after
  const before = cleaned.slice(0, at)
  const previous = before.lastIndexOf('\r')
  return previous === -1 ? before : before.slice(previous + 1)
}

export interface LogLine {
  /** Increasing across the whole log — the view's "what have I drawn" cursor. */
  seq: number
  /** The step's key. */
  source: string
  text: string
}

export class LaunchpadLog {
  readonly #limit: number
  #lines: LogLine[] = []
  /** Index of the oldest line in `#lines` — a ring without per-push shifting. */
  #start = 0
  #nextSeq = 0
  readonly #partial = new Map<string, string>()

  constructor(limit = DEFAULT_LOG_LIMIT) {
    this.#limit = Math.max(1, Math.floor(limit))
  }

  /** Raw output from one step's terminal. Complete lines join the log; the rest waits for its newline. */
  push(source: string, chunk: string): void {
    if (chunk.length === 0) return
    let pending = (this.#partial.get(source) ?? '') + chunk
    let at = pending.indexOf('\n')
    while (at !== -1) {
      this.#append(source, settle(pending.slice(0, at)))
      pending = pending.slice(at + 1)
      at = pending.indexOf('\n')
    }
    while (pending.length > MAX_PARTIAL_CHARS) {
      this.#append(source, settle(pending.slice(0, MAX_PARTIAL_CHARS)))
      pending = pending.slice(MAX_PARTIAL_CHARS)
    }
    if (pending.length === 0) this.#partial.delete(source)
    else this.#partial.set(source, pending)
  }

  /** A step's terminal went away (restart, close): its unfinished line is let go. */
  forget(source: string): void {
    this.#partial.delete(source)
  }

  #append(source: string, text: string): void {
    const line: LogLine = { seq: this.#nextSeq, source, text }
    this.#nextSeq += 1
    if (this.#lines.length - this.#start < this.#limit) {
      this.#lines.push(line)
    } else {
      this.#lines.push(line)
      this.#start += 1
    }
    // Compact now and then, so the dropped head does not grow for ever.
    if (this.#start >= this.#limit) {
      this.#lines = this.#lines.slice(this.#start)
      this.#start = 0
    }
  }

  /** How many lines the log holds now. */
  get size(): number {
    return this.#lines.length - this.#start
  }

  /** The oldest kept line's seq (equals `nextSeq` when empty). */
  get firstSeq(): number {
    return this.size === 0 ? this.#nextSeq : this.#lines[this.#start].seq
  }

  /** The seq the next line will get. */
  get nextSeq(): number {
    return this.#nextSeq
  }

  /** Every kept line, oldest first. */
  lines(): LogLine[] {
    return this.#lines.slice(this.#start)
  }

  /** Kept lines with `seq >= from`, oldest first. */
  since(from: number): LogLine[] {
    const offset = Math.max(0, from - this.firstSeq)
    return this.#lines.slice(this.#start + offset)
  }
}

/**
 * A step's colour slot: its place in the group's step order, so a step keeps
 * its colour while the group runs and two neighbours never share one (until
 * the palette wraps). -1 for a key the group does not have.
 */
export function stepColourSlot(stepKeys: readonly string[], key: string): number {
  const index = stepKeys.indexOf(key)
  return index === -1 ? -1 : index % PROJECT_HUE_COUNT
}
