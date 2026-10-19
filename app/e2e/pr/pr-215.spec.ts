import { test, expect } from '../fixtures/electron'
import { sel, statusButtonByText } from '../selectors'

/**
 * Regression for PR #215 — "show a distinct load-error state instead of a
 * fake-empty Kanban board (#205)".
 *
 * The board's `refresh()` caught any `tasks:list` failure (IPC error, DB
 * locked, store not ready), logged it, and set an empty task array — so a real
 * load failure rendered three empty lanes ("Nothing here yet" / "—"),
 * indistinguishable from a project that genuinely has no tasks. The user
 * believed their tasks vanished, with no error and no way to retry (forbidden
 * pattern #2). #215 adds a pure `resolveBoardView(hasRoot, loadError)`
 * classifier and, in `kanban-board.ts`, a `#loadError` flag that drives a
 * distinct error banner (`.fl-board-error` — "Couldn't load tasks." + Retry)
 * shown INSTEAD of the lanes, plus a `flow:notify` error toast on the catch.
 *
 * Reaching the real error banner needs a project + a failing `tasks:list` —
 * not drivable from a fresh, credential-less launch (see e2e/README.md "Known
 * gate"); the view precedence is covered by the pure `board-view` unit suite.
 * This spec guards the two things that ARE observable headlessly:
 *   1. The board bundle (which now imports `resolveBoardView`) still mounts and
 *      renders its lanes on demand — a broken import or a throw in the reworked
 *      `#render` would crash the board open.
 *   2. The delivered mechanism end-to-end: dispatching the EXACT `flow:notify`
 *      event `#notify` emits for a failed load (state-change / error, title
 *      "Could not load tasks", body = the error message) surfaces a real toast
 *      card. If that bridge weren't wired the fix would stay a silent no-op even
 *      once the catch fires.
 */
test.describe('PR #215 — distinct load-error state for the Kanban board', () => {
  test('the Tasks board opens and renders its lanes (resolveBoardView rewire intact)', async ({
    window,
  }) => {
    await expect(window.locator(sel.board)).toBeHidden()
    await window.locator(statusButtonByText('Tasks')).click()
    // Board mounted — proof kanban-board.ts (now importing resolveBoardView and
    // running the reworked #render) rendered without throwing.
    await expect(window.locator(sel.board)).toBeVisible()
    // A fresh launch has no project, so the board renders its distinct
    // "No project open" state (#622) instead of lanes — still the board's own
    // #render output, so it proves the bundle mounted without throwing.
    await expect(window.locator('.fl-board-no-project')).toBeVisible()
    await expect(window.locator('.fl-board-no-project-label')).toHaveText('No project open')
    // On a fresh, project-less launch the view is not 'load-error': the error
    // banner stays hidden.
    await expect(window.locator('.fl-board-error')).toBeHidden()
  })

  test('a task-load failure notification surfaces a toast via the flow:notify bridge', async ({
    window,
  }) => {
    // Emit the exact event `#notify('Could not load tasks', <message>, 'error')`
    // dispatches from the refresh() catch path.
    await window.evaluate(() => {
      document.dispatchEvent(
        new CustomEvent('flow:notify', {
          detail: {
            kind: 'state-change',
            rootId: '/tmp/qa-pr-215',
            title: 'Could not load tasks',
            body: 'database is locked',
            timestamp: new Date().toISOString(),
            level: 'error',
          },
        }),
      )
    })

    const toast = window.locator('.fl-flow-toast').filter({ hasText: 'Could not load tasks' })
    await expect(toast).toHaveCount(1)
    await expect(toast.locator('.fl-flow-title')).toHaveText('Could not load tasks')
    await expect(toast.locator('.fl-flow-toast-body')).toHaveText('database is locked')
  })
})
