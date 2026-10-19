import { test, expect } from '../fixtures/electron'
import { sel, statusButtonByText } from '../selectors'
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed'

/**
 * Tasks board "New task" modal UX regression guards — flow 9 of the progressive sweep.
 *
 * Two bugs found by driving the modal against a seeded throwaway project, now FIXED:
 *
 *   #442 (fixed in PR #445) — switching source tabs (From scratch ↔ Jira/GitHub/Azure)
 *          silently wiped the typed title & description, while the sibling "Start with"
 *          / "Skip permission prompts" fields survived the same switch (inconsistent
 *          data loss). The board now caches the draft across renders.
 *   #443 (fixed in PR #447) — double-clicking "+ New task" opened then instantly
 *          dismissed the modal: the second mousedown of the double-click hit the
 *          freshly-opened overlay backdrop and closed it, so the primary CTA looked
 *          like a dead click. A double-click-window dismiss guard + re-entrancy latch
 *          now keeps the modal open.
 *
 * Each assertion describes the EXPECTED (correct) behavior and passes on fixed `main`;
 * these are the durable regression guards. No account needed — pure manual-modal
 * paths, so they run headless in CI.
 */
test.afterAll(() => cleanupSeeds())

async function openBoard(window: import('@playwright/test').Page): Promise<void> {
  const root = await seedProject(window)
  await activateProject(window, root)
  await window.locator(statusButtonByText('Tasks')).click()
  await expect(window.locator(sel.board)).toBeVisible()
}

test.describe('tasks board — New task modal', () => {
  test('preserves the typed title & description across a source-tab round-trip (#442)', async ({
    window,
  }) => {
    await openBoard(window)
    await window.locator('.fl-board-lane-btn[aria-label="New task"]').click()
    await expect(window.locator('.fl-board-modal')).toBeVisible()

    const title = () => window.locator('.fl-board-modal-body input[type="text"]').first()
    const desc = () => window.locator('.fl-board-modal-body textarea')
    await title().fill('Careful title')
    await desc().fill('Long description typed by user.')

    // Round-trip to another source tab and back.
    await window.locator('.fl-board-modal-tab', { hasText: 'Jira' }).click()
    await window.locator('.fl-board-modal-tab', { hasText: 'From scratch' }).click()

    // The draft survives (as "Start with" / "Skip" already do) — fixed in PR #445.
    await expect(title()).toHaveValue('Careful title')
    await expect(desc()).toHaveValue('Long description typed by user.')
  })

  test('preserves the "Start with" / "Skip" fields across a tab round-trip (control)', async ({
    window,
  }) => {
    // Control: these out-of-body siblings DO persist — proving #442 is an
    // inconsistency, not an intentional full-form reset. This one passes today.
    await openBoard(window)
    await window.locator('.fl-board-lane-btn[aria-label="New task"]').click()
    await expect(window.locator('.fl-board-modal')).toBeVisible()
    const startWith = () => window.locator('.fl-board-modal input[list="fl-flow-commands"]')
    const skip = () => window.locator('.fl-board-modal-skip input[type="checkbox"]')
    await startWith().fill('/review-pr')
    await skip().check()
    await window.locator('.fl-board-modal-tab', { hasText: 'Jira' }).click()
    await window.locator('.fl-board-modal-tab', { hasText: 'From scratch' }).click()
    await expect(startWith()).toHaveValue('/review-pr')
    await expect(skip()).toBeChecked()
  })

  test('keeps the modal open when "+ New task" is double-clicked (#443)', async ({ window }) => {
    await openBoard(window)
    const newBtn = window.locator('.fl-board-lane-btn[aria-label="New task"]')
    await newBtn.dblclick()
    // The modal opens and stays — fixed in PR #447 (was: 2nd click closed it, 0 overlays).
    await expect(window.locator('.fl-board-modal')).toBeVisible()
    expect(await window.locator('.fl-board-modal-overlay').count()).toBe(1)
  })

  test('opens the modal on a single click of "+ New task" (control)', async ({ window }) => {
    // Control: the single-click path works — isolates #443 to the double-click.
    await openBoard(window)
    await window.locator('.fl-board-lane-btn[aria-label="New task"]').click()
    await expect(window.locator('.fl-board-modal')).toBeVisible()
    expect(await window.locator('.fl-board-modal-overlay').count()).toBe(1)
  })
})
