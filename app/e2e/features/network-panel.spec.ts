import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

import type { ElectronApplication, Page } from '@playwright/test'

import { test, expect } from '../fixtures/electron'

/**
 * The Network panel (Chrome-style) in the real app, against a local server the
 * test runs. The page makes a known set of requests on load:
 *   - GET /api/desks (JSON), GET /api/missing (404), POST /api/echo (a body),
 *   - GET /api/poll three times (a repeat to group),
 *   - GET /style.css, and a request to a closed port (connection refused).
 * Then it checks the columns, grouping, chips, the filter box, errors only, the
 * detail tabs, sorting, the right-click menu, send again, clear and reload.
 */

const PAGE = `<!doctype html><title>Net</title><link rel="icon" href="data:,"><link rel="stylesheet" href="/style.css"><h1>Net</h1>
<script>
async function go() {
  await fetch('/api/desks')
  await fetch('/api/missing')
  await fetch('/api/echo', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ desk: 'front', open: 3 }) })
  for (let i = 0; i < 3; i++) await fetch('/api/poll')
  await fetch('http://127.0.0.1:CLOSED_PORT/refused').catch(() => undefined)
  document.title = 'Net done'
}
go()
</script>`

let server: Server
let origin = ''
let echoCount = 0
let closedPort = 0

test.beforeAll(async () => {
  // A port nothing listens on: bind one, then let it go.
  const probe = createServer()
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve))
  closedPort = (probe.address() as AddressInfo).port
  await new Promise<void>((resolve) => probe.close(() => resolve()))
  server = createServer((request, response) => {
    const path = (request.url ?? '/').split('?')[0] ?? '/'
    if (path === '/') {
      response.writeHead(200, { 'content-type': 'text/html' })
      response.end(PAGE.replace('CLOSED_PORT', String(closedPort)))
    } else if (path === '/style.css') {
      response.writeHead(200, { 'content-type': 'text/css' })
      response.end('h1 { color: teal }')
    } else if (path === '/api/desks' || path === '/api/poll') {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ desks: [{ id: 'dsk_41', name: 'Front desk', owner: { name: 'Ana' } }], total: 1 }))
    } else if (path === '/api/echo') {
      echoCount += 1
      let body = ''
      request.on('data', (chunk: Buffer) => (body += chunk.toString()))
      request.on('end', () => {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ received: JSON.parse(body || '{}') as unknown }))
      })
    } else {
      response.writeHead(404, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: 'Not Found' }))
    }
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
})

test.afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

const panel = (window: Page) => window.locator('.fl-net')
const rows = (window: Page) => panel(window).locator('.fl-net-row')
const row = (window: Page, name: string) => rows(window).filter({ has: window.locator('.fl-net-name-text', { hasText: new RegExp(`^${name}$`) }) })
const check = (window: Page, label: string) => panel(window).locator('.fl-net-check', { hasText: label }).locator('input')

async function pageTitle(app: ElectronApplication): Promise<string | null> {
  return app.evaluate(async ({ BrowserWindow, webContents }) => {
    const host = BrowserWindow.getAllWindows()[0]?.webContents
    const id = (await host?.executeJavaScript(
      "[...document.querySelectorAll('.fl-browser-tab webview')].find((w) => w.style.visibility !== 'hidden')?.getWebContentsId() ?? null",
    )) as number | null
    const guest = id === null ? undefined : webContents.fromId(id)
    return guest === undefined || guest.isDestroyed() ? null : guest.getTitle()
  })
}

