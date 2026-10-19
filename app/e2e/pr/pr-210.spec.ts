import { test, expect } from '../fixtures/electron'
import { sel, statusButtonByText } from '../selectors'

/**
 * Regression for PR #210 — "cap the pre-attach output buffer so unopened tabs
 * can't leak memory (#208)".
 *
 * `terminal:data` is broadcast for EVERY live terminal, but a tab's xterm is
 * only created on first activation. Output for a tab that's never opened (agent
 * `⚙` tabs the user never clicks are the common case) piled into an uncapped
 * `string[]` (`tab.pending` / the sibling `orphanData` map) forever, leaking
 * renderer memory over a long session. #210 replaces the raw arrays with a
 * char-bounded `PendingBuffer` (~256 KB) that evicts the oldest chunks past the
 * cap, and drops an orphan's buffer on `terminal:exit` if it never got a tab.
 * On attach, the buffered chunks are consumed via `tab.pending.drain()`.
 *
 * The eviction/cap behavior needs >256 KB of pre-attach output on an UNOPENED
 * tab to observe (the truncation marker) — not drivable from a fresh launch,
 * and fully covered by the pure `pending-buffer` unit suite. What IS observable
 * headlessly is the integration the swap could break: the terminal still opens
 * and its xterm attaches, running the reworked `attachXterm` → `pending.drain()`
 * path. A broken `PendingBuffer` import/drain would leave the terminal surface
 * unmounted. This spec guards that the string[]→PendingBuffer swap didn't
 * regress terminal reveal + attach.
 */
test.describe('PR #210 — terminal opens/attaches after pending-buffer cap', () => {
  test('revealing the terminal mounts a live xterm surface (drain-on-attach path)', async ({
    window,
  }) => {
    await expect(window.locator(sel.shell)).toBeVisible()

    const toggle = window.locator(statusButtonByText('Terminal'))
    // Post-#674 the terminal panel starts VISIBLE. Close and reopen it so the
    // reveal path below is the one a user drives, not the boot default.
    await expect(window.locator(sel.terminalRoot)).toBeVisible()
    await toggle.click()
    await expect(window.locator(sel.terminalRoot)).toBeHidden()

    await toggle.click()
    await expect(window.locator(sel.terminalRoot)).toBeVisible()

    // Auto-start spawns a terminal → addTab (now seeds `new PendingBuffer()`) →
    // activateTab → attachXterm, which calls `tab.pending.drain()` and mounts
    // the xterm. The `.xterm` surface appearing proves that reworked attach path
    // ran to completion post-#208.
    await expect(window.locator(`${sel.terminalRoot} .xterm`).first()).toBeVisible({
      timeout: 15000,
    })
  })

  test('the terminal still toggles closed after the buffer rework', async ({ window }) => {
    const toggle = window.locator(statusButtonByText('Terminal'))
    // Starts visible (post-#674 default); one press closes it, the next reopens it.
    await expect(window.locator(sel.terminalRoot)).toBeVisible()
    await toggle.click()
    await expect(window.locator(sel.terminalRoot)).toBeHidden()
    await toggle.click()
    await expect(window.locator(sel.terminalRoot)).toBeVisible()
  })
})
