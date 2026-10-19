import { _electron as electron, expect, type ElectronApplication, type Page } from '@playwright/test'
import { test } from '../fixtures/electron'
import { mkdtempSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

/**
 * UX-sweep regression probe — flow 11: Settings / accounts.
 *
 * Prior settings sweeps (rounds 4–7) drove the theme selector, model-routing
 * rows, flow-settings toggles, provisioning, integrations, and the *empty*
 * accounts state — but NEVER the populated account-row management surface:
 *  - the **Default** badge + **Set default** action on a non-default account,
 *  - the danger-gated inline **Remove** confirm (Cancel restores; Remove deletes).
 *
 * These are only reachable with real account rows, which a fresh launch lacks
 * (adding one opens a browser sign-in Playwright can't drive). So we pre-seed
 * two accounts into flow.db BEFORE launch (the runbook-blessed technique — the
 * on-disk config dirs never need to exist; removeConfigDir is rmSync force:true),
 * then drive the manager through the real IPC bridge and assert the UX.
 *
 * Pure coverage guard — no bug expected. Attaches a pageerror listener; any
 * uncaught error during the flow would be a strong bug signal.
 */

const MAIN_ENTRY = resolve(__dirname, '../../out/main/index.js')
// SETTINGS IS A PAGE, not an overlay: it moved into the editor area with its
// groups behind tabs. The name is kept so the walk below reads unchanged; what
// it names is the page.
const SETTINGS_OVERLAY = '.fl-settings-page'
const SCREENS = 'e2e/ux/__screens'

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

/** Seed two accounts — one default ("Personal"), one not ("Acme Co"). */
function seedTwoAccounts(userDataDir: string): void {
  const db = join(userDataDir, 'flow.db')
  execFileSync('sqlite3', [
    db,
    `INSERT INTO accounts (id, label, config_dir_path, identity_hint, created_at)
       VALUES ('acc-personal', 'Personal', '/tmp/flow-e2e-nocfg-p', 'me@personal.example', '2026-01-01T00:00:00Z');
     INSERT INTO accounts (id, label, config_dir_path, identity_hint, created_at)
       VALUES ('acc-acme', 'Acme Co', '/tmp/flow-e2e-nocfg-a', 'me@acme.example', '2026-01-02T00:00:00Z');
     INSERT INTO app_settings (key, value) VALUES ('default_account_id', 'acc-personal');`,
  ])
}

/** Open the app-level Settings overlay via the titlebar event. */
async function openSettings(win: Page): Promise<void> {
  await win.evaluate(() => document.dispatchEvent(new CustomEvent('flow:open-settings')))
  await expect(win.locator(SETTINGS_OVERLAY)).toBeVisible()
}

/** A settings account row, located by its visible label. */
function accountRow(win: Page, label: string) {
  return win.locator('.fl-settings-account', { hasText: label })
}

test.describe('flow 11 — settings accounts management', () => {
  test('set-default moves the badge; Remove confirm cancels then deletes', async () => {
    const userDataDir = mkdtempSync(join(tmpdir(), 'flow-e2e-acct-manage-'))
    let app: ElectronApplication | undefined
    const pageErrors: string[] = []
    try {
      await migrateDb(userDataDir)
      seedTwoAccounts(userDataDir)

      app = await launch(userDataDir)
      const win = await app.firstWindow()
      await win.waitForLoadState('domcontentloaded')
      win.on('pageerror', (e) => pageErrors.push(e.message))
      // Dismiss first-run onboarding if it appears (no project seeded here).
      const wizard = win.locator('.fl-settings-overlay:not([hidden]):has(.fl-wizard-body)')
      if (await wizard.count()) {
        const skip = wizard.locator('.fl-wizard-btn', { hasText: 'Skip for now' })
        if (await skip.count()) await skip.first().click()
        else await win.keyboard.press('Escape')
        await expect(wizard).toHaveCount(0)
      }

      await openSettings(win)
      const overlay = win.locator(SETTINGS_OVERLAY)

      // Both seeded accounts render.
      await expect(accountRow(win, 'Personal')).toBeVisible()
      await expect(accountRow(win, 'Acme Co')).toBeVisible()

      // The default badge sits on Personal; Acme Co has a "Set default" action.
      await expect(accountRow(win, 'Personal').locator('.fl-settings-badge')).toHaveText('Default')
      await expect(accountRow(win, 'Acme Co').locator('.fl-settings-badge')).toHaveCount(0)
      const acmeSetDefault = accountRow(win, 'Acme Co').locator('button', {
        hasText: 'Set default',
      })
      await expect(acmeSetDefault).toBeVisible()

      await win.screenshot({ path: `${SCREENS}/settings-accounts-seeded.png` })

      // --- Set default → badge moves to Acme Co (accounts:changed re-renders). ---
      await acmeSetDefault.click()
      await expect(accountRow(win, 'Acme Co').locator('.fl-settings-badge')).toHaveText('Default')
      await expect(accountRow(win, 'Personal').locator('.fl-settings-badge')).toHaveCount(0)
      // Now Personal (no longer default) exposes its own "Set default".
      await expect(
        accountRow(win, 'Personal').locator('button', { hasText: 'Set default' }),
      ).toBeVisible()
      // A default account must not offer to set itself default again.
      await expect(
        accountRow(win, 'Acme Co').locator('button', { hasText: 'Set default' }),
      ).toHaveCount(0)

      // --- Remove confirm: click Remove → inline "Remove Personal?" confirm. ---
      const personalRow = accountRow(win, 'Personal')
      await personalRow.locator('button', { hasText: 'Remove' }).first().click()
      const confirm = personalRow.locator('.fl-settings-confirm')
      await expect(confirm).toBeVisible()
      await expect(confirm).toContainText('Remove Personal?')
      await expect(confirm.locator('button', { hasText: 'Cancel' })).toBeVisible()
      await win.screenshot({ path: `${SCREENS}/settings-accounts-remove-confirm.png` })

      // Cancel restores the plain Remove button (no deletion).
      await confirm.locator('button', { hasText: 'Cancel' }).click()
      await expect(personalRow.locator('.fl-settings-confirm')).toHaveCount(0)
      await expect(personalRow.locator('button', { hasText: 'Remove' })).toBeVisible()
      await expect(accountRow(win, 'Personal')).toBeVisible() // still there

      // Now actually remove: Remove → inner Remove → row vanishes, Acme Co stays.
      await personalRow.locator('button', { hasText: 'Remove' }).first().click()
      const confirm2 = personalRow.locator('.fl-settings-confirm')
      await expect(confirm2).toBeVisible()
      await confirm2.locator('button', { hasText: 'Remove' }).click()
      await expect(accountRow(win, 'Personal')).toHaveCount(0)
      await expect(accountRow(win, 'Acme Co')).toBeVisible()

      // The overlay stayed open throughout and no uncaught error fired.
      await expect(overlay).toBeVisible()
      expect(pageErrors, `unexpected pageerrors: ${pageErrors.join(' | ')}`).toEqual([])
    } finally {
      if (app) await app.close()
      rmSync(userDataDir, { recursive: true, force: true })
    }
  })
})
