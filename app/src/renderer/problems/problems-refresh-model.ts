// When the Problems tab reads main's diagnostics, and how much — DOM-free so
// the "pay only for what someone can see" rule (allowed-pattern #17) is
// unit-testable without a layout.
//
// Diagnostics arrive per file and in bursts (every keystroke re-checks the
// file). The view coalesces them behind one trailing timer, then asks here
// what the read should be:
//   - the bottom panel is not on screen → read nothing, remember it is stale
//   - the panel shows the terminal      → counts only (the tab label)
//   - the panel shows Problems          → the bounded list
import { DEFAULT_PROBLEMS_LIMIT } from '../../shared/problems-model'
import { DEFAULT_TERMINAL_PROBLEMS_LIMIT } from '../../shared/terminal-problems'

/** Quiet window after the last diagnostics event before one read. */
export const PROBLEMS_COALESCE_MS = 250

export interface ProblemsSurfaceState {
  /** The bottom panel is attached and has a size. */
  rendered: boolean
  /** The Problems tab is the one selected. */
  listShown: boolean
}

/** The `limit` to read with, or null to skip the read (and stay stale). */
export function problemsReadLimit(state: ProblemsSurfaceState): number | null {
  if (!state.rendered) return null
  return state.listShown ? DEFAULT_PROBLEMS_LIMIT : 0
}

/** The same rule for the terminal problems read: off screen nothing, counts, or the bounded list. */
export function terminalProblemsReadLimit(state: ProblemsSurfaceState): number | null {
  if (!state.rendered) return null
  return state.listShown ? DEFAULT_TERMINAL_PROBLEMS_LIMIT : 0
}
