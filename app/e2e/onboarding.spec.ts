import { test, expect, dismissOnboarding } from './fixtures/electron'
import { sel } from './selectors'

/**
 * First-run onboarding wizard. On a fresh userData dir (no Claude account), the
 * "Welcome to Flow" wizard opens over the shell. This spec drives the raw window
 * (the `app` fixture, before the auto-dismiss the `window` fixture applies).
 */
test.describe('first-run onboarding', () => {
  test('shows the Welcome to Flow wizard on a fresh launch', async ({ app }) => {
    const window = await app.firstWindow()
    await window.waitForLoadState('domcontentloaded')

    const wizard = window.locator(sel.onboardingVisible)
    await expect(wizard).toHaveCount(1)
    await expect(wizard.locator('.fl-settings-header')).toContainText('Welcome to Flow')
    // Wizard chrome: step dots and a Skip/Next footer.
    await expect(wizard.locator('.fl-wizard-steps .fl-wizard-dot').first()).toBeVisible()
    await expect(wizard.locator('.fl-wizard-btn', { hasText: 'Skip for now' })).toBeVisible()
    await expect(wizard.locator('.fl-wizard-btn', { hasText: 'Next' })).toBeVisible()
  })

  test('Skip for now dismisses the wizard and reveals the shell', async ({ app }) => {
    const window = await app.firstWindow()
    await window.waitForLoadState('domcontentloaded')

    await window.locator(sel.onboardingSkip).first().click()
    await expect(window.locator(sel.onboardingVisible)).toHaveCount(0)
    // Shell is now interactable.
    await expect(window.locator(sel.threadSidebar)).toBeVisible()
  })

  test('Next advances through the wizard steps', async ({ app }) => {
    const window = await app.firstWindow()
    await window.waitForLoadState('domcontentloaded')

    const wizard = window.locator(sel.onboardingVisible)
    const dots = wizard.locator('.fl-wizard-dot')
    const total = await dots.count()
    expect(total).toBeGreaterThan(1)

    await wizard.locator('.fl-wizard-btn', { hasText: 'Next' }).click()
    // A "Back" affordance becomes available once past step 1.
    await expect(wizard.locator('.fl-wizard-btn', { hasText: 'Back' })).toBeVisible()

    // Clean up so teardown isn't blocked by the modal.
    await dismissOnboarding(window)
  })

  /**
   * Choosing Claude must ANSWER the press, and the step must keep exactly one
   * forward action.
   *
   * Reported live on Windows as "nothing happens": the runtime options are
   * primary-styled buttons, so the Claude option is the only thing on that step
   * that looks like a control — and choosing it replied with a bare
   * instruction, "Connect your Claude account in the next step.", which reads
   * as a refusal rather than a result. Codex and Copilot both answer their own
   * verdict with a visible outcome. So the press got repeated.
   *
   * The first fix added a "Continue to Claude sign-in" button and was reported
   * back as "two buttons for the same thing" — the footer's Next already leads
   * here. So this asserts BOTH halves: the choice is confirmed, and Next (not
   * some second control) is what reaches the account step.
   */
  test('choosing Claude confirms the choice and Next reaches the sign-in step', async ({ app }) => {
    const window = await app.firstWindow()
    await window.waitForLoadState('domcontentloaded')

    const wizard = window.locator(sel.onboardingVisible)
    const claudeOption = wizard.locator('button', { hasText: 'Claude (Anthropic)' })
    const next = wizard.locator('.fl-wizard-btn', { hasText: 'Next' })

    for (let i = 0; i < 8 && (await claudeOption.count()) === 0; i += 1) {
      await next.first().click()
    }
    await expect(claudeOption).toHaveCount(1)

    await claudeOption.click()

    // The press is ANSWERED — not met with an instruction to go elsewhere.
    await expect(wizard.locator('.fl-wizard-body')).toContainText('Claude selected')

    // And the step keeps ONE forward action: no second navigation button
    // duplicating the footer's Next.
    await expect(
      wizard.locator('button', { hasText: /Continue to|Go to|Next step/ }),
    ).toHaveCount(0)

    await next.first().click()
    await expect(wizard.locator('button', { hasText: 'Connect a Claude account' })).toBeVisible()

    await dismissOnboarding(window)
  })
})
