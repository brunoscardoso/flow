import { test, expect } from '../fixtures/electron'
import { sel } from '../selectors'

/**
 * Regression for PR #248 — "per-message model badge (#129)".
 *
 * Model routing was live but invisible: a user couldn't tell which model
 * produced a given reply, and the `messages` table didn't record it. #248 adds a
 * per-message model badge, on by default and persisted:
 *   - migration v14 adds an additive, nullable `messages.model` column;
 *   - `ThreadStore.appendMessage` round-trips an optional `model`, and
 *     `StreamBridge` persists the Anthropic assistant message's own
 *     `message.message.model` (accurate even for an 'auto'/routed session);
 *   - `ConversationPane.#assistantContent` renders a small muted badge
 *     (`.fl-conv-model-badge`, label via `modelLabel`) under each assistant
 *     message whenever a model was recorded — older messages have none.
 *
 * The badge only paints once a real assistant message carrying a model exists,
 * which needs a **project + Claude account + a completed agent turn** — out of
 * range for a fresh, credential-less launch (see e2e/README.md "Known gate").
 * That round-trip is covered by unit tests: the store's "records the model that
 * produced an assistant message and returns it (#129)" test and the pure
 * `modelLabel` tests ("Opus 4.8" / "Sonnet 5" / "Haiku 4.5", raw id passthrough).
 *
 * What IS observable on a fresh launch — and what this spec guards — is that the
 * reworked conversation module still boots AND that its badge styling shipped in
 * the bundle. `ConversationPane`'s constructor calls `injectConversationStyles()`
 * (which now injects the `.fl-conv-model-badge` rule), and `#assistantContent`
 * is the render path the badge lives in. If #248's edit to `conversation-pane.ts`
 * had broken the bundle, the conversation surface would never mount and the badge
 * CSS would never be injected. Asserting the conversation empty state + the
 * presence of the injected badge rule proves that edit is live end-to-end.
 */
test.describe('PR #248 — per-message model badge (conversation module + badge CSS live)', () => {
  test('conversation mounts and the #129 badge style shipped in the bundle', async ({
    window,
  }) => {
    // Thread UI + conversation empty state mounted — proof the edited
    // conversation-pane.ts bundle loaded and its constructor ran (which is what
    // injects the badge styles) without throwing.
    await expect(window.locator(sel.threadSidebar)).toBeAttached()
    await expect(window.locator(sel.conversation)).toBeAttached()
    await expect(window.locator('.fl-conv-empty')).toBeAttached()

    // The composer is mounted but hidden with no active thread — the badge only
    // renders against a persisted assistant message an active thread produces.
    const composer = window.locator(sel.composer)
    await expect(composer).toBeAttached()
    await expect(composer).toBeHidden()

    // The per-message badge rule (`.fl-conv-model-badge`, #129) was injected into
    // a document stylesheet by injectConversationStyles() — proof the badge
    // render path shipped in this bundle, not just the pre-#248 conversation CSS.
    const badgeRulePresent = await window.evaluate(() => {
      for (const sheet of Array.from(document.styleSheets)) {
        let rules: CSSRuleList
        try {
          rules = sheet.cssRules
        } catch {
          continue // cross-origin sheet — skip
        }
        for (const rule of Array.from(rules)) {
          if (rule.cssText.includes('fl-conv-model-badge')) return true
        }
      }
      return false
    })
    expect(badgeRulePresent).toBe(true)
  })
})
