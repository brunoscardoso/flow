import type { Page } from '@playwright/test'
import { test, expect } from '../fixtures/electron'
import { sel, statusButtonByText } from '../selectors'
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed'

/**
 * Flow 12 — global panel shortcuts vs. the **tasks-board** modals (#1002).
 *
 * #525 (fixed) gates the shell's capture-phase panel shortcuts while a modal owns
 * the keyboard, and #683 gates the terminal's autofocus for the same reason. Both
 * guards test ONE class:
 *
 *   shell.ts:539            `document.querySelector('.fl-settings-overlay:not([hidden])')`
 *   terminal-panel.ts:103   `isModalOverlayOpen()` — the identical query
 *
 * The tasks-board modals ("New task" / task detail) use `.fl-board-modal-overlay`
 * (kanban-board.ts:321/511), so they opt out of the isolation by accident and every
 * #525 symptom is still live there: ⌃` reveals the terminal BEHIND the modal, xterm
 * steals focus from the title input, the user's next keystrokes land on the live
 * shell prompt, and Escape is swallowed — the modal is keyboard-stranded (only a
 * mouse click on Cancel/backdrop gets out). ⌘B leaks the same way.
 *
 * LIVE GUARDS (pass on current `main`):
 *   control — with no modal open, ⌃` round-trips the docked terminal, and a
 *             freshly-opened New-task modal focuses its title input and closes on Escape.
 *   recovery — the mouse path (Cancel) closes the modal even after the leak has
 *             stranded the keyboard. This is the user's only current escape hatch;
 *             it must keep working after the fix too.
 *
 * Regression guard (#1002, fixed): with the terminal hidden and a half-typed task in
 * the New-task modal, ⌃` is a no-op — terminal still hidden, focus still in the title
 * input, and Escape still closes the modal. The modal guard is now overlay-agnostic:
 * every modal marks itself via `markModalOverlay()` (renderer/modal-overlay.ts) and
 * shell.ts, terminal-panel.ts and the focus trap all ask that one registry.
 *
 * Credential-free: a seeded throwaway repo, the real board UI, no agent, no account,
 * no native dialog.
 */
const mod = process.platform === 'darwin' ? 'Meta' : 'Control'

const newTaskBtn = (win: Page) => win.locator('.fl-board-lane-btn[aria-label="New task"]').first()
const modalOverlay = (win: Page) => win.locator('.fl-board-modal-overlay')
const titleInput = (win: Page) => win.locator('.fl-board-modal-body input[type="text"]').first()
const cancelBtn = (win: Page) => win.locator('.fl-board-modal button', { hasText: 'Cancel' }).first()

/** Seed a throwaway project and open its Tasks board. */
async function openBoard(win: Page): Promise<void> {
  const root = await seedProject(win, 'flow-ux-boardmodal-')
  await activateProject(win, root)
  await win.locator(statusButtonByText('Tasks')).click()
  await expect(win.locator(sel.board)).toBeVisible()
}

/** Open "New task" and type a draft title; returns once the modal owns focus. */
async function openNewTaskWithDraft(win: Page, draft: string): Promise<void> {
  await newTaskBtn(win).click()
  await expect(win.locator('.fl-board-modal')).toBeVisible()
  await titleInput(win).click()
  await titleInput(win).fill(draft)
  expect(await focusedClass(win)).toContain('fl-settings-input')
}

const focusedClass = (win: Page): Promise<string> =>
  win.evaluate(() => document.activeElement?.className ?? '')

const terminal = (win: Page) => win.locator(sel.terminalRoot)

/**
 * Put the docked terminal in a known state, whatever it started in. The panel's
 * visibility is persisted layout, so it carries over between runs — asserting a
 * default here would make every test below order-dependent, and "⌃` did nothing"
 * has to be read against a state this spec actually established.
 */
