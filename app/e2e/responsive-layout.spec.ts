import { test, expect } from './fixtures/electron'
import { sel } from './selectors'

/**
 * Panel layout (#580, post-#674). The activity-bar restructure RETIRED most of the
 * movable-panel system: files-git, the ⋯ reposition menus, and the ⌘⌥←/→ panel
 * moves are gone; threads / files / source-control moved to the activity-bar rail
 * (managed outside the layout model). What remains is a single movable panel — the
 * conversation (chat) — carrying data-panel-id, plus the ⌘⌥ toggle shortcuts for
 * chat (⌘⌥C) and the center editor (⌘⌥D). (The sidebar ⌘B / terminal ⌃`/⌘J toggles
 * are covered by panels.spec.)
 */
test.describe('panel layout — conversation panel + ⌘⌥ toggles (#580 post-#674)', () => {
  test('the conversation is the sole movable panel; the retired panels are gone', async ({
    window,
  }) => {
    await expect(window.locator(sel.panelById('conversation'))).toBeVisible()
    // The former movable panels were removed by the activity-bar restructure.
    await expect(window.locator(sel.panelById('threads'))).toHaveCount(0)
    await expect(window.locator(sel.panelById('files-git'))).toHaveCount(0)
    // The immovable editor center has no data-panel-id.
    await expect(window.locator(sel.rootSplit)).toBeVisible()
  })

  test('⌘⌥C toggles the conversation (chat) panel', async ({ window }) => {
    const chat = window.locator(sel.panelById('conversation'))
    await expect(chat).toBeVisible()

    await window.keyboard.press('ControlOrMeta+Alt+KeyC') // toggle off
    await expect(chat).toHaveCount(0)

    await window.keyboard.press('ControlOrMeta+Alt+KeyC') // toggle back on
    await expect(chat).toBeVisible()
  })

  test('⌘⌥D toggles the center editor area', async ({ window }) => {
    const editorStack = window.locator('#fl-split-editor-stack')
    await expect(editorStack).toBeVisible()

    await window.keyboard.press('ControlOrMeta+Alt+KeyD') // hide the editor
    await expect(editorStack).toHaveCount(0)

    await window.keyboard.press('ControlOrMeta+Alt+KeyD') // bring it back
    await expect(editorStack).toBeVisible()
  })

  test('the threads toolbar "New thread" button is clickable (no ⋯ trigger overlaps it) (#636)', async ({
    window,
  }) => {
    // The ⋯ reposition trigger that once floated over each panel's top-right and
    // stole this click was retired with the movable-panel system; a real click
    // (which runs Playwright's pointer-interception check) must reach the button.
    const newThread = window.locator(sel.newThread).first()
    await expect(newThread).toBeVisible()
    await newThread.click({ timeout: 5000 })
  })
})
