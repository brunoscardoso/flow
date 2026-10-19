import { test, expect, type Page } from '../fixtures/electron'
import { sel, statusButtonByText } from '../selectors'
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed'

/**
 * UX sweep — tasks board (flow 9), the DETAIL MODAL'S FOCUS LIFECYCLE.
 *
 * Flow 9 is the most-covered flow in the suite (40+ specs), and its two
 * siblings already have a full keyboard contract:
 *
 *   · the card lane menu — first item focused on open, arrows, contained Tab,
 *     and an Escape that returns focus to the card (#1153 + #1300, guarded by
 *     tasks-detail-lane-control.spec.ts)
 *   · the New-task modal — `titleInput.focus()` on open (kanban-board.ts)
 *
 * The task DETAIL modal — what Enter on a card opens, the board's ticket view —
 * has neither end of it: `#openTaskDetail`/`#renderDetailBody` never call
 * `focus()` at all. The document-level trap (settings/overlay-focus-trap.ts)
 * contains Tab and pulls STRAY focus back on `focusin`, but a modal that opens
 * *around* an already-focused element fires no focusin, so the backstop never
 * runs. What that costs a user, all confirmed live:
 *
 *   1. Open it and the caret is still on the card BEHIND the `inset: 0;
 *      z-index: 1000` backdrop — pointing at something the user cannot see, and
 *      nothing announces the dialog.
 *   2. That covered card's own keydown handlers stay live: Shift+F10 pops its
 *      lane menu (z-index 1100) OVER the open modal. The trap then yanks focus
 *      into the modal, leaving a stranded popup that arrows can't drive but the
 *      mouse can — one click moves a task hidden behind the dialog.
 *   3. Closing from inside (Close button, or Escape after Tab) drops focus on
 *      `<body>`, so the next Tab restarts at the top of the document — the exact
 *      symptom #1300 fixed for the lane menu, still live on the modal that owns
 *      it.
 *
 * Account-independent: tasks are created over `tasks:create`, no agent. The
 * live guards run green so the tripwires can't pass vacuously on a board whose
 * modal never opens.
 */

test.afterAll(() => {
  try {
    cleanupSeeds()
  } catch {
    /* temp dirs are OS-cleaned */
  }
})

const SCREENS = 'e2e/ux/__screens'
const TITLE_A = 'Rotate the API keys'
const TITLE_B = 'Retire the legacy exporter'

/** Seed a project with two manual tasks and open the board on it. */
async function openBoardWithTasks(win: Page): Promise<string> {
  const root = await seedProject(win)
  await activateProject(win, root)
  await win.evaluate(
    async ({ r, titles }) => {
      const api = (
        window as unknown as {
          flow: { tasks: { create(a: { projectRoot: string; title: string }): Promise<unknown> } }
        }
      ).flow.tasks
      for (const title of titles) await api.create({ projectRoot: r, title })
    },
    { r: root, titles: [TITLE_A, TITLE_B] },
  )
  await win.locator(statusButtonByText('Tasks')).click()
  await expect(win.locator(sel.board)).toBeVisible()
  await expect(win.locator('.fl-board-card', { hasText: TITLE_A })).toBeVisible()
  await expect(win.locator('.fl-board-card', { hasText: TITLE_B })).toBeVisible()
  return root
}

/** Where the caret is: `TAG.class` of `document.activeElement`, or 'BODY'. */
async function activeDescription(win: Page): Promise<string> {
  return win.evaluate(() => {
    const el = document.activeElement
    if (!el || el === document.body) return 'BODY'
    return `${el.tagName}.${el.className}`.trim()
  })
}

/** True when the caret sits inside the open detail modal. */
async function focusInsideModal(win: Page): Promise<boolean> {
  return win.evaluate(() => !!document.activeElement?.closest('.fl-board-detail'))
}

/** Open the detail modal for a card the keyboard way (Enter on the card). */
async function openDetailByKeyboard(win: Page, title: string): Promise<void> {
  await win.locator('.fl-board-card', { hasText: title }).focus()
  await win.keyboard.press('Enter')
  await expect(win.locator('.fl-board-detail')).toBeVisible()
}

