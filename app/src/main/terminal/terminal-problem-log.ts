/**
 * One terminal's problems — the pure, clock-injected store behind the
 * Problems list's Terminals section. DOM-free, timer-free: the service
 * (terminal-problems-service.ts) owns batching and broadcasting.
 *
 * Output arrives in chunks that split lines anywhere. `feed` keeps the
 * unfinished tail, judges each complete line once (shared/terminal-problems.ts),
 * and folds a repeat into the row it repeats: count + 1, last seen and the
 * latest context updated, first seen and its context kept.
 *
 * Bounds (a noisy terminal must not grow main's memory): the newest
 * MAX_PROBLEMS_PER_TERMINAL distinct problems, lines cut at
 * MAX_PROBLEM_LINE_CHARS, context lines at MAX_CONTEXT_LINE_CHARS, and an
 * unfinished line at MAX_PARTIAL_CHARS.
 */
import {
  colourOfLine,
  detectProblem,
  lastScreenSegment,
  MAX_PROBLEM_LINE_CHARS,
  problemFingerprint,
  stripAnsi,
  type ColourState,
  type TerminalProblem,
} from '../../shared/terminal-problems'

/** Distinct problems kept per terminal; the oldest by last appearance goes first. */
export const MAX_PROBLEMS_PER_TERMINAL = 200
/** Lines printed before a problem that are kept with it. */
export const CONTEXT_LINES = 6
/** A context line longer than this is cut. */
export const MAX_CONTEXT_LINE_CHARS = 400
/** An unfinished line (no newline yet) longer than this keeps only its tail. */
export const MAX_PARTIAL_CHARS = 16_000

interface Row extends TerminalProblem {
  fingerprint: string
}

function cut(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text
}

export class TerminalProblemLog {
  readonly terminalId: string
  #now: () => number
  #rows = new Map<string, Row>()
  #recent: string[] = []
  #partial = ''
  #colour: ColourState = null
  #seq = 0

  constructor(terminalId: string, now: () => number = Date.now) {
    this.terminalId = terminalId
    this.#now = now
  }

  /** Read a chunk of raw output. True when a problem was added or repeated. */
  feed(data: string): boolean {
    if (data.length === 0) return false
    let text = this.#partial + data
    const lastNewline = text.lastIndexOf('\n')
    if (lastNewline < 0) {
      this.#partial = this.#boundPartial(text)
      return false
    }
    this.#partial = this.#boundPartial(text.slice(lastNewline + 1))
    text = text.slice(0, lastNewline)
    let changed = false
    let start = 0
    while (start <= text.length) {
      const end = text.indexOf('\n', start)
      const line = end < 0 ? text.slice(start) : text.slice(start, end)
      if (this.#line(line)) changed = true
      if (end < 0) break
      start = end + 1
    }
    return changed
  }

  /** The unfinished last line is judged as it is (the process exited). */
  flush(): boolean {
    if (this.#partial === '') return false
    const line = this.#partial
    this.#partial = ''
    return this.#line(line)
  }

  /** Output was lost before what comes next: forget the unfinished line. */
  dropPartial(): void {
    this.#partial = ''
  }

  /** Newest first. */
  problems(): TerminalProblem[] {
    return [...this.#rows.values()].reverse().map(({ fingerprint: _fingerprint, ...problem }) => ({
      ...problem,
      context: [...problem.context],
      firstContext: [...problem.firstContext],
    }))
  }

  get size(): number {
    return this.#rows.size
  }

  /** The latest appearance of any problem, or 0 with none. */
  get lastSeen(): number {
    let latest = 0
    for (const row of this.#rows.values()) latest = Math.max(latest, row.lastSeen)
    return latest
  }

  counts(): { errors: number; warnings: number } {
    let errors = 0
    let warnings = 0
    for (const row of this.#rows.values()) {
      if (row.severity === 'error') errors += 1
      else warnings += 1
    }
    return { errors, warnings }
  }

  clear(): void {
    this.#rows.clear()
  }

  #boundPartial(partial: string): string {
    if (partial.length <= MAX_PARTIAL_CHARS) return partial
    const cr = partial.lastIndexOf('\r')
    const tail = cr >= 0 ? partial.slice(cr + 1) : partial
    return tail.length <= MAX_PARTIAL_CHARS ? tail : tail.slice(tail.length - MAX_PARTIAL_CHARS)
  }

  #line(rawLine: string): boolean {
    const raw = rawLine.length > MAX_PROBLEM_LINE_CHARS * 4 ? rawLine.slice(0, MAX_PROBLEM_LINE_CHARS * 4) : rawLine
    const colour = colourOfLine(raw, this.#colour)
    this.#colour = colour.end
    const visible = cut(stripAnsi(lastScreenSegment(raw)).trimEnd(), MAX_PROBLEM_LINE_CHARS)
    const found = detectProblem(raw, colour.tone)
    let changed = false
    if (found !== null) {
      changed = true
      const fingerprint = problemFingerprint(found)
      const now = this.#now()
      const context = this.#recent.map((line) => cut(line, MAX_CONTEXT_LINE_CHARS))
      const existing = this.#rows.get(fingerprint)
      if (existing !== undefined) {
        existing.count += 1
        existing.lastSeen = now
        existing.message = found.message
        existing.line = visible
        existing.context = context
        // Re-insert: the map's order is "last appearance", oldest first.
        this.#rows.delete(fingerprint)
        this.#rows.set(fingerprint, existing)
      } else {
        this.#seq += 1
        this.#rows.set(fingerprint, {
          id: `${this.terminalId}:${this.#seq}`,
          terminalId: this.terminalId,
          fingerprint,
          severity: found.severity,
          message: found.message,
          meta: found.meta,
          count: 1,
          firstSeen: now,
          lastSeen: now,
          line: visible,
          context,
          firstContext: context,
        })
        while (this.#rows.size > MAX_PROBLEMS_PER_TERMINAL) {
          const oldest = this.#rows.keys().next().value
          if (oldest === undefined) break
          this.#rows.delete(oldest)
        }
      }
    }
    // Blank lines are not context: a traceback is what matters, not spacing.
    if (visible.trim() !== '') {
      this.#recent.push(visible)
      if (this.#recent.length > CONTEXT_LINES) this.#recent.shift()
    }
    return changed
  }
}
