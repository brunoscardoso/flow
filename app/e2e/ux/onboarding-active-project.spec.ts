import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { trustSeededAccount, advanceWizardTo } from './fixtures/settings'
import { removeTempDir } from './fixtures/seed'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'

/**
 * UX sweep — flow 0 (onboarding), round 17: the wizard's PROJECT IDENTITY with
 * MORE THAN ONE project open.
 *
 * Every prior onboarding round (16 of them, 13 specs) seeded exactly ONE project
 * root, so the question "which project is this wizard talking about?" could never
 * be wrong. Real users accumulate projects: the switcher adds a second root, they
 * switch to it, and later open "Getting Started" from Settings.
 *
 * Fixed contract (#1038): `steps.ts` projectStep resolves the reopen target from
 * `project.active()` (ADR-002 — the app's own answer to "which project
 * am I in"; the titlebar switcher, Files tree, editor and terminals all bind to
 * it), falling back to `roots()[0]` only when nothing is active. One resolution
 * feeds the confirmation label, markRootOnboarded and `session.rootPath`, so the
 * step's text and the mode step's `.flowconfig` write can never disagree.
 *
 * This probe seeds two real repos (alpha added first, bravo added second and made
 * active via the real setActiveProject IPC), reopens the wizard, and reads both the
 * confirmation text and the on-disk effect of the mode choice — independently, from
 * disk, never trusting the wizard's own "✓ Ready." claim.
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

/** Create a throwaway git repo and add it through the real addRoot IPC.
 *  The root is pre-marked "onboarded" (the same localStorage key the wizard
 *  writes) so the per-project flow-settings overlay never auto-opens mid-run and
 *  races the wizard for clicks — this probe is about the wizard, not that panel. */
async function seedProject(win: Page, prefix: string): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  execFileSync('git', ['init', '-q'], { cwd: dir })
  await win.evaluate((p) => {
    const raw = localStorage.getItem('flow.onboarded')
    const seen = raw ? (JSON.parse(raw) as string[]) : []
    localStorage.setItem('flow.onboarded', JSON.stringify([...seen, p]))
  }, dir)
  await win.evaluate(async (p) => {
    await (
      window as unknown as {
        flow: { project: { add(r: { path: string }): Promise<unknown> } }
      }
    ).flow.project.add({ path: p })
  }, dir)
  return dir
}

/** Switch projects the way the titlebar switcher does. */
async function activateProject(win: Page, rootPath: string): Promise<void> {
  await win.evaluate(async (p) => {
    await (
      window as unknown as {
        flow: { project: { setActive(r: { rootPath: string }): Promise<unknown> } }
      }
    ).flow.project.setActive({ rootPath: p })
  }, rootPath)
}

