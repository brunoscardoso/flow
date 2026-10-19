import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { trustSeededAccount } from './fixtures/settings'
import { mkdtempSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

/**
 * UX sweep — flow 0 (first-run onboarding), the un-probed **Connect-step REPORT**.
 *
 * 21 prior onboarding rounds (18 specs) drove the Connect step as a *gate*: does
 * Next stay disabled without an account (#48), does the sign-in click give
 * feedback (#972), does abandoning it strand the login (#1167). None ever asked
 * what its confirmation line actually CLAIMS, or what happens to a live sign-in
 * when the user navigates *inside* the wizard.
 *
 * `connectStep` (`onboarding/steps.ts`) derives its whole confirmation from a bare
 * row count:
 *
 *     accounts.list().then(a => { if (a.length > 0) { ctx.update({accountConnected:true});
 *                                                     showConnected(a[0].label) } })
 *
 * so it names `accounts[0]` (account-store orders `created_at ASC`) and never
 * reads `isDefault` — which the same payload carries — nor `accounts.status()`,
 * the live probe Settings uses to say "○ signed out — sessions will fail until
 * you re-login" (added after a user call, settings-view.ts:463).
 *
 * And `OnboardingWizard.#renderCurrent()` does `body.replaceChildren()` on every
 * Back/Next, which destroys the login assist (#972's status line, sign-in URL,
 * paste-code field and its *only* Cancel) while the child process keeps the
 * orchestrator's single-flight slot. #1167 fixed exactly this for Skip/Escape by
 * calling `cancelLoginOwnedBy` in `close()`; the in-wizard re-render never got it.
 *
 * Live guards below lock in what works today. The `test.fixme` tripwires carry
 * the filed bugs — #1319 (the Connect step's claim) and #1320 (the Back/Next
 * re-render) — and flip green when they're fixed.
 */

const MAIN_ENTRY = resolve(__dirname, '../../out/main/index.js')
const WIZARD = '.fl-settings-overlay:not([hidden]):has(.fl-wizard-body)'
// SETTINGS IS A PAGE, not an overlay: it moved into the editor area with its
// groups behind tabs. The name is kept so the walk below reads unchanged; what
// it names is the page.
const SETTINGS_OVERLAY = '.fl-settings-page'
const ANY_OVERLAY = '.fl-settings-overlay:not([hidden])'
const SCREENS = 'e2e/ux/__screens'
const CONNECT = 'Connect a Claude account'
/** The assist has upgraded itself from the child's streamed output — the login is live. */
const LOGIN_LIVE = /sign-in page|authorization code/

function launch(userDataDir: string): Promise<ElectronApplication> {
  return electron.launch({
    args: [MAIN_ENTRY, `--user-data-dir=${userDataDir}`],
    env: { ...process.env, ELECTRON_RENDERER_URL: '', NODE_ENV: 'production', FLOW_E2E: '1' },
  })
}

/** Boot once so the app creates + migrates flow.db, then close. */
async function migrateDb(userDataDir: string): Promise<void> {
  const app = await launch(userDataDir)
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')
  await app.close()
}

/**
 * Two real account rows whose DEFAULT is the *newer* one, and whose config dirs
 * hold no credentials — the ordinary shape of an account whose session expired
 * (Settings offers "Re-login" for precisely this). accounts:list returns them
 * created_at ASC, so accounts[0] is "Personal" and the default is "Work".
 */
function seedTwoAccounts(userDataDir: string): void {
  execFileSync('sqlite3', [
    join(userDataDir, 'flow.db'),
    `INSERT INTO accounts (id, label, config_dir_path, identity_hint, created_at)
       VALUES ('acc-old', 'Personal', '/tmp/flow-e2e-noconfig-a', 'personal@example.com', '2026-01-01T00:00:00Z');
     INSERT INTO accounts (id, label, config_dir_path, identity_hint, created_at)
       VALUES ('acc-new', 'Work', '/tmp/flow-e2e-noconfig-b', 'work@example.com', '2026-02-01T00:00:00Z');
     INSERT INTO app_settings (key, value) VALUES ('default_account_id', 'acc-new');`,
  ])
}

async function dismissOverlays(win: Page): Promise<void> {
  for (let i = 0; i < 3; i += 1) {
    if (!(await win.locator(ANY_OVERLAY).count())) return
    await win.keyboard.press('Escape')
    await win.waitForTimeout(400)
  }
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

/** Walk Welcome → Connect and return the step's rendered confirmation text. */
async function openConnectStep(win: Page): Promise<string> {
  const wizard = win.locator(WIZARD)
  // The runtime step now sits between Welcome and Connect: which agent
  // runs is chosen before whose account gets connected.
  await wizard.locator('.fl-wizard-btn', { hasText: 'Next' }).click()
  await expect(wizard.locator('.fl-settings-header')).toContainText('Choose your agent')
  await wizard.locator('.fl-wizard-btn', { hasText: 'Next' }).click()
  await expect(wizard.locator('.fl-settings-header')).toContainText(CONNECT)
  await expect(wizard.locator('.fl-wizard-body')).toContainText(/Connected as|Connect a Claude/)
  return wizard.locator('.fl-wizard-body').innerText()
}

interface AccountFacts {
  accounts: Array<{ id: string; label: string; isDefault?: boolean }>
  statuses: Array<{ id: string; checked?: boolean; loggedIn?: boolean }>
}

/** The truth the Connect step could have read at the very moment it rendered. */
async function accountFacts(win: Page): Promise<AccountFacts> {
  return win.evaluate(async () => {
    const api = (window as unknown as { flow: { accounts: Record<string, Function> } }).flow.accounts
    const accounts = (await api.list()) as Array<{ id: string; label: string; isDefault?: boolean }>
    const statuses = []
    for (const account of accounts) {
      const result = await api.status?.({ id: account.id }).catch(() => null)
      statuses.push({ id: account.id, ...(result ?? {}) })
    }
    return { accounts, statuses }
  })
}

async function withSeededApp(
  run: (win: Page, errors: string[]) => Promise<void>,
  options: { signedIn?: boolean } = {},
): Promise<void> {
  const userDataDir = mkdtempSync(join(tmpdir(), 'flow-e2e-connect-report-'))
  let app: ElectronApplication | null = null
  try {
    await migrateDb(userDataDir)
    seedTwoAccounts(userDataDir)
    app = await launch(userDataDir)
    // Seeded rows point at empty config dirs, which the #1319 probe truthfully
    // reports as signed out. A spec about what Connect shows for a WORKING
    // account says so.
    if (options.signedIn === true) await trustSeededAccount(app)
    const win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    const errors: string[] = []
    win.on('pageerror', (e) => errors.push(e.message))
    await win.waitForTimeout(1500)
    await dismissOverlays(win) // seeded accounts ⇒ no auto first-run wizard, but be safe
    await run(win, errors)
  } finally {
    if (app) await app.close()
    rmSync(userDataDir, { recursive: true, force: true })
  }
}

// ── live guards: the parts that work today and must keep working ─────────────

test('LIVE: the Connect step auto-detects existing accounts and ungates Next — no dead gate', async () => {
  await withSeededApp(async (win, errors) => {
    await reopenWizard(win)
    const body = await openConnectStep(win)
    expect(body).toContain('Connected as')
    const next = win.locator(`${WIZARD} .fl-wizard-btn`, { hasText: 'Next' })
    await expect(next).toBeEnabled()

    // The app CAN answer both questions the step ignores, right here, right now:
    // which account is default, and whether it can actually run.
    const facts = await accountFacts(win)
    expect(facts.accounts.map((a) => a.label)).toEqual(['Personal', 'Work'])
    expect(facts.accounts.find((a) => a.isDefault)?.label).toBe('Work')
    expect(facts.statuses.every((s) => s.checked === true)).toBe(true)

    await win.screenshot({ path: `${SCREENS}/onboarding-connect-report-claim.png` })
    expect(errors, errors.join(', ')).toHaveLength(0)
  }, { signedIn: true })
})

test('LIVE: Settings tells the truth about the same two accounts (default badge + live status)', async () => {
  await withSeededApp(async (win) => {
    await win.evaluate(() => document.dispatchEvent(new CustomEvent('flow:open-settings')))
    const settings = win.locator(SETTINGS_OVERLAY)
    await expect(settings).toBeVisible()
    // The default badge and the live auth probe both render — this is the
    // sibling surface the wizard disagrees with.
    await expect(settings).toContainText('Default')
    await expect(settings).toContainText(/signed in|signed out/, { timeout: 20_000 })
    await win.screenshot({ path: `${SCREENS}/onboarding-connect-report-settings.png` })
  })
})

// ── tripwires (target behavior — red on current main) ────────────────────────

test.fixme(
  'the Connect confirmation names the DEFAULT account, not merely the oldest row (#1319)',
  async () => {
    await withSeededApp(async (win) => {
      await reopenWizard(win)
      const body = await openConnectStep(win)
      const facts = await accountFacts(win)
      const def = facts.accounts.find((a) => a.isDefault)?.label ?? '(none)'
      expect(
        body,
        `Settings badges "${def}" as Default; the wizard confirms: ${JSON.stringify(body)}`,
      ).toContain(`Connected as ${def}`)
    })
  },
)

test.fixme(
  'a SIGNED-OUT account is not confirmed as a green ✓ — the step says what Settings says (#1319)',
  async () => {
    await withSeededApp(async (win) => {
      await reopenWizard(win)
      const body = await openConnectStep(win)
      const facts = await accountFacts(win)
      const allOut = facts.statuses.every((s) => s.checked === true && s.loggedIn === false)
      expect(allOut, 'precondition: every seeded account probes as signed out').toBe(true)
      expect(
        body,
        `every account probes signed out (sessions will fail) yet the first-run step reports: ${JSON.stringify(body)}`,
      ).toMatch(/signed out|re-?login|sessions will fail/i)
    })
  },
)

test.fixme(
  'Back→Next inside the wizard keeps the in-flight sign-in reachable — code field / Cancel, not a bare button (#1320)',
  async () => {
    test.setTimeout(240_000)
    const userDataDir = mkdtempSync(join(tmpdir(), 'flow-e2e-connect-nav-'))
    let app: ElectronApplication | null = null
    try {
      app = await launch(userDataDir)
      const win = await app.firstWindow()
      await win.waitForLoadState('domcontentloaded')
      const wizard = win.locator(WIZARD)
      await expect(wizard).toBeVisible()

      // Start a real interactive sign-in from the first-run Connect step.
      // The runtime step now sits between Welcome and Connect: which agent
      // runs is chosen before whose account gets connected.
      await wizard.locator('.fl-wizard-btn', { hasText: 'Next' }).click()
      await expect(wizard.locator('.fl-settings-header')).toContainText('Choose your agent')
      await wizard.locator('.fl-wizard-btn', { hasText: 'Next' }).click()
      await expect(wizard.locator('.fl-settings-header')).toContainText(CONNECT)
      await wizard.locator('.fl-wizard-btn', { hasText: CONNECT }).click()
      await expect(wizard.locator('.fl-wizard-body')).toContainText(LOGIN_LIVE, { timeout: 90_000 })

      // One step back and forward — an ordinary "let me re-read that" gesture.
      // One step back is now the runtime step, not Welcome.
      await wizard.locator('.fl-wizard-btn', { hasText: 'Back' }).click()
      await expect(wizard.locator('.fl-settings-header')).toContainText('Choose your agent')
      await wizard.locator('.fl-wizard-btn', { hasText: 'Next' }).click()
      await expect(wizard.locator('.fl-settings-header')).toContainText(CONNECT)
      await win.waitForTimeout(1500)

      await win.screenshot({ path: `${SCREENS}/onboarding-signin-backnext.png` })
      // The sign-in is still running and still owns the orchestrator's only slot,
      // so the step must keep it reachable — the code the user is holding needs
      // somewhere to go, and an abandoned login needs a Cancel.
      await expect(wizard.locator('.fl-wizard-body')).toContainText(
        /authorization code|sign-in page|Cancel|in progress/i,
      )
      await win
        .evaluate(() => (window as any).flow.accounts.cancelLogin?.().catch(() => undefined))
        .catch(() => undefined)
    } finally {
      if (app) await app.close()
      rmSync(userDataDir, { recursive: true, force: true })
    }
  },
)
