import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { removeTempDir } from './fixtures/seed'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron, test, expect, type ElectronApplication, type Page } from '@playwright/test'

/**
 * UX-sweep regression probe — flow 11 (Settings), round 11.
 *
 * Un-probed seam: what the Settings overlay does LIVE when the user removes the
 * very account their active project is bound to. `AccountStore.removeAccount`
 * clears every dangling reference in one transaction (project override → NULL,
 * default cleared if it pointed here), and `accounts:changed` fires a re-render.
 * Prior settings sweeps drove set-default / remove-confirm (#216) and the
 * project binding (#763) in ISOLATION, but never the cascade where a removal
 * invalidates the open panel's own "This project" binding.
 *
 * Expected UX (fail-closed, no phantom state):
 *  - the removed account vanishes from BOTH the accounts list and the
 *    "This project" dropdown options (no stale/phantom "Work" option);
 *  - the project falls back to the remaining default account (override cleared),
 *    reflected live in the dropdown value without a manual reopen;
 *  - no uncaught error tears down the panel.
 *
 * Whatever deviates from that is the reported bug.
 */

const MAIN_ENTRY = join(__dirname, '..', '..', 'out', 'main', 'index.js')

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

/** Dismiss the first-run onboarding wizard (fresh userData → it opens over the shell). */
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
  const dir = mkdtempSync(join(tmpdir(), 'flow-e2e-rmbound-'))
  mkdirSync(join(dir, 'src'), { recursive: true })
  await win.evaluate(
    (root) =>
      (window as unknown as { flow: { project: { add(r: { path: string }): Promise<unknown> } } }).flow.project.add({ path: root }),
    dir,
  )
  return dir
}

// App Settings overlay (not the per-project Flow settings) — anchor on its heading.
const SETTINGS_OVERLAY =
  // A PAGE, and the Models group is where the accounts live.
  '.fl-settings-page'

async function activeForProject(
  win: Page,
  rootPath: string,
): Promise<{ status: string; accountId?: string }> {
  return win.evaluate(
    (root) =>
      (
        window as unknown as {
          flow: { accounts: { activeForProject(r: { rootPath: string }): Promise<{ status: string; accountId?: string }> } }
        }
      ).flow.accounts.activeForProject({ rootPath: root }),
    rootPath,
  )
}

test('removing the account a project is bound to falls back to default, live (no phantom option)', async () => {
  const userDataDir = mkdtempSync(join(tmpdir(), 'flow-e2e-rmbound-data-'))
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
    // addRoot activates the fresh project → the per-project Flow-settings overlay
    // auto-opens (onboarding). Dismiss it so it doesn't intercept clicks.
    await dismissFlowOverlay(win)

    // Open Settings and bind "This project" → Work (the reported precondition).
    await win.evaluate(() => document.dispatchEvent(new CustomEvent('flow:open-settings')))
    const settings = win.locator(SETTINGS_OVERLAY)
    await expect(settings).toBeVisible()
    const projectSection = settings.locator('.fl-settings-group:not([hidden]) .fl-settings-section', { hasText: 'This project' })
    const select = projectSection.locator('select')
    await expect(select).toBeVisible({ timeout: 10_000 })
    await select.selectOption('acc-work')
    await win.waitForTimeout(400)
    expect((await activeForProject(win, projectDir)).accountId).toBe('acc-work')

    // Remove the Work account (Remove → inline confirm Remove) — the same panel
    // is open, so its "This project" binding is now invalidated under it.
    const accountsSection = settings.locator('.fl-settings-section', { hasText: 'Model settings' })
    const workRow = accountsSection.locator('.fl-settings-account', { hasText: 'Work' })
    await expect(workRow).toHaveCount(1)
    await workRow.locator('button', { hasText: 'Remove' }).click()
    // Inline confirm swaps in — click its Remove.
    const confirm = workRow.locator('.fl-settings-confirm')
    await expect(confirm).toBeVisible()
    await confirm.locator('button', { hasText: 'Remove' }).click()

    // Live re-render (accounts:changed): Work vanishes from the account list.
    await expect(accountsSection.locator('.fl-settings-account', { hasText: 'Work' })).toHaveCount(
      0,
      { timeout: 10_000 },
    )

    // The "This project" dropdown must NOT keep a phantom "Work" option.
    const select2 = settings.locator('.fl-settings-group:not([hidden]) .fl-settings-section', { hasText: 'This project' }).locator('select')
    await expect(select2).toBeVisible({ timeout: 10_000 })
    await expect(select2.locator('option', { hasText: 'Work' })).toHaveCount(0)

    // Binding fell back to the remaining default account (override was cleared).
    const resolved = await activeForProject(win, projectDir)
    expect(resolved.status).toBe('ready')
    expect(resolved.accountId).toBe('acc-personal')
    // And the live dropdown reflects that fallback without a manual reopen.
    // #1108's fix (a1ef5132): an INHERITED default leaves "Use default account"
    // ('') selected — only an explicit pin selects a concrete account — while
    // the hint names the account actually in play.
    await expect(select2).toHaveValue('')
    await expect(
      settings.locator('.fl-settings-group:not([hidden]) .fl-settings-section', { hasText: 'This project' }).locator('.fl-settings-hint'),
    ).toContainText('Personal')

    await win.screenshot({ path: join(__dirname, '__screens', 'settings-remove-bound-account.png') })

    expect(errors, errors.join(', ')).toHaveLength(0)
  } finally {
    if (app) await app.close()
    if (projectDir) removeTempDir(projectDir)
    rmSync(userDataDir, { recursive: true, force: true })
  }
})
