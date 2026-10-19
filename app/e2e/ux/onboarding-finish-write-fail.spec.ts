import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
  type Page,
} from '@playwright/test'
import { trustSeededAccount, advanceWizardTo } from './fixtures/settings'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

/**
 * UX sweep — flow 0 (onboarding), round 23: the wizard's **FINISH commit**
 * failing.
 *
 * Finish is not just "close the dialog". It is the COMMIT for the one
 * safety-relevant thing the wizard owns (`onboarding/index.ts` onComplete,
 * lines 13-30): the app-wide permission-prompt bypass `autonomyBypassDefault`
 * is deliberately withheld on every mode click (#1116/#1077) and written ONLY
 * here, in the same `settings:setOnboarding` call that marks onboarding
 * complete.
 *
 * 22 prior onboarding rounds (19 specs) drove every OTHER write in this wizard,
 * including the same failure branch one step earlier:
 *   - `onboarding-mode-persist-fail` / `-rollback` (#229/#1077/#1078) force the
 *     MODE step's `flow.setConfig` to reject and assert the user is told
 *     ("Couldn't save your choice — try again.") and that Next stays gated.
 *   - `onboarding-finish-persists` (#944) drives Finish only on the happy path.
 * Nobody has ever forced the FINAL write — the commit — to fail.
 *
 * It has no user-facing handling at all: `.catch((error) => console.error(...))`
 * and the wizard closes regardless (`#advance()` calls `onComplete` then
 * `close()`, never awaiting). So this probe asks the user's question: I opened
 * Getting Started specifically to turn Autonomous OFF, I picked Manual, I
 * clicked Finish and the wizard closed — is the permission bypass off?
 *
 * The failure is induced in SQLite itself, from a second connection, so it
 * travels the real store → ipcMain → renderer path; nothing in the UI or the
 * preload bridge is stubbed. A writable-store CONTROL runs the identical clicks
 * so the failing case can't be a harness artifact.
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

/** First launch creates + migrates flow.db so the seed can INSERT into it. */
async function migrateDb(userDataDir: string): Promise<void> {
  const app = await launch(userDataDir)
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')
  await app.close()
}

/** A connected account (so Connect auto-passes) + a prior AUTONOMOUS setup. */
function seedAccountAndAutonomy(userDataDir: string): void {
  execFileSync('sqlite3', [
    join(userDataDir, 'flow.db'),
    `INSERT INTO accounts (id, label, config_dir_path, identity_hint, created_at)
       VALUES ('acc-e2e', 'QA Seed Account', '/tmp/flow-e2e-noconfig', 'qa@example.com', '2026-01-01T00:00:00Z');
     INSERT INTO app_settings (key, value) VALUES ('default_account_id', 'acc-e2e');
     INSERT INTO app_settings (key, value) VALUES ('autonomy_bypass_default', 'true');`,
  ])
}

/** Throwaway repo added as a project root, pre-seeded autopilot: true so the
 *  mode step reflects the same Autonomous setup the app store carries. */
async function seedRepo(win: Page): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'flow-ux-onbfinish-'))
  execFileSync('git', ['init', '-q'], { cwd: dir })
  writeFileSync(join(dir, '.git', 'info', 'exclude'), '.claude/\nflow\n.gitignore\n')
  mkdirSync(join(dir, 'flow'), { recursive: true })
  writeFileSync(join(dir, 'flow', '.flowconfig'), 'autopilot: true\n')
  await win.evaluate(async (p) => {
    const api = (
      window as unknown as {
        flow: {
          project: {
            add(r: { path: string }): Promise<unknown>
            setActive(r: { rootPath: string }): Promise<unknown>
          }
        }
      }
    ).flow.project
    await api.add({ path: p })
    await api.setActive({ rootPath: p })
  }, dir)
  return dir
}

async function dismissOverlays(win: Page): Promise<void> {
  for (let i = 0; i < 4; i += 1) {
    if ((await win.locator(ANY_OVERLAY).count()) === 0) return
    await win.keyboard.press('Escape')
    await win.waitForTimeout(400)
  }
}

