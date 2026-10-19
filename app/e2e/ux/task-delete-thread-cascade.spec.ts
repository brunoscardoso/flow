import { test, expect, type Page } from '../fixtures/electron'
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed'

/**
 * A task owns a 1:1 thread. Deleting the task from the sidebar's ⋯ menu ("Delete
 * task + thread") must ALSO delete that thread — otherwise a dangling, ownerless
 * thread is left behind. The cascade lives in the tasks:delete IPC handler
 * (taskStore.deleteTask returns the threadId → threadStore.deleteThread). No spec
 * guarded it; this drives the real menu and asserts the thread is gone from the
 * store afterward. Credential-free (task create + local store only).
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

test('deleting a task from the sidebar cascades to its 1:1 thread (no dangling thread)', async ({
  window,
}) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(String(e)))

  const dir = await seedProject(window, 'flow-task-cascade-')
  await activateProject(window, dir)

  // Create a task via the real IPC — it spawns and links its 1:1 thread.
  const threadId = await window.evaluate(async (root) => {
    const api = (
      window as unknown as {
        flow: { tasks: { create(r: { projectRoot: string; title: string }): Promise<{ threadId: string | null }> } }
      }
    ).flow
    const task = await api.tasks.create({ projectRoot: root, title: 'Cascade Delete Me' })
    return task.threadId
  }, dir)
  expect(threadId, 'task should link a thread').toBeTruthy()

  // The thread exists in the store, and the task row shows in the sidebar.
  expect(await listThreadIds(window, dir)).toContain(threadId!)
  const taskTitle = window
    .locator('.fl-thread-sidebar')
    .getByText('Cascade Delete Me', { exact: true })
  await expect(taskTitle).toBeVisible({ timeout: 8000 })

  // Open the task's actions menu (right-click the row) → "Delete task + thread".
  await taskTitle.click({ button: 'right' })
  const menu = window.locator('.fl-thread-menu')
  await expect(menu).toBeVisible()
  await menu.locator('.fl-thread-menu-item', { hasText: 'Delete task + thread' }).click()

  // #1501: that item does not delete — it swaps the menu for a named confirm
  // ("Delete “<title>” and its chat?" / Cancel / Delete both), added with the
  // task menus' destructive-action gates (#1173, #1390). This spec predates the
  // gate and asserted the row was gone straight after the first click, so it has
  // been failing on main ever since — reporting a fixed guard as a broken
  // cascade. Click through the confirm, which is what a user does.
  const confirm = window.locator('.fl-thread-menu-confirm')
  await expect(confirm).toBeVisible()
  await expect(confirm).toContainText('Cascade Delete Me')
  // The safe default holds the focus, so Enter can never be the destructive
  // answer (#1173) — press the button explicitly.
  await menu.locator('.fl-thread-menu-item', { hasText: 'Delete both' }).click()

  // The task row is gone AND the cascade removed its thread from the store.
  await expect(taskTitle).toHaveCount(0, { timeout: 8000 })
  await expect
    .poll(async () => (await listThreadIds(window, dir)).includes(threadId!), { timeout: 8000 })
    .toBe(false)

  expect(errors, errors.join(', ')).toHaveLength(0)
})

test('cancelling the delete confirm keeps the task AND its thread (#1501)', async ({ window }) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(String(e)))

  const dir = await seedProject(window, 'flow-task-cascade-keep-')
  await activateProject(window, dir)

  const threadId = await window.evaluate(async (root) => {
    const api = (
      window as unknown as {
        flow: {
          tasks: {
            create(r: { projectRoot: string; title: string }): Promise<{ threadId: string | null }>
          }
        }
      }
    ).flow
    const task = await api.tasks.create({ projectRoot: root, title: 'Keep Me' })
    return task.threadId
  }, dir)
  expect(threadId).toBeTruthy()

  const taskTitle = window.locator('.fl-thread-sidebar').getByText('Keep Me', { exact: true })
  await expect(taskTitle).toBeVisible({ timeout: 8000 })

  await taskTitle.click({ button: 'right' })
  const menu = window.locator('.fl-thread-menu')
  await menu.locator('.fl-thread-menu-item', { hasText: 'Delete task + thread' }).click()
  await expect(window.locator('.fl-thread-menu-confirm')).toBeVisible()
  await menu.locator('.fl-thread-menu-item', { hasText: 'Cancel' }).click()

  // Nothing destroyed — the gate is only worth having if backing out really backs out.
  await expect(taskTitle).toBeVisible()
  expect(await listThreadIds(window, dir)).toContain(threadId!)

  expect(errors, errors.join(', ')).toHaveLength(0)
})
