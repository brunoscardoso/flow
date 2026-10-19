import { test, expect } from './fixtures/electron'
import { sel } from './selectors'

/**
 * Sidebar (threads pane) show/hide from the titlebar toggle and ⌘/Ctrl+B.
 * The pane is removed from / restored to the root split.
 */
test.describe('threads sidebar toggle', () => {
  test('titlebar toggle hides and restores the sidebar', async ({ window }) => {
    await expect(window.locator(sel.threadSidebar)).toBeVisible()
    const toggle = window.locator(sel.sidebarToggle).first()
    await toggle.click()
    await expect(window.locator(sel.threadSidebar)).toBeHidden()
    await toggle.click()
    await expect(window.locator(sel.threadSidebar)).toBeVisible()
  })

  test('⌘/Ctrl+B toggles the sidebar', async ({ window }) => {
    await expect(window.locator(sel.threadSidebar)).toBeVisible()
    const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
    await window.keyboard.press(`${mod}+b`)
    await expect(window.locator(sel.threadSidebar)).toBeHidden()
    await window.keyboard.press(`${mod}+b`)
    await expect(window.locator(sel.threadSidebar)).toBeVisible()
  })
})
