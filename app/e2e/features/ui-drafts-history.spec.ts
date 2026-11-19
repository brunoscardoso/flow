import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import type { ElectronApplication, Page } from '@playwright/test'

import { test, expect } from '../fixtures/electron'
import { sel } from '../selectors'
import { observeAgentWrite } from './drafts-observer-handle'
import { activateProject, cleanupSeeds, seedProject, waitForWorkspaceLink } from '../ux/fixtures/seed'

/**
 * Undo and named versions on UI drafts (plan `ui_drafts`, phase 6): the canvas
 * toolbar's Undo steps back one change whoever made it (the person's in-place
 * edit, the agent's rewrite of a screen), and the Versions menu saves a named
 * version and restores one after a confirmation — and a restore can be undone.
 *
 * The page is read and driven from MAIN (it is a separate WebContents); the
 * toolbar buttons get REAL input on the host page, the menu and dialogs, which
 * are the page's own DOM, get their clicks from the page.
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
  return app.evaluate(async ({ webContents }, script) => {
    const guest = webContents.getAllWebContents().find((contents) => contents.getType() === 'webview')
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
  return app.evaluate(async ({ webContents }, { screen, script }) => {
    const guest = webContents.getAllWebContents().find((contents) => contents.getType() === 'webview')
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
  const host = await window.locator('.fl-browser-tab webview').boundingBox()
  if (host === null) throw new Error('no webview box')
  return host
}

async function pointInPage(window: Page, app: ElectronApplication, selector: string): Promise<{ x: number; y: number }> {
  const host = await webviewBox(window)
  const rect = await inPage<Box>(app, BOX(selector))
  if (rect === null) throw new Error(`no box for ${selector}`)
  return { x: host.x + rect.x + rect.w / 2, y: host.y + rect.y + rect.h / 2 }
}

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

test('undo steps back the person’s and the agent’s changes, and a named version restores and can be undone', async ({
  app,
  window,
}) => {
  test.setTimeout(240_000)
  const root = await seedProject(window, 'flow-e2e-drafts-history-', seedCanvas, { onboarded: true })
  await activateProject(window, root)
  await waitForWorkspaceLink(root)
  const title = 'Drafts history'
  await createThread(window, root, title)
  await window.getByText(title, { exact: true }).first().click()
  await expect(window.locator(sel.composer)).toBeVisible()

  const file = join(root, 'flow', 'drafts', 'checkout', 'payment.html')
  const read = (): string => readFileSync(file, 'utf8')
  const buttonText = (): Promise<string | null> =>
    inFrame<string>(app, 'payment', "document.querySelector('[data-flow-id=\"paybtn\"]').textContent")
  const titleText = (): Promise<string | null> =>
    inFrame<string>(app, 'payment', "document.querySelector('[data-flow-id=\"ptitle\"]').textContent")
  const undoCount = (): Promise<number | null> => inPage<number>(app, 'window.flowCanvas.undoCount()')
  const toast = (): Promise<string | null> =>
    inPage<string>(app, "(() => { const t = document.getElementById('toast'); return t.hidden ? null : t.textContent })()")

  const encoded = Buffer.from(root, 'utf8').toString('base64url')
  await window.evaluate(
    (url) => document.dispatchEvent(new CustomEvent('flow:open-browser', { detail: { url } })),
    `flow-page://drafts/${encoded}/checkout/`,
  )
  await expect(window.locator('.fl-browser-tab webview')).toBeVisible()
  await expect
    .poll(() => inPage<string>(app, "document.querySelector('.bar .name')?.textContent ?? null"), { timeout: 30_000 })
    .toBe('Checkout')
  await expect.poll(() => inFrame<boolean>(app, 'payment', 'window.__flowDraftPicker === true'), { timeout: 30_000 }).toBe(true)

  // ── Nothing to undo yet: the button is disabled, the shortcut says so ───
  await expect.poll(() => inPage<boolean>(app, "document.getElementById('undo').disabled"), { timeout: 15_000 }).toBe(true)
  expect(await undoCount()).toBe(0)

  // ── An in-place edit through the side panel ─────────────────────────────
  const inspect = await pointInPage(window, app, '#inspect')
  await window.mouse.click(inspect.x, inspect.y)
  await expect.poll(() => inPage<string>(app, "document.getElementById('inspect').getAttribute('aria-pressed')")).toBe('true')
  const pay = await pointInFrame(window, app, 'payment', '[data-flow-id="paybtn"]')
  await window.mouse.move(pay.x, pay.y)
  await window.mouse.click(pay.x, pay.y)
  await expect(panel(window)).toBeVisible({ timeout: 15_000 })
  await expect(window.locator('.fl-draft-panel-text')).toHaveValue('Pay $27')
  await window.locator('.fl-draft-panel-text').fill('Pay now')
  await window.locator('.fl-draft-panel-text').press('Enter')
  await expect(status(window)).toHaveText('Saved', { timeout: 15_000 })
  expect(read()).toContain('>Pay now</button>')
  await expect.poll(buttonText, { timeout: 15_000 }).toBe('Pay now')
  // The edit is a step, so Undo is enabled.
  await expect.poll(() => inPage<boolean>(app, "document.getElementById('undo').disabled"), { timeout: 15_000 }).toBe(false)
  expect(await undoCount()).toBe(1)

  // ── Undo in the toolbar puts the file and the frame back ────────────────
  const undo = await pointInPage(window, app, '#undo')
  await window.mouse.click(undo.x, undo.y)
  await expect.poll(() => read(), { timeout: 15_000 }).toBe(PAYMENT)
  await expect.poll(buttonText, { timeout: 15_000 }).toBe('Pay $27')
  await expect.poll(() => inPage<boolean>(app, "document.getElementById('undo').disabled")).toBe(true)
  // The open side panel shows the element as it is now.
  await expect(window.locator('.fl-draft-panel-text')).toHaveValue('Pay $27', { timeout: 15_000 })

  // ── The agent rewrites a screen: Undo restores the previous version ─────
  const agentVersion = PAYMENT.replace('>Payment</h1>', '>Agent title</h1>')
  writeFileSync(file, agentVersion)
  // The drafts observer processes the write (snapshotting the previous
  // version) and tells the page; the count becomes one step. The file watcher
  // on a macOS temp folder is not reliable enough to wait on, so main runs the
  // change through the observer's OWN chain and processing — the same call the
  // watcher's settled event makes, on the same per-file chain. Whichever of
  // the two runs second meets content already seen and does nothing, so the
  // answer is not asserted — the undo count below is the observable fact.
  await observeAgentWrite(app, root, file)
  await expect.poll(undoCount, { timeout: 15_000 }).toBe(1)
  await expect.poll(titleText, { timeout: 15_000 }).toBe('Agent title')
  await window.mouse.click(undo.x, undo.y)
  await expect.poll(() => read(), { timeout: 15_000 }).toBe(PAYMENT)
  await expect.poll(titleText, { timeout: 15_000 }).toBe('Payment')
  await expect.poll(undoCount).toBe(0)
  // …and with nothing left the shortcut says so, in a short line.
  await inPage(app, "document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', metaKey: true, ctrlKey: true, bubbles: true }))")
  await expect.poll(toast).toBe('Nothing to undo.')

  // ── Save a version named "First" ────────────────────────────────────────
  const versions = await pointInPage(window, app, '#versions')
  await window.mouse.click(versions.x, versions.y)
  await expect.poll(() => inPage<boolean>(app, "!document.getElementById('versions-menu').hidden")).toBe(true)
  expect(await inPage<string>(app, "document.querySelector('#versions-menu .head').textContent")).toBe('Versions')
  expect(await inPage<string>(app, "document.querySelector('#versions-menu .item .name').textContent")).toBe('Save this version…')
  await inPage(app, "document.querySelector('#versions-menu .item').click()")
  await expect.poll(() => inPage<boolean>(app, "!document.getElementById('overlay').hidden")).toBe(true)
  // Save stays disabled while the name is empty.
  expect(await inPage<boolean>(app, "document.querySelector('#overlay .confirm').disabled")).toBe(true)
  const typeName = (name: string): Promise<unknown> =>
    inPage(
      app,
      `(() => { const i = document.querySelector('#overlay .field'); i.value = ${JSON.stringify(name)}; i.dispatchEvent(new Event('input')); })()`,
    )
  await typeName('First')
  expect(await inPage<boolean>(app, "document.querySelector('#overlay .confirm').disabled")).toBe(false)
  await inPage(app, "document.querySelector('#overlay .confirm').click()")
  await expect.poll(() => inPage<boolean>(app, "document.getElementById('overlay').hidden")).toBe(true)
  await expect.poll(toast).toBe('Version saved.')
  const saved = join(root, 'flow', 'drafts', 'checkout', 'versions', 'first', 'payment.html')
  expect(readFileSync(saved, 'utf8')).toBe(PAYMENT)

  // A second version with the same name is refused in the dialog, in a sentence.
  await window.mouse.click(versions.x, versions.y)
  await inPage(app, "document.querySelector('#versions-menu .item').click()")
  await typeName('First')
  await inPage(app, "document.querySelector('#overlay .confirm').click()")
  await expect
    .poll(() => inPage<string>(app, "document.querySelector('#overlay .error').textContent"))
    .toBe('A version with that name already exists.')
  await inPage(app, "document.querySelector('#overlay .cancel').click()")
  await expect.poll(() => inPage<boolean>(app, "document.getElementById('overlay').hidden")).toBe(true)

  // ── Change a screen, then restore "First" after confirming ──────────────
  await window.locator('.fl-draft-panel-text').fill('Pay twice')
  await window.locator('.fl-draft-panel-text').press('Enter')
  await expect(status(window)).toHaveText('Saved', { timeout: 15_000 })
  await expect.poll(buttonText, { timeout: 15_000 }).toBe('Pay twice')
  const changed = read()
  expect(changed).toContain('>Pay twice</button>')

  await window.mouse.click(versions.x, versions.y)
  await expect
    .poll(() => inPage<number>(app, "document.querySelectorAll('#versions-menu .item[data-version]').length"))
    .toBe(1)
  expect(await inPage<string>(app, "document.querySelector('#versions-menu .item[data-version] .name').textContent")).toBe('First')
  expect(await inPage<string>(app, "document.querySelector('#versions-menu .item[data-version] .when').textContent")).toMatch(
    /^(\d\d:\d\d|[A-Z][a-z]{2} \d{1,2})$/,
  )
  await inPage(app, "document.querySelector('#versions-menu .item[data-version]').click()")
  await expect
    .poll(() => inPage<string>(app, "document.querySelector('#overlay .dialog p').textContent"))
    .toBe("Replace the current screens with 'First'? You can undo this.")
  // Cancel leaves everything as it is.
  await inPage(app, "document.querySelector('#overlay .cancel').click()")
  await expect.poll(() => inPage<boolean>(app, "document.getElementById('overlay').hidden")).toBe(true)
  expect(read()).toBe(changed)
  // Replace restores.
  await window.mouse.click(versions.x, versions.y)
  await expect
    .poll(() => inPage<number>(app, "document.querySelectorAll('#versions-menu .item[data-version]').length"))
    .toBe(1)
  await inPage(app, "document.querySelector('#versions-menu .item[data-version]').click()")
  await expect.poll(() => inPage<boolean>(app, "!document.getElementById('overlay').hidden")).toBe(true)
  expect(await inPage<string>(app, "document.querySelector('#overlay .confirm').textContent")).toBe('Replace')
  await inPage(app, "document.querySelector('#overlay .confirm').click()")
  await expect.poll(() => read(), { timeout: 15_000 }).toBe(PAYMENT)
  await expect.poll(buttonText, { timeout: 15_000 }).toBe('Pay $27')
  await expect.poll(toast).toBe('Version restored.')
  await expect(window.locator('.fl-draft-panel-text')).toHaveValue('Pay $27', { timeout: 15_000 })

  // ── Undo after a restore brings the change back ─────────────────────────
  await expect.poll(() => inPage<boolean>(app, "document.getElementById('undo').disabled")).toBe(false)
  await window.mouse.click(undo.x, undo.y)
  await expect.poll(() => read(), { timeout: 15_000 }).toBe(changed)
  await expect.poll(buttonText, { timeout: 15_000 }).toBe('Pay twice')
})
