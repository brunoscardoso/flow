import { test, expect } from '../fixtures/electron'
import { sel } from '../selectors'

/**
 * Regression for PR #116 — "surface a toast when review reject fails (#103)".
 * A failed Review reject used to be a silent no-op (the renderer's `rejectFile`
 * catch only `console.error`d then returned). #116 wires it to the same toast
 * bridge as the commit path: the review module now imports `rejectFailedToast`
 * from `review-feedback.ts` and calls `notify(rejectFailedToast(error))` before
 * returning, so the user learns the reject didn't take (the file is still
 * preserved from #102).
 *
 * The failing-reject path itself needs a project + tracked review state + a git
 * failure to fire, none of which is drivable from a fresh, credential-less
 * launch (see e2e/README.md "Known gate": review generation/commit/reject are
 * behind a project + Claude account). The toast-text logic is covered by the
 * pure `rejectFailedToast` unit test. What IS observable headlessly is that the
 * reworked review module still loads and mounts: the new `rejectFailedToast`
 * import must resolve and the Review tab must render its body. A broken export
 * or import from #116 would fail the review bundle and this switch would never
 * surface `.fl-review`. This guards that wiring.
 */
test.describe('PR #116 — review reject-failure toast wiring', () => {
  test('Review tab still mounts its body after the reject-toast rewire', async ({ window }) => {
    // Renderer booted with the reworked review module.
    await expect(window.locator(sel.shell)).toBeVisible()

    // Switch to Review — activates the tab and mounts the review surface. If the
    // new rejectFailedToast import had broken the review bundle, this fails.
    const review = window.locator('[data-rail-item="source-control"]')
    await review.click()
    await expect(review).toHaveClass(/active/)
    await expect(window.locator('.fl-review')).toBeAttached()

    // Renderer stayed alive through the tab switch.
    await expect(window.locator(sel.shell)).toBeVisible()
  })
})
