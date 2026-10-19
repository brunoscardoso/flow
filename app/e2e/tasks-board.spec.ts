import { test, expect } from './fixtures/electron'
import { sel, statusButtonByText } from './selectors'

/**
 * Tasks board: the status-bar Tasks button opens the editor-area Kanban board
 * (Todo / Doing / Done). Asserts the board surface mounts on demand.
 */
test.describe('tasks board', () => {
  test('Tasks button opens the Kanban board', async ({ window }) => {
    await expect(window.locator(sel.board)).toBeHidden()
    await window.locator(statusButtonByText('Tasks')).click()
    await expect(window.locator(sel.board)).toBeVisible()
    // NO PROJECT IS OPEN IN THIS FIXTURE, so the lanes are hidden by design
    // (#622) and the board's own empty state is what proves it mounted. There
    // is no header row to assert any more — the board's two verbs live on
    // Todo's column head, which only exists with a project.
    await expect(window.locator('.fl-board-no-project')).toBeVisible()
  })

  test('shows a "No project open" empty state, not an empty board, with no project (#622)', async ({
    window,
  }) => {
    await window.locator(statusButtonByText('Tasks')).click()
    await expect(window.locator(sel.board)).toBeVisible()

    // A dedicated empty state — mirroring the Files panel — with an Open Folder action.
    const noProject = window.locator('.fl-board-no-project')
    await expect(noProject).toBeVisible()
    await expect(noProject).toContainText('No project open')
    await expect(noProject.locator('fl-button')).toBeVisible()

    // NOT the lanes: the Todo "Nothing here yet" board must not show. The
    // "+ New task" control lives on Todo's own column head now, so with the
    // lanes hidden it is off screen entirely — and still disabled underneath,
    // which is what stops the reveal being a soft dead-end the moment the
    // columns come back.
    await expect(window.locator('.fl-board-columns')).toBeHidden()
    const add = window.locator('.fl-board-lane-btn[aria-label="New task"]')
    await expect(add).toBeHidden()
    await expect(add).toBeDisabled()
  })
})
