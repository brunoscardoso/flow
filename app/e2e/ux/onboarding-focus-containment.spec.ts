import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
  type Page,
} from '@playwright/test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

/**
 * UX sweep — flow 0 (onboarding), FOCUS CONTAINMENT: the first-run wizard is a
 * modal for the MOUSE but not for the KEYBOARD.
 *
 * `wizard-view.ts` focuses `.fl-settings-panel` on open and stops there; nothing
 * in `src/renderer` traps focus (no consumer of `.fl-settings-overlay` does).
 * So three Tab presses walk focus out of the overlay and into the shell BEHIND
 * the backdrop, where the user can't see what's focused: Enter then activates
 * invisible controls (the sidebar rail swaps panels silently), and at Tab ~19
 * focus lands on `textarea.xterm-helper-textarea` — keystrokes go to the LIVE
 * shell prompt, and xterm's stopPropagation kills the wizard's Escape handler
 * (the #683/#525 dead-end, reached with no shortcut at all).
 *
 * The neighbouring guards deliberately cover other channels only: `shell.ts`
 * blocks global panel SHORTCUTS while an overlay is open (#525), and
 * `terminal-panel.ts` stops the terminal AUTO-START from stealing focus under an
 * overlay (#683). Neither sees user-driven Tab. Filed as #1006.
 *
 * This guards:
 *   - LIVE: the backdrop really does block the mouse (the modal intent that the
 *     keyboard leak violates) while the wizard's own controls stay clickable;
 *   - LIVE: the keyboard-stranded state is recoverable with the mouse — clicking
 *     a wizard control puts focus back in the overlay and Escape closes it again
 *     (true before AND after a fix, so it stays a valid guard);
 *   - GUARD (#1006 fixed): Tab/Shift+Tab stay INSIDE the wizard. Before the
 *     shared overlay focus trap (settings/overlay-focus-trap.ts) this failed at
 *     Tab 3 (`inWizard=false`).
 */

const MAIN_ENTRY = resolve(__dirname, '../../out/main/index.js')
const WIZARD = '.fl-settings-overlay:not([hidden]):has(.fl-wizard-body)'
const SCREENS = 'e2e/ux/__screens'

function launch(userDataDir: string): Promise<ElectronApplication> {
  return electron.launch({
    args: [MAIN_ENTRY, `--user-data-dir=${userDataDir}`],
    env: { ...process.env, ELECTRON_RENDERER_URL: '', NODE_ENV: 'production', FLOW_E2E: '1' },
  })
}

/** Boot to the FIRST-RUN wizard (fresh userData dir ⇒ no account ⇒ it opens). */
async function bootToWizard(app: ElectronApplication, errors: string[]): Promise<Page> {
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')
  win.on('pageerror', (e) => errors.push(e.message))
  await expect(win.locator(WIZARD)).toHaveCount(1, { timeout: 20_000 })
  // Let the docked terminal finish auto-starting behind the overlay — that's the
  // real first-run layout, and the surface the escaped focus eventually reaches.
  await win.waitForTimeout(2500)
  return win
}

/** Is keyboard focus still inside the modal overlay? */
function focusIsInWizard(win: Page): Promise<boolean> {
  return win.evaluate(() => !!document.activeElement?.closest('.fl-settings-overlay'))
}

/** Has focus landed on the live terminal's hidden textarea (which eats Escape)? */
function focusIsOnXterm(win: Page): Promise<boolean> {
  return win.evaluate(
    () => document.activeElement?.classList.contains('xterm-helper-textarea') ?? false,
  )
}

