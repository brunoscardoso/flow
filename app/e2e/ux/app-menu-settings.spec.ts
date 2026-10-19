import { test, expect } from '../fixtures/electron'

/**
 * UX-sweep regression probe — the application menu's Settings… item (#1159).
 *
 * Flow ships a full native menu bar with accelerators on almost every item
 * (⌘W, ⌘R, ⌘0, ⌘M, ⌃⌘F, ⌥⌘I …). The one item every desktop app has was
 * missing: no `Flow ▸ Settings…`, and ⌘, bound to nothing. The Settings
 * surface existed and was fine — it was reachable only by CLICKING the
 * titlebar accounts control or the status-bar ⚙, or by knowing to open the
 * palette and type "Open Settings". ⌘, is the first thing a user tries.
 *
 * Electron's `appMenu` role is a fixed composite with no Preferences item, so
 * the macOS app menu had to be spelled out. This probe asserts the item exists
 * with the right accelerator and that firing it really opens the overlay —
 * a menu item that opens nothing would pass a shape-only check.
 *
 * The accelerator itself can't be typed here: Playwright's keyboard sends keys
 * to the WEB CONTENTS, and native menu accelerators are handled by the OS
 * before that. Clicking the menu item is the honest end-to-end equivalent.
 */

// The app's Settings is a tabbed PAGE in the editor area now, not the overlay
// it was when #1159 was filed (selectors.ts `settingsPage`).
const SETTINGS = '.fl-settings-page'

interface MenuItemShape {
  label: string
  accelerator: string | null
  enabled: boolean
}

test('the app menu offers Settings… on ⌘,/Ctrl+, and it opens Settings', async ({
  window,
  app,
}) => {
  const errors: string[] = []
  window.on('pageerror', (error) => errors.push(error.message))

  // ── The item exists, in a top-level menu, with the conventional accelerator.
  const found = await app.evaluate(({ Menu }) => {
    const menu = Menu.getApplicationMenu()
    if (menu === null) return null
    for (const top of menu.items) {
      for (const item of top.submenu?.items ?? []) {
        if (/settings|preferences/i.test(item.label)) {
          return {
            menu: top.label,
            label: item.label,
            accelerator: item.accelerator ?? null,
            enabled: item.enabled,
          }
        }
      }
    }
    return null
  })

  expect(found, 'no Settings/Preferences item anywhere in the application menu').not.toBeNull()
  expect(found?.accelerator).toBe('CmdOrCtrl+,')
  expect(found?.enabled).toBe(true)
  // macOS convention puts it in the app menu; elsewhere, under File.
  expect(found?.menu).toBe(process.platform === 'darwin' ? 'Flow' : 'File')

  // ── …and firing it actually opens the surface (not a dead menu entry).
  await expect(window.locator(SETTINGS)).toHaveCount(0)
  await app.evaluate(({ Menu }) => {
    const menu = Menu.getApplicationMenu()
    for (const top of menu?.items ?? []) {
      for (const item of top.submenu?.items ?? []) {
        if (/settings|preferences/i.test(item.label)) {
          item.click()
          return
        }
      }
    }
  })
  await expect(window.locator(SETTINGS)).toBeVisible({ timeout: 8000 })

  expect(errors, errors.join(', ')).toEqual([])
})

test('the menu keeps its other accelerators (⌘W stays Close Tab)', async ({ app, window }) => {
  // Wait for the first window before reading main: evaluated during startup,
  // main's context can be replaced under the call ("Execution context was
  // destroyed") — the menu is built by then either way.
  await window.waitForLoadState('domcontentloaded')
  // Guard against the fix regressing #673: the macOS app menu is now spelled
  // out by hand, so the surrounding roles must still be there.
  const shape = await app.evaluate(({ Menu }) => {
    const menu = Menu.getApplicationMenu()
    const out: Record<string, MenuItemShape[]> = {}
    for (const top of menu?.items ?? []) {
      out[top.label] = (top.submenu?.items ?? []).map((item) => ({
        label: item.label,
        accelerator: item.accelerator ?? null,
        enabled: item.enabled,
      }))
    }
    return out
  })

  const file = shape['File'] ?? []
  expect(file.find((item) => item.label === 'Close Tab')?.accelerator).toBe('CmdOrCtrl+W')
  if (process.platform === 'darwin') {
    // Quit/Hide/Services survive the hand-written app menu.
    const appMenuLabels = (shape['Flow'] ?? []).map((item) => item.label.toLowerCase())
    expect(appMenuLabels.some((label) => label.includes('quit'))).toBe(true)
    expect(appMenuLabels.some((label) => label.includes('services'))).toBe(true)
    expect(appMenuLabels.some((label) => label.includes('hide'))).toBe(true)
  }
})
