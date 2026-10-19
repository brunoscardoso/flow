import { test, expect } from '../fixtures/electron'
import { sel, statusButtonByText } from '../selectors'
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed'

/**
 * Tasks board — "New task" empty-required-field submit (flow 9 sweep).
 *
 * #412 (an empty-title Create was a silent dead click) is FIXED: the Create
 * button is now disabled with an "Enter a task title" hint until a title is
 * entered. This guards that fixed behavior — an empty title cannot submit and
 * gives feedback (disabled button), the typed description is preserved, entering
 * a title re-enables Create, and no phantom task is created.
 */
test.afterAll(() => cleanupSeeds())

test.describe('tasks board — empty-title create', () => {
  test('empty-title Create is disabled (feedback), input preserved, no phantom task (#412)', async ({
    window,
  }) => {
    const errors: string[] = []
    window.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
    window.on('console', (m) => {
      if (m.type() === 'error') errors.push(`console.error: ${m.text()}`)
    })

    const root = await seedProject(window)
    await activateProject(window, root)

    await window.locator(statusButtonByText('Tasks')).click()
    await expect(window.locator(sel.board)).toBeVisible()

    await window.locator('.fl-board-lane-btn[aria-label="New task"]').click()
    await expect(window.locator('.fl-board-modal')).toBeVisible()

    // Fill only the description (the trap: title left empty).
    const description = 'A seeded description with no title.'
    await window.locator('.fl-board-modal-body textarea').fill(description)

    // #412 fixed: Create is disabled with an empty title — feedback, not a dead click.
    const createBtn = window.locator('.fl-board-modal .fl-board-new', { hasText: 'Create task' })
    await expect(createBtn).toBeDisabled()

    // The modal stays open and the typed description survives (no #299 discard).
    await expect(window.locator('.fl-board-modal')).toBeVisible()
    await expect(window.locator('.fl-board-modal-body textarea')).toHaveValue(description)

    // Entering a title re-enables Create.
    await window.locator('.fl-board-modal-body input[placeholder="Task title"]').fill('Now it has a title')
    await expect(createBtn).toBeEnabled()

    // No phantom task was created — the empty-title submit never went through.
    await window.keyboard.press('Escape')
    await expect(window.locator('.fl-board-modal')).toBeHidden()
    await window.locator(statusButtonByText('Tasks')).click()
    await expect(window.locator(sel.board)).toBeVisible()
    await expect
      .poll(async () => window.locator('.fl-board-column:not(.fl-board-remote) .fl-board-count').allTextContents())
      .toEqual(['0', '0', '0', '0', '0'])
    await expect(window.locator('.fl-board-card')).toHaveCount(0)

    expect(errors).toEqual([])
  })
})
