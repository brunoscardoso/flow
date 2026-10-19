import { _electron as electron, expect, type ElectronApplication, type Page } from '@playwright/test'
import { test } from '../fixtures/electron'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'

/**
 * UX sweep — flow 11 (Settings / accounts), round 14: the account row's LIVE
 * AUTH STATUS line and the Updates section's manual check — the two newest
 * settings surfaces (both shipped 2026-07-27) and the only ones no probe drives.
 *
 * Both are pure *feedback* surfaces, so the user-visible contract is the same:
 * a pending state ("checking…" / "Checking…") must always resolve to a definite
 * outcome, and the control must come back. A row stuck on "checking…" or an
 * update button stuck disabled reads as a hung app.
 *
 * Accounts are pre-seeded into `flow.db` BEFORE launch (the runbook-blessed
 * technique — adding one for real opens a browser sign-in Playwright can't
 * drive; the on-disk config dir never needs to exist).
 *
 * Deliberately NOT asserted here: *which* definite state a logged-out account
 * lands on. `claude auth status` exits 1 for a logged-out config dir, and the
 * probe treats "non-zero exit + loggedIn:false" as a FAILED probe, so a cleanly
 * observed logout renders as "? status check failed — try again" instead of
 * "○ signed out" — filed as #965. Asserting the correct text would be a red
 * test rather than a guard, so this spec guards the resolution contract only.
 */

const MAIN_ENTRY = resolve(__dirname, '../../out/main/index.js')
// SETTINGS IS A PAGE, not an overlay: it moved into the editor area with its
// groups behind tabs. The name is kept so the walk below reads unchanged; what
// it names is the page.
const SETTINGS_OVERLAY = '.fl-settings-page'
const SCREENS = 'e2e/ux/__screens'
/** Every definite state `#renderAccountRow` can settle on (settings-view.ts). */
const RESOLVED_STATUS = /^(● signed in|○ signed out|\? status check failed)/

function launch(userDataDir: string): Promise<ElectronApplication> {
  return electron.launch({
    args: [MAIN_ENTRY, `--user-data-dir=${userDataDir}`],
    env: { ...process.env, ELECTRON_RENDERER_URL: '', NODE_ENV: 'production', FLOW_E2E: '1' },
  })
}

/** Boot once so the main process migrates flow.db, then close. */
async function migrateDb(userDataDir: string): Promise<void> {
  const app = await launch(userDataDir)
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')
  await app.close()
}

function seedAccount(userDataDir: string): void {
  execFileSync('sqlite3', [
    join(userDataDir, 'flow.db'),
    `INSERT INTO accounts (id, label, config_dir_path, identity_hint, created_at)
       VALUES ('acc-personal', 'Personal', '/tmp/flow-e2e-nocfg-p', 'me@personal.example', '2026-01-01T00:00:00Z');
     INSERT INTO app_settings (key, value) VALUES ('default_account_id', 'acc-personal');`,
  ])
}

/** Dismiss first-run onboarding (no project is seeded in this spec). */
async function dismissWizard(win: Page): Promise<void> {
  const wizard = win.locator('.fl-settings-overlay:not([hidden]):has(.fl-wizard-body)')
  if (await wizard.count()) {
    const skip = wizard.locator('.fl-wizard-btn', { hasText: 'Skip for now' })
    if (await skip.count()) await skip.first().click()
    else await win.keyboard.press('Escape')
    await expect(wizard).toHaveCount(0)
  }
}

async function openSettings(win: Page, group = 'Models'): Promise<void> {
  await win.evaluate(() => document.dispatchEvent(new CustomEvent('flow:open-settings')))
  await expect(win.locator(SETTINGS_OVERLAY)).toBeVisible()
  // Settings is a tabbed page: a section is reachable only in its own group.
  await showSettingsGroup(win, group)
}

/**
 * Show one Settings group.
 *
 * A NO-OP WHEN IT IS ALREADY SHOWING, and that is not an optimisation: on a
 * fresh userData the onboarding wizard is over the page, and a click on a tab
 * that is already active would wait thirty seconds to press something that
 * would change nothing.
 */
async function showSettingsGroup(win: Page, group: string): Promise<void> {
  const tab = win.locator('.fl-settings-tab', { hasText: group })
  await expect(tab).toBeVisible({ timeout: 15_000 })
  if ((await tab.getAttribute('aria-selected')) !== 'true') await tab.click()
}

test.describe('flow 11 — settings account status + updates feedback', () => {
  test('the account status line resolves, and Check-for-updates reports an outcome', async () => {
    const userDataDir = mkdtempSync(join(tmpdir(), 'flow-e2e-acct-status-'))
    let app: ElectronApplication | undefined
    const pageErrors: string[] = []
    try {
      await migrateDb(userDataDir)
      seedAccount(userDataDir)

      app = await launch(userDataDir)
      const win = await app.firstWindow()
      await win.waitForLoadState('domcontentloaded')
      win.on('pageerror', (e) => pageErrors.push(e.message))
      await dismissWizard(win)

      await openSettings(win)
      const overlay = win.locator(SETTINGS_OVERLAY)
      const row = overlay.locator('.fl-settings-account', { hasText: 'Personal' })
      await expect(row).toBeVisible()

      // --- The account row carries a live status line, not just the cached hint. ---
      const status = row.locator('.fl-settings-account-status')
      await expect(status).toBeVisible()
      // …and it must SETTLE: never left on the pending placeholder. The probe's
      // own ceiling is 15s (AUTH_PROBE_TIMEOUT_MS), so allow a little more.
      await expect(status).toHaveText(RESOLVED_STATUS, { timeout: 25_000 })
      await win.screenshot({ path: `${SCREENS}/settings-account-status-resolved.png` })

      // --- The Re-login affordance the status line points at (#948) exists. ---
      const relogin = row.locator('button', { hasText: 'Re-login' })
      await expect(relogin).toBeVisible()
      await expect(relogin).toHaveAttribute('title', /sign-in flow again/i)
      // Not clicked on purpose: it spawns the real interactive login.

      // --- Updates: the manual check reports an outcome and restores the button. ---
      // UNDER "App" NOW. Updates is a fact about Flow itself, not about the
      // runtime, so it sits with the theme rather than under the accounts.
      await showSettingsGroup(win, 'App')
      // Scoped to the Updates section: other groups (hidden tabs) carry their
      // own `.fl-settings-add-status` lines later in the DOM, so `.last()` on
      // the page found one of theirs.
      const updates = overlay.locator('.fl-settings-section:has(.fl-settings-heading:text-is("Updates"))')
      const checkBtn = updates.locator('button', { hasText: 'Check for updates' })
      await expect(checkBtn).toBeVisible()
      await checkBtn.click()
      const updateStatus = updates.locator('.fl-settings-add-status')
      await expect(updateStatus).toBeVisible()
      // Whatever the verdict (latest / available / error), the user gets a
      // sentence — and the button is usable again rather than stuck disabled.
      await expect(updateStatus).not.toHaveText('Checking…', { timeout: 20_000 })
      await expect(updateStatus).not.toHaveText('')
      await expect(checkBtn).not.toHaveAttribute('disabled', '', { timeout: 20_000 })

      // The overlay survived both async surfaces with no uncaught error.
      await expect(overlay).toBeVisible()
      expect(pageErrors, `unexpected pageerrors: ${pageErrors.join(' | ')}`).toEqual([])
    } finally {
      if (app) await app.close()
      rmSync(userDataDir, { recursive: true, force: true })
    }
  })
})
