import { test, expect } from '../fixtures/electron'
import { sel } from '../selectors'
import type { Page } from '@playwright/test'

/**
 * UX sweep — flow 0 (first-run onboarding), the **abandoned sign-in** seam.
 *
 * The Connect step spawns a real, interactive `claude auth login` child (#972).
 * Its only abort affordance — the login assist's `Cancel` — lives *inside the
 * wizard overlay*, which `OnboardingWizard.close()` removes from the DOM. The
 * orchestrator keeps a single in-flight slot (`login-orchestrator.ts` `active`),
 * so an abandoned login locks out EVERY sign-in entry point (wizard Connect and
 * Settings Add account alike) for `LOGIN_TIMEOUT_MS` = 5 minutes behind
 * "another sign-in is already in progress" — filed as #1167.
 *
 * The identical seam on the Settings overlay was #1107, fixed by
 * `SettingsView.close()` calling `accounts.cancelLogin()`. The wizard — named in
 * that issue's suggested fix — never got it, so these tests drive the *first-run*
 * surface, where the user has no account and nowhere else to go.
 *
 * Both tests really do spawn a sign-in (a browser tab opens) — the same side
 * effect `onboarding-connect-signin.spec.ts` already has. Each cancels the
 * orchestrator's login on the way out so no child outlives the run.
 */

const SCREENS = 'e2e/ux/__screens'
const CONNECT = 'Connect a Claude account'
// SETTINGS IS A PAGE, not an overlay: it moved into the editor area with its
// groups behind tabs. The name is kept so the walk below reads unchanged; what
// it names is the page.
const SETTINGS_OVERLAY = '.fl-settings-page'
/** The assist has upgraded itself from the child's streamed output — i.e. the
 *  login process is genuinely live, so we abandon a real one, not a race. */
const LOGIN_LIVE = /sign-in page|authorization code/

/** Kill any login this test started so it can't outlive the run. */
async function cancelAnyLogin(win: Page): Promise<void> {
  await win
    .evaluate(() => window.flow.accounts.cancelLogin?.().catch(() => undefined))
    .catch(() => undefined)
}

/** Walk the (already open) wizard to Connect and start the interactive sign-in.
 *  The click must always produce SOME immediate state change — the pending line,
 *  or (when the orchestrator refuses outright) the failure message. A refused
 *  attempt settles synchronously, so "Opening browser sign-in…" can be gone
 *  before the first poll; asserting either is what makes this a dead-click
 *  guard rather than a race. */
async function startSignIn(win: Page): Promise<void> {
  const wizard = win.locator(sel.onboardingVisible)
  // The runtime step now sits between Welcome and Connect: which agent
  // runs is chosen before whose account gets connected.
  await wizard.locator('.fl-wizard-btn', { hasText: 'Next' }).click()
  await expect(wizard.locator('.fl-settings-header')).toContainText('Choose your agent')
  await wizard.locator('.fl-wizard-btn', { hasText: 'Next' }).click()
  await expect(wizard.locator('.fl-settings-header')).toContainText(CONNECT)
  await wizard.locator('.fl-wizard-btn', { hasText: CONNECT }).click()
  await expect(wizard.locator(sel.wizardBody)).toContainText(
    /Opening browser sign-in|already in progress|Connected as|sign-in page|authorization code|failed/i,
  )
}

/** Re-open the wizard through Settings → "Getting Started…". */
async function reopenWizard(win: Page): Promise<void> {
  await win.evaluate(() => document.dispatchEvent(new CustomEvent('flow:open-settings')))
  const settings = win.locator(SETTINGS_OVERLAY)
  await expect(settings).toBeVisible()
  // Settings is a tabbed page; "Getting Started…" is a thing about Flow itself,
  // so it sits in the App group with the theme and the updater.
  await win.locator('.fl-settings-tab', { hasText: 'App' }).click()
  await settings.locator('button', { hasText: 'Getting Started' }).click()
  await expect(win.locator(sel.onboardingVisible)).toBeVisible()
}

/** Classify what the Connect step ended up telling the user. */
async function connectOutcome(win: Page): Promise<string> {
  const handle = await win.waitForFunction(
    () => {
      const el = document.querySelector('.fl-settings-overlay:not([hidden]) .fl-wizard-body')
      const text = el?.textContent ?? ''
      if (text.includes('Connected as')) return 'connected'
      if (/already in progress/i.test(text)) return 'blocked'
      if (/sign-in page|authorization code/i.test(text)) return 'sign-in-live'
      return null
    },
    undefined,
    { timeout: 60_000, polling: 500 },
  )
  return (await handle.jsonValue()) as string
}

/**
 * Live guard (holds on current main): abandoning a sign-in must leave a usable
 * app, and the retry must SAY something within a bounded time — never a disabled
 * button stuck on "Opening browser sign-in…" forever, and never an uncaught
 * error. Guards the dead-click / silent-failure class on the one flow a
 * brand-new user cannot skip.
 */
test('re-connecting after abandoning the wizard mid-sign-in gives bounded feedback, never a dead click', async ({
  app,
}) => {
  test.setTimeout(180_000)
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')
  const errors: string[] = []
  win.on('pageerror', (e) => errors.push(e.message))

  await startSignIn(win)
  await expect(win.locator(sel.wizardBody)).toContainText(LOGIN_LIVE, { timeout: 60_000 })

  // Abandon: the ordinary "I'll finish this later" gesture. Skip must stay live
  // and hand back an interactive shell.
  await win.locator(sel.onboardingSkip).click()
  await expect(win.locator(sel.onboardingVisible)).toHaveCount(0)
  await expect(win.locator(sel.threadSidebar)).toBeVisible()

  // Come back and try again — the only path a user without an account has.
  await reopenWizard(win)
  await startSignIn(win)

  const outcome = await connectOutcome(win)
  await win.screenshot({ path: `${SCREENS}/onboarding-abandon-signin-retry.png` })
  expect(['connected', 'blocked', 'sign-in-live']).toContain(outcome)

  // A refused attempt must be RETRYABLE: the message is rendered and the button
  // comes back enabled rather than staying dead (#1167 is about the lockout
  // itself; this guards the failure UI around it).
  if (outcome === 'blocked') {
    const body = win.locator(sel.wizardBody)
    await expect(body).toContainText('already in progress')
    await expect(
      win.locator(sel.onboardingVisible).locator('.fl-wizard-btn', { hasText: CONNECT }),
    ).toBeEnabled()
  }

  expect(errors, errors.join(', ')).toHaveLength(0)
  await cancelAnyLogin(win)
})

/**
 * Tripwire for #1167: abandoning the wizard must not strand the login it
 * started. Flips green when the wizard cancels on close (the fix #1107 applied
 * to `SettingsView.close()`) or the retry is otherwise made recoverable — i.e.
 * the second attempt reaches a live sign-in instead of the un-cancellable
 * "another sign-in is already in progress" lockout.
 */
test(
  'abandoning the wizard cancels the sign-in it started, so reconnecting works (#1167)',
  async ({ app }) => {
    test.setTimeout(180_000)
    const win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')

    await startSignIn(win)
    await expect(win.locator(sel.wizardBody)).toContainText(LOGIN_LIVE, { timeout: 60_000 })
    await win.locator(sel.onboardingSkip).click()
    await expect(win.locator(sel.onboardingVisible)).toHaveCount(0)

    await reopenWizard(win)
    await startSignIn(win)

    expect(await connectOutcome(win)).not.toBe('blocked')
    await cancelAnyLogin(win)
  },
)
