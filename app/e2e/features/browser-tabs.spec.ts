import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

import type { ElectronApplication, Page } from '@playwright/test'

import { test, expect } from '../fixtures/electron'

/**
 * Tabs in the built-in browser, in the real app, against a local server the
 * test runs (no dev server, no network):
 *   - opening, switching and closing tabs, each tab its own page;
 *   - a page's new window: its own site opens as a tab right after it, another
 *     site goes to the person's browser (recorded in main, never opened);
 *   - the shortcuts on the browser's controls and inside a page;
 *   - past six live pages the tab used longest ago sleeps, and wakes on open;
 *   - a page behind another that logs an error gets a red dot;
 *   - closing the last tab closes the browser.
 */

const PAGES: Record<string, string> = {
  '/a': '<title>Page A</title><h1>A</h1>',
  '/b': '<title>Page B</title><h1>B</h1>',
  '/noisy': '<title>Noisy</title><h1>N</h1><script>setTimeout(() => console.error("boom"), 1200)</script>',
}

let server: Server
let origin = ''

test.beforeAll(async () => {
  server = createServer((request, response) => {
    const path = (request.url ?? '/').split('?')[0] ?? '/'
    const body = PAGES[path] ?? `<title>Page ${path.slice(1)}</title><h1>${path}</h1>`
    response.writeHead(200, { 'content-type': 'text/html' })
    response.end(body)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
})

test.afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

const tabRows = (window: Page) => window.locator('.fl-browser-tabs-tab')
const activeRow = (window: Page) => window.locator('.fl-browser-tabs-tab[aria-selected="true"]')
const webviews = (window: Page) => window.locator('.fl-browser-tab webview')

/** Run a script in the page on screen, as if the person did it (user gesture). */
async function inActivePage<T>(app: ElectronApplication, code: string): Promise<T | null> {
  return app.evaluate(async ({ BrowserWindow, webContents }, script) => {
    const host = BrowserWindow.getAllWindows()[0]?.webContents
    const id = (await host?.executeJavaScript(
      "[...document.querySelectorAll('.fl-browser-tab webview')].find((w) => w.style.visibility !== 'hidden')?.getWebContentsId() ?? null",
    )) as number | null
    const guest = id === null ? undefined : webContents.fromId(id)
    if (guest === undefined || guest.isDestroyed()) return null
    try {
      return (await guest.executeJavaScript(script, true)) as unknown
    } catch {
      return null
    }
  }, code) as Promise<T | null>
}

async function openBrowserAt(window: Page, url: string): Promise<void> {
  await window.evaluate((target) => document.dispatchEvent(new CustomEvent('flow:open-browser', { detail: { url: target } })), url)
  await expect(window.locator('.fl-browser-tab')).toBeVisible()
}

test('tabs: open, switch, new windows, shortcuts, sleep, red dot, and closing the last', async ({ app, window }) => {
  test.setTimeout(120_000)
  const errors: string[] = []
  window.on('pageerror', (error) => errors.push(error.message))
  // Another site's window is recorded, never opened in a real browser.
  await app.evaluate(({ shell }) => {
    const g = globalThis as unknown as { __opened: string[] }
    g.__opened = []
    shell.openExternal = async (url: string) => {
      g.__opened.push(url)
    }
  })

  // ── One tab, on the page asked for ─────────────────────────────────────
  await openBrowserAt(window, `${origin}/a`)
  await expect(tabRows(window)).toHaveCount(1)
  await expect(activeRow(window)).toContainText('Page A')
  await expect.poll(() => inActivePage<string>(app, 'document.title')).toBe('Page A')

  // ── "+" opens a blank tab on screen; the first keeps its page ──────────
  await window.locator('[data-action="browser-new-tab"]').click()
  await expect(tabRows(window)).toHaveCount(2)
  await expect(activeRow(window)).toContainText('New tab')
  await expect(window.locator('.fl-browser-overlay')).toBeVisible()
  await expect(webviews(window)).toHaveCount(2)
  await tabRows(window).first().click()
  await expect(activeRow(window)).toContainText('Page A')
  await expect(window.locator('.fl-browser-overlay')).toBeHidden()
  await expect.poll(() => inActivePage<string>(app, 'document.title')).toBe('Page A')
  await expect(window.locator('.fl-browser-chrome input[aria-label="Address"]')).toHaveValue(`${origin}/a`)

  // ── A new window for the page's own site: a tab right after it ─────────
  await inActivePage(app, `window.open('${origin}/b'); true`)
  await expect(tabRows(window)).toHaveCount(3)
  await expect(tabRows(window).nth(1)).toContainText('Page B')
  await expect(activeRow(window)).toContainText('Page B')
  await expect.poll(() => inActivePage<string>(app, 'document.title')).toBe('Page B')

  // ── Another site: the person's browser, no tab ─────────────────────────
  await inActivePage(app, "window.open('https://docs.example.test/guide'); true")
  await expect
    .poll(() => app.evaluate(() => (globalThis as unknown as { __opened: string[] }).__opened))
    .toEqual(['https://docs.example.test/guide'])
  await expect(tabRows(window)).toHaveCount(3)

  // ── Shortcuts on the browser's controls: ⌃Tab, ⌘1, ⌘W, ⌘⇧T ────────────
  await activeRow(window).focus()
  await window.keyboard.press('Control+Tab')
  await expect(activeRow(window)).toContainText('New tab')
  await window.keyboard.press('Meta+1')
  await expect(activeRow(window)).toContainText('Page A')
  await window.keyboard.press('Meta+w')
  await expect(tabRows(window)).toHaveCount(2)
  await expect(activeRow(window)).toContainText('Page B')
  await window.keyboard.press('Meta+Shift+t')
  await expect(tabRows(window)).toHaveCount(3)
  await expect(activeRow(window)).toContainText('Page A')
  await expect.poll(() => inActivePage<string>(app, 'document.title')).toBe('Page A')

  // ── A shortcut pressed inside the page reaches the tabs ────────────────
  await app.evaluate(async ({ BrowserWindow, webContents }) => {
    const host = BrowserWindow.getAllWindows()[0]?.webContents
    const id = (await host?.executeJavaScript(
      "[...document.querySelectorAll('.fl-browser-tab webview')].find((w) => w.style.visibility !== 'hidden')?.getWebContentsId() ?? null",
    )) as number | null
    const guest = id === null ? undefined : webContents.fromId(id)
    guest?.focus()
    guest?.sendInputEvent({ type: 'keyDown', keyCode: 't', modifiers: [process.platform === 'darwin' ? 'meta' : 'control'] })
  })
  await expect(tabRows(window)).toHaveCount(4)
  await expect(activeRow(window)).toContainText('New tab')

  // ── A page behind another logs an error: a red dot until it is opened ──
  await tabRows(window).first().click()
  await inActivePage(app, `window.open('${origin}/noisy'); true`)
  await expect(activeRow(window)).toContainText('Noisy')
  await tabRows(window).first().click()
  const noisy = tabRows(window).filter({ hasText: 'Noisy' })
  await expect(noisy.locator('.fl-browser-tabs-dot')).toBeVisible({ timeout: 10_000 })
  await noisy.click()
  await expect(noisy.locator('.fl-browser-tabs-dot')).toHaveCount(0)

  // ── Past six live pages, the tab used longest ago sleeps ───────────────
  for (const n of [1, 2, 3, 4]) {
    await window.locator('[data-action="browser-new-tab"]').click()
    await window.locator('.fl-browser-chrome input[aria-label="Address"]').fill(`${origin}/p${String(n)}`)
    await window.locator('.fl-browser-chrome input[aria-label="Address"]').press('Enter')
    await expect(activeRow(window)).toContainText(`Page p${String(n)}`)
  }
  await expect(tabRows(window)).toHaveCount(9)
  await expect(webviews(window)).toHaveCount(6)
  await expect(window.locator('.fl-browser-tabs-tab.is-asleep')).toHaveCount(3)
  if (process.env['FLOW_E2E_SHOTS']) await window.locator('.fl-browser-tab').screenshot({ path: `${process.env['FLOW_E2E_SHOTS']}/browser-tabs.png` })
  // A sleeping tab keeps its title and wakes on open.
  const asleep = window.locator('.fl-browser-tabs-tab.is-asleep').first()
  const title = (await asleep.locator('.fl-browser-tabs-title').textContent()) ?? ''
  expect(title).not.toBe('')
  await asleep.click()
  await expect(activeRow(window)).toContainText(title)
  await expect(webviews(window)).toHaveCount(6)

  // ── Closing every tab closes the browser ───────────────────────────────
  while ((await tabRows(window).count()) > 1) await activeRow(window).locator('.fl-browser-tabs-close').click()
  await expect(window.locator('.fl-browser-tab')).toBeVisible()
  await activeRow(window).locator('.fl-browser-tabs-close').click()
  await expect(window.locator('.fl-browser-tab')).toBeHidden()

  expect(errors, errors.join(', ')).toEqual([])
})
