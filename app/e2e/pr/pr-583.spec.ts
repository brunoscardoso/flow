import { test, expect } from '../fixtures/electron'
import { sel, statusButtonByText } from '../selectors'
import { seedProject, activateProject, cleanupSeeds } from '../ux/fixtures/seed'

/**
 * Regression for PR #583 — "preserve the New-task draft on accidental close (#561)".
 *
 * Dismissing the New-task modal WITHOUT creating (Escape / backdrop / Cancel) used
 * to discard the typed title / description / reference / Start-with. #583 snapshots
 * the draft on a non-creating close and restores it on reopen; a SUCCESSFUL create
 * clears it. These probes drive the real modal against a seeded throwaway project
 * (no account needed — pure manual paths, so they run headless) and assert the
 * observable behavior:
 *
 *   - Escape-dismiss then reopen → the typed title & description are restored.
 *   - Cancel-dismiss then reopen → the "Start with" field is restored.
 *   - A successful manual create → the next reopen is blank (draft cleared).
 *
 * Each assertion describes the EXPECTED (correct) behavior and passes on fixed `main`.
 */
test.afterAll(() => cleanupSeeds())

async function openBoard(window: import('@playwright/test').Page): Promise<void> {
  const root = await seedProject(window)
  await activateProject(window, root)
  await window.locator(statusButtonByText('Tasks')).click()
  await expect(window.locator(sel.board)).toBeVisible()
}

const openNewTask = (window: import('@playwright/test').Page) =>
  window.locator('.fl-board-lane-btn[aria-label="New task"]')

const modal = (window: import('@playwright/test').Page) => window.locator('.fl-board-modal')
const titleInput = (window: import('@playwright/test').Page) =>
  window.locator('.fl-board-modal-body input[type="text"]').first()
const descInput = (window: import('@playwright/test').Page) =>
  window.locator('.fl-board-modal-body textarea')
const startWith = (window: import('@playwright/test').Page) =>
  window.locator('.fl-board-modal input[list="fl-flow-commands"]')

test.describe('tasks board — New-task draft preservation (#561)', () => {
  test('restores the typed title & description after an Escape dismiss', async ({ window }) => {
    await openBoard(window)
    await openNewTask(window).click()
    await expect(modal(window)).toBeVisible()

    await titleInput(window).fill('Draft that should survive')
    await descInput(window).fill('A description I do not want to lose.')

    // Accidental dismiss — Escape closes the modal WITHOUT creating.
    await window.keyboard.press('Escape')
    await expect(modal(window)).toBeHidden()

    // Reopen: the draft is restored (was: wiped to empty before #583).
    await openNewTask(window).click()
    await expect(modal(window)).toBeVisible()
    await expect(titleInput(window)).toHaveValue('Draft that should survive')
    await expect(descInput(window)).toHaveValue('A description I do not want to lose.')
  })

  test('restores the "Start with" field after a Cancel dismiss', async ({ window }) => {
    await openBoard(window)
    await openNewTask(window).click()
    await expect(modal(window)).toBeVisible()

    await titleInput(window).fill('Keep me')
    await startWith(window).fill('/review-pr')

    // Cancel is a non-creating close — the draft must persist.
    await window.locator('.fl-board-modal .fl-board-ghost', { hasText: 'Cancel' }).click()
    await expect(modal(window)).toBeHidden()

    await openNewTask(window).click()
    await expect(modal(window)).toBeVisible()
    await expect(startWith(window)).toHaveValue('/review-pr')
    await expect(titleInput(window)).toHaveValue('Keep me')
  })

  test('clears the draft after a successful create', async ({ window }) => {
    await openBoard(window)
    await openNewTask(window).click()
    await expect(modal(window)).toBeVisible()

    await titleInput(window).fill('Task to actually create')
    await descInput(window).fill('Body text.')

    // Create the task (manual path — no Start-with, so no agent turn is needed).
    await window.locator('.fl-board-new', { hasText: 'Create task' }).click()
    // On success the modal closes.
    await expect(modal(window)).toBeHidden()

    // Reopen: a completed create must have cleared the draft — blank fields.
    await openNewTask(window).click()
    await expect(modal(window)).toBeVisible()
    await expect(titleInput(window)).toHaveValue('')
    await expect(descInput(window)).toHaveValue('')
  })
})
