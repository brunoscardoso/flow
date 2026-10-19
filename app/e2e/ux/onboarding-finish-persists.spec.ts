import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { trustSeededAccount, advanceWizardTo } from './fixtures/settings'
import { mkdtempSync, rmSync } from 'node:fs'
import { removeTempDir } from './fixtures/seed'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

/**
 * UX sweep — flow 0 (onboarding), round 14: FINISH persistence, the POSITIVE
 * complement to onboarding-dismiss.
 *
 * onboarding-dismiss proves a *dismissed* wizard (Escape/Skip) is NOT marked
 * complete, so a relaunch on the same account-less dir RE-SHOWS it. Nothing drives
 * the opposite, and more important, promise first-run.ts actually makes:
 *
 *   "Once completed, it stays out of the way even if a prerequisite is later
 *    removed — the user opted out by finishing it."  (first-run.ts)
 *
 * i.e. a user who walks the wizard to **Finish** must NEVER be re-onboarded on a
 * later launch — even if they subsequently disconnect their only account (which,
 * absent the completion flag, would re-trigger `needsOnboarding` since
 * accountCount === 0). That invariant is only covered by a pure unit test on
 * needsOnboarding + an in-session store read (mode-effect); it has never been
 * driven across a real Finish → account-removal → relaunch boot. A regression
 * where Finish fails to persist, or where a removed prerequisite re-opens the
 * wizard over a returning user's shell, is a squarely user-facing bug this guards.
 *
 * Preconditions are the runbook-blessed pre-seeded ones (account row in flow.db,
 * project via the real addRoot IPC); no agent responses are faked.
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

/** Seed a real account row + default so the Connect step auto-reflects on boot. */
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
  const dir = mkdtempSync(join(tmpdir(), 'flow-ux-onboard-finish-'))
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

async function readOnboarding(win: Page): Promise<{ completed: boolean }> {
  return win.evaluate(() =>
    (
      window as unknown as {
        flow: { settings: { getOnboarding(): Promise<{ completed: boolean }> } }
      }
    ).flow.settings.getOnboarding(),
  )
}

async function accountCount(win: Page): Promise<number> {
  return win.evaluate(() =>
    (
      window as unknown as { flow: { accounts: { list(): Promise<unknown[]> } } }
    ).flow.accounts.list().then((a) => a.length),
  )
}

test('a FINISHED wizard stays gone on relaunch even after the only account is removed (first-run.ts opt-out promise)', async () => {
  const userDataDir = mkdtempSync(join(tmpdir(), 'flow-e2e-onboard-finish-'))
  let projectDir: string | null = null
  let app: ElectronApplication | null = null
  const errors: string[] = []
  try {
    await migrateDb(userDataDir)
    seedAccount(userDataDir)

    // ── boot 1: complete the wizard through to Finish ────────────────────────
    app = await launch(userDataDir)
    let win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    win.on('pageerror', (e) => errors.push(e.message))

    // Account seeded but no project yet ⇒ the wizard auto-opens on boot. Dismiss
    // that auto-open; we walk the wizard deliberately via the re-open path once a
    // project exists (mirrors the returning-user "Getting Started" entry).
    const auto = win.locator(WIZARD)
    if (await auto.count()) {
      await auto.locator('.fl-wizard-btn', { hasText: 'Skip for now' }).click()
      await expect(auto).toHaveCount(0)
    }
    projectDir = await seedProject(win)
    await dismissFlowOverlay(win)

    // Precondition: not yet complete — so a later "gone" is attributable to Finish.
    expect((await readOnboarding(win)).completed, 'precondition: not complete before Finish').toBe(
      false,
    )

    await reopenWizard(win)
    const wizard = win.locator(WIZARD)
    // Welcome → Connect (seeded account auto-reflects) → Project (seeded root).
    await advanceWizardTo(win, 'Choose a mode')
    // Mode: pick Manual (the conservative branch — no autopilot side effects).
    await expect(wizard.locator('.fl-settings-header')).toContainText('Choose a mode')
    const manual = wizard.locator('.fl-wizard-btn', { hasText: 'Manual' })
    await manual.click()
    await expect(manual).toHaveClass(/fl-wizard-btn--primary/, { timeout: 5000 })
    await expect.poll(() => nextDisabled(win)).toBe(false)
    // Next → Settings (last), then Finish.
    await advanceWizardTo(win, 'Your project settings')
    await expect(wizard.locator('.fl-settings-header')).toContainText('Your project settings')
    // The Workspace step is the last one since 2026-10-06; Finish lives there.
    await advanceWizardTo(win, 'Your Workspace')
    await wizard.locator('.fl-wizard-btn', { hasText: 'Finish' }).click()
    await expect(win.locator(WIZARD)).toHaveCount(0)

    // Finish must have persisted completion (independent store read, not the UI).
    await expect
      .poll(() => readOnboarding(win).then((o) => o.completed), {
        message: 'Finish must mark onboarding complete',
        timeout: 5000,
      })
      .toBe(true)

    // ── remove the only account: absent the completion flag this alone would ──
    //    re-trigger needsOnboarding (accountCount === 0) on the next boot.
    await win.evaluate(() =>
      (
        window as unknown as { flow: { accounts: { remove(r: { id: string }): Promise<unknown> } } }
      ).flow.accounts.remove({ id: 'acc-e2e' }),
    )
    await expect.poll(() => accountCount(win)).toBe(0)
    await app.close()
    app = null

    // ── boot 2: returning user, now account-less. The FINISHED wizard must NOT ──
    //    re-open over their shell; they get a clean interactive window.
    app = await launch(userDataDir)
    win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    win.on('pageerror', (e) => errors.push(e.message))

    // The project root persisted, so this is a real returning-user boot; still
    // account-less (verify), yet the completed flag must keep the wizard away.
    expect(await accountCount(win), 'boot 2 is genuinely account-less').toBe(0)
    // Give the async maybeStartOnboarding() its chance to (wrongly) open a wizard.
    await win.waitForTimeout(1500)
    await expect(
      win.locator(WIZARD),
      'a finished wizard must not re-open even after the account was removed',
    ).toHaveCount(0)
    // And the shell is genuinely interactive (not a blank/blocked window).
    await expect(win.locator('.fl-thread-sidebar')).toBeVisible()

    await win.screenshot({ path: `${SCREENS}/onboarding-finish-persists.png` })
    expect(errors, errors.join(', ')).toHaveLength(0)
  } finally {
    if (app) await app.close()
    if (projectDir) removeTempDir(projectDir)
    rmSync(userDataDir, { recursive: true, force: true })
  }
})
