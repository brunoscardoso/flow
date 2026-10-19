import type { ElectronApplication, Page } from '@playwright/test'
import { test, expect } from '../fixtures/electron'
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed'

/**
 * UX sweep — flow 12 (panel toggles & keyboard shortcuts), round 24:
 * the RELEASE-NOTES modal vs. the modal-overlay registry.
 *
 * `modal-overlay.ts` exists because #525's shortcut isolation was written
 * against ONE overlay class, so the tasks-board modals opted out by accident
 * (#1002). Its fix was "a convention set at creation": a modal calls
 * `markModalOverlay()`, and the shell's shortcut guard, the terminal's focus
 * guard and the Tab focus trap all ask that one registry. Its own comment even
 * names the overlays that are REMOVED from the DOM on close — "the board
 * modals, release notes".
 *
 * `update/release-notes.ts` never calls it. The overlay it builds is modal in
 * every other respect (fixed inset-0 backdrop at z-index 9500, backdrop click
 * to dismiss, its own document-level Escape handler) but is invisible to all
 * three guards — and it is the surface that opens BY ITSELF on the first launch
 * after every update, plus from the titlebar "What's new" chip.
 *
 * Verified live: with it open, ⌘B hides the sidebar behind it and ⌃` reveals
 * the docked terminal behind it, whose xterm takes focus — after which Escape
 * is swallowed and the modal is keyboard-uncloseable, while everything typed
 * lands on a live shell prompt one Enter from executing. That is the exact
 * #525/#1002 symptom set, on an overlay nobody registered.
 *
 * Sibling instance: #1430 (the conversation image viewer, same missing call).
 *
 * The updater FEED is the only thing simulated — `updater:status` is pushed
 * from the main process on the same channel electron-updater uses, so the chip,
 * the click, the modal and every guard under test are the real ones.
 */
const mod = process.platform === 'darwin' ? 'Meta' : 'Control'

/** Raise the real release-notes modal via the titlebar "What's new" chip. */
async function openReleaseNotes(app: ElectronApplication, win: Page) {
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.webContents.send('updater:status', {
      phase: 'available',
      version: '9.9.9',
    })
  })
  const chip = win.locator('.fl-update-chip-notes')
  await chip.waitFor({ state: 'visible', timeout: 6000 })
  await chip.click()
  const overlay = win.locator('.fl-relnotes-overlay')
  await overlay.waitFor({ state: 'visible', timeout: 6000 })
  return overlay
}

/** Hide the docked terminal (visible by default, #674) so ⌃` is a REVEAL. */
async function hideTerminal(win: Page) {
  if (await win.locator('.fl-term-root').isVisible()) {
    await win.keyboard.press('Control+`')
  }
  await expect(win.locator('.fl-term-root')).toBeHidden()
}

test.describe('release-notes modal vs. the modal-overlay registry (flow 12)', () => {
  test.afterAll(() => cleanupSeeds())

  test('control: the modal opens from the chip and Escape closes it', async ({ app, window }) => {
    const errors: string[] = []
    window.on('pageerror', (e) => errors.push(String(e)))
    const root = await seedProject(window)
    await activateProject(window, root)

    const overlay = await openReleaseNotes(app, window)
    await expect(overlay).toBeVisible()
    await window.keyboard.press('Escape')
    await expect(overlay).toHaveCount(0)
    expect(errors).toEqual([])
  })

  test('the overlay joins the modal registry', async ({ app, window }) => {
    const root = await seedProject(window)
    await activateProject(window, root)
    await openReleaseNotes(app, window)

    // What every guard actually asks (MODAL_OVERLAY_SELECTOR).
    expect(
      await window.evaluate(() => !!document.querySelector('[data-fl-modal]:not([hidden])')),
    ).toBe(true)
  })

  test('⌘B does not drop the sidebar behind the modal', async ({ app, window }) => {
    const root = await seedProject(window)
    await activateProject(window, root)
    const sidebar = window.locator('.fl-thread-sidebar')
    await expect(sidebar).toBeVisible()

    await openReleaseNotes(app, window)
    await window.keyboard.press(`${mod}+b`)
    await window.waitForTimeout(300)
    await expect(sidebar).toBeVisible()
  })

  test(
    '⌃` does not open a focus-stealing terminal behind the modal, and Escape still closes it',
    async ({ app, window }) => {
      const root = await seedProject(window)
      await activateProject(window, root)
      await hideTerminal(window)

      const overlay = await openReleaseNotes(app, window)
      await window.keyboard.press('Control+`')
      await window.waitForTimeout(1000)

      // Nothing may be revealed behind a modal, and the keyboard must stay here.
      await expect(window.locator('.fl-term-root')).toBeHidden()
      expect(
        await window.evaluate(
          () => !!document.activeElement?.closest('.fl-term-root, .fl-term-host'),
        ),
      ).toBe(false)

      // The modal's own exit still works — the #525 symptom was Escape going
      // dead once xterm owned the keyboard.
      await window.keyboard.press('Escape')
      await expect(overlay).toHaveCount(0)
    },
  )
})
