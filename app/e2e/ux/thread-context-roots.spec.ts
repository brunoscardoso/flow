import { test, expect } from '../fixtures/electron'
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed'
import type { Page } from '@playwright/test'

/**
 * #695 — add more folders as context to an EXISTING thread. With 2+ open projects,
 * a thread's ⋯ menu offers "Add folder to context…", which opens a picker of the
 * other open projects; applying sets them as the thread's additional roots (the
 * agent reads them on its next turn via additionalDirectories).
 *
 * Drives it credential-free: seed two projects, create a thread in the first, add
 * the second as context via the menu, and assert the thread's additionalRoots now
 * includes it (queried from the store via threads:list).
 */

function threadRow(win: Page, title: string) {
  return win.locator('fl-list').getByText(title, { exact: true })
}

/** additionalRoots for the first thread of a project, read from the store. */
async function firstThreadRoots(win: Page, projectRoot: string): Promise<string[]> {
  return win.evaluate(async (root) => {
    const api = (
      window as unknown as {
        flow: { threads: { list(r: { projectRoot: string }): Promise<Array<{ additionalRoots: string[] }>> } }
      }
    ).flow
    const threads = await api.threads.list({ projectRoot: root })
    return threads[0]?.additionalRoots ?? []
  }, projectRoot)
}

test.afterAll(() => cleanupSeeds())

test('an existing thread can add another open project as a context root (#695)', async ({
  window,
}) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  const dirA = await seedProject(window, 'flow-ux-ctxA-')
  const dirB = await seedProject(window, 'flow-ux-ctxB-')
  await activateProject(window, dirA)

  // Create a thread scoped to A only. The multi-project chooser "+" used to open
  // was retired with the new-thread page (2026-09-04); the thread is made over
  // the IPC that page ends in — this spec is about the row menu, not creation.
  await window.evaluate(async (root) => {
    const flow = (
      window as unknown as {
        flow: { threads: { create(i: { projectRoot: string; title: string }): Promise<unknown> } }
      }
    ).flow
    await flow.threads.create({ projectRoot: root, title: 'New thread' })
  }, dirA)
  await expect(threadRow(window, 'New thread').first()).toBeVisible({ timeout: 10000 })

  // It starts with no additional roots.
  expect(await firstThreadRoots(window, dirA)).toEqual([])

  // Open the row menu → Add folder to context…
  await threadRow(window, 'New thread').first().click({ button: 'right' })
  const menu = window.locator('.fl-thread-menu')
  await expect(menu).toBeVisible()
  await menu.locator('.fl-thread-menu-item', { hasText: 'Add folder to context' }).click()

  // The context picker lists the OTHER project (B); check it and Apply.
  await expect(window.getByText('Context folders for this thread', { exact: true })).toBeVisible()
  const overlay = window.locator('.fl-context-roots-overlay')
  // Browse… escape hatch for folders not yet opened in Flow (2026-07-22) —
  // the native dialog itself can't be driven headlessly, but the affordance
  // must be offered.
  await expect(overlay.locator('.fl-context-roots-browse')).toBeVisible()
  const boxes = overlay.locator('input[type="checkbox"]')
  await expect(boxes).toHaveCount(1) // only B (A is the primary, excluded)
  await boxes.first().check()
  await overlay.locator('.fl-context-roots-apply').click()

  // The thread now spans B as an additional root.
  await expect
    .poll(async () => (await firstThreadRoots(window, dirA)).includes(dirB), { timeout: 5000 })
    .toBe(true)

  expect(errors, errors.join(', ')).toHaveLength(0)
})
