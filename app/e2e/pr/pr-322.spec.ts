import { test, expect } from '../fixtures/electron'
import { statusButtonByText } from '../selectors'

/**
 * Regression for PR #322 — "serialize the async #render so an account-change
 * race can't duplicate sections (#308)".
 *
 * `SettingsView.#render()` is async (awaits accounts.list + activeProject +
 * getModelRouting, then the project section's own IPC) and fires from TWO
 * independent triggers — `open()` and the `accounts.onChanged` subscription —
 * with no re-entrancy guard. Two calls landing close together interleaved
 * across their awaits and BOTH appended to `#body`, so the overlay showed
 * DUPLICATED "Model settings" / "Model routing (Auto)" / "Getting Started"
 * sections. #322 serializes renders with a monotonic `#renderSeq` generation
 * token, builds every section into a detached fragment, and swaps it in
 * atomically via `replaceChildren()` — so a superseded render bails and a
 * partial/stale render can never leave duplicate sections behind.
 *
 * Forcing the exact open()↔accounts:changed interleave needs a rejecting/racing
 * IPC pair that isn't drivable from a fresh headless launch, and the pure guard
 * predicate `isLatestRender` is covered by `render-guard.test.ts`. This spec
 * guards the headlessly-observable invariant the fix protects: when the
 * accounts overlay renders, each section heading appears EXACTLY ONCE — never
 * duplicated. A regression that re-introduced the double-append (or a broken
 * `replaceChildren` swap) would render two "Model routing (Auto)" headings and
 * fail this assertion.
 */
// SETTINGS IS A PAGE, not an overlay: it moved into the editor area with its
// groups behind tabs. What this const names is that page.
const VISIBLE_OVERLAY = '.fl-settings-page'

test.describe('PR #322 — settings overlay renders each section exactly once (#308)', () => {
  test('no duplicated sections when the accounts overlay opens', async ({ window }) => {
    await expect(window.locator(VISIBLE_OVERLAY)).toHaveCount(0)
    await window.locator('.fl-titlebar-icon[aria-label="Settings"]').click()

    const overlay = window.locator(VISIBLE_OVERLAY)
    await expect(overlay).toBeVisible()

    // The two always-present sections (rendered regardless of project/account
    // state) must each appear exactly once — the #308 bug duplicated them.
    // "Claude accounts" became "Model settings" when the logins moved inside
    // the runtime that uses them — same invariant, current heading.
    await expect(
      overlay.locator('.fl-settings-heading', { hasText: 'Model settings' }),
    ).toHaveCount(1)
    await expect(
      overlay.locator('.fl-settings-heading', { hasText: 'Model routing (Auto)' }),
    ).toHaveCount(1)
    // "Getting Started…" is appended once at the tail of every render — in the
    // App group now, which is hidden until its tab is pressed. `toHaveCount`
    // counts what is in the DOM, which is exactly the accrual question #308 is
    // about, so it reads the same either way.
    await expect(
      overlay.locator('button', { hasText: 'Getting Started' }),
    ).toHaveCount(1)
  })

  test('re-opening the overlay still renders single sections (no accrual)', async ({ window }) => {
    const overlay = window.locator(VISIBLE_OVERLAY)

    // Open → close → open. Closing the tab hides the page; opening re-renders
    // it. With the atomic `replaceChildren()` swap, a second render replaces
    // rather than appends — so sections never accrue across successive opens.
    await window.locator('.fl-titlebar-icon[aria-label="Settings"]').click()
    await expect(overlay).toBeVisible()
    // A TAB IS CLOSED FROM THE TAB STRIP. There is no ✕ inside the page, and
    // Escape does not dismiss it — it is not covering anything.
    await window.locator('.fl-shell fl-tabs .tab', { hasText: 'Settings' }).locator('.close').click()
    await expect(window.locator(VISIBLE_OVERLAY)).toBeHidden()

    await window.locator('.fl-titlebar-icon[aria-label="Settings"]').click()
    await expect(overlay).toBeVisible()
    await expect(
      overlay.locator('.fl-settings-heading', { hasText: 'Model routing (Auto)' }),
    ).toHaveCount(1)
    await expect(
      overlay.locator('button', { hasText: 'Getting Started' }),
    ).toHaveCount(1)
  })
})
