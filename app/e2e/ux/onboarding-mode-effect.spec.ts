import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { trustSeededAccount, advanceWizardTo } from './fixtures/settings'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { removeTempDir } from './fixtures/seed'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

/**
 * UX sweep — flow 0 (onboarding), round 11: MODE-CHOICE **EFFECT** guard.
 *
 * The existing onboarding specs verify the "Choose a mode" step at the UI layer —
 * the highlight moves (full-flow), a failed write surfaces "try again" and stays
 * gated (mode-persist-fail), Back preserves the highlight (#320). But NONE verify
 * that picking a mode has a REAL EFFECT: that choosing **Autonomous** actually
 * persists `autopilot: true` to the project's `.flowconfig` on disk AND flips the
 * app-level `autonomyBypassDefault` setting. That invariant is the entire point of
 * #229 — the autonomy mode gates permission-prompt bypass, so a mode the wizard
 * *shows* as chosen but never writes is a safety-relevant lie (the user believes
 * they're in autopilot; the agent still asks on every action, or vice-versa).
 *
 * This drives the success path to completion (Autonomous → Finish) and then asserts
 * the durable, user-observable outcome by INDEPENDENTLY reading the store and the
 * on-disk config — not trusting the wizard's own "confirmed" highlight. Preconditions
 * are the runbook-blessed pre-seeded ones (account row in flow.db, project via the
 * real addRoot IPC); no agent responses are ever faked.
 */

const MAIN_ENTRY = resolve(__dirname, '../../out/main/index.js')
const WIZARD = '.fl-settings-overlay:not([hidden]):has(.fl-wizard-body)'
// SETTINGS IS A PAGE, not an overlay: it moved into the editor area with its
// groups behind tabs. The name is kept so the walk below reads unchanged; what
// it names is the page.
const SETTINGS_OVERLAY = '.fl-settings-page'
const ANY_OVERLAY = '.fl-settings-overlay:not([hidden])'
const SCREENS = 'e2e/ux/__screens'

/** Launch the app; a seeded account reads as signed in (see trustSeededAccount). */
async function launch(userDataDir: string): Promise<ElectronApplication> {
  const app = await launchApp(userDataDir)
  await trustSeededAccount(app)
  return app
}

function launchApp(userDataDir: string): Promise<ElectronApplication> {
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

function seedAccount(userDataDir: string): void {
  const db = join(userDataDir, 'flow.db')
  execFileSync('sqlite3', [
    db,
    `INSERT INTO accounts (id, label, config_dir_path, identity_hint, created_at)
       VALUES ('acc-e2e', 'QA Seed Account', '/tmp/flow-e2e-noconfig', 'qa@example.com', '2026-01-01T00:00:00Z');
     INSERT INTO app_settings (key, value) VALUES ('default_account_id', 'acc-e2e');`,
  ])
}

async function seedProject(win: Page): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'flow-ux-onboard-effect-'))
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

/** Independently read the app-level onboarding state from the store (not the UI). */
async function readOnboarding(
  win: Page,
): Promise<{ completed: boolean; autonomyBypassDefault: boolean }> {
  return win.evaluate(() =>
    (
      window as unknown as {
        flow: {
          settings: {
            getOnboarding(): Promise<{ completed: boolean; autonomyBypassDefault: boolean }>
          }
        }
      }
    ).flow.settings.getOnboarding(),
  )
}

test('onboarding Autonomous choice has a REAL effect: autopilot:true lands in .flowconfig + autonomyBypassDefault flips (#229)', async () => {
  const userDataDir = mkdtempSync(join(tmpdir(), 'flow-e2e-onboard-effect-'))
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

    const auto = win.locator(WIZARD)
    if (await auto.count()) {
      await auto.locator('.fl-wizard-btn', { hasText: 'Skip for now' }).click()
      await expect(auto).toHaveCount(0)
    }
    projectDir = await seedProject(win)
    await dismissFlowOverlay(win)

    // Baseline: before onboarding completes, autopilot is off and onboarding
    // is not marked complete — so any post-Finish flip is attributable to it.
    const before = await readOnboarding(win)
    expect(before.completed, 'precondition: onboarding not yet complete').toBe(false)
    expect(before.autonomyBypassDefault, 'precondition: bypass off before choosing').toBe(false)

    // Walk Welcome → Connect → Project → Mode.
    await reopenWizard(win)
    const wizard = win.locator(WIZARD)
    await advanceWizardTo(win, 'Choose a mode')
    await expect(wizard.locator('.fl-settings-header')).toContainText('Choose a mode')

    // Choose Autonomous — the safety-relevant branch (autopilot on + bypass on).
    const autonomous = wizard.locator('.fl-wizard-btn', { hasText: 'Autonomous' })
    await autonomous.click()
    await expect(autonomous).toHaveClass(/fl-wizard-btn--primary/, { timeout: 5000 })
    await expect.poll(() => nextDisabled(win)).toBe(false)

    // Next → Settings (last step), then Finish to complete onboarding.
    await advanceWizardTo(win, 'Your project settings')
    await expect(wizard.locator('.fl-settings-header')).toContainText('Your project settings')
    await win.screenshot({ path: `${SCREENS}/onboarding-mode-effect.png` })
    // The Workspace step — the last; Finish lives there.
    await wizard.locator('.fl-wizard-btn', { hasText: /^Next$/ }).click()
    await expect(wizard.locator('.fl-settings-header')).toContainText('Your Workspace')
    await wizard.locator('.fl-wizard-btn', { hasText: 'Finish' }).click()
    await expect(win.locator(WIZARD)).toHaveCount(0)

    // ── EFFECT #1: app-level store flipped (independent read, not the UI) ────────
    await expect
      .poll(() => readOnboarding(win).then((o) => o.autonomyBypassDefault), {
        message: 'Autonomous must flip autonomyBypassDefault true in app settings',
        timeout: 5000,
      })
      .toBe(true)
    const after = await readOnboarding(win)
    expect(after.completed, 'Finish must mark onboarding complete').toBe(true)

    // ── EFFECT #2: the project's .flowconfig on disk carries autopilot: true ─────
    const cfgPath = join(projectDir, 'flow', '.flowconfig')
    // eslint-disable-next-line no-console
    console.log(
      `[probe] .flowconfig exists=${existsSync(cfgPath)} contents=${
        existsSync(cfgPath) ? JSON.stringify(readFileSync(cfgPath, 'utf8')) : '<none>'
      }`,
    )
    await expect
      .poll(
        () => (existsSync(cfgPath) ? readFileSync(cfgPath, 'utf8') : ''),
        {
          message: 'Autonomous choice must persist autopilot: true to .flowconfig on disk',
          timeout: 5000,
        },
      )
      .toMatch(/autopilot:\s*true/)

    // The wizard never claimed success it didn't deliver, and nothing threw.
    expect(errors, errors.join(', ')).toHaveLength(0)
  } finally {
    if (app) await app.close()
    if (projectDir) removeTempDir(projectDir)
    rmSync(userDataDir, { recursive: true, force: true })
  }
})
