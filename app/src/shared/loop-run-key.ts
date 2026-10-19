// A run's name (#loops). A loop run used to be identified by the whole sentence
// somebody typed at it — a paragraph as a card title, a paragraph as a thread
// title, and nothing shorter to say out loud.
//
// So a run gets a KEY and a SHORT TITLE, both computed here and nowhere else
// (allowed-pattern #14): the key is minted when the run starts and stored on its
// thread, and every surface that shows the run — the sidebar row, the board's
// card in Doing, the loops screen — reads that one stored value rather than
// deriving its own and drifting.
//
// THE KEY IS THREE LETTERS AND A NUMBER: T for task, the project's own initial,
// L for loop — `TOL-001` in a project called orbit-app. It is deliberately
// NOT a hash, a uuid or a timestamp: it exists to be read aloud and typed into
// a search box, which is the whole reason the paragraph was not enough.

/** A run key, split into the parts that make it sortable. */
export interface RunKeyParts {
  prefix: string
  number: number
}

const KEY_PATTERN = /^([A-Z]{2,4})-(\d{1,6})$/

/** How many digits a fresh number is padded to. Three: `TOL-001`. */
const KEY_DIGITS = 3

/**
 * The letters a project's run keys start with — `T` + its initial + `L`.
 *
 * The initial is the first LETTER of the project's own name, so `orbit-app`
 * and `2-orbit` both give `O` rather than a digit or a dash. A name with no
 * letter at all falls back to `X`, which is a real answer: it keys nothing
 * incorrectly and still increments.
 */
export function runKeyPrefix(projectName: string): string {
  const letter = /[A-Za-z]/.exec(projectName)?.[0] ?? 'X'
  return `T${letter.toUpperCase()}L`
}

/** The parts of a key, or null when the string is not one. */
export function parseRunKey(key: string): RunKeyParts | null {
  const match = KEY_PATTERN.exec(key.trim())
  if (match === null) return null
  return { prefix: match[1], number: Number(match[2]) }
}

/**
 * The next key for this project.
 *
 * COUNTS FROM THE HIGHEST KEY, NOT FROM HOW MANY THERE ARE. Deleting a run's
 * thread must not hand its number to the next run — two different runs answering
 * to `TOL-004` is exactly the confusion a key is for avoiding, and a person who
 * wrote the number down is not told when the count moves under them. Keys with
 * another project's prefix are ignored rather than counted.
 */
export function nextRunKey(projectName: string, existingKeys: readonly string[]): string {
  const prefix = runKeyPrefix(projectName)
  let highest = 0
  for (const key of existingKeys) {
    const parts = parseRunKey(key)
    if (parts === null || parts.prefix !== prefix) continue
    if (parts.number > highest) highest = parts.number
  }
  const next = highest + 1
  return `${prefix}-${String(next).padStart(KEY_DIGITS, '0')}`
}

/** Longest a summarized aim may run before it is cut. */
const SUMMARY_MAX = 72

/** Shortest a first clause may be before the next one is pulled in with it. */
const SUMMARY_MIN = 16

/**
 * A sentence's worth of what a run is about.
 *
 * CUT AT THE WRITER'S OWN PUNCTUATION FIRST. People front-load: the clause
 * before the first comma is almost always the subject, and the paragraph after
 * it is qualification. Falling straight to a character count would slice a word
 * in half and read as a truncation rather than a title. A very short first
 * clause ("tenant ids") is not a summary, so clauses are taken until there is
 * enough to be one.
 *
 * DETERMINISTIC, AND NOT A MODEL. The same text always summarizes the same way —
 * this runs while a person waits for a button to respond, and a title that
 * changed between two renders of the same run would be worse than a long one.
 */
export function summarizeAim(text: string): string {
  const clean = text.trim().replace(/\s+/g, ' ')
  if (clean.length === 0) return ''
  if (clean.length <= SUMMARY_MAX) return clean

  let summary = ''
  for (const clause of clean.split(/(?<=[,;:.—])\s+/)) {
    const next = summary.length === 0 ? clause : `${summary} ${clause}`
    if (summary.length >= SUMMARY_MIN && next.length > SUMMARY_MAX) break
    summary = next
    if (summary.length >= SUMMARY_MIN) break
  }
  if (summary.length === 0) summary = clean
  // Trailing punctuation is a seam, not part of the title.
  summary = summary.replace(/[,;:.—]+$/, '')
  if (summary.length <= SUMMARY_MAX) return summary

  // Still too long: cut on a word boundary, never mid-word.
  const cut = summary.slice(0, SUMMARY_MAX)
  const lastSpace = cut.lastIndexOf(' ')
  return `${(lastSpace > SUMMARY_MIN ? cut.slice(0, lastSpace) : cut).replace(/[,;:.—]+$/, '')}…`
}

/** `TOL-001 · what it is about` — one title, used for the thread and the card. */
export function runTitle(key: string, aim: string): string {
  const summary = summarizeAim(aim)
  return summary.length === 0 ? key : `${key} · ${summary}`
}
