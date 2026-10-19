import { test, expect } from '../fixtures/electron'
import { sel } from '../selectors'
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed'

/**
 * Flow 12 — rail-digit shortcuts (⌘1-3) vs. focus-mode SCOPE (⌘⌥Z, #616/#713/#836).
 *
 * Focus mode is a distraction-free, editor-only overlay: it hides the Chat panel
 * AND (since #713) the whole activity sidebar. Exit (Escape / ⌘⌥Z) RESTORES the
 * user's prior sidebar state, because `sidebarOpen` / `activeRailItem` are left
 * untouched behind the overlay (shell.ts applyLayout gates the sidebar render on
 * `sidebarOpen && !focusMode`).
 *
 * #836 fixed ⌘B leaking through focus mode: `else if (key === 'b' ...)` now only
 * calls `setSidebarVisible` when `!layout.focusMode` (shell.ts ~573). But the
 * SIBLING rail-digit shortcuts — ⌘1/⌘2/⌘3 (shell.ts ~554-556) — still call
 * `onRailSelect(...)` UNCONDITIONALLY, and `onRailSelect` (shell.ts ~262) sets
 * `sidebarOpen = true` and swaps `activeRailItem` with NO focus-mode guard. So a
 * user who reflexively taps ⌘1/2/3 inside focus mode silently mutates the very
 * restore state focus-exit relies on — the exact leak #836 fixed for ⌘B, still
 * live for its rail-digit siblings (the round-12 probe flagged this by name).
 *
 * The live guard below proves the SIBLING contract that was actually fixed (⌘B
 * inert in focus mode). The fixme tripwire pins the un-fixed ⌘1-3 leak: a
 * rail-digit in focus mode must NOT reopen a sidebar the user had closed. Flip it
 * live once shell.ts gates the ⌘1-3 branch on `!layout.focusMode` too.
 */
const activitySidebar = '.fl-activity-sidebar'

test.describe('flow 12 — rail digits (⌘1-3) vs focus-mode scope (#836 sibling)', () => {
  test.afterAll(() => cleanupSeeds())

  // LIVE GUARD (passes on main): ⌘B is inert under focus mode (#836). A user who
  // closes the sidebar, enters focus mode, taps ⌘B, and exits keeps it closed —
  // the guarded ⌘B branch never flips `sidebarOpen` behind the overlay.
  test('⌘B is inert under focus mode — closed sidebar stays closed on exit (#836)', async ({
    window,
  }) => {
    const errors: string[] = []
    window.on('pageerror', (e) => errors.push(String(e)))

    const root = await seedProject(window)
    await activateProject(window, root)

    const sidebar = window.locator(activitySidebar)
    const focusHint = window.locator(sel.focusHint)

    // Close the sidebar first (⌘B in the NORMAL layout — legitimately toggles it).
    await expect(sidebar).toBeVisible()
    await window.keyboard.press('ControlOrMeta+KeyB')
    await expect(sidebar).toBeHidden()

    // Enter focus mode, reflexively tap ⌘B (inert since #836), exit.
    await window.keyboard.press('ControlOrMeta+Alt+KeyZ')
    await expect(focusHint).toBeVisible()
    await window.keyboard.press('ControlOrMeta+KeyB')
    await window.keyboard.press('Escape')
    await expect(focusHint).toBeHidden()

    // Restore state intact: the sidebar the user CLOSED stays closed.
    await expect(sidebar).toBeHidden()
    expect(errors.filter((e) => !/Canceled/.test(e))).toEqual([])
  })

  // #924 (fixed): a rail digit (⌘2) pressed inside focus mode used to call
  // onRailSelect, forcing `sidebarOpen = true` behind the overlay. onRailSelect
  // is now inert under focus mode (swallowedByFocusMode — covering ⌘1-3 AND the
  // rail icon clicks), so a sidebar the user CLOSED stays closed on exit.
  test(
    'rail digit (⌘2) in focus mode must not silently reopen a closed sidebar on exit',
    async ({ window }) => {
      const errors: string[] = []
      window.on('pageerror', (e) => errors.push(String(e)))

      const root = await seedProject(window)
      await activateProject(window, root)

      const sidebar = window.locator(activitySidebar)
      const focusHint = window.locator(sel.focusHint)

      await expect(sidebar).toBeVisible()
      await window.keyboard.press('ControlOrMeta+KeyB')
      await expect(sidebar).toBeHidden()

      await window.keyboard.press('ControlOrMeta+Alt+KeyZ')
      await expect(focusHint).toBeVisible()
      // Reflexive ⌘2 (Files) while in focus mode — no visible effect (can't render).
      await window.keyboard.press('ControlOrMeta+Digit2')

      await window.keyboard.press('Escape')
      await expect(focusHint).toBeHidden()
      // Expected: the sidebar the user CLOSED must stay closed — the rail digit
      // must not have flipped `sidebarOpen` behind the overlay. Fails today.
      await expect(sidebar).toBeHidden()

      expect(errors.filter((e) => !/Canceled/.test(e))).toEqual([])
    },
  )
})
