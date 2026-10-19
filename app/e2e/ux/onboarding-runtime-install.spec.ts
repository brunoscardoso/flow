import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

/**
 * A GUI-launched app cannot see the tools its user's terminal can.
 *
 * Reported from a real desktop: "Copilot is not installed on this machine, so
 * Flow cannot run it" — on a machine running GitHub Copilot CLI 1.0.80. A
 * double-clicked macOS app inherits `/usr/bin:/bin:/usr/sbin:/sbin`, so
 * spawning `copilot` ENOENTs in a millisecond and Flow reported that as a fact
 * about the machine rather than a fact about its own PATH.
 *
 * This launches Electron with exactly that PATH — the Finder condition, which
 * the normal fixture (started from a developer's shell) can never reproduce —
 * and requires the runtime step to find the tool anyway.
 */

const MAIN_ENTRY = resolve(__dirname, '../../out/main/index.js')
const WIZARD = '.fl-settings-overlay:not([hidden]):has(.fl-wizard-body)'
/** What macOS hands an app launched by clicking it. */
const GUI_PATH = '/usr/bin:/bin:/usr/sbin:/sbin'

test('a runtime the login shell can find is not reported as missing (GUI PATH)', async () => {
  const userDataDir = mkdtempSync(join(tmpdir(), 'flow-gui-path-'))
  let app: ElectronApplication | undefined
  try {
    app = await electron.launch({
      args: [MAIN_ENTRY, `--user-data-dir=${userDataDir}`],
      env: {
        ...process.env,
        PATH: GUI_PATH,
        ELECTRON_RENDERER_URL: '',
        NODE_ENV: 'production',
        FLOW_E2E: '1',
      },
    })
    const win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')

    const wizard = win.locator(WIZARD)
    await wizard.locator('.fl-wizard-btn', { hasText: 'Next' }).click()
    await expect(wizard.locator('.fl-settings-header')).toContainText('Choose your agent')

    await wizard.locator('.fl-wizard-btn', { hasText: 'GitHub Copilot' }).click()
    const body = wizard.locator('.fl-wizard-body')

    // The machine running this suite has Copilot installed (/opt/homebrew/bin),
    // which is NOT on the PATH above. Finding it takes asking the login shell.
    // Either it is ready, or the only thing left is the sign-in — never the
    // install, which would mean Flow failed to find what is already there.
    await expect(body).toContainText(/Copilot is ready|Copilot needs:/)
    await expect(wizard.locator('.fl-wizard-btn', { hasText: 'Install Copilot' })).toHaveCount(0)
  } finally {
    await app?.close()
  }
})

/**
 * The sign-in itself, in the app.
 *
 * The first version handed over a terminal with the login command typed into
 * it — which, from inside a modal setup wizard, is either invisible (the shell
 * is behind the overlay) or throws the user out of onboarding. `copilot login
 * --device-code` prints a URL and a code and waits; showing those is all this
 * ever needed.
 *
 * This drives the REAL login: it creates a genuine (unclaimed, short-lived)
 * device code at github.com and then cancels. Nothing is authorized.
 */
test('signing in to a runtime happens in the panel, with a link and a code', async () => {
  const userDataDir = mkdtempSync(join(tmpdir(), 'flow-runtime-login-'))
  let app: ElectronApplication | undefined
  try {
    app = await electron.launch({
      args: [MAIN_ENTRY, `--user-data-dir=${userDataDir}`],
      env: { ...process.env, ELECTRON_RENDERER_URL: '', NODE_ENV: 'production', FLOW_E2E: '1' },
    })
    const win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')

    const wizard = win.locator(WIZARD)
    await wizard.locator('.fl-wizard-btn', { hasText: 'Next' }).click()
    await wizard.locator('.fl-wizard-btn', { hasText: 'GitHub Copilot' }).click()

    const signIn = wizard.locator('.fl-wizard-btn', { hasText: 'Sign in to Copilot' })
    // Skipped when this machine is already signed in — there is no sign-in
    // button to press then, and asserting one would be asserting a bug.
    test.skip((await signIn.count()) === 0, 'Copilot is already signed in on this machine')
    await signIn.click()

    const body = wizard.locator('.fl-wizard-body')
    // No terminal, no shell: the page to open and the code to type are here.
    await expect(body.locator('a', { hasText: 'Open the sign-in page' })).toBeVisible({
      timeout: 30_000,
    })
    await expect(body).toContainText('Enter this code there')
    await expect(body.locator('code')).toHaveText(/[A-Z0-9]{4}-[A-Z0-9]{4}/)

    // Cancelling stops the child rather than leaving an OAuth waiting forever.
    await body.locator('.fl-settings-inline-btn', { hasText: 'Cancel' }).click()
    await expect(body).toContainText(/did not complete/i, { timeout: 20_000 })
  } finally {
    await app?.close()
  }
})
