import { test, expect } from '../fixtures/electron'
import { sel } from '../selectors'

/**
 * Regression for PR #200 — "toast on cmd+S save failure instead of silent
 * swallow (#195)".
 *
 * A cmd/ctrl+S save whose `project:writeFile` rejected (permission denied,
 * read-only mount, ENOSPC, path became a directory) used to be swallowed to the
 * console: `saveFile` `console.error`'d and rethrew, and the keydown handler
 * caught and dropped it. The tab kept its dirty dot — indistinguishable from
 * ordinary unsaved edits — so a user could close the file or quit believing the
 * change was on disk when it never hit disk (a silent data-loss trap, forbidden
 * pattern #2). #200 adds a pure toast builder (`saveFailedToast` /`errorText` in
 * the new `editor-feedback.ts`) and dispatches it from `saveFile`'s catch via
 * the `flow:notify` bridge → NotificationCenter, keeping the buffer dirty (it
 * still rethrows, so nothing typed is lost).
 *
 * The toast itself needs a real project + an open dirty file + a
 * `project:writeFile` failure to fire — none of which is drivable from a
 * fresh, credential-less launch (see e2e/README.md "Known gate"). The toast
 * content is fully covered by the pure `editor-feedback` unit tests. What IS
 * observable headlessly is that the reworked editor bundle — which now imports
 * `saveFailedToast` from the new `editor-feedback.ts` and dispatches a
 * `FlowNotification` on the save-failure catch path — still initializes and
 * mounts. A broken export/import would throw inside `initEditor` at boot and
 * take the whole renderer down, so the shell (and the editor panel it mounts)
 * would never render. This spec guards that wiring.
 */
test.describe('PR #200 — toast on cmd+S save failure', () => {
  test('editor bundle still mounts after the editor-feedback rewire', async ({ window }) => {
    // Renderer booted with the reworked initEditor (new editor-feedback import +
    // save-failure notify wiring). A broken import would have crashed boot.
    await expect(window.locator(sel.shell)).toBeVisible()

    // The editor surface itself mounted — proof initEditor ran to completion and
    // resolved its `editor-feedback` import (the file the #200 save-failure
    // toast dispatch lives alongside).
    await expect(window.locator('#fl-panel-editor')).toBeVisible()

    // Renderer stayed alive through boot.
    await expect(window.locator(sel.shell)).toBeVisible()
  })
})
