import { test, expect } from '../fixtures/electron'
import { statusButtonByText } from '../selectors'

/**
 * Regression coverage for **PR #145** — "effort-based Auto model routing,
 * configurable in Settings" (part of #129).
 *
 * PR #145 added a "Model routing (Auto)" section to the titlebar Settings modal:
 * one dropdown per effort (Low / Medium / High), each choosing Haiku / Sonnet /
 * Opus, seeded with the suggested defaults (low→Haiku, medium→Sonnet, high→Opus),
 * plus a "Reset to suggested" button. The modal is opened by the status-bar
 * "Claude accounts" button (dispatches `flow:open-settings`, rendered by
 * SettingsView).
 *
 * This guards the delivered Settings surface: the section renders, all three
 * effort→model selects exist with the suggested defaults, and the reset control
 * is present — the part of #145 exercisable from a fresh, credential-less launch.
 *
 * NOT guarded here (tracked in the QA-heartbeat issue for #145): the composer
 * disables the effort dropdown for `Auto` and drops effort from the selection,
 * so Auto currently always routes to the medium tier — a fix is required before
 * that behavior can be asserted green, so it is filed as an issue rather than a
 * (necessarily-failing) spec.
 */
// SETTINGS IS A PAGE, not an overlay: it moved into the editor area with its
// groups behind tabs. What this const names is that page.
const VISIBLE_OVERLAY = '.fl-settings-page'

test.describe('PR #145 — Model routing (Auto) settings section', () => {
  test('renders one effort→model dropdown per effort with the suggested defaults', async ({
    window,
  }) => {
    await window.locator('.fl-titlebar-icon[aria-label="Settings"]').click()
    const overlay = window.locator(VISIBLE_OVERLAY)
    await expect(overlay).toHaveCount(1)

    // The section heading is present.
    await expect(overlay).toContainText('Model routing (Auto)')

    // One select per effort, addressed by its accessible label, seeded with the
    // suggested defaults (low→Haiku, medium→Sonnet, high→Opus).
    const low = overlay.locator('select[aria-label="Model for Low effort"]')
    const medium = overlay.locator('select[aria-label="Model for Medium effort"]')
    const high = overlay.locator('select[aria-label="Model for High effort"]')
    await expect(low).toHaveCount(1)
    await expect(medium).toHaveCount(1)
    await expect(high).toHaveCount(1)
    await expect(low).toHaveValue('haiku')
    await expect(medium).toHaveValue('sonnet')
    await expect(high).toHaveValue('opus')

    // The "Reset to suggested" control is offered.
    await expect(
      overlay.locator('button', { hasText: 'Reset to suggested' }),
    ).toHaveCount(1)
  })

  test('editing an effort mapping persists after reopening the modal', async ({ window }) => {
    // Open, change Low → Opus, close.
    await window.locator('.fl-titlebar-icon[aria-label="Settings"]').click()
    let overlay = window.locator(VISIBLE_OVERLAY)
    await expect(overlay).toHaveCount(1)
    const low = overlay.locator('select[aria-label="Model for Low effort"]')
    await low.selectOption('opus')
    await expect(low).toHaveValue('opus')
    // A TAB IS CLOSED FROM THE TAB STRIP. There is no ✕ inside the page, and
    // Escape does not dismiss it — it is not covering anything.
    await window.locator('.fl-shell fl-tabs .tab', { hasText: 'Settings' }).locator('.close').click()
    await expect(window.locator(VISIBLE_OVERLAY)).toBeHidden()

    // Reopen — the saved mapping is reflected (round-trips through the store).
    await window.locator('.fl-titlebar-icon[aria-label="Settings"]').click()
    overlay = window.locator(VISIBLE_OVERLAY)
    await expect(overlay).toHaveCount(1)
    await expect(
      overlay.locator('select[aria-label="Model for Low effort"]'),
    ).toHaveValue('opus')
  })
})
