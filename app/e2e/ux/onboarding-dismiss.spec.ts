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
 * UX sweep — flow 0 (onboarding), DISMISSAL semantics: two behaviors a real
 * first-run user relies on that the existing onboarding specs never drive —
 *
 *  1. **Escape closes the wizard even after a button click** (the #475 fix).
 *     On macOS a `<button>` click doesn't move focus, so `activeElement` falls
 *     back to `document.body`; the old Escape handler was bound to the overlay
 *     element and never fired from there — a dead key after any interaction.
 *     The fix binds the handler to `document` while the wizard is open. This
 *     drives the exact broken scenario (advance Welcome→Connect by clicking
 *     Next, then press Escape) and asserts the wizard closes AND the shell is
 *     interactive afterwards — never a trapped, dimmed overlay.
 *
 *  2. **A dismissal is "finish later", not "done"** — closing the wizard by
 *     Escape (or Skip) must NOT persist onboarding completion, so a relaunch on
 *     the same still-account-less userData dir re-shows it. Completion is earned
 *     only by finishing (or by having an account + project). This guards that a
 *     dismiss never silently opts the user out of setup.
 *
 * Self-contained raw launches (own userData dir) so the relaunch persistence
 * path is drivable, mirroring onboarding-full-flow.spec.ts. Zero credentials,
 * zero native dialogs — the fresh wizard is fully reachable on its own.
 */

const MAIN_ENTRY = resolve(__dirname, '../../out/main/index.js')
const WIZARD = '.fl-settings-overlay:not([hidden]):has(.fl-wizard-body)'
const SCREENS = 'e2e/ux/__screens'

function launch(userDataDir: string): Promise<ElectronApplication> {
  return electron.launch({
    args: [MAIN_ENTRY, `--user-data-dir=${userDataDir}`],
    env: {
      ...process.env,
      ELECTRON_RENDERER_URL: '',
      NODE_ENV: 'production',
      FLOW_E2E: '1',
    },
  })
}

/** Open a fresh window and return it once the DOM is ready, with error capture. */
async function bootWindow(app: ElectronApplication, errors: string[]): Promise<Page> {
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')
  win.on('pageerror', (e) => errors.push(e.message))
  return win
}

test('Escape closes the fresh first-run wizard after a Next click, and leaves an interactive shell (#475)', async () => {
  const userDataDir = mkdtempSync(join(tmpdir(), 'flow-e2e-onboard-esc-'))
  let app: ElectronApplication | null = null
  const errors: string[] = []
  try {
    app = await launch(userDataDir)
    const win = await bootWindow(app, errors)

    // A fresh, account-less userData dir auto-opens the wizard on Welcome.
    const wizard = win.locator(WIZARD)
    await expect(wizard).toHaveCount(1)
    await expect(wizard.locator('.fl-settings-header')).toContainText('Welcome to Flow')

    // Advance Welcome → Connect by CLICKING Next. On macOS this click does not
    // focus the button, so activeElement is document.body — the precise state
    // where the old overlay-bound Escape handler was dead (#475).
    // The runtime step now sits between Welcome and Connect: which agent
    // runs is chosen before whose account gets connected.
    await wizard.locator('.fl-wizard-btn', { hasText: 'Next' }).click()
    await expect(wizard.locator('.fl-settings-header')).toContainText('Choose your agent')
    await wizard.locator('.fl-wizard-btn', { hasText: 'Next' }).click()
    await expect(wizard.locator('.fl-settings-header')).toContainText('Connect a Claude account')

    // Escape must now close the wizard from body-focus (document-bound handler).
    await win.keyboard.press('Escape')
    await expect(win.locator(WIZARD)).toHaveCount(0)

    // The shell underneath must be live — not occluded by a lingering overlay.
    await expect(win.locator('.fl-thread-sidebar')).toBeVisible()
    await expect(win.locator('fl-button[aria-label="New thread"]')).toBeEnabled()

    await win.screenshot({ path: `${SCREENS}/onboarding-escape-closed.png` })
    expect(errors, errors.join(', ')).toHaveLength(0)
  } finally {
    if (app) await app.close()
    rmSync(userDataDir, { recursive: true, force: true })
  }
})

test('a dismissed wizard is not marked complete: relaunch on the same account-less dir re-shows it', async () => {
  const userDataDir = mkdtempSync(join(tmpdir(), 'flow-e2e-onboard-persist-'))
  let app: ElectronApplication | null = null
  const errors: string[] = []
  try {
    // ── first launch: wizard auto-opens; dismiss it via Escape (a "finish later"). ──
    app = await launch(userDataDir)
    let win = await bootWindow(app, errors)
    await expect(win.locator(WIZARD)).toHaveCount(1)
    await win.keyboard.press('Escape')
    await expect(win.locator(WIZARD)).toHaveCount(0)
    await app.close()
    app = null

    // ── relaunch: still no account, completion never persisted → wizard returns. ──
    app = await launch(userDataDir)
    win = await bootWindow(app, errors)
    const wizard = win.locator(WIZARD)
    await expect(wizard).toHaveCount(1)
    // Freshly reset to Welcome — a dismiss must not leave a half-finished wizard.
    await expect(wizard.locator('.fl-settings-header')).toContainText('Welcome to Flow')
    const dots = await wizard
      .locator('.fl-wizard-dot')
      .evaluateAll((ds) => ds.map((d) => d.getAttribute('data-active')))
    // One dot per step (eight since the agent, sign-in and Workspace steps),
    // only Welcome's lit.
    expect(dots[0]).toBe('true')
    expect(dots.slice(1).every((dot) => dot === 'false'), JSON.stringify(dots)).toBe(true)

    await win.screenshot({ path: `${SCREENS}/onboarding-reshow-after-dismiss.png` })
    expect(errors, errors.join(', ')).toHaveLength(0)
  } finally {
    if (app) await app.close()
    rmSync(userDataDir, { recursive: true, force: true })
  }
})
