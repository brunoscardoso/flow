import { test, expect } from '../fixtures/electron'
import { sel } from '../selectors'

/**
 * Regression for PR #249 — "preview new untracked directories instead of EISDIR
 * (#247)". git rolls a brand-new untracked directory up into one trailing-slash
 * `status --porcelain` entry (`newfeature/`), rendered as a single clickable git
 * -panel row. Before #249 that row was a dead end: `GitManager.diff` read the
 * working-tree side with `fsPromises.readFile(root/dir)` → **EISDIR**, and the
 * renderer's `openFileDiff` short-circuited on `filePath.endsWith('/')` (a no-op
 * click). #249:
 *   - `diff()` detects a trailing-slash directory entry (working-tree side, no
 *     commit) and returns a placeholder `GitDiff` listing the folder's files
 *     (recursive, sorted, empty `before`) via a new `directoryDiff` helper;
 *   - the renderer removed the `endsWith('/')` early-return in `openFileDiff`, so
 *     a new-folder row opens that listing like any other diff row.
 *
 * The directory-click path itself needs a project + a real git working tree to
 * fire, which a fresh, credential-less E2E launch can't reach — the git panel
 * shows "No project open" until a project is added, and "Open Folder…" opens a
 * native OS folder picker Playwright can't drive (see e2e/README.md "Known
 * gate"). The directory-listing logic is covered by the git-manager unit test
 * (`previews a new untracked DIRECTORY as a file listing instead of EISDIR
 * (#247)`), which asserts the recursive, sorted, empty-`before` listing.
 *
 * What IS observable headlessly — and what this spec guards — is that the
 * reworked git renderer module still boots and mounts. #249 edited the git
 * bundle's `openFileDiff` (dropping the trailing-slash guard); if that edit had
 * broken the bundle, the Git side tab would never surface `.gp-root`. Switching
 * to the Git tab and asserting the panel root + its empty state guards that
 * wiring stayed intact.
 *
 * (Note: a follow-up gap is tracked separately as QA-heartbeat issue #253 — the
 * listing is built from a raw `readdir` walk that ignores `.gitignore`, so it
 * can show files a commit would exclude. This spec does not assert that unfixed
 * behavior.)
 */
test.describe('PR #249 — new-untracked-directory preview wiring', () => {
  test('the Git side panel still mounts its root + empty state after the openFileDiff rewire', async ({
    window,
  }) => {
    // Renderer booted with the reworked git module (openFileDiff no longer
    // short-circuits on trailing-slash directory rows).
    await expect(window.locator(sel.shell)).toBeVisible()

    // Switch to the Git tab — mounts the git panel surface. If #249's edit to
    // openFileDiff had broken the git bundle, initGit would throw and the panel
    // root below would never appear.
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
