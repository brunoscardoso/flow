import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
  type Page,
} from '@playwright/test'
import { mkdtempSync, rmSync } from 'node:fs'
import { removeTempDir } from '../ux/fixtures/seed'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { trustSeededAccount } from '../ux/fixtures/settings'

/**
 * Regression guard for **PR #551** — "fix(onboarding): let the user change the
 * project in first-run setup (#504)".
 *
 * Before #551 the wizard's Project step, once a folder was picked, showed only a
 * "✓ <name>" status with **no way to change it** — the first-run choice was a
 * trap. #551 adds a **"Change project…"** button to the opened state (disabled
 * only while provisioning is in flight).
 *
 * This spec reaches the Project step legitimately — a real account row seeded into
 * flow.db (Connect auto-detects it) plus a real project root added via the
 * `project:add` IPC (Project auto-detects it) — then asserts the observable
 * fix: the Project step renders an ENABLED "Change project…" affordance. On the
 * pre-#551 code this button does not exist. Asserts observable UX only + zero
 * uncaught pageerrors.
 */

const MAIN_ENTRY = resolve(__dirname, '../../out/main/index.js')
const WIZARD = '.fl-settings-overlay:not([hidden]):has(.fl-wizard-body)'
// SETTINGS IS A PAGE, not an overlay: it moved into the editor area with its
// groups behind tabs. The name is kept so the walk below reads unchanged; what
// it names is the page.
const SETTINGS_OVERLAY = '.fl-settings-page'
const ANY_OVERLAY = '.fl-settings-overlay:not([hidden])'

function launch(userDataDir: string): Promise<ElectronApplication> {
  return electron.launch({
    args: [MAIN_ENTRY, `--user-data-dir=${userDataDir}`],
    env: { ...process.env, ELECTRON_RENDERER_URL: '', NODE_ENV: 'production', FLOW_E2E: '1' },
  })
}

/** Boot once so the app creates + migrates flow.db, then close. */
async function migrateDb(userDataDir: string): Promise<void> {
  const app = await launch(userDataDir)
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')
  await app.close()
}

/** Seed a real account row + default-account setting straight into flow.db. */
function seedAccount(userDataDir: string): void {
  const db = join(userDataDir, 'flow.db')
  execFileSync('sqlite3', [
    db,
    `INSERT INTO accounts (id, label, config_dir_path, identity_hint, created_at)
       VALUES ('acc-e2e', 'QA Seed Account', '/tmp/flow-e2e-noconfig', 'qa@example.com', '2026-01-01T00:00:00Z');
     INSERT INTO app_settings (key, value) VALUES ('default_account_id', 'acc-e2e');`,
  ])
}

/** Add a throwaway git repo as a project root via the real IPC bridge. */
async function seedProject(win: Page): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'flow-pr551-'))
  execFileSync('git', ['init', '-q'], { cwd: dir })
  await win.evaluate(async (p) => {
    await (
      window as unknown as {
        flow: { project: { add(r: { path: string }): Promise<unknown> } }
      }
    ).flow.project.add({ path: p })
  }, dir)
  return dir
}

/** Dismiss the per-project flow-settings overlay if it auto-opened (Escape). */
async function dismissFlowOverlay(win: Page): Promise<void> {
  const overlay = win.locator(ANY_OVERLAY)
  try {
    await overlay.waitFor({ state: 'visible', timeout: 2000 })
  } catch {
    return
  }
  await win.keyboard.press('Escape')
  await overlay.waitFor({ state: 'hidden', timeout: 3000 }).catch(() => undefined)
}

/** Re-open the wizard the way a returning user does: Settings → Getting Started. */
async function reopenWizard(win: Page): Promise<void> {
  await win.evaluate(() => document.dispatchEvent(new CustomEvent('flow:open-settings')))
  const settings = win.locator(SETTINGS_OVERLAY)
  await expect(settings).toBeVisible()
  // Settings is a tabbed page; "Getting Started…" is a thing about Flow itself,
  // so it sits in the App group with the theme and the updater.
  await win.locator('.fl-settings-tab', { hasText: 'App' }).click()
  await settings.locator('button', { hasText: 'Getting Started' }).click()
  await expect(win.locator(WIZARD)).toBeVisible()
}

async function nextDisabled(win: Page): Promise<boolean> {
  return win
    .locator(`${WIZARD} .fl-wizard-btn`, { hasText: 'Next' })
    .evaluate((b) => (b as HTMLButtonElement).disabled)
    .catch(() => true)
}

test('Project step offers an enabled "Change project…" affordance once a project is open (#504)', async () => {
  const userDataDir = mkdtempSync(join(tmpdir(), 'flow-e2e-pr551-'))
  let projectDir: string | null = null
  let app: ElectronApplication | null = null
  const errors: string[] = []
  try {
    await migrateDb(userDataDir)
    seedAccount(userDataDir)

    app = await launch(userDataDir)
    const win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    win.on('pageerror', (e) => errors.push(e.message))
    // #1319: Connect now asks whether the seeded account (an empty config dir)
    // is really logged in, and truthfully hears "no". This spec is about the
    // Project step AFTER Connect, so the probe answers "logged in".
    await trustSeededAccount(app)

    // A seeded account means the wizard should not auto-open; dismiss it if it did.
    const auto = win.locator(WIZARD)
    if (await auto.count()) {
      await auto.locator('.fl-wizard-btn', { hasText: 'Skip for now' }).click()
      await expect(auto).toHaveCount(0)
    }
    projectDir = await seedProject(win)
    // Adding the first root auto-opens the per-project flow-settings overlay for a
    // project without .flowconfig — dismiss it so it doesn't sit over the wizard.
    await dismissFlowOverlay(win)

    // Walk Welcome → Connect → Project.
    await reopenWizard(win)
    const wizard = win.locator(WIZARD)
    await expect(wizard.locator('.fl-settings-header')).toContainText('Welcome to Flow')
    // The runtime step now sits between Welcome and Connect: which agent
    // runs is chosen before whose account gets connected.
    await wizard.locator('.fl-wizard-btn', { hasText: 'Next' }).click()
    await expect(wizard.locator('.fl-settings-header')).toContainText('Choose your agent')
    await wizard.locator('.fl-wizard-btn', { hasText: 'Next' }).click()

    await expect(wizard.locator('.fl-settings-header')).toContainText('Connect a Claude account')
    await expect.poll(() => nextDisabled(win)).toBe(false)
    await wizard.locator('.fl-wizard-btn', { hasText: 'Next' }).click()

    await expect(wizard.locator('.fl-settings-header')).toContainText('Open a project')

    // The #504 fix: the opened state offers a "Change project…" button so the
    // first-run choice is never a trap. It is enabled (provisioning has settled).
    const change = wizard.locator('.fl-wizard-btn', { hasText: 'Change project' })
    await expect(change).toBeVisible()
    await expect(change).toBeEnabled()

    // The confirmed-project status still shows too (the button augments, not replaces).
    await expect(wizard.locator('.fl-wizard-body')).toContainText('✓')

    expect(errors, errors.join(', ')).toHaveLength(0)
  } finally {
    if (app) await app.close()
    if (projectDir) removeTempDir(projectDir)
    rmSync(userDataDir, { recursive: true, force: true })
  }
})
