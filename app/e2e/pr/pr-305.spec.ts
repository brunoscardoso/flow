import { test, expect } from '../fixtures/electron'
import { sel } from '../selectors'

/**
 * Regression for PR #305 — "drop an in-flight diff whose project switched before
 * it resolved (#288)".
 *
 * The git panel is scoped to the active project (ADR-002). Clicking a file row
 * opens its diff asynchronously (`openFileDiff`/`openCommitDiff` await
 * `api.git.diff`, then `diffView.show`). If the user switched projects during
 * that await, the resolved diff used to `diffRoot = rootPath` unconditionally —
 * pinning project A's diff over project B's editor (#288). #305 routes both
 * open paths through a new `commitOpenedDiff(requestedRoot)` that reuses the #191
 * `shouldCloseDiff` staleness predicate: if focus already moved off the requested
 * root (or the root was removed), it `closeDiff()`s and refuses to set `diffRoot`;
 * otherwise it commits the diff.
 *
 * The click-then-switch race itself needs a project + a real git working tree +
 * two roots to fire, which a fresh, credential-less E2E launch can't reach — the
 * git panel shows "No project open" until a project is added, and "Add
 * project" opens a native OS folder picker Playwright can't drive (see
 * e2e/README.md "Known gate"). The staleness predicate is covered by the unit
 * test (`drops an in-flight diff whose focus moved before it resolved (#288)` in
 * `diff-lifecycle.test.ts`).
 *
 * (Note: a residual gap is tracked separately as QA-heartbeat issue #315 —
 * `diffView.show()` still runs *before* `commitOpenedDiff`'s guard, so a stale
 * in-flight diff can briefly flash the wrong project's content and, in a
 * click→switch→click ordering, close the switched-to project's valid diff. This
 * spec does not assert that unfixed behavior.)
 *
 * What IS observable headlessly — and what this spec guards — is that the git
 * renderer module still boots and mounts after #305 rewired `openFileDiff` and
 * `openCommitDiff` through `commitOpenedDiff`. If that edit had broken the git
 * bundle, `initGit` would throw and the Git side tab would never surface
 * `.gp-root`. Switching to the Git tab and asserting the panel root + its empty
 * state guards that the wiring stayed intact.
 */
test.describe('PR #305 — in-flight diff staleness rewire (git panel boots after the fix)', () => {
  test('the Git side panel still mounts its root + empty state after the commitOpenedDiff rewire', async ({
    window,
  }) => {
    // Renderer booted with the reworked git module (openFileDiff/openCommitDiff
    // now commit through commitOpenedDiff instead of assigning diffRoot directly).
    await expect(window.locator(sel.shell)).toBeVisible()

    // Switch to the Git tab — mounts the git panel surface. If #305's rewire had
    // broken the git bundle, initGit would throw and the panel root below would
    // never appear.
    const gitTab = window.locator('[data-rail-item="source-control"]')
    await gitTab.click()
    await expect(gitTab).toHaveClass(/active/)

    // The git panel mounted its root, and on a project-less launch shows the
    // "No project open" empty state (not a crash / blank body).
    await expect(window.locator(sel.gitPanelRoot)).toBeAttached()
    await expect(window.locator(sel.gitPanelEmpty)).toContainText('No project open')

    // Renderer stayed alive through the tab switch.
    await expect(window.locator(sel.shell)).toBeVisible()
  })
})
