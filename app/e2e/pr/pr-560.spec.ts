import { test, expect } from '../fixtures/electron'
import { sel } from '../selectors'

/**
 * Regression for PR #560 — "AI merge conflict resolution — trust-and-audit
 * resolver in Source Control".
 *
 * #560 substantially rewired the Source Control panel (`git-panel.ts`): it added
 * per-conflict risk badges (`.gp-risk-badge`), a section-level "Resolve all with
 * AI" control, use-ours/use-theirs + open-merge row actions, and a
 * merge/rebase-in-progress banner with Complete/Abort. It also added a whole new
 * conflict-resolution renderer bundle (`conflict-resolve-index.ts`,
 * `conflict-merge-editor.ts`, `conflict-proposal.ts`) wired into the git module.
 *
 * The actual resolve flow needs a real conflicted git working tree in an added
 * project — which a fresh, credential-less E2E launch can't reach (the git panel
 * shows "No project open" until a project is added, and "Open Folder…" opens a
 * native OS folder picker Playwright can't drive; see e2e/README.md "Known
 * gate"). The trust-and-audit logic itself — structural triage downgrade-only
 * invariant, proposal parse/gate (synthesized-held, malformed→hold), risk badge,
 * merge banner, verify command-resolution, and summary byte-determinism — is
 * covered by the feature's 72 unit tests.
 *
 * What IS observable headlessly — and what this spec guards — is that the git
 * renderer module still boots and mounts after #560's rewire. If any of the new
 * imports or the panel rewrite had broken the git bundle, `initGit` would throw
 * and the Source Control side tab would never surface `.gp-root` — leaving every
 * user's Source Control panel dead, not just those with conflicts. Switching to
 * the Git tab and asserting the panel root + its project-less empty state guards
 * that the wiring stayed intact.
 */
test.describe('PR #560 — AI conflict resolver rewire (Source Control panel still boots)', () => {
  test('the Source Control panel still mounts its root + empty state after the #560 rewire', async ({
    window,
  }) => {
    // Renderer booted with the reworked git module (risk badges, Resolve-all,
    // merge banner, and the new conflict-resolve bundle all wired into initGit).
    await expect(window.locator(sel.shell)).toBeVisible()

    // Switch to the Source Control tab — mounts the git panel surface. If #560's
    // rewire had broken the git bundle, initGit would throw and the panel root
    // below would never appear.
    const gitTab = window.locator('[data-rail-item="source-control"]')
    await gitTab.click()
    await expect(gitTab).toHaveClass(/active/)

    // The git panel mounted its root, and on a project-less launch shows the
    // "No project open" empty state (not a crash / blank body) — proving the
    // conflict-resolver rewire didn't break the panel's normal render path.
    await expect(window.locator(sel.gitPanelRoot)).toBeAttached()
    await expect(window.locator(sel.gitPanelEmpty)).toContainText('No project open')

    // Renderer stayed alive through the tab switch (no uncaught error from the
    // new conflict-resolution wiring).
    await expect(window.locator(sel.shell)).toBeVisible()
  })
})
