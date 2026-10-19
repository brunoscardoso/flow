import { test, expect } from '../fixtures/electron'
import { statusButtonByText } from '../selectors'

/**
 * Regression for PR #225 — "confirm account removal + toast on action failure
 * (#216)".
 *
 * The **Remove** button on a Claude account row was a single-click destructive
 * action (it deletes the account's isolated on-disk login dir), and Remove /
 * Set default / Assign-project were bare `void window.flow.accounts.x(...)` with
 * no `.catch` — a rejection was a silent dead click plus an unhandled promise
 * rejection (forbidden pattern #2). #225 gates Remove behind an inline
 * "Remove <account>?" confirm and routes every failure to a `flow:notify` toast
 * via a pure `accountActionFailedToast(action, error)` builder. The builder's
 * titling + error-carrying and `errorText`'s graceful degradation are fully
 * covered by the `settings-feedback` unit suite.
 *
 * Rendering an account row (and thus the Remove/confirm affordance) needs a
 * real Claude account — not drivable from a fresh, credential-less launch (see
 * e2e/README.md "Known gate"). This spec guards the headlessly-observable half:
 * `settings-view.ts` now imports `accountActionFailedToast` from the new
 * `./settings-feedback` module at module scope, so a broken/renamed export would
 * crash the whole Settings bundle and the accounts overlay would fail to render.
 * The overlay opening and mounting its panel proves that wiring is intact.
 */
// SETTINGS IS A PAGE, not an overlay: it moved into the editor area with its
// groups behind tabs. What this const names is that page.
const VISIBLE_OVERLAY = '.fl-settings-page'

test.describe('PR #225 — Settings overlay (settings-feedback import intact)', () => {
  test('opens the accounts overlay and renders its panel', async ({ window }) => {
    await expect(window.locator(VISIBLE_OVERLAY)).toHaveCount(0)
    await window.locator('.fl-titlebar-icon[aria-label="Settings"]').click()
    // Overlay mounted — proof settings-view.ts's module-scope
    // `import { accountActionFailedToast } from './settings-feedback'` resolved
    // and the Settings view rendered without throwing.
    // A PAGE HAS NO PANEL AND NO HEADER STRIP — its chrome is the editor tab
    // and its own tab list. The import this case really guards is proved by the
    // page rendering its groups at all.
    const overlay = window.locator(VISIBLE_OVERLAY)
    await expect(overlay).toBeVisible()
    await expect(overlay.locator('.fl-settings-tab', { hasText: 'Models' })).toBeVisible()
  })
})
