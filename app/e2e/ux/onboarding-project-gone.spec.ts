import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
  type Page,
} from '@playwright/test'
import { trustSeededAccount } from './fixtures/settings'
import { existsSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync } from 'node:fs'
import { removeTempDir } from './fixtures/seed'
import { execFileSync } from 'node:child_process'
import { homedir, tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'

/**
 * UX sweep — flow 0 (onboarding), round 24. TWO seams on steps 2-3 of the
 * wizard, both about a precondition the step reports as fine when it is not.
 *
 * A. **"Open a project" ignores the `available` flag** (#1407). #263 introduced
 *    the flag so a root whose location is unreachable renders greyed + tagged
 *    `unavailable`; #974 stopped the titlebar switcher activating one; #975
 *    stopped boot restore binding to one; #1118 made it LIVE — `project:list`
 *    re-stats every root on every read — explicitly so "no surface can render a
 *    project as healthy after its folder was moved/deleted/unmounted
 *    mid-session". `projectStep` (onboarding/steps.ts) reads that very payload
 *    and drops the flag, so it confirms "✓ <name>" + "Ready." for a folder that
 *    is gone and ungates Next on it. `session.rootPath` — a path that does not
 *    exist — is then what the MODE step writes `.flowconfig` to, which RE-CREATES
 *    the deleted directory tree.
 *
 * B. **The Connect step computes a signed-out message and then destroys it**
 *    (#1408). #1319 taught the step to withhold the ✓ when `accounts:status`
 *    says the default account is logged out, with the comment "fall through to
 *    the connect button rather than dead-ending" — but the fall-through ends in
 *    `slot.replaceChildren(connectBtn)`, wiping the just-rendered "<label> is
 *    signed out — connect it again below" line in the same tick. The user gets a
 *    bare Connect button on a hard-gated step, with no hint that the account
 *    they already have is the problem.
 *
 * 23 prior onboarding rounds (20 specs) drove the project step's happy path
 * (#504 "Change project…", #1038 active-vs-first-added identity, #1206 mode
 * reflection) and the connect step's gate/feedback/abandon paths (#48, #972,
 * #1167, #1319, #1320). Neither of these was ever asked.
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

/**
 * A config dir whose `claude auth status` prints a parseable `loggedIn: false`
 * — the ordinary shape of an account whose session expired (Settings offers
 * "Re-login" for exactly this). No credentials, no network.
 */
function signedOutConfigDir(): string {
  return mkdtempSync(join(tmpdir(), 'flow-e2e-signedout-'))
}

/**
 * A config dir that reports `loggedIn: true`, so the Connect step's live probe
 * (#1319) ungates Next and this spec can reach the PROJECT step — the step under
 * test — without driving an interactive login.
 *
 * There is no synthetic substitute: `claude auth status` prints its "config not
 * found" message on stderr while stdout still carries a valid `loggedIn: false`
 * (so `probeFailed` is unreachable), and a copy of a logged-in dir does not
 * carry the login. Read-only — only `auth status` runs against it, no agent
 * session is started and nothing writes into it. Null when the machine has no
 * logged-in Flow account, in which case the test skips rather than assert on a
 * wizard parked at the Connect gate.
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

function seedAccount(userDataDir: string, configDir: string): void {
  execFileSync('sqlite3', [
    join(userDataDir, 'flow.db'),
    `INSERT INTO accounts (id, label, config_dir_path, identity_hint, created_at)
       VALUES ('acc-e2e', 'QA Seed Account', '${configDir}', 'qa@example.com', '2026-01-01T00:00:00Z');
     INSERT INTO app_settings (key, value) VALUES ('default_account_id', 'acc-e2e');`,
  ])
}

/** A real throwaway git repo, added + activated through real project IPC. */
async function seedProject(win: Page): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'flow-ux-onboard-gone-'))
  execFileSync('git', ['init', '-q'], { cwd: dir })
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

/** The app's own live answer about every root (this is what #1118 made honest). */
async function rootFacts(win: Page): Promise<Array<{ rootPath: string; available?: boolean }>> {
  return win.evaluate(async () =>
    (
      window as unknown as {
        flow: { project: { list(): Promise<Array<{ rootPath: string; available?: boolean }>> } }
      }
    ).flow.project.list(),
  )
}

function nextButton(win: Page) {
  return win.locator(`${WIZARD} .fl-wizard-btn`, { hasText: /^(Next|Finish)$/ }).first()
}

