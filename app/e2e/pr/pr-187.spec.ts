import { test, expect } from '../fixtures/electron'
import { sel } from '../selectors'

/**
 * Regression for PR #187 — "defer background refresh while a reject/discard
 * prompt is open (#182)".
 *
 * The Review panel re-renders from scratch (`container.textContent = ''`) on
 * every `setGroups`, and the chokidar watcher fires `project:fileChanged` for
 * constant `flow/**` / `.brain.sqlite` writes (heartbeat, brain captures, the
 * agent). Before #187 a passive refresh mid-interaction tore down the inline
 * "Why reject?" prompt (and any typed feedback) or the "Discard all" two-step
 * confirm. #187 adds a pure `ReviewRefreshGate` (new module
 * `review-refresh-gate.ts`, imported into `review-panel.ts`): while a reject /
 * discard interaction is open the gate DEFERS incoming groups updates and
 * flushes only the newest one when the interaction closes, and reject feedback
 * is captured BEFORE the closing re-render.
 *
 * Opening a real reject/discard prompt needs a project + Claude account + a real
 * agent-produced changed-file selection to reject — none of which is drivable
 * from a fresh, credential-less launch (see e2e/README.md "Known gate"). The
 * defer/flush decision logic is fully covered by the pure `ReviewRefreshGate`
 * unit tests. What IS observable headlessly is that the reworked review bundle
 * still loads and mounts: `review-panel.ts` now imports `ReviewRefreshGate` and
 * routes `setGroups` through it, so a broken export/import would fail the review
 * bundle and the Review tab would never surface `.fl-review`. This spec guards
 * that wiring — the Review tab activates, `.fl-review` mounts, the empty state
 * renders, and Manual mode still toggles (exercising the panel `#render()` path
 * the gate now guards) — so the panel keeps rendering through the new gate.
 */
test.describe('PR #187 — defer background refresh while a reject/discard prompt is open', () => {
  test('Review panel still mounts and renders after the ReviewRefreshGate rewire', async ({
    window,
  }) => {
    // Renderer booted with the reworked review-panel (new ReviewRefreshGate import).
    await expect(window.locator(sel.shell)).toBeVisible()

    // Switch to Review — activates the tab and mounts the review surface. A
    // broken gate import would fail the bundle and leave .fl-review unattached.
    const review = window.locator('[data-rail-item="source-control"]')
    await review.click()
    await expect(review).toHaveClass(/active/)
    await window.locator(sel.scViewBtn).filter({ hasText: 'Phases' }).click() // #335 fold
    await expect(window.locator('.fl-review')).toBeAttached()

    // Fresh launch has no changes → the panel's empty state renders (the
    // `#groups.length === 0` branch of the #render() path the gate now guards).
    await expect(window.locator('.fl-review-empty')).toBeVisible()

    // The empty-state render above already exercises #render() end-to-end via the
    // ReviewRefreshGate-guarded setGroups path, confirming the gate rewire didn't
    // break the render loop. (The former Manual-mode toggle was later removed from
    // the review toolbar, so it's no longer the render proxy.)

    // Renderer stayed alive through the tab switch.
    await expect(window.locator(sel.shell)).toBeVisible()
  })
})
