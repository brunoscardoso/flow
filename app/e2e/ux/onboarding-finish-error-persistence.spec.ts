import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
  type Page,
} from '@playwright/test'
import { trustSeededAccount, advanceWizardTo, backWizardTo } from './fixtures/settings'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { execFileSync } from 'node:child_process'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

/**
 * UX sweep — flow 0 (onboarding), round 25: does the wizard's Finish-failure
 * message SURVIVE, or does it evaporate the moment the user navigates?
 *
 * #1356 taught Finish to stay open and complain when the commit fails, and
 * `onboarding-finish-write-fail.spec.ts` (round 23) guards that FIRST failure.
 * Nobody has ever touched the wizard AFTER that message appears. That matters
 * because the message is the only thing standing between the user and the
 * pre-#1356 silent failure: the commit is the app-wide permission-prompt bypass
 * (`autonomyBypassDefault`, withheld on every mode click per #1116/#1077 and
 * written ONLY by Finish), and while it is unwritten the wizard is showing a
 * "Your project settings" summary that says the setup is done.
 *
 * The mode step ONE SCREEN EARLIER already learned this exact lesson — #1078
 * moved its "Couldn't save your choice" line into wizard STATE precisely so
 * "Back → Next re-renders the step, and the error must not evaporate while it
 * still gates Next". Finish's error was left as a bare DOM node instead
 * (`wizard-view.ts` #showFinishError / #finishError, 202-212), appended to the
 * body that `#renderCurrent()` (231-248) unconditionally `replaceChildren()`s.
 *
 * Nothing in the renderer is stubbed: the write failure is induced in SQLite
 * from a second connection, so it travels store → ipcMain → renderer exactly as
 * a full/corrupt disk would. A writable-store CONTROL runs the same clicks.
 *
 * HARNESS TRAPS (each cost a wrong reading first — see the sweep log):
 *  - The Finish-failure line has NO stable class hook (`.fl-wizard-error` has no
 *    CSS rule); assert on the wizard's own innerText, not a styled locator.
 *  - The seeded project must be `autopilot: true` + app bypass ON, or the mode
 *    step reflects Manual and clicking Manual is a no-op write that never
 *    reaches the disk assertion.
 *  - Blocking `app_settings` writes with a BEFORE INSERT trigger only bites
 *    INSERTs; the seed pre-inserts `autonomy_bypass_default` so the commit's
 *    upsert of `onboarding_completed` is the row that actually aborts.
 */

const MAIN_ENTRY = resolve(__dirname, '../../out/main/index.js')
const WIZARD = '.fl-settings-overlay:not([hidden]):has(.fl-wizard-body)'
// SETTINGS IS A PAGE, not an overlay: it moved into the editor area with its
// groups behind tabs. The name is kept so the walk below reads unchanged; what
// it names is the page.
const SETTINGS_OVERLAY = '.fl-settings-page'
const ANY_OVERLAY = '.fl-settings-overlay:not([hidden])'
const SCREENS = 'e2e/ux/__screens'

/**
 * Anything on screen that reads as "that didn't save".
 *
 * HARNESS TRAP: the wizard's own line is `Couldn’t save your setup — … Try
 * Finish again.` with a TYPOGRAPHIC apostrophe (U+2019) and "Try **Finish**
 * again" — so the obvious `/couldn'?t save|try again/i` matches NEITHER and
 * reports the message as absent even while it is on screen.
 */
const COMPLAINT = /couldn[’']?t save|could not save|failed to save|didn[’']?t save|try .{0,10}again/i

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

/**
 * A config dir that reports `loggedIn: true`, so the Connect step's live probe
 * (#1319) ungates Next and this spec can reach the FINISH step without driving
 * an interactive login. Read-only — only `claude auth status` runs against it.
 * Null when the machine has no logged-in Flow account (the test then skips
 * rather than assert on a wizard parked at the Connect gate).
 */
function loggedInConfigDir(): string | null {
  const accountsDir = join(homedir(), '.flow', 'accounts')
  if (!existsSync(accountsDir)) return null
  for (const entry of readdirSync(accountsDir)) {
    const dir = join(accountsDir, entry)
    try {
      const out = execFileSync('claude', ['auth', 'status'], {
        env: { ...process.env, CLAUDE_CONFIG_DIR: dir },
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 20_000,
      })
      if ((JSON.parse(out) as { loggedIn?: unknown }).loggedIn === true) return dir
    } catch {
      /* not this one */
    }
  }
  return null
}

/** A connected account (so Connect auto-passes) + a prior AUTONOMOUS setup. */
function seedAccountAndAutonomy(userDataDir: string, configDir: string): void {
  execFileSync('sqlite3', [
    join(userDataDir, 'flow.db'),
    `INSERT INTO accounts (id, label, config_dir_path, identity_hint, created_at)
       VALUES ('acc-e2e', 'QA Seed Account', '${configDir}', 'qa@example.com', '2026-01-01T00:00:00Z');
     INSERT INTO app_settings (key, value) VALUES ('default_account_id', 'acc-e2e');
     INSERT INTO app_settings (key, value) VALUES ('autonomy_bypass_default', 'true');`,
  ])
}

