import { test, expect } from '../fixtures/electron'
import { sel, statusButtonByText } from '../selectors'
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed'
import type { Page } from '@playwright/test'

/**
 * Tasks board "New task" modal — do the picked **Context folders** (#695) survive
 * the same accidental close that the title / description / Start-with survive
 * (#561)? Flow 9 (Tasks board) of the progressive UX sweep, round 15.
 *
 * Prior flow-9 draft probes cover the TYPED fields only: tasks-newtask.spec
 * (#442, draft survives a source-TAB round-trip while the modal stays open),
 * tasks-newtask-draft-preserve.spec (#561/#591/#830, Escape + reopen restores
 * title/description; per-project keying), tasks-newtask-tab-fields.spec (#412
 * import refs). task-context-roots.spec drives the happy path (check a folder →
 * create → the thread carries it). NONE drive a checked context folder through a
 * modal dismiss + reopen — the seam where the draft's field coverage stops.
 *
 * LIVE GUARDS (pass on current `main`):
 *   #695/#442 — a checked context folder survives a source-TAB round-trip
 *               (`contextRoots` is card-scoped, so renderBody() re-checks the box).
 *   #561      — an Escape dismiss + reopen restores the typed title & description.
 *
 * Regression tripwire (#996, open): reopening after that dismiss restores the
 * typed text but SILENTLY drops the checked context folders — `PersistedNewTaskDraft`
 * (task-draft.ts) carries only { title, description, refs, selected, start }, and
 * `contextRoots` is a card-scoped Set rebuilt empty on every open. The restored
 * title/description read as "your work is back", so the user hits Create and the
 * task's thread silently spawns WITHOUT the extra roots its agent needed.
 *
 * Credential-free: manual-tab paths against two seeded throwaway projects — no
 * agent, no account, no native dialog (Browse… is untouched).
 */
test.afterAll(() => cleanupSeeds())

const newTaskBtn = (win: Page) => win.locator('.fl-board-lane-btn[aria-label="New task"]')
const modal = (win: Page) => win.locator('.fl-board-modal')
const titleInput = (win: Page) => win.locator('.fl-board-modal-body input[type="text"]').first()
const descInput = (win: Page) => win.locator('.fl-board-modal-body textarea')
const ctxRow = (win: Page, dir: string) =>
  win.locator('.fl-board-modal-context-row', { hasText: dir.split('/').pop()! })
const tab = (win: Page, label: string) => win.locator('.fl-board-modal-tab', { hasText: label })

/** Seed A (active, board open) + B (the other open project offered as context). */
async function openBoardWithTwoProjects(win: Page, prefix: string): Promise<[string, string]> {
  const dirA = await seedProject(win, `${prefix}A-`)
  const dirB = await seedProject(win, `${prefix}B-`)
  await activateProject(win, dirA)
  await win.locator(statusButtonByText('Tasks')).click()
  await expect(win.locator(sel.board)).toBeVisible()
  return [dirA, dirB]
}

/** additionalRoots of the thread owned by the first task in `projectRoot`. */
async function firstTaskThreadRoots(win: Page, projectRoot: string): Promise<string[]> {
  return win.evaluate(async (root) => {
    const flow = (
      window as unknown as {
        flow: {
          tasks: {
            list(r: {
              projectRoot: string
              includeArchived: boolean
            }): Promise<Array<{ threadId: string | null }>>
          }
          threads: {
            list(r: { projectRoot: string }): Promise<Array<{ id: string; additionalRoots: string[] }>>
          }
        }
      }
    ).flow
    const tasks = await flow.tasks.list({ projectRoot: root, includeArchived: false })
    const threadId = tasks[0]?.threadId ?? null
    if (!threadId) return []
    const threads = await flow.threads.list({ projectRoot: root })
    return threads.find((t) => t.id === threadId)?.additionalRoots ?? []
  }, projectRoot)
}

