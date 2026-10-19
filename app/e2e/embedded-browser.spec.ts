import { test, expect } from './fixtures/electron'

/**
 * Embedded browser — host-level E2E.
 *
 * Playwright can drive the HOST renderer (the Browser editor tab, its chrome,
 * the empty-state overlay, the host inspect-mode hint, and the console/network
 * drawer) but NOT the sandboxed <webview> guest (a separate WebContents). So
 * this asserts the host integration is wired and responds; the guest-side
 * capture (crosshair, element/console/network into chat) is verified manually.
 *
 * The tab is opened the way the activity-bar entry does — by dispatching
 * `flow:open-browser`, which `initBrowserTab` listens for.
 */
test.describe('embedded browser tab', () => {
  test.beforeEach(async ({ window }) => {
    await window.evaluate(() => document.dispatchEvent(new CustomEvent('flow:open-browser')))
    await expect(window.locator('.fl-browser-tab')).toBeVisible()
  })

  test('opens with chrome: URL bar + inspect toggle', async ({ window }) => {
    await expect(window.locator('.fl-browser-chrome')).toBeVisible()
    await expect(window.locator('.fl-browser-chrome input[aria-label="Address"]')).toBeVisible()
    await expect(
      window.locator('.fl-browser-chrome fl-button[aria-label="Inspect element"]'),
    ).toBeVisible()
  })

  test('shows an empty-state overlay when there is no page', async ({ window }) => {
    // No dev server in E2E, so the guest never loads a real page — the host
    // overlay must cover the blank webview with a message (not a black void).
    await expect(window.locator('.fl-browser-overlay')).toBeVisible()
    await expect(window.locator('.fl-browser-overlay-title')).not.toBeEmpty()
  })

  test('inspect toggle shows then hides the host inspect hint', async ({ window }) => {
    const inspect = window.locator('.fl-browser-chrome fl-button[aria-label="Inspect element"]')
    const hint = window.getByText('Inspect mode', { exact: false })
    await expect(hint).toBeHidden()
    await inspect.click()
    await expect(hint).toBeVisible()
    await inspect.click()
    await expect(hint).toBeHidden()
  })

  test('debug drawer opens on a sub-tab and exposes the Add actions', async ({ window }) => {
    const drawer = window.locator('.fl-bdrawer')
    await expect(drawer).toBeVisible()
    const body = window.locator('.fl-bdrawer-body')
    // Starts collapsed.
    await expect(body).toBeHidden()
    // Clicking a sub-tab must OPEN the drawer (the fix for "tabs looked dead").
    await window.locator('.fl-bdrawer-tab', { hasText: 'Console' }).click()
    await expect(body).toBeVisible()
    await expect(drawer.locator('fl-button', { hasText: 'Add all' })).toBeVisible()
    await expect(drawer.locator('fl-button', { hasText: 'Add recent' })).toBeVisible()
    // Switching to Network keeps it open.
    await window.locator('.fl-bdrawer-tab', { hasText: 'Network' }).click()
    await expect(body).toBeVisible()
  })
})