/** The app's own answer to "which project am I in" (ADR-002 project context). */
async function readActiveProject(win: Page): Promise<string | null> {
  const ctx = await win.evaluate(() =>
    (
      window as unknown as {
        flow: { project: { active(): Promise<{ rootPath: string } | null> } }
      }
    ).flow.project.active(),
  )
  return ctx?.rootPath ?? null
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

function flowConfig(dir: string): string {
  const p = join(dir, 'flow', '.flowconfig')
  return existsSync(p) ? readFileSync(p, 'utf8') : ''
}

interface Ctx {
  app: ElectronApplication
  win: Page
  alpha: string
  bravo: string
  errors: string[]
}

/**
 * Two projects open, the SECOND one active, wizard walked to the Project step.
 * Returns the Project-step confirmation text alongside the context.
 */
async function walkToProjectStep(userDataDir: string): Promise<Ctx & { shown: string }> {
  await migrateDb(userDataDir)
  seedAccount(userDataDir)

  const app = await launch(userDataDir)
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')
  const errors: string[] = []
  win.on('pageerror', (e) => errors.push(e.message))

  // The first-run wizard auto-opens (no account/project yet) — skip it; this probe
  // drives the deliberate "Getting Started" reopen path instead. Waited for
  // explicitly: a bare count() can sample before it mounts and leave it stacked
  // under the wizard we open later.
  const auto = win.locator(WIZARD)
  await auto.waitFor({ state: 'visible', timeout: 5000 }).catch(() => undefined)
  if (await auto.count()) {
    await auto.locator('.fl-wizard-btn', { hasText: 'Skip for now' }).click()
    await expect(auto).toHaveCount(0)
  }

  // Project 1 (alpha) — added first, so it becomes active (addRootAndMaybeActivate).
  const alpha = await seedProject(win, 'flow-ux-alpha-')
  await dismissFlowOverlay(win)
  // Project 2 (bravo) — added second (does NOT yank activation), then switched to.
  const bravo = await seedProject(win, 'flow-ux-bravo-')
  await activateProject(win, bravo)
  await dismissFlowOverlay(win)

  // Precondition: the app agrees the user is inside bravo.
  await expect
    .poll(() => readActiveProject(win), { message: 'bravo must be the active project' })
    .toBe(bravo)

  await reopenWizard(win)
  const wizard = win.locator(WIZARD)
  // Welcome → Connect (seeded account reflects) → Project.
  // The runtime step now sits between Welcome and Connect: which agent
  // runs is chosen before whose account gets connected.
  await wizard.locator('.fl-wizard-btn', { hasText: 'Next' }).click()
  await expect(wizard.locator('.fl-settings-header')).toContainText('Choose your agent')
  await wizard.locator('.fl-wizard-btn', { hasText: 'Next' }).click()
  await expect(wizard.locator('.fl-settings-header')).toContainText('Connect a Claude account')
  await expect.poll(() => nextDisabled(win)).toBe(false)
  await wizard.locator('.fl-wizard-btn', { hasText: 'Next' }).click()
  await expect(wizard.locator('.fl-settings-header')).toContainText('Open a project')
  await expect(wizard.locator('.fl-wizard-body')).toContainText('✓')

  const shown = (await wizard.locator('.fl-wizard-body').innerText()).trim()
  // eslint-disable-next-line no-console
  console.log(
    `[probe] active=${basename(bravo)} first-added=${basename(alpha)} projectStep body=${JSON.stringify(shown)}`,
  )
  return { app, win, alpha, bravo, errors, shown }
}

async function chooseAutonomousAndFinish(win: Page): Promise<void> {
  const wizard = win.locator(WIZARD)
  await expect.poll(() => nextDisabled(win)).toBe(false)
  await wizard.locator('.fl-wizard-btn', { hasText: 'Next' }).click()
  await expect(wizard.locator('.fl-settings-header')).toContainText('Choose a mode')
  const autonomous = wizard.locator('.fl-wizard-btn', { hasText: 'Autonomous' })
  await autonomous.click()
  await expect(autonomous).toHaveClass(/fl-wizard-btn--primary/, { timeout: 5000 })
  await expect.poll(() => nextDisabled(win)).toBe(false)
  await advanceWizardTo(win, 'Your project settings')
  await expect(wizard.locator('.fl-settings-header')).toContainText('Your project settings')
  // The Workspace step is the last one since 2026-10-06; Finish lives there.
  await advanceWizardTo(win, 'Your Workspace')
  await wizard.locator('.fl-wizard-btn', { hasText: 'Finish' }).click()
  await expect(win.locator(WIZARD)).toHaveCount(0)
}

function cleanup(ctx: (Ctx & { shown?: string }) | null, userDataDir: string): Promise<void> {
  const done = ctx?.app ? ctx.app.close() : Promise.resolve()
  return done.then(() => {
    if (ctx?.alpha) removeTempDir(ctx.alpha)
    if (ctx?.bravo) removeTempDir(ctx.bravo)
    rmSync(userDataDir, { recursive: true, force: true })
  })
}

// ── GUARD (#1038): the wizard follows the ACTIVE project ──────────────────────
test(
  'the reopened wizard confirms the ACTIVE project and writes the mode into it',
  async () => {
    const userDataDir = mkdtempSync(join(tmpdir(), 'flow-e2e-onboard-active2-'))
    let ctx: (Ctx & { shown: string }) | null = null
    try {
      ctx = await walkToProjectStep(userDataDir)
      const { win, alpha, bravo, shown, errors } = ctx

      // The step must name the project the user is actually inside.
      expect(shown, 'projectStep must confirm the ACTIVE project').toContain(basename(bravo))
      expect(shown).not.toContain(basename(alpha))
      await win.screenshot({ path: `${SCREENS}/onboarding-active-project.png` })

      // ...and the autonomy choice must land in the active project's config,
      // never in a different project the user is not looking at.
      await chooseAutonomousAndFinish(win)
      await expect
        .poll(() => flowConfig(bravo), { timeout: 5000 })
        .toMatch(/autopilot:\s*true/)
      expect(flowConfig(alpha), 'the inactive project must not be reconfigured').not.toMatch(
        /autopilot:\s*true/,
      )
      expect(errors, errors.join(', ')).toHaveLength(0)
    } finally {
      await cleanup(ctx, userDataDir)
    }
  },
)
