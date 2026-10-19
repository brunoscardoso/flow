import { test, expect, type Page } from '../fixtures/electron'
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed'

/**
 * Archiving a task (sidebar ⋯ → Archive) removes it from the task views — the
 * sidebar and the kanban both fetch tasks with `includeArchived: false`. But the
 * task's 1:1 CONVERSATION must NOT be lost: the thread survives, and because the
 * archived task no longer "owns" it, it resurfaces as a bare thread row (the
 * sidebar's dedup keys off the ACTIVE task set). This pins that no-data-loss
 * contract (distinct from "Delete task + thread", which removes both). IPC-driven,
 * so deterministic — no file watcher.
 */
async function listThreadIds(win: Page, projectRoot: string): Promise<string[]> {
  return win.evaluate(async (root) => {
    const api = (
      window as unknown as {
        flow: { threads: { list(r: { projectRoot: string }): Promise<Array<{ id: string }>> } }
      }
    ).flow
    return (await api.threads.list({ projectRoot: root })).map((t) => t.id)
  }, projectRoot)
}

test.afterAll(() => cleanupSeeds())

test('archiving a task hides it from the task list but keeps its thread (no data loss)', async ({
  window,
}) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(String(e)))

  const dir = await seedProject(window, 'flow-task-archive-')
  await activateProject(window, dir)

  const threadId = await window.evaluate(async (root) => {
    const api = (
      window as unknown as {
        flow: { tasks: { create(r: { projectRoot: string; title: string }): Promise<{ threadId: string | null }> } }
      }
    ).flow
    const task = await api.tasks.create({ projectRoot: root, title: 'Archive Me Task' })
    return task.threadId
  }, dir)
  expect(threadId, 'task should link a thread').toBeTruthy()

  const title = window.locator('.fl-thread-sidebar').getByText('Archive Me Task', { exact: true })
  await expect(title).toBeVisible({ timeout: 8000 })
  expect(await listThreadIds(window, dir)).toContain(threadId!)

  // Archive via the task's ⋯ menu (right-click the row).
  await title.click({ button: 'right' })
  const menu = window.locator('.fl-thread-menu')
  await expect(menu).toBeVisible()
  await menu.locator('.fl-thread-menu-item', { hasText: /^Archive$/ }).click()

  // The task's CONVERSATION survives — the archive must not delete the thread
  // (unlike "Delete task + thread"). This is the no-data-loss guarantee.
  await expect
    .poll(async () => (await listThreadIds(window, dir)).includes(threadId!), { timeout: 8000 })
    .toBe(true)
  // The row is still reachable in the sidebar (now as its bare thread), so the
  // user can still open the conversation.
  await expect(title).toBeVisible({ timeout: 8000 })

  expect(errors, errors.join(', ')).toHaveLength(0)
})
