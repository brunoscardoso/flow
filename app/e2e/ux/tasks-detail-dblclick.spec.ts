import { test, expect } from '../fixtures/electron'
import { sel, statusButtonByText } from '../selectors'
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed'
import type { Page } from '@playwright/test'

/**
 * Tasks board — double-clicking a task card and the detail modal (flow 9 sweep).
 *
 * The "+ New task" modal got a double-click dismiss guard (#443): its
 * position:fixed;inset:0 overlay covers the button that opened it, so a
 * double-click's second mousedown lands on the fresh backdrop and would
 * instantly dismiss the just-opened modal — unless a `backdropDismissAllowed`
 * guard ignores a dismiss arriving within the double-click window.
 *
 * The task-DETAIL modal (`#openTaskDetail`, opened by a card click) shares the
 * identical overlay + `target === overlay → close` backdrop handler but has NO
 * such guard, so double-clicking a card opens then instantly closes it —
 * dead-feeling and inconsistent with the sibling New-task modal. Filed as #511.
 *
 * - The single-click control passes on `main` (opens and stays).
 * - The double-click guard is a `test.fixme` documenting the EXPECTED behavior
 *   (detail stays open on a double-click) that FAILS today; flip it live once
 *   #511 lands (mirror `backdropDismissAllowed` into `#openTaskDetail`).
 */
test.afterAll(() => cleanupSeeds())

async function seedTaskAndOpenBoard(window: Page): Promise<void> {
  const root = await seedProject(window)
  await activateProject(window, root)
  await window.locator(statusButtonByText('Tasks')).click()
  await expect(window.locator(sel.board)).toBeVisible()
  // Create one manual task so a card exists.
  await window.locator('.fl-board-lane-btn[aria-label="New task"]').click()
  await expect(window.locator('.fl-board-modal')).toBeVisible()
  await window.locator('.fl-board-modal-body input[type="text"]').first().fill('Card to open')
  await window.locator('.fl-board-modal .fl-board-new', { hasText: 'Create task' }).click()
  await expect(window.locator('.fl-board-modal')).toBeHidden()
  await window.locator(statusButtonByText('Tasks')).click()
  await expect(window.locator(sel.board)).toBeVisible()
  await expect(window.locator('.fl-board-card', { hasText: 'Card to open' })).toBeVisible()
}

test.describe('tasks board — card detail modal', () => {
  test('single click on a card opens the detail modal and it stays (control)', async ({
    window,
  }) => {
    const errors: string[] = []
    window.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
    window.on('console', (m) => {
      if (m.type() === 'error') errors.push(`console.error: ${m.text()}`)
    })
    await seedTaskAndOpenBoard(window)

    await window.locator('.fl-board-card', { hasText: 'Card to open' }).click()
    await expect(window.locator('.fl-board-detail')).toBeVisible()
    expect(await window.locator('.fl-board-modal-overlay').count()).toBe(1)

    expect(errors).toEqual([])
  })

  // #511: double-clicking a card must keep the detail modal open, like the
  // New-task modal does after #443. It currently flashes open then closes —
  // remove `.fixme` once `#openTaskDetail` adopts `backdropDismissAllowed`.
  test.fixme('double-clicking a card keeps the detail modal open (#511)', async ({ window }) => {
    await seedTaskAndOpenBoard(window)
    const card = window.locator('.fl-board-card', { hasText: 'Card to open' })
    await card.dblclick()
    // Expected once fixed: the detail modal opens and STAYS (no backdrop flash-close).
    await expect(window.locator('.fl-board-detail')).toBeVisible()
    expect(await window.locator('.fl-board-modal-overlay').count()).toBe(1)
  })
})
