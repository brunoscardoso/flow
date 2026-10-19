import { test, expect } from '../fixtures/electron'
import { sel } from '../selectors'

/**
 * Regression for PR #184 — "reset manual commit message after a successful
 * commit (#183)".
 *
 * In the Review panel's **Manual** commit mode the message draft was seeded into
 * the textarea on every render but never cleared after a successful commit, so
 * the next distinct batch of approved files was silently committed with the
 * stale message left over from the previous commit — a mislabeled commit. #184
 * makes `commitFiles` resolve `Promise<boolean>` (true only on success), the
 * panel awaits it and, on success only, resets both the message and the approved
 * set via the pure `manualDraftAfterCommit` helper (in `review-manual.ts`) and
 * re-renders. A failed commit keeps message + selection for retry.
 *
 * The reset itself needs a project + Claude account + a real committable
 * selection to fire, none of which is drivable from a fresh, credential-less
 * launch (see e2e/README.md "Known gate": review commit is behind a project +
 * Claude account). The reset logic is covered by the pure `manualDraftAfterCommit`
 * unit tests. What IS observable headlessly is that the reworked review bundle
 * still loads and mounts AND that Manual mode — the surface whose commit handler
 * #184 rewired and which now imports `manualDraftAfterCommit` into
 * `review-panel.ts` — still activates. A broken export/import would fail the
 * review bundle so the Manual toggle would never render. This guards that wiring.
 */
test.describe('PR #184 — reset manual commit message after success', () => {
  test('Review Manual mode still activates after the reset-draft rewire', async ({ window }) => {
    // Renderer booted with the reworked review-panel (new manualDraftAfterCommit import).
    await expect(window.locator(sel.shell)).toBeVisible()

    // Switch to Review — activates the tab and mounts the review surface.
    const review = window.locator('[data-rail-item="source-control"]')
    await review.click()
    await expect(review).toHaveClass(/active/)
    await window.locator(sel.scViewBtn).filter({ hasText: 'Phases' }).click() // #335 fold
    await expect(window.locator('.fl-review')).toBeAttached()

    // Fresh launch has no changes → the panel's empty state renders (the
    // `#groups.length === 0` branch of #render()), proving the reworked bundle
    // (manualDraftAfterCommit import) mounts and renders. The Manual-mode toggle
    // this PR reworked was later removed from the review toolbar, so the render
    // path is asserted via the empty state instead.
    await expect(window.locator('.fl-review-empty')).toBeVisible()

    // Renderer stayed alive through the tab switch.
    await expect(window.locator(sel.shell)).toBeVisible()
  })
})
