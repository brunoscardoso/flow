import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { trustSeededAccount } from './fixtures/settings'
import { removeTempDir } from './fixtures/seed'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

/**
 * UX sweep — flow 0 (onboarding), REOPEN path with a PREVIOUSLY-SAVED mode.
 *
 * A returning user (account + project + a saved autonomy mode) re-opens the
 * wizard via "Getting Started" and walks to the "Choose a mode" step. The
 * Connect and Project steps both auto-detect existing state and reflect it
 * (Connect shows "Connected as …" + ungates; Project shows the root + ungates).
 * The Mode step is the odd one out: it never reads the saved
 * `autonomy_bypass_default` setting (which `settings:getOnboarding` already
 * returns), so it renders with NEITHER mode highlighted and Next GATED —
 * forcing a re-pick. Because the saved choice isn't shown, picking the
 * first/"safe-looking" option silently overwrites the real preference
 * (autonomous → manual); autonomy mode gates permission-prompt bypass, so a
 * silent flip is a safety-relevant change. Tracked as #716 — the live guard
 * documents today's inconsistency; the fixme is the target.
 *
 * Preconditions are the runbook-blessed ones (pre-populate flow.db before
 * launch); no agent responses are ever faked.
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

/** Seed an account row + default-account + a saved AUTONOMOUS autonomy mode. */
function seedAccountAndAutonomousMode(userDataDir: string): void {
  const db = join(userDataDir, 'flow.db')
  execFileSync('sqlite3', [
    db,
    `INSERT INTO accounts (id, label, config_dir_path, identity_hint, created_at)
       VALUES ('acc-e2e', 'QA Seed Account', '/tmp/flow-e2e-noconfig', 'qa@example.com', '2026-01-01T00:00:00Z');
     INSERT INTO app_settings (key, value) VALUES ('default_account_id', 'acc-e2e');
     INSERT INTO app_settings (key, value) VALUES ('autonomy_bypass_default', 'true');`,
  ])
}

async function seedProject(win: Page): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'flow-ux-onboard-mode-'))
  execFileSync('git', ['init', '-q'], { cwd: dir })
  // The SAVED mode the step reflects is the active PROJECT's autopilot (#1206 —
  // it used to read only the app-level default, a store the step never writes),
  // so the returning user's Autonomous choice lives in the project too.
  mkdirSync(join(dir, 'flow'), { recursive: true })
  writeFileSync(join(dir, 'flow', '.flowconfig'), 'autopilot: true\n')
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

/** Set up the returning-user preconditions and walk the wizard to the Mode step. */
async function walkToModeStep(userDataDir: string): Promise<{
  app: ElectronApplication
  win: Page
  projectDir: string
  errors: string[]
}> {
  await migrateDb(userDataDir)
  seedAccountAndAutonomousMode(userDataDir)

  const app = await launch(userDataDir)
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')
  const errors: string[] = []
  win.on('pageerror', (e) => errors.push(e.message))

  const auto = win.locator(WIZARD)
  if (await auto.count()) {
    await auto.locator('.fl-wizard-btn', { hasText: 'Skip for now' }).click()
    await expect(auto).toHaveCount(0)
  }
  const projectDir = await seedProject(win)
  await dismissFlowOverlay(win)

  // The saved mode is readable — the wizard COULD reflect it (like Connect/Project).
  const saved = await win.evaluate(async () =>
    (
      window as unknown as {
        flow: { settings: { getOnboarding(): Promise<{ autonomyBypassDefault?: boolean }> } }
      }
    ).flow.settings.getOnboarding(),
  )
  expect(saved.autonomyBypassDefault, 'saved mode should be autonomous').toBe(true)

  await reopenWizard(win)
  const wizard = win.locator(WIZARD)

  // Welcome → Next
  // The runtime step now sits between Welcome and Connect: which agent
  // runs is chosen before whose account gets connected.
  await wizard.locator('.fl-wizard-btn', { hasText: 'Next' }).click()
  await expect(wizard.locator('.fl-settings-header')).toContainText('Choose your agent')
  await wizard.locator('.fl-wizard-btn', { hasText: 'Next' }).click()
  // Connect: reflects saved account state → "Connected", ungated.
  await expect(wizard.locator('.fl-settings-header')).toContainText('Connect a Claude account')
  await expect(wizard.locator('.fl-wizard-body')).toContainText('Connected as QA Seed Account')
  await expect.poll(() => nextDisabled(win)).toBe(false)
  await wizard.locator('.fl-wizard-btn', { hasText: 'Next' }).click()
  // Project: reflects saved root state → ungated.
  await expect(wizard.locator('.fl-settings-header')).toContainText('Open a project')
  await expect.poll(() => nextDisabled(win)).toBe(false)
  await wizard.locator('.fl-wizard-btn', { hasText: 'Next' }).click()
  // Mode step reached.
  await expect(wizard.locator('.fl-settings-header')).toContainText('Choose a mode')

  return { app, win, projectDir, errors }
}

// ── live guard: documents today's inconsistency (passes on current main) ──────
test('LIVE: reopen mode step neither reflects the saved mode nor errors — Connect/Project do reflect it', async () => {
  const userDataDir = mkdtempSync(join(tmpdir(), 'flow-e2e-onboard-mode-'))
  let ctx: Awaited<ReturnType<typeof walkToModeStep>> | null = null
  try {
    ctx = await walkToModeStep(userDataDir)
    const { win, errors } = ctx
    const wizard = win.locator(WIZARD)
    const manual = wizard.locator('.fl-wizard-btn', { hasText: 'Manual' })
    const autonomous = wizard.locator('.fl-wizard-btn', { hasText: 'Autonomous' })

    // Both mode buttons render, but (today) NEITHER carries the saved-choice
    // highlight — the wizard reaches the Mode step cleanly, so it is not a crash.
    await expect(manual).toBeVisible()
    await expect(autonomous).toBeVisible()
    await win.screenshot({ path: `${SCREENS}/onboarding-mode-saved-ignored.png` })
    expect(errors, errors.join(', ')).toHaveLength(0)
  } finally {
    if (ctx?.app) await ctx.app.close()
    if (ctx?.projectDir) removeTempDir(ctx.projectDir)
    rmSync(userDataDir, { recursive: true, force: true })
  }
})

// ── guard for #716 (fixed): the Mode step reflects the saved autonomy setting
// like Connect/Project do — saved Autonomous pre-selected, Next ungated. ─
test(
  'TRIPWIRE: reopen mode step should pre-select the saved Autonomous mode and ungate Next',
  async () => {
    const userDataDir = mkdtempSync(join(tmpdir(), 'flow-e2e-onboard-mode2-'))
    let ctx: Awaited<ReturnType<typeof walkToModeStep>> | null = null
    try {
      ctx = await walkToModeStep(userDataDir)
      const { win, errors } = ctx
      const wizard = win.locator(WIZARD)
      const autonomous = wizard.locator('.fl-wizard-btn', { hasText: 'Autonomous' })

      // The saved AUTONOMOUS mode should be reflected: highlighted + Next ungated,
      // so the user's real preference is shown and never silently overwritten.
      await expect(autonomous).toHaveClass(/fl-wizard-btn--primary/)
      await expect.poll(() => nextDisabled(win)).toBe(false)
      expect(errors, errors.join(', ')).toHaveLength(0)
    } finally {
      if (ctx?.app) await ctx.app.close()
      if (ctx?.projectDir) removeTempDir(ctx.projectDir)
      rmSync(userDataDir, { recursive: true, force: true })
    }
  },
)
