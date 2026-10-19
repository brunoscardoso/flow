import { test, expect } from '../fixtures/electron'
import { sel } from '../selectors'

/**
 * Regression for PR #63 — "multi-project threads (#45)". The New-Thread flow
 * gained a multi-project picker popover ("Projects for this thread"), but it
 * must ONLY appear with 2+ open projects — the PR's stated invariant is that a
 * single project keeps the one-click fast path. A fresh, credential-less launch
 * has zero projects, so clicking New thread must NOT surface that picker.
 *
 * This guards the gating condition (`this.#roots.length >= 2`) in
 * thread-sidebar's `#createThread`: a regression that showed the picker for the
 * 0/1-project case would trap a first-run user behind an empty popover. Driving
 * the true 2+-project multi-select needs seeded projects (the native "Add
 * project" OS picker isn't reachable headlessly — see e2e/README.md "Known
 * gate"); the picker's pure helpers (splitRoots/badgeLabel) are unit-tested.
 */
test.describe('PR #63 — multi-project thread picker gating', () => {
  /** The picker is a bespoke overlay identified by its heading copy. */
  const pickerHeading = 'text=Projects for this thread'

  test('New thread with <2 projects does not show the multi-project picker', async ({ window }) => {
    const btn = window.locator(sel.newThread)
    await expect(btn).toBeVisible()

    // Fresh launch = zero projects → the fast path, never the picker popover.
    await btn.click()

    await expect(window.locator(pickerHeading)).toHaveCount(0)
    // Renderer stayed alive (the click must not throw with no project).
    await expect(window.locator(sel.shell)).toBeVisible()
  })
})
