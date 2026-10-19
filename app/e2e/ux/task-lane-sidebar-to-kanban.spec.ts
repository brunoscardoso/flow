import { test, expect, type Page } from '../fixtures/electron'
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed'

/**
 * A task shows on TWO surfaces at once — the thread sidebar (as a task row) and the
 * kanban board (as a card). Changing its lane from the sidebar's ⋯ menu
 * ("Move to Done" → tasks:update {lane}) must move its card on the board, which is a
 * separate editor-area tab that only re-renders off the tasks:updated broadcast.
 * tasks-drag-persist covers the kanban DRAG; this guards the sidebar→kanban reflect.
 */
async function laneCounts(win: Page): Promise<string[]> {
  return win.locator('.fl-board-column:not(.fl-board-remote) .fl-board-count').allTextContents()
}

test.afterAll(() => cleanupSeeds())

test('changing a task lane from the sidebar ⋯ menu moves its card on the kanban', async ({
  window,
}) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(String(e)))

  const dir = await seedProject(window, 'flow-lane-xsurface-')
  await activateProject(window, dir)

  // Create a task via IPC — it starts in Todo and shows in the sidebar.
  await window.evaluate(async (root) => {
    const api = (
      window as unknown as {
        flow: { tasks: { create(r: { projectRoot: string; title: string }): Promise<unknown> } }
      }
    ).flow
    await api.tasks.create({ projectRoot: root, title: 'Lane Xsurface Task' })
  }, dir)

  const title = window.locator('.fl-thread-sidebar').getByText('Lane Xsurface Task', { exact: true })
  await expect(title).toBeVisible({ timeout: 8000 })

  // Open the kanban board (Tasks rail action opens an editor tab; the sidebar stays).
  await window.locator('.fl-editor-actions .fl-rail-item[aria-label="Tasks"]').click()
  await expect(window.locator('.fl-board-columns')).toBeVisible({ timeout: 8000 })
  // The card lands in Todo — counts [todo, doing, blocked, done] = [1, 0, 0, 0].
  await expect.poll(() => laneCounts(window), { timeout: 8000 }).toEqual(['1', '0', '0', '0', '0'])

  // Move it to Done from the SIDEBAR ⋯ menu (right-click the task row).
  await title.click({ button: 'right' })
  const menu = window.locator('.fl-thread-menu')
  await expect(menu).toBeVisible()
  await menu.locator('.fl-thread-menu-item', { hasText: 'Move to Done' }).click()

  // The board — a different surface — reflects the move: card now in Done.
  await expect.poll(() => laneCounts(window), { timeout: 8000 }).toEqual(['0', '0', '0', '0', '1'])

  expect(errors, errors.join(', ')).toHaveLength(0)
})
