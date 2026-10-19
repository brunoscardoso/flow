import { test, expect } from '../fixtures/electron'
import { sel } from '../selectors'

/**
 * Regression for PR #97 — "flatten project header — remove weird border, clearer
 * collapse state". The project **header row** (`#renderRow` group branch in
 * thread-sidebar.ts) was reworked: the boxed `surface-raised` band + inset accent
 * bar from #71 became a flat, VS Code-style section row, and the trailing
 * indicators now show a thread count only when COLLAPSED plus an accent dot for
 * the active project.
 *
 * Those header rows only render with ≥1 open project (each `group` row is a
 * project), and adding a project goes through the native OS folder picker that
 * Playwright can't drive on a fresh, credential-less launch (see
 * e2e/README.md "Known gate"). So this spec guards what IS observable headlessly:
 * the reworked render path must not crash the thread sidebar, and the empty,
 * project-less first-run state must stay intact (no stray header band, the
 * "no threads yet" empty state still shows). A regression that threw inside the
 * group-row branch would take the whole sidebar down with it. The trailing-
 * indicator logic (count-when-collapsed, active dot) is pure per-row markup and
 * is covered by the sidebar's unit tests; driving the real styled header needs
 * seeded projects (future work — see the runbook).
 */
test.describe('PR #97 — flattened project header render path', () => {
  test('thread sidebar renders cleanly with no projects (empty first-run state)', async ({
    window,
  }) => {
    // The reworked #renderRow must not break the sidebar mount.
    await expect(window.locator(sel.threadSidebar)).toBeVisible()

    // Fresh launch = zero projects → no group header rows, and the thread empty
    // state is shown. A crash in the group branch would collapse both.
    await expect(window.locator(sel.threadEmpty)).toBeVisible()

    // Renderer stayed alive.
    await expect(window.locator(sel.shell)).toBeVisible()
  })
})
