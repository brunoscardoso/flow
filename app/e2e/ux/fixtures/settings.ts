import { expect, type ElectronApplication, type Page } from '@playwright/test'

/**
 * OPEN THE SETTINGS PAGE, on the group a spec is about.
 *
 * Settings stopped being a 560px dialog holding one scrolling column of every
 * decision the app can make: it is a page in the editor area with its groups
 * behind tabs. That means a spec can no longer assert on a section just because
 * Settings is open — the section has to be in the group that is showing, which
 * is a real thing about the product and so a real step in the walk.
 *
 * `group` is the tab's own label ("Models", "Conversation files", "Tasks",
 * "Integrations", "App"). Models is where the page opens, so it is the default.
 */
export async function openSettings(win: Page, group = 'Models'): Promise<void> {
  await win.evaluate(() => document.dispatchEvent(new CustomEvent('flow:open-settings')))
  await expect(win.locator('.fl-settings-page')).toBeVisible({ timeout: 15_000 })
  const tab = win.locator('.fl-settings-tab', { hasText: group })
  // A GROUP CAN BE ABSENT, and that is information rather than a flake: Tasks
  // needs an open project and Conversation files needs a preload with the defaults
  // channel, and both lose their tab rather than opening onto nothing.
  await expect(tab).toBeVisible({ timeout: 15_000 })
  await tab.click()
}

/**
 * Make a SEEDED account read as signed in.
 *
 * Specs seed an `accounts` row pointing at an empty config dir, which was
 * enough until #1319: the Connect step now asks whether the default account is
 * still logged in (`accounts:status` runs `claude auth status` against that
 * dir), and an empty dir truthfully answers "no" — so Connect stayed gated and
 * every walk past it stalled. Those specs are about the steps AFTER Connect,
 * so the probe answers "logged in" here; a spec about the probe itself must
 * not use this. Main is reached after the first window (evaluated during
 * startup, main's context can be replaced under the call).
 */
export async function trustSeededAccount(app: ElectronApplication): Promise<void> {
  await app.firstWindow()
  await app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('accounts:status')
    ipcMain.handle('accounts:status', () => ({ checked: true, loggedIn: true, identity: null }))
  })
}

/**
 * Walk the onboarding wizard forward until its header reads `title`.
 *
 * The wizard's steps are welcome → runtime → connect → project → mode →
 * signIn → settings → workspace (wizard-controller.ts WIZARD_STEPS). Specs that
 * counted Next presses broke each time a step was added (runtime 2026-08-18,
 * signIn and workspace since); walking BY TITLE says where the spec means to
 * be, and every press still waits for that step's own gate to open.
 */
export async function advanceWizardTo(win: Page, title: string, maxSteps = 8): Promise<void> {
  const wizard = win.locator('.fl-settings-overlay:not([hidden]):has(.fl-wizard-body)')
  const header = wizard.locator('.fl-settings-header')
  for (let step = 0; step < maxSteps; step += 1) {
    const shown = ((await header.textContent()) ?? '').trim()
    if (shown.includes(title)) return
    const next = wizard.locator('.fl-wizard-btn', { hasText: 'Next' })
    await expect(next, `Next is gated on "${shown}"`).toBeEnabled({ timeout: 15_000 })
    await next.click()
    await expect(header).not.toHaveText(shown, { timeout: 5_000 })
  }
  await expect(header).toContainText(title)
}

/** Walk the onboarding wizard BACK until its header reads `title` (see advanceWizardTo). */
export async function backWizardTo(win: Page, title: string, maxSteps = 8): Promise<void> {
  const wizard = win.locator('.fl-settings-overlay:not([hidden]):has(.fl-wizard-body)')
  const header = wizard.locator('.fl-settings-header')
  for (let step = 0; step < maxSteps; step += 1) {
    const shown = ((await header.textContent()) ?? '').trim()
    if (shown.includes(title)) return
    await wizard.locator('.fl-wizard-btn', { hasText: /^Back$/ }).click()
    await expect(header).not.toHaveText(shown, { timeout: 5_000 })
  }
  await expect(header).toContainText(title)
}