test('the detail modal opens, acts, and closes by keyboard (live guard)', async ({ window }) => {
  const errors: string[] = []
  window.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`))

  await openBoardWithTasks(window)
  const modal = window.locator('.fl-board-detail')

  // Enter on a focused card is the keyboard route into the modal (#1153).
  await openDetailByKeyboard(window, TITLE_A)
  await expect(modal.locator('.fl-board-modal-title')).toHaveText(TITLE_A)
  await expect(modal.locator('.fl-board-lane-btn')).toHaveText(['Todo', 'Doing', 'Blocked', 'Review', 'Done'])

  // Escape closes it — so anything the tripwires catch is a FOCUS defect, not
  // a dead modal.
  await window.keyboard.press('Escape')
  await expect(modal).toBeHidden()

  expect(errors, errors.join('\n')).toEqual([])
})

test('Tab is contained inside the open detail modal (live guard)', async ({ window }) => {
  await openBoardWithTasks(window)
  await openDetailByKeyboard(window, TITLE_A)

  // The shared document trap (#1006) does hold for this overlay: ten Tabs cycle
  // only through the modal's own controls. Containment is not the gap — entry
  // and return are.
  const escaped: string[] = []
  for (let i = 0; i < 10; i += 1) {
    await window.keyboard.press('Tab')
    if (!(await focusInsideModal(window))) escaped.push(await activeDescription(window))
  }
  expect(escaped, `Tab left the modal: ${escaped.join(', ')}`).toEqual([])
})

// TRIPWIRE (currently RED). Opening the modal leaves `document.activeElement`
// on the `.fl-board-card` the backdrop now covers: the sibling New-task modal
// focuses its first field and the lane menu focuses its first item, but this
// one focuses nothing, so the caret points at an invisible element and no
// dialog is announced.
test('opening the detail modal moves focus into it', async ({ window }) => {
  await openBoardWithTasks(window)
  await openDetailByKeyboard(window, TITLE_A)

  await window.screenshot({ path: `${SCREENS}/tasks-detail-focus-open.png` })
  const where = await activeDescription(window)
  expect(where, `focus left on ${where}`).not.toContain('fl-board-card')
  expect(await focusInsideModal(window)).toBe(true)
})

// TRIPWIRE (currently RED, second shape). Because focus never left the covered
// card, the card's own keyboard gesture still fires: Shift+F10 opens the lane
// menu at z-index 1100 — above the modal overlay's 1000 — so a second popup
// about a task the user cannot see is drawn over the dialog they opened.
test('no popup from the covered card can open over the detail modal', async ({ window }) => {
  await openBoardWithTasks(window)
  const menu = window.locator('.fl-board-menu')

  await openDetailByKeyboard(window, TITLE_A)
  await window.keyboard.press('Shift+F10')
  await window.waitForTimeout(300)
  await window.screenshot({ path: `${SCREENS}/tasks-detail-focus-stacked-menu.png` })
  await expect(menu).toBeHidden()
})

// Guard (was a RED tripwire, fixed 2026-10-09). Both in-modal close routes left
// the caret on `<body>` — #1300's "the next Tab restarted from the top of the
// document": the board re-renders its cards while the modal is up, so the card
// that opened it had left the document; close now refocuses its successor.
test('closing the detail modal returns focus to the card that opened it', async ({
  window,
}) => {
  await openBoardWithTasks(window)
  const modal = window.locator('.fl-board-detail')

  // Route 1: the keyboard user's own path — Tab to a control, then Escape.
  await openDetailByKeyboard(window, TITLE_A)
  await window.keyboard.press('Tab')
  expect(await focusInsideModal(window)).toBe(true)
  await window.keyboard.press('Escape')
  await expect(modal).toBeHidden()
  expect(await activeDescription(window)).toContain('fl-board-card')

  // Route 2: the Close button.
  await openDetailByKeyboard(window, TITLE_A)
  await modal.locator('.fl-board-ghost', { hasText: 'Close' }).click()
  await expect(modal).toBeHidden()
  await window.screenshot({ path: `${SCREENS}/tasks-detail-focus-after-close.png` })
  expect(await activeDescription(window)).toContain('fl-board-card')
})
