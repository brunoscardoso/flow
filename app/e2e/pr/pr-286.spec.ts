import { test, expect } from '../fixtures/electron'
import { sel } from '../selectors'

/**
 * Regression for PR #286 — "preserve commit-message focus/caret across a
 * background refresh (#282)".
 *
 * The Review panel rebuilds its whole DOM on every `setGroups()`, and the #182
 * refresh gate defers rebuilds ONLY for reject/discard prompts — not the plain
 * commit-message inputs. So a background refresh (`git:changed`, a debounced
 * `project:fileChanged`, a heartbeat/brain write) fired while the user was
 * typing a commit message recreated the input and dropped focus + caret. During
 * an active agent session (files changing constantly) this happened every few
 * hundred ms, making the message box nearly impossible to type in.
 *
 * #286 tags the two commit-message inputs with `data-msg-key` (the group label,
 * or a reserved `MANUAL_MESSAGE_KEY`), captures the focused input's key +
 * selection before `#render` clears the DOM, and restores focus + caret on the
 * recreated element after. The capture decision is the pure, unit-tested
 * `captureMessageFocus`.
 *
 * The focus-loss and its restoration only reproduce with a project + changed
 * files + a focused commit input mid-typing during a background refresh — out of
 * range for a fresh, credential-less launch (see e2e/README.md "Known gate").
 * The capture decision is fully unit-tested by the `message-focus` suite
 * (snapshots by key + selection, null when nothing tagged is focused or the
 * active element is outside the panel, nullish selection → 0).
 *
 * What IS observable on a fresh launch — and what this spec guards — is that the
 * Review module still boots after #286's edits to `review-panel.ts` (new
 * `captureMessageFocus`/`restoreMessageFocus`, the new `./message-focus` import,
 * `data-msg-key` on both inputs). If those edits had broken the bundle, the
 * Review tab would never mount its panel. Switching to Review and asserting the
 * panel + its empty state proves the edited bundle loaded and rendered
 * end-to-end.
 */
test.describe('PR #286 — commit-message focus preserve (Review module boots after the fix)', () => {
  test('the Review tab mounts the reworked panel and its empty state', async ({ window }) => {
    // Switch to the Review side tab.
    const review = window.locator('[data-rail-item="source-control"]')
    await review.click()
    await expect(review).toHaveClass(/active/)

    // The edited review-panel.ts bundle mounted the panel — proof #286's
    // capture/restore + message-focus import didn't break the module's boot.
    await expect(window.locator('.fl-review')).toBeAttached()

    // With no active project, refresh() calls setGroups([]) → the panel renders
    // its "No project open" empty state (the render path #286's
    // capture/restore wraps).
    await expect(window.locator('.fl-review-empty')).toBeAttached()
    await expect(window.locator('.fl-review-empty')).toContainText('No project open')
  })
})
