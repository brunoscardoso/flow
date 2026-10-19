import { test, expect, type Page } from '../fixtures/electron'
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed'

/**
 * A task and its 1:1 thread are created with the SAME title (createManualTask).
 * Renaming the task (sidebar ⋯ → Rename → tasks:update {title}) must keep the
 * thread's title in sync — otherwise the conversation header, and the bare-thread
 * row the thread falls back to once the task is archived, keep the STALE old name.
 * Regression for tasks:update not propagating the title to the linked thread.
 */
async function taskTitle(win: Page, projectRoot: string, taskId: string): Promise<string | null> {
  return win.evaluate(
    async ({ root, id }) => {
      const api = (
        window as unknown as {
          flow: {
            tasks: {
              list(r: {
                projectRoot: string
                includeArchived?: boolean
              }): Promise<Array<{ id: string; title: string }>>
            }
          }
        }
      ).flow
      const tasks = await api.tasks.list({ projectRoot: root, includeArchived: true })
      return tasks.find((t) => t.id === id)?.title ?? null
    },
    { root: projectRoot, id: taskId },
  )
}

async function threadTitle(win: Page, projectRoot: string, threadId: string): Promise<string | null> {
  return win.evaluate(
    async ({ root, id }) => {
      const api = (
        window as unknown as {
          flow: { threads: { list(r: { projectRoot: string }): Promise<Array<{ id: string; title: string }>> } }
        }
      ).flow
      const threads = await api.threads.list({ projectRoot: root })
      return threads.find((t) => t.id === id)?.title ?? null
    },
    { root: projectRoot, id: threadId },
  )
}

test.afterAll(() => cleanupSeeds())

test('renaming a task renames its 1:1 thread too (no stale title)', async ({ window }) => {
  const dir = await seedProject(window, 'flow-task-rename-')
  await activateProject(window, dir)

  const { taskId, threadId } = await window.evaluate(async (root) => {
    const api = (
      window as unknown as {
        flow: {
          tasks: {
            create(r: { projectRoot: string; title: string }): Promise<{ id: string; threadId: string | null }>
          }
        }
      }
    ).flow
    const task = await api.tasks.create({ projectRoot: root, title: 'Rename Sync Old' })
    return { taskId: task.id, threadId: task.threadId }
  }, dir)
  expect(threadId).toBeTruthy()
  expect(await threadTitle(window, dir, threadId!)).toBe('Rename Sync Old')

  // Rename the task — the same call the sidebar ⋯ "Rename" makes.
  await window.evaluate(
    async ({ id }) => {
      const api = (
        window as unknown as {
          flow: { tasks: { update(r: { taskId: string; patch: { title: string } }): Promise<unknown> } }
        }
      ).flow
      await api.tasks.update({ taskId: id, patch: { title: 'Rename Sync New' } })
    },
    { id: taskId },
  )

  // The linked thread must carry the new title, not the stale one.
  await expect
    .poll(async () => threadTitle(window, dir, threadId!), { timeout: 5000 })
    .toBe('Rename Sync New')
})

/**
 * #1447 — the same identity, in the other direction. Searching the sidebar drops
 * its task layer, so a task's chat "appears as an ordinary row" (#1061) carrying
 * the ordinary thread menu, Rename included. That Rename wrote the THREAD only,
 * so the board card, the detail modal and the idle sidebar row all kept the old
 * name: the name the user just typed appeared nowhere, and search could not find
 * the chat by the name its own row was displaying.
 */
test('renaming a task’s CHAT renames the task too — one object, one name (#1447)', async ({
  window,
}) => {
  const dir = await seedProject(window, 'flow-thread-rename-')
  await activateProject(window, dir)

  const { taskId, threadId } = await window.evaluate(async (root) => {
    const api = (
      window as unknown as {
        flow: {
          tasks: {
            create(r: {
              projectRoot: string
              title: string
            }): Promise<{ id: string; threadId: string | null }>
          }
        }
      }
    ).flow
    const task = await api.tasks.create({ projectRoot: root, title: 'Alpha widget' })
    return { taskId: task.id, threadId: task.threadId }
  }, dir)
  expect(threadId).toBeTruthy()

  // The rename the flattened thread row offers — threads:update, not tasks:update.
  await window.evaluate(
    async ({ id }) => {
      const api = (
        window as unknown as {
          flow: {
            threads: {
              update(r: { threadId: string; patch: { title: string } }): Promise<unknown>
            }
          }
        }
      ).flow
      await api.threads.update({ threadId: id, patch: { title: 'Ticket 42 rewrite auth' } })
    },
    { id: threadId },
  )

  // Both sides carry the typed name — no second name left anywhere.
  await expect
    .poll(async () => taskTitle(window, dir, taskId), { timeout: 5000 })
    .toBe('Ticket 42 rewrite auth')
  expect(await threadTitle(window, dir, threadId!)).toBe('Ticket 42 rewrite auth')

  // And the board row shows it, which is where the old name used to persist.
  await expect(
    window.locator('.fl-thread-sidebar').getByText('Ticket 42 rewrite auth', { exact: true }),
  ).toBeVisible({ timeout: 8000 })
})

test('renaming a bare thread that no task owns still works (#1447)', async ({ window }) => {
  const dir = await seedProject(window, 'flow-bare-rename-')
  await activateProject(window, dir)

  const threadId = await window.evaluate(async (root) => {
    const api = (
      window as unknown as {
        flow: { threads: { create(i: { projectRoot: string; title: string }): Promise<{ id: string }> } }
      }
    ).flow
    return (await api.threads.create({ projectRoot: root, title: 'Just a chat' })).id
  }, dir)

  await window.evaluate(
    async ({ id }) => {
      const api = (
        window as unknown as {
          flow: {
            threads: { update(r: { threadId: string; patch: { title: string } }): Promise<unknown> }
          }
        }
      ).flow
      await api.threads.update({ threadId: id, patch: { title: 'Renamed chat' } })
    },
    { id: threadId },
  )

  expect(await threadTitle(window, dir, threadId)).toBe('Renamed chat')
})
