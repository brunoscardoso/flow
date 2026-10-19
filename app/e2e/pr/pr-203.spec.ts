import { test, expect } from '../fixtures/electron'
import { sel } from '../selectors'

/**
 * Regression for PR #203 — "restore the Git side-panel tab so the panel is
 * reachable again (#198)".
 *
 * The right-hand side panel hosts three bodies — Files, Git, Review — switched
 * by one tab bar. When Review was added, Git lost its tab, and the intended
 * replacement trigger (a status-bar Git button dispatching `flow:show-git`) was
 * never wired. So the Git panel's body stayed mounted but permanently
 * `display:none`: any new/reset user (anyone without a stale persisted
 * `sideTab: 'git'`) had **no reachable way to open Git at all** — silently
 * defeating the just-merged diff-close (#194) and diff-failure-toast (#197)
 * fixes. #203 restores the Git tab alongside Files and Review, so it switches
 * on click like its siblings.
 *
 * This spec guards the reachability regression from a fresh, credential-less
 * launch (no persisted state → Files is the initial tab): the Git tab is present
 * in the bar and, when clicked, becomes active and reveals the real git panel
 * (`.gp-root`, rendered by initGit into the Git body). Before #203 there was no
 * Git tab to click and the body was unreachable.
 */
test.describe('PR #203 — Git side-panel tab reachable', () => {
  test('the rail exposes a Source Control item (was missing pre-#203)', async ({ window }) => {
    await expect(window.locator(sel.shell)).toBeVisible()
    const git = window.locator('[data-rail-item="source-control"]')
    await expect(git).toHaveCount(1)
    // Post-#674 the default active rail switch-item on a fresh launch is Threads,
    // not Source Control (the tab bar became the activity-bar rail).
    await expect(window.locator('.fl-activity-bar .fl-rail-item.active')).toHaveCount(1)
    await expect(window.locator('[data-rail-item="threads"]')).toHaveClass(/active/)
  })

  test('clicking Source Control activates it and reveals the git panel', async ({ window }) => {
    const git = window.locator('[data-rail-item="source-control"]')
    await git.click()
    await expect(git).toHaveClass(/active/)
    // Only one rail switch-item is active at a time — Files yields.
    await expect(window.locator('[data-rail-item="files"]')).not.toHaveClass(/active/)
    // The reachable body is the real git panel initGit mounted, not an empty div.
    await expect(window.locator('.gp-root')).toBeVisible()
  })

  test('can switch back to Files from Source Control', async ({ window }) => {
    await window.locator('[data-rail-item="source-control"]').click()
    const files = window.locator('[data-rail-item="files"]')
    await files.click()
    await expect(files).toHaveClass(/active/)
  })
})
