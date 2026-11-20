import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import type { ElectronApplication, Page } from '@playwright/test'

import { test, expect } from '../fixtures/electron'
import { sel } from '../selectors'
import { observeAgentWrite } from './drafts-observer-handle'
import { activateProject, cleanupSeeds, seedProject, waitForWorkspaceLink } from '../ux/fixtures/seed'

/**
 * Inspect on UI drafts (plan `ui_drafts`, phase 5): pick an element inside a
 * screen frame of the canvas, ask the agent about it, change it in place, and
 * pick in the single-screen view.
 *
 * Screens are seeded already stamped (the drafts observer stamps an agent's
 * write, but the file watcher on a macOS temp dir is not reliable enough to
 * wait on in a spec). The guest and its frames are read from MAIN; input is
 * REAL input on the host page (`window.mouse`) — the only kind that reaches an
 * out-of-process frame faithfully.
 */

test.afterAll(() => cleanupSeeds())

const TOKENS = 'body { margin: 0; font-family: sans-serif; }\n'

const PAYMENT =
  '<!doctype html><html><head><link rel="stylesheet" href="tokens.css"></head>' +
  '<body data-flow-id="pbody"><main data-flow-id="pmain" style="padding: 24px">' +
  '<h1 data-flow-id="ptitle">Payment</h1>' +
  '<button data-flow-id="paybtn" style="background-color: #2b6cff; color: white; padding: 12px 16px; font-size: 20px; width: 300px">Pay $27</button>' +
  '</main></body></html>'

const HOME =
  '<!doctype html><html><head><link rel="stylesheet" href="tokens.css"></head>' +
  '<body data-flow-id="hbody"><h1 data-flow-id="htitle">Home</h1></body></html>'

function seedCanvas(root: string): void {
  const dir = join(root, 'flow', 'drafts', 'checkout')
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'layout.json'),
    JSON.stringify({
      name: 'Checkout',
      tokenSources: [],
      screens: [
        { id: 'home', title: 'Home', order: 1, frame: { x: 0, y: 0, w: 390, h: 600 } },
        { id: 'payment', title: 'Payment', order: 2, frame: { x: 470, y: 0, w: 390, h: 600 } },
      ],
    }),
  )
  writeFileSync(join(dir, 'tokens.css'), TOKENS)
  writeFileSync(join(dir, 'home.html'), HOME)
  writeFileSync(join(dir, 'payment.html'), PAYMENT)
}

