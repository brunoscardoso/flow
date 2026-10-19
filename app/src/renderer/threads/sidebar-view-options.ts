// HOW A PROJECT'S LIST IS ORDERED, AND WHETHER IT SHOWS WHAT WAS PUT AWAY.
//
// Both answers used to be somewhere else, or nowhere:
//
//  · ORDER was not a question. The list is newest-first, always, and a person
//    looking for a conversation they named — rather than one they touched an
//    hour ago — had to scroll for it.
//  · ARCHIVED was a row at the BOTTOM of the whole sidebar: "Archived (4)",
//    under every project, expanding into a mixed pile. The user's objection is
//    where it lives — "i don't like where we are showing the archive access" —
//    and the fix is that both belong on the project they are about, beside the
//    `+` that already acts on it.
//
// Pure: no DOM, no storage. It decides what the menu offers, what the list is
// sorted by, and what a stored answer means; the sidebar performs it.

/** The orders a project's list can be in. */
export type SidebarOrder = 'recent' | 'name' | 'created'

/** What each order is called, in the menu, in the order they are offered. */
export const SIDEBAR_ORDERS: readonly { value: SidebarOrder; label: string }[] = [
  // RECENT FIRST, because it is the default and the one most presses confirm.
  { value: 'recent', label: 'Last updated' },
  { value: 'created', label: 'Newest first' },
  { value: 'name', label: 'Name' },
]

/** Everything a project's list remembers about how it is shown. */
export interface SidebarViewOptions {
  order: SidebarOrder
  /** Whether the list includes what was archived. */
  showArchived: boolean
}

/** What a project's list does before anybody has said otherwise. */
export function defaultViewOptions(): SidebarViewOptions {
  // NEWEST-FIRST AND NO ARCHIVE — exactly what the sidebar did before it could
  // be asked. A new control must not change what an existing reader sees until
  // they use it.
  return { order: 'recent', showArchived: false }
}

/** Where one project's answers live. Per project: a repo's order is its own. */
export function viewOptionsStorageKey(projectRoot: string): string {
  return `flow.sidebar.view:${projectRoot}`
}

/**
 * The key the one list answers with BEFORE it knows its Workspace.
 *
 * The sidebar mounts on `{ kind: 'none' }` and learns its Workspace from a
 * subscription, so this is a window a person can really act in — not a
 * theoretical one.
 */
export const UNRESOLVED_LIST_KEY = 'workspace:'

/**
 * Whether an answer stored before the scope resolved belongs to the list it
 * resolved INTO.
 *
 * A PRESS IN THAT WINDOW WAS BEING LOST. The list keys its answers on its
 * Workspace, so pressing "Archived (N)" in the first seconds after launch
 * stored the answer under `UNRESOLVED_LIST_KEY`; the resolve then re-rendered
 * against `workspace:<slug>`, which nobody had written, and the archive shut
 * again with nothing on screen to explain it. Measured on a seeded project: the
 * first press did nothing, the second worked, and an 8s wait before the first
 * press made it work — which is the shape of a race, not of a preference.
 *
 * Carried ONCE, and never over an answer the real key already holds: a press
 * made before this list knew what it was is weaker evidence than anything the
 * Workspace has since said about itself.
 */
export function carriesViewOptionsForward(
  previousKey: string,
  nextKey: string,
  storedAtPrevious: string | null,
  storedAtNext: string | null,
): boolean {
  return (
    previousKey === UNRESOLVED_LIST_KEY &&
    nextKey !== UNRESOLVED_LIST_KEY &&
    storedAtPrevious !== null &&
    storedAtNext === null
  )
}

/**
 * A stored answer, or the default.
 *
 * VALIDATED, NEVER TRUSTED. What comes back is a string this build did not
 * write — a value from a newer version that knows an order this one does not,
 * or a hand-edit. An unrecognised word is no answer at all rather than an order
 * nothing can sort by, and the list then reads exactly as it did before anybody
 * touched it.
 */
export function readViewOptions(stored: string | null): SidebarViewOptions {
  const fallback = defaultViewOptions()
  if (stored === null || stored.trim().length === 0) return fallback
  let parsed: unknown
  try {
    parsed = JSON.parse(stored)
  } catch {
    return fallback
  }
  if (typeof parsed !== 'object' || parsed === null) return fallback
  const record = parsed as Record<string, unknown>
  const order = SIDEBAR_ORDERS.find((entry) => entry.value === record['order'])?.value
  return {
    order: order ?? fallback.order,
    showArchived: record['showArchived'] === true,
  }
}

/** The stored form. */
export function writeViewOptions(options: SidebarViewOptions): string {
  return JSON.stringify({ order: options.order, showArchived: options.showArchived })
}

/** The half of a row this module sorts by. */
export interface OrderableRow {
  title: string
  updatedAt: string
  createdAt: string
}

/**
 * Compare two rows in the given order.
 *
 * EVERY ORDER ENDS IN A TIE-BREAK on the title, so a list of rows written in
 * the same second does not shuffle between renders — the sidebar re-renders on
 * every thread update, and a list that reorders under a click is the same
 * defect the board fixed for its lanes (#1192).
 */
export function compareInOrder(a: OrderableRow, b: OrderableRow, order: SidebarOrder): number {
  if (order === 'name') {
    return a.title.localeCompare(b.title) || a.updatedAt.localeCompare(b.updatedAt)
  }
  if (order === 'created') {
    return b.createdAt.localeCompare(a.createdAt) || a.title.localeCompare(b.title)
  }
  return b.updatedAt.localeCompare(a.updatedAt) || a.title.localeCompare(b.title)
}

/** The menu's own label for the current order — the row a person reads first. */
export function orderLabel(order: SidebarOrder): string {
  return SIDEBAR_ORDERS.find((entry) => entry.value === order)?.label ?? 'Last updated'
}

/**
 * What the archived row says.
 *
 * THE COUNT IS THE NEWS. The section is otherwise closed and empty-looking, so
 * the number is the only thing saying there is anything to press for — the same
 * reason the old bottom-of-the-sidebar header carried one.
 */
export function archivedToggleLabel(count: number): string {
  return count === 1 ? 'Archived (1)' : `Archived (${String(count)})`
}

/** What pressing the archived option does, said as the list it changes. */
export function archivedToggleTitle(showing: boolean, count: number): string {
  if (count === 0) return 'Nothing in this project has been archived.'
  return showing
    ? 'Hide archived conversations and tasks from this list'
    : 'Show archived conversations and tasks in this list'
}
