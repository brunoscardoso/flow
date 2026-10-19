import { test, expect } from '../fixtures/electron'
import type { Page } from '@playwright/test'

/**
 * Regression guard for **PR #550** — "fix(app): modal shortcut isolation +
 * single-instance lock (#525, #544)".
 *
 * Before #550 the shell's capture-phase, VS-Code-parity panel shortcuts (⌘B,
 * ⌃`/⌘J, ⌘⌥C/D/Z) fired regardless of an open modal, mutating the layout behind
 * the Flow/app-settings overlay (and ⌃` opened a terminal that stole focus and
 * killed Escape-to-close). #550 makes the window keydown handler no-op while a
 * `.fl-settings-overlay:not([hidden])` modal is open.
 *
 * This spec drives the observable behavior: with the app Settings overlay open,
 * ⌘B (toggle activity sidebar) must NOT change the sidebar's mount state and must
 * not disturb the overlay; once the overlay is closed, the SAME shortcut toggles
 * the sidebar normally — proving the guard is scoped to "modal open", not a dead
 * shortcut. Asserts observable UX only + zero uncaught pageerrors.
 *
 * The activity sidebar (`.fl-activity-sidebar`) is a root-split child only while
 * `sidebarOpen` is true, so its element count is the ground-truth open/closed
 * signal (1 = open, 0 = closed) — see shell.ts applyLayout.
 */

const SETTINGS_OVERLAY = '.fl-settings-overlay:not([hidden])'
const ACTIVITY_SIDEBAR = '.fl-activity-sidebar'
// ControlOrMeta so the probe holds on both macOS (⌘) and Linux CI (⌃) — the
// shell treats `event.ctrlKey || event.metaKey` as the same panel modifier.
const TOGGLE_SIDEBAR = 'ControlOrMeta+b'

/**
 * Open a settings MODAL — the per-project flow settings.
 *
 * NOT THE APP'S SETTINGS: that is a tabbed page in the editor area now, and a
 * page is not the subject of "does a modal own the keyboard". #525's rule is
 * about modal chrome, and this project still has modal chrome.
 */
async function openSettings(win: Page): Promise<void> {
  await win.evaluate(() => document.dispatchEvent(new CustomEvent('flow:open-flow-settings')))
  await expect(win.locator(SETTINGS_OVERLAY)).toBeVisible()
}

const sidebarCount = (win: Page) => win.locator(ACTIVITY_SIDEBAR).count()

test('⌘B panel shortcut is inert while a settings MODAL is open, live once it closes (#525)', async ({
  window,
}) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))

  // Ground-truth initial mount state of the activity sidebar (robust to whatever
  // the default open/closed state is on a fresh launch).
  const initial = await sidebarCount(window)
  expect(initial === 0 || initial === 1).toBe(true)

  // Open a settings MODAL — it owns the keyboard while it is up.
  await openSettings(window)

  // ⌘B while the modal is open must be a no-op: the sidebar mount state is
  // unchanged AND the overlay stays open (the shortcut never leaked through).
  await window.keyboard.press(TOGGLE_SIDEBAR)
  await expect(window.locator(SETTINGS_OVERLAY)).toBeVisible()
  await expect
    .poll(() => sidebarCount(window))
    .toBe(initial)
  // Give any (buggy) async layout reconcile a beat to have mutated the DOM — it
  // must still match the pre-shortcut state.
  await window.waitForTimeout(150)
  expect(await sidebarCount(window)).toBe(initial)

  // Close the overlay — the keyboard returns to the shell.
  await window.keyboard.press('Escape')
  await expect(window.locator(SETTINGS_OVERLAY)).toHaveCount(0)

  // The very same shortcut now toggles the sidebar (0↔1) — proving the guard was
  // scoped to "modal open", not a globally-dead shortcut.
  await window.keyboard.press(TOGGLE_SIDEBAR)
  await expect
    .poll(() => sidebarCount(window))
    .toBe(initial === 1 ? 0 : 1)

  expect(errors, `uncaught errors: ${errors.join(' | ')}`).toEqual([])
})