/** The app's own answer for the app-wide permission-prompt bypass. */
async function bypassDefault(win: Page): Promise<{ completed: boolean; bypass: boolean }> {
  return win.evaluate(async () => {
    const state = await (
      window as unknown as {
        flow: {
          settings: {
            getOnboarding(): Promise<{ completed: boolean; autonomyBypassDefault: boolean }>
          }
        }
      }
    ).flow.settings.getOnboarding()
    return { completed: state.completed, bypass: state.autonomyBypassDefault }
  })
}

function autopilotOnDisk(dir: string): string | null {
  const path = join(dir, 'flow', '.flowconfig')
  if (!existsSync(path)) return null
  const line = readFileSync(path, 'utf-8')
    .split('\n')
    .find((l) => l.trim().startsWith('autopilot:'))
  return line ? line.split(':')[1].trim() : null
}

async function nextDisabled(win: Page): Promise<boolean> {
  return win
    .locator(`${WIZARD} .fl-wizard-btn`, { hasText: /^(Next|Finish)$/ })
    .first()
    .evaluate((b) => (b as HTMLButtonElement).disabled)
}

/** Settings → "Getting Started…" → walk Welcome → Connect → Project → Mode. */
async function openWizardToMode(win: Page): Promise<void> {
  await win.evaluate(() => document.dispatchEvent(new CustomEvent('flow:open-settings')))
  const settings = win.locator(SETTINGS_OVERLAY)
  await expect(settings).toBeVisible()
  // Settings is a tabbed page; "Getting Started…" is a thing about Flow itself,
  // so it sits in the App group with the theme and the updater.
  await win.locator('.fl-settings-tab', { hasText: 'App' }).click()
  await settings.locator('button', { hasText: 'Getting Started' }).click()
  const wizard = win.locator(WIZARD)
  await expect(wizard).toBeVisible()
  for (const title of [
    'Choose your agent',
    'Connect a Claude account',
    'Open a project',
    'Choose a mode',
  ]) {
    await expect.poll(() => nextDisabled(win), { timeout: 20_000 }).toBe(false)
    await wizard.locator('.fl-wizard-btn', { hasText: /^Next$/ }).click()
    await expect(wizard.locator('.fl-settings-header')).toContainText(title)
  }
  await win.waitForTimeout(1500) // the saved-mode reflection is async
}

/**
 * Make writes to the app-settings table fail, leaving reads intact — the fault
 * `settings:setOnboarding` hits on a full/failing disk or a corrupted store.
 *
 * Induced in SQLite itself, from a second connection, so the failure travels the
 * REAL path: `AppSettingsStore.#setBool` throws → the `settings:setOnboarding`
 * ipcMain handler rejects → the renderer's promise rejects. Nothing in the
 * renderer (the code under test) is stubbed or mocked. `chmod` cannot do this —
 * POSIX checks permissions at open(), and SQLite already holds the fd.
 */
function blockSettingsWrites(userDataDir: string): void {
  execFileSync('sqlite3', [
    join(userDataDir, 'flow.db'),
    `CREATE TRIGGER qa_block_app_settings BEFORE INSERT ON app_settings
       BEGIN SELECT RAISE(ABORT, 'disk I/O error'); END;`,
  ])
}

function unblockSettingsWrites(userDataDir: string): void {
  try {
    execFileSync('sqlite3', [
      join(userDataDir, 'flow.db'),
      'DROP TRIGGER IF EXISTS qa_block_app_settings;',
    ])
  } catch {
    /* best effort — the dir may already be gone */
  }
}

/** What Finish left behind, and whether the user was told anything about it. */
interface FinishOutcome {
  /** The commit landed: bypass off (Manual) AND onboarding marked complete. */
  commitLanded: boolean
  /** The wizard stayed open to retry, or something on screen says it failed. */
  userWasTold: boolean
  bypassStillOn: boolean
  onboardingCompleted: boolean
  wizardStillUp: boolean
}

/**
 * Boot with an account + an autopilot-on project + the app-wide bypass ON, then
 * do exactly what a user who wants to turn autonomy OFF does: Getting Started →
 * Mode → Manual → Finish. `blockWrites` decides whether the store accepts the
 * commit. Returns what the app was left in.
 */
