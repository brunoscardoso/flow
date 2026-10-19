import { test, expect } from '../fixtures/electron'
import { sel, statusButtonByText } from '../selectors'

/**
 * Regression for PR #222 — "only zoom out on Esc when the board is actually
 * visible (#221)".
 *
 * The blueprint installs a GLOBAL `document` keydown listener that pops one
 * layer off the board's stack on Escape. It was guarded only by
 * `!this.element.isConnected`, but the editor keeps the blueprint element
 * mounted (`display:none`) when another tab is active OR after the tab is
 * closed — so `isConnected` stayed `true`, and Escape pressed ANYWHERE in the
 * app (editing a file, dismissing autocomplete) silently popped the hidden
 * board's layer stack. The fix gates on real visibility: `offsetParent === null`
 * is null while the element or an ancestor is `display:none`, so the handler is
 * inert off-screen. That gate is still the first line of the live board's
 * handler (`blueprint-board.ts:1477`) — the BlueprintView it was written for has
 * since been retired and its logic folded into the board, and the decision
 * itself stays covered by the `view-state` unit suite
 * (`shouldZoomOutOnEscape`: visible+depth → zoom; hidden → ignore; root →
 * ignore; non-Escape → ignore).
 *
 * Observing an actual zoom needs a multi-layer graph (a project + derived
 * structure), which isn't drivable from a fresh, credential-less launch (see
 * e2e/README.md "Known gate"). This spec guards the two headlessly-observable
 * halves of the wiring:
 *   1. The blueprint still mounts — a throw in the reworked keydown handler
 *      would crash the open.
 *   2. The #221 target condition end-to-end: with the blueprint board HIDDEN
 *      behind the Tasks board (mounted, display:none — exactly what tricked the
 *      old `isConnected` guard), a global Escape leaves the visible board and
 *      the shell untouched.
 *
 * Both halves used to run against `.bpv-root`, which the retirement deleted
 * (#1814): test 1 failed on every run, and the three "hidden" assertions of
 * test 2 — including line 63, the load-bearing one this whole spec exists for —
 * were green on a locator that matched nothing. `toBeAttached()` now precedes
 * every `toBeHidden()`, because Playwright reports zero matches as hidden and a
 * lone `toBeHidden()` therefore cannot distinguish "mounted and display:none"
 * (the #221 state) from "gone".
 */
test.describe('PR #222 — Blueprint only zooms out on Esc while visible', () => {
  test('the Blueprint view opens (hidden-Escape guard wiring intact)', async ({ window }) => {
    await expect(window.locator(sel.blueprintRoot)).not.toBeAttached()
    await window.locator(statusButtonByText('Blueprint')).click()
    // Mounted — proof the board constructed and installed its keydown handler
    // without throwing.
    await expect(window.locator(sel.blueprintRoot)).toBeVisible()
  })

  test('a global Escape does not disturb the visible board while Blueprint is hidden', async ({
    window,
  }) => {
    // Open Blueprint first, then the Tasks board on top of it. Blueprint stays
    // mounted but hidden (display:none) — the exact state that defeated the old
    // `isConnected` guard (#221).
    await window.locator(statusButtonByText('Blueprint')).click()
    await expect(window.locator(sel.blueprintRoot)).toBeVisible()

    await window.locator(statusButtonByText('Tasks')).click()
    await expect(window.locator(sel.board)).toBeVisible()
    // STILL ATTACHED, and hidden. Asserting only the second would also pass if
    // the editor had unmounted the board, which is not the state #221 is about.
    await expect(window.locator(sel.blueprintRoot)).toBeAttached()
    await expect(window.locator(sel.blueprintRoot)).toBeHidden()

    // Global Escape (as a user would press it anywhere in the app). The hidden
    // board's handler must be inert now (offsetParent === null), so the visible
    // board and shell are unaffected.
    await window.locator('body').press('Escape')
    await window.locator('body').press('Escape')

    await expect(window.locator(sel.shell)).toBeVisible()
    await expect(window.locator(sel.board)).toBeVisible()
    await expect(window.locator(sel.blueprintRoot)).toBeAttached()
    await expect(window.locator(sel.blueprintRoot)).toBeHidden()
  })
})
