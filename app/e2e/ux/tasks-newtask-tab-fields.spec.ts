import { test, expect } from '../fixtures/electron'
import { sel, statusButtonByText } from '../selectors'
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed'

/**
 * Tasks board — "New task" modal per-source-tab field behavior (flow 9 sweep).
 *
 * #442 (PR #445) proved the MANUAL title/description survive a source-tab
 * round-trip. This probes the two adjacent, previously-un-probed seams on the
 * IMPORT tabs (Jira / GitHub / Azure), each of which shares one modal:
 *
 *   1. Per-tab ref isolation + preservation — each import tab owns its own
 *      reference slot (`draft.refs[selected]`). A key typed on Jira must NOT
 *      leak into GitHub's field, and switching back to Jira must restore it.
 *      A leak would make the user import the wrong provider's reference.
 *   2. Submit-button disabled state crossing a tab switch (#412 × #442) — a
 *      valid manual title enables "Create task"; switching to an import tab
 *      whose ref is empty must DISABLE the button (feedback, not a dead click);
 *      typing a ref re-enables it; switching back to manual restores both the
 *      title and the enabled "Create task" button.
 *
 * Each assertion states the EXPECTED behavior and passes on current `main` —
 * a durable regression guard. No account needed (pure modal-state paths).
 */
test.afterAll(() => cleanupSeeds())

async function openNewTaskModal(window: import('@playwright/test').Page): Promise<void> {
  const root = await seedProject(window)
  await activateProject(window, root)
  await window.locator(statusButtonByText('Tasks')).click()
  await expect(window.locator(sel.board)).toBeVisible()
  await window.locator('.fl-board-lane-btn[aria-label="New task"]').click()
  await expect(window.locator('.fl-board-modal')).toBeVisible()
}

const bodyInput = (win: import('@playwright/test').Page) =>
  win.locator('.fl-board-modal-body input[type="text"]').first()
const tab = (win: import('@playwright/test').Page, label: string) =>
  win.locator('.fl-board-modal-tab', { hasText: label })
const submitBtn = (win: import('@playwright/test').Page) =>
  win.locator('.fl-board-modal-actions .fl-board-new')

test.describe('tasks board — New task import-tab fields', () => {
  test('import ref is per-provider: no leak between Jira/GitHub, restored on return', async ({
    window,
  }) => {
    const errors: string[] = []
    window.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
    window.on('console', (m) => {
      if (m.type() === 'error') errors.push(`console.error: ${m.text()}`)
    })

    await openNewTaskModal(window)

    // Type a Jira reference on the Jira tab.
    await tab(window, 'Jira').click()
    await bodyInput(window).fill('PRJ-123')
    await expect(bodyInput(window)).toHaveValue('PRJ-123')

    // Switch to GitHub — its own ref slot is EMPTY (Jira's key must not leak).
    await tab(window, 'GitHub').click()
    await expect(bodyInput(window)).toHaveValue('')
    await bodyInput(window).fill('https://github.com/acme/repo/issues/7')

    // Back to Jira — the Jira key is restored, not GitHub's URL.
    await tab(window, 'Jira').click()
    await expect(bodyInput(window)).toHaveValue('PRJ-123')

    // And GitHub still holds its own URL.
    await tab(window, 'GitHub').click()
    await expect(bodyInput(window)).toHaveValue('https://github.com/acme/repo/issues/7')

    expect(errors).toEqual([])
  })

  test('submit button disabled-state follows the active tab (#412 × #442)', async ({ window }) => {
    const errors: string[] = []
    window.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
    window.on('console', (m) => {
      if (m.type() === 'error') errors.push(`console.error: ${m.text()}`)
    })

    await openNewTaskModal(window)

    // Manual tab with a valid title → "Create task" enabled.
    await bodyInput(window).fill('A real manual title')
    await expect(submitBtn(window)).toHaveText('Create task')
    await expect(submitBtn(window)).toBeEnabled()

    // Switch to Jira (empty ref) → button becomes "Import" and DISABLED (feedback,
    // not a silent dead click). The manual title must not make an import submittable.
    await tab(window, 'Jira').click()
    await expect(submitBtn(window)).toHaveText('Import')
    await expect(submitBtn(window)).toBeDisabled()

    // Typing a Jira ref re-enables Import.
    await bodyInput(window).fill('PRJ-9')
    await expect(submitBtn(window)).toBeEnabled()

    // Back to manual → title restored, "Create task" enabled again.
    await tab(window, 'From scratch').click()
    await expect(bodyInput(window)).toHaveValue('A real manual title')
    await expect(submitBtn(window)).toHaveText('Create task')
    await expect(submitBtn(window)).toBeEnabled()

    expect(errors).toEqual([])
  })

  test('a typed import ref survives dismiss + reopen with its provider tab re-selected', async ({
    window,
  }) => {
    const errors: string[] = []
    window.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
    window.on('console', (m) => {
      if (m.type() === 'error') errors.push(`console.error: ${m.text()}`)
    })

    await openNewTaskModal(window)

    // Type a GitHub URL on the GitHub tab, then dismiss WITHOUT creating (Escape).
    await tab(window, 'GitHub').click()
    await bodyInput(window).fill('https://github.com/acme/repo/issues/42')
    await window.keyboard.press('Escape')
    await expect(window.locator('.fl-board-modal')).toBeHidden()

    // Reopen — the preserved draft restores the GitHub tab AND its URL, so an
    // accidental dismiss never silently loses a typed import reference (#561).
    await window.locator('.fl-board-lane-btn[aria-label="New task"]').click()
    await expect(window.locator('.fl-board-modal')).toBeVisible()
    await expect(window.locator('.fl-board-modal-tab.active')).toHaveText('GitHub')
    await expect(bodyInput(window)).toHaveValue('https://github.com/acme/repo/issues/42')

    expect(errors).toEqual([])
  })
})
