import { test, expect } from '../fixtures/electron'
import { sel, statusButtonByText } from '../selectors'
import { seedProject, activateProject, cleanupSeeds } from '../ux/fixtures/seed'

/**
 * Regression for PR #602 — "New-task draft keyed by project (no cross-project leak) (#591)".
 *
 * #583/#561 preserves a typed-but-dismissed New-task draft so an accidental close
 * doesn't lose work. That draft lived on a single board-global field restored
 * UNCONDITIONALLY, so a draft typed + dismissed in project A reappeared in project
 * B's New-task modal (#591) — leaking one project's title/description and, worse,
 * an import reference (risking importing A's issue into B). #602 tags the preserved
 * draft with the project root it was typed in and restores it only when the roots
 * match (`restorableDraft`).
 *
 * These probes drive the real modal across TWO seeded throwaway projects (pure
 * manual paths, so they run headless) and assert the observable behavior:
 *
 *   - A draft typed + dismissed in project A does NOT appear in project B's modal.
 *   - The draft is not globally wiped by a mere project switch — returning to A
 *     (without touching B's modal) still restores it, proving it's KEYED, not lost.
 *
 * Each assertion describes the EXPECTED (correct) behavior and passes on fixed `main`.
 */
test.afterAll(() => cleanupSeeds())

async function showBoard(window: import('@playwright/test').Page): Promise<void> {
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

test.describe('tasks board — New-task draft is project-scoped (#591)', () => {
  test('a draft typed in project A does NOT leak into project B', async ({ window }) => {
    const projA = await seedProject(window, 'flow-proj-a-')
    const projB = await seedProject(window, 'flow-proj-b-')

    // Type + dismiss a draft in project A.
    await activateProject(window, projA)
    await showBoard(window)
    await openNewTask(window).click()
    await expect(modal(window)).toBeVisible()
    await titleInput(window).fill('Project A secret task')
    await descInput(window).fill('Body that belongs ONLY to project A.')
    await window.keyboard.press('Escape')
    await expect(modal(window)).toBeHidden()

    // Switch to project B and open its New-task modal — A's draft must NOT appear.
    await activateProject(window, projB)
    await showBoard(window)
    await openNewTask(window).click()
    await expect(modal(window)).toBeVisible()
    await expect(titleInput(window)).toHaveValue('')
    await expect(descInput(window)).toHaveValue('')
  })

  test("a project switch alone doesn't wipe A's draft — returning restores it", async ({
    window,
  }) => {
    const projA = await seedProject(window, 'flow-proj-a2-')
    const projB = await seedProject(window, 'flow-proj-b2-')

    // Type + dismiss a draft in project A.
    await activateProject(window, projA)
    await showBoard(window)
    await openNewTask(window).click()
    await expect(modal(window)).toBeVisible()
    await titleInput(window).fill('Keep me for A')
    await descInput(window).fill('Still mine on return.')
    await window.keyboard.press('Escape')
    await expect(modal(window)).toBeHidden()

    // Switch AWAY to B without touching its New-task modal, then back to A.
    await activateProject(window, projB)
    await showBoard(window)
    await activateProject(window, projA)
    await showBoard(window)

    // A's keyed draft survived the round-trip and restores on reopen.
    await openNewTask(window).click()
    await expect(modal(window)).toBeVisible()
    await expect(titleInput(window)).toHaveValue('Keep me for A')
    await expect(descInput(window)).toHaveValue('Still mine on return.')
  })
})
