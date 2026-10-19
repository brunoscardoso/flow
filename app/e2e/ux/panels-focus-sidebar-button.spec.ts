import { test, expect } from '../fixtures/electron'
import { sel } from '../selectors'
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed'

/**
 * Flow 12 — the titlebar sidebar BUTTON vs. focus-mode scope (#836's mouse path).
 *
 * #836 made ⌘B inert under focus mode (shell.ts ~595: `if (!layout.focusMode)
 * setSidebarVisible(...)`) because the sidebar can't render there — flipping
 * `sidebarOpen` behind the overlay silently rewrites the layout the user gets
 * back on exit. The titlebar button that carries the SAME action (and the tooltip
 * "Toggle sidebar (⌘B)") was not covered: its click handler (shell.ts ~453) calls
 * `setSidebarVisible(!sidebarOpen)` unconditionally, and focus mode leaves the
 * button on screen, visible and enabled.
 *
 * So the same user intent has two opposite behaviors depending on input device:
 * the shortcut is correctly inert, the button is a dead click that still mutates
 * the restore state (#968).
 */
const activitySidebar = '.fl-activity-sidebar'

test.describe('flow 12 — titlebar sidebar button vs focus-mode scope (#836 mouse path)', () => {
  test.afterAll(() => cleanupSeeds())

  // LIVE GUARD (passes on main): in the NORMAL layout the titlebar button is an
  // honest toggle — it hides and re-shows the activity sidebar.
  test('titlebar sidebar button round-trips the sidebar in the normal layout', async ({
    window,
  }) => {
    const errors: string[] = []
    window.on('pageerror', (e) => errors.push(String(e)))

    const root = await seedProject(window)
    await activateProject(window, root)

    const sidebar = window.locator(activitySidebar)
    const toggleBtn = window.locator(sel.sidebarToggle).first()

    await expect(sidebar).toBeVisible()
    await toggleBtn.click()
    await expect(sidebar).toBeHidden()
    await toggleBtn.click()
    await expect(sidebar).toBeVisible()

    expect(errors.filter((e) => !/Canceled/.test(e))).toEqual([])
  })

  // LIVE GUARD (passes on main): focus mode keeps the button on screen — it is
  // visible and enabled, so a user has every reason to believe it still works.
  // (This is the premise of the tripwire below, pinned so a future "hide the
  // titlebar under focus mode" fix visibly changes this expectation.)
  test('focus mode leaves the sidebar button visible and enabled', async ({ window }) => {
    const root = await seedProject(window)
    await activateProject(window, root)

    const focusHint = window.locator(sel.focusHint)
    const toggleBtn = window.locator(sel.sidebarToggle).first()

    await window.keyboard.press('ControlOrMeta+Alt+KeyZ')
    await expect(focusHint).toBeVisible()
    await expect(window.locator(activitySidebar)).toBeHidden()
    await expect(toggleBtn).toBeVisible()
    await expect(toggleBtn).toBeEnabled()
    await expect(toggleBtn).toHaveAttribute('title', /Toggle sidebar/)

    await window.keyboard.press('Escape')
    await expect(focusHint).toBeHidden()
  })

  // #968 (fixed): clicking that visible, enabled button inside focus mode used to
  // do nothing on screen yet close the sidebar the user had open. The button and
  // ⌘B now share one guarded path (toggleSidebarFromUser → swallowedByFocusMode),
  // so the click is inert and the sidebar comes back exactly as it was.
  test(
    'sidebar button click in focus mode must not silently close the open sidebar',
    async ({ window }) => {
      const errors: string[] = []
      window.on('pageerror', (e) => errors.push(String(e)))

      const root = await seedProject(window)
      await activateProject(window, root)

      const sidebar = window.locator(activitySidebar)
      const focusHint = window.locator(sel.focusHint)
      const toggleBtn = window.locator(sel.sidebarToggle).first()

      await expect(sidebar).toBeVisible()

      await window.keyboard.press('ControlOrMeta+Alt+KeyZ')
      await expect(focusHint).toBeVisible()
      // Dead click: the sidebar cannot render here, so nothing responds.
      await toggleBtn.click()
      await expect(sidebar).toBeHidden()

      await window.keyboard.press('Escape')
      await expect(focusHint).toBeHidden()
      // Expected: the sidebar the user had OPEN is still open. Fails today —
      // the unguarded click flipped `sidebarOpen` behind the overlay.
      await expect(sidebar).toBeVisible()

      expect(errors.filter((e) => !/Canceled/.test(e))).toEqual([])
    },
  )
})
