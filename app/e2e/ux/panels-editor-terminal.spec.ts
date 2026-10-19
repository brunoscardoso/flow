import type { Page } from '@playwright/test'
import { test, expect } from '../fixtures/electron'
import { sel } from '../selectors'
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed'

/**
 * Flow 12 — the panel-layout shortcuts (#580) and their interaction with the
 * docked terminal. The terminal lives INSIDE the editor-stack (editor +
 * terminal), so hiding the editor (⌘⌥D) detaches the whole stack — the terminal
 * goes with it.
 *
 * #626 (fixed) / #674 (regression from the #668 activity-bar redesign, re-fixed):
 * with the editor hidden the Terminal control must stay HONEST — the terminal is
 * effectively visible only when its editor host is shown, and asking for a
 * terminal (⌃` or ⌘J, both restored/shared via `toggleTerminal`) re-surfaces it
 * in ONE action by bringing the editor host back. Never a dead control that
 * leaves the terminal unrecoverable while the toggle silently does nothing.
 */
const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
const editorStack = (win: Page) => win.locator('#fl-split-editor-stack')

test.describe('flow 12 — ⌘⌥D editor toggle vs. the terminal (#580/#626/#674)', () => {
  test.afterAll(() => cleanupSeeds())

  test('control: ⌘⌥C hides and re-shows the conversation panel', async ({ window }) => {
    const errors: string[] = []
    window.on('pageerror', (e) => errors.push(String(e)))
    const conv = window.locator(sel.panelById('conversation'))
    await expect(conv).toBeVisible()

    await window.keyboard.press('ControlOrMeta+Alt+KeyC')
    await expect(conv).toHaveCount(0)
    await window.keyboard.press('ControlOrMeta+Alt+KeyC')
    await expect(conv).toBeVisible()

    expect(errors.filter((e) => !/Canceled/.test(e))).toEqual([])
  })

  test('control: ⌘⌥D detaches and re-attaches the editor-stack', async ({ window }) => {
    const root = await seedProject(window)
    await activateProject(window, root)
    await expect(editorStack(window)).toBeVisible()

    await window.keyboard.press('ControlOrMeta+Alt+KeyD') // hide editor
    await expect(editorStack(window)).toHaveCount(0)
    await window.keyboard.press('ControlOrMeta+Alt+KeyD') // show editor
    await expect(editorStack(window)).toBeVisible()
  })

  // #674: with the editor hidden, the terminal must not become an unrecoverable
  // dead control. Asking for it re-surfaces it in a single press by bringing the
  // editor host back — via ⌃` AND the restored ⌘J.
  for (const shortcut of ['Control+Backquote', `${mod}+j`]) {
    test(`Terminal recovers when the editor is hidden, via ${shortcut} (#674)`, async ({
      window,
    }) => {
      const errors: string[] = []
      window.on('pageerror', (e) => errors.push(String(e)))
      const root = await seedProject(window)
      await activateProject(window, root)

      // Terminal is docked + visible by default (terminalVisible !== false).
      await expect(editorStack(window)).toBeVisible()
      await expect(window.locator(sel.terminalRoot)).toBeVisible()

      // Hide the editor — the editor-stack (terminal inside) detaches; the
      // terminal is no longer on screen.
      await window.keyboard.press('ControlOrMeta+Alt+KeyD')
      await expect(editorStack(window)).toHaveCount(0)
      await expect(window.locator(sel.terminalRoot)).toBeHidden()

      // Ask for a terminal — it comes back in ONE press by re-attaching the
      // editor host (pre-#674 this was a silent no-op / dead control).
      await window.keyboard.press(shortcut)
      await expect(editorStack(window)).toBeVisible()
      await expect(window.locator(sel.terminalRoot)).toBeVisible()

      expect(errors.filter((e) => !/Canceled/.test(e))).toEqual([])
    })
  }
})
