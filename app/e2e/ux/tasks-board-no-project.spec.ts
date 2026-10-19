import { test, expect } from '../fixtures/electron'
import { sel, statusButtonByText } from '../selectors'
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed'
import type { Page } from '@playwright/test'

/**
 * Tasks board — the "No project open" empty state + working sibling controls
 * (flow 9 of the progressive UX sweep).
 *
 * #622: opened with NO project active, the board renders a full, normal-looking
 * empty Kanban — Todo shows "Nothing here yet", Doing/Done show "—", and the
 * "+ New task" CTA is fully enabled — indistinguishable from a genuinely-empty
 * *active-project* board. Only the small subtitle reads "No project open".
 *
 * This is inconsistent with every sibling surface in the same state: the Files
 * panel renders a dedicated "No project open / Open Folder…" empty state (#360),
 * and the Blueprint board got the same treatment (#449). The board even computes
 * a distinct `'no-project'` view (`resolveBoardView`) but `#render` never renders
 * it — it only special-cases `'load-error'`, so `'no-project'` falls through to
 * the lanes.
 *
 * - The live controls below (drag across lanes, Integrations button, the
 *   +New-task toast) all PASS on `main` — they isolate #622 to the missing
 *   empty state, not a broken board.
 * - The `test.fixme` documents the EXPECTED behavior (lanes hidden, a dedicated
 *   no-project state shown) that FAILS today; flip it live once #622 lands
 *   (branch `#render` on the `'no-project'` view).
 *
 * All no-account paths (manual create + local lane moves + overlay open), so
 * they run headless in CI.
 */
test.afterAll(() => cleanupSeeds())

async function openBoardNoProject(window: Page): Promise<void> {
  await window.locator(statusButtonByText('Tasks')).click()
  await expect(window.locator(sel.board)).toBeVisible()
  await expect(window.locator('.fl-board-subtitle')).toHaveText('No project open')
}

test.describe('tasks board — no-project empty state (#622)', () => {
  test('no-project board still reports "No project open" and gates +New task with a toast (control)', async ({
    window,
  }) => {
    const errors: string[] = []
    window.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
    window.on('console', (m) => {
      if (m.type() === 'error') errors.push(`console.error: ${m.text()}`)
    })
    await openBoardNoProject(window)

    // The +New-task button is present and, with no project, is DISABLED rather
    // than click-to-toast: #633 changed the mitigation when it landed the empty
    // state, and this assertion followed it. A disabled control still owes its
    // reason (forbidden-pattern #12), so the title is asserted too — a dead
    // control with no explanation is the failure this test exists to catch.
    // It lives on Todo's column head now, which the no-project state hides
    // wholesale — so it is OFF SCREEN and still disabled underneath, which is
    // what stops the reveal being a soft dead-end the moment the lanes return.
    const newBtn = window.locator('.fl-board-lane-btn[aria-label="New task"]')
    await expect(newBtn).toBeHidden()
    await expect(newBtn).toBeDisabled()
    await expect(newBtn).toHaveAttribute('title', /Open a project first/)
    await expect(window.locator('.fl-board-modal')).toBeHidden()

    expect(errors).toEqual([])
  })

  // #622: with no project open, the board should hide the Todo/Doing/Done lanes
  // and render a dedicated "No project open" empty state (like the Files panel
  // #360 / Blueprint #449 do), instead of the misleading "Nothing here yet"
  // empty board. Remove `.fixme` once `#render` branches on the `'no-project'`
  // view resolveBoardView already returns.
  test.fixme('no-project shows a dedicated empty state, not an empty Kanban (#622)', async ({
    window,
  }) => {
    await openBoardNoProject(window)
    // Expected once fixed: the lanes are hidden and the inviting "Nothing here
    // yet" Todo placeholder is NOT shown when there is no project to hold tasks.
    await expect(window.locator('.fl-board-columns')).toBeHidden()
    await expect(window.locator('.fl-board-empty', { hasText: 'Nothing here yet' })).toHaveCount(0)
  })

  test('board is a working Kanban once a project is active — drag across lanes + Integrations (control)', async ({
    window,
  }) => {
    const errors: string[] = []
    window.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
    window.on('console', (m) => {
      if (m.type() === 'error') errors.push(`console.error: ${m.text()}`)
    })

    const root = await seedProject(window)
    await activateProject(window, root)
    await window.locator(statusButtonByText('Tasks')).click()
    await expect(window.locator(sel.board)).toBeVisible()

    // Create two manual cards.
    for (const title of ['Alpha task', 'Beta task']) {
      await window.locator('.fl-board-lane-btn[aria-label="New task"]').click()
      await expect(window.locator('.fl-board-modal')).toBeVisible()
      await window.locator('.fl-board-modal-body input[type="text"]').first().fill(title)
      await window.locator('.fl-board-modal .fl-board-new', { hasText: 'Create task' }).click()
      await expect(window.locator('.fl-board-modal')).toBeHidden()
    }
    await window.locator(statusButtonByText('Tasks')).click()
    await expect(window.locator(sel.board)).toBeVisible()
    await expect
      .poll(async () => window.locator('.fl-board-column:not(.fl-board-remote) .fl-board-count').allTextContents())
      .toEqual(['2', '0', '0', '0', '0'])

    // Drag "Alpha task" Todo → Done via native HTML5 DnD (shared DataTransfer,
    // the channel the board's dragstart/drop handlers carry the task id on).
    await window.evaluate(() => {
      const card = Array.from(document.querySelectorAll('.fl-board-card')).find((c) =>
        c.textContent?.includes('Alpha task'),
      ) as HTMLElement
      // [todo, doing, blocked, done] — Done is the LAST lane, not the third.
      const lanes = document.querySelectorAll('.fl-board-column:not(.fl-board-remote) .fl-board-cards')
      const done = lanes[lanes.length - 1] as HTMLElement
      const dt = new DataTransfer()
      card.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }))
      done.dispatchEvent(new DragEvent('dragover', { bubbles: true, dataTransfer: dt }))
      done.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: dt }))
      card.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }))
    })
    // Move persists via tasks:update; the lane counts follow (1 Todo, 0, 1 Done).
    await expect
      .poll(async () => window.locator('.fl-board-column:not(.fl-board-remote) .fl-board-count').allTextContents())
      .toEqual(['1', '0', '0', '0', '1'])
    await expect(
      window.locator('.fl-board-column').last().locator('.fl-board-card', { hasText: 'Alpha task' }),
    ).toBeVisible()

    // INTEGRATIONS MOVED TO THE APP'S SETTINGS. They are accounts, and every
    // other account is configured there; on the board they were a permanent
    // button about something almost nobody changes twice. They are a settings
    // GROUP rather than an overlay opened from one, so this is one event.
    await window.evaluate(() => document.dispatchEvent(new CustomEvent('flow:open-integrations')))
    await expect(window.locator('.fl-settings-tab.active')).toHaveText('Integrations', {
      timeout: 15_000,
    })

    expect(errors).toEqual([])
  })
})
