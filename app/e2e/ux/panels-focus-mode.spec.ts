import { test, expect } from '../fixtures/electron'
import { sel } from '../selectors'
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed'

/**
 * Flow 12 — focus mode (⌘⌥Z, VS-Code Zen-mode parity, #616).
 *
 * Focus mode is meant to give a distraction-free, editor-only view: the panel-
 * layout model documents it as hiding EVERYTHING but the editor
 * (`effectivePanels()` returns `[]` while `focusMode`), and `syncToggleStates`
 * reads the titlebar sidebar toggle as inactive on that assumption
 * ("focus mode hides everything, so the sidebar button must not read active
 * while it's on (it would lie, #616)").
 *
 * That held while the sidebar (Threads/Files/Source-Control) was itself a
 * movable panel governed by `effectivePanels`. The #663/#674 activity-bar
 * redesign moved it OUT into a separate `activitySidebarWrapper` rendered by
 * `applyLayout` gated only on `sidebarOpen` — never on `layout.focusMode`
 * (shell.ts ~657). So today focus mode hides the Chat panel but leaves the whole
 * activity sidebar (with the live thread list) on screen, while the titlebar
 * toggle now reads INACTIVE beside the plainly-visible sidebar — the exact
 * "it would lie" state the model tried to avoid, inverted.
 *
 * Live guards below (pass on `main`): the half that still works — Chat hides,
 * the exit pill shows, Escape exits. The `test.fixme` documents the EXPECTED
 * distraction-free behavior (sidebar hidden + toggle honest) that FAILS today;
 * flip it live once `applyLayout` gates the sidebar on `layout.focusMode`.
 */
const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
const activitySidebar = '.fl-activity-sidebar'

test.describe('flow 12 — focus mode (⌘⌥Z) distraction-free view (#616)', () => {
  test.afterAll(() => cleanupSeeds())

  test('focus mode hides the Chat panel, shows the exit pill, and Escape exits', async ({
    window,
  }) => {
    const errors: string[] = []
    window.on('pageerror', (e) => errors.push(String(e)))

    const root = await seedProject(window)
    await activateProject(window, root)

    const conversation = window.locator(sel.panelById('conversation'))
    await expect(conversation).toBeVisible()
    await expect(window.locator(sel.focusHint)).toBeHidden()

    // Enter focus mode: the Chat panel detaches and the exit pill appears.
    await window.keyboard.press('ControlOrMeta+Alt+KeyZ')
    await expect(conversation).toHaveCount(0)
    await expect(window.locator(sel.focusHint)).toBeVisible()

    // Escape is the discoverable exit (the #616 fix) — Chat returns, pill hides.
    await window.keyboard.press('Escape')
    await expect(conversation).toBeVisible()
    await expect(window.locator(sel.focusHint)).toBeHidden()

    expect(errors.filter((e) => !/Canceled/.test(e))).toEqual([])
  })

  // Guard for #713 (fixed): focus mode is a genuine distraction-free view —
  // applyLayout now gates the activity sidebar on !focusMode too, so the
  // sidebar (with the thread list) hides and the titlebar toggle reads honest.
  test(
    'focus mode hides the activity sidebar and the titlebar toggle stays honest',
    async ({ window }) => {
      const root = await seedProject(window)
      await activateProject(window, root)

      const sidebar = window.locator(activitySidebar)
      const toggle = window.locator(sel.sidebarToggle)
      await expect(sidebar).toBeVisible()

      await window.keyboard.press('ControlOrMeta+Alt+KeyZ')
      await expect(window.locator(sel.focusHint)).toBeVisible()

      // Distraction-free: the sidebar (with the thread list) is gone…
      await expect(sidebar).toBeHidden()
      // …and the toggle must not claim the sidebar is hidden while it's shown,
      // nor active while focus mode overlays it — it reads inactive because the
      // sidebar is genuinely gone.
      await expect(toggle).not.toHaveClass(/active/)
    },
  )
})