async function seedRepo(win: Page): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'flow-ux-onberr-'))
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
    .locator(`${WIZARD} .fl-wizard-btn`, { hasText: /^(Next|Finish|Saving…)$/ })
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

/** The fault `settings:setOnboarding` hits on a full/failing disk. */
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

interface Measurement {
  /** After the FIRST Finish: is the failure stated in the wizard? (#1356) */
  toldOnFirstFailure: boolean
  firstFailureText: string
  /** After Back: does anything still say the setup is unsaved? */
  toldAfterBack: boolean
  /** What the mode step shows after Back — the step body the user lands on. */
  modeStepText: string
  /** After Back → Next → Finish (2nd failure): is the failure stated at all? */
  toldOnSecondFailure: boolean
  secondFailureText: string
  /** The button after the 2nd failed Finish — proof it fired and settled. */
  buttonAfterSecondFinish: string
  /** The settings summary's Autopilot row after Back → switch mode → Next. */
  autopilotRow: string
  /** The store's own answer: the commit never landed in any of this. */
  bypassStillOn: boolean
  onboardingCompleted: boolean
  wizardStillUp: boolean
  errors: string[]
}

/**
 * Boot with an account + an autopilot-on project + the app-wide bypass ON, do
 * what a user turning autonomy OFF does (Getting Started → Mode → Manual →
 * Finish) against a store that rejects the commit — then keep using the wizard
 * the way the "Try Finish again" message invites: check the earlier steps
 * (Back), come forward, Finish again.
 */
