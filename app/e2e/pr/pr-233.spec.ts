import { test, expect, dismissOnboarding } from '../fixtures/electron'
import { sel } from '../selectors'

/**
 * Regression for PR #233 — "await the mode-choice write and surface failure
 * instead of false success (#229)".
 *
 * The onboarding "Choose a mode" step wrote the user's autonomy choice to app
 * settings (`autonomyBypassDefault`, a boolean) AND to `.flowconfig`
 * (`autopilot`, a STRING) with fire-and-forget, un-caught promises. Picking a
 * mode immediately highlighted the button and enabled **Next** — a success
 * signal — even if the write rejected, so the user believed autopilot was on
 * while `.flowconfig` was never updated. #233:
 *   - awaits BOTH writes and only **confirms** the mode (highlight + the
 *     `ctx.update` that ungates Next) on success;
 *   - on failure shows an inline "Couldn't save your choice — try again." and
 *     keeps Next gated (`canAdvance('mode')` === `state.mode !== null`);
 *   - isolates the boolean-vs-string payload mapping in a pure, unit-tested
 *     `modePersistPayload` (imported at module scope by `steps.ts`).
 *
 * The failure path itself needs a **connected account + opened project** to
 * reach the mode step (Connect gates Next on an account, Project on a native
 * folder picker Playwright can't drive — see e2e/README.md "Known gate"), and
 * the boolean/string mapping is fully covered by `mode-persist.test.ts`. This
 * spec guards the headlessly-observable half: `steps.ts` now imports
 * `modePersistPayload` from the new `./mode-persist` module at module scope, so
 * a broken/renamed export would crash the onboarding bundle and the wizard would
 * never open. The wizard opening on a fresh launch — and advancing past
 * Welcome — proves that import chain resolved and the steps render intact.
 */
test.describe('PR #233 — onboarding wizard (mode-persist import intact)', () => {
  test('opens the Welcome wizard on a fresh launch', async ({ app }) => {
    const window = await app.firstWindow()
    await window.waitForLoadState('domcontentloaded')

    // Wizard mounted — proof steps.ts's module-scope
    // `import { modePersistPayload } from './mode-persist'` resolved and
    // createOnboardingSteps() built the steps (incl. the mode step) without
    // throwing.
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
