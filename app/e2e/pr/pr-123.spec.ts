import { test, expect } from '../fixtures/electron'
import { sel } from '../selectors'

/**
 * Regression for PR #123 — "per-project + button to add a thread/task without a
 * project picker". The PR added a blue per-project `+` on every project header
 * (opens a scoped "New thread / New task" menu, no chooser) and, on the top
 * toolbar `+`, renamed its `title`/`aria-label` to the multi-project wording
 * ("New thread across projects").
 *
 * The per-project `+` lives on `#renderRow`'s group branch, which only renders
 * with ≥1 open project — and adding a project goes through the native OS folder
 * picker Playwright can't drive on a fresh, credential-less launch (see
 * e2e/README.md "Known gate"). So the scoped per-project menu itself needs
 * seeded projects to exercise (covered by the sidebar unit tests; future E2E
 * work per the runbook). What IS observable headlessly — and what this spec
 * guards — is the top toolbar `+`:
 *
 *   1. It must exist and be findable by its STABLE aria-label "New thread"
 *      (#131 reverted the aria-label to this so screen readers never hear a
 *      cross-project promise that isn't shown; the multi-project wording now
 *      lives only in the tooltip at 2+ projects). This spec pins the label so a
 *      future rename fails loudly here instead of leaking into three specs.
 *   2. Clicking it with **zero** projects must not crash the renderer (the
 *      `fixedRoot`-less `#createThread` fast path) and must not surface the
 *      multi-project chooser (there is nothing to choose across yet).
 */
test.describe('PR #123 — per-project add + renamed top new-thread button', () => {
  test('top "+" is findable by its renamed label and is a no-crash fast path with 0 projects', async ({
    window,
  }) => {
    const topPlus = window.locator(sel.newThread)
    await expect(topPlus).toBeVisible()

    // Zero projects → the fast path, never the multi-project selection popover.
    await topPlus.click()
    await expect(window.locator('text=Projects for this thread')).toHaveCount(0)

    // Renderer stayed alive through the click.
    await expect(window.locator(sel.shell)).toBeVisible()
    await expect(window.locator(sel.threadSidebar)).toBeVisible()
  })

  test('the reworked group-row render path leaves the empty first-run state intact', async ({
    window,
  }) => {
    // Per-project "+" is added inside the group branch; a throw there would take
    // the whole sidebar down. With no projects there are no group rows, so the
    // thread empty state must still show and the shell must stay mounted.
    await expect(window.locator(sel.threadEmpty)).toBeVisible()
    await expect(window.locator(sel.shell)).toBeVisible()
  })
})
