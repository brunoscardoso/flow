import { test, expect } from '../fixtures/electron'
import { sel, statusButtonByText } from '../selectors'
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'

/**
 * Tasks board — clicking a FILE LINK inside the task-detail modal (flow 9).
 *
 * A task description is rendered with the shared `renderMarkdown`, so a path in
 * backticks (`NOTES.md` — very common in an imported issue body or a manual
 * note) becomes a clickable file chip that dispatches `flow:open-file-path`.
 * The editor resolves it, opens a tab, and announces `flow:editor-file-opened`
 * — the signal added by #345 precisely so overlays covering the editor step
 * aside instead of hiding the file the user just asked for.
 *
 * The detail modal is such an overlay (`position: fixed; inset: 0; z-index:
 * 1000`, dimmed backdrop) and does not listen for it, so the file opens
 * BEHIND the modal that is still up. Contrast "Open chat" in the very same
 * modal's action row, which closes the modal before navigating.
 *
 * Account-independent (manual create + a seeded file). A `pageerror` listener
 * fails the flow on any uncaught renderer error.
 */

test.afterAll(() => cleanupSeeds())

const DESCRIPTION = 'Everything is written up in `NOTES.md` — start there.'

/** Seed a project holding NOTES.md, create a task whose description names it,
 *  and open that task's detail modal. */
async function openDetailWithFileLink(window: Page): Promise<void> {
  const root = await seedProject(window, 'flow-ux-detaillink-', (dir) => {
    writeFileSync(join(dir, 'NOTES.md'), '# Notes\n\nthe seeded notes file\n')
  })
  await activateProject(window, root)

  await window.locator(statusButtonByText('Tasks')).click()
  await expect(window.locator(sel.board)).toBeVisible()
  await window.locator('.fl-board-lane-btn[aria-label="New task"]').click()
  await expect(window.locator('.fl-board-modal')).toBeVisible()
  await window.locator('.fl-board-modal-body input[type="text"]').first().fill('Read the notes')
  await window.locator('.fl-board-modal-body textarea').fill(DESCRIPTION)
  await window.locator('.fl-board-modal .fl-board-new', { hasText: 'Create task' }).click()
  await expect(window.locator('.fl-board-modal')).toBeHidden()

  // Creating a task opens its thread; come back to the board and open the card.
  await window.locator(statusButtonByText('Tasks')).click()
  await expect(window.locator(sel.board)).toBeVisible()
  await window.locator('.fl-board-card', { hasText: 'Read the notes' }).click()
  await expect(window.locator('.fl-board-detail')).toBeVisible()
}

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

test.describe('tasks board — file link in the task detail modal', () => {
  // Live control: the chip renders and the click really does open the file.
  // Passes on current `main`.
  test('a path in the description renders as a chip that opens the file in the editor', async ({
    window,
  }) => {
    const errors = watchErrors(window)
    await openDetailWithFileLink(window)

    const chip = window.locator('.fl-board-detail-desc a.fl-md-file')
    await expect(chip).toHaveText('NOTES.md')

    await chip.click()
    // The editor really opened the seeded file (it is behind the modal, but the
    // tab exists) — the click is wired, not inert.
    await expect(window.locator('[role="tab"]', { hasText: 'NOTES.md' })).toBeVisible()
    expect(errors).toEqual([])
  })

  // Was the #961 tripwire — now the contract: the detail modal steps aside on
  // `flow:editor-file-opened` (the #345 signal), the way the git diff overlay
  // already does and the way "Open chat" in this same action row already does.
  test(
    'clicking the file chip reveals the opened file instead of leaving the modal over it',
    async ({ window }) => {
      await openDetailWithFileLink(window)

      await window.locator('.fl-board-detail-desc a.fl-md-file').click()
      await expect(window.locator('[role="tab"]', { hasText: 'NOTES.md' })).toBeVisible()

      // EXPECTED: the user asked to see the file, so the modal that covers the
      // whole viewport gets out of the way — as the git diff overlay does (#345)
      // and as "Open chat" in this same action row does.
      await expect(window.locator('.fl-board-modal-overlay')).toHaveCount(0)
    },
  )

  // The sibling action in the same row DOES stand down — the inconsistency the
  // tripwire above is measured against. Passes on current `main`.
  test('the sibling "Open chat" action closes the modal before navigating', async ({ window }) => {
    const errors = watchErrors(window)
    await openDetailWithFileLink(window)

    await window.locator('.fl-board-detail .fl-board-new', { hasText: 'Open chat' }).click()
    await expect(window.locator('.fl-board-modal-overlay')).toHaveCount(0)
    expect(errors).toEqual([])
  })
})
