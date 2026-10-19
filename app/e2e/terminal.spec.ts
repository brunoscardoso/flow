import { test, expect } from './fixtures/electron'
import { sel, statusButtonByText } from './selectors'

/**
 * Terminal panel: docked and VISIBLE by default (post-#674), toggled from the
 * editor area's Terminal view action (and ⌃`). Hiding then revealing it
 * round-trips the terminal surface.
 */
test.describe('terminal toggle', () => {
  test('the Terminal view action hides and reveals the panel', async ({ window }) => {
    const toggle = window.locator(statusButtonByText('Terminal'))
    await expect(toggle).toBeVisible()

    // Visible on fresh launch, and the toggle says so.
    await expect(window.locator(sel.terminalRoot)).toBeVisible()
    await expect(toggle).toHaveClass(/active/)

    await toggle.click()
    await expect(window.locator(sel.terminalRoot)).toBeHidden()
    await expect(toggle).not.toHaveClass(/active/)

    await toggle.click()
    await expect(window.locator(sel.terminalRoot)).toBeVisible()
    await expect(toggle).toHaveClass(/active/)
  })

  test('⌃` keyboard shortcut toggles the terminal', async ({ window }) => {
    await expect(window.locator(sel.terminalRoot)).toBeVisible()
    await window.keyboard.press('Control+`')
    await expect(window.locator(sel.terminalRoot)).toBeHidden()
    await window.keyboard.press('Control+`')
    await expect(window.locator(sel.terminalRoot)).toBeVisible()
  })
})
