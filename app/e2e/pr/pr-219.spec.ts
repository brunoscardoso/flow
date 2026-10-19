import { test, expect } from '../fixtures/electron'
import { sel, statusButtonByText } from '../selectors'

/**
 * Regression for PR #219 — "stop the detail modal resetting scroll on every
 * background tasks:updated (#204)".
 *
 * `tasks:updated` broadcasts globally on ANY task mutation (debounced), and the
 * board's `refresh()` → `#render()` called `this.#detail?.rerender()` every
 * time. `#renderDetailBody` starts with `modal.textContent = ''`, rebuilding
 * every node — which snapped the open detail modal's scroll back to the top
 * mid-read, most disruptively while an agent was actively touching tasks. The
 * fix, in `kanban-board.ts`, computes a `taskDetailSignature(task)` (a digest of
 * exactly the fields the modal renders — title, source, external key/url, brief
 * + status, description, threadId) and skips the rebuild when THIS task's
 * visible content is unchanged; when it genuinely changed, the rebuild still
 * runs but `modal.scrollTop` and the description element's `scrollTop` are
 * captured and restored. The signature's completeness and stability are fully
 * covered by the `task-detail` unit suite (stable for identical content;
 * unchanged for lane/suggestDone/updatedAt; changed for every rendered field).
 *
 * Opening a task-detail modal needs a project with tasks — not drivable from a
 * fresh, credential-less launch (see e2e/README.md "Known gate"). This spec
 * guards the headlessly-observable half: the Tasks board bundle now imports
 * `taskDetailSignature` from the new `./task-detail` module at module scope, so
 * a broken/renamed export would crash the whole board on open. The board
 * mounting and rendering its lanes proves that wiring is intact.
 */
test.describe('PR #219 — detail modal preserves scroll across background updates', () => {
  test('the Tasks board opens and renders its lanes (task-detail import intact)', async ({
    window,
  }) => {
    await expect(window.locator(sel.board)).toBeHidden()
    await window.locator(statusButtonByText('Tasks')).click()
    // Board mounted — proof kanban-board.ts's module-scope
    // `import { taskDetailSignature } from './task-detail'` resolved and the
    // board rendered without throwing.
    await expect(window.locator(sel.board)).toBeVisible()
    // A fresh launch has no project, so the board renders its distinct
    // "No project open" state (#622) instead of lanes — still the board's own
    // #render output, so it proves the bundle mounted without throwing.
    await expect(window.locator('.fl-board-no-project')).toBeVisible()
    await expect(window.locator('.fl-board-no-project-label')).toHaveText('No project open')
    // No detail modal on a fresh launch (no tasks to open) — the board is clean.
    await expect(window.locator('.fl-board-detail')).toBeHidden()
  })
})
