import { test, expect } from '../fixtures/electron'
import { sel, statusButtonByText } from '../selectors'
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed'

/**
 * UX sweep — cross-surface: a task's detail "Open chat" must actually OPEN a
 * chat. The handler only acts when task.threadId is set, so this verifies (a)
 * a created task is linked to a thread in the store, and (b) clicking Open chat
 * surfaces that thread's composer — not a dead button.
 */

test.afterAll(() => cleanupSeeds())

test('task detail "Open chat" opens the task\'s linked thread', async ({ window }) => {
  const errors: string[] = []
  window.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`))

  const root = await seedProject(window)
  await activateProject(window, root)

  await window.locator(statusButtonByText('Tasks')).click()
  await expect(window.locator(sel.board)).toBeVisible()

  // Create a manual task.
  await window.locator('.fl-board-lane-btn[aria-label="New task"]').click()
  await expect(window.locator('.fl-board-modal')).toBeVisible()
  await window.locator('.fl-board-modal-body input[type="text"]').first().fill('Chat link task')
  await window.locator('.fl-board-modal .fl-board-new', { hasText: 'Create task' }).click()
  await expect(window.locator('.fl-board-modal')).toBeHidden()

  const card = window.locator('.fl-board-card', { hasText: 'Chat link task' })
  await expect(card).toBeVisible()

  // (a) The store links the task to a thread.
  const threadId = await window.evaluate(async (projectRoot) => {
    const api = (window as unknown as {
      flow: { tasks: { list(r: { projectRoot: string }): Promise<Array<{ title: string; threadId: string | null }>> } }
    }).flow
    const tasks = await api.tasks.list({ projectRoot })
    return tasks.find((t) => t.title === 'Chat link task')?.threadId ?? null
  }, root)
  expect(threadId, 'a created task should be linked to a thread').not.toBeNull()

  // (b) Open the detail and click "Open chat" — the linked thread's composer opens.
  await card.click()
  const detail = window.locator('.fl-board-detail')
  await expect(detail).toBeVisible()
  await detail.locator('.fl-board-new', { hasText: 'Open chat' }).click()

  // The task's chat is now the active conversation (its composer is mounted).
  await expect(window.locator('.fl-composer')).toBeVisible({ timeout: 10_000 })

  expect(errors).toEqual([])
})
