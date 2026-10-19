import { test, expect } from './fixtures/electron'
import { sel, statusButtonByText } from './selectors'

/**
 * Blueprint: the status-bar Blueprint button opens the editor-area Blueprint
 * tab (the derived structure board). Asserts the view mounts on demand.
 *
 * The board opens as an editor VIEW (blueprint/index.ts `openBlueprintTab` →
 * `editorApi.openView`), so before the click its root is not in the document at
 * all. That is asserted as `not.toBeAttached()` and not as `toBeHidden()`:
 * Playwright counts a zero-match locator as hidden, so the hidden form was green
 * whatever the app did — including while it named `.bpv-root`, a class the
 * retired BlueprintView took with it (#1814).
 */
test.describe('blueprint view', () => {
  test('Blueprint button opens the Blueprint view', async ({ window }) => {
    await expect(window.locator(sel.blueprintRoot)).not.toBeAttached()
    await window.locator(statusButtonByText('Blueprint')).click()
    await expect(window.locator(sel.blueprintRoot)).toBeVisible()
  })
})
