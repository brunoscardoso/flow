import { test, expect } from '../fixtures/electron'
import { sel } from '../selectors'

/**
 * Regression for PR #280 — "roll back composer echo + toast on send failure (#279)".
 *
 * The primary composer optimistically echoes the user's message into the
 * transcript and starts the "Working…" loader, but `#send` discarded the
 * rollback closure `echoUserMessage` returns. When `threads.sendMessage`
 * rejected, `#send` only restored the draft and `console.error`'d — it never
 * removed the phantom "You: …" bubble and never stopped the loader, so the
 * loader spun forever and the message was misrepresented as sent (the same
 * forbidden-pattern-#2 class #180 fixed on the redo path).
 *
 * #280 widens `#onSend` to return `(() => void) | null`, captures the rollback in
 * `#send`, and on a `sendMessage` rejection calls `rollback?.()` (removes the
 * bubble + stops the loader) and dispatches a `flow:notify` error toast built by
 * the new pure `sendFailedToast`.
 *
 * The rollback path only fires on a real send failure, which needs a project + a
 * Claude account + a live thread whose send rejects — out of range for a fresh,
 * credential-less launch (see e2e/README.md "Known gate"). The toast content is
 * fully unit-tested (`sendFailedToast` — "Couldn't send message" / "…wasn't
 * delivered. Try again." at error level).
 *
 * What IS observable on a fresh launch — and what this spec guards — is that the
 * reworked composer still boots after #280's edits to `composer.ts` (the widened
 * `#onSend`/`setOnSend` signature + the new `sendFailedToast` import and failure
 * handler). If those edits had broken the bundle, the composer module would never
 * mount. Asserting the conversation empty state + the mounted-but-gated composer
 * proves the edited bundle loaded and ran without throwing.
 */
test.describe('PR #280 — send-failure rollback (composer module boots after the fix)', () => {
  test('the reworked composer mounts and stays gated with no active thread', async ({
    window,
  }) => {
    // Conversation empty state mounted — proof the edited composer.ts bundle
    // loaded and its module ran without throwing.
    await expect(window.locator(sel.conversation)).toBeAttached()
    await expect(window.locator('.fl-conv-empty')).toBeAttached()

    // The composer is mounted but hidden with no active thread — the send path
    // #280 reworked (optimistic echo → rollback on failure) only runs against an
    // active thread the fresh launch can't create.
    const composer = window.locator(sel.composer)
    await expect(composer).toBeAttached()
    await expect(composer).toBeHidden()
  })
})
