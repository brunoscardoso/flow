import { test, expect } from '../fixtures/electron'
import { sel } from '../selectors'

/**
 * Regression for PR #334 — "show a 'No threads match' state on a no-match
 * search (#326)".
 *
 * The thread sidebar's `#groupRows` pushes a header for EVERY project root
 * (even one with zero threads — the header is the project-management surface),
 * so during a search that matched nothing `rows.length > 0` (the bare headers)
 * and the `.fl-thread-empty` hint never showed. A no-match search was visually
 * indistinguishable from an empty project — the user couldn't tell whether the
 * search ran, was loading, or genuinely found nothing. #334 suppresses empty
 * group headers while searching (a no-match search collapses to zero rows) and
 * makes the empty hint search-aware: "No threads match “<query>”" while
 * searching, "No threads yet" otherwise.
 *
 * The pure decisions (`shouldRenderGroupHeader`, `emptySidebarMessage`) are
 * covered by `thread-search-empty.test.ts`; this spec guards the headlessly
 * observable user-facing behavior: from a fresh, credential-less launch (no
 * threads), typing a query flips the empty hint from the first-run "No threads
 * yet" to a query-naming "No threads match …" state, and clearing the query
 * restores the first-run hint. A regression that stopped threading the query
 * into the hint (or re-showed the bare "No threads yet" during search) would
 * fail these assertions.
 */
test.describe('PR #334 — thread search shows a "No threads match" empty state (#326)', () => {
  test('a no-match search names the query; clearing it restores the first-run hint', async ({
    window,
  }) => {
    const search = window.locator('.fl-thread-search input').first()
    const empty = window.locator(sel.threadEmpty)
    // The first-run hint is the Workspace's (every project belongs to one now):
    // a fresh launch's Default Workspace has no project open, so it says so
    // rather than "No threads yet" (workspace-switcher-model emptyWorkspaceMessage).
    const firstRun = /^None of .+'s projects are open in Flow yet$/

    // Fresh launch: no threads, no active search → first-run hint.
    await expect(empty).toHaveText(firstRun)

    // Typing a query that matches nothing must surface a search-aware empty
    // state that NAMES the query (curly quotes are intentional — U+201C/U+201D).
    await search.fill('zzz-nonexistent-query')
    await expect(empty).toHaveText('No threads match “zzz-nonexistent-query”')
    await expect(empty).toBeVisible()

    // A different query updates the named empty state in place.
    await search.fill('another-miss')
    await expect(empty).toHaveText('No threads match “another-miss”')

    // Clearing the query drops back to the first-run hint (not a stale search
    // message) — the non-search path is unchanged by #334.
    await search.fill('')
    await expect(empty).toHaveText(firstRun)
  })
})
