import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { trustSeededAccount, advanceWizardTo } from './fixtures/settings'
import { mkdtempSync, rmSync } from 'node:fs'
import { removeTempDir } from './fixtures/seed'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

/**
 * UX sweep — flow 0 (onboarding), the LAST step's PAYOFF CONTENT: the
 * **Settings** step ("Your project settings"). It's the final first-run screen —
 * it tells the user "Flow configured your project with these settings" and lists
 * the actual flow-settings sections (Autopilot, Git & PR, Execution, Engines,
 * Learning) so setup ends on a concrete summary rather than a blank confirmation.
 *
 * The deep full-flow spec (onboarding-full-flow.spec.ts) reaches this step but
 * asserts only the header title, the all-dots-active indicator, and the Finish
 * button — it never checks that the step's BODY actually renders the configured
 * settings. If FLOW_SETTINGS_SECTIONS ever rendered empty/broken, a first-run
 * user would land on a confusing blank final panel and still be told to "Finish".
 * This guard drives to the step and asserts the summary content is really there.
 *
 * Reached legitimately (never faking an agent/account): an account row is seeded
 * into flow.db before launch and a real git repo is added via project:add,
 * exactly as the runbook blesses. Then the wizard is re-opened via the same
 * "Getting Started" affordance a returning user would use, and walked to the end.
 */

const MAIN_ENTRY = resolve(__dirname, '../../out/main/index.js')

const WIZARD = '.fl-settings-overlay:not([hidden]):has(.fl-wizard-body)'
// SETTINGS IS A PAGE, not an overlay: it moved into the editor area with its
// groups behind tabs. The name is kept so the walk below reads unchanged; what
// it names is the page.
const SETTINGS_OVERLAY = '.fl-settings-page'
const ANY_OVERLAY = '.fl-settings-overlay:not([hidden])'
const SCREENS = 'e2e/ux/__screens'

// The four flow-settings section titles the Settings step renders from
// FLOW_SETTINGS_SECTIONS — asserted so the payoff panel is provably populated.
// No "Engines": that section went when lavish was retired and graphify became
// always-on (#1807/#1808) — nothing in it was a setting any more.
const SECTION_TITLES = ['Autopilot', 'Git & PR', 'Execution', 'Learning']

/** Launch the app; a seeded account reads as signed in (see trustSeededAccount). */
async function launch(userDataDir: string): Promise<ElectronApplication> {
  const app = await launchApp(userDataDir)
  await trustSeededAccount(app)
  return app
}

function launchApp(userDataDir: string): Promise<ElectronApplication> {
  return electron.launch({
    args: [MAIN_ENTRY, `--user-data-dir=${userDataDir}`],
    env: {
      ...process.env,
      ELECTRON_RENDERER_URL: '',
      NODE_ENV: 'production',
      FLOW_E2E: '1',
    },
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
  const dir = mkdtempSync(join(tmpdir(), 'flow-ux-onboard-settings-'))
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

test('onboarding Settings step renders the configured flow-settings summary (populated payoff, not a blank final panel)', async () => {
  const userDataDir = mkdtempSync(join(tmpdir(), 'flow-e2e-onboard-settings-'))
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

    // Seeded account → wizard should not auto-open; if it did, dismiss so we drive
    // the returning-user re-open path.
    const auto = win.locator(WIZARD)
    if (await auto.count()) {
      await auto.locator('.fl-wizard-btn', { hasText: 'Skip for now' }).click()
      await expect(auto).toHaveCount(0)
    }
    projectDir = await seedProject(win)
    await dismissFlowOverlay(win)

    await reopenWizard(win)
    const wizard = win.locator(WIZARD)

    // Welcome → Connect → Project: each ungates once its precondition is met
    // (seeded account + root), so three Next clicks land us on the Mode step.
    await advanceWizardTo(win, 'Choose a mode')

    // Mode: pick one so Next ungates, then advance to the final Settings step.
    await expect(wizard.locator('.fl-settings-header')).toContainText('Choose a mode')
    await wizard.locator('.fl-wizard-btn', { hasText: 'Manual' }).click()
    await expect.poll(() => nextDisabled(win)).toBe(false)
    // Mode → (Sign in to Flow) → Settings.
    await advanceWizardTo(win, 'Your project settings')

    // ── the assertion: the Settings step's BODY is a populated summary ─────────
    await expect(wizard.locator('.fl-settings-header')).toContainText('Your project settings')
    const body = wizard.locator('.fl-wizard-body')
    // The framing line that tells the user this IS a summary of what was set up.
    await expect(body).toContainText('Flow configured your project with these settings')
    // Every flow-settings section is listed — not an empty/broken final panel.
    for (const title of SECTION_TITLES) {
      await expect(body, `Settings step should list the "${title}" section`).toContainText(title)
    }
    // And representative field labels are present, so the sections have real rows
    // (headings alone could render while fields silently dropped).
    await expect(body).toContainText('Auto-commit per task')
    await expect(body).toContainText('Model routing')

    await win.screenshot({ path: `${SCREENS}/onboarding-settings-summary.png` })

    // The Workspace step follows the summary, the last one: the primary
    // button reads "Finish" there, and completing it returns to an
    // interactive shell (no trapped overlay).
    await wizard.locator('.fl-wizard-btn', { hasText: /^Next$/ }).click()
    await expect(wizard.locator('.fl-settings-header')).toContainText('Your Workspace')
    await expect(wizard.locator('.fl-wizard-btn', { hasText: 'Finish' })).toBeEnabled()
    await wizard.locator('.fl-wizard-btn', { hasText: 'Finish' }).click()
    await expect(win.locator(WIZARD)).toHaveCount(0)

    expect(errors, errors.join(', ')).toHaveLength(0)
  } finally {
    if (app) await app.close()
    if (projectDir) removeTempDir(projectDir)
    rmSync(userDataDir, { recursive: true, force: true })
  }
})