async function driveFailThenNavigate(
  configDir: string,
  screenshots: boolean,
): Promise<Measurement> {
  const userDataDir = mkdtempSync(join(tmpdir(), 'flow-ux-onberr-udd-'))
  let repo = ''
  let app: ElectronApplication | undefined
  const errors: string[] = []

  try {
    await migrateDb(userDataDir)
    seedAccountAndAutonomy(userDataDir, configDir)

    app = await launch(userDataDir)
    const win = await app.firstWindow()
    win.on('pageerror', (error) => errors.push(String(error)))
    await win.waitForLoadState('domcontentloaded')
    repo = await seedRepo(win)
    await dismissOverlays(win)

    expect(await bypassDefault(win)).toEqual({ completed: false, bypass: true })

    await openWizardToMode(win)
    const wizard = win.locator(WIZARD)
    await wizard.locator('.fl-wizard-btn', { hasText: /^Manual/ }).click()
    await expect.poll(() => autopilotOnDisk(repo), { timeout: 10_000 }).toBe('false')

    blockSettingsWrites(userDataDir)

    // Mode → (Sign in to Flow) → Settings.
    await advanceWizardTo(win, 'Your project settings')

    // ── 1st Finish: fails. #1356's guarantee.
    await advanceWizardTo(win, 'Your Workspace') // Finish lives on the last step
    await wizard.locator('.fl-wizard-btn', { hasText: /^Finish$/ }).click()
    await win.waitForTimeout(2500)
    const firstFailureText = (await wizard.innerText()).replace(/\s+/g, ' ').trim()
    const toldOnFirstFailure = COMPLAINT.test(firstFailureText)
    if (screenshots) {
      await win.screenshot({ path: `${SCREENS}/onboarding-finish-err-01-told.png` })
    }

    // ── Back: the user re-checks the choices the wizard just failed to save.
    await backWizardTo(win, 'Choose a mode') // Workspace → Settings → Sign in → Mode
    await expect(wizard.locator('.fl-settings-header')).toContainText('Choose a mode')
    await win.waitForTimeout(800)
    const modeStepText = (await wizard.innerText()).replace(/\s+/g, ' ').trim()
    const toldAfterBack = COMPLAINT.test(await win.evaluate(() => document.body.innerText))
    if (screenshots) {
      await win.screenshot({ path: `${SCREENS}/onboarding-finish-err-02-after-back.png` })
    }

    // ── Forward again and Finish again — still blocked, so it MUST fail again.
    // Mode → (Sign in to Flow) → Settings.
    await advanceWizardTo(win, 'Your project settings')
    await advanceWizardTo(win, 'Your Workspace') // Finish lives on the last step
    await wizard.locator('.fl-wizard-btn', { hasText: /^Finish$/ }).click()
    await win.waitForTimeout(2500)
    const secondFailureText = (await wizard.innerText()).replace(/\s+/g, ' ').trim()
    const toldOnSecondFailure = COMPLAINT.test(
      await win.evaluate(() => document.body.innerText),
    )
    const buttonAfterSecondFinish = await wizard
      .locator('.fl-wizard-btn--primary')
      .last()
      .innerText()
    if (screenshots) {
      await win.screenshot({ path: `${SCREENS}/onboarding-finish-err-03-second-fail.png` })
    }

    // ── Adjacent seam: Back → change the mode → Next. Does the "Your project
    // settings" summary (#1207) re-report the NEW choice, or a stale one?
    await backWizardTo(win, 'Choose a mode') // Workspace → Settings → Sign in → Mode
    await expect(wizard.locator('.fl-settings-header')).toContainText('Choose a mode')
    await wizard.locator('.fl-wizard-btn', { hasText: /^Autonomous/ }).click()
    await expect.poll(() => autopilotOnDisk(repo), { timeout: 10_000 }).toBe('true')
    // Mode → (Sign in to Flow) → Settings.
    await advanceWizardTo(win, 'Your project settings')
    await win.waitForTimeout(1500)
    const autopilotRow = (
      await wizard.locator('[data-setting-key="autopilot"]').first().innerText()
    ).trim()

    const wizardStillUp = (await win.locator(WIZARD).count()) > 0
    const after = await bypassDefault(win)
    unblockSettingsWrites(userDataDir)

    return {
      toldOnFirstFailure,
      firstFailureText,
      toldAfterBack,
      modeStepText,
      toldOnSecondFailure,
      secondFailureText,
      buttonAfterSecondFinish,
      autopilotRow,
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

test.describe.configure({ mode: 'serial' })

const CONFIG_DIR = loggedInConfigDir()

/**
 * The drive is one ~40s Electron run; every assertion below reads the SAME run
 * so the suite costs one launch, not four. Memoised (not `beforeAll`) so the
 * live guards and the tripwires can be run in isolation with `-g`.
 */
let measured: Promise<Measurement> | null = null
function drive(): Promise<Measurement> {
  measured ??= driveFailThenNavigate(CONFIG_DIR as string, true)
  return measured
}

test.beforeEach(() => {
  test.skip(CONFIG_DIR === null, 'no logged-in Flow account dir — cannot pass the Connect gate')
})

// ── LIVE guards: what works today and must keep working ─────────────────────

/**
 * #1356, still standing. The FIRST failed commit is announced IN the wizard and
 * the wizard stays open to retry — it must never close as if it saved.
 */
test('LIVE: the FIRST failed Finish is announced and keeps the wizard open (#1356)', async () => {
  const m = await drive()
  expect(m.toldOnFirstFailure, `wizard body was: ${m.firstFailureText}`).toBe(true)
  expect(m.firstFailureText).toContain('Try Finish again')
  expect(m.wizardStillUp, 'the wizard must stay open on a failed commit').toBe(true)
  // The commit really did not land — otherwise this whole probe measures nothing.
  expect({ bypass: m.bypassStillOn, completed: m.onboardingCompleted }).toEqual({
    bypass: true,
    completed: false,
  })
  expect(m.errors, 'no uncaught renderer errors').toEqual([])
})

/**
 * The adjacent seam, measured healthy and worth keeping: Back → switch the mode
 * → Next re-reports the NEW choice in "Your project settings" (#1207), rather
 * than the summary the step rendered the first time through.
 */
test('LIVE: the settings summary re-reports a mode changed via Back (#1207)', async () => {
  const m = await drive()
  expect(m.autopilotRow).toBe('Autopilot — On')
})

// ── Tripwires for #1461 — un-fixme when the notice moves into wizard state ──

/**
 * #1461 (a). Measured on main: `toldAfterBack: false`. Back re-renders the step
 * and `#body.replaceChildren()` detaches the notice, so nothing anywhere says
 * the setup is still unsaved. The mode step one screen earlier renders its own
 * unresolved failure FROM STATE for exactly this reason (#1078).
 */
test('an unresolved Finish failure survives Back navigation (#1461)', async () => {
  const m = await drive()
  expect(
    m.toldAfterBack,
    `nothing on screen says the setup is unsaved — mode step read: ${m.modeStepText}`,
  ).toBe(true)
})

/**
 * #1461 (b), the dangerous half. Measured on main: `toldOnSecondFailure: false`
 * — `#showFinishError` sees a non-null `#finishError` and only sets textContent
 * on the node Back already detached, so the retry the message itself invited
 * fails in total silence. Byte-for-byte the pre-#1356 behaviour.
 */
test('a SECOND failed Finish is announced too — never a silent dead click (#1461)', async () => {
  const m = await drive()
  expect(
    m.toldOnSecondFailure,
    `2nd failed Finish said nothing; wizard body was: ${m.secondFailureText}`,
  ).toBe(true)
  expect(m.buttonAfterSecondFinish).toBe('Finish') // it fired and settled
  expect(m.bypassStillOn, 'and the bypass is still on, unsaved').toBe(true)
})
