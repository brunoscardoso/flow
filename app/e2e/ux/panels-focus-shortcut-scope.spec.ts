import { test, expect } from '../fixtures/electron'
import { sel } from '../selectors'
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed'

/**
 * Flow 12 — panel-toggle shortcuts vs. focus mode SCOPE (⌘⌥Z, #616/#713).
 *
 * Focus mode is a distraction-free, editor-only view: entering it hides the Chat
 * panel AND (since #713) the whole activity sidebar; `syncToggleStates` keeps the
 * titlebar toggle honest. Escape / ⌘⌥Z exit and RESTORE the user's prior sidebar
 * state, because `sidebarOpen` itself is left untouched while focus mode overlays
 * it (shell.ts applyLayout gates the sidebar render on `sidebarOpen && !focusMode`).
 *
 * BUT the global keydown handler (shell.ts ~502, capture phase) guards ONLY
 * Escape against focus mode. ⌘B (`setSidebarVisible(!sidebarOpen)`) falls straight
 * through while focus mode is on — and MUTATES the very `sidebarOpen` state that
 * focus-mode-exit relies on to restore the layout, with NO visible effect
 * (applyLayout won't render the sidebar under focus mode). So a user who
 * reflexively taps ⌘B in focus mode (near-universal muscle memory) silently
 * inverts their restore state: exiting focus mode drops the sidebar they had
 * open — a dead control that also corrupts state.
 *
 * The CONTROL below (live guard, passes on main) proves the seam restores the
 * sidebar on a clean focus enter→exit. The second test guards the EXPECTED
 * distraction-free contract (⌘B in focus mode must be inert w.r.t. the post-exit
 * layout) that FAILS today; flip it live once the shell guards ⌘B (and the
 * ⌘1-3 rail digits, same `onRailSelect` fall-through) against focus mode.
 */
const activitySidebar = '.fl-activity-sidebar'

test.describe('flow 12 — panel shortcuts vs focus-mode scope (#616/#713)', () => {
  test.afterAll(() => cleanupSeeds())

  // CONTROL (live guard): a clean focus enter → exit restores the sidebar the
  // user had open. This is what isolates ⌘B as the culprit in the tripwire.
  test('a clean focus-mode enter→exit restores the open sidebar', async ({ window }) => {
    const errors: string[] = []
    window.on('pageerror', (e) => errors.push(String(e)))

    const root = await seedProject(window)
    await activateProject(window, root)

    const sidebar = window.locator(activitySidebar)
    const focusHint = window.locator(sel.focusHint)

    await expect(sidebar).toBeVisible()

    await window.keyboard.press('ControlOrMeta+Alt+KeyZ')
    await expect(focusHint).toBeVisible()
    await expect(sidebar).toBeHidden()

    await window.keyboard.press('Escape')
    await expect(focusHint).toBeHidden()
    // No ⌘B was pressed → the sidebar returns exactly as the user left it.
    await expect(sidebar).toBeVisible()

    expect(errors.filter((e) => !/Canceled/.test(e))).toEqual([])
  })

  // TRIPWIRE (#836): ⌘B pressed inside focus mode silently flips sidebarOpen
  // behind the overlay, so exiting focus mode drops the sidebar the user had.
  // Expected (post-fix): ⌘B in focus mode is inert w.r.t. the restored layout,
  // so the sidebar returns on exit exactly as in the control. FAILS today.
  test(
    '⌘B pressed inside focus mode must not silently drop the sidebar on exit',
    async ({ window }) => {
      const errors: string[] = []
      window.on('pageerror', (e) => errors.push(String(e)))

      const root = await seedProject(window)
      await activateProject(window, root)

      const sidebar = window.locator(activitySidebar)
      const focusHint = window.locator(sel.focusHint)

      await expect(sidebar).toBeVisible()

      await window.keyboard.press('ControlOrMeta+Alt+KeyZ')
      await expect(focusHint).toBeVisible()
      await expect(sidebar).toBeHidden()

      // Reflexive ⌘B while in focus mode — no visible effect (can't render).
      await window.keyboard.press('ControlOrMeta+KeyB')
      await expect(sidebar).toBeHidden()

      // Exit focus mode: the sidebar was OPEN before entering, so it must return.
      await window.keyboard.press('Escape')
      await expect(focusHint).toBeHidden()
      await expect(sidebar).toBeVisible() // ← fails today: silently dropped.

      expect(errors.filter((e) => !/Canceled/.test(e))).toEqual([])
    },
  )
})
