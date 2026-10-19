import { test, expect } from '../fixtures/electron'
import { sel } from '../selectors'

/**
 * Regression for PR #181 — "commit new untracked directories instead of
 * dropping them (#176)".
 *
 * A wholly-new untracked directory is surfaced by `git status --porcelain=v2`
 * as a single trailing-slash entry (`newfeature/`). The Review panel's commit
 * paths used to `.filter((p) => !p.endsWith('/'))` those entries out BEFORE
 * calling `git:commit`, then bail on the emptiness guard — so a directory-only
 * phase group's Commit was a dead no-op and mixed groups committed their files
 * while silently leaving the new directory uncommitted. #181 replaces both
 * filters with a shared `commitPaths` helper (in `review-approval.ts`) that
 * KEEPS trailing-slash directory entries; the git layer's `ensureInsideRoot`
 * strips the slash so `git add -- newfeature` stages the whole directory.
 *
 * The commit path itself needs a project + tracked review state + a real
 * untracked directory to fire, none of which is drivable from a fresh,
 * credential-less launch (see e2e/README.md "Known gate": review
 * generation/commit is behind a project + Claude account). The pathspec logic
 * is covered by the pure `commitPaths` unit tests and a real-temp-repo
 * git-manager test. What IS observable headlessly is that the reworked review
 * bundle still loads and mounts: `renderer/review/index.ts` now imports
 * `commitPaths` from `review-approval.ts`, and a broken export/import would
 * fail the review bundle so the Review tab would never surface `.fl-review`.
 * This guards that wiring.
 */
test.describe('PR #181 — commit new untracked directories', () => {
  test('Review tab still mounts its body after the commitPaths rewire', async ({ window }) => {
    // Renderer booted with the reworked review module (new commitPaths import).
    await expect(window.locator(sel.shell)).toBeVisible()

    // Switch to Review — activates the tab and mounts the review surface. If the
    // new commitPaths import had broken the review bundle, this would fail.
    const review = window.locator('[data-rail-item="source-control"]')
    await review.click()
    await expect(review).toHaveClass(/active/)
    await expect(window.locator('.fl-review')).toBeAttached()

    // Fresh launch has no project → the review body renders its empty state via
    // the same #render() path the commit rework runs through.
    await expect(window.locator('.fl-review-empty')).toHaveText('No project open')

    // Renderer stayed alive through the tab switch.
    await expect(window.locator(sel.shell)).toBeVisible()
  })
})
