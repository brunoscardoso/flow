import { test, expect } from '../fixtures/electron'
import { sel } from '../selectors'

/**
 * Regression for PR #113 — "don't wipe a follow-up sent as the turn ended (#101)".
 * Sending a follow-up the instant a turn finished intermittently produced a
 * blank/frozen pane: on stream `done`, `#reconcile` runs `#clearLive()` then
 * `await #loadHistory()`, and the composer allows sending during that load
 * window. The freshly-echoed user bubble and the new turn's stream node were not
 * guarded, so `#loadHistory`'s `#feed.textContent = ''` wiped them — leaving no
 * bubble, no streaming text, no loader. #113 adds a `#liveDuringLoad` flag:
 * `echoUserMessage` and the message-start/delta appends set it while
 * `#historyLoading`, and `#loadHistory` then skips its feed wipe + re-render so
 * the live nodes survive; the flag is reset at the start of each load.
 *
 * The bug only manifests with a live agent turn: a real send (echo), a `done`
 * event that kicks off a reconcile, and a second send landing inside the load
 * window — all of which need a project + Claude account + precise timing, none
 * drivable from a fresh, credential-less launch (see e2e/README.md "Known gate":
 * sending a message / agent runs are behind a project + Claude account). The
 * flag/skip logic itself is a DOM coordinator with typecheck-only coverage per
 * repo convention. What IS observable headlessly is that the reworked
 * conversation-pane bundle — with the new `#liveDuringLoad` branches threaded
 * through `echoUserMessage`, `#loadHistory`, and `#onStream` — still loads and
 * mounts its first-run state cleanly. A syntax/wiring break in #113 would fail
 * the renderer bundle and neither the conversation surface nor its empty state
 * would mount; this guards that.
 */
test.describe('PR #113 — follow-up-at-turn-end pane wiring', () => {
  test('conversation pane still mounts its first-run state after the #liveDuringLoad rework', async ({
    window,
  }) => {
    // Renderer booted with the reworked conversation-pane module.
    await expect(window.locator(sel.shell)).toBeVisible()

    // The conversation surface and its empty state mount. If #113's new
    // #liveDuringLoad branches had broken the bundle, neither would attach.
    await expect(window.locator(sel.conversation)).toBeAttached()
    await expect(window.locator('.fl-conv-empty')).toBeAttached()

    // No active thread on a fresh launch → the composer stays mounted-but-gated,
    // exactly as before the fix (the send path that echoes into the load window
    // is unreachable until a thread is active).
    const composer = window.locator(sel.composer)
    await expect(composer).toBeAttached()
    await expect(composer).toBeHidden()

    // Renderer stayed alive.
    await expect(window.locator(sel.shell)).toBeVisible()
  })
})
