import { test, expect } from '../fixtures/electron'
import { sel } from '../selectors'

/**
 * UX sweep — flow 0: first-run onboarding, the Connect step's sign-in ATTEMPT
 * (#972). Complements onboarding.spec.ts, which asserts the connect button's
 * immediate feedback but never follows the attempt any further.
 *
 * Clicking "Connect a Claude account" spawns `claude auth login`. That command
 * always uses Claude's paste-the-code OAuth mode (`code=true`, remote callback —
 * no localhost listener), so the authorization code has to reach the child on
 * STDIN. Since #972 was fixed, the orchestrator spawns with stdin open, streams
 * the child's output, and the login assist renders the sign-in URL fallback plus
 * a paste-your-code field wired to `accounts:submitLoginCode` — the tripwire
 * below asserts that code-entry affordance actually appears.
 *
 * These tests really do spawn the login (a browser tab opens) — the same side
 * effect onboarding.spec.ts's connect test already has. Each test triggers one
 * sign-in attempt.
 */

const SCREENS = 'e2e/ux/__screens'
const CONNECT = 'Connect a Claude account'

test('mid-sign-in the user is never TRAPPED: Skip stays live and dismisses to a working shell', async ({
  app,
}) => {
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')
  const errors: string[] = []
  win.on('pageerror', (e) => errors.push(e.message))

  const wizard = win.locator(sel.onboardingVisible)
  // The runtime step now sits between Welcome and Connect: which agent
  // runs is chosen before whose account gets connected.
  await wizard.locator('.fl-wizard-btn', { hasText: 'Next' }).click()
  await expect(wizard.locator('.fl-settings-header')).toContainText('Choose your agent')
  await wizard.locator('.fl-wizard-btn', { hasText: 'Next' }).click()
  await expect(wizard.locator('.fl-settings-header')).toContainText(CONNECT)

  const connectBtn = wizard.locator('.fl-wizard-btn', { hasText: CONNECT })
  await connectBtn.click()
  await expect(connectBtn).toBeDisabled()
  await expect(wizard.locator('.fl-wizard-body')).toContainText('Opening browser sign-in')

  // The sign-in blocks for minutes (#972). Whatever else is broken about it, the
  // user must not be stuck inside the wizard waiting on it: Skip stays enabled
  // and really does dismiss, leaving an interactive shell behind.
  const skip = wizard.locator('.fl-wizard-btn', { hasText: 'Skip for now' })
  await expect(skip).toBeEnabled()
  await skip.click()
  await expect(win.locator(sel.onboardingVisible)).toHaveCount(0)
  await expect(win.locator(sel.threadSidebar)).toBeVisible()

  expect(errors, errors.join(', ')).toHaveLength(0)
})

// Regression tripwire for #972 — the connect step must surface a way to hand the
// CLI the authorization code it blocks on: once `claude auth login` prints its
// paste-code prompt, the login assist renders a code input (or the sign-in
// completed on its own).
test(
  'connect step offers a way to deliver the auth code the CLI asks for (or completes the sign-in) (#972)',
  async ({ app }) => {
    // A REAL `claude auth login`: it opens the system browser on the sign-in
    // page. That cannot run in a hidden suite (it puts a window on screen and
    // starts a real OAuth flow), so it runs only when asked for by name.
    test.skip(
      process.env['FLOW_E2E_REAL_LOGIN'] !== '1',
      'drives a real `claude auth login` that opens the system browser — set FLOW_E2E_REAL_LOGIN=1 to run',
    )
    test.setTimeout(120_000)
    const win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')

    const wizard = win.locator(sel.onboardingVisible)
    // Welcome → Choose your agent → Connect (the agent step came first, 2026-08-18).
    await wizard.locator('.fl-wizard-btn', { hasText: 'Next' }).click()
    await expect(wizard.locator('.fl-settings-header')).toContainText('Choose your agent')
    await wizard.locator('.fl-wizard-btn', { hasText: 'Next' }).click()
    await wizard.locator('.fl-wizard-btn', { hasText: CONNECT }).click()
    await expect(wizard.locator('.fl-wizard-body')).toContainText('Opening browser sign-in')

    // `claude auth login` prints the sign-in URL and then blocks on
    // "Paste code here if prompted >". Within a generous window the user must be
    // given SOMEWHERE to answer that — a code field — or the sign-in must have
    // completed on its own. Poll rather than wait on one locator so either
    // outcome ends the wait.
    const outcome = await win.waitForFunction(
      () => {
        const el = document.querySelector('.fl-settings-overlay:not([hidden]) .fl-wizard-body')
        if (!el) return null
        if ((el.textContent ?? '').includes('Connected as')) return 'connected'
        return el.querySelectorAll('input, textarea').length > 0 ? 'code-field' : null
      },
      undefined,
      { timeout: 60_000, polling: 1_000 },
    )

    await win.screenshot({ path: `${SCREENS}/onboarding-connect-code-entry.png` })
    expect(['code-field', 'connected']).toContain(await outcome.jsonValue())
  },
)
