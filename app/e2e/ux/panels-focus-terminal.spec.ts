import { test, expect } from '../fixtures/electron'
import { sel } from '../selectors'
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed'

/**
 * Flow 12 — focus mode (⌘⌥Z) SCOPE vs. the docked terminal.
 *
 * Focus mode is an OVERLAY flag on the panel-layout model: a panel renders iff
 * `visible && !focusMode`, so entering focus mode hides every MODEL panel (the
 * Chat/conversation panel) and — since #713 — the activity sidebar too, for a
 * genuine editor-only view. Every existing focus-mode spec (panels-focus-mode,
 * pr-611) asserts the Chat panel / movable panels / activity sidebar hide.
 *
 * NONE drive the docked terminal, which is NOT a model panel: it lives inside
 * the editor-stack (editor + terminal vertical split), and `buildSplitPlan` in
 * focus mode returns `center: 'editor'` → applyLayout keeps the whole
 * editorStack. So the terminal is part of the "editor-only" surface and stays on
 * screen while chat + sidebar go away — the intentional scope boundary of focus
 * mode (it governs model panels + the sidebar, NOT the editor's own docked
 * terminal). This is a defensible design (edit + run tests, distraction-free
 * from chat/threads), and there is no state-lie: the terminal is genuinely
 * present, so any Terminal control reading "active" is honest (contrast #626,
 * where ⌘⌥D detached the stack and left the Terminal button lit-but-dead).
 *
 * These two live guards pin that boundary against silent regression in EITHER
 * direction — focus mode must keep hiding chat + sidebar, must NOT start
 * clobbering the docked terminal, and the exit round-trip must restore all three
 * with no uncaught errors.
 */
const activitySidebar = '.fl-activity-sidebar'

test.describe('flow 12 — focus mode vs. the docked terminal (scope boundary)', () => {
  test.afterAll(() => cleanupSeeds())

  test('focus mode hides chat + sidebar but keeps the docked terminal (editor-only scope)', async ({
    window,
  }) => {
    const errors: string[] = []
    window.on('pageerror', (e) => errors.push(String(e)))

    const root = await seedProject(window)
    await activateProject(window, root)

    const conversation = window.locator(sel.panelById('conversation'))
    const sidebar = window.locator(activitySidebar)
    const termRoot = window.locator(sel.terminalRoot)

    // Baseline: chat + sidebar + docked terminal all present.
    await expect(conversation).toBeVisible()
    await expect(sidebar).toBeVisible()
    await expect(termRoot).toBeVisible()

    // Enter focus mode.
    await window.keyboard.press('ControlOrMeta+Alt+KeyZ')
    await expect(window.locator(sel.focusHint)).toBeVisible()

    // Model panels + the sidebar go away (the distraction-free surface)…
    await expect(conversation).toHaveCount(0)
    await expect(sidebar).toBeHidden()
    // …but the docked terminal is part of the editor-only view and STAYS — it is
    // not a model panel, so focus mode never touches it (intentional scope).
    await expect(termRoot).toBeVisible()
  })

  test('exiting focus mode restores chat + sidebar with the terminal still docked', async ({
    window,
  }) => {
    const errors: string[] = []
    window.on('pageerror', (e) => errors.push(String(e)))

    const root = await seedProject(window)
    await activateProject(window, root)

    const conversation = window.locator(sel.panelById('conversation'))
    const sidebar = window.locator(activitySidebar)
    const termRoot = window.locator(sel.terminalRoot)

    await window.keyboard.press('ControlOrMeta+Alt+KeyZ')
    await expect(window.locator(sel.focusHint)).toBeVisible()
    await expect(conversation).toHaveCount(0)
    await expect(termRoot).toBeVisible()

    // Escape exits — chat + sidebar return, terminal never left.
    await window.keyboard.press('Escape')
    await expect(window.locator(sel.focusHint)).toBeHidden()
    await expect(conversation).toBeVisible()
    await expect(sidebar).toBeVisible()
    await expect(termRoot).toBeVisible()

    expect(errors.filter((e) => !/Canceled/.test(e))).toEqual([])
  })
})