test('LIVE: the wizard backdrop blocks the MOUSE — shell controls behind it are unclickable, its own are not', async () => {
  const userDataDir = mkdtempSync(join(tmpdir(), 'flow-e2e-onb-focus-mouse-'))
  let app: ElectronApplication | null = null
  const errors: string[] = []
  try {
    app = await launch(userDataDir)
    const win = await bootToWizard(app, errors)
    const wizard = win.locator(WIZARD)

    // The shell behind the backdrop exists but cannot be reached with a pointer —
    // the overlay intercepts the click. This is the modal contract the keyboard
    // leak in #1006 breaks.
    expect(await win.locator('.fl-rail-item').count()).toBeGreaterThan(0)
    let mouseBlocked = false
    try {
      await win.locator('.fl-rail-item').nth(1).click({ timeout: 3_000 })
    } catch {
      mouseBlocked = true
    }
    expect(mouseBlocked).toBe(true)

    // ...while the wizard's own controls take the click normally (not a frozen UI).
    const next = wizard.locator('.fl-wizard-btn', { hasText: 'Next' })
    // The runtime step now sits between Welcome and Connect: which agent
    // runs is chosen before whose account gets connected.
    await next.click()
    await expect(wizard.locator('.fl-settings-header')).toContainText('Choose your agent')
    await next.click()
    await expect(wizard.locator('.fl-settings-header')).toContainText('Connect a Claude account')

    expect(errors).toEqual([])
  } finally {
    await app?.close()
    rmSync(userDataDir, { recursive: true, force: true })
  }
})

test('LIVE: once focus has escaped, a MOUSE click on a wizard control restores Escape-to-close', async () => {
  const userDataDir = mkdtempSync(join(tmpdir(), 'flow-e2e-onb-focus-recover-'))
  let app: ElectronApplication | null = null
  const errors: string[] = []
  try {
    app = await launch(userDataDir)
    const win = await bootToWizard(app, errors)
    const wizard = win.locator(WIZARD)

    // Tab far enough that focus is somewhere in the shell behind the overlay
    // (today it reaches xterm and swallows Escape; after #1006 it never leaves).
    for (let i = 0; i < 19; i += 1) await win.keyboard.press('Tab')

    // The documented recovery route: a mouse click on a wizard control pulls
    // focus OFF xterm (on macOS a button click leaves activeElement on
    // document.body — see #475), so the document-bound Escape handler fires again.
    await wizard.locator('.fl-wizard-btn', { hasText: 'Next' }).click()
    expect(await focusIsOnXterm(win)).toBe(false)
    await win.keyboard.press('Escape')
    await expect(wizard).toHaveCount(0)

    // ...and the shell underneath is live afterwards (no half-dismissed state).
    await expect(win.locator('.fl-rail-item').first()).toBeVisible()

    expect(errors).toEqual([])
  } finally {
    await app?.close()
    rmSync(userDataDir, { recursive: true, force: true })
  }
})

test(
  'GUARD (#1006): Tab/Shift+Tab stay inside the wizard, and Escape still closes after tabbing',
  async () => {
    const userDataDir = mkdtempSync(join(tmpdir(), 'flow-e2e-onb-focus-trap-'))
    let app: ElectronApplication | null = null
    const errors: string[] = []
    try {
      app = await launch(userDataDir)
      const win = await bootToWizard(app, errors)
      const wizard = win.locator(WIZARD)

      // Forward: focus must cycle within the overlay's own controls. Pre-fix
      // this failed on the 3rd press (button.fl-titlebar-icon, then the project
      // switcher, the sidebar rail, and finally xterm-helper-textarea).
      for (let i = 1; i <= 12; i += 1) {
        await win.keyboard.press('Tab')
        expect(await focusIsInWizard(win), `focus left the wizard on Tab ${i}`).toBe(true)
      }
      // Backward too — Shift+Tab off the first control must wrap, not escape.
      for (let i = 1; i <= 12; i += 1) {
        await win.keyboard.press('Shift+Tab')
        expect(await focusIsInWizard(win), `focus left the wizard on Shift+Tab ${i}`).toBe(true)
      }

      // Because focus never reaches xterm, Escape is never swallowed.
      await win.screenshot({ path: `${SCREENS}/onboarding-focus-containment.png` })
      await win.keyboard.press('Escape')
      await expect(wizard).toHaveCount(0)

      expect(errors).toEqual([])
    } finally {
      await app?.close()
      rmSync(userDataDir, { recursive: true, force: true })
    }
  },
)