async function driveDowngradeToManual(
  blockWrites: boolean,
  screenshot?: string,
): Promise<FinishOutcome & { errors: string[] }> {
  const userDataDir = mkdtempSync(join(tmpdir(), 'flow-ux-onbfinish-udd-'))
  let repo = ''
  let app: ElectronApplication | undefined
  const errors: string[] = []

  try {
    await migrateDb(userDataDir)
    seedAccountAndAutonomy(userDataDir)

    app = await launch(userDataDir)
    const win = await app.firstWindow()
    win.on('pageerror', (error) => errors.push(String(error)))
    await win.waitForLoadState('domcontentloaded')
    repo = await seedRepo(win)
    await dismissOverlays(win)

    // Precondition: the app-wide bypass really is ON before the user downgrades.
    expect(await bypassDefault(win)).toEqual({ completed: false, bypass: true })

    await openWizardToMode(win)
    const wizard = win.locator(WIZARD)
    await wizard.locator('.fl-wizard-btn', { hasText: /^Manual/ }).click()
    // The per-project half of the choice lands on disk (filesystem is writable
    // in BOTH cases) — so the run reaches Finish identically either way.
    await expect.poll(() => autopilotOnDisk(repo), { timeout: 10_000 }).toBe('false')

    if (blockWrites) blockSettingsWrites(userDataDir)

    // Mode → (Sign in to Flow) → Settings → Workspace, where Finish lives.
    await advanceWizardTo(win, 'Your project settings')
    await advanceWizardTo(win, 'Your Workspace')
    await wizard.locator('.fl-wizard-btn', { hasText: /^Finish$/ }).click()
    await win.waitForTimeout(2000)

    const wizardStillUp = (await win.locator(WIZARD).count()) > 0
    const after = await bypassDefault(win)
    if (screenshot) await win.screenshot({ path: `${SCREENS}/${screenshot}` })
    // Anything anywhere on screen that reads as "that didn't save" — the wizard
    // staying open to retry, a toast, an inline line. The mode step one screen
    // earlier renders exactly such a line for the same class of failure.
    const bodyText = await win.evaluate(() => document.body.innerText)
    const complaint = /couldn'?t save|could not save|failed to save|try again|didn'?t save/i.test(
      bodyText,
    )
    unblockSettingsWrites(userDataDir)

    return {
      commitLanded: after.bypass === false && after.completed === true,
      userWasTold: wizardStillUp || complaint,
      bypassStillOn: after.bypass,
      onboardingCompleted: after.completed,
      wizardStillUp,
      errors,
    }
  } finally {
    unblockSettingsWrites(userDataDir)
    await app?.close().catch(() => undefined)
    if (repo) rmSync(repo, { recursive: true, force: true })
    rmSync(userDataDir, { recursive: true, force: true })
  }
}

/**
 * Control. Proves this probe measures the real commit — same clicks, writable
 * store — so the failing case below cannot be a harness artifact.
 */
test('Finish commits the Manual downgrade when the store accepts writes', async () => {
  const outcome = await driveDowngradeToManual(false)
  expect(outcome.errors, 'no uncaught renderer errors').toEqual([])
  expect({
    commitLanded: outcome.commitLanded,
    bypassStillOn: outcome.bypassStillOn,
    onboardingCompleted: outcome.onboardingCompleted,
    wizardStillUp: outcome.wizardStillUp,
  }).toEqual({
    commitLanded: true,
    bypassStillOn: false,
    onboardingCompleted: true,
    wizardStillUp: false,
  })
})

/**
 * The bug. Measured on main: `{commitLanded:false, userWasTold:false,
 * bypassStillOn:true, onboardingCompleted:false, wizardStillUp:false}` — the
 * wizard closes exactly as it does on success, and the app-wide permission
 * bypass the user just turned off is still on. Un-fixmes when Finish either
 * reports the failure or keeps the wizard open to retry.
 */
test.fixme(
  'Finish says so when the onboarding commit fails — it must not close as if it saved',
  async () => {
    const outcome = await driveDowngradeToManual(true, 'onboarding-finish-write-fail.png')
    expect(
      outcome.commitLanded || outcome.userWasTold,
      `Finish must either save or say it didn't — measured ${JSON.stringify(outcome)}`,
    ).toBe(true)
  },
)
