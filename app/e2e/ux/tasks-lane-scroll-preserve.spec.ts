import { test, expect } from '../fixtures/electron'
import { sel, statusButtonByText } from '../selectors'
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed'
import type { Page } from '@playwright/test'

/**
 * Tasks board — LANE scroll preservation across a board re-render (flow 9).
 *
 * #204 fixed this class of bug for the task-DETAIL modal: a global
 * `tasks:updated` broadcast rebuilt the modal and snapped the reader's scroll to
 * the top mid-read. The board's own LANES look structurally identical —
 * `#render()` does `column.cards.textContent = ''` and re-appends every card —
 * yet they have no explicit scroll guard.
 *
 * They survive for a subtle reason worth pinning down: the scroll CONTAINER
 * (`.fl-board-cards`) is created once in the constructor and only its children
 * are swapped, synchronously, so no layout runs while it is empty and the
 * browser never clamps `scrollTop` to 0. The #204 modal differed because the
 * scrolling node itself (`.fl-board-detail-desc`) was recreated.
 *
 * That makes this a real regression risk: rebuilding lanes by recreating
 * `.fl-board-cards` (or awaiting between the clear and the re-append) would
 * silently start throwing a reader of a long backlog back to the top. Two user
 * paths reach the rebuild, and both are asserted here:
 *   A. a BACKGROUND update to an unrelated task (an agent bumping a sibling
 *      while the user reads the backlog) — `tasks:updated` → `refresh()`;
 *   B. the user's OWN drag — `#moveTask` paints optimistically via `#render()`.
 *
 * Account-independent (`tasks:create` + `tasks:update` IPC — no agent).
 * A `pageerror` listener fails the flow on any uncaught renderer error.
 */

test.afterAll(() => cleanupSeeds())

/** Enough cards that the Todo lane overflows and has a real scroll offset. */
const TODO_COUNT = 24

type TasksBridge = {
  flow: {
    tasks: {
      list(r: { projectRoot: string; includeArchived: boolean }): Promise<
        Array<{ id: string; lane: string; title: string }>
      >
      create(r: { projectRoot: string; title: string }): Promise<{ id: string }>
      update(r: { taskId: string; patch: Record<string, unknown> }): Promise<unknown>
    }
  }
}

const todoLane = (win: Page) => win.locator('.fl-board-column:not(.fl-board-remote) .fl-board-cards').first()
const doingLane = (win: Page) => win.locator('.fl-board-column:not(.fl-board-remote) .fl-board-cards').nth(1)

/** Seed a project, open the board, and fill Todo past one screen. */
async function seedBoard(window: Page): Promise<{ root: string; sideTaskId: string }> {
  const root = await seedProject(window, 'flow-ux-lanescroll-')
  await activateProject(window, root)

  // Create the backlog + one extra task through the real IPC bridge (the same
  // channel the New-task modal uses) — 25 modal round-trips would be pure noise.
  await window.evaluate(
    async ({ p, n }) => {
      const api = (window as unknown as TasksBridge).flow.tasks
      for (let i = 1; i <= n; i += 1) await api.create({ projectRoot: p, title: `Backlog ${i}` })
      await api.create({ projectRoot: p, title: 'Sibling task' })
    },
    { p: root, n: TODO_COUNT },
  )

  // Park the sibling in Doing so a background change to it leaves Todo untouched.
  const sideTaskId = await window.evaluate(async (p) => {
    const api = (window as unknown as TasksBridge).flow.tasks
    const list = await api.list({ projectRoot: p, includeArchived: false })
    const sibling = list.find((t) => t.title === 'Sibling task')!
    await api.update({ taskId: sibling.id, patch: { lane: 'doing' } })
    return sibling.id
  }, root)

  await window.locator(statusButtonByText('Tasks')).click()
  await expect(window.locator(sel.board)).toBeVisible()
  await expect
    .poll(async () => window.locator('.fl-board-column:not(.fl-board-remote) .fl-board-count').allTextContents())
    .toEqual([String(TODO_COUNT), '1', '0', '0', '0'])

  return { root, sideTaskId }
}

