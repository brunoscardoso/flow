import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { trustSeededAccount } from './fixtures/settings'
import { removeTempDir } from './fixtures/seed'
import { mkdtempSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'

/**
 * UX sweep — flow 0 (onboarding), REOPEN path: the "Open a project" step's
 * CONFIRMATION UI for a returning user who already has a project root.
 *
 * Prior onboarding rounds drove the Project step only far enough to assert that
 * Next ungates (projectOpen reflected). NONE asserted the step's actual body on
 * reopen: `showOpened(root, false)` must render the picked project as confirmed
 * ("✓ <name>" + "Ready.") AND offer the "Change project…" affordance so the
 * first-run choice is never a trap (#504) — a returning user must be able to
 * see the project is set and that they can switch it. If that confirmation body
 * rendered empty/broken, a returning user would land on a blank, confusing
 * project step even though Next is enabled.
 *
 * Note: clicking "Change project…" opens a NATIVE folder picker (invisible to
 * Playwright), so we assert the affordance renders + is enabled, never drive it.
 *
 * Preconditions are the runbook-blessed ones (pre-populate flow.db before
 * launch, add the root via real project IPC); no agent responses are faked.
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

/** Seed an account row + default-account so the Connect step auto-reflects. */
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
  const dir = mkdtempSync(join(tmpdir(), 'flow-ux-onboard-proj-'))
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

/** Returning-user preconditions; walk the reopened wizard to the Project step. */
async function walkToProjectStep(userDataDir: string): Promise<{
  app: ElectronApplication
  win: Page
  projectDir: string
  errors: string[]
}> {
  await migrateDb(userDataDir)
  seedAccount(userDataDir)

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

  await reopenWizard(win)
  const wizard = win.locator(WIZARD)

  // Welcome → Next.
  // The runtime step now sits between Welcome and Connect: which agent
  // runs is chosen before whose account gets connected.
  await wizard.locator('.fl-wizard-btn', { hasText: 'Next' }).click()
  await expect(wizard.locator('.fl-settings-header')).toContainText('Choose your agent')
  await wizard.locator('.fl-wizard-btn', { hasText: 'Next' }).click()
  // Connect: reflects the seeded account → "Connected", ungated → Next.
  await expect(wizard.locator('.fl-settings-header')).toContainText('Connect a Claude account')
  await expect.poll(() => nextDisabled(win)).toBe(false)
  await wizard.locator('.fl-wizard-btn', { hasText: 'Next' }).click()
  // Project step reached.
  await expect(wizard.locator('.fl-settings-header')).toContainText('Open a project')

  return { app, win, projectDir, errors }
}

// ── live guard: the reopen Project step renders a populated confirmation body ──
test('LIVE: reopen project step confirms the saved root (✓ name + Ready) and offers Change project — no trap, no error', async () => {
  const userDataDir = mkdtempSync(join(tmpdir(), 'flow-e2e-onboard-proj-'))
  let ctx: Awaited<ReturnType<typeof walkToProjectStep>> | null = null
  try {
    ctx = await walkToProjectStep(userDataDir)
    const { win, projectDir, errors } = ctx
    const wizard = win.locator(WIZARD)
    const body = wizard.locator('.fl-wizard-body')
    const name = basename(projectDir)

    // The picked project is shown as confirmed — the returning user isn't left
    // on a blank step even though Next is enabled.
    await expect(body).toContainText(`✓ ${name}`)
    await expect(body).toContainText('Ready.')

    // #504: the choice is never a trap — a "Change project…" affordance is offered
    // and is enabled (not mid-provision) on reopen with an already-set root.
    const change = wizard.locator('.fl-wizard-btn', { hasText: 'Change project' })
    await expect(change).toBeVisible()
    await expect(change).toBeEnabled()

    // Next is ungated (projectOpen reflected from the saved root).
    await expect.poll(() => nextDisabled(win)).toBe(false)

    await win.screenshot({ path: `${SCREENS}/onboarding-project-confirm.png` })
    expect(errors, errors.join(', ')).toHaveLength(0)
  } finally {
    if (ctx?.app) await ctx.app.close()
    if (ctx?.projectDir) removeTempDir(ctx.projectDir)
    rmSync(userDataDir, { recursive: true, force: true })
  }
})
