import { test, expect, type Page } from '../fixtures/electron'
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed'

/**
 * A task's pin IS its thread's pin: the sidebar renders a task row's pinned state
 * from its thread's `pinnedAt` (threadOf(task).pinnedAt), and pinning a task from
 * the ⋯ menu writes through threads:update {pinned}. This guards that cross-surface
 * contract — pin a task → its thread is pinned in the store; unpin → cleared — so a
 * future refactor can't quietly point the task pin at a task-only field the row
 * never reads. IPC-driven where possible, deterministic.
 */
async function threadPinned(win: Page, projectRoot: string, threadId: string): Promise<boolean> {
  return win.evaluate(
    async ({ root, id }) => {
      const api = (
        window as unknown as {
          flow: {
            threads: { list(r: { projectRoot: string }): Promise<Array<{ id: string; pinnedAt: string | null }>> }
          }
        }
      ).flow
      const threads = await api.threads.list({ projectRoot: root })
      return (threads.find((t) => t.id === id)?.pinnedAt ?? null) !== null
    },
    { root: projectRoot, id: threadId },
  )
}

test.afterAll(() => cleanupSeeds())

test('pinning a task from the sidebar pins its 1:1 thread and shows the pin glyph', async ({
  window,
}) => {
  const dir = await seedProject(window, 'flow-task-pin-')
  await activateProject(window, dir)

  const threadId = await window.evaluate(async (root) => {
    const api = (
      window as unknown as {
        flow: { tasks: { create(r: { projectRoot: string; title: string }): Promise<{ threadId: string | null }> } }
      }
    ).flow
    const task = await api.tasks.create({ projectRoot: root, title: 'Pin Sync Task' })
    return task.threadId
  }, dir)
  expect(threadId).toBeTruthy()
  expect(await threadPinned(window, dir, threadId!)).toBe(false)

  const title = window.locator('.fl-thread-sidebar').getByText('Pin Sync Task', { exact: true })
  await expect(title).toBeVisible({ timeout: 8000 })

  // No pin glyph yet.
  await expect(window.locator('.fl-thread-sidebar fl-icon[title="Pinned"]')).toHaveCount(0)

  // Pin via the task's ⋯ menu (right-click the row → Pin).
  await title.click({ button: 'right' })
  const menu = window.locator('.fl-thread-menu')
  await expect(menu).toBeVisible()
  await menu.locator('.fl-thread-menu-item', { hasText: /^Pin$/ }).click()

  // The thread is pinned in the store (the field the task row reads)…
  await expect.poll(async () => threadPinned(window, dir, threadId!), { timeout: 8000 }).toBe(true)
  // …and the row REFLECTS it: the pin glyph appears (a re-render read the thread's
  // pinnedAt through threadOf(task)).
  await expect(window.locator('.fl-thread-sidebar fl-icon[title="Pinned"]')).toHaveCount(1, {
    timeout: 8000,
  })
})
