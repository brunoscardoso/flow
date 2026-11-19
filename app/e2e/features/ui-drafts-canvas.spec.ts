import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import type { ElectronApplication, Page } from '@playwright/test'

import { test, expect } from '../fixtures/electron'
import { activateProject, cleanupSeeds, seedProject, waitForWorkspaceLink } from '../ux/fixtures/seed'
import { observeAgentWrite } from './drafts-observer-handle'

/**
 * The UI drafts canvas in the built-in browser (plan `ui_drafts`, phase 4).
 *
 * A temp project gets `flow/drafts/demo/` — a layout, a tokens stylesheet, two
 * screens and one EMPTY screen — and the canvas opens in the built-in browser
 * the way every other surface opens it (`flow:open-browser` with a url).
 *
 * The guest is a separate WebContents and each screen an out-of-process frame,
 * so the page is read from MAIN (`executeJavaScript` on the guest and on each
 * frame). Input is REAL input on the host page (`window.mouse`), which is the
 * only kind the spike found to reach a guest faithfully.
 */

test.afterAll(() => cleanupSeeds())

const TOKENS = ':root { --brand: rgb(10, 20, 30); }\nbody { margin: 0; background: var(--brand); color: white; }\n'

function screen(title: string): string {
  return `<!doctype html><html><head><link rel="stylesheet" href="tokens.css"></head><body><h1>${title}</h1></body></html>`
}

function seedCanvas(root: string): void {
  const dir = join(root, 'flow', 'drafts', 'demo')
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'layout.json'),
    JSON.stringify({
      name: 'Demo flow',
      tokenSources: ['src/theme.css'],
      screens: [
        { id: 'home', title: 'Home', order: 1, frame: { x: 0, y: 0, w: 390, h: 844 } },
        { id: 'cart', title: 'Cart', order: 2, frame: { x: 470, y: 0, w: 390, h: 844 } },
        { id: 'blank', title: 'Blank', order: 3 },
      ],
    }),
  )
  writeFileSync(join(dir, 'tokens.css'), TOKENS)
  writeFileSync(join(dir, 'home.html'), screen('Home'))
  writeFileSync(join(dir, 'cart.html'), screen('Cart'))
  writeFileSync(join(dir, 'blank.html'), '')
}

/** Run a script in the canvas page (the guest's top document). */
async function inPage<T>(app: ElectronApplication, code: string): Promise<T | null> {
  return app.evaluate(async ({ webContents }, script) => {
    const guest = webContents.getAllWebContents().find((contents) => contents.getType() === 'webview')
    if (!guest || guest.isDestroyed()) return null
    // The top frame, bounded: `webContents.executeJavaScript` never settles on
    // a page served with a CSP sandbox (the single-screen view).
    try {
      return await Promise.race([
        guest.mainFrame.executeJavaScript(script),
        new Promise((settle) => setTimeout(() => settle(null), 2000)),
      ])
    } catch {
      return null
    }
  }, code) as Promise<T | null>
}

/** Run a script in every screen frame; answers `{ url: result }`. */
async function inFrames(app: ElectronApplication, code: string): Promise<Record<string, unknown>> {
  return app.evaluate(async ({ webContents }, script) => {
    const guest = webContents.getAllWebContents().find((contents) => contents.getType() === 'webview')
    const out: Record<string, unknown> = {}
    if (!guest || guest.isDestroyed()) return out
    for (const frame of guest.mainFrame.framesInSubtree) {
      if (frame === guest.mainFrame) continue
      const name = /\/([a-z0-9-]+)\.html/.exec(frame.url)?.[1] ?? frame.url
      try {
        out[name] = await frame.executeJavaScript(script)
      } catch (error) {
        out[name] = `error: ${String(error)}`
      }
    }
    return out
  }, code)
}

async function guestUrl(app: ElectronApplication): Promise<string> {
  return app.evaluate(({ webContents }) => {
    const guest = webContents.getAllWebContents().find((contents) => contents.getType() === 'webview')
    return guest && !guest.isDestroyed() ? guest.getURL() : ''
  })
}

interface View {
  zoom: number
  x: number
  y: number
}

const readView = (app: ElectronApplication): Promise<View | null> =>
  inPage<View>(app, 'window.flowCanvas ? window.flowCanvas.view() : null')

