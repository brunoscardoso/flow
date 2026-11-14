import { test, expect, dismissOnboarding } from '../fixtures/electron'
import { sel } from '../selectors'

/**
 * Regression for PR #233 — "await the mode-choice write and surface failure
 * instead of false success (#229)".
 *
 * The step that wrote the choice on click is gone: "Before the agent acts" now
 * holds the pick in wizard state and Finish writes `autonomyBypassDefault` alone
 * (autopilot is chosen per conversation, never by the wizard). What this spec
 * still guards is the headlessly-observable half: the onboarding bundle's
 * imports (`steps.ts`, and `index.ts`'s `modePersistPayload`) resolve, so the
 * wizard opens on a fresh launch and advances past Welcome.
 */
test.describe('PR #233 — onboarding wizard (imports intact)', () => {
  test('opens the Welcome wizard on a fresh launch', async ({ app }) => {
    const window = await app.firstWindow()
    await window.waitForLoadState('domcontentloaded')

    // Wizard mounted — proof the onboarding modules resolved and
    // createOnboardingSteps() built the steps without throwing.
    const wizard = window.locator(sel.onboardingVisible)
    await expect(wizard).toHaveCount(1)
    await expect(wizard.locator('.fl-settings-header')).toContainText('Welcome to Flow')
    await expect(wizard.locator('.fl-wizard-btn', { hasText: 'Next' })).toBeVisible()
  })

  test('advances past Welcome — the built steps render', async ({ app }) => {
    const window = await app.firstWindow()
    await window.waitForLoadState('domcontentloaded')

    const wizard = window.locator(sel.onboardingVisible)
    await expect(wizard).toHaveCount(1)
    // Next on Welcome always advances (canAdvance('welcome') === true); a Back
    // affordance appears once past step 1, proving the step views mounted.
    await wizard.locator('.fl-wizard-btn', { hasText: 'Next' }).click()
    await expect(wizard.locator('.fl-wizard-btn', { hasText: 'Back' })).toBeVisible()

    // Clean up so teardown isn't blocked by the modal.
    await dismissOnboarding(window)
  })
})
