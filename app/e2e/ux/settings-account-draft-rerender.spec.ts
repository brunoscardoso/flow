import { _electron as electron, expect, type ElectronApplication, type Page } from '@playwright/test'
import { test } from '../fixtures/electron'
import { mkdtempSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

/**
 * UX-sweep regression probe — flow 11 (round 15): Settings → Claude accounts,
 * the in-progress "Add account" draft vs the `accounts:changed` re-render.
 *
 * `SettingsView` answers every `accounts.onChanged` broadcast with a whole-body
 * `#body.replaceChildren(...)` (settings-view.ts #render). That rebuilds the
 * Add-account row from scratch, so any half-typed account name — and the
 * add-status line — is silently destroyed. A real user hits this mouse-only:
 * type the new account's name, then tidy the existing rows (Set default /
 * Remove) before completing the sign-in.
 *
 * Account rows only exist with real accounts, which a fresh launch lacks (adding
 * one opens a browser sign-in Playwright can't drive), so two accounts are
 * pre-seeded into flow.db before launch — the runbook-blessed technique; the
 * on-disk config dirs never need to exist.
 *
 *  - live guard  : the Add row stays usable after a sibling account action
 *                  (input present + enabled, blank-Add still gives feedback),
 *                  the badge moves, and nothing throws.
 *  - test.fixme  : the typed draft survives that action — FAILS today (#1000).
 */

const MAIN_ENTRY = resolve(__dirname, '../../out/main/index.js')
// SETTINGS IS A PAGE, not an overlay: it moved into the editor area with its
// groups behind tabs. The name is kept so the walk below reads unchanged; what
// it names is the page.
const SETTINGS_OVERLAY = '.fl-settings-page'
const SCREENS = 'e2e/ux/__screens'
const DRAFT = 'Acme Backup'

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

async function dismissWizard(win: Page): Promise<void> {
  const wizard = win.locator('.fl-settings-overlay:not([hidden]):has(.fl-wizard-body)')
  if (await wizard.count()) {
    const skip = wizard.locator('.fl-wizard-btn', { hasText: 'Skip for now' })
    if (await skip.count()) await skip.first().click()
    else await win.keyboard.press('Escape')
    await expect(wizard).toHaveCount(0)
  }
}

async function openSettings(win: Page): Promise<void> {
  await win.evaluate(() => document.dispatchEvent(new CustomEvent('flow:open-settings')))
  await expect(win.locator(SETTINGS_OVERLAY)).toBeVisible()
}

function accountRow(win: Page, label: string) {
  return win.locator('.fl-settings-account', { hasText: label })
}

/** Boot with two seeded accounts, dismiss onboarding, open Settings. */
async function bootWithAccounts(
  userDataDir: string,
  pageErrors: string[],
): Promise<{ app: ElectronApplication; win: Page }> {
  await migrateDb(userDataDir)
  seedTwoAccounts(userDataDir)
  const app = await launch(userDataDir)
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')
  win.on('pageerror', (e) => pageErrors.push(e.message))
  await dismissWizard(win)
  await openSettings(win)
  return { app, win }
}

test.describe('flow 11 — settings add-account draft vs re-render', () => {
  test('the Add-account row stays usable after a sibling account action', async () => {
    const userDataDir = mkdtempSync(join(tmpdir(), 'flow-e2e-acct-draft-'))
    let app: ElectronApplication | undefined
    const pageErrors: string[] = []
    try {
      const booted = await bootWithAccounts(userDataDir, pageErrors)
      app = booted.app
      const win = booted.win
      const overlay = win.locator(SETTINGS_OVERLAY)

      const addInput = overlay.locator('.fl-settings-group:not([hidden]) .fl-settings-input')
      await expect(addInput).toBeVisible()
      await addInput.click()
      await addInput.pressSequentially(DRAFT)
      await expect(addInput).toHaveValue(DRAFT)
      await win.screenshot({ path: `${SCREENS}/settings-draft-typed.png` })

      // Promote the non-default account — this broadcasts accounts:changed and
      // re-renders the whole overlay body.
      await accountRow(win, 'Acme Co').locator('button', { hasText: 'Set default' }).click()
      await expect(accountRow(win, 'Acme Co').locator('.fl-settings-badge')).toHaveText('Default')
      await win.screenshot({ path: `${SCREENS}/settings-draft-after-setdefault.png` })

      // Whatever happened to the draft, the Add row must still be a working
      // control the user can finish adding an account with.
      const rebuilt = overlay.locator('.fl-settings-group:not([hidden]) .fl-settings-input')
      await expect(rebuilt).toHaveCount(1)
      await expect(rebuilt).toBeEnabled()
      await expect(overlay.locator('button', { hasText: 'Add account' })).toBeEnabled()

      // And the empty-field feedback added for #834 still fires on the rebuilt row.
      //
      // CLEARED FIRST, because the draft SURVIVES the rebuild now — that is the
      // fix this file was written to demand, and it means the field is not
      // empty when we get here. This assertion was written against the broken
      // behaviour it describes ("Today the rebuilt input comes back empty") and
      // has been red ever since the carry landed; it asks its own question now.
      await rebuilt.fill('')
      await overlay.locator('button', { hasText: 'Add account' }).click()
      await expect(
        overlay.locator('.fl-settings-add-status', { hasText: 'Enter an account name first.' }),
      ).toBeVisible()

      await expect(overlay).toBeVisible()
      expect(pageErrors, `unexpected pageerrors: ${pageErrors.join(' | ')}`).toEqual([])
    } finally {
      if (app) await app.close()
      rmSync(userDataDir, { recursive: true, force: true })
    }
  })

  // Tripwire for #1000 — flips green when the re-render stops destroying the
  // in-progress Add-account draft. Unskip to reproduce the bug.
  test.fixme('the typed account name survives a sibling account action (#1000)', async () => {
    const userDataDir = mkdtempSync(join(tmpdir(), 'flow-e2e-acct-draft-fixme-'))
    let app: ElectronApplication | undefined
    const pageErrors: string[] = []
    try {
      const booted = await bootWithAccounts(userDataDir, pageErrors)
      app = booted.app
      const win = booted.win
      const overlay = win.locator(SETTINGS_OVERLAY)

      const addInput = overlay.locator('.fl-settings-group:not([hidden]) .fl-settings-input')
      await addInput.click()
      await addInput.pressSequentially(DRAFT)
      await expect(addInput).toHaveValue(DRAFT)

      await accountRow(win, 'Acme Co').locator('button', { hasText: 'Set default' }).click()
      await expect(accountRow(win, 'Acme Co').locator('.fl-settings-badge')).toHaveText('Default')

      // Today the rebuilt input comes back empty — the user's typing is gone.
      await expect(overlay.locator('.fl-settings-group:not([hidden]) .fl-settings-input')).toHaveValue(DRAFT)
      expect(pageErrors, `unexpected pageerrors: ${pageErrors.join(' | ')}`).toEqual([])
    } finally {
      if (app) await app.close()
      rmSync(userDataDir, { recursive: true, force: true })
    }
  })
})