/** The host-page point over an element of the canvas page. */
async function pointOver(window: Page, app: ElectronApplication, selector: string): Promise<{ x: number; y: number }> {
  const host = await window.locator('.fl-browser-tab webview').boundingBox()
  const rect = await inPage<{ x: number; y: number; w: number; h: number }>(
    app,
    `(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height } })()`,
  )
  if (host === null || rect === null) throw new Error(`no box for ${selector}`)
  return { x: host.x + rect.x + rect.w / 2, y: host.y + rect.y + rect.h / 2 }
}

test('the canvas: frames with labels, an unreadable screen, Fit, tokens, and a reload that keeps the zoom', async ({
  app,
  window,
}) => {
  test.setTimeout(150_000)
  const root = await seedProject(window, 'flow-e2e-drafts-', seedCanvas, { onboarded: true })
  await activateProject(window, root)
  await waitForWorkspaceLink(root)
  const canvasUrl = `flow-page://drafts/${Buffer.from(root, 'utf8').toString('base64url')}/demo/`
  await window.evaluate(
    (url) => document.dispatchEvent(new CustomEvent('flow:open-browser', { detail: { url } })),
    canvasUrl,
  )
  await expect(window.locator('.fl-browser-tab webview')).toBeVisible()

  // ── The toolbar, two frames with labels, and the empty one says why ──────
  await expect
    .poll(() => inPage<string>(app, "document.querySelector('.bar .name')?.textContent ?? null"), { timeout: 30_000 })
    .toBe('Demo flow')
  expect(await inPage<string>(app, "document.querySelector('.bar .meta').textContent")).toBe(
    "3 screens · colours from the app's theme",
  )
  expect(
    await inPage<string[]>(app, "[...document.querySelectorAll('.label')].map((l) => l.textContent)"),
  ).toEqual(['Home1', 'Cart2', 'Blank3'])
  expect(await inPage<number>(app, "document.querySelectorAll('.frame iframe').length")).toBe(2)
  expect(await inPage<string>(app, "document.querySelector('.frame.bad').textContent")).toBe(
    'This screen could not be read. The file is empty. Ask the agent to draw it again.',
  )
  expect(await inPage<string>(app, "document.querySelector('.frame.bad').dataset.screen")).toBe('blank')

  // ── The screen's tokens stylesheet is applied inside its sandboxed frame ──
  await expect
    .poll(() => inFrames(app, 'getComputedStyle(document.body).backgroundColor'), { timeout: 30_000 })
    .toEqual({ home: 'rgb(10, 20, 30)', cart: 'rgb(10, 20, 30)' })

  // ── Opened fitted; + zooms in; Fit brings every frame back ───────────────
  const fitted = await readView(app)
  expect(fitted).not.toBeNull()
  expect(fitted!.zoom).toBeLessThanOrEqual(1)
  expect(await inPage<string>(app, "document.getElementById('level').textContent")).toBe(
    `${Math.round(fitted!.zoom * 100)}%`,
  )
  const plus = await pointOver(window, app, '#zoom-in')
  await window.mouse.click(plus.x, plus.y)
  await expect.poll(async () => (await readView(app))?.zoom).toBeGreaterThan(fitted!.zoom)
  const fit = await pointOver(window, app, '#fit')
  await window.mouse.click(fit.x, fit.y)
  await expect.poll(() => readView(app)).toEqual(fitted)
  // Every frame is inside the stage after Fit.
  expect(
    await inPage<boolean>(
      app,
      `(() => { const s = document.getElementById('stage').getBoundingClientRect();
        return [...document.querySelectorAll('.frame')].every((f) => { const r = f.getBoundingClientRect();
          return r.left >= s.left - 1 && r.right <= s.right + 1 && r.top >= s.top - 1 && r.bottom <= s.bottom + 1 }) })()`,
    ),
  ).toBe(true)

  // ── A plain wheel pans; a pinch (ctrl+wheel) zooms around the cursor ─────
  const over = await pointOver(window, app, '#stage')
  await window.mouse.move(over.x, over.y)
  const beforeScroll = (await readView(app))!
  await window.mouse.wheel(0, 60)
  await expect
    .poll(async () => {
      const view = await readView(app)
      return view === null ? null : [view.zoom, Math.round(beforeScroll.y - view.y)]
    })
    .toEqual([beforeScroll.zoom, 60])
  await window.mouse.wheel(0, -60)
  await expect.poll(async () => Math.round((await readView(app))?.y ?? NaN)).toBe(Math.round(beforeScroll.y))
  await window.keyboard.down('Control')
  await window.mouse.wheel(0, -120)
  await window.keyboard.up('Control')
  await expect.poll(async () => (await readView(app))?.zoom).toBeGreaterThan(fitted!.zoom)
  // ── A drag pans, at the same zoom ────────────────────────────────────────
  const beforePan = (await readView(app))!
  await window.mouse.move(over.x, over.y)
  await window.mouse.down()
  await window.mouse.move(over.x + 40, over.y + 10, { steps: 5 })
  await window.mouse.move(over.x + 80, over.y + 20, { steps: 5 })
  await window.mouse.up()
  await expect
    .poll(async () => {
      const view = await readView(app)
      return view === null ? null : [view.zoom, Math.round(view.x - beforePan.x), Math.round(view.y - beforePan.y)]
    })
    .toEqual([beforePan.zoom, 80, 20])
  // The view is kept in the address, for a reload and for Back.
  await expect.poll(() => guestUrl(app)).toMatch(/#view=/)
  const zoomed = (await readView(app))!

  // ── One screen changes: only its frame reloads, the zoom is kept ─────────
  await inPage(app, 'window.__pageMark = 1')
  await inFrames(app, 'window.__mark = 1')
  writeFileSync(join(root, 'flow', 'drafts', 'demo', 'home.html'), screen('Home again'))
  // The drafts observer processes the write and broadcasts it. The file
  // watcher on a macOS temp dir is not reliable enough to wait on, so main runs
  // the change through the observer's own processing; the watcher's late event
  // for it is then a no-op. (Sending `drafts:changed` by hand left the real
  // watcher's event to land later — once just as Back was pressed on this
  // screen, and its reload cancelled the Back.)
  await observeAgentWrite(app, root, join(root, 'flow', 'drafts', 'demo', 'home.html'))
  await expect
    .poll(() => inFrames(app, "document.querySelector('h1').textContent + ':' + (window.__mark ?? 0)"), {
      timeout: 20_000,
    })
    .toEqual({ home: 'Home again:0', cart: 'Cart:1' })
  expect(await inPage<number>(app, 'window.__pageMark ?? 0')).toBe(1)
  expect(await readView(app)).toEqual(zoomed)

  // ── Double-click a frame: the screen alone, then Back to the same view ───
  const back = (): Promise<unknown> =>
    window.evaluate(() =>
      (window as unknown as { flow: { browser: { back(r: object): Promise<unknown> } } }).flow.browser.back({}),
    )
  // The fragment keeps two decimals.
  const round = (view: View | null): View | null =>
    view === null
      ? null
      : { zoom: Math.round(view.zoom * 100) / 100, x: Math.round(view.x * 100) / 100, y: Math.round(view.y * 100) / 100 }
  const frame = await pointOver(window, app, '.frame[data-screen="cart"]')
  await window.mouse.dblclick(frame.x, frame.y)
  await expect.poll(() => guestUrl(app), { timeout: 20_000 }).toMatch(/\/demo\/cart\.html\?view=single$/)
  await back()
  await expect.poll(() => guestUrl(app), { timeout: 20_000 }).toMatch(/\/demo\/#view=/)
  await expect.poll(async () => round(await readView(app)), { timeout: 20_000 }).toEqual(round(zoomed))

  // ── …and a label does the same (Fit first, so every label is on screen) ──
  const fitAgain = await pointOver(window, app, '#fit')
  await window.mouse.click(fitAgain.x, fitAgain.y)
  await expect.poll(() => readView(app)).toEqual(fitted)
  const label = await pointOver(window, app, '.label[data-screen="home"]')
  await window.mouse.dblclick(label.x, label.y)
  await expect.poll(() => guestUrl(app), { timeout: 20_000 }).toMatch(/\/demo\/home\.html\?view=single$/)
  // The screen alone is the whole page, with its tokens.
  await expect
    .poll(() => inPage<string>(app, "document.querySelector('h1').textContent + ':' + getComputedStyle(document.body).backgroundColor"))
    .toBe('Home again:rgb(10, 20, 30)')
  await back()
  await expect.poll(async () => round(await readView(app)), { timeout: 20_000 }).toEqual(round(fitted))
})
