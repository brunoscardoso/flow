import { test, expect } from '../fixtures/electron'
import { sel, statusButtonByText } from '../selectors'
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed'

/**
 * UX sweep — the tasks board drag COMPLETE round trip. tasks.spec drags a card
 * and checks the lane COUNTS follow, but never confirms the move was PERSISTED
 * (a reopened board reuses the same DOM, so an optimistic-only update would look
 * fine). This queries the store (tasks:list) after the drop and asserts the
 * task's `lane` is actually 'doing' — the write, not just the paint.
 */

test.afterAll(() => cleanupSeeds())

test('dragging a card Todo→Doing persists the lane to the store', async ({ window }) => {
  const errors: string[] = []
  window.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`))

  const root = await seedProject(window)
  await activateProject(window, root)

  await window.locator(statusButtonByText('Tasks')).click()
  await expect(window.locator(sel.board)).toBeVisible()

  // Create a manual task (lands in Todo).
  await window.locator('.fl-board-lane-btn[aria-label="New task"]').click()
  await expect(window.locator('.fl-board-modal')).toBeVisible()
  await window.locator('.fl-board-modal-body input[type="text"]').first().fill('Persist task')
  await window.locator('.fl-board-modal .fl-board-new', { hasText: 'Create task' }).click()
  await expect(window.locator('.fl-board-modal')).toBeHidden()

  const card = window.locator('.fl-board-card', { hasText: 'Persist task' })
  await expect(card).toBeVisible()
  await expect
    .poll(async () => window.locator('.fl-board-column:not(.fl-board-remote) .fl-board-count').allTextContents())
    .toEqual(['1', '0', '0', '0', '0'])

  // Drag Todo → Doing (native HTML5 DnD over a shared DataTransfer).
  const dragged = await window.evaluate(() => {
    const el = document.querySelector('.fl-board-card') as HTMLElement | null
    const doing = document.querySelectorAll('.fl-board-column:not(.fl-board-remote) .fl-board-cards')[1] as HTMLElement | undefined
    if (!el || !doing) return false
    const dt = new DataTransfer()
    el.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }))
    doing.dispatchEvent(new DragEvent('dragover', { bubbles: true, dataTransfer: dt }))
    doing.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: dt }))
    el.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }))
    return true
  })
  expect(dragged).toBe(true)
  await expect
    .poll(async () => window.locator('.fl-board-column:not(.fl-board-remote) .fl-board-count').allTextContents())
    .toEqual(['0', '1', '0', '0', '0'])

  // PERSISTENCE: the STORE reflects the move, not just the optimistic UI.
  await expect
    .poll(
      async () =>
        window.evaluate(async (projectRoot) => {
          const api = (window as unknown as {
            flow: { tasks: { list(r: { projectRoot: string }): Promise<Array<{ title: string; lane: string }>> } }
          }).flow
          const tasks = await api.tasks.list({ projectRoot })
          return tasks.find((t) => t.title === 'Persist task')?.lane ?? null
        }, root),
      { timeout: 5_000 },
    )
    .toBe('doing')

  expect(errors).toEqual([])
})
