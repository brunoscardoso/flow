import { test, expect } from '../fixtures/electron'
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'

/**
 * UX sweep — flow 7 (Editor): the #735 close-operations context menu on EDITOR
 * tabs (right-click → Close / Close Others / Close to the Left / Close to the
 * Right / Close All). Prior flow-7 rounds probed cycling, dirty-close, conflict
 * merge, markdown preview, tab overflow (#700), selection-to-chat, save-fail,
 * multi-project follow, and external reload — never this menu, which was only
 * e2e-covered on TERMINAL tabs. This drives it live on the editor tab strip.
 *
 * Findings:
 *  - The core close-ops behavior is correct: the menu offers the five ops with
 *    the right enabled/disabled states, and each op closes exactly the right
 *    tabs and re-activates the surviving anchor (guards 1–2, green).
 *  - Regression guard #827 (fixed): the menu clamps into the viewport, so
 *    right-clicking the RIGHTMOST tab keeps every label fully visible.
 */

const SCREENS = 'e2e/ux/__screens'

function appErrors(errors: string[]): string[] {
  return errors.filter((m) => m !== 'Canceled')
}

function tab(win: Page, name: string) {
  return win.locator('.fl-shell fl-tabs .tab', { hasText: name })
}

function ctxMenu(win: Page) {
  return win.locator('.fl-shell fl-tabs .ctx-menu')
}

function ctxItem(win: Page, label: RegExp) {
  return win.locator('.fl-shell fl-tabs .ctx-item').filter({ hasText: label })
}

/** Open a file the decoupled way — same event blueprint rows / chat links use. */
async function openViaEvent(win: Page, rootPath: string, relPath: string): Promise<void> {
  await win.evaluate(
    ({ rootPath, relPath }) => {
      document.dispatchEvent(new CustomEvent('flow:open-file', { detail: { rootPath, relPath } }))
    },
    { rootPath, relPath },
  )
}

/** Seed `names` files under `dir`, activate, and open them all in strip order. */
async function seedAndOpen(win: Page, names: string[]): Promise<string> {
  const dir = await seedProject(win)
  names.forEach((n, i) => writeFileSync(join(dir, n), `export const V${i} = "${n}-marker"\n`))
  await activateProject(win, dir)
  for (const n of names) {
    await openViaEvent(win, dir, n)
    await expect(tab(win, n)).toHaveCount(1, { timeout: 10000 })
  }
  return dir
}

/** Right-click a tab and wait for its close-ops menu. */
async function openCloseOps(win: Page, name: string): Promise<void> {
  await tab(win, name).click({ button: 'right' })
  await expect(ctxMenu(win)).toBeVisible()
}

test.afterAll(() => cleanupSeeds())

test('close-ops menu: right-click an editor tab → all five ops, "Close Others" keeps + activates the anchor', async ({
  window,
}) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  const names = ['alpha.ts', 'beta.ts', 'gamma.ts', 'delta.ts']
  await seedAndOpen(window, names)
  await expect(tab(window, 'delta.ts')).toHaveClass(/active/)

  // Right-click the middle tab → the #735 menu with all five ops, all enabled
  // (beta has closable tabs on both sides).
  await openCloseOps(window, 'beta.ts')
  await expect(ctxItem(window, /^Close$/)).toBeVisible()
  await expect(ctxItem(window, /^Close Others$/)).toBeEnabled()
  await expect(ctxItem(window, /^Close to the Left$/)).toBeEnabled()
  await expect(ctxItem(window, /^Close to the Right$/)).toBeEnabled()
  await expect(ctxItem(window, /^Close All$/)).toBeEnabled()
  await window.screenshot({ path: `${SCREENS}/editor-closeops-menu.png` })

  // Close Others → only beta survives, and it becomes the active tab.
  await ctxItem(window, /^Close Others$/).click()
  await expect(tab(window, 'beta.ts')).toHaveCount(1)
  await expect(tab(window, 'alpha.ts')).toHaveCount(0)
  await expect(tab(window, 'gamma.ts')).toHaveCount(0)
  await expect(tab(window, 'delta.ts')).toHaveCount(0)
  await expect(tab(window, 'beta.ts')).toHaveClass(/active/)

  const appErrs = appErrors(errors)
  expect(appErrs, appErrs.join(', ')).toHaveLength(0)
})

test('close-ops menu: "Close to the Right"/"Close to the Left" close exactly the anchored side', async ({
  window,
}) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  await seedAndOpen(window, ['alpha.ts', 'beta.ts', 'gamma.ts', 'delta.ts'])

  // Anchored on beta: Close to the Right removes gamma + delta, keeps alpha + beta.
  await openCloseOps(window, 'beta.ts')
  await ctxItem(window, /^Close to the Right$/).click()
  await expect(tab(window, 'gamma.ts')).toHaveCount(0)
  await expect(tab(window, 'delta.ts')).toHaveCount(0)
  await expect(tab(window, 'alpha.ts')).toHaveCount(1)
  await expect(tab(window, 'beta.ts')).toHaveCount(1)

  // Anchored on beta: Close to the Left removes alpha, keeps beta.
  await openCloseOps(window, 'beta.ts')
  await ctxItem(window, /^Close to the Left$/).click()
  await expect(tab(window, 'alpha.ts')).toHaveCount(0)
  await expect(tab(window, 'beta.ts')).toHaveCount(1)

  // On the sole remaining tab, side ops are disabled (nothing to close) — no dead clicks.
  await openCloseOps(window, 'beta.ts')
  await expect(ctxItem(window, /^Close to the Left$/)).toBeDisabled()
  await expect(ctxItem(window, /^Close to the Right$/)).toBeDisabled()
  await expect(ctxItem(window, /^Close$/)).toBeEnabled()

  const appErrs = appErrors(errors)
  expect(appErrs, appErrs.join(', ')).toHaveLength(0)
})

test(
  'close-ops tripwire (#827): the menu on the rightmost tab must stay within the viewport (no right-edge clip)',
  async ({ window }) => {
    const errors: string[] = []
    window.on('pageerror', (e) => errors.push(e.message))

    // A full strip so the last-opened tab is scrolled hard against the right edge.
    const names = Array.from({ length: 30 }, (_, i) => `probe-file-${String(i).padStart(2, '0')}.ts`)
    await seedAndOpen(window, names)
    const last = tab(window, 'probe-file-29.ts')
    await expect(last).toHaveClass(/active/)

    await last.click({ button: 'right' })
    await expect(ctxMenu(window)).toBeVisible()

    const vp = await window.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }))
    const box = await ctxMenu(window).boundingBox()
    expect(box).not.toBeNull()
    // Today the menu overflows ~82px past the right edge (#827); a viewport clamp
    // fixes it and flips this green.
    expect(box!.x + box!.width, 'close-ops menu right edge must stay within the viewport').toBeLessThanOrEqual(
      vp.width,
    )
    expect(box!.y + box!.height, 'close-ops menu bottom edge must stay within the viewport').toBeLessThanOrEqual(
      vp.height,
    )
  },
)
