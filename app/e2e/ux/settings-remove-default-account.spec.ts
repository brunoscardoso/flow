import { _electron as electron, test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

/**
 * UX-sweep regression probe — flow 11 (Settings / accounts / flow-settings
 * overlays), round 22.
 *
 * Flow 11 owns 21 committed specs. Exactly one drives account REMOVAL
 * (`settings-remove-bound-account.spec.ts`, round 11): it removes the
 * NON-default account a project was explicitly pinned to and asserts the
 * project falls back to the remaining default. The mirror case — removing the
 * **default** account while another account remains — has never been driven,
 * and it is the one that changes which identity every inheriting project runs
 * under.
 *
 * `AccountStore.removeAccount` used to delete the `default_account_id` row and
 * never promote a survivor, landing on "accounts configured, no default"
 * (#1349). It now promotes the oldest surviving account, as `accounts:add`
 * promotes the first one on the way in.
 *
 * Ground truth is `flow.db` read with sqlite3 plus the `accounts:activeForProject`
 * resolution the agent path itself uses — never the panel's claims about itself.
 * Accounts are pre-seeded into flow.db before launch (adding one for real
 * spawns an interactive sign-in Playwright cannot drive).
 *
 * GUARDS (a regression here is a real bug):
 *   1. Removing the default account removes it everywhere at once — gone from
 *      the account list and from the "This project" dropdown (no phantom
 *      option) — and the survivor becomes `app_settings.default_account_id`,
 *      live, with no reopen and no uncaught error.
 *   2. The surviving account stays listed and is badged Default.
 *   3. (#1349, formerly a fixme tripwire) the project that INHERITED the
 *      default keeps a managed account rather than silently dropping to the
 *      ambient CLI login.
 */

const MAIN_ENTRY = resolve(__dirname, '../../out/main/index.js')
const SETTINGS_OVERLAY =
  // A PAGE, and the Models group is where the accounts live.
  '.fl-settings-page'
const SCREENS = join(__dirname, '__screens')

function launch(userDataDir: string): Promise<ElectronApplication> {
  return electron.launch({
    args: [MAIN_ENTRY, `--user-data-dir=${userDataDir}`],
    env: { ...process.env, ELECTRON_RENDERER_URL: '', NODE_ENV: 'production', FLOW_E2E: '1' },
  })
}

/** Boot once so migrations create the schema, then close. */
async function migrateDb(userDataDir: string): Promise<void> {
  const app = await launch(userDataDir)
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')
  await app.close()
}

/** Personal (app default) + Work — the "work + personal" case. */
function seedTwoAccounts(userDataDir: string): void {
  execFileSync('sqlite3', [
    join(userDataDir, 'flow.db'),
    `INSERT INTO accounts (id, label, config_dir_path, identity_hint, created_at)
       VALUES ('acc-personal', 'Personal', '/tmp/flow-e2e-rmdef-p', 'me@personal.example', '2026-01-01T00:00:00Z');
     INSERT INTO accounts (id, label, config_dir_path, identity_hint, created_at)
       VALUES ('acc-work', 'Work', '/tmp/flow-e2e-rmdef-w', 'me@work.example', '2026-01-02T00:00:00Z');
     INSERT INTO app_settings (key, value) VALUES ('default_account_id', 'acc-personal');`,
  ])
}

/** The stored app default — ground truth, independent of the UI. */
function storedDefault(userDataDir: string): string {
  return execFileSync('sqlite3', [
    join(userDataDir, 'flow.db'),
    `SELECT COALESCE(value, "") FROM app_settings WHERE key = 'default_account_id';`,
  ])
    .toString()
    .trim()
}

async function dismissOnboarding(win: Page): Promise<void> {
  const wizard = win.locator('.fl-settings-overlay:not([hidden]):has(.fl-wizard-body)')
  if ((await wizard.count()) === 0) return
  const skip = wizard.locator('.fl-wizard-btn', { hasText: 'Skip for now' })
  if (await skip.count()) await skip.first().click()
  else await win.keyboard.press('Escape')
  await expect(wizard).toHaveCount(0)
}

/** Close the auto-opened per-project Flow-settings overlay, if present. */
async function dismissFlowOverlay(win: Page): Promise<void> {
  const overlay = win.locator('.fl-settings-overlay:not([hidden])')
  try {
    await overlay.waitFor({ state: 'visible', timeout: 1500 })
  } catch {
    return
  }
  await win.keyboard.press('Escape')
  await overlay.waitFor({ state: 'hidden', timeout: 2000 }).catch(() => undefined)
}

async function seedProject(win: Page): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'flow-e2e-rmdef-'))
  mkdirSync(join(dir, 'src'), { recursive: true })
  await win.evaluate(
    (root) =>
      (
        window as unknown as {
          flow: { project: { add(r: { path: string }): Promise<unknown> } }
        }
      ).flow.project.add({ path: root }),
    dir,
  )
  return dir
}

/**
 * Remove a seeded dir, retrying on ENOTEMPTY: the IDE's fire-and-forget
 * auto-provisioner can still be writing its scaffold into a just-attached root
 * when teardown runs, so a single rmSync races the concurrent file creation
 * (same retry `ux/fixtures/seed.ts` uses).
 */
function rmRetry(dir: string): void {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      rmSync(dir, { recursive: true, force: true })
      return
    } catch (error) {
      if ((error as { code?: string }).code !== 'ENOTEMPTY') throw error
      execFileSync('sleep', ['0.3'])
    }
  }
}

interface Resolution {
  status: string
  accountId?: string
  label?: string
  source?: string
}

