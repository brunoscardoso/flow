import { test, expect } from '../fixtures/electron'
import { sel } from '../selectors'

/**
 * Regression for PR #238 — "preserve scroll + expanded tool cards across the
 * post-turn reconcile (#179)".
 *
 * Every completed agent turn ran `#onStream` `done` → `#reconcile` →
 * `#loadHistory`, which does `this.#feed.textContent = ''` (resetting
 * `scrollTop` to 0) and rebuilds every `ToolCard` from scratch (each starts
 * collapsed). A reader who had scrolled up to re-read earlier messages was
 * yanked to the top the instant the turn finished, and any tool card they had
 * expanded silently snapped shut. #238:
 *   - captures bottom-pin state + `scrollTop` and the set of expanded tool-call
 *     ids BEFORE the rebuild, then restores them AFTER — expanding cards first
 *     (via the new `ToolCard.setExpanded()` / `expanded` getter) so the
 *     restored `scrollTop` is measured against the final content height;
 *   - isolates the restore target in a pure, unit-tested `reconcileScrollTop`
 *     (pinned → bottom; scrolled-up → clamped previous position; never
 *     negative), imported at module scope by `conversation-pane.ts`.
 *
 * The reconcile path itself needs a **project + Claude account** to run an agent
 * turn (sending a message is out of reach for a fresh, credential-less launch —
 * see e2e/README.md "Known gate"), and the scroll math is fully covered by
 * `conversation-scroll.test.ts`. This spec guards the headlessly-observable
 * half: `conversation-pane.ts` now imports `reconcileScrollTop` from the new
 * `./conversation-scroll` module at module scope, so a broken/renamed export
 * would crash the threads bundle and the conversation surface would never mount.
 * The conversation pane rendering its first-run empty state proves that import
 * chain — and the `ToolCard` API refactor it depends on — resolved intact.
 */
test.describe('PR #238 — conversation preserves scroll + expanded cards (import intact)', () => {
  test('mounts the conversation empty state (conversation-scroll import resolved)', async ({
    window,
  }) => {
    // Conversation pane mounted — proof conversation-pane.ts's module-scope
    // `import { reconcileScrollTop } from './conversation-scroll'` resolved and
    // the pane constructed without throwing.
    await expect(window.locator(sel.conversation)).toBeAttached()
    await expect(window.locator('.fl-conv-empty')).toBeAttached()

    // Composer is mounted but hidden with no active thread (the reconcile that
    // #238 fixes only runs once a turn completes on an active thread).
    const composer = window.locator(sel.composer)
    await expect(composer).toBeAttached()
    await expect(composer).toBeHidden()

    // No tool cards on a fresh launch (no turn has run) — a clean pane proves
    // the ToolCard setExpanded/expanded refactor didn't break the card build.
    await expect(window.locator('.fl-conv-entry-tool')).toHaveCount(0)
  })
})
