import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { trustSeededAccount, advanceWizardTo } from './fixtures/settings'
import { mkdtempSync, rmSync } from 'node:fs'
import { removeTempDir } from './fixtures/seed'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

/**
 * UX sweep — flow 0 (onboarding), DEEP path: the wizard steps that live *behind*
 * the Connect account-gate — **Project → Mode → Settings → Finish**. The base
 * `onboarding.spec.ts` covers the credential-less reachable surface (Welcome,
 * gated Connect, Back, Skip); those later steps have only unit tests and had
 * never been driven end-to-end in a real window.
 *
 * To reach them legitimately (never faking an agent response), we set up the two
 * real preconditions the steps read from the store — exactly what the runbook
 * blesses ("pre-populate the app's SQLite before launch"):
 *   - an **account row** seeded into flow.db via the `sqlite3` CLI (the store
 *     doesn't care how the row landed; the Connect step just reads accounts:list),
 *   - a **project root** added post-boot via the real `project:add` IPC.
 * With both present the wizard is no longer auto-shown, so we re-open it via the
 * same "Getting Started" affordance a returning user would, then walk every step.
 *
 * Assertions target observable UX: the step indicator, gating (Next enabled only
 * when a step's precondition is met), the mode-selection highlight, the Finish
 * button on the last step, and a clean dismissal — plus zero uncaught pageerrors.
 */

const MAIN_ENTRY = resolve(__dirname, '../../out/main/index.js')

const WIZARD = '.fl-settings-overlay:not([hidden]):has(.fl-wizard-body)'
// The main app-level Settings overlay. The per-project "Flow settings · <proj>"
// overlay also carries .fl-settings-header and its text contains "Settings", so
// it's dismissed first (dismissFlowOverlay) before this is matched.
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
  const dir = mkdtempSync(join(tmpdir(), 'flow-ux-onboard-'))
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

async function stepTitle(win: Page): Promise<string> {
  return (await win.locator(`${WIZARD} .fl-settings-header`).textContent()) ?? ''
}

async function dots(win: Page): Promise<(string | null)[]> {
  return win
    .locator(`${WIZARD} .fl-wizard-dot`)
    .evaluateAll((ds) => ds.map((d) => d.getAttribute('data-active')))
}

async function nextDisabled(win: Page): Promise<boolean> {
  return win
    .locator(`${WIZARD} .fl-wizard-btn`, { hasText: 'Next' })
    .evaluate((b) => (b as HTMLButtonElement).disabled)
    .catch(() => true)
}

test('full wizard: seeded account+project unlock Project→Mode→Settings→Finish, each gated & then dismissed clean', async () => {
  const userDataDir = mkdtempSync(join(tmpdir(), 'flow-e2e-onboard-'))
  let projectDir: string | null = null
  let app: ElectronApplication | null = null
  const errors: string[] = []
  try {
    // ── preconditions ───────────────────────────────────────────────────────
    await migrateDb(userDataDir)
    seedAccount(userDataDir)

    app = await launch(userDataDir)
    const win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    win.on('pageerror', (e) => errors.push(e.message))

    // A seeded account means the first-run wizard should NOT auto-open (needsOnboarding
    // is false once an account exists); if it did, dismiss so we drive the re-open path.
    const auto = win.locator(WIZARD)
    if (await auto.count()) {
      await auto.locator('.fl-wizard-btn', { hasText: 'Skip for now' }).click()
      await expect(auto).toHaveCount(0)
    }
    projectDir = await seedProject(win)
    // Adding the first root auto-activates it; a project without .flowconfig then
    // auto-opens the per-project flow-settings overlay. Dismiss it so it doesn't
    // sit on top of the wizard we're about to drive.
    await dismissFlowOverlay(win)

    // ── drive the wizard ────────────────────────────────────────────────────
    await reopenWizard(win)
    const wizard = win.locator(WIZARD)

    // Step 1: Welcome — first dot active, Next ungated.
    expect(await stepTitle(win)).toContain('Welcome to Flow')
    // One dot per step (welcome, agent, connect, project, mode, sign-in,
    // settings, Workspace — the last three added since this spec was written),
    // lit up to and including the step on screen.
    const total = (await dots(win)).length
    const lit = (count: number): string[] =>
      Array.from({ length: total }, (_, index) => (index < count ? 'true' : 'false'))
    expect(await dots(win)).toEqual(lit(1))
    expect(await nextDisabled(win)).toBe(false)
    // The runtime step now sits between Welcome and Connect: which agent
    // runs is chosen before whose account gets connected.
    await wizard.locator('.fl-wizard-btn', { hasText: 'Next' }).click()
    await expect(wizard.locator('.fl-settings-header')).toContainText('Choose your agent')
    await wizard.locator('.fl-wizard-btn', { hasText: 'Next' }).click()

    // Step 2: Connect — the seeded account is auto-detected, so this step reports
    // "Connected" and Next is UNGATED (no dead gate on an already-connected user).
    await expect(wizard.locator('.fl-settings-header')).toContainText('Connect a Claude account')
    await expect(wizard.locator('.fl-wizard-body')).toContainText('Connected as QA Seed Account')
    expect(await dots(win)).toEqual(lit(3))
    await expect
      .poll(() => nextDisabled(win), { message: 'Connect Next should ungate once account exists' })
      .toBe(false)
    await win.screenshot({ path: `${SCREENS}/onboarding-full-connected.png` })
    await wizard.locator('.fl-wizard-btn', { hasText: 'Next' }).click()

    // Step 3: Project — the seeded root is auto-detected; Next ungates.
    await expect(wizard.locator('.fl-settings-header')).toContainText('Open a project')
    await expect
      .poll(() => nextDisabled(win), { message: 'Project Next should ungate once a root exists' })
      .toBe(false)
    await wizard.locator('.fl-wizard-btn', { hasText: 'Next' }).click()

    // Step 4: Mode — the SAFE default is pre-reflected. Since #790 (the #716 fix),
    // the Mode step mirrors Connect/Project by auto-detecting persisted state: it
    // maps the saved autonomy default (autopilot off ⇒ Manual on a fresh project)
    // onto the step, so Manual arrives pre-highlighted and Next is ungated — never
    // Autonomous, so a user who skims can only fall through to the conservative
    // mode. (This intentionally superseded the older "no default selection"
    // assertion this spec shipped with in #529.) Assertions poll because the
    // reflection resolves via an async getOnboarding IPC round-trip.
    await expect(wizard.locator('.fl-settings-header')).toContainText('Choose a mode')
    const manual = wizard.locator('.fl-wizard-btn', { hasText: 'Manual' })
    const autonomous = wizard.locator('.fl-wizard-btn', { hasText: 'Autonomous' })
    await expect(manual).toHaveClass(/fl-wizard-btn--primary/)
    await expect(autonomous).not.toHaveClass(/fl-wizard-btn--primary/)
    await expect
      .poll(() => nextDisabled(win), { message: 'Mode Next ungated once the safe default reflects' })
      .toBe(false)
    // Explicitly (re-)picking a mode keeps exactly that one highlighted and Next
    // ungated — the pre-selection never blocks a deliberate choice.
    await manual.click()
    await expect(manual).toHaveClass(/fl-wizard-btn--primary/)
    await expect(autonomous).not.toHaveClass(/fl-wizard-btn--primary/)
    expect(await nextDisabled(win)).toBe(false)
    await win.screenshot({ path: `${SCREENS}/onboarding-full-mode.png` })
    // Mode → (Sign in to Flow) → Settings.
    await advanceWizardTo(win, 'Your project settings')

    // Settings — every dot lit but the Workspace step's, which comes last and
    // is where the primary button reads "Finish" (so the user knows this
    // completes setup).
    await expect(wizard.locator('.fl-settings-header')).toContainText('Your project settings')
    expect(await dots(win)).toEqual(lit(total - 1))
    // The Workspace step is the last one since 2026-10-06; Finish lives there.
    await advanceWizardTo(win, 'Your Workspace')
    await expect(wizard.locator('.fl-wizard-btn', { hasText: 'Finish' })).toBeEnabled()
    await win.screenshot({ path: `${SCREENS}/onboarding-full-settings.png` })

    // Finish dismisses the wizard back to an interactive shell (no trapped overlay).
    await wizard.locator('.fl-wizard-btn', { hasText: 'Finish' }).click()
    await expect(win.locator(WIZARD)).toHaveCount(0)

    expect(errors, errors.join(', ')).toHaveLength(0)
  } finally {
    if (app) await app.close()
    if (projectDir) removeTempDir(projectDir)
    rmSync(userDataDir, { recursive: true, force: true })
  }
})

