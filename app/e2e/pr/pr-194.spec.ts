import { test, expect } from '../fixtures/electron'
import { sel } from '../selectors'

/**
 * Regression for PR #194 — "close diff overlay on project switch / root removal
 * (#191)".
 *
 * The Git panel is scoped to the ACTIVE project (ADR-002), but the diff overlay
 * it opens over the editor was only ever *shown*, never *hidden* on a project
 * switch or root removal — so a diff opened in project A stayed on screen (as if
 * it belonged to B) after switching to B, or lingered after A's root was
 * removed. #194 tracks the diff's owning root (`diffRoot`) and closes it via the
 * pure `shouldCloseDiff(diffRoot, focusRoot, aliveRoots)` predicate, called from
 * `setActiveRoot` (project switch) and `syncRoots` (root removal).
 *
 * The stale-close itself needs two projects (or a removable root) + a real
 * open diff to fire, none of which is drivable from a fresh, credential-less
 * launch (see e2e/README.md "Known gate"). The close-decision is fully covered
 * by the pure `shouldCloseDiff` unit tests. What IS observable headlessly is
 * that the reworked `initGit` bundle — which now imports `shouldCloseDiff` from
 * the new `diff-lifecycle.ts` and adds the `diffRoot`/`closeDiff`/
 * `closeStaleDiff` wiring — still mounts and renders. A broken export/import
 * would throw at boot and leave the Git panel body empty. This guards that
 * wiring.
 *
 * NOTE: the Git panel currently has NO UI trigger — its `flow:show-git` reveal
 * event is never dispatched by any button (tracked in issue #198). Until that
 * is fixed, this spec reveals the panel by dispatching the app's own documented
 * reveal event, then asserts the panel rendered.
 */
test.describe('PR #194 — close diff overlay on project switch / root removal', () => {
  test('Git panel bundle still mounts and renders after the diff-lifecycle rewire', async ({
    window,
  }) => {
    // Renderer booted with the reworked initGit (new diff-lifecycle import + wiring).
    await expect(window.locator(sel.shell)).toBeVisible()

    // Reveal the Git side-panel body via the app's documented reveal event
    // (there is no button for it yet — issue #198). initGit renders into this
    // body at boot; a broken diff-lifecycle import would have crashed that render.
    await window.evaluate(() => {
      document.dispatchEvent(new CustomEvent('flow:show-git'))
    })

    // With no project/roots on a fresh launch, the Git panel renders its empty
    // state — proof that initGit's reworked bundle mounted and its render path
    // (which the #194 diffRoot/closeStaleDiff changes live alongside) executed
    // cleanly.
    const gitEmpty = window.locator('.gp-empty')
    await expect(gitEmpty.first()).toBeVisible()
    await expect(gitEmpty.first()).toContainText('No project open')
    await expect(gitEmpty.first().locator('fl-button', { hasText: 'Open Folder' })).toBeVisible()

    // Renderer stayed alive through the reveal.
    await expect(window.locator(sel.shell)).toBeVisible()
  })
})
