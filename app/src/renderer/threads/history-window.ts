// How much of a thread's history mounts on a rebuild (#1088).
//
// `#loadHistory` mounts only the newest HISTORY_WINDOW entries and parks the
// rest behind a "Show N earlier entries" control. That re-chunking used to be
// unconditional, so every completed turn discarded a chunk the reader had
// deliberately expanded — and because #179 faithfully restores the numeric
// `scrollTop` across the rebuild, removing ~20 entries from ABOVE the reader
// silently teleported them onto unrelated messages (measured: scrollTop stayed
// at 900 while the top entry went from "Bulk entry 7" to "Bulk entry 31").
//
// The window is therefore a function of the reader's state, not just the entry
// count. DOM-free so the rule unit-tests directly.

export interface HistoryWindowPlan {
  /** Entries to park behind the "Show earlier" control — 0 means no control. */
  earlierCount: number
  /** Index of the first entry to mount directly into the feed. */
  visibleFrom: number
}

/**
 * @param total       Number of history entries the thread has.
 * @param windowSize  HISTORY_WINDOW — the newest N that always mount.
 * @param expanded    Whether the reader already expanded the earlier chunk in
 *                    this feed. Once they have, a rebuild mounts everything:
 *                    re-collapsing is what loses their place.
 */
export function historyWindow(
  total: number,
  windowSize: number,
  expanded: boolean,
): HistoryWindowPlan {
  if (expanded) return { earlierCount: 0, visibleFrom: 0 }
  const overflow = total - windowSize
  if (overflow <= 0) return { earlierCount: 0, visibleFrom: 0 }
  return { earlierCount: overflow, visibleFrom: overflow }
}
