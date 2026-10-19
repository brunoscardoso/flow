import { test, expect } from '../fixtures/electron'
import { sel } from '../selectors'

/**
 * Regression for PR #298 — "reject a stale AskUserQuestion submit after a
 * crashed session instead of silently dropping it (#290)".
 *
 * Follow-up to #278/#287. On a crashed/torn-down session `dialogs.disposeThread()`
 * resolves the parked dialog with `null` and deletes it from `pending`, but the
 * inline QuestionCard is never removed. A later Submit used to hit the silent
 * `if (!pending) return` no-op, the IPC handler resolved, and the card flipped to
 * "Answered" — falsely confirming an answer that was thrown away. #298 makes the
 * miss observable: `UserDialogBroker.respond()` returns `boolean`, the
 * `threads:respondDialog` IPC handler throws on a miss, `conversation-pane`
 * re-throws a clean domain message ("the agent session is no longer active"), and
 * `QuestionCard.#submit`'s catch rolls back (Submit restored, selections kept) and
 * shows its inline `role="alert"` "Failed to send — …" line. The happy path is
 * unchanged: a real pending dialog returns `true` and the card commits "Answered".
 *
 * The card + its submit/crash path only appear during a live agent turn (the agent
 * calls AskUserQuestion, then the session is disposed), which needs a project + a
 * Claude account + a running session — out of range for a fresh, credential-less
 * launch (see e2e/README.md "Known gate"). The delivery signal is unit-tested
 * (`dialogs` "respond delivery signal (#290)": true when parked, false for an
 * unknown id, false on a second respond after disposeThread cleared it mid-question).
 *
 * NOTE (issue #301): even after #298 the crash-path error copy is the generic
 * "…Try again." — misleading for a session that's gone for good — and the card has
 * no dismiss control. That residual UX gap is tracked separately and isn't
 * observable from a fresh launch.
 *
 * What IS observable on a fresh launch — and what this spec guards — is that the
 * threads bundle still boots after #298's renderer edits. `conversation-pane.ts`
 * now wraps `respondDialog` in a try/catch that re-throws a domain error; if that
 * edit had broken the bundle, the conversation module would never mount. Asserting
 * the conversation empty state proves the edited bundle loaded and ran end-to-end
 * without throwing.
 */
test.describe('PR #298 — stale question-card submit rejects after a crashed session (threads module boots after the fix)', () => {
  test('the conversation mounts its empty state after the reworked respondDialog wiring', async ({
    window,
  }) => {
    // Conversation pane mounted — proof the edited conversation-pane.ts
    // (try/catch around respondDialog re-throwing a domain error) bundle loaded
    // and ran its module code without throwing.
    await expect(window.locator(sel.conversation)).toBeAttached()
    await expect(window.locator('.fl-conv-empty')).toBeAttached()

    // No QuestionCard is present with no active thread — the crash/rollback path
    // #298 reworked (respond() miss → IPC throw → inline "Failed to send" error)
    // only runs during a live agent turn the fresh launch can't create.
    await expect(window.locator('.fl-qcard')).toHaveCount(0)
  })
})
