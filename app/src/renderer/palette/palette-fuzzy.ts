// Fuzzy subsequence scorer for the command palette. DOM-free and pure so it's
// unit-testable under node-env jest and reusable by any source provider.
//
// Model: case-insensitive SUBSEQUENCE match — every query char must appear in
// `target` in order (not necessarily contiguously). No match → null, so callers
// can filter with a single truthiness check. A match returns a score where
// higher is better; the shape of the score (not its absolute value) is the
// contract, so ranking stays deterministic for the same inputs.

// A contiguous run (typed substring) is the strongest intuitive signal — "com"
// should rank "command" above a boundary-laden "c_o_m_x" — so it outweighs the
// per-char boundary bonus below.
/** Bonus for a match char that directly follows the previous match char. */
const CONTIGUOUS_BONUS = 15
/** Bonus for a match landing on a word/segment boundary (see isBoundary). */
const BOUNDARY_BONUS = 12
/** Bonus for the very first char matching at target start. */
const START_BONUS = 6
/** Penalty per target index scanned before a match — rewards earlier matches. */
const LEADING_PENALTY = 1
/** Characters that begin a new segment; a match right after one is a boundary. */
const BOUNDARY_CHARS = new Set(['/', '\\', '-', '_', '.', ' '])

/**
 * True when position `i` in `target` starts a new segment: the string start, a
 * char following a separator, or a camelCase hump (lower/digit → Upper).
 */
function isBoundary(target: string, i: number): boolean {
  if (i === 0) return true
  const prev = target[i - 1]
  if (BOUNDARY_CHARS.has(prev)) return true
  const cur = target[i]
  // camelCase hump: previous char is lower/digit and current is uppercase.
  return (
    cur >= 'A' &&
    cur <= 'Z' &&
    ((prev >= 'a' && prev <= 'z') || (prev >= '0' && prev <= '9'))
  )
}

/**
 * Score `query` against `target` as a case-insensitive subsequence.
 *
 * Returns `null` when no subsequence match exists. An empty query returns 0 —
 * it matches everything but carries no ranking signal (recents/empty-state
 * path). Otherwise returns a positive-leaning score favoring, in order:
 * boundary hits, contiguous runs, and earlier match positions.
 */
export function fuzzyScore(query: string, target: string): number | null {
  if (query.length === 0) return 0
  if (target.length === 0) return null

  const q = query.toLowerCase()
  const t = target.toLowerCase()

  let score = 0
  let qi = 0
  // Index in `target` of the previous matched char, -2 so the first match is
  // never treated as contiguous.
  let prevMatch = -2

  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] !== q[qi]) continue

    let charScore = 1
    if (isBoundary(target, ti)) charScore += BOUNDARY_BONUS
    if (ti === prevMatch + 1) charScore += CONTIGUOUS_BONUS
    if (qi === 0 && ti === 0) charScore += START_BONUS
    // Earlier matches beat later ones: penalize the gap this char skipped.
    charScore -= (ti - (prevMatch + 1)) * LEADING_PENALTY

    score += charScore
    prevMatch = ti
    qi++
  }

  // Not every query char was consumed → not a subsequence.
  if (qi < q.length) return null
  return score
}
