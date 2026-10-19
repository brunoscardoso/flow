import { test, expect } from './fixtures/electron'
import { sel } from './selectors'

/**
 * Shell chrome: the persistent frame every feature lives inside — titlebar,
 * thread sidebar, editor/side-panel area, and status bar. If these regress,
 * the whole app is unusable, so they're asserted up front.
 */
test.describe('shell chrome', () => {
  test('renders titlebar with brand and project switcher', async ({ window }) => {
    await expect(window.locator(sel.titlebar)).toBeVisible()
    await expect(window.locator(sel.brand)).toHaveText('flow')
    await expect(window.locator(sel.projectSwitcher)).toBeVisible()
    // The switcher is the WORKSPACE switcher now (Workspaces are always on,
    // 2026-10-06): a fresh launch names this machine's Default Workspace, and
    // the sidebar (below) says that no project is open in it yet.
    await expect(window.locator(sel.projectName)).toHaveText('Default')
  })

  test('renders thread sidebar with empty state and toolbar', async ({ window }) => {
    await expect(window.locator(sel.threadSidebar)).toBeVisible()
    // NO PROJECT, NOT NO THREADS. A fresh launch has no project open, and
    // "No threads yet" would be the wrong thing to say about a window that has
    // nowhere to have threads — the sidebar says which of the two it is.
    await expect(window.locator(sel.threadEmpty)).toContainText('Open a project to start')
    // The sidebar's "Add project" button was removed (#128) — adding a project
    // is the titlebar switcher's job. It must NOT be present here anymore.
    await expect(window.locator(sel.addProject)).toHaveCount(0)
    // NEW TASK IS A MENU ITEM NOW, not a toolbar button — it moved into the
    // project row's menu, so a locator for a standalone button finds nothing.
    // The toolbar's own controls are the search field and New thread.
    await expect(window.locator(sel.newTask)).toHaveCount(0)
    await expect(window.locator(sel.newThread)).toBeVisible()
    await expect(window.locator('input[aria-label="Search threads"]')).toBeVisible()
  })

  test('exposes Files + Source Control on the activity-bar rail, with SC view modes (#335/#674)', async ({
    window,
  }) => {
    // Post-#674 the former .fl-sidetabs Files/Source-Control strip is the
    // activity-bar rail (data-rail-item switch items).
    const rail = window.locator('.fl-activity-bar')
    await expect(rail.locator('[data-rail-item="files"]')).toBeVisible()
    await expect(rail.locator('[data-rail-item="source-control"]')).toBeVisible()
    // The view-mode toggle (Changes|Phases) exposes both former surfaces (Git + Review).
    await rail.locator('[data-rail-item="source-control"]').click()
    const views = window.locator(sel.scViewBtn)
    await expect(views.filter({ hasText: 'Changes' })).toBeVisible()
    await expect(views.filter({ hasText: 'Phases' })).toBeVisible()
  })

  test('the status bar is the notification corner; everything else moved out', async ({
    window,
  }) => {
    const bar = window.locator(sel.statusBar)
    await expect(bar).toBeVisible()

    // 2026-09-04: the bar was emptied on the user's call. `flow: <skill>` and
    // the footer terminal button were removed outright, `autopilot on|off`
    // became a toggle in the COMPOSER, and Settings became a gear in the
    // titlebar's top-right. What is left is what is genuinely a notification.
    //
    // Asserted by reading the bar's whole text, not by locating absences: a
    // `not.toBeVisible` passes whether the thing is gone or the selector is
    // simply wrong, and this repo has been burned by exactly that.
    await expect(bar).not.toContainText('flow:')
    await expect(bar).not.toContainText('autopilot')
    await expect(bar).not.toContainText('Settings')
    await expect(bar.locator('.fl-flow-line-inbox')).toBeVisible()

    // THE CHROME ICONS ARE IN ONE ROW NOW — the editor's top bar.
    //
    // They used to be split by accident rather than by rule: a lone gear in the
    // window's corner, and Terminal / Tasks / Blueprint down in the rail beside
    // Threads and Files, where five icons swapped the sidebar and four did
    // something else entirely. The rail keeps what changes the SIDEBAR; the
    // editor's top bar carries what opens a view, plus Settings at the end.
    const topBar = window.locator('.fl-editor-topbar')
    await expect(topBar).toBeVisible()
    for (const action of ['tasks', 'blueprint', 'browser', 'terminal']) {
      await expect(topBar.locator(`[data-view-action="${action}"]`)).toBeVisible()
    }
    await expect(topBar.locator('.fl-titlebar-icon[aria-label="Settings"]')).toBeVisible()

    // …and the rail carries only surfaces that swap the sidebar.
    const rail = window.locator('.fl-activity-bar')
    for (const item of ['threads', 'files', 'source-control']) {
      await expect(rail.locator(`[data-rail-item="${item}"]`)).toBeVisible()
    }
    await expect(rail.locator('[data-rail-item="terminal"]')).toHaveCount(0)
    // Search stopped being a pane on 2026-09-18 — it lives inside Files, with
    // the tree it searches.
    await expect(rail.locator('[data-rail-item="search"]')).toHaveCount(0)
  })
})
