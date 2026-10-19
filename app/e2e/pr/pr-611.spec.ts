import { test, expect } from '../fixtures/electron'
import { sel } from '../selectors'

/**
 * Regression guard for PR #611 — "feat: responsive layout — panel
 * side-assignment, toggle shortcuts, per-project memory (#580)".
 *
 * Focus mode (⌘⌥Z) is an OVERLAY flag on the panel-layout model: when on,
 * `effectivePanels()` returns [] so the movable panel (conversation — threads
 * and files/git now live in the activity sidebar, which focus mode also hides)
 * is removed from the root split, leaving only the center editor; when off, each panel's own `visible` flag is restored exactly
 * (no per-panel save/restore). PR #611's own probe covers per-panel toggles and
 * moves but not this whole-shell overlay round-trip — this spec locks it in.
 *
 * Asserts observable DOM only (panels present/absent), never model internals.
 *
 * Focus mode now has a discoverable exit (#616 fixed): a persistent "Focus mode ·
 * Esc to exit" pill shows while it's on, Esc exits it, and it never persists
 * across a reload (normalizePanelLayout drops it — covered by unit tests).
 */
test.describe('responsive layout — focus mode overlay round-trip (#580, PR #611)', () => {
  // Threads and Files/Git moved into the activity-bar SIDEBAR (panel-layout.ts:
  // "the only movable panel is conversation"). Focus mode still takes every
  // surface but the editor away, so the walk checks the one movable panel and
  // the sidebar that replaced the other two.
  const MOVABLE_PANELS = ['conversation'] as const
  const SIDEBAR = sel.threadSidebar

  test('⌘⌥Z hides every movable panel, then restores them all', async ({ window }) => {
    // Baseline: the movable panel and the sidebar render.
    for (const id of MOVABLE_PANELS) {
      await expect(window.locator(sel.panelById(id))).toBeVisible()
    }
    await expect(window.locator(SIDEBAR)).toBeVisible()

    // Focus mode ON — the overlay removes every movable panel from the split,
    // and the sidebar with it.
    await window.keyboard.press('ControlOrMeta+Alt+KeyZ')
    for (const id of MOVABLE_PANELS) {
      await expect(window.locator(sel.panelById(id))).toHaveCount(0)
    }
    await expect(window.locator(SIDEBAR)).toBeHidden()
    // The immovable editor center still renders (non-empty invariant holds).
    await expect(window.locator(sel.rootSplit)).toBeVisible()

    // Focus mode OFF — every panel that was visible comes back, exactly.
    await window.keyboard.press('ControlOrMeta+Alt+KeyZ')
    for (const id of MOVABLE_PANELS) {
      await expect(window.locator(sel.panelById(id))).toBeVisible()
    }
    await expect(window.locator(SIDEBAR)).toBeVisible()
  })

  test('focus mode is escapable without ⌘⌥Z — a hint pill + Esc exit (#616)', async ({
    window,
  }) => {
    const hint = window.locator(sel.focusHint)
    await expect(hint).toBeHidden()

    // Enter focus mode: the exit pill appears (a discoverable way back).
    await window.keyboard.press('ControlOrMeta+Alt+KeyZ')
    await expect(window.locator(sel.panelById('conversation'))).toHaveCount(0)
    await expect(hint).toBeVisible()
    await expect(hint).toHaveText(/Esc to exit/)

    // Esc alone (no ⌘⌥Z) exits focus mode — panels return, the pill hides.
    await window.keyboard.press('Escape')
    for (const id of MOVABLE_PANELS) {
      await expect(window.locator(sel.panelById(id))).toBeVisible()
    }
    await expect(window.locator(SIDEBAR)).toBeVisible()
    await expect(hint).toBeHidden()
  })

  test('clicking the focus pill exits focus mode (#616)', async ({ window }) => {
    await window.keyboard.press('ControlOrMeta+Alt+KeyZ')
    const hint = window.locator(sel.focusHint)
    await expect(hint).toBeVisible()

    await hint.click()
    await expect(hint).toBeHidden()
    await expect(window.locator(sel.panelById('conversation'))).toBeVisible()
    await expect(window.locator(SIDEBAR)).toBeVisible()
  })
})