async function nextDisabled(win: Page): Promise<boolean> {
  return nextButton(win).evaluate((b) => (b as HTMLButtonElement).disabled)
}

/** Welcome → Connect; returns the Connect step's rendered body. */
async function openConnectStep(win: Page): Promise<string> {
  const wizard = win.locator(WIZARD)
  // The runtime step now sits between Welcome and Connect: which agent
  // runs is chosen before whose account gets connected.
  await wizard.locator('.fl-wizard-btn', { hasText: 'Next' }).click()
  await expect(wizard.locator('.fl-settings-header')).toContainText('Choose your agent')
  await wizard.locator('.fl-wizard-btn', { hasText: 'Next' }).click()
  await expect(wizard.locator('.fl-settings-header')).toContainText('Connect a Claude account')
  await expect(wizard.locator('.fl-wizard-body')).toContainText(/Connected as|Connect a Claude/)
  await win.waitForTimeout(1200) // let the live status probe settle
  return wizard.locator('.fl-wizard-body').innerText()
}

/** Connect → Project; returns the Project step's rendered body. */
async function openProjectStep(win: Page): Promise<string> {
  const wizard = win.locator(WIZARD)
  await nextButton(win).click()
  await expect(wizard.locator('.fl-settings-header')).toContainText('Open a project')
  await expect(wizard.locator('.fl-wizard-body')).toContainText(/✓|Open project/)
  await win.waitForTimeout(800)
  return wizard.locator('.fl-wizard-body').innerText()
}

interface Ctx {
  win: Page
  errors: string[]
  projectDir: string
  /** The shell's own text right after the folder vanished, before the wizard. */
  shellText: string
}

/**
 * Seeded returning user: one logged-in account, one real git project added +
 * activated — then the project's folder is deleted while the app keeps running
 * (#1118's scenario), and the wizard is reopened via Settings → Getting Started.
 */
async function withGoneProject(configDir: string, run: (ctx: Ctx) => Promise<void>): Promise<void> {
  const userDataDir = mkdtempSync(join(tmpdir(), 'flow-e2e-onb-gone-'))
  let app: ElectronApplication | null = null
  let projectDir = ''
  let movedTo = ''
  try {
    await migrateDb(userDataDir)
    seedAccount(userDataDir, configDir)
    app = await launch(userDataDir)
    const win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    const errors: string[] = []
    win.on('pageerror', (e) => errors.push(e.message))
    await win.waitForTimeout(1200)
    await dismissOverlays(win) // the auto first-run wizard (no project yet)
    projectDir = await seedProject(win)
    await win.waitForTimeout(1500)
    await dismissOverlays(win)

    // The user MOVES the folder in Finder while Flow keeps running (#1118's
    // canonical scenario). A rename is used rather than a delete because the
    // provisioner/watchers keep writing into a live root, which makes a
    // recursive delete race (ENOTEMPTY); a rename is atomic.
    movedTo = `${projectDir}-moved-away`
    renameSync(projectDir, movedTo)
    expect(existsSync(projectDir)).toBe(false)
    await rootFacts(win) // one read = one re-stat (#1118), so the shell can react
    await win.waitForTimeout(800)
    const shellText = await win.locator('body').innerText()

    await run({ win, errors, projectDir, shellText })
  } finally {
    if (app) await app.close()
    rmSync(userDataDir, { recursive: true, force: true })
    for (const dir of [projectDir, movedTo]) {
      if (dir) removeTempDir(dir)
    }
  }
}

function skipWithoutAccount(): string {
  const configDir = loggedInConfigDir()
  test.skip(configDir === null, 'no logged-in Flow account dir — cannot pass the Connect gate')
  return configDir as string
}

// ── A. "Open a project" for a folder that is gone (#1407) ───────────────────

test('LIVE: the app model still knows a deleted project folder is unreachable (#1118)', async () => {
  await withGoneProject(skipWithoutAccount(), async ({ win, projectDir }) => {
    const facts = await rootFacts(win)
    const gone = facts.find((root) => root.rootPath === projectDir)
    expect(gone, 'the deleted root stays a project record (#258)').toBeDefined()
    expect(gone?.available, 'roots() re-stats on every read (#1118)').toBe(false)
  })
})

