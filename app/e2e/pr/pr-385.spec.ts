import { basename } from 'node:path'
import { test, expect } from '../fixtures/electron'
import { sel } from '../selectors'
import { seedProject, cleanupSeeds, activeProjectName, dismissFlowOverlay } from '../ux/fixtures/seed'

/**
 * Regression for PR #385 — "activate the first project when it's opened (#382)".
 *
 * Opening your first/only project called `projectRegistry.addRoot()` only,
 * which broadcasts `rootsChanged` but NOT `activeProjectChanged`. Since nothing
 * else activated the new root, the titlebar switcher, Files tree, editor and
 * terminals — all bound to `project:activeChanged` — stayed on the
 * "No project" empty state until the user clicked the project a SECOND time. The
 * app's primary entry action visibly half-failed on first use.
 *
 * #385 routes both `project:add` and `project:open` through a
 * shared `addRootAndMaybeActivate` helper that, when `activeRoot() === null`,
 * enters the root via `setActiveProject` (firing `activeProjectChanged`) using
 * the canonical path `addRoot` returns. Guarding on "nothing active" means
 * adding a SECOND project while already inside one won't yank the user out.
 *
 * `seedProject` calls the real `project:add` IPC bridge and NOTHING else —
 * exactly the state the app is in the instant a user finishes "Open Project…".
 * So a bare `seedProject()` on a fresh launch (nothing active yet) is the precise
 * first-open path #385 fixes. This spec asserts the observable fix: after that
 * single addRoot the titlebar switcher shows the project's name and the Files
 * tree leaves its "No project open" empty state — WITHOUT a second click. A
 * regression that dropped the activation would leave the titlebar on "No project".
 */
test.describe('PR #385 — first project activates on open (#382)', () => {
  test.afterAll(() => cleanupSeeds())

  test('fresh launch shows the "No project" empty state', async ({ window }) => {
    await expect(window.locator(sel.projectSwitcher)).toBeVisible()
    await expect.poll(() => activeProjectName(window)).toBe('')
    // The hint lives in the Files panel; the default rail is Threads.
    await window.locator('.fl-activity-bar [data-rail-item="files"]').click()
    await expect(window.locator('.fl-sidebar-files').getByText('No project open')).toBeVisible()
  })

  test('opening the first project (addRoot only) activates it — no second click', async ({
    window,
  }) => {
    const errors: string[] = []
    window.on('pageerror', (e) => errors.push(String(e)))

    // addRoot ONLY — mirrors the real openProject handler finishing. Nothing is
    // active yet, so #385's helper must enter this root automatically.
    const root = await seedProject(window)

    // The titlebar switcher follows the newly-activated project (was the #382 bug).
    await expect.poll(() => activeProjectName(window)).toBe(basename(root))

    // The Files panel left its empty state — a project is genuinely open now.
    // (A first-visit project raises its flow-settings overlay; let it go first.)
    await dismissFlowOverlay(window)
    await window.locator('.fl-activity-bar [data-rail-item="files"]').click()
    await expect(window.locator('.fl-sidebar-files').getByText('No project open')).toBeHidden()

    expect(errors, errors.join(', ')).toEqual([])
  })
})
