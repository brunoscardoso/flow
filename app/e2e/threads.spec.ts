import { test, expect } from './fixtures/electron'
import { sel } from './selectors'

/**
 * Thread sidebar: search + the empty state a first-run user sees. Creating a
 * real thread needs an account/project, which fresh-launch E2E doesn't have —
 * so this covers the surfaces reachable without credentials.
 */
test.describe('threads sidebar', () => {
  test('search input accepts text', async ({ window }) => {
    const search = window.locator('.fl-thread-search input').first()
    await expect(search).toBeVisible()
    await search.fill('checkout flow')
    await expect(search).toHaveValue('checkout flow')
    // Empty query state is preserved (no threads to filter). A fresh launch has
    // no project, so the hint names THAT blocker (#978), not threads.
    await search.fill('')
    await expect(window.locator(sel.threadEmpty)).toContainText('Open a project to start')
  })

  test('New thread button is enabled and clickable', async ({ window }) => {
    const btn = window.locator(sel.newThread)
    await expect(btn).toBeVisible()
    // Clicking without a project should not crash the renderer.
    await btn.click()
    await expect(window.locator(sel.shell)).toBeVisible()
  })
})
