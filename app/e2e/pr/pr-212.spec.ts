import { test, expect } from '../fixtures/electron'
import { sel } from '../selectors'

/**
 * Regression for PR #212 — "toast on terminal create/attach failure instead of
 * a silent dead click (#209)".
 *
 * Terminal create/attach failures were swallowed to `console.error` only. When
 * `api.terminal.create` rejected (PTY spawn fails, shell missing, project root
 * gone), clicking + (or ⌘/Ctrl+Shift+`) did nothing visible — no toast, no error
 * state, no terminal — a silent dead click (forbidden pattern #2). The git panel
 * (#192) and editor (#195/#196) already fixed this class; the terminal panel
 * never used `flow:notify`. #212 adds pure `terminalCreateFailedToast(error)` /
 * `terminalAttachFailedToast(error)` builders (new `terminal-feedback.ts`) and a
 * `notify()` helper in `terminal-panel.ts` that dispatches a `flow:notify` error
 * toast (kind `state-change`) via the NotificationCenter bridge on each catch.
 *
 * Triggering a real create/attach failure needs a project + a failing PTY spawn
 * — none drivable from a fresh, credential-less launch (see e2e/README.md "Known
 * gate"); the toast COPY is covered by the pure `terminal-feedback` unit suite.
 * This spec guards the delivered mechanism end-to-end: dispatching the EXACT
 * `flow:notify` event `notify()` emits for a failed create (state-change / error,
 * with the copy `terminalCreateFailedToast(new Error('shell missing'))` builds)
 * surfaces a real `.fl-flow-toast` card with that title + error body. If the
 * NotificationCenter bridge weren't wired for state-change error notifications
 * the fix would stay a silent no-op even once the catch fires.
 */
test.describe('PR #212 — terminal create/attach failure toast', () => {
  test('shell boots (terminal bundle rewire did not crash the renderer)', async ({
    window,
  }) => {
    // A broken `terminal-feedback` import would throw when terminal-panel.ts is
    // evaluated and could take the renderer down; the shell still renders.
    await expect(window.locator(sel.shell)).toBeVisible()
  })

  test('a terminal-create failure notification surfaces a toast via the flow:notify bridge', async ({
    window,
  }) => {
    // Emit the exact event `notify()` dispatches for a failed create, carrying
    // the exact title/body `terminalCreateFailedToast(new Error('shell missing'))`
    // builds ("Couldn't open terminal" / "shell missing") at error level.
    await window.evaluate(() => {
      document.dispatchEvent(
        new CustomEvent('flow:notify', {
          detail: {
            kind: 'state-change',
            rootId: '/tmp/qa-pr-212',
            title: "Couldn't open terminal",
            body: 'shell missing',
            timestamp: new Date().toISOString(),
            level: 'error',
          },
        }),
      )
    })

    const toast = window
      .locator('.fl-flow-toast')
      .filter({ hasText: "Couldn't open terminal" })
    await expect(toast).toHaveCount(1)
    await expect(toast.locator('.fl-flow-title')).toHaveText("Couldn't open terminal")
    await expect(toast.locator('.fl-flow-toast-body')).toHaveText('shell missing')
  })
})
