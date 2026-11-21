import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import type { ElectronApplication } from '@playwright/test'

import { test, expect } from '../fixtures/electron'
import { activateProject, cleanupSeeds, seedProject } from '../ux/fixtures/seed'
import { draftPageUrl } from '../../src/shared/ui-drafts'

/**
 * A draft screen always scrolls in Flow's browser, in the real app.
 *
 * The screen is the shape that was cut off for real: its stylesheet copied an
 * app's `body { overflow: hidden }`, and it lays eight 300px columns side by
 * side (2,600px). Served by Flow, the page scrolls sideways and down anyway.
 */

test.afterAll(() => cleanupSeeds())

const WIDE =
  '<!doctype html><html><head><link rel="stylesheet" href="tokens.css"></head><body>' +
  '<div style="display:grid;grid-template-columns:repeat(8,300px);gap:24px;padding:32px">' +
  Array.from({ length: 8 }, (_, i) => `<div style="height:1600px;border:1px solid #ccc">Option ${String(i + 1)}</div>`).join('') +
  '</div></body></html>'

function seedCanvas(root: string): void {
  const dir = join(root, 'flow', 'drafts', 'wide')
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'layout.json'),
    JSON.stringify({ name: 'Wide', screens: [{ id: 'all', title: 'All', order: 0, frame: { x: 0, y: 0, w: 1280, h: 800 } }] }),
  )
  writeFileSync(join(dir, 'tokens.css'), 'html, body { height: 100%; }\nbody {\n  margin: 0;\n  overflow: hidden;\n}\n')
  writeFileSync(join(dir, 'all.html'), WIDE)
}

async function inActivePage<T>(app: ElectronApplication, code: string): Promise<T | null> {
  return app.evaluate(async ({ BrowserWindow, webContents }, script) => {
    const host = BrowserWindow.getAllWindows()[0]?.webContents
    const id = (await host?.executeJavaScript(
      "(() => { try { return [...document.querySelectorAll('.fl-browser-tab webview')].find((w) => w.style.visibility !== 'hidden')?.getWebContentsId() ?? null } catch { return null } })()",
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

test('a wide draft screen whose stylesheet hides overflow still scrolls both ways', async ({ app, window }) => {
  test.setTimeout(120_000)
  const root = await seedProject(window, 'flow-e2e-drafts-scroll-', seedCanvas)
  await activateProject(window, root)
  const url = draftPageUrl({ kind: 'screen', root, canvas: 'wide', screen: 'all', mode: 'single' })
  await window.evaluate((u) => document.dispatchEvent(new CustomEvent('flow:open-browser', { detail: { url: u } })), url)

  // The screen is on screen, and its stylesheet really does hide overflow.
  await expect.poll(() => inActivePage<string>(app, "document.body?.innerText.includes('Option 8') ? 'ok' : null"), { timeout: 20_000 }).toBe('ok')
  // (A sandboxed page cannot read its stylesheet's rules: the tokens are known
  // to apply because they take away the body's default 8px margin.)
  await expect.poll(() => inActivePage<string>(app, 'getComputedStyle(document.body).marginTop')).toBe('0px')
  expect(await inActivePage<number>(app, "document.querySelectorAll('style[data-flow-scroll-guard]').length")).toBe(1)

  // Sideways and down, the page moves.
  const moved = await inActivePage<{ x: number; y: number; wide: boolean }>(
    app,
    `(() => { const s = document.scrollingElement; s.scrollLeft = 900; s.scrollTop = 600;
      return { x: s.scrollLeft, y: s.scrollTop, wide: s.scrollWidth > s.clientWidth + 1000 } })()`,
  )
  expect(moved?.wide).toBe(true)
  expect(moved?.x).toBeGreaterThan(800)
  expect(moved?.y).toBeGreaterThan(500)
})
