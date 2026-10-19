import { test, expect } from '../fixtures/electron'
import { sel, statusButtonByText } from '../selectors'
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed'
import type { Page } from '@playwright/test'

/**
 * Tasks board "New task" modal — draft survives an ACCIDENTAL close, and stays
 * scoped to the project it was typed in. Flow 9 (Tasks board) of the progressive
 * UX sweep, round 12.
 *
 * tasks-newtask.spec already guards #442 (draft survives a source-TAB round-trip
 * WHILE the modal stays open). This probe covers the DISTINCT #561/#591 seam that
 * was un-probed: the modal is dismissed entirely (Escape) and reopened.
 *
 * LIVE GUARDS (pass on current `main`):
 *   #561 — an accidental Escape dismiss must not silently discard typed work: the
 *          board snapshots the live inputs into a board-level draft on a persisting
 *          close and restores them on the next open.
 *   #561 — a SUCCESSFUL create clears that preserved draft (close(false)), so the
 *          next "+ New task" opens blank, not pre-filled with the just-created task.
 *
 * Regression guard (#830, fixed — write side keyed per project):
 *   A draft preserved in project A is SILENTLY DESTROYED merely by opening and
 *   dismissing the New-task modal in another project B — even without typing in B.
 *   Root cause: `#newTaskDraft` is a single board-level slot. `#snapshotNewTaskDraft`
 *   (run on any persisting close) sets it to `null` whenever the CURRENT modal's live
 *   inputs are empty, regardless of project. The #591 `restorableDraft(rootPath)` key
 *   only guards the READ side (no cross-project leak); the WRITE side still clobbers
 *   A's draft when B's empty modal closes. Isolated trigger: a bare project switch A→B→A
 *   PRESERVES the draft; opening+Escaping B's empty modal is what wipes it.
 *
 * Credential-free: pure manual-modal paths against seeded throwaway projects —
 * no agent, no account. Runs headless in CI.
 */
test.afterAll(() => cleanupSeeds())

const newTaskBtn = (win: Page) => win.locator('.fl-board-lane-btn[aria-label="New task"]')
const modal = (win: Page) => win.locator('.fl-board-modal')
const titleInput = (win: Page) => win.locator('.fl-board-modal-body input[type="text"]').first()
const descInput = (win: Page) => win.locator('.fl-board-modal-body textarea')

async function openBoardFor(win: Page, prefix: string): Promise<string> {
  const root = await seedProject(win, prefix)
  await activateProject(win, root)
  await win.locator(statusButtonByText('Tasks')).click()
  await expect(win.locator(sel.board)).toBeVisible()
  return root
}

async function followBoard(win: Page, root: string): Promise<void> {
  await activateProject(win, root)
  await expect
    .poll(async () => win.locator('.fl-board-subtitle').textContent())
    .not.toBe('No project open')
}

test.describe('tasks board — New task draft preservation', () => {
  test('restores the typed title & description after an accidental Escape dismiss (#561)', async ({
    window,
  }) => {
    const errors: string[] = []
    window.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`))

    await openBoardFor(window, 'flow-ux-draft-a-')

    // Type a task, then dismiss the modal WITHOUT creating (Escape = accidental).
    await newTaskBtn(window).click()
    await expect(modal(window)).toBeVisible()
    await titleInput(window).fill('Investigate flaky login')
    await descInput(window).fill('Repro: 2FA times out on slow networks. Trace the retry path.')
    await window.keyboard.press('Escape')
    await expect(modal(window)).toBeHidden()

    // Reopen: the typed work is RESTORED, not silently lost (#561).
    await newTaskBtn(window).click()
    await expect(modal(window)).toBeVisible()
    await expect(titleInput(window)).toHaveValue('Investigate flaky login')
    await expect(descInput(window)).toHaveValue(
      'Repro: 2FA times out on slow networks. Trace the retry path.',
    )
    expect(errors).toEqual([])
  })

  test('a successful create clears the preserved draft — reopen is blank (#561)', async ({
    window,
  }) => {
    await openBoardFor(window, 'flow-ux-draft-b-')

    await newTaskBtn(window).click()
    await expect(modal(window)).toBeVisible()
    await titleInput(window).fill('Ship the release notes')
    await window.locator('.fl-board-modal .fl-board-new', { hasText: 'Create task' }).click()
    await expect(modal(window)).toBeHidden()

    // The card exists; the draft is cleared → the next open starts blank.
    await expect(
      window.locator('.fl-board-card', { hasText: 'Ship the release notes' }),
    ).toBeVisible()
    await newTaskBtn(window).click()
    await expect(modal(window)).toBeVisible()
    await expect(titleInput(window)).toHaveValue('')
    await expect(descInput(window)).toHaveValue('')
  })

  // TRIPWIRE for the confirmed cross-project draft-loss bug (filed this sweep).
  // #830 fixed: the preserved draft is keyed per project on the WRITE side too
  // (e.g. keep a Map<rootPath, draft>, or snapshot into the current project's slot
  // instead of a single shared field). Confirmed RED on current main.
  test(
    "A's preserved draft survives opening & dismissing B's empty New-task modal (#591 write-side)",
    async ({ window }) => {
      const rootA = await openBoardFor(window, 'flow-ux-draft-pa-')

      await newTaskBtn(window).click()
      await expect(modal(window)).toBeVisible()
      await titleInput(window).fill('Project A only draft')
      await window.keyboard.press('Escape')
      await expect(modal(window)).toBeHidden()

      // Visit project B and open/dismiss its (empty) New-task modal.
      const rootB = await seedProject(window, 'flow-ux-draft-pb-')
      await followBoard(window, rootB)
      await newTaskBtn(window).click()
      await expect(modal(window)).toBeVisible()
      await expect(titleInput(window)).toHaveValue('') // no leak (#591 read-side, already fixed)
      await window.keyboard.press('Escape')
      await expect(modal(window)).toBeHidden()

      // Return to A: the draft must STILL be there. (Bug: it was silently wiped.)
      await followBoard(window, rootA)
      await newTaskBtn(window).click()
      await expect(modal(window)).toBeVisible()
      await expect(titleInput(window)).toHaveValue('Project A only draft')
    },
  )
})
