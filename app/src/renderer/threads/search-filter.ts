// Pure thread-search-filter decisions for the sidebar (#386). Kept DOM-free so
// it's unit-testable under the node-env jest that can't import the DOM-coupled
// sidebar component.

/**
 * Whether creating a new thread should clear the active search filter.
 *
 * A freshly-created thread has a default title that cannot match a stale query,
 * so with a filter active the sidebar would keep showing "No threads match …"
 * and the just-created thread would be invisible (#386). Clearing the filter on
 * create guarantees it shows. Only clear when a filter is actually active — an
 * empty query needs no reset (avoids churning the search input for nothing).
 */
export function shouldClearSearchOnThreadCreate(query: string): boolean {
  return query.trim().length > 0
}

/**
 * Whether committing a rename should clear the active search filter (#977).
 *
 * Renaming the only match to a title the live query cannot match made the
 * just-renamed thread vanish behind "No threads match …" — the exact failure
 * #386 fixed for create, one action over. When the new title still matches the
 * query the row survives the filter, so the filter is left alone; when it no
 * longer matches, the filter is cleared so the subject stays visible.
 *
 * #1365: this comment used to claim the substring test was "mirroring the
 * store's LIKE/FTS search on titles". It was not — the store matched by FTS
 * token PREFIX only, so for a whole class of renames the guard said "still
 * matches, keep the filter" while the store disagreed and dropped the row.
 * Renaming to `user_store migration` under the query `store` is one: a
 * substring hit the prefix index cannot see.
 *
 * The claim is now TRUE, because #1364 made the store union its FTS hits with
 * a substring scan. That is why this guard is left as a substring test rather
 * than re-implemented: the rule it mirrors finally matches it. The remaining
 * asymmetry is safe in one direction only — the store ALSO matches message
 * content and token prefixes, so a title miss can over-clear, and clearing
 * only ever reveals more, never hides the renamed thread.
 */
export function shouldClearSearchOnThreadRename(query: string, newTitle: string): boolean {
  const trimmed = query.trim()
  if (trimmed.length === 0) return false
  return !newTitle.toLowerCase().includes(trimmed.toLowerCase())
}
