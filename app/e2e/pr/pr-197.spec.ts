import { test, expect } from '../fixtures/electron'
import { sel } from '../selectors'

/**
 * Regression for PR #197 — "toast on diff failure instead of a silent dead
 * click (#192)".
 *
 * Changed-file and commit rows in the Git panel render with `cursor: pointer`
 * and open a diff, but when the `git:diff` IPC call rejected the coordinator
 * only `console.error`'d — a dead click with no visible feedback (forbidden
 * pattern #2). #197 adds pure toast builders (`fileDiffFailedToast` /
 * `commitDiffFailedToast` in the new `git-feedback.ts`) and a `notify()` helper
 * in `initGit` that dispatches them via the `flow:notify` bridge →
 * NotificationCenter, on the existing catch path.
 *
 * The toast itself needs a real project + a changed file + a git:diff failure
 * (e.g. a path deleted at HEAD) to fire — none of which is drivable from a
 * fresh, credential-less launch (see e2e/README.md "Known gate"). The toast
 * content is fully covered by the pure `git-feedback` unit tests. What IS
 * observable headlessly is that the reworked `initGit` bundle — which now
 * imports `git-feedback` (`fileDiffFailedToast`, `commitDiffFailedToast`,
 * `GitToast`) and `FlowNotification` — still mounts and renders. A broken
 * export/import would throw at boot and leave the Git panel body empty. This
 * guards that wiring.
 *
 * NOTE: the Git panel currently has NO UI trigger — its `flow:show-git` reveal
 * event is never dispatched by any button (tracked in issue #198). Until that
 * is fixed, this spec reveals the panel by dispatching the app's own documented
 * reveal event, then asserts the panel rendered.
 */
test.describe('PR #197 — toast on git diff failure', () => {
  test('Git panel bundle still mounts and renders after the git-feedback rewire', async ({
    window,
  }) => {
    // Renderer booted with the reworked initGit (new git-feedback + notify wiring).
    await expect(window.locator(sel.shell)).toBeVisible()

    // Reveal the Git side-panel body via the app's documented reveal event
    // (there is no button for it yet — issue #198). initGit renders into this
    // body at boot; a broken git-feedback import would have crashed that render.
    await window.evaluate(() => {
      document.dispatchEvent(new CustomEvent('flow:show-git'))
    })

    // With no project/roots on a fresh launch, the Git panel renders its empty
    // state — proof that initGit's reworked bundle mounted and its render path
    // (which the #197 notify/import changes live alongside) executed cleanly.
    const gitEmpty = window.locator('.gp-empty')
    await expect(gitEmpty.first()).toBeVisible()
    await expect(gitEmpty.first()).toContainText('No project open')
    await expect(gitEmpty.first().locator('fl-button', { hasText: 'Open Folder' })).toBeVisible()

    // Renderer stayed alive through the reveal.
    await expect(window.locator(sel.shell)).toBeVisible()
  })
})