/** Run a script in the guest's top document, bounded (a CSP-sandboxed top page never settles). */
async function inPage<T>(app: ElectronApplication, code: string): Promise<T | null> {
  return app.evaluate(async ({ BrowserWindow, webContents }, script) => {
    // The page ON SCREEN: with tabs there is one guest per open tab.
    const host = BrowserWindow.getAllWindows()[0]?.webContents
    const id = (await host?.executeJavaScript(
      "[...document.querySelectorAll('.fl-browser-tab webview')].find((w) => w.style.visibility !== 'hidden')?.getWebContentsId() ?? null",
    )) as number | null
    const guest = id === null ? undefined : webContents.fromId(id)
    if (!guest || guest.isDestroyed()) return null
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

/** Run a script in one screen frame of the canvas. */
async function inFrame<T>(app: ElectronApplication, screen: string, code: string): Promise<T | null> {
  return app.evaluate(async ({ BrowserWindow, webContents }, { screen, script }) => {
    // The page ON SCREEN: with tabs there is one guest per open tab.
    const host = BrowserWindow.getAllWindows()[0]?.webContents
    const id = (await host?.executeJavaScript(
      "[...document.querySelectorAll('.fl-browser-tab webview')].find((w) => w.style.visibility !== 'hidden')?.getWebContentsId() ?? null",
    )) as number | null
    const guest = id === null ? undefined : webContents.fromId(id)
    if (!guest || guest.isDestroyed()) return null
    const frame = guest.mainFrame.framesInSubtree.find(
      (candidate) => candidate !== guest.mainFrame && new RegExp(`/${screen}\\.html`).test(candidate.url),
    )
    if (!frame) return null
    try {
      return await Promise.race([
        frame.executeJavaScript(script),
        new Promise((settle) => setTimeout(() => settle(null), 2000)),
      ])
    } catch {
      return null
    }
  }, { screen, script: code }) as Promise<T | null>
}

interface Box {
  x: number
  y: number
  w: number
  h: number
}

const BOX = (selector: string): string =>
  `(() => { const n = document.querySelector(${JSON.stringify(selector)}); if (!n) return null; const r = n.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height } })()`

async function webviewBox(window: Page): Promise<{ x: number; y: number }> {
  const host = await window.locator('.fl-browser-tab webview:not([style*="visibility: hidden"])').boundingBox()
  if (host === null) throw new Error('no webview box')
  return host
}

/** The host point over an element of the canvas page. */
async function pointInPage(window: Page, app: ElectronApplication, selector: string): Promise<{ x: number; y: number }> {
  const host = await webviewBox(window)
  const rect = await inPage<Box>(app, BOX(selector))
  if (rect === null) throw new Error(`no box for ${selector}`)
  return { x: host.x + rect.x + rect.w / 2, y: host.y + rect.y + rect.h / 2 }
}

/** The host point over an element inside a screen frame (the frame may be zoomed). */
async function pointInFrame(
  window: Page,
  app: ElectronApplication,
  screen: string,
  selector: string,
): Promise<{ x: number; y: number }> {
  const host = await webviewBox(window)
  const frame = await inPage<Box>(app, BOX(`.frame[data-screen="${screen}"] iframe`))
  const inner = await inFrame<Box>(app, screen, BOX(selector))
  if (frame === null || inner === null) throw new Error(`no box for ${selector} in ${screen}`)
  const scale = frame.w / 390
  return {
    x: host.x + frame.x + (inner.x + inner.w / 2) * scale,
    y: host.y + frame.y + (inner.y + inner.h / 2) * scale,
  }
}

async function createThread(win: Page, root: string, title: string): Promise<void> {
  await win.evaluate(
    async ({ root, title }) => {
      await (
        window as unknown as {
          flow: { threads: { create(i: { projectRoot: string; title: string }): Promise<{ id: string }> } }
        }
      ).flow.threads.create({ projectRoot: root, title })
    },
    { root, title },
  )
}

const panel = (window: Page) => window.locator('.fl-draft-panel')
const status = (window: Page) => window.locator('.fl-draft-panel-status')

test('inspect on drafts: pick in a frame, ask the agent, change text and colour, a refusal, and the single view', async ({
  app,
  window,
}) => {
  test.setTimeout(180_000)
  const root = await seedProject(window, 'flow-e2e-drafts-inspect-', seedCanvas, { onboarded: true })
  await activateProject(window, root)
  await waitForWorkspaceLink(root)
  const title = 'Drafts inspect'
  await createThread(window, root, title)
  await window.getByText(title, { exact: true }).first().click()
  await expect(window.locator(sel.composer)).toBeVisible()

  // What reaches the composer: the chip's text for the agent and the picture.
  await window.evaluate(() => {
    const seen = ((window as unknown as { __seen: unknown[] }).__seen = [] as unknown[])
    document.addEventListener('flow:add-to-chat', (event) => seen.push(['chat', (event as CustomEvent).detail]))
    document.addEventListener('flow:attach-image', (event) =>
      seen.push(['image', { fileName: (event as CustomEvent<{ fileName: string }>).detail.fileName }]),
    )
  })

  const encoded = Buffer.from(root, 'utf8').toString('base64url')
  const canvasUrl = `flow-page://drafts/${encoded}/checkout/`
  await window.evaluate(
    (url) => document.dispatchEvent(new CustomEvent('flow:open-browser', { detail: { url } })),
    canvasUrl,
  )
  await expect(window.locator('.fl-browser-tab webview')).toBeVisible()
  await expect
    .poll(() => inPage<string>(app, "document.querySelector('.bar .name')?.textContent ?? null"), { timeout: 30_000 })
    .toBe('Checkout')
  // Main has put the picker in each screen frame.
  await expect.poll(() => inFrame<boolean>(app, 'payment', 'window.__flowDraftPicker === true'), { timeout: 30_000 }).toBe(true)

  // ── Inspect on, from the canvas's own toolbar ──────────────────────────
  expect(await inPage<string>(app, "getComputedStyle(document.querySelector('.frame iframe')).pointerEvents")).toBe('none')
  const inspect = await pointInPage(window, app, '#inspect')
  await window.mouse.click(inspect.x, inspect.y)
  await expect.poll(() => inPage<string>(app, "document.getElementById('inspect').getAttribute('aria-pressed')")).toBe('true')
  expect(await inPage<string>(app, "getComputedStyle(document.querySelector('.frame iframe')).pointerEvents")).toBe('auto')
  // The browser toolbar follows the canvas's toggle.
  await expect(window.locator('.fl-browser-chrome fl-button[aria-label="Inspect element"]')).toHaveAttribute('aria-pressed', 'true')

  // ── A real click on the button inside the Payment frame ────────────────
  const pay = await pointInFrame(window, app, 'payment', '[data-flow-id="paybtn"]')
  await window.mouse.move(pay.x, pay.y)
  await window.mouse.click(pay.x, pay.y)
  await expect(panel(window)).toBeVisible({ timeout: 15_000 })
  await expect(window.locator('.fl-draft-panel-kind')).toHaveText('Button')
  await expect(window.locator('.fl-draft-panel-screen')).toHaveText('Payment')
  await expect(window.locator('.fl-draft-panel-text')).toHaveValue('Pay $27')
  await expect(window.locator('.fl-draft-panel-hex[data-property="background-color"]')).toHaveValue('#2b6cff')
  await expect(window.locator('.fl-draft-panel-side[data-box="padding"][data-side="left"]')).toHaveValue('16')
  // The pick is outlined in its frame with its tag, and the frame is outlined in the canvas.
  await expect
    .poll(() =>
      inFrame<string>(app, 'payment', "[...document.querySelectorAll('[data-flow-draft-picker]')].map((n) => n.style.display === 'block' ? n.textContent : '').join('|')"),
    )
    .toContain('button · pay')
  expect(await inPage<boolean>(app, "document.querySelector('.frame[data-screen=\"payment\"]').classList.contains('picked')")).toBe(true)

  // ── Ask the agent: a chip naming the screen, and the screen's picture ──
  await window.locator('.fl-draft-panel-ask').click()
  const chip = window.locator('.fl-composer-chip', { hasText: 'Pay $27' })
  await expect(chip.locator('.fl-composer-chip-kind')).toHaveText('Payment · "Pay $27" button')
  await expect(chip.locator('.fl-composer-chip-label')).toContainText('data-flow-id="paybtn"')
  // The chip carries the text the agent gets: the screen file and the element's id.
  await expect(chip).toHaveAttribute('title', /flow\/drafts\/checkout\/payment\.html[\s\S]*data-flow-id="paybtn"/)
  await expect
    .poll(() => window.evaluate(() => JSON.stringify((window as unknown as { __seen: unknown[] }).__seen)))
    .toContain('Picture of Payment')
  const chat = await window.evaluate(
    () =>
      ((window as unknown as { __seen: Array<[string, { text?: string; label?: string }]> }).__seen.find(
        ([kind]) => kind === 'chat',
      )?.[1] ?? null),
  )
  expect(chat?.label).toBe('Payment · "Pay $27" button')
  expect(chat?.text).toContain('Canvas: checkout')
  expect(chat?.text).toContain('Screen: Payment — flow/drafts/checkout/payment.html')
  expect(chat?.text).toContain('data-flow-id="paybtn"')
  expect(chat?.text).not.toContain('Selector')

  // ── An in-place text edit lands in the file, and the frame shows it ────
  const file = join(root, 'flow', 'drafts', 'checkout', 'payment.html')
  await window.locator('.fl-draft-panel-text').fill('Pay now')
  await window.locator('.fl-draft-panel-text').press('Enter')
  await expect(status(window)).toHaveText('Saved', { timeout: 15_000 })
  expect(readFileSync(file, 'utf8')).toContain('>Pay now</button>')
  await expect
    .poll(() => inFrame<string>(app, 'payment', "document.querySelector('[data-flow-id=\"paybtn\"]').textContent"), {
      timeout: 15_000,
    })
    .toBe('Pay now')
  // The reloaded frame got its picker again and re-selected the element by id.
  await expect
    .poll(() =>
      inFrame<string>(app, 'payment', "[...document.querySelectorAll('[data-flow-draft-picker]')].map((n) => n.style.display === 'block' ? n.textContent : '').join('|')"),
    { timeout: 15_000 })
    .toContain('button · pay')

  // ── A colour edit lands in the style attribute ─────────────────────────
  const hex = window.locator('.fl-draft-panel-hex[data-property="background-color"]')
  await hex.fill('#ff0000')
  await hex.press('Enter')
  await expect(status(window)).toHaveText('Saved', { timeout: 15_000 })
  expect(readFileSync(file, 'utf8')).toMatch(/data-flow-id="paybtn" style="background-color: #ff0000;/)
  await expect
    .poll(() =>
      inFrame<string>(app, 'payment', "getComputedStyle(document.querySelector('[data-flow-id=\"paybtn\"]')).backgroundColor"),
    { timeout: 15_000 })
    .toBe('rgb(255, 0, 0)')

  // ── The element's id is gone from the file: the edit is refused, nothing written ──
  // An agent rewrites the screen without the button's id. The drafts observer
  // stamps the button with a NEW id — that is the product working — so the
  // spec lets it finish before judging "nothing written". It used to race it:
  // whenever the watcher won, the stamp landed between the write and the
  // check and the file no longer matched. Main runs the change through the
  // observer's own processing (the watcher on a macOS temp folder is not
  // reliable enough to wait on); a late watcher event for it is a no-op.
  const withoutId = readFileSync(file, 'utf8').replace(' data-flow-id="paybtn"', '')
  await inFrame(app, 'payment', 'window.__mark = 1')
  writeFileSync(file, withoutId)
  await observeAgentWrite(app, root, file)
  await expect.poll(() => readFileSync(file, 'utf8'), { timeout: 15_000 }).not.toBe(withoutId)
  // …and wait for its broadcast to land: the Payment frame reloads (the mark
  // is gone) and gets its picker again. Moving on before it left the reload to
  // land on whatever the spec did next.
  await expect.poll(() => inFrame<number>(app, 'payment', 'window.__mark ?? 0'), { timeout: 15_000 }).toBe(0)
  await expect.poll(() => inFrame<boolean>(app, 'payment', 'window.__flowDraftPicker === true'), { timeout: 15_000 }).toBe(true)
  const afterAgent = readFileSync(file, 'utf8')
  // The button is there, stamped afresh — and the id the panel holds is gone.
  expect(afterAgent).toMatch(/<button data-flow-id="[a-z0-9]{6}" style="background-color: #ff0000;/)
  expect(afterAgent).not.toContain('data-flow-id="paybtn"')
  await window.locator('.fl-draft-panel-text').fill('Pay later')
  await window.locator('.fl-draft-panel-text').press('Enter')
  await expect(status(window)).toHaveText('This element is no longer on the screen, so the change was not saved.', {
    timeout: 15_000,
  })
  expect(readFileSync(file, 'utf8')).toBe(afterAgent)

  // ── Inspect off from the canvas; the toolbar follows ───────────────────
  const inspectAgain = await pointInPage(window, app, '#inspect')
  await window.mouse.click(inspectAgain.x, inspectAgain.y)
  await expect(window.locator('.fl-browser-chrome fl-button[aria-label="Inspect element"]')).toHaveAttribute('aria-pressed', 'false')

  // ── The single-screen view: the stock picker, the same panel ───────────
  await window.evaluate(
    (url) => document.dispatchEvent(new CustomEvent('flow:open-browser', { detail: { url } })),
    `flow-page://drafts/${encoded}/checkout/payment.html?view=single`,
  )
  await expect.poll(() => inPage<string>(app, "document.querySelector('h1')?.textContent ?? null"), { timeout: 20_000 }).toBe('Payment')
  // The same screen, open alone: the panel stays until closed.
  await expect(panel(window)).toBeVisible()
  await window.locator('.fl-draft-panel-close').click()
  await expect(panel(window)).toBeHidden()
  await window.locator('.fl-browser-chrome fl-button[aria-label="Inspect element"]').click()
  const host = await webviewBox(window)
  let heading: Box | null = null
  await expect
    .poll(async () => {
      heading = await inPage<Box>(app, BOX('h1'))
      return heading !== null
    })
    .toBe(true)
  const h = heading as unknown as Box
  // The stock picker comes up on a message from main — hover until it highlights.
  await expect
    .poll(
      async () => {
        await window.mouse.move(host.x + h.x + h.w / 2, host.y + h.y + h.h / 2 + 1)
        await window.mouse.move(host.x + h.x + h.w / 2, host.y + h.y + h.h / 2)
        return inPage<boolean>(
          app,
          "[...document.querySelectorAll('[data-flow-inspect-overlay]')].some((n) => n.style.display === 'block')",
        )
      },
      { timeout: 15_000 },
    )
    .toBe(true)
  await window.mouse.click(host.x + h.x + h.w / 2, host.y + h.y + h.h / 2)
  await expect(panel(window)).toBeVisible({ timeout: 15_000 })
  await expect(window.locator('.fl-draft-panel-kind')).toHaveText('Heading')
  await expect(window.locator('.fl-draft-panel-screen')).toHaveText('Payment')
  await expect(window.locator('.fl-draft-panel-text')).toHaveValue('Payment')
  // …and an edit there lands too, shown by reloading the screen.
  await window.locator('.fl-draft-panel-text').fill('Pay with card')
  await window.locator('.fl-draft-panel-text').press('Enter')
  await expect(status(window)).toHaveText('Saved', { timeout: 15_000 })
  expect(readFileSync(file, 'utf8')).toContain('<h1 data-flow-id="ptitle">Pay with card</h1>')
  await expect.poll(() => inPage<string>(app, "document.querySelector('h1')?.textContent ?? null"), { timeout: 20_000 }).toBe('Pay with card')
})
