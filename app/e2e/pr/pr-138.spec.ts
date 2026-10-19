import { test, expect } from '../fixtures/electron'
import { sel } from '../selectors'

/**
 * Regression for PR #138 — "stable, accurate label for the top new-thread +
 * button" (closes #131). PR #123 had renamed the top toolbar `+` to promise a
 * cross-project chooser ("New thread across projects" / tooltip "choose one or
 * more projects") even for the common 0- and 1-project cases, where that
 * chooser never appears (it's gated on `roots.length >= 2`).
 *
 * PR #138's fix: the **aria-label is the stable, always-accurate "New thread"**
 * (screen readers never hear a cross-project promise that isn't shown), and the
 * multi-project wording lives ONLY in the **tooltip**, re-derived on rootsChanged
 * and initial load, and only when 2+ projects are open.
 *
 * The 2+-project tooltip needs seeded projects to exercise, and adding a project
 * goes through the native OS folder picker Playwright can't drive on a fresh
 * launch (see e2e/README.md "Known gate"); that path is covered by the sidebar
 * unit tests. What IS observable headlessly — and what this spec guards — is the
 * **0-project** case #131 reported: with no projects open, the top "+" must NOT
 * promise a cross-project chooser in either its aria-label or its tooltip.
 *
 * (The stable aria-label + no-crash fast-path click are pinned by pr-123.spec.ts;
 * this spec adds the distinct tooltip-accuracy guard.)
 */
test.describe('PR #138 — accurate top new-thread label at 0/1 projects', () => {
  test('the top "+" tooltip does not promise a cross-project chooser with 0 projects', async ({
    window,
  }) => {
    const topPlus = window.locator(sel.newThread)
    await expect(topPlus).toBeVisible()

    // With zero projects the chooser can never appear, so neither the accessible
    // name nor the tooltip may mention choosing across projects (#131).
    await expect(topPlus).toHaveAttribute('aria-label', 'New thread')
    await expect(topPlus).toHaveAttribute('title', 'New thread')
  })
})
