import { test, expect } from '../fixtures/electron'
import { sel } from '../selectors'

/**
 * Regression for PR #146 — "Discard all / reject must remove new untracked
 * directories (#136)". Git rolls a wholly-new directory up as a single
 * trailing-slash `status --porcelain` entry (`newfeature/`). Before #146 the
 * renderer's `discardGroup` filtered every trailing-slash path out
 * (`!path.endsWith('/')`) while the confirm still counted them, so discarding a
 * group whose only change was a new directory was a silent no-op; and
 * `GitManager.revertFile` called `fsPromises.rm(path, { force: true })` without
 * `recursive: true`, throwing `ERR_FS_EISDIR` on a directory. #146:
 *   - `revertFile` removes unknown-at-HEAD paths with `{ recursive: true,
 *     force: true }` so a new directory is actually deleted (fixes reject too);
 *   - `discardGroup` reverts EVERY entry (drops the trailing-slash filter), so
 *     the loop acts on the same set the confirm counts.
 *
 * The directory-discard path itself needs a project + real git working-tree
 * state to fire, which isn't drivable from a fresh, credential-less launch (see
 * e2e/README.md "Known gate": review commit/discard/reject sit behind a project
 * + Claude account, and "Add project" opens a native OS folder picker Playwright
 * can't drive). The trailing-slash/recursive logic itself is covered by the
 * git-manager unit test (`revertFile removes a wholly-new untracked DIRECTORY`).
 * What IS observable headlessly is that the reworked review module still loads
 * and mounts — the #146 edits to `discardGroup` must not have broken the review
 * bundle, or the Review tab would never surface `.fl-review`. This guards that
 * wiring. (Note: the symmetric COMMIT path still filters trailing-slash entries
 * and silently drops new directories — tracked separately as a QA-heartbeat
 * issue; this spec does not assert that unfixed behavior.)
 */
test.describe('PR #146 — new-untracked-directory discard wiring', () => {
  test('Review tab still mounts its body after the directory-discard rewire', async ({ window }) => {
    // Renderer booted with the reworked review module (discardGroup no longer
    // filters trailing-slash directory entries).
    await expect(window.locator(sel.shell)).toBeVisible()

    // Switch to Review — activates the tab and mounts the review surface. If the
    // #146 change to discardGroup had broken the review bundle, this would fail.
    const review = window.locator('[data-rail-item="source-control"]')
    await review.click()
    await expect(review).toHaveClass(/active/)
    await expect(window.locator('.fl-review')).toBeAttached()

    // Renderer stayed alive through the tab switch.
    await expect(window.locator(sel.shell)).toBeVisible()
  })
})
