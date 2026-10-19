import { test, expect } from '../fixtures/electron'
import { sel } from '../selectors'

/**
 * Regression for PR #287 — "surface a failed AskUserQuestion submit instead of
 * locking to 'Answered' (#278)".
 *
 * The inline QuestionCard used to set its terminal UI ("Answered", disabled,
 * `#done = true`, `fl-qcard-answered`) BEFORE awaiting `threads:respondDialog`
 * and never caught a rejection — so a failed submit left the card lying
 * "Answered" while the agent stayed parked with no feedback (forbidden-pattern
 * #2). #287 locks optimistically ("Sending…"), commits "Answered" only after the
 * send resolves, and on rejection rolls back (`#done = false`, Submit restored,
 * inline `role="alert"` "Failed to send — …" line) so the user can retry. The
 * failure message is the pure, unit-tested `submitFailureMessage`.
 *
 * The card + its submit path only appear during a live agent turn (the agent
 * calls AskUserQuestion), which needs a project + a Claude account + a running
 * session — out of range for a fresh, credential-less launch (see e2e/README.md
 * "Known gate"). The message decision is fully unit-tested (`question-submit`:
 * names an Error, passes a string reason through, degrades an opaque value to
 * "Unknown error").
 *
 * NOTE (issue #290): even after #287, a crashed/torn-down session resolves the
 * parked dialog silently, so a later Submit still shows "Answered" — that
 * residual gap is tracked separately and isn't observable from a fresh launch.
 *
 * What IS observable on a fresh launch — and what this spec guards — is that the
 * threads bundle still boots after #287's edits. `question-card.ts` now imports
 * the new `./question-submit` module and `conversation-pane.ts` imports
 * `QuestionCard`; if either edit had broken the bundle, the conversation module
 * would never mount. Asserting the conversation empty state proves the edited
 * bundle loaded and ran end-to-end without throwing.
 */
test.describe('PR #287 — question-card submit failure (threads module boots after the fix)', () => {
  test('the conversation mounts its empty state after the reworked question-card edits', async ({
    window,
  }) => {
    // Conversation pane mounted — proof the edited question-card.ts (new
    // ./question-submit import) + conversation-pane.ts bundle loaded and ran
    // their module code without throwing.
    await expect(window.locator(sel.conversation)).toBeAttached()
    await expect(window.locator('.fl-conv-empty')).toBeAttached()

    // No QuestionCard is present with no active thread — the submit path #287
    // reworked (optimistic "Sending…" → rollback + inline error on failure) only
    // runs during a live agent turn the fresh launch can't create.
    await expect(window.locator('.fl-qcard')).toHaveCount(0)
  })
})
