import { test, expect } from '../fixtures/electron'
import { sel, statusButtonByText } from '../selectors'

/**
 * Regression for PR #306 — "keep the New task modal open on a failed manual
 * create so typed input survives (#299)".
 *
 * The board's manual "From scratch" submit used to call `close()` synchronously
 * the instant the user clicked **Create task**, before `tasks.create` resolved —
 * so a failed create discarded the typed title/description with only a transient
 * toast. #306 mirrors the import path: dismiss only on success; on failure keep
 * the modal, re-enable Submit, and render an inline `.fl-board-modal-error` banner
 * so the input survives. It does this by delegating the close-iff-success invariant
 * to a new pure helper `planManualSubmit` in `new-task-submit.ts`, which
 * `kanban-board.ts` now imports.
 *
 * The failed-create rollback only fires from the New Task modal, which
 * `#openNewTaskForm` refuses to open without a project (`this.#root`) — and the
 * "Add project" flow opens a native OS folder picker Playwright can't drive
 * (see e2e/README.md "Known gate"). The invariant itself is unit-tested
 * (`new-task-submit` — `planManualSubmit` closes only on success, keeps the modal
 * open with an inline error on failure; `createErrorMessage` avoids
 * "[object Object]").
 *
 * NOTE (issue #311): the in-flight double-submit guard #306 added
 * (`submit.disabled = true`) is button-only — the Enter path (`enterSubmit` →
 * `doSubmit`) still fires a duplicate `tasks.create`. That residual gap is tracked
 * separately and, like the modal itself, isn't observable from a fresh launch.
 *
 * What IS observable on a fresh launch — and what this spec guards — is that the
 * board bundle still boots after #306's renderer edits. If the new
 * `import { planManualSubmit } from './new-task-submit'` (and the `#showModalError`
 * DOM wiring) had broken the module, the Kanban board would never mount. Opening
 * the board and asserting its surface proves the edited bundle loaded and ran
 * end-to-end without throwing.
 */
test.describe('PR #306 — New task modal preserves input on failed create (board module boots after the fix)', () => {
  test('the Kanban board mounts after the reworked manual-submit wiring', async ({ window }) => {
    // Board hidden until summoned.
    await expect(window.locator(sel.board)).toBeHidden()

    // Open it via the status-bar Tasks button — same path a user takes.
    await window.locator(statusButtonByText('Tasks')).click()

    // Board mounted + its header rendered — proof the edited kanban-board.ts
    // (now importing planManualSubmit from new-task-submit.ts) bundle loaded and
    // ran its module/render code without throwing.
    await expect(window.locator(sel.board)).toBeVisible()
    // A fresh launch has no project, so the board renders its distinct
    // "No project open" state (#622) instead of lanes — still the board's own
    // #render output, so it proves the bundle mounted without throwing.
    await expect(window.locator('.fl-board-no-project')).toBeVisible()
    await expect(window.locator('.fl-board-no-project-label')).toHaveText('No project open')

    // No stale modal-error banner exists before any create is attempted — the
    // failed-create rollback path #306 reworked only runs inside the New Task
    // modal, which needs a project this fresh launch can't add.
    await expect(window.locator('.fl-board-modal-error')).toHaveCount(0)
  })
})
