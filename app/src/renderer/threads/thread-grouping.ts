// Pure thread-list capping for the sidebar (#71) — pinned first, then the N
// most-recent items, with the overflow folded under "Show more". Count-based
// (not time-based) so each project shows a predictable number of threads
// regardless of age. DOM-free so it is unit-testable (the sidebar component
// touches customElements at import time).

/** Default number of unpinned items shown before "Show more" folds the rest. */
export const DEFAULT_VISIBLE_LIMIT = 5

/** The Workspace's ONE list holds every project's threads, so a per-project
 *  five would fold most of the work away (user, 2026-10-06: "can we have more
 *  than 5 by default showing?"). */
export const WORKSPACE_VISIBLE_LIMIT = 25

/** Anything that can be capped: has a last-activity time and a pin state. A
 *  task's pin is its 1:1 thread's pin, so tasks are wrapped to satisfy this. */
export interface RecencyPinned {
  updatedAt: string
  pinnedAt: string | null
  /** Identity for the active-thread cap exemption (#1042) — a task carries its
   *  1:1 thread's id. Optional: callers without one simply get no exemption. */
  id?: string
}

export interface CappedList<T> {
  /** Pinned items, always shown first (newest-first, cap-exempt). */
  pinned: T[]
  /** Unpinned items shown by default (newest-first, up to the limit). */
  visible: T[]
  /** How many unpinned items sit beyond the limit — the "Show N more" count.
   *  Reported even when expanded, so the toggle can label itself. */
  overflowCount: number
}

/**
 * Cap a project's items (threads or tasks) to a predictable default: pinned
 * first (always shown), then the `limit` most-recent unpinned items; the rest
 * fold under "Show more".
 *
 * - `searching`: every match is shown AND the fold is suppressed — search
 *   already reveals all matches, so a "Show N more" control would be inert and
 *   misleading (#75). `overflowCount` is therefore reported as 0 while
 *   searching, so the sidebar never pushes a fold header.
 * - `expanded`: every item is shown but `overflowCount` still reports how many
 *   sit beyond the limit, so the toggle can label itself "Show less".
 * - `activeId`: the OPEN thread is always represented (#1042) — when it falls
 *   past the cap it is force-included at the end of the visible band, mirroring
 *   the pinned exemption, so the composer is never live and bound to a thread
 *   with no row anywhere. It stays counted in `overflowCount` (it is surfaced
 *   out of the fold, not re-banded), keeping the "Show N more" label stable.
 */
export function capThreadList<T extends RecencyPinned>(
  items: T[],
  opts: {
    searching: boolean
    expanded: boolean
    limit?: number
    activeId?: string | null
    /**
     * How to order the list, when the project asked for something other than
     * recency.
     *
     * PASSED IN RATHER THAN PRE-SORTED, because this function is what decides
     * where the fold falls: sorting outside and letting it re-sort by recency
     * would fold by one rule and display by another, putting "Show N more"
     * somewhere the reader cannot predict. Absent keeps the recency default
     * every existing caller relies on.
     */
    compare?: (a: T, b: T) => number
  },
): CappedList<T> {
  const limit = opts.limit ?? DEFAULT_VISIBLE_LIMIT
  const byRecency = (a: T, b: T): number => b.updatedAt.localeCompare(a.updatedAt)
  const order = opts.compare ?? byRecency
  // THE PINNED BAND KEEPS ITS OWN RULE. Pinning is "keep this in front of me",
  // and a pinned row that moved because the list below it was re-sorted by name
  // would be the one thing a pin exists to prevent.
  const pinned = items.filter((t) => t.pinnedAt !== null).sort(byRecency)
  const rest = items.filter((t) => t.pinnedAt === null).sort(order)
  const overflowCount = Math.max(0, rest.length - limit)
  if (opts.searching) {
    // All matches visible; no fold control (search bypasses the cap entirely).
    return { pinned, visible: rest, overflowCount: 0 }
  }
  if (opts.expanded) {
    return { pinned, visible: rest, overflowCount }
  }
  const visible = rest.slice(0, limit)
  const activeId = opts.activeId ?? null
  if (
    activeId !== null &&
    !visible.some((t) => t.id === activeId) &&
    !pinned.some((t) => t.id === activeId)
  ) {
    const active = rest.find((t) => t.id === activeId)
    if (active) visible.push(active)
  }
  return { pinned, visible, overflowCount }
}

/** A sidebar row's height, in the two sizes the list now renders. */
export const SIDEBAR_ROW_HEIGHT = 28
/** The title's line — the one the glyph, the age and the ⋯ sit on. */
export const ROW_LINE_HEIGHT = 20
/**
 * The projects line.
 *
 * SMALLER THAN THE TITLE'S ON PURPOSE. It is a footnote about where else this
 * thread can reach, not a second title, and a row whose two lines carry equal
 * weight reads as two rows.
 */
export const ROW_CONTEXT_LINE_HEIGHT = 16
/** Where the text column starts — past the glyph and its gap. */
export const ROW_TEXT_INDENT = 21
/** Both lines, plus a little air above and below. */
export const SIDEBAR_ROW_HEIGHT_WITH_CONTEXT =
  ROW_LINE_HEIGHT + ROW_CONTEXT_LINE_HEIGHT + 4

/**
 * How tall a sidebar row is (user report 2026-08-26: "when we have multiples we
 * are hiding the name of the thread").
 *
 * A row that names extra projects gets a second line for them; every other row
 * — project headers, "Show more", threads that live in one project — keeps the
 * 28px it always had. Which is the whole reason `<fl-list>` had to learn
 * variable heights rather than the sidebar simply asking for taller rows: one
 * uniform height is shared by the headers and the folds too, so buying the
 * second line for everyone would have doubled a sidebar that mostly does not
 * need it.
 *
 * `<fl-list>` CLIPS a row to the height it was measured at, so this and the
 * renderer have to agree — a row that draws two lines and is measured at one
 * renders both of them sliced through the middle (#1489 taught the git panel
 * the same lesson).
 *
 * Takes the count rather than the thread so it stays DOM- and model-free.
 */
export function sidebarRowHeight(extraRootCount: number): number {
  return extraRootCount > 0 ? SIDEBAR_ROW_HEIGHT_WITH_CONTEXT : SIDEBAR_ROW_HEIGHT
}

/**
 * A background-work row — a sub-agent nested under the thread that started it.
 *
 * SHORTER THAN A THREAD ROW. It is a footnote about something the conversation
 * above it is waiting on, not another conversation, and four of them at a
 * thread's full pitch push the next project off the screen. The same reasoning
 * the context line already uses for its second line.
 */
export const AGENT_TASK_ROW_HEIGHT = 22