test('mode step: switching selection moves the single highlight, and Back from Settings preserves it', async () => {
  const userDataDir = mkdtempSync(join(tmpdir(), 'flow-e2e-onboard2-'))
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

    await reopenWizard(win)
    const wizard = win.locator(WIZARD)

    // Advance Welcome → Connect → Project → Mode.
    await advanceWizardTo(win, 'Choose a mode')
    await expect(wizard.locator('.fl-settings-header')).toContainText('Choose a mode')

    const manual = wizard.locator('.fl-wizard-btn', { hasText: 'Manual' })
    const autonomous = wizard.locator('.fl-wizard-btn', { hasText: 'Autonomous' })

    // Pick Manual → exactly Manual is highlighted.
    await manual.click()
    await expect(manual).toHaveClass(/fl-wizard-btn--primary/)
    await expect(autonomous).not.toHaveClass(/fl-wizard-btn--primary/)

    // Switch to Autonomous → the highlight MOVES; Manual is no longer selected
    // (a mode picker must never show two modes selected at once).
    await autonomous.click()
    await expect(autonomous).toHaveClass(/fl-wizard-btn--primary/)
    await expect(manual).not.toHaveClass(/fl-wizard-btn--primary/)

    // Advance to Settings, then Back — the Autonomous highlight must survive the
    // re-render (the #320 regression: Back used to drop the selection).
    await advanceWizardTo(win, 'Your project settings')
    await expect(wizard.locator('.fl-settings-header')).toContainText('Your project settings')
    // Back twice: Settings → Sign in to Flow → Mode (sign-in sits between them).
    await wizard.locator('.fl-wizard-btn', { hasText: 'Back' }).click()
    await expect(wizard.locator('.fl-settings-header')).toContainText('Sign in to Flow')
    await wizard.locator('.fl-wizard-btn', { hasText: 'Back' }).click()
    await expect(wizard.locator('.fl-settings-header')).toContainText('Choose a mode')
    await expect(wizard.locator('.fl-wizard-btn', { hasText: 'Autonomous' })).toHaveClass(
      /fl-wizard-btn--primary/,
    )
    await expect(wizard.locator('.fl-wizard-btn', { hasText: 'Manual' })).not.toHaveClass(
      /fl-wizard-btn--primary/,
    )
    // And Next stays ungated — the restored selection is a real, honored choice.
    expect(await nextDisabled(win)).toBe(false)

    expect(errors, errors.join(', ')).toHaveLength(0)
  } finally {
    if (app) await app.close()
    if (projectDir) removeTempDir(projectDir)
    rmSync(userDataDir, { recursive: true, force: true })
  }
})