test.fixme(
  'the wizard project step must not certify a project whose folder is gone as "Ready." (#1407)',
  async () => {
    await withGoneProject(skipWithoutAccount(), async ({ win, projectDir, shellText }) => {
      await reopenWizard(win)
      await openConnectStep(win)
      const body = await openProjectStep(win)
      await win.screenshot({ path: `${SCREENS}/onboarding-project-gone-step.png` })

      const name = basename(projectDir)
      expect(
        body,
        `roots() says available:false for ${name}; shell text mentions "unavailable": ` +
          `${shellText.includes('unavailable')}; the wizard says: ${JSON.stringify(body)}`,
      ).not.toMatch(/Ready\./)
      expect(body, 'the step must say the location is unreachable').toMatch(
        /unavailable|unreachable|missing|can’t find|cannot find/i,
      )
      expect(await nextDisabled(win), 'Next must not ungate on a gone project').toBe(true)
    })
  },
)

test.fixme(
  'accepting the gone project must not RE-CREATE the deleted folder to write autopilot into it (#1407)',
  async () => {
    await withGoneProject(skipWithoutAccount(), async ({ win, projectDir }) => {
      await reopenWizard(win)
      await openConnectStep(win)
      await openProjectStep(win)
      await nextButton(win).click()
      const wizard = win.locator(WIZARD)
      await expect(wizard.locator('.fl-settings-header')).toContainText('Choose a mode')
      await wizard.locator('.fl-wizard-btn', { hasText: /^Manual/ }).click()
      await win.waitForTimeout(2000)
      await win.screenshot({ path: `${SCREENS}/onboarding-project-gone-mode.png` })

      const config = join(projectDir, 'flow', '.flowconfig')
      expect(
        existsSync(projectDir),
        existsSync(config)
          ? `resurrected ${projectDir} and wrote ${JSON.stringify(readFileSync(config, 'utf-8'))}`
          : `resurrected ${projectDir}`,
      ).toBe(false)
    })
  },
)

// ── B. the Connect step for an account whose session expired (#1408) ─────────

async function withSignedOutAccount(
  run: (win: Page, errors: string[]) => Promise<void>,
): Promise<void> {
  const userDataDir = mkdtempSync(join(tmpdir(), 'flow-e2e-onb-signedout-'))
  const configDir = signedOutConfigDir()
  let app: ElectronApplication | null = null
  try {
    await migrateDb(userDataDir)
    seedAccount(userDataDir, configDir)
    // The REAL status probe: this is the signed-out case it exists to catch.
    app = await launchApp(userDataDir)
    const win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    const errors: string[] = []
    win.on('pageerror', (e) => errors.push(e.message))
    await win.waitForTimeout(1500)
    if ((await win.locator(WIZARD).count()) === 0) await reopenWizard(win)
    await run(win, errors)
  } finally {
    if (app) await app.close()
    rmSync(userDataDir, { recursive: true, force: true })
    rmSync(configDir, { recursive: true, force: true })
  }
}

test('LIVE: a signed-out account gets no false ✓, and the step still offers Connect (#1319)', async () => {
  await withSignedOutAccount(async (win, errors) => {
    const body = await openConnectStep(win)
    // #1319's half that works: no green ✓ over a dead session, and the step
    // offers a way forward instead of dead-ending.
    expect(body).not.toContain('Connected as')
    expect(body).toContain('Connect a Claude account')
    expect(await nextDisabled(win), 'Connect is a hard gate (#48)').toBe(true)
    await win.screenshot({ path: `${SCREENS}/onboarding-connect-signedout-silent.png` })
    expect(errors, errors.join(', ')).toHaveLength(0)
  })
})

test.fixme(
  'the Connect step must SAY the existing account is signed out, not just offer Connect (#1408)',
  async () => {
    await withSignedOutAccount(async (win) => {
      const body = await openConnectStep(win)
      const facts = await win.evaluate(async () => {
        const api = (
          window as unknown as {
            flow: { accounts: Record<string, (arg?: unknown) => Promise<unknown>> }
          }
        ).flow.accounts
        const accounts = (await api.list()) as Array<{ id: string; label: string }>
        const statuses = []
        for (const account of accounts)
          statuses.push({
            label: account.label,
            ...((await api.status?.({ id: account.id })) ?? {}),
          })
        return statuses
      })
      expect(
        body,
        `accounts:status answered ${JSON.stringify(facts)} — the step renders: ${JSON.stringify(body)}`,
      ).toMatch(/signed out|sign in again|re-?login/i)
    })
  },
)
