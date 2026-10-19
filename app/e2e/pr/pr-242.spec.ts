import { test, expect } from '../fixtures/electron'
import { sel } from '../selectors'

/**
 * Regression for PR #242 — "roll back the redo bubble + toast when the redo send
 * fails (#180)".
 *
 * The Review "reject → ask the agent to redo" flow (`flow:agent-redo`)
 * optimistically echoed a "I rejected the changes to `<file>` — please redo
 * them" user bubble and then fired `threads.sendMessage`. When that send
 * rejected (session not ready / IPC error / thread busy), the failure was
 * swallowed to `console.error` and the phantom bubble stayed — the transcript
 * showed the user had asked for a redo the agent never received, and (no turn
 * runs to reconcile) it persisted until they switched threads. #242:
 *   - `echoUserMessage` now returns a rollback closure that removes the
 *     optimistic bubble AND stops the loader it started;
 *   - the `flow:agent-redo` handler (in `threads/index.ts`) captures that
 *     rollback and, on send failure, calls it and dispatches a `flow:notify`
 *     error toast naming the file, built by the pure `redoFailedToast`.
 *
 * The failure path itself needs a **project + Claude account + a rejecting send**
 * to reach — out of range for a fresh, credential-less launch (see
 * e2e/README.md "Known gate") — and the toast content is fully covered by
 * `redo-feedback.test.ts`. This spec guards the headlessly-observable half:
 * `threads/index.ts` now imports `redoFailedToast` from the new `./redo-feedback`
 * module at module scope, so a broken/renamed export would crash the threads
 * bundle and the thread UI would never mount. The thread sidebar and
 * conversation empty state rendering on a fresh launch prove that import chain
 * resolved and `initThreads()` wired the `flow:agent-redo` handler intact.
 */
test.describe('PR #242 — redo send-failure rollback + toast (import intact)', () => {
  test('mounts the thread UI (redo-feedback import resolved in initThreads)', async ({
    window,
  }) => {
    // Thread sidebar + conversation mounted — proof threads/index.ts's
    // module-scope `import { redoFailedToast } from './redo-feedback'` resolved
    // and initThreads() ran (registering the flow:agent-redo handler) without
    // throwing.
    await expect(window.locator(sel.threadSidebar)).toBeAttached()
    await expect(window.locator(sel.conversation)).toBeAttached()
    await expect(window.locator('.fl-conv-empty')).toBeAttached()

    // Composer is mounted but hidden with no active thread — the redo flow the
    // #242 fix guards only fires against an active thread's agent.
    const composer = window.locator(sel.composer)
    await expect(composer).toBeAttached()
    await expect(composer).toBeHidden()
  })
})
