import { test, expect } from '../fixtures/electron'
import { sel } from '../selectors'
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed'

/**
 * Flow 12 — the Chat-panel shortcut (⌘⌥C) vs. focus-mode SCOPE (⌘⌥Z, #616/#713/#836/#924).
 *
 * Focus mode is a distraction-free, editor-only overlay. Its documented contract
 * (panel-layout.ts ~15): "A panel is EFFECTIVELY shown iff `visible && !focusMode`,
 * so leaving focus mode restores each panel's own visibility exactly, for free."
 *
 * #836 fixed ⌘B leaking through the overlay (`if (!layout.focusMode) setSidebarVisible(...)`,
 * shell.ts ~595); #924 tracks the same leak still live for the rail digits ⌘1-3.
 * The ⌘⌥ panel branch (shell.ts ~602-617) has NO focus-mode guard either:
 *   - ⌘⌥D (editor) self-protects — `enforceNonEmpty` forces the editor back on
 *     because `effectivePanels` is empty under focus mode, so it is a true no-op.
 *   - ⌘⌥C (chat) does NOT — `togglePanel(layout, 'conversation')` flips
 *     `conversation.visible` behind the overlay, `applyLayout` persists it via
 *     `saveActive()`, and the user only discovers the loss on exit.
 *
 * That loss is sticky: there is no Chat toggle button in the titlebar and no
 * "Toggle Chat" entry in the command palette (palette-commands.ts) — ⌘⌥C is the
 * ONLY way back, and the layout is persisted per project.
 *
 * The live guard below pins the sibling contract that DOES hold (⌘⌥D inert under
 * focus mode). The fixme tripwire pins the ⌘⌥C leak (#967); flip it live once the
 * ⌘⌥ branch gates on `!layout.focusMode` (or ignores chat toggles under the overlay).
 */
test.describe('flow 12 — ⌘⌥C (Chat) vs focus-mode scope (#836/#924 sibling)', () => {
  test.afterAll(() => cleanupSeeds())

  // LIVE GUARD (passes on main): in the NORMAL layout ⌘⌥C is an honest, visible,
  // round-tripping toggle — hide then show returns the Chat panel.
  test('⌘⌥C round-trips the Chat panel in the normal layout', async ({ window }) => {
    const errors: string[] = []
    window.on('pageerror', (e) => errors.push(String(e)))

    const root = await seedProject(window)
    await activateProject(window, root)

    const chat = window.locator(sel.conversation)
    await expect(chat).toBeVisible()

    await window.keyboard.press('ControlOrMeta+Alt+KeyC')
    await expect(chat).toBeHidden()

    await window.keyboard.press('ControlOrMeta+Alt+KeyC')
    await expect(chat).toBeVisible()

    expect(errors.filter((e) => !/Canceled/.test(e))).toEqual([])
  })

  // RECOVERY AFFORDANCE (#967/#1071): a hidden Chat panel must be recoverable
  // without knowing ⌘⌥C — the palette's "Toggle Chat" command brings it back.
  test('palette "Toggle Chat" restores a ⌘⌥C-hidden Chat panel', async ({ window }) => {
    const errors: string[] = []
    window.on('pageerror', (e) => errors.push(String(e)))

    const root = await seedProject(window)
    await activateProject(window, root)

    const chat = window.locator(sel.conversation)
    await expect(chat).toBeVisible()
    await window.keyboard.press('ControlOrMeta+Alt+KeyC')
    await expect(chat).toBeHidden()

    // ⌘⇧P opens the palette in command mode; run "Toggle Chat".
    await window.keyboard.press('ControlOrMeta+Shift+p')
    const panel = window.locator('.fl-palette-panel')
    await expect(panel).toBeVisible()
    await panel.locator('.fl-palette-input').fill('>toggle chat')
    await expect(window.locator('.fl-palette-row', { hasText: 'Toggle Chat' })).toBeVisible()
    await window.keyboard.press('Enter')

    await expect(panel).toBeHidden()
    await expect(chat).toBeVisible()
    expect(errors.filter((e) => !/Canceled/.test(e))).toEqual([])
  })

  // LIVE GUARD (passes on main): ⌘⌥D IS inert under focus mode — the editor is
  // the only thing focus mode can render, so `enforceNonEmpty` keeps it on and
  // exiting restores the layout untouched. This is the behavior ⌘⌥C should share.
  test('⌘⌥D is inert under focus mode — layout intact on exit', async ({ window }) => {
    const errors: string[] = []
    window.on('pageerror', (e) => errors.push(String(e)))

    const root = await seedProject(window)
    await activateProject(window, root)

    const chat = window.locator(sel.conversation)
    const focusHint = window.locator(sel.focusHint)
    await expect(chat).toBeVisible()

    await window.keyboard.press('ControlOrMeta+Alt+KeyZ')
    await expect(focusHint).toBeVisible()
    await expect(chat).toBeHidden() // overlay hides every model panel
    await window.keyboard.press('ControlOrMeta+Alt+KeyD')

    await window.keyboard.press('Escape')
    await expect(focusHint).toBeHidden()
    await expect(chat).toBeVisible()

    expect(errors.filter((e) => !/Canceled/.test(e))).toEqual([])
  })

  // #967 (fixed): ⌘⌥C pressed inside focus mode used to silently flip
  // `conversation.visible` behind the overlay — the user exited and the Chat
  // panel was gone, persisted per project. The ⌘⌥ branch is now inert under
  // focus mode (swallowedByFocusMode, the shared #836/#924/#968 guard): the
  // layout the user entered focus mode with is exactly the layout they get back.
  test(
    '⌘⌥C in focus mode must not silently drop the Chat panel on exit',
    async ({ window }) => {
      const errors: string[] = []
      window.on('pageerror', (e) => errors.push(String(e)))

      const root = await seedProject(window)
      await activateProject(window, root)

      const chat = window.locator(sel.conversation)
      const focusHint = window.locator(sel.focusHint)
      await expect(chat).toBeVisible()

      await window.keyboard.press('ControlOrMeta+Alt+KeyZ')
      await expect(focusHint).toBeVisible()
      // Reflexive ⌘⌥C while in focus mode — nothing renders, nothing responds.
      await window.keyboard.press('ControlOrMeta+Alt+KeyC')

      await window.keyboard.press('Escape')
      await expect(focusHint).toBeHidden()
      // Expected: the Chat panel the user had open is still there. Fails today.
      await expect(chat).toBeVisible()

      expect(errors.filter((e) => !/Canceled/.test(e))).toEqual([])
    },
  )
})