test.describe('tasks board — New task context folders vs the preserved draft', () => {
  test('a checked context folder survives a source-tab round-trip (#695/#442)', async ({
    window,
  }) => {
    const errors: string[] = []
    window.on('pageerror', (e) => errors.push(e.message))

    const [, dirB] = await openBoardWithTwoProjects(window, 'flow-ux-taskctxdraft1-')

    await newTaskBtn(window).click()
    await expect(modal(window)).toBeVisible()
    await titleInput(window).fill('Cross-repo task')

    const box = ctxRow(window, dirB).locator('input[type="checkbox"]')
    await expect(ctxRow(window, dirB)).toBeVisible()
    await box.check()
    await expect(box).toBeChecked()

    // renderBody() destroys and rebuilds the picker on every tab click; the
    // card-scoped Set is what re-checks the box on the way back.
    //
    // THE PICKER IS ON EVERY TAB NOW, and that is right: an import creates a
    // thread the same way a from-scratch task does, and `tasks:importIssue`
    // takes the very `additionalRoots` this picker collects. It used to be
    // hidden here, so this line asserted its absence — a limitation, dressed as
    // a rule. What the round trip is actually about is the card-scoped Set, so
    // that is what is checked: the box survives the rebuild in both directions.
    await tab(window, 'Jira').click()
    await expect(ctxRow(window, dirB).locator('input[type="checkbox"]')).toBeChecked()
    await tab(window, 'From scratch').click()

    await expect(titleInput(window)).toHaveValue('Cross-repo task')
    await expect(ctxRow(window, dirB).locator('input[type="checkbox"]')).toBeChecked()

    await window.keyboard.press('Escape')
    expect(errors, errors.join(', ')).toHaveLength(0)
  })

  test('an Escape dismiss + reopen restores the typed title & description (#561)', async ({
    window,
  }) => {
    const errors: string[] = []
    window.on('pageerror', (e) => errors.push(e.message))

    const [, dirB] = await openBoardWithTwoProjects(window, 'flow-ux-taskctxdraft2-')

    await newTaskBtn(window).click()
    await expect(modal(window)).toBeVisible()
    await titleInput(window).fill('Wire up the API client')
    await descInput(window).fill('Needs the sibling repo for the schema.')
    await ctxRow(window, dirB).locator('input[type="checkbox"]').check()

    await window.keyboard.press('Escape')
    await expect(modal(window)).toBeHidden()

    await newTaskBtn(window).click()
    await expect(modal(window)).toBeVisible()
    // The typed work IS restored — which is exactly what makes the dropped
    // context folder (next test) read as "everything came back".
    await expect(titleInput(window)).toHaveValue('Wire up the API client')
    await expect(descInput(window)).toHaveValue('Needs the sibling repo for the schema.')
    await expect(ctxRow(window, dirB)).toBeVisible()

    await window.keyboard.press('Escape')
    expect(errors, errors.join(', ')).toHaveLength(0)
  })

  test(
    'reopening after a dismiss keeps the checked context folder, and the created thread carries it (#996)',
    async ({ window }) => {
      const errors: string[] = []
      window.on('pageerror', (e) => errors.push(e.message))

      const [dirA, dirB] = await openBoardWithTwoProjects(window, 'flow-ux-taskctxdraft3-')

      await newTaskBtn(window).click()
      await expect(modal(window)).toBeVisible()
      await titleInput(window).fill('Wire up the API client')
      await descInput(window).fill('Needs the sibling repo for the schema.')
      await ctxRow(window, dirB).locator('input[type="checkbox"]').check()

      // Accidental dismiss (the #561 scenario the draft exists for).
      await window.keyboard.press('Escape')
      await expect(modal(window)).toBeHidden()

      await newTaskBtn(window).click()
      await expect(modal(window)).toBeVisible()
      await expect(titleInput(window)).toHaveValue('Wire up the API client')
      // The restore is whole, not silently partial: the box comes back checked
      // along with the text (#996).
      await expect(ctxRow(window, dirB).locator('input[type="checkbox"]')).toBeChecked()

      // …and the data consequence: the spawned thread loses the extra root.
      await window.locator('.fl-board-modal .fl-board-new', { hasText: 'Create task' }).click()
      await expect(modal(window)).toBeHidden()
      await expect
        .poll(async () => (await firstTaskThreadRoots(window, dirA)).includes(dirB), {
          timeout: 5000,
        })
        .toBe(true)

      expect(errors, errors.join(', ')).toHaveLength(0)
    },
  )
})
