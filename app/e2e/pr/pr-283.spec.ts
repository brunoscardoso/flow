import { test, expect } from '../fixtures/electron'
import { sel } from '../selectors'

/**
 * Regression for PR #283 — "isolate commit-message drafts per project on switch (#281)".
 *
 * The Review panel's per-group commit-message drafts (`#drafts`) and approval
 * state (`#approved` / `#manualApproved` / `#manualMessage`) are keyed ONLY by
 * group label. Since every project's catch-all group is the same hardcoded
 * "Other changes" (and phase groups reuse "Phase 1" / "Phase 2"), a message
 * typed (or ✨-generated) for project A's group reappeared in project B's
 * same-labeled group — so the user could commit project B's files with project
 * A's message (a wrong-message / data-correctness bug in a multi-project session).
 *
 * #283 adds `ReviewPanel.reset()` (clears all four per-project state stores) and
 * a pure `isProjectSwitch(prev, next)` guard; the review coordinator calls
 * `panel.reset()` from `onActiveProjectChanged` ONLY on a genuine root change, so
 * a same-project background refresh never wipes a draft the user is mid-typing.
 *
 * The cross-project leak itself only reproduces with TWO projects + a Claude
 * account + typed drafts — out of range for a fresh, credential-less launch (see
 * e2e/README.md "Known gate"). That decision is fully unit-tested by the
 * `project-switch` suite (true between two roots and on first selection; false
 * for the same root and for null→null).
 *
 * What IS observable on a fresh launch — and what this spec guards — is that the
 * reworked Review module still boots after #283's edits to `review-panel.ts`
 * (new `reset()`) and `index.ts` (new `isProjectSwitch` import + call). If either
 * edit had broken the bundle, the Review tab would never mount its panel. So
 * switching to Review and asserting the panel + its empty state proves the edited
 * bundle loaded and rendered end-to-end.
 */
test.describe('PR #283 — per-project draft isolation (Review module boots after the fix)', () => {
  test('the Review tab mounts the reworked panel and its empty state', async ({ window }) => {
    // Switch to the Review side tab.
    const review = window.locator('[data-rail-item="source-control"]')
    await review.click()
    await expect(review).toHaveClass(/active/)

    // The edited review-panel.ts / index.ts bundle mounted the panel — proof
    // #283's reset()/isProjectSwitch wiring didn't break the module's boot.
    await expect(window.locator('.fl-review')).toBeAttached()

    // With no active project, refresh() calls setGroups([]) → the panel renders
    // its "No project open" empty state. This is the render path #283's
    // reset() feeds into after a project switch clears the drafts.
    await expect(window.locator('.fl-review-empty')).toBeAttached()
    await expect(window.locator('.fl-review-empty')).toContainText('No project open')
  })
})
