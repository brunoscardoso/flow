import { test, expect } from '../fixtures/electron'
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed'
import { statusButtonByText } from '../selectors'
import type { Page } from '@playwright/test'

/**
 * #695 (tasks half) — the New Task modal lets the user pick additional context
 * folders (the other open projects); the task's spawned thread inherits them as
 * additional roots, so its agent reads them from the first turn.
 *
 * Credential-free: seed two projects, create a manual task in the first with the
 * second checked as context, then assert the task's thread carries the second as
 * an additional root (read from the store via tasks:list + threads:list).
 */

/** additionalRoots of the thread owned by the first task in `projectRoot`. */
async function firstTaskThreadRoots(win: Page, projectRoot: string): Promise<string[]> {
  return win.evaluate(async (root) => {
    const flow = (
      window as unknown as {
        flow: {
          tasks: { list(r: { projectRoot: string; includeArchived: boolean }): Promise<Array<{ threadId: string | null }>> }
          threads: { list(r: { projectRoot: string }): Promise<Array<{ id: string; additionalRoots: string[] }>> }
        }
      }
    ).flow
    const tasks = await flow.tasks.list({ projectRoot: root, includeArchived: false })
    const threadId = tasks[0]?.threadId ?? null
    if (!threadId) return []
    const threads = await flow.threads.list({ projectRoot: root })
    return threads.find((t) => t.id === threadId)?.additionalRoots ?? []
  }, projectRoot)
}

test.afterAll(() => cleanupSeeds())

test('New Task modal: additional context folders seed the task thread as extra roots (#695)', async ({
  window,
}) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  const dirA = await seedProject(window, 'flow-ux-taskctxA-')
  const dirB = await seedProject(window, 'flow-ux-taskctxB-')
  await activateProject(window, dirA)

  await window.locator(statusButtonByText('Tasks')).click()
  await window.locator('.fl-board-lane-btn[aria-label="New task"]').click()
  await expect(window.locator('.fl-board-modal')).toBeVisible()

  await window.locator('.fl-board-modal-body input[type="text"]').first().fill('Cross-repo task')

  // The Context folders picker lists the OTHER open project (B); check it.
  const ctxRow = window.locator('.fl-board-modal-context-row', { hasText: dirB.split('/').pop()! })
  await expect(ctxRow).toBeVisible()
  await ctxRow.locator('input[type="checkbox"]').check()

  await window.locator('.fl-board-modal .fl-board-new', { hasText: 'Create task' }).click()
  await expect(window.locator('.fl-board-modal')).toBeHidden()

  // The spawned thread carries B as an additional root.
  await expect
    .poll(async () => (await firstTaskThreadRoots(window, dirA)).includes(dirB), { timeout: 5000 })
    .toBe(true)

  expect(errors, errors.join(', ')).toHaveLength(0)
})
