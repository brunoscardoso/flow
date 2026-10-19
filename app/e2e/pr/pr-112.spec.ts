import { test, expect } from '../fixtures/electron'
import { sel } from '../selectors'

/**
 * Regression for PR #112 — "remove duplicate flow:open-thread listener (#100)".
 * `initThreads` had registered `flow:open-thread` TWICE — one unguarded listener
 * for Kanban board cards and one guarded listener for blueprint prompt cards. Both
 * stayed active, so every dispatch ran two concurrent `selectThread` flows (2×
 * `threads.get`, `setThread`/`loadHistory`, `project.setActiveThread`,
 * `flow:active-thread`, `setActiveProject`), and re-opening the already-open thread
 * from a board card reloaded history + re-scrolled. #112 deletes the unguarded
 * listener and keeps the single guarded one, which now serves EVERY source:
 * it early-returns when `detail.threadId === selectedThreadId` and runs once per
 * dispatch.
 *
 * The full open-a-thread flow needs a project + seeded threads + a board/blueprint
 * card to click — behind the E2E "known gate" (see e2e/README.md: opening a real
 * thread needs a project + Claude account). The coordinator is a DOM module with
 * typecheck-only coverage per repo convention. What IS observable headlessly: the
 * reworked threads bundle mounts its first-run state, and dispatching a
 * `flow:open-thread` with an unknown thread id exercises the SINGLE surviving
 * handler — its `!detail?.threadId`/`=== selectedThreadId` guard, the
 * `flow:reveal-sidebar` dispatch, and the `threads.get` → null path — without
 * throwing, selecting a phantom thread, or leaving the shell in a broken state.
 * A syntax/wiring break in #112's consolidation, or a handler that threw on an
 * unresolvable id, would surface here.
 */
test.describe('PR #112 — consolidated single flow:open-thread handler', () => {
  test('threads bundle mounts first-run state and the lone handler no-ops on an unknown thread', async ({
    window,
  }) => {
    // Renderer booted with the reworked threads module.
    await expect(window.locator(sel.shell)).toBeVisible()

    // Thread sidebar + its fresh-launch empty state mount. If #112's
    // consolidation had broken the bundle, neither would attach.
    await expect(window.locator(sel.threadSidebar)).toBeAttached()
    await expect(window.locator(sel.threadEmpty)).toBeAttached()

    // No active thread on a fresh launch → the composer stays mounted-but-gated.
    const composer = window.locator(sel.composer)
    await expect(composer).toBeAttached()
    await expect(composer).toBeHidden()

    // Drive the surviving handler directly: dispatch flow:open-thread for a
    // thread id that doesn't exist. The guard lets it through (id !== the null
    // selection), it dispatches flow:reveal-sidebar and calls threads.get, which
    // resolves null → no selectThread. With the duplicate listener removed this
    // runs exactly once and must not throw.
    await window.evaluate(() => {
      document.dispatchEvent(
        new CustomEvent('flow:open-thread', {
          detail: { threadId: 'pr-112-nonexistent-thread' },
        }),
      )
    })

    // The renderer stayed alive and no phantom thread was selected: the composer
    // is still gated (no active thread) and the empty state is still shown.
    await expect(window.locator(sel.shell)).toBeVisible()
    await expect(composer).toBeHidden()
    await expect(window.locator(sel.threadEmpty)).toBeAttached()
  })
})
