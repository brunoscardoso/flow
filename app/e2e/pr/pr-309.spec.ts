import { test, expect } from '../fixtures/electron'
import { sel, statusButtonByText } from '../selectors'

/**
 * Regression for PR #309 — "surface a toast when a task's auto-start command
 * fails to send (#297)".
 *
 * The board's "Start with (optional)" field auto-starts the task's agent by
 * sending its first message. When `threads.sendMessage` rejected, `#startTask`
 * swallowed it with a bare `console.error`: the thread opened empty, the agent
 * never started, and the user got no cue. The sibling `bypassPermissions` update
 * in `#afterCreate` had the same silent swallow, quietly ignoring the user's
 * "Skip permission prompts" choice. #309 surfaces both via `#notify`, using two
 * pure toast builders (`startTaskFailedToast`, `skipPermissionsFailedToast`) that
 * `kanban-board.ts` now imports from `new-task-submit.ts`.
 *
 * Both failures only fire during task auto-start, which needs a project + a
 * created task + a running session — out of range for a fresh, credential-less
 * launch (the New Task modal won't even open without a project; see
 * e2e/README.md "Known gate"). The toast copy itself is unit-tested
 * (`new-task-submit` — `startTaskFailedToast` names the error and points to
 * resending in the thread; `skipPermissionsFailedToast` explains prompts stay on).
 *
 * What IS observable on a fresh launch — and what this spec guards — is that the
 * board bundle still boots after #309's renderer edits. If the new
 * `import { planManualSubmit, skipPermissionsFailedToast, startTaskFailedToast }`
 * or the two `#notify` catch handlers had broken the module, the Kanban board
 * would never mount. Opening the board and asserting its surface proves the edited
 * bundle loaded and ran end-to-end without throwing.
 */
test.describe('PR #309 — auto-start failure toasts (board module boots after the fix)', () => {
  test('the Kanban board mounts after the auto-start toast wiring', async ({ window }) => {
    await expect(window.locator(sel.board)).toBeHidden()

    await window.locator(statusButtonByText('Tasks')).click()

    // Board mounted + header rendered — proof the edited kanban-board.ts (now
    // importing the toast builders from new-task-submit.ts and calling #notify in
    // its #startTask / #afterCreate catches) bundle loaded without throwing.
    await expect(window.locator(sel.board)).toBeVisible()
    // A fresh launch has no project, so the board renders its distinct
    // "No project open" state (#622) instead of lanes — still the board's own
    // #render output, so it proves the bundle mounted without throwing.
    await expect(window.locator('.fl-board-no-project')).toBeVisible()
    await expect(window.locator('.fl-board-no-project-label')).toHaveText('No project open')
  })
})
