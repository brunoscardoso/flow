import type { ElectronApplication, Page } from '@playwright/test'
import { test, expect } from '../fixtures/electron'

/**
 * UX sweep — flow 12 (panel toggles & keyboard shortcuts), round 22.
 *
 * The app ships Electron's stock `role: 'viewMenu'` (main/menu.ts:69), so every
 * user has **View ▸ Zoom In (⌘+) / Zoom Out (⌘-) / Actual Size (⌘0)**. Zoom
 * works and even survives a relaunch — but the shell's macOS traffic-light
 * clearance does not follow it.
 *
 * `.fl-titlebar` reserves that clearance as a fixed CSS length
 * (renderer/shell.ts:1577 — `padding: 0 var(--fl-space-sm) 0 78px`, commented
 * "Clear the macOS traffic lights (hiddenInset) on the left"), and the window is
 * created with `titleBarStyle: 'hiddenInset'` (main/index.ts:224). The traffic
 * lights are native NSWindow buttons drawn in POINTS; the padding is in CSS px,
 * which page zoom scales. So the app's own declared clearance is only honoured
 * at exactly 100%:
 *
 *   zoom 100%  →  78 CSS px  = 78.0 pt   ✓ (the app's own requirement)
 *   ⌘- ×2      →  78 CSS px  = 65.0 pt   ✗
 *   ⌘- ×4      →  78 CSS px  = 54.2 pt   ✗  ← first titlebar control (the ⌘B
 *                                            sidebar toggle) starts here
 *
 * The titlebar's own height goes the same way (34 px → 23.6 pt), so the button
 * row also stops fitting inside it vertically.
 *
 * This spec measures the clearance IN POINTS at each zoom step — the unit macOS
 * draws its window buttons in — using the app's own 78px constant as the
 * threshold, so it needs no external metric to be meaningful.
 */

/** The clearance the shell itself declares it needs, in points. */
const REQUIRED_CLEARANCE_PT = 78

async function clickView(app: ElectronApplication, window: Page, label: string): Promise<void> {
  const ok = await app.evaluate(({ Menu, BrowserWindow }, l) => {
    const view = Menu.getApplicationMenu()?.items.find((i) => i.label === 'View')
    const item = view?.submenu?.items.find((s) => s.label === l)
    if (!item) return false
    const win = BrowserWindow.getAllWindows()[0]
    item.click(undefined as never, win, win.webContents as never)
    return true
  }, label)
  expect(ok, `View ▸ ${label} exists`).toBe(true)
  await window.waitForTimeout(350)
}

/** Titlebar geometry converted from CSS px into POINTS (CSS px × zoom factor). */
async function titlebarPoints(
  app: ElectronApplication,
  window: Page,
): Promise<{ zoomFactor: number; clearancePt: number; heightPt: number; firstControlPt: number }> {
  const css = await window.evaluate(() => {
    const tb = document.querySelector('.fl-titlebar') as HTMLElement | null
    const icon = document.querySelector('.fl-titlebar-icon') as HTMLElement | null
    return {
      padLeft: tb ? parseFloat(getComputedStyle(tb).paddingLeft) : NaN,
      height: tb ? tb.getBoundingClientRect().height : NaN,
      firstControlX: icon ? icon.getBoundingClientRect().x : NaN,
    }
  })
  const zoomFactor = await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].webContents.getZoomFactor(),
  )
  return {
    zoomFactor: +zoomFactor.toFixed(3),
    clearancePt: +(css.padLeft * zoomFactor).toFixed(1),
    heightPt: +(css.height * zoomFactor).toFixed(1),
    firstControlPt: +(css.firstControlX * zoomFactor).toFixed(1),
  }
}

test.describe('flow 12 — View ▸ Zoom vs the titlebar traffic-light clearance', () => {
  test('control: the View menu really offers zoom, and it applies', async ({ window, app }) => {
    const labels = await app.evaluate(({ Menu }) =>
      Menu.getApplicationMenu()
        ?.items.find((i) => i.label === 'View')
        ?.submenu?.items.map((s) => s.label),
    )
    expect(labels).toEqual(expect.arrayContaining(['Actual Size', 'Zoom In', 'Zoom Out']))

    const at100 = await titlebarPoints(app, window)
    expect(at100.zoomFactor).toBe(1)
    // At 100% the shell honours the clearance it declares it needs.
    expect(at100.clearancePt).toBe(REQUIRED_CLEARANCE_PT)

    await clickView(app, window, 'Zoom Out')
    await clickView(app, window, 'Zoom Out')
    const zoomed = await titlebarPoints(app, window)
    expect(zoomed.zoomFactor, 'Zoom Out actually applies').toBeLessThan(1)

    await clickView(app, window, 'Actual Size')
    await expect
      .poll(async () => (await titlebarPoints(app, window)).zoomFactor, { timeout: 5000 })
      .toBe(1)
  })

  // ── TRIPWIRE ─────────────────────────────────────────────────────────────
  // Fix-agnostic: however the shell keeps the macOS window buttons clear
  // (a zoom-aware padding, `setWindowButtonPosition`, or excluding the titlebar
  // from zoom), the clearance in POINTS must never fall below the 78pt the
  // shell itself says it needs. Un-`fixme` when zoom stops shrinking it.
  test.fixme(
    'the traffic-light clearance survives View ▸ Zoom Out (⌘-)',
    async ({ window, app }) => {
      for (let i = 0; i < 4; i++) await clickView(app, window, 'Zoom Out')
      await window.waitForTimeout(800)

      const zoomed = await titlebarPoints(app, window)
      await window.screenshot({
        path: 'e2e/ux/__screens/panels-zoom-titlebar-clearance.png',
        clip: { x: 0, y: 0, width: 460, height: 40 },
      })

      expect(zoomed.zoomFactor).toBeLessThan(1)
      expect(
        zoomed.clearancePt,
        `titlebar reserves only ${zoomed.clearancePt}pt for the macOS window buttons ` +
          `(needs ${REQUIRED_CLEARANCE_PT}pt); first control starts at ${zoomed.firstControlPt}pt`,
      ).toBeGreaterThanOrEqual(REQUIRED_CLEARANCE_PT)
    },
  )
})

export {}
