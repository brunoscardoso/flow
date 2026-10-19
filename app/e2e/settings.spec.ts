import { test, expect } from './fixtures/electron'


/**
 * SETTINGS IS A TAB NOW, not an overlay.
 *
 * It was a 560px dialog holding one scrolling column of every decision the app
 * can make; it is a page in the editor area with its groups behind tabs
 * (`SETTINGS_GROUPS`). This file used to assert the dialog's three verbs —
 * opens, closes by ✕, closes by Escape — and two of those belonged to the
 * chrome rather than to Settings: a tab is closed from the tab strip, and
 * Escape does not close a tab any more than it closes the Tasks board.
 *
 * What is left is what was always the point: pressing the button opens it, its
 * groups are there, and it does not own the keyboard — the two overlays that
 * still are modals (Flow settings, Integrations) keep their own guards.
 */
const PAGE = '.fl-settings-page'

test.describe('settings page', () => {
  test('opens from the Settings button, with its groups', async ({ window }) => {
    await expect(window.locator(PAGE)).toHaveCount(0)
    await window.locator('.fl-titlebar-icon[aria-label="Settings"]').click()
    await expect(window.locator(PAGE)).toBeVisible()
    // A tab strip, not a header with a close button.
    await expect(window.locator('.fl-settings-tab', { hasText: 'Models' })).toBeVisible()
    await expect(window.locator('.fl-settings-tab', { hasText: 'App' })).toBeVisible()
  })

  test('shows one group at a time, and the tab says which', async ({ window }) => {
    await window.locator('.fl-titlebar-icon[aria-label="Settings"]').click()
    await expect(window.locator(PAGE)).toBeVisible()
    const shown = () =>
      window
        .locator('.fl-settings-group:not([hidden])')
        .evaluateAll((els) => els.map((el) => (el as HTMLElement).dataset.group))
    await expect.poll(shown).toEqual(['models'])

    await window.locator('.fl-settings-tab', { hasText: 'App' }).click()
    await expect.poll(shown).toEqual(['app'])
    await expect(window.locator('.fl-settings-tab.active')).toHaveText('App')
  })

  test('does NOT own the keyboard — it is a tab, not a modal', async ({ window }) => {
    // The dialog declared itself modal chrome so panel shortcuts could not
    // reach past it. A tab is not past anything, and this is the difference
    // being asserted rather than assumed.
    await window.locator('.fl-titlebar-icon[aria-label="Settings"]').click()
    await expect(window.locator(PAGE)).toBeVisible()
    await window.keyboard.press('Escape')
    await expect(window.locator(PAGE)).toBeVisible()
  })
})
