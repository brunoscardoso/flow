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
 * UX sweep — flow 0 (onboarding), Escape FOCUS-THEFT: the first-run wizard is a
 * modal over the shell, but the docked terminal panel auto-starts at boot
 * (`terminal-panel.ts` `ensureStarted()` → `tab.term?.focus()`) and its focus
 * call runs AFTER the wizard's `open()` focuses its panel — so keyboard focus
 * lands on the terminal's hidden `xterm-helper-textarea` BEHIND the overlay.
 *
 * When a first-run user presses Escape on the untouched Welcome step, xterm
 * consumes the keystroke (stopPropagation) and it never reaches the wizard's
 * document-bound Escape handler — the wizard doesn't close. Escape only starts
 * working after the user clicks something (which moves focus to `document.body`,
 * off xterm). That's the same #525-class xterm-swallows-Escape failure, but
 * triggered automatically at first run rather than by a user-invoked ⌃`.
 *
 * Filed as #683. This guards:
 *   - a LIVE guard that Escape DOES close the wizard after a Next click (the
 *     working path — proves the #475 document-bound handler still fires), and
 *   - a `fixme` TRIPWIRE that Escape closes the wizard on the UNTOUCHED Welcome
 *     step. It fails today (focus stolen by the terminal) and flips green when
 *     #683 lands — capture-phase Escape / focus-trap / no-autofocus-under-modal.
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

async function bootWindow(app: ElectronApplication, errors: string[]): Promise<Page> {
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')
  win.on('pageerror', (e) => errors.push(e.message))
  return win
}

test('LIVE: Escape closes the wizard after a Next click (focus off xterm → handler fires, #475)', async () => {
  const userDataDir = mkdtempSync(join(tmpdir(), 'flow-e2e-esc-live-'))
  let app: ElectronApplication | null = null
  const errors: string[] = []
  try {
    app = await launch(userDataDir)
    const win = await bootWindow(app, errors)

    const wizard = win.locator(WIZARD)
    await expect(wizard).toHaveCount(1)
    await expect(wizard.locator('.fl-settings-header')).toContainText('Welcome to Flow')

    // Clicking Next moves focus to document.body (macOS button click doesn't
    // focus), away from the terminal's xterm-helper-textarea. Escape now reaches
    // the wizard's document-bound handler.
    // The runtime step now sits between Welcome and Connect: which agent
    // runs is chosen before whose account gets connected.
    await wizard.locator('.fl-wizard-btn', { hasText: 'Next' }).click()
    await expect(wizard.locator('.fl-settings-header')).toContainText('Choose your agent')
    await wizard.locator('.fl-wizard-btn', { hasText: 'Next' }).click()
    await expect(wizard.locator('.fl-settings-header')).toContainText('Connect a Claude account')

    await win.keyboard.press('Escape')
    await expect(win.locator(WIZARD)).toHaveCount(0)
    await expect(win.locator('.fl-thread-sidebar')).toBeVisible()
    expect(errors, errors.join(', ')).toHaveLength(0)
  } finally {
    if (app) await app.close()
    rmSync(userDataDir, { recursive: true, force: true })
  }
})

// #683 (fixed): the boot terminal auto-start no longer steals focus while the
// wizard overlay is open (activateTab skips focus when a modal is visible), so
// Escape reaches the wizard's document handler and closes it even on the
// untouched Welcome step.
test(
  '#683: Escape closes the wizard on the untouched first-run Welcome step',
  async () => {
    const userDataDir = mkdtempSync(join(tmpdir(), 'flow-e2e-esc-trip-'))
    let app: ElectronApplication | null = null
    const errors: string[] = []
    try {
      app = await launch(userDataDir)
      const win = await bootWindow(app, errors)

      const wizard = win.locator(WIZARD)
      await expect(wizard).toHaveCount(1)
      await expect(wizard.locator('.fl-settings-header')).toContainText('Welcome to Flow')

      // No interaction — press Escape exactly as a first-run user would to dismiss.
      await win.keyboard.press('Escape')
      await win.screenshot({ path: `${SCREENS}/onboarding-escape-welcome.png` })

      // Currently focus is on TEXTAREA.xterm-helper-textarea (terminal behind the
      // overlay) and xterm swallows Escape — so the wizard stays open. When #683
      // is fixed this closes.
      await expect(win.locator(WIZARD)).toHaveCount(0)
      expect(errors, errors.join(', ')).toHaveLength(0)
    } finally {
      if (app) await app.close()
      rmSync(userDataDir, { recursive: true, force: true })
    }
  },
)
