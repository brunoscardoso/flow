import { test, expect } from '../fixtures/electron'
import { sel } from '../selectors'

/**
 * Regression for PR #156 — "Enter sends, Shift/Alt+Enter breaks the line"
 * (closes #139). The composer send/newline chord was inverted to the
 * chat-standard: plain **Enter sends**, **⇧/⌥Enter** inserts a newline
 * (previously ⌘/Ctrl+Enter sent and bare Enter made a newline).
 *
 * The keydown behavior itself needs a live thread (project + Claude account),
 * which a fresh, credential-less E2E launch can't reach — the composer is
 * mounted but hidden until a thread is active (see e2e/README.md "Known gate").
 * The pure `enterKeyIntent()` mapping is unit-tested in
 * `src/renderer/threads/composer-keys.test.ts`.
 *
 * What IS observable headlessly — and what this spec guards — is the
 * user-facing affordance PR #156 shipped: the app must advertise the new chord
 * (⏎ sends, ⇧⏎ breaks the line) and must NOT still tell users the old "⌘⏎ to
 * send" behavior, which would mislead them into the wrong keystroke.
 *
 * WHERE IT SAYS SO MOVED (2026-09-04). It was in the composer's placeholder,
 * which had grown into a four-clause sentence in a box whose job is to look
 * empty; the keys now ride on the Send button's hover text, attached to the
 * control they operate. The guarantee is unchanged and so is this spec's
 * subject — only the element carrying it. Both are in the DOM while the
 * composer is hidden, so this is still assertable on a fresh launch.
 */
test.describe('PR #156 — Enter-to-send composer affordance', () => {
  test('the composer advertises Enter-sends / Shift-Enter-newline', async ({ window }) => {
    // Composer is mounted (hidden until a thread is active), so its controls —
    // and their text — are in the DOM and assertable.
    const textarea = window.locator(`${sel.composerInput} textarea`)
    await expect(textarea).toBeAttached()
    const send = window.locator(`${sel.composer} .fl-composer-actions fl-button`).last()
    await expect(send).toBeAttached()

    const placeholder = (await textarea.getAttribute('placeholder')) ?? ''
    const sendHint = (await send.getAttribute('title')) ?? ''
    const advertised = `${placeholder} ${sendHint}`

    // New chord is advertised: Enter sends, Shift+Enter breaks the line (#139).
    // Read across BOTH controls, so moving it between them is not a regression
    // while losing it from both still is.
    expect(advertised).toContain('⏎')
    expect(sendHint, 'the Send button names the key that sends').toContain('⏎')
    expect(advertised, 'Shift+Enter must still be advertised').toContain('⇧⏎')

    // The old "⌘⏎ to send" hint must be gone — leaving it would tell users the
    // wrong keystroke and hide the new Enter-sends behavior.
    expect(advertised).not.toContain('⌘⏎')
  })
})
