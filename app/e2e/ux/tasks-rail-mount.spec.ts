import { test, expect } from '../fixtures/electron'
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed'

/**
 * UX sweep — flow 9 (Tasks board): can a user actually reach the Kanban board?
 *
 * History: post-#663 the Tasks board briefly lived as a sidebar rail PANE,
 * which was unreachable because the whole sidebar body was detached at boot
 * (#664). The #668 rewire resolved this by making Tasks an activity-bar
 * ACTION item (aria-label "Tasks", no `data-rail-item`) that dispatches
 * `flow:open-board` — the Kanban board opens as an editor tab, the same
 * surface the old status-bar button targeted.
 *
 * This spec drives that real flow end to end: click the Tasks rail action →
 * the live board (`.fl-board`) mounts with its header chrome.
 */

test.afterAll(() => cleanupSeeds())

// The view actions left the activity rail for the editor area's own toolbar
// ("Open a view") — beside where the view opens. The rail is sidebar surfaces
// only, so the action is asserted where it lives, and absent where it was.
test('the editor toolbar renders the Tasks action (and the rail does not)', async ({ window }) => {
  const actions = window.locator('.fl-editor-actions')
  await expect(actions).toBeVisible()
  await expect(actions.locator('.fl-rail-item[aria-label="Tasks"]')).toBeVisible()
  await expect(window.locator('.fl-activity-bar .fl-rail-item[aria-label="Tasks"]')).toHaveCount(0)
})

test('clicking the Tasks rail action opens the LIVE Kanban board (#664)', async ({ window }) => {
  const proj = await seedProject(window)
  await activateProject(window, proj)

  await expect(window.locator('.fl-board')).toBeHidden()
  await window.locator('.fl-editor-actions .fl-rail-item[aria-label="Tasks"]').click()

  // The live board mounts as an editor tab with its real chrome — not an
  // empty/absent pane.
  await expect(window.locator('.fl-board')).toBeVisible()
  // The board's own structure. There is no header row any more — its two verbs
  // live on Todo's column head — so a lane head is what proves the view mounted.
  // SCOPED PAST REMOTE. The first column is the tracker's own list, which is
  // hidden until somebody asks for it — an unscoped .first() proved nothing
  // about whether the board mounted, and reported a hidden lane head instead.
  await expect(
    window.locator('.fl-board-column:not(.fl-board-remote) .fl-board-column-head').first(),
  ).toBeVisible()
})
