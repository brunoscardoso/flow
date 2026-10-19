import { test, expect } from '../fixtures/electron'
import { sel, statusButtonByText } from '../selectors'

/**
 * Regression for PR #314 — "gate the New task submit LOGIC so Enter can't
 * double-fire a create (#311)".
 *
 * #299/#306 kept the New task modal open while `tasks.create` was in flight and
 * guarded a double-submit with `submit.disabled = true`. But that only blocked
 * the **button** — the modal's inputs also submit on **Enter** (`enterSubmit →
 * doSubmit`), which never checked `disabled`. A second Enter during the in-flight
 * window fired a duplicate `tasks.create` → two tasks + two threads (and
 * `#afterCreate` running twice, double-sending any "Start with" command) from one
 * intent (#311). #314 gates the submit LOGIC, not just the button: a `submitting`
 * re-entrancy latch shared by every entry path (button click *and* Enter), checked
 * at the top of both `doSubmit` branches via the pure `canSubmit(submitting,
 * hasRequiredInput)`, with `setSubmitting(v)` keeping the latch and the visual
 * `submit.disabled` in sync (reset on manual-create failure and via `.finally` on
 * the import path so a legitimate retry is still allowed).
 *
 * The double-submit path itself needs a project + the open New Task modal +
 * `tasks.create` in flight — out of range for a fresh, credential-less launch:
 * the New Task modal won't open without a project, and "Add project" opens a
 * native OS folder picker Playwright can't drive (see e2e/README.md "Known
 * gate"). The guard decision is fully unit-tested (`canSubmit (#311)` in
 * `new-task-submit.test.ts`): proceeds only when not in flight and the required
 * field is present; blocks a re-entrant submit even with input (the Enter vector);
 * blocks an empty required field.
 *
 * What IS observable on a fresh launch — and what this spec guards — is that the
 * board bundle still boots after #314's renderer edits. `kanban-board.ts` now
 * imports `canSubmit` from `new-task-submit.ts` and rewires `doSubmit` around the
 * `setSubmitting` latch; if that had broken the module, the Kanban board would
 * never mount. Opening the board and asserting its surface proves the edited
 * bundle loaded and ran end-to-end without throwing.
 */
test.describe('PR #314 — New task submit re-entrancy latch (board module boots after the fix)', () => {
  test('the Kanban board mounts after the canSubmit/setSubmitting rewire', async ({ window }) => {
    await expect(window.locator(sel.board)).toBeHidden()

    await window.locator(statusButtonByText('Tasks')).click()

    // Board mounted + header rendered — proof the edited kanban-board.ts (now
    // importing canSubmit from new-task-submit.ts and gating doSubmit on the
    // shared setSubmitting latch) bundle loaded without throwing.
    await expect(window.locator(sel.board)).toBeVisible()
    // A fresh launch has no project, so the board renders its distinct
    // "No project open" state (#622) instead of lanes — still the board's own
    // #render output, so it proves the bundle mounted without throwing.
    await expect(window.locator('.fl-board-no-project')).toBeVisible()
    await expect(window.locator('.fl-board-no-project-label')).toHaveText('No project open')
  })
})
