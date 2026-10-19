/**
 * What a slow moment looks like written down.
 *
 * Pure formatting, apart from the observers that feed it — the wording is the
 * part that has to be right, because these lines are read months later by
 * somebody holding only a complaint ("it is slow") and this file.
 *
 * Every line answers three questions in order: WHAT was slow, HOW slow, and
 * WHAT ELSE was happening. The third is the one that ends investigations: a
 * frame blocked for 900 ms while waiting on `project:listAllFiles` and one
 * blocked for 900 ms with nothing in flight are different bugs with identical
 * symptoms, and this repo has spent whole sessions guessing between them.
 */

/** A frame budget is 16 ms. Anything past this is visible as a stutter; below
 *  it, logging would bury the moments a person actually felt. */
export const LONG_TASK_MS = 200

/** An interaction slower than this stops feeling like a press and starts
 *  feeling like a wait — the "I click the input and the cursor spins" report. */
export const SLOW_INTERACTION_MS = 200

/** What was in flight when it happened, or an explicit statement that nothing
 *  was — never an empty parenthesis the reader has to interpret. */
export function whileWaitingFor(inFlight: readonly string[]): string {
  if (inFlight.length === 0) return 'nothing in flight'
  return `waiting on ${inFlight.join(', ')}`
}

/** The renderer's main thread was busy for `ms` and could not paint. */
export function formatLongTask(ms: number, inFlight: readonly string[]): string {
  return `[renderer] blocked for ${String(Math.round(ms))}ms (${whileWaitingFor(inFlight)})`
}

/**
 * One interaction, split where the time actually went.
 *
 * `delay` is how long the event sat in the queue before its handler ran — that
 * is the main thread being busy with something else. `handler` is the handler
 * itself. A press that is all delay and no handler is not this button's fault,
 * and a line that reported only the total could never say so.
 */
export function formatInteraction(input: {
  name: string
  total: number
  delay: number
  handler: number
  target: string
  inFlight: readonly string[]
}): string {
  const { name, total, delay, handler, target, inFlight } = input
  return (
    `[renderer] ${name} on ${target} took ${String(Math.round(total))}ms ` +
    `(${String(Math.round(delay))}ms waiting for the thread, ` +
    `${String(Math.round(handler))}ms in the handler, ${whileWaitingFor(inFlight)})`
  )
}

/** How long the window took to become usable, in the stages a person notices. */
export function formatStartup(marks: {
  scriptMs: number
  shellMs: number
  firstPaintMs: number
}): string {
  return (
    `[renderer] startup: script ${String(Math.round(marks.scriptMs))}ms, ` +
    `shell ${String(Math.round(marks.shellMs))}ms, ` +
    `first paint ${String(Math.round(marks.firstPaintMs))}ms`
  )
}

/**
 * A short, stable name for the thing that was clicked.
 *
 * Not a selector to be re-run — a label to be recognised. Prefers whatever the
 * app already calls the element (a data-testid, an aria-label, its first class)
 * over a DOM path nobody can read.
 */
export function describeTarget(element: {
  tagName?: string
  getAttribute?: (name: string) => string | null
  className?: unknown
} | null): string {
  if (element === null || element === undefined) return 'the window'
  const tag = (element.tagName ?? 'element').toLowerCase()
  const attr = (name: string): string | null => element.getAttribute?.(name) ?? null
  const named = attr('data-testid') ?? attr('aria-label') ?? attr('data-action')
  if (named !== null && named.trim().length > 0) return `${tag}[${named.trim().slice(0, 40)}]`
  const classes = typeof element.className === 'string' ? element.className.trim() : ''
  const first = classes.split(/\s+/)[0]
  if (first !== undefined && first.length > 0) return `${tag}.${first.slice(0, 40)}`
  return tag
}

/**
 * Collapse a burst into one line with a count.
 *
 * A stall does not produce one long task, it produces forty — and forty
 * identical lines hide the one different line between them.
 */
export function collapseRepeats(lines: readonly string[]): string[] {
  const out: string[] = []
  let last: string | null = null
  let repeats = 0
  const flush = (): void => {
    if (last === null) return
    out.push(repeats > 0 ? `${last} (×${String(repeats + 1)})` : last)
  }
  for (const line of lines) {
    // Same shape, different milliseconds, is still the same event repeating.
    const shape = line.replace(/\d+ms/g, 'Nms')
    if (last !== null && shape === last.replace(/\d+ms/g, 'Nms')) {
      repeats += 1
      continue
    }
    flush()
    last = line
    repeats = 0
  }
  flush()
  return out
}
