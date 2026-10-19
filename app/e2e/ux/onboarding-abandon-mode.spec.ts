import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { trustSeededAccount, advanceWizardTo } from './fixtures/settings'
import { removeTempDir } from './fixtures/seed'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

/**
 * UX sweep — flow 0 (onboarding), round 19: ABANDONING the wizard after touching
 * the "Choose a mode" step.
 *
 * All 18 prior onboarding rounds (15 specs) drove the mode step either along the
 * happy path (click → Next → Finish) or along its persist-FAILURE branch (#229,
 * #1077, #1078). None ever asked what happens when the user clicks a mode and then
 * BACKS OUT — "Skip for now" or Escape — which is exactly what an exploring user
 * does on a first run, encouraged by the wizard's own welcome copy: "You can skip
 * and finish later."
 *
 * Fixed contract (#1116): the app-wide permission bypass is CONFIRM-GATED. A
 * mode click writes only the visible per-project `flow.setConfig({autopilot})`;
 * `settings.setOnboarding({autonomyBypassDefault})` is committed on FINISH
 * (onboarding/index.ts onComplete), never on click — so backing out via
 * Skip/Escape is a real cancel for the app-wide flag.
 *
 * Why that matters end to end: `main/index.ts:278` hands
 * `appSettings.getAutonomyBypassDefault()` to the ThreadStore as the default
 * permission mode for EVERY new thread. The sidebar's own deliberate opt-in for
 * the same behavior is labelled "New thread — skip permissions (dangerous)"
 * (thread-sidebar.ts:1219-1222) — but after an abandoned onboarding run the plain
 * "New thread" produces exactly that, silently. Nothing else in the renderer reads
 * or writes `autonomyBypassDefault` (grep: only onboarding/mode-persist.ts), so
 * there is no Settings toggle and no thread badge to notice or undo it with.
 *
 * Everything below is read from the REAL stores — `flow.db` via the sqlite3 CLI and
 * the project's `.flowconfig` from disk — never from the wizard's own claims.
 *
 * Test 1 (LIVE) guards the split: a click commits the per-project flag only;
 * Finish is what flips the app-wide bypass. Test 2 (#1116) guards the cancel:
 * an abandoned run leaves the bypass untouched and plain threads still ask.
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

/** First launch creates + migrates flow.db so the account row can be seeded. */
async function migrateDb(userDataDir: string): Promise<void> {
  const app = await launch(userDataDir)
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')
  await app.close()
}

function seedAccount(userDataDir: string): void {
  execFileSync('sqlite3', [
    join(userDataDir, 'flow.db'),
    `INSERT INTO accounts (id, label, config_dir_path, identity_hint, created_at)
       VALUES ('acc-e2e', 'QA Seed Account', '/tmp/flow-e2e-noconfig', 'qa@example.com', '2026-01-01T00:00:00Z');
     INSERT INTO app_settings (key, value) VALUES ('default_account_id', 'acc-e2e');`,
  ])
}

/** Read an app_settings row straight out of flow.db — the store, not the UI. */
function appSetting(userDataDir: string, key: string): string {
  return execFileSync('sqlite3', [
    join(userDataDir, 'flow.db'),
    `SELECT value FROM app_settings WHERE key = '${key}';`,
  ])
    .toString()
    .trim()
}

/** Create a throwaway git repo and add it through the real addRoot IPC.
 *  Pre-marked "onboarded" (the same localStorage key the wizard writes) so the
 *  per-project flow-settings overlay never auto-opens and races for clicks. */
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

/** Create a PLAIN thread — the same `threads:create` the sidebar's "New thread"
 *  item calls with no bypass opt-in — and report the permission mode it got. */
async function createPlainThread(win: Page, rootPath: string): Promise<boolean> {
  return win.evaluate(async (p) => {
    const thread = await (
      window as unknown as {
        flow: {
          threads: {
            create(r: { projectRoot: string; title?: string }): Promise<{
              bypassPermissions: boolean
            }>
          }
        }
      }
    ).flow.threads.create({ projectRoot: p, title: 'qa plain thread' })
    return thread.bypassPermissions
  }, rootPath)
}