async function setTerminalVisible(win: Page, visible: boolean): Promise<void> {
  if ((await terminal(win).isVisible()) !== visible) {
    await win.keyboard.press('Control+`')
  }
  if (visible) await expect(terminal(win)).toBeVisible()
  else await expect(terminal(win)).toBeHidden()
}

test.describe('panel shortcuts vs. the tasks-board modals (#1002)', () => {
  test.afterAll(() => cleanupSeeds())

  test('control: ⌃` round-trips the terminal, and a New-task modal takes focus and closes on Escape', async ({
    window,
  }) => {
    const errors: string[] = []
    window.on('pageerror', (e) => errors.push(String(e)))
    await openBoard(window)

    // Round-trip the terminal with no modal open, so the tripwire's "⌃` did
    // nothing" is a real isolation signal rather than a broken shortcut.
    await setTerminalVisible(window, true)
    await window.keyboard.press('Control+`')
    await expect(terminal(window)).toBeHidden()
    await window.keyboard.press('Control+`')
    await expect(terminal(window)).toBeVisible()

    // A freshly-opened modal owns the keyboard: it focuses its title input and
    // Escape reaches its own close handler.
    await openNewTaskWithDraft(window, 'control draft')
    await window.keyboard.press('Escape')
    await expect(modalOverlay(window)).toHaveCount(0)

    expect(errors.filter((e) => !/Canceled/.test(e))).toEqual([])
  })

  test('recovery: the mouse path (Cancel) closes the modal even after ⌃` strands the keyboard', async ({
    window,
  }) => {
    const errors: string[] = []
    window.on('pageerror', (e) => errors.push(String(e)))
    await openBoard(window)

    await setTerminalVisible(window, false)
    await openNewTaskWithDraft(window, 'recovery draft')

    // Today this leaks (see the tripwire below); after the fix it is a no-op.
    // Either way, the explicit dismiss affordance must remain clickable — it is
    // the user's only way out while the keyboard is stranded.
    await window.keyboard.press('Control+`')
    await window.waitForTimeout(1200)
    await expect(cancelBtn(window)).toBeVisible()
    await cancelBtn(window).click()
    await expect(modalOverlay(window)).toHaveCount(0)

    expect(errors.filter((e) => !/Canceled/.test(e))).toEqual([])
  })

  test(
    'the New-task modal isolates ⌃`/⌘B and Escape still closes it (#1002)',
    async ({ window }) => {
      const errors: string[] = []
      window.on('pageerror', (e) => errors.push(String(e)))
      await openBoard(window)

      // Terminal hidden first — a user working terminal-free, so a leaking ⌃`
      // REVEALS a terminal (and its focus-stealing xterm) behind the modal.
      await setTerminalVisible(window, false)
      const sidebarBefore = await window.locator(sel.threadSidebar).isVisible()

      await openNewTaskWithDraft(window, 'write the release notes')

      // ⌃` while the modal owns the keyboard must be a NO-OP.
      await window.keyboard.press('Control+`')
      await window.waitForTimeout(1200)
      await expect(terminal(window)).toBeHidden()
      // …and focus must NOT be stolen to xterm — otherwise the user's next
      // keystrokes are typed into a live shell prompt.
      expect(await focusedClass(window)).not.toContain('xterm-helper-textarea')

      // Typing continues to land in the form the user is looking at.
      await window.keyboard.type('!')
      await expect(titleInput(window)).toHaveValue('write the release notes!')

      // ⌘B must not mutate the layout behind the modal either.
      await window.keyboard.press(`${mod}+b`)
      await window.waitForTimeout(400)
      expect(await window.locator(sel.threadSidebar).isVisible()).toBe(sidebarBefore)

      // And Escape still reaches the modal's own close handler.
      await window.keyboard.press('Escape')
      await expect(modalOverlay(window)).toHaveCount(0)

      expect(errors.filter((e) => !/Canceled/.test(e))).toEqual([])
    },
  )
})
