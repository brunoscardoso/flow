import { test, expect } from '../fixtures/electron'
import type { Page } from '@playwright/test'

/**
 * UX-sweep regression probe — flow 11 (Settings / flow-settings overlays),
 * round 12. Drives the app-level Settings overlay's "Claude accounts → Add
 * account" form (settings-view.ts #renderAddRow), a primary settings action no
 * prior settings spec exercises.
 *
 * The finding this guards: clicking "Add account" with a blank or whitespace-only
 * name is a SILENT no-op — the handler only `input.focus()`es and returns, the
 * `.fl-settings-add-status` line stays hidden, and the account list is unchanged.
 * The sibling Integrations "Connect" action (same overlay family) surfaces a
 * visible "Fill every field" hint for the same mistake (#217). The accounts add
 * form gives no such feedback: a user who submits an empty name sees nothing
 * happen and no explanation.
 *
 * No account/credentials needed — a fresh launch shows the empty accounts state,
 * and the empty-input branch returns before any accounts.add() IPC.
 */

// SETTINGS IS A PAGE, not an overlay: it moved into the editor area with its
// groups behind tabs. The name is kept so the walk below reads unchanged; what
// it names is the page.
const SETTINGS_OVERLAY = '.fl-settings-page'

async function openSettings(win: Page): Promise<void> {
  await win.evaluate(() => document.dispatchEvent(new CustomEvent('flow:open-settings')))
  await expect(win.locator(SETTINGS_OVERLAY)).toBeVisible()
}

test.describe('flow 11 — Settings accounts "Add account" blank-name feedback', () => {
  // GREEN coverage guard: the accounts section renders with an empty state and a
  // working Add row; clicking Add with a blank name does not crash, throw, or
  // create a phantom account. (Documents the CURRENT — silently-feedbackless —
  // behavior so a regression that made it worse would trip.)
  test('blank Add is a no-op that does not crash or create an account', async ({ window }) => {
    const errors: string[] = []
    window.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))

    await openSettings(window)
    const overlay = window.locator(SETTINGS_OVERLAY)

    const accounts = overlay.locator('.fl-settings-section', { hasText: 'Model settings' })
    await expect(accounts).toHaveCount(1)
    await expect(accounts.locator('.fl-settings-empty', { hasText: 'No accounts yet' })).toBeVisible()

    const addBtn = accounts.locator('.fl-settings-btn', { hasText: 'Add account' })
    const status = accounts.locator('.fl-settings-add-status')
    await expect(addBtn).toBeVisible()
    // Status starts hidden.
    await expect(status).toBeHidden()

    // Click Add with an EMPTY name.
    await addBtn.click()
    // No crash, no phantom account (still the empty state), button still enabled.
    await expect(accounts.locator('.fl-settings-empty', { hasText: 'No accounts yet' })).toBeVisible()
    await expect(accounts.locator('.fl-settings-account')).toHaveCount(0)
    await expect(addBtn).toBeEnabled()

    // Whitespace-only name — the field LOOKS filled, but trims to empty.
    const input = accounts.locator('input.fl-settings-input').first()
    await input.fill('   ')
    await addBtn.click()
    await expect(accounts.locator('.fl-settings-account')).toHaveCount(0)

    await window.screenshot({ path: '/tmp/qa-settings-add-account.png' })

    expect(errors, `uncaught errors: ${errors.join(' | ')}`).toEqual([])
  })

  // BUG TRIPWIRE (#834): submitting a blank/whitespace name should surface
  // VISIBLE feedback (like Integrations' "Fill every field"), not a silent no-op.
  // Currently the status line stays hidden — this fails until the add form gives
  // the user feedback for an empty name.
  test('blank Add surfaces a visible "enter a name" hint', async ({ window }) => {
    await openSettings(window)
    const accounts = window
      .locator(SETTINGS_OVERLAY)
      .locator('.fl-settings-section', { hasText: 'Model settings' })
    const addBtn = accounts.locator('.fl-settings-btn', { hasText: 'Add account' })
    const status = accounts.locator('.fl-settings-add-status')

    // Whitespace-only: looks filled, trims to empty.
    await accounts.locator('input.fl-settings-input').first().fill('   ')
    await addBtn.click()

    // Expected once fixed: a visible, non-empty status message explaining that a
    // name is required — matching the Integrations panel's feedback contract.
    await expect(status).toBeVisible()
    await expect(status).not.toHaveText('')
  })
})