/** The resolution the agent session path itself uses for a project root. */
async function activeForProject(win: Page, rootPath: string): Promise<Resolution> {
  return win.evaluate(
    (root) =>
      (
        window as unknown as {
          flow: { accounts: { activeForProject(r: { rootPath: string }): Promise<Resolution> } }
        }
      ).flow.accounts.activeForProject({ rootPath: root }),
    rootPath,
  ) as Promise<Resolution>
}

/** Drive to the state under test: two accounts, Personal is the app default and
 *  the project inherits it; then remove Personal through the real UI. */
async function removeTheDefaultAccount(
  win: Page,
  projectDir: string,
): Promise<{ settings: ReturnType<Page['locator']>; accountsSection: ReturnType<Page['locator']> }> {
  // Precondition: the project runs under the app default, by inheritance.
  const before = await activeForProject(win, projectDir)
  expect(before.status).toBe('ready')
  expect(before.accountId).toBe('acc-personal')

  await win.evaluate(() => document.dispatchEvent(new CustomEvent('flow:open-settings')))
  const settings = win.locator(SETTINGS_OVERLAY)
  await expect(settings).toBeVisible()
  const accountsSection = settings.locator('.fl-settings-section', { hasText: 'Model settings' })
  await expect(
    settings.locator('.fl-settings-group:not([hidden]) .fl-settings-section', { hasText: 'This project' }).locator('select'),
  ).toBeVisible({ timeout: 10_000 })

  const personalRow = accountsSection.locator('.fl-settings-account', { hasText: 'Personal' })
  await expect(personalRow).toHaveCount(1)
  // #216: Remove is a two-step inline confirm, never a single click.
  await personalRow.locator('button', { hasText: 'Remove' }).click()
  const confirm = personalRow.locator('.fl-settings-confirm')
  await expect(confirm).toBeVisible()
  await confirm.locator('button', { hasText: 'Remove' }).click()

  // accounts:changed re-renders the overlay body — Personal is gone from it.
  await expect(accountsSection.locator('.fl-settings-account', { hasText: 'Personal' })).toHaveCount(
    0,
    { timeout: 10_000 },
  )
  return { settings, accountsSection }
}

test('removing the default account clears it everywhere, live, and leaves the survivor recoverable', async () => {
  const userDataDir = mkdtempSync(join(tmpdir(), 'flow-e2e-rmdef-data-'))
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

    await dismissOnboarding(win)
    projectDir = await seedProject(win)
    await dismissFlowOverlay(win)

    const { settings, accountsSection } = await removeTheDefaultAccount(win, projectDir)

    // Guard 1 — removed everywhere at once, no phantoms, no stale default row.
    await expect(accountsSection.locator('.fl-settings-account')).toHaveCount(1)
    const projectSelect = settings
      .locator('.fl-settings-group:not([hidden]) .fl-settings-section', { hasText: 'This project' })
      .locator('select')
    await expect(projectSelect).toBeVisible({ timeout: 10_000 })
    await expect(projectSelect.locator('option', { hasText: 'Personal' })).toHaveCount(0)
    // #1349 (fixed in AccountStore.removeAccount): removing the default promotes
    // the oldest surviving account instead of leaving "no default" behind.
    await expect.poll(() => storedDefault(userDataDir), { timeout: 10_000 }).toBe('acc-work')

    // Guard 2 — the survivor is still listed, and the panel says it is now the
    // default (live, no reopen) rather than offering to make it one.
    const workRow = accountsSection.locator('.fl-settings-account', { hasText: 'Work' })
    await expect(workRow).toHaveCount(1)
    await expect(workRow.locator('.fl-settings-badge')).toHaveText('Default')
    await expect(workRow.locator('button', { hasText: 'Set default' })).toHaveCount(0)

    await win.screenshot({ path: join(SCREENS, 'settings-remove-default-account.png') })
    expect(errors, errors.join(', ')).toHaveLength(0)
  } finally {
    if (app) await app.close()
    if (projectDir) rmRetry(projectDir)
    rmRetry(userDataDir)
  }
})

// #1349 — FIXED: AccountStore.removeAccount now promotes the oldest survivor,
// so the inheriting project keeps a managed account. Was a test.fixme tripwire.
test(
  'removing the default account does not silently orphan the remaining account',
  async () => {
    const userDataDir = mkdtempSync(join(tmpdir(), 'flow-e2e-rmdef-tw-'))
    let app: ElectronApplication | null = null
    let projectDir: string | null = null
    try {
      await migrateDb(userDataDir)
      seedTwoAccounts(userDataDir)
      app = await launch(userDataDir)
      const win = await app.firstWindow()
      await win.waitForLoadState('domcontentloaded')

      await dismissOnboarding(win)
      projectDir = await seedProject(win)
      await dismissFlowOverlay(win)

      const { settings, accountsSection } = await removeTheDefaultAccount(win, projectDir)

      const resolved = await activeForProject(win, projectDir)
      const panelText = `${await accountsSection.innerText()}\n${await settings
        .locator('.fl-settings-group:not([hidden]) .fl-settings-section', { hasText: 'This project' })
        .innerText()}`
      // Either the app kept a managed account in play (a survivor was promoted),
      // or it said out loud that there is no default account any more. Silence
      // plus a fallback to the ambient CLI login is the defect.
      const keptAManagedAccount = resolved.status === 'ready'
      const saidThereIsNoDefault = /no default account/i.test(panelText)
      expect(
        keptAManagedAccount || saidThereIsNoDefault,
        `resolution=${JSON.stringify(resolved)} panel=${JSON.stringify(panelText)}`,
      ).toBe(true)
    } finally {
      if (app) await app.close()
      if (projectDir) rmRetry(projectDir)
      rmRetry(userDataDir)
    }
  },
)
