import { test, expect } from '../fixtures/electron'
import { sel } from '../selectors'

/**
 * Regression for PR #406 — "show a multi-question AskTool card as a carousel (#400)".
 *
 * A multi-question AskUserQuestion is now shown ONE question at a time with a
 * `‹ Back` / `i of N` / `Next ›` pager (`.fl-qcard-pager`), instead of a stacked
 * list. To wire this, `question-card.ts` gained a new `import { carouselView,
 * clampIndex } from './question-carousel'` and a `#renderCarousel()` path; a CSS
 * `.fl-qcard-q[hidden]{display:none}` rule hides off-screen questions.
 *
 * The card + its pager only appear during a live agent turn (the agent calls
 * AskUserQuestion), which needs a project + a Claude account + a running session
 * — out of range for a fresh, credential-less launch (see e2e/README.md "Known
 * gate"). The pager/clamp logic itself is fully unit-tested in
 * `question-carousel.test.ts` (single-question → no pager, multi-question edges,
 * out-of-range clamp).
 *
 * What IS observable on a fresh launch — and what this spec guards — is that the
 * threads/conversation bundle still boots after #406's edits. `question-card.ts`
 * now imports the new `./question-carousel` module and `conversation-pane.ts`
 * imports `QuestionCard`; if the new import or the added carousel render code had
 * broken the bundle, the conversation module would never mount. Asserting the
 * conversation empty state proves the edited bundle loaded and ran end-to-end
 * without throwing. No card (and therefore no pager) leaks into a thread-less
 * conversation.
 */
test.describe('PR #406 — multi-question carousel (threads module boots after the fix)', () => {
  test('the conversation mounts its empty state after the carousel rewire', async ({
    window,
  }) => {
    // Conversation pane mounted — proof the edited question-card.ts (new
    // ./question-carousel import + #renderCarousel path) + conversation-pane.ts
    // bundle loaded and ran their module code without throwing.
    await expect(window.locator(sel.conversation)).toBeAttached()
    await expect(window.locator('.fl-conv-empty')).toBeAttached()

    // No QuestionCard — and therefore no carousel pager — is present with no
    // active thread. The carousel path #406 added only runs during a live agent
    // turn the fresh launch can't create.
    await expect(window.locator('.fl-qcard')).toHaveCount(0)
    await expect(window.locator('.fl-qcard-pager')).toHaveCount(0)
  })
})
