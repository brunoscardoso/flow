import { test, expect } from '../fixtures/electron'
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed'

/**
 * A thread row's hover actions (Pin, Archive) sit at the row's TRAILING edge.
 *
 * They used to follow the title, and in a Workspace — where the project tag
 * stands between title and date — that put Archive under the middle of the
 * row: the ordinary press that opens a thread archived it, with no
 * confirmation (found by the sidebar-selection-box spec, 2026-10-09).
 */
test.afterAll(() => cleanupSeeds())

test('pressing the middle of a hovered thread row opens it, and archives nothing', async ({ window }) => {
  const errors: string[] = []
  window.on('pageerror', (error) => errors.push(error.message))

  const alpha = await seedProject(window, 'flow-hover-alpha-')
  const beta = await seedProject(window, 'flow-hover-beta-')
  await activateProject(window, beta)
  await activateProject(window, alpha)
  const title = 'React Native version mismatch'
  const id = await window.evaluate(
    async (root) =>
      (
        await (window as unknown as {
          flow: { threads: { create(i: { projectRoot: string; title: string }): Promise<{ id: string }> } }
        }).flow.threads.create({ projectRoot: root, title: 'React Native version mismatch' })
      ).id,
    alpha,
  )

  const row = window.locator('.fl-thread-sidebar .row', { hasText: title }).first()
  await expect(row).toBeVisible({ timeout: 15_000 })
  // The precondition the bug needs: a project tag on the row, i.e. two projects.
  await expect
    .poll(() => window.evaluate(async () => (await (window as any).flow.project.list()).length))
    .toBeGreaterThanOrEqual(2)

  // The list re-renders as the second project settles; read the row's box once
  // it holds still rather than from an element about to be replaced.
  let box: { x: number; y: number; width: number; height: number } | null = null
  await expect
    .poll(async () => {
      box = await row.boundingBox().catch(() => null)
      return box !== null && box.width > 0
    })
    .toBe(true)
  if (box === null) throw new Error('row has no box')
  await window.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  // The hover actions are on screen (the positive) …
  await expect(row.locator('button[aria-label="Archive"]')).toBeVisible()
  // … and none of them is under the middle of the row.
  const underCentre = await window.evaluate(
    ({ x, y }) => {
      let el = document.elementFromPoint(x, y)
      while (el?.shadowRoot) {
        const inner = el.shadowRoot.elementFromPoint(x, y)
        if (inner === null || inner === el) break
        el = inner
      }
      return el?.closest('button')?.getAttribute('aria-label') ?? null
    },
    { x: box.x + box.width / 2, y: box.y + box.height / 2 },
  )
  expect(underCentre).toBeNull()

  // Actions sit at the trailing edge: right of every other piece of the row.
  const archiveBox = await row.locator('button[aria-label="Archive"]').boundingBox()
  expect(archiveBox!.x).toBeGreaterThan(box.x + box.width * 0.75)

  await window.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
  await expect(window.locator('.fl-thread-sidebar .fl-row-current', { hasText: title })).toBeVisible()
  const archived = await window.evaluate(
    async (threadId) =>
      (await (window as any).flow.threads.get({ threadId }))?.archivedAt ?? null,
    id,
  )
  expect(archived).toBeNull()
  expect(errors).toEqual([])
})
