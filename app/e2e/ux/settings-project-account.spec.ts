import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { removeTempDir } from './fixtures/seed'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron, test, expect, type ElectronApplication, type Page } from '@playwright/test'

/**
 * #763 — "I am not able to change the claude account in the project settings."
 *
 * The per-project override machinery exists end-to-end (workspace_state.account_id,
 * accounts:assignProject, the Settings "This project" dropdown). This probe drives
 * the REAL flow — two seeded accounts, an open project, Settings → change the
 * "This project" select — and asserts the binding actually changes and survives a
 * Settings reopen. Whatever fails here is the reported bug.
 */

const MAIN_ENTRY = join(__dirname, '..', '..', 'out', 'main', 'index.js')

function launch(userDataDir: string): Promise<ElectronApplication> {
  return electron.launch({
    args: [MAIN_ENTRY, `--user-data-dir=${userDataDir}`],
    env: { ...process.env, ELECTRON_RENDERER_URL: '', NODE_ENV: 'production', FLOW_E2E: '1' },
  })
}

async function migrateDb(userDataDir: string): Promise<void> {
  const app = await launch(userDataDir)
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')
  await app.close()
}

/** Two accounts, first is the app default — the "I have a work + personal" case. */
function seedTwoAccounts(userDataDir: string): void {
  const db = join(userDataDir, 'flow.db')
  execFileSync('sqlite3', [
    db,
    `INSERT INTO accounts (id, label, config_dir_path, identity_hint, created_at)
       VALUES ('acc-personal', 'Personal', '/tmp/flow-e2e-acc-personal', 'me@example.com', '2026-01-01T00:00:00Z');
     INSERT INTO accounts (id, label, config_dir_path, identity_hint, created_at)
       VALUES ('acc-work', 'Work', '/tmp/flow-e2e-acc-work', 'work@example.com', '2026-01-01T00:00:00Z');
     INSERT INTO app_settings (key, value) VALUES ('default_account_id', 'acc-personal');`,
  ])
}

async function seedProject(win: Page): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'flow-e2e-projacct-'))
  mkdirSync(join(dir, 'src'), { recursive: true })
  await win.evaluate(
    (root) =>
      (window as unknown as { flow: { project: { add(r: { path: string }): Promise<unknown> } } }).flow.project.add({ path: root }),
    dir,
  )
  return dir
}

// Two .fl-settings-overlay elements exist (app Settings + per-project Flow
// settings) — anchor on the accounts heading to hit the app one.
// A PAGE, and its Models group — where the runtime, the accounts and this
// project's binding all live now.
const SETTINGS_OVERLAY = '.fl-settings-page'

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

test('the "This project" account dropdown exists, changes the binding, and persists (#763)', async () => {
  const userDataDir = mkdtempSync(join(tmpdir(), 'flow-e2e-projacct-data-'))
  let app: ElectronApplication | null = null
  let projectDir: string | null = null
  const errors: string[] = []
  try {
    await migrateDb(userDataDir)
    seedTwoAccounts(userDataDir)
    app = await launch(userDataDir)
    const win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    win.on('pageerror', (e) => errors.push(e.message))

    projectDir = await seedProject(win)

    // Open Settings.
    await win.evaluate(() => document.dispatchEvent(new CustomEvent('flow:open-settings')))
    await expect(win.locator(SETTINGS_OVERLAY)).toBeVisible({ timeout: 15_000 })
    await showSettingsGroup(win, 'Models')
    const settings = win.locator(SETTINGS_OVERLAY)
    await expect(settings).toBeVisible()

    // The per-project section + its dropdown must exist with an open project.
    const projectHeading = settings.locator('.fl-settings-heading', { hasText: 'This project' })
    await expect(projectHeading).toBeVisible({ timeout: 10_000 })
    const select = settings.locator('.fl-settings-group:not([hidden]) .fl-settings-section', { hasText: 'This project' }).locator('select')
    await expect(select).toBeVisible()

    // Both seeded accounts are offered.
    await expect(select.locator('option', { hasText: 'Personal' })).toHaveCount(1)
    await expect(select.locator('option', { hasText: 'Work' })).toHaveCount(1)

    // Change to Work — the reported action.
    await select.selectOption('acc-work')
    await win.waitForTimeout(400)

    // The binding actually changed (authoritative main-side resolution).
    const resolved = await win.evaluate(
      (root) =>
        (window as unknown as { flow: { accounts: { activeForProject(r: { rootPath: string }): Promise<{ status: string; accountId?: string }> } } })
          .flow.accounts.activeForProject({ rootPath: root }),
      projectDir,
    )
    expect(resolved.status).toBe('ready')
    expect(resolved.accountId).toBe('acc-work')

    // Survives a Settings close + reopen (re-render reads it back).
    await win.keyboard.press('Escape')
    await win.evaluate(() => document.dispatchEvent(new CustomEvent('flow:open-settings')))
    await expect(win.locator(SETTINGS_OVERLAY)).toBeVisible({ timeout: 15_000 })
    await showSettingsGroup(win, 'Models')
    const select2 = win
      .locator(SETTINGS_OVERLAY)
      .locator('.fl-settings-group:not([hidden]) .fl-settings-section', { hasText: 'This project' })
      .locator('select')
    await expect(select2).toBeVisible({ timeout: 10_000 })
    await expect(select2).toHaveValue('acc-work')

    expect(errors, errors.join(', ')).toHaveLength(0)
  } finally {
    if (app) await app.close()
    if (projectDir) removeTempDir(projectDir)
    rmSync(userDataDir, { recursive: true, force: true })
  }
})

test('the per-project FLOW settings overlay offers the account binding too (#763)', async () => {
  const userDataDir = mkdtempSync(join(tmpdir(), 'flow-e2e-projacct2-data-'))
  let app: ElectronApplication | null = null
  let projectDir: string | null = null
  const errors: string[] = []
  try {
    await migrateDb(userDataDir)
    seedTwoAccounts(userDataDir)
    app = await launch(userDataDir)
    const win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    win.on('pageerror', (e) => errors.push(e.message))

    projectDir = await seedProject(win)

    // Open the per-project Flow settings — the surface the user calls
    // "the project settings", which had NO account control (#763).
    await win.evaluate(
      (root) =>
        document.dispatchEvent(
          new CustomEvent('flow:open-flow-settings', { detail: { rootPath: root } }),
        ),
      projectDir,
    )
    const flowSettings = win.locator(
      '.fl-settings-overlay:not([hidden]):has(.fl-settings-heading:has-text("Claude account"))',
    )
    await expect(flowSettings).toBeVisible({ timeout: 10_000 })

    const select = flowSettings
      .locator('.fl-settings-section', { hasText: 'Claude account' })
      .locator('select')
    await expect(select).toBeVisible({ timeout: 10_000 })
    await select.selectOption('acc-work')
    await win.waitForTimeout(400)

    const resolved = await win.evaluate(
      (root) =>
        (window as unknown as { flow: { accounts: { activeForProject(r: { rootPath: string }): Promise<{ status: string; accountId?: string }> } } })
          .flow.accounts.activeForProject({ rootPath: root }),
      projectDir,
    )
    expect(resolved.status).toBe('ready')
    expect(resolved.accountId).toBe('acc-work')

    expect(errors, errors.join(', ')).toHaveLength(0)
  } finally {
    if (app) await app.close()
    if (projectDir) removeTempDir(projectDir)
    rmSync(userDataDir, { recursive: true, force: true })
  }
})
