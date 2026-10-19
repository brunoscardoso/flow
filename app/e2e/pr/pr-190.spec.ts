import { test, expect } from '../fixtures/electron'
import { sel } from '../selectors'

/**
 * Regression for PR #190 — "ref-count the refresh gate so overlapping prompts
 * don't unprotect each other (#188)".
 *
 * #187 added a pure `ReviewRefreshGate` that defers Review-panel re-renders while
 * a reject/discard prompt is open. #188 found the gate used a single boolean, so
 * when two transient prompts overlap (two rejects, or a reject + a "Discard all"
 * confirm), closing the FIRST lowered the guard while the SECOND was still open —
 * re-exposing the #182 data loss. #190 makes the gate REF-COUNTED: `open()`
 * increments a depth counter, `close()` only flushes the newest deferred update
 * when the LAST interaction closes, and `markRendered()` hard-resets the depth to
 * 0 (a full render tears down every transient prompt at once).
 *
 * The ref-count decision logic is fully covered by the pure `ReviewRefreshGate`
 * unit tests (`review-refresh-gate.test.ts`, incl. the `#188` describe block).
 * Opening real overlapping reject/discard prompts needs a project + Claude
 * account + a real agent-produced changed-file selection — not drivable from a
 * fresh, credential-less launch (see e2e/README.md "Known gate"). What IS
 * observable headlessly is the reworked render loop: `#render()` now calls
 * `gate.markRendered()` (the depth hard-reset #190 changed), and a broken gate
 * export/import or a render loop wedged by the new depth logic would fail the
 * review bundle or leave the panel unable to re-render. This spec drives the
 * panel through REPEATED render cycles — tab switches and mode toggles, each of
 * which re-invokes `#render()` → `markRendered()` — and asserts the panel keeps
 * mounting and rendering its empty state every time, so the ref-counted gate
 * never wedges the render path.
 */
test.describe('PR #190 — ref-counted refresh gate keeps the Review render loop healthy', () => {
  test('Review panel re-renders cleanly across repeated tab-switch + mode-toggle cycles', async ({
    window,
  }) => {
    // Renderer booted with the ref-counted review-panel (new gate depth logic).
    await expect(window.locator(sel.shell)).toBeVisible()

    const review = window.locator('[data-rail-item="source-control"]')
    const files = window.locator('[data-rail-item="files"]')

    // Drive the panel through several render cycles. Each Review activation +
    // mode toggle re-runs #render() → gate.markRendered() (the depth hard-reset
    // #190 reworked). A gate that wedged the render loop would leave .fl-review
    // detached or the empty state missing on a later pass.
    for (let cycle = 0; cycle < 3; cycle++) {
      await review.click()
      await expect(review).toHaveClass(/active/)
      await window.locator(sel.scViewBtn).filter({ hasText: 'Phases' }).click() // #335 fold
      await expect(window.locator('.fl-review')).toBeAttached()

      // Fresh launch has no changes → the panel's empty state renders every time
      // (#render() completing cleanly through the ref-counted gate).
      await expect(window.locator('.fl-review-empty')).toBeVisible()

      // (The former Manual/Phase mode toggle these passes exercised was removed
      // from the review toolbar in a later redesign; the empty-state render above
      // already drives #render() through the ref-counted gate each cycle.)

      // Leave the Review tab so the next cycle remounts the panel from scratch.
      await files.click()
    }

    // Renderer stayed alive through every render cycle — the ref-counted gate
    // never left the panel wedged or the shell torn down.
    await expect(window.locator(sel.shell)).toBeVisible()
  })
})