test('network panel: columns, grouping, filters, details, menu, send again, clear', async ({ app, window }) => {
  test.setTimeout(120_000)
  const errors: string[] = []
  window.on('pageerror', (error) => errors.push(error.message))
  // Copy actions write the clipboard; record them instead of touching the real one.
  await window.evaluate(() => {
    const g = window as unknown as { __copied: string[] }
    g.__copied = []
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: (text: string) => (g.__copied.push(text), Promise.resolve()) },
    })
  })

  await window.evaluate((url) => document.dispatchEvent(new CustomEvent('flow:open-browser', { detail: { url } })), `${origin}/`)
  await expect(window.locator('.fl-browser-tab')).toBeVisible()
  await expect.poll(() => pageTitle(app), { timeout: 20_000 }).toBe('Net done')
  await window.locator('.fl-bdrawer-tab', { hasText: 'Network' }).click()
  await expect(panel(window)).toBeVisible()

  // ── Columns, and repeats grouped into one row ─────────────────────────────
  await expect(panel(window).locator('th')).toHaveText(['Name', 'Status', 'Method', 'Type', 'Initiator', 'Size', 'Time', 'Waterfall'])
  await expect(row(window, 'poll')).toHaveCount(1, { timeout: 15_000 })
  await expect(row(window, 'poll').locator('.fl-net-repeat')).toHaveText('×3')
  await expect(row(window, 'missing').locator('.fl-net-status-cell')).toHaveText('404')
  await expect(row(window, 'refused').locator('.fl-net-status-cell')).toContainText('(failed)')
  await expect(row(window, 'refused').locator('.fl-net-status-cell')).toContainText('connection refused')
  await expect(row(window, 'desks').locator('td').nth(3)).toHaveText('fetch')
  // A fresh tab's first load: the page's process sent its stylesheet before
  // capture listened there. The panel says so and offers a reload, after which
  // every request is in the list.
  const missed = panel(window).locator('.fl-net-missed')
  if (await row(window, 'style.css').count() === 0) {
    await expect(missed).toBeVisible()
    await expect(missed).toContainText('not recorded')
    await missed.getByRole('button', { name: 'Reload page' }).click()
    await expect.poll(() => pageTitle(app), { timeout: 20_000 }).toBe('Net done')
  }
  await expect(row(window, 'style.css').locator('td').nth(3)).toHaveText('stylesheet', { timeout: 15_000 })
  await expect(missed).toBeHidden()
  await expect(row(window, 'poll').locator('.fl-net-repeat')).toHaveText('×3')
  await check(window, 'Group repeats').uncheck()
  await expect(row(window, 'poll')).toHaveCount(3)
  await check(window, 'Group repeats').check()
  await expect(row(window, 'poll')).toHaveCount(1)

  // ── Chips and the filter box ──────────────────────────────────────────────
  await panel(window).locator('.fl-net-chip[data-type="css"]').click()
  await expect(rows(window)).toHaveCount(1)
  await expect(row(window, 'style.css')).toHaveCount(1)
  await panel(window).locator('.fl-net-chip[data-type="all"]').click()
  const filter = panel(window).locator('input[aria-label="Filter requests"]')
  await filter.fill('status:404')
  await expect(rows(window)).toHaveCount(1)
  await expect(row(window, 'missing')).toHaveCount(1)
  await filter.fill('method:post')
  await expect(rows(window)).toHaveCount(1)
  await filter.fill('-api')
  await expect(row(window, 'desks')).toHaveCount(0)
  await expect(row(window, 'style.css')).toHaveCount(1)
  await filter.fill('')
  await check(window, 'Errors only').check()
  await expect(rows(window)).toHaveCount(2)
  await check(window, 'Errors only').uncheck()

  // ── Summary bar ───────────────────────────────────────────────────────────
  await expect(panel(window).locator('.fl-net-status-facts')).toContainText('requests')
  await expect(panel(window).locator('.fl-net-status-facts')).toContainText('transferred')
  await expect(panel(window).locator('.fl-net-status-facts')).toContainText('failed')

  // ── Details beside the list ───────────────────────────────────────────────
  await row(window, 'echo').click()
  const detail = panel(window).locator('.fl-net-detail')
  await expect(detail).toBeVisible()
  await expect(detail.locator('.fl-net-detail-title')).toHaveText(`${origin}/api/echo`)
  await expect(detail.locator('.fl-net-kv').first()).toContainText('Request URL')
  await detail.locator('.fl-net-detail-tab', { hasText: 'Payload' }).click()
  await expect(detail.locator('.fl-net-tree-key', { hasText: 'desk' })).toBeVisible()
  await detail.locator('.fl-net-detail-tab', { hasText: 'Preview' }).click()
  await expect(detail.locator('.fl-net-tree-key', { hasText: 'received' })).toBeVisible()
  await detail.locator('.fl-net-detail-tab', { hasText: 'Response' }).click()
  await expect(detail.locator('.fl-net-raw')).toContainText('"front"')
  await detail.locator('.fl-net-detail-tab', { hasText: 'Timing' }).click()
  await expect(detail.locator('.fl-net-timing')).toContainText('Waiting for server')
  await detail.locator('.fl-net-detail-tab', { hasText: 'Initiator' }).click()
  await expect(detail.locator('.fl-net-initiator')).toContainText('A script')
  await expect(detail.locator('.fl-net-stack li').first()).toBeVisible()
  if (process.env['FLOW_E2E_SHOTS']) await panel(window).screenshot({ path: `${process.env['FLOW_E2E_SHOTS']}/network-panel.png` })

  // Arrow keys move through the list while details are open.
  await panel(window).locator('.fl-net-list').focus()
  await window.keyboard.press('ArrowDown')
  await expect(detail.locator('.fl-net-detail-title')).not.toHaveText(`${origin}/api/echo`)
  await window.keyboard.press('Escape')
  await expect(detail).toBeHidden()

  // ── Sorting ───────────────────────────────────────────────────────────────
  const timeHead = panel(window).locator('th', { hasText: 'Time' })
  await timeHead.click()
  await expect(timeHead).toHaveAttribute('aria-sort', 'ascending')
  await timeHead.click()
  await expect(timeHead).toHaveAttribute('aria-sort', 'descending')
  await timeHead.click()
  await expect(timeHead).toHaveAttribute('aria-sort', 'none')

  // ── Right-click menu: copy, then send again ──────────────────────────────
  await row(window, 'desks').click({ button: 'right' })
  const menu = panel(window).locator('.fl-net-menu')
  await expect(menu).toBeVisible()
  await menu.getByRole('menuitem', { name: 'Copy as cURL' }).click()
  await expect(menu).toBeHidden()
  await expect
    .poll(() => window.evaluate(() => (window as unknown as { __copied: string[] }).__copied.join('\n')))
    .toContain(`curl '${origin}/api/desks'`)

  await check(window, 'Group repeats').uncheck()
  const before = echoCount
  await row(window, 'echo').click({ button: 'right' })
  await menu.getByRole('menuitem', { name: 'Send again' }).click()
  await expect.poll(() => echoCount).toBe(before + 1)
  await expect(row(window, 'echo')).toHaveCount(2, { timeout: 10_000 })

  // ── Clear, then a reload starts the list over ─────────────────────────────
  await panel(window).getByRole('button', { name: 'Clear' }).click()
  await expect(rows(window)).toHaveCount(0)
  await expect(panel(window).locator('.fl-net-empty')).toHaveText('No requests yet. Requests the page makes appear here.')
  await window.locator('.fl-browser-chrome fl-button[aria-label="Reload"]').click()
  await expect.poll(() => pageTitle(app), { timeout: 20_000 }).toBe('Net done')
  await expect(row(window, 'desks')).toHaveCount(1, { timeout: 15_000 })

  expect(errors, errors.join(', ')).toEqual([])
})
