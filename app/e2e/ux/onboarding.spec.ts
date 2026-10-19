import { test, expect } from '../fixtures/electron'
import { sel } from '../selectors'
import type { Page } from '@playwright/test'

/**
 * UX sweep — flow 0: First-run onboarding wizard (steps, gating, skip/back,
 * connect-account affordance). Drives the RAW window (the `app` fixture, before
 * the auto-dismiss the `window` fixture applies) on a fresh, credential-less
 * userData dir, where the "Welcome to Flow" wizard opens over the shell.
 *
 * A fresh launch has no Claude account, so the wizard is only drivable through
 * its reachable surface: the Welcome step, Back/Next navigation, the step-dot
 * indicator, and the Connect step — which is correctly *gated* (Next disabled)
 * until an account exists. The Connect button opens a native browser OAuth flow
 * (not drivable here); we assert its immediate feedback, not its completion. The
 * Project/Mode/Settings steps live behind that account gate and aren't reachable
 * credential-less — see flow/qa-sweep-runbook.md's "Known gate".
 */

const SCREENS = 'e2e/ux/__screens'

const CONNECT = 'Connect a Claude account'

/** Snapshot the wizard chrome so assertions read against observable state. */
async function chrome(wizard: ReturnType<Page['locator']>): Promise<{
  title: string | null
  dots: (string | null)[]
  nextDisabled: boolean
  backVisible: boolean
}> {
  return wizard.evaluate((el) => {
    const btn = (label: string): HTMLButtonElement | undefined =>
      Array.from(el.querySelectorAll<HTMLButtonElement>('.fl-wizard-btn')).find(
        (b) => b.textContent === label,
      )
    return {
      title: (el.querySelector('.fl-settings-header') as HTMLElement)?.textContent ?? null,
      dots: Array.from(el.querySelectorAll('.fl-wizard-dot')).map((d) =>
        d.getAttribute('data-active'),
      ),
      nextDisabled: btn('Next')?.disabled ?? true,
      backVisible: (btn('Back')?.style.visibility ?? 'hidden') !== 'hidden',
    }
  })
}

/**
 * The steps with Workspaces off (the default): welcome, runtime, connect,
 * project, mode, sign-in, settings, knowledge. The Workspace offer appears
 * only while Workspaces are enabled (wizard-controller.ts `wizardSteps`).
 */
const STEP_COUNT = 8

/** The indicator with the first `reached` dots active. */
function dots(reached: number): string[] {
  return Array.from({ length: STEP_COUNT }, (_unused, index) => (index < reached ? 'true' : 'false'))
}

test('welcome step: first launch shows the wizard with the first dot active and Back hidden', async ({
  app,
}) => {
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')
  const errors: string[] = []
  win.on('pageerror', (e) => errors.push(e.message))

  const wizard = win.locator(sel.onboardingVisible)
  await expect(wizard).toHaveCount(1)

  const state = await chrome(wizard)
  expect(state.title).toBe('Welcome to Flow')
  // Every step has a dot; the first is active.
  expect(state.dots).toEqual(dots(1))
  // On the first step there's nothing to go back to, and Next is ungated.
  expect(state.backVisible).toBe(false)
  expect(state.nextDisabled).toBe(false)

  await win.screenshot({ path: `${SCREENS}/onboarding-welcome.png` })
  expect(errors, errors.join(', ')).toHaveLength(0)
})

test('connect step is correctly gated: Next stays disabled until an account exists', async ({
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
  const state = await chrome(wizard)
  expect(state.dots).toEqual(dots(3))
  // Back is now reachable; Next MUST be gated (no account) so the user can't
  // advance into a broken, account-less setup — a disabled affordance, never a
  // dead click that silently does nothing.
  expect(state.backVisible).toBe(true)
  expect(state.nextDisabled).toBe(true)
  // The connect affordance is present.
  await expect(wizard.locator('.fl-wizard-btn', { hasText: CONNECT })).toBeVisible()

  await win.screenshot({ path: `${SCREENS}/onboarding-connect-gated.png` })
  expect(errors, errors.join(', ')).toHaveLength(0)
})

test('connect affordance gives immediate feedback (no dead click) when sign-in starts', async ({
  app,
}) => {
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')
  const errors: string[] = []
  win.on('pageerror', (e) => errors.push(e.message))

  const wizard = win.locator(sel.onboardingVisible)
  await wizard.locator('.fl-wizard-btn', { hasText: 'Next' }).click()
  await expect(wizard.locator('.fl-settings-header')).toContainText('Choose your agent')
  await wizard.locator('.fl-wizard-btn', { hasText: 'Next' }).click()

  const connectBtn = wizard.locator('.fl-wizard-btn', { hasText: CONNECT })
  await connectBtn.click()

  // Clicking Connect opens a native browser OAuth flow. The user must get an
  // instant in-progress signal — the button disables and the step reports
  // "Opening browser sign-in…" — rather than a click that appears to do nothing.
  await expect(connectBtn).toBeDisabled()
  await expect(wizard.locator('.fl-wizard-body')).toContainText('Opening browser sign-in')
  // Skip stays available so the user is never trapped mid-sign-in.
  await expect(wizard.locator('.fl-wizard-btn', { hasText: 'Skip for now' })).toBeEnabled()

  await win.screenshot({ path: `${SCREENS}/onboarding-connect-signing-in.png` })
  expect(errors, errors.join(', ')).toHaveLength(0)
})

test('back navigation returns to Welcome and rewinds the step indicator', async ({ app }) => {
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

  await wizard.locator('.fl-wizard-btn', { hasText: 'Back' }).click()
  await expect(wizard.locator('.fl-settings-header')).toContainText('Choose your agent')
  await wizard.locator('.fl-wizard-btn', { hasText: 'Back' }).click()
  await expect(wizard.locator('.fl-settings-header')).toContainText('Welcome to Flow')

  const state = await chrome(wizard)
  // The indicator rewinds and Back hides again — no stale "step 2" highlight.
  expect(state.dots).toEqual(dots(1))
  expect(state.backVisible).toBe(false)
  expect(state.nextDisabled).toBe(false)

  expect(errors, errors.join(', ')).toHaveLength(0)
})

test('Skip for now dismisses the wizard and reveals an interactive shell', async ({ app }) => {
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')
  const errors: string[] = []
  win.on('pageerror', (e) => errors.push(e.message))

  await win.locator(sel.onboardingSkip).first().click()
  await expect(win.locator(sel.onboardingVisible)).toHaveCount(0)
  await expect(win.locator(sel.threadSidebar)).toBeVisible()

  expect(errors, errors.join(', ')).toHaveLength(0)
})