function flowConfig(dir: string): string {
  const p = join(dir, 'flow', '.flowconfig')
  return existsSync(p) ? readFileSync(p, 'utf8') : ''
}

async function dismissAnyOverlay(win: Page): Promise<void> {
  const overlay = win.locator(ANY_OVERLAY)
  try {
    await overlay.waitFor({ state: 'visible', timeout: 2000 })
  } catch {
    return
  }
  await win.keyboard.press('Escape')
  await overlay.waitFor({ state: 'hidden', timeout: 3000 }).catch(() => undefined)
}

async function nextDisabled(win: Page): Promise<boolean> {
  return win
    .locator(`${WIZARD} .fl-wizard-btn`, { hasText: 'Next' })
    .evaluate((b) => (b as HTMLButtonElement).disabled)
    .catch(() => true)
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

/** Welcome → Connect (seeded account reflects) → Project → Choose a mode. */
async function walkToModeStep(win: Page): Promise<void> {
  const wizard = win.locator(WIZARD)
  // The runtime step now sits between Welcome and Connect: which agent
  // runs is chosen before whose account gets connected.
  await wizard.locator('.fl-wizard-btn', { hasText: 'Next' }).click()
  await expect(wizard.locator('.fl-settings-header')).toContainText('Choose your agent')
  await wizard.locator('.fl-wizard-btn', { hasText: 'Next' }).click()
  await expect(wizard.locator('.fl-settings-header')).toContainText('Connect a Claude account')
  await expect.poll(() => nextDisabled(win)).toBe(false)
  await wizard.locator('.fl-wizard-btn', { hasText: 'Next' }).click()
  await expect(wizard.locator('.fl-settings-header')).toContainText('Open a project')
  await expect.poll(() => nextDisabled(win)).toBe(false)
  await wizard.locator('.fl-wizard-btn', { hasText: 'Next' }).click()
  await expect(wizard.locator('.fl-settings-header')).toContainText('Choose a mode')
}

interface Ctx {
  app: ElectronApplication
  win: Page
  project: string
  errors: string[]
}

/**
 * Seeded app (one account, one project), wizard reopened and walked to the mode
 * step, "Autonomous" clicked and CONFIRMED selected — but nothing finished yet.
 */
async function abandonAfterChoosingAutonomous(userDataDir: string): Promise<Ctx> {
  await migrateDb(userDataDir)
  seedAccount(userDataDir)

  const app = await launch(userDataDir)
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')
  const errors: string[] = []
  win.on('pageerror', (e) => errors.push(e.message))

  // The first-run wizard auto-opens (no project yet). Dismiss it explicitly —
  // a bare count() can sample before it mounts and leave it stacked underneath.
  const auto = win.locator(WIZARD)
  await auto.waitFor({ state: 'visible', timeout: 8000 }).catch(() => undefined)
  if (await auto.count()) {
    await auto.locator('.fl-wizard-btn', { hasText: 'Skip for now' }).click()
    await expect(auto).toHaveCount(0)
  }

  const project = await seedProject(win, 'flow-ux-onb-abandon-')
  await dismissAnyOverlay(win)

  // Baseline: nothing has touched the app-wide autonomy default yet.
  expect(appSetting(userDataDir, 'autonomy_bypass_default'), 'baseline bypass').toBe('')

  await reopenWizard(win)
  await walkToModeStep(win)

  const wizard = win.locator(WIZARD)
  const autonomous = wizard.locator('.fl-wizard-btn', { hasText: 'Autonomous' })
  await autonomous.click()
  await expect(autonomous).toHaveClass(/fl-wizard-btn--primary/, { timeout: 5000 })

  return { app, win, project, errors }
}

function cleanup(ctx: Ctx | null, userDataDir: string): Promise<void> {
  const done = ctx?.app ? ctx.app.close() : Promise.resolve()
  return done.then(() => {
    if (ctx?.project) removeTempDir(ctx.project)
    rmSync(userDataDir, { recursive: true, force: true })
  })
}

// ── LIVE: the confirm-gated split — click commits the project flag, Finish the bypass ──
test('LIVE: a mode click commits only the per-project autopilot flag — the app-wide bypass waits for Finish', async () => {
  const userDataDir = mkdtempSync(join(tmpdir(), 'flow-e2e-onb-abandon-'))
  let ctx: Ctx | null = null
  try {
    ctx = await abandonAfterChoosingAutonomous(userDataDir)
    const { win, project, errors } = ctx
    const wizard = win.locator(WIZARD)

    await win.screenshot({ path: `${SCREENS}/onboarding-abandon-mode.png` })

    // The click wrote the VISIBLE per-project half (status line / flow settings
    // reflect it, and it is revertable there)...
    await expect
      .poll(() => flowConfig(project), {
        message: 'project .flowconfig after clicking Autonomous',
        timeout: 5000,
      })
      .toMatch(/autopilot:\s*true/)
    // ...but NOT the app-wide permission bypass — that commit is Finish's.
    expect(
      appSetting(userDataDir, 'autonomy_bypass_default'),
      'app-wide bypass must not flip on click',
    ).not.toBe('true')

    // Walk to Finish — the confirm. Now, and only now, the bypass flips.
    await expect.poll(() => nextDisabled(win)).toBe(false)
    await advanceWizardTo(win, 'Your project settings')
    await expect(wizard.locator('.fl-settings-header')).toContainText('Your project settings')
    // The Workspace step is the last one since 2026-10-06; Finish lives there.
    await advanceWizardTo(win, 'Your Workspace')
    await wizard.locator('.fl-wizard-btn', { hasText: 'Finish' }).click()
    await expect(wizard).toHaveCount(0)
    await expect
      .poll(() => appSetting(userDataDir, 'autonomy_bypass_default'), {
        message: 'Finish commits the confirmed Autonomous choice',
        timeout: 5000,
      })
      .toBe('true')
    expect(appSetting(userDataDir, 'onboarding_completed'), 'onboarding completion').toBe('true')

    // The deliberate, finished choice DOES reach new threads — the affordance
    // is confirm-gated, not disabled.
    const bypass = await createPlainThread(win, project)
    // eslint-disable-next-line no-console
    console.log(
      `[probe] after Finish → bypass_default=${appSetting(userDataDir, 'autonomy_bypass_default')} plain-thread bypassPermissions=${bypass}`,
    )
    expect(bypass, 'a plain new thread inherits the CONFIRMED choice').toBe(true)

    expect(errors, errors.join(', ')).toHaveLength(0)
  } finally {
    await cleanup(ctx, userDataDir)
  }
})

// ── GUARD (#1116): backing out of the wizard must not change the app's autonomy ──
test(
  'an abandoned onboarding run must not leave new threads skipping permission prompts',
  async () => {
    const userDataDir = mkdtempSync(join(tmpdir(), 'flow-e2e-onb-abandon2-'))
    let ctx: Ctx | null = null
    try {
      ctx = await abandonAfterChoosingAutonomous(userDataDir)
      const { win, project, errors } = ctx
      const wizard = win.locator(WIZARD)

      await wizard.locator('.fl-wizard-btn', { hasText: 'Skip for now' }).click()
      await expect(wizard).toHaveCount(0)

      // Skipping an unfinished wizard is a cancel: the app-wide permission-prompt
      // bypass must not be left on by a choice the user never confirmed.
      expect(appSetting(userDataDir, 'autonomy_bypass_default')).not.toBe('true')
      expect(await createPlainThread(win, project), 'plain new thread must ask for permissions').toBe(
        false,
      )
      expect(errors, errors.join(', ')).toHaveLength(0)
    } finally {
      await cleanup(ctx, userDataDir)
    }
  },
)