/** Scroll the Todo lane to the bottom; returns the resulting offset. */
async function scrollTodoToBottom(window: Page): Promise<number> {
  const lane = todoLane(window)
  // Precondition: the lane genuinely overflows, otherwise the check is vacuous.
  const overflows = await lane.evaluate((el) => el.scrollHeight > el.clientHeight + 8)
  expect(overflows).toBe(true)
  await lane.evaluate((el) => {
    el.scrollTop = el.scrollHeight
  })
  const offset = await lane.evaluate((el) => el.scrollTop)
  expect(offset).toBeGreaterThan(0)
  return offset
}

/** Uncaught-error capture. The board's own diagnostics are console.error by
 *  design, and Monaco emits benign "Canceled" rejections on teardown. */
function watchErrors(window: Page): string[] {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
  window.on('console', (m) => {
    if (m.type() === 'error' && !/Canceled|failed to (load|move|generate)/i.test(m.text())) {
      errors.push(`console.error: ${m.text()}`)
    }
  })
  return errors
}

test.describe('tasks board — lane scroll across a re-render', () => {
  test('a long Todo lane scrolls and keeps every card reachable', async ({ window }) => {
    const errors = watchErrors(window)

    await seedBoard(window)
    await scrollTodoToBottom(window)

    // The last card in the backlog is reachable after scrolling (the lane is a
    // real scroll container, not a clipped overflow).
    await expect(todoLane(window).locator('.fl-board-card').last()).toBeInViewport()
    expect(errors).toEqual([])
  })

  test('a background update to another lane does not reset this lane’s scroll', async ({
    window,
  }) => {
    const errors = watchErrors(window)
    const { sideTaskId } = await seedBoard(window)
    const scrolled = await scrollTodoToBottom(window)

    // Background mutation of the SIBLING task in Doing. Todo's contents are
    // unchanged — the user is just reading their backlog.
    await window.evaluate(async (id) => {
      await (window as unknown as TasksBridge).flow.tasks.update({
        taskId: id,
        patch: { title: 'Sibling task (edited)' },
      })
    }, sideTaskId)

    // Wait until the re-render has demonstrably run (the Doing card repaints),
    // so we assert AFTER refresh() had its chance to reset the scroll.
    await expect(doingLane(window).locator('.fl-board-card')).toHaveText(/Sibling task \(edited\)/)

    // The untouched Todo lane keeps the reader's place.
    expect(await todoLane(window).evaluate((el) => el.scrollTop)).toBe(scrolled)
    expect(errors).toEqual([])
  })

  test('dragging a card out of a scrolled lane keeps the lane near the reader’s place', async ({
    window,
  }) => {
    const errors = watchErrors(window)
    await seedBoard(window)
    const scrolled = await scrollTodoToBottom(window)

    // Drag the LAST Todo card (the one the user scrolled down to) into Doing,
    // via the native HTML5 DnD sequence the board's handlers listen for.
    const moved = await window.evaluate(() => {
      const cards = document
        .querySelectorAll('.fl-board-column:not(.fl-board-remote) .fl-board-cards')[0]!
        .querySelectorAll('.fl-board-card')
      const el = cards[cards.length - 1] as HTMLElement | undefined
      const target = document.querySelectorAll('.fl-board-column:not(.fl-board-remote) .fl-board-cards')[1] as HTMLElement | undefined
      if (!el || !target) return false
      const dt = new DataTransfer()
      el.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }))
      target.dispatchEvent(new DragEvent('dragover', { bubbles: true, dataTransfer: dt }))
      target.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: dt }))
      el.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }))
      return true
    })
    expect(moved).toBe(true)
    await expect
      .poll(async () => window.locator('.fl-board-column:not(.fl-board-remote) .fl-board-count').allTextContents())
      .toEqual([String(TODO_COUNT - 1), '2', '0', '0', '0'])

    // The lane lost a card, so the offset may drop by roughly a card height —
    // but it must never snap back to the top of the backlog.
    const after = await todoLane(window).evaluate((el) => el.scrollTop)
    expect(after).toBeGreaterThan(scrolled / 2)
    expect(errors).toEqual([])
  })
})
