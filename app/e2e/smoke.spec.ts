import { test, expect } from './fixtures/electron'

/**
 * Smoke: the app boots, the main window renders, and the renderer root mounts.
 * This is the go/no-go proof that Playwright can drive the built Electron app
 * with its native modules loaded.
 */
test.describe('app boot', () => {
  test('launches and renders the main window', async ({ app, window }) => {
    // The Electron main process is alive.
    expect(app.windows().length).toBeGreaterThan(0)

    // Window title is set by the main process.
    await expect.poll(() => window.title(), { timeout: 15_000 }).toBe('Flow')

    // The renderer mounts into #app and paints something.
    const root = window.locator('#app')
    await expect(root).toBeAttached()
    await expect.poll(async () => (await root.innerHTML()).trim().length, {
      timeout: 15_000,
    }).toBeGreaterThan(0)
  })
})
