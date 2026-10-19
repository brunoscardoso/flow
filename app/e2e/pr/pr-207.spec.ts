import { test, expect } from '../fixtures/electron'
import { sel } from '../selectors'
import { FILES_PANE } from '../ux/fixtures/seed'

/**
 * Regression for PR #207 — "surface a toast when a file-tree create/rename/
 * delete fails (#196)".
 *
 * The editor file-tree context-menu actions (New File, New Folder, Rename,
 * Delete) swallowed failures to `console.error` only. On a name collision,
 * invalid name, or permission error the menu just closed and nothing changed on
 * screen — no toast, no dialog (forbidden pattern #2); Rename was especially
 * misleading. #207 adds a pure `fileOpFailedToast(op, path, error)` builder and
 * a `#notifyError` helper in `file-tree.ts` that dispatches a `flow:notify`
 * error toast (kind `state-change`) via the NotificationCenter bridge on each
 * catch path.
 *
 * Triggering a real op failure needs a project + file-tree + a failing fs op —
 * none drivable from a fresh, credential-less launch (see e2e/README.md "Known
 * gate"); the toast COPY is covered by the pure `editor-feedback` unit suite.
 * This spec guards the two things that ARE observable headlessly:
 *   1. The file-tree bundle (which now imports `fileOpFailedToast`) still mounts
 *      and renders its empty state on the default-active Files tab — a broken
 *      import would crash that render.
 *   2. The delivered mechanism end-to-end: dispatching the EXACT `flow:notify`
 *      event `#notifyError` emits (state-change / error, with the copy
 *      `fileOpFailedToast('create', …)` produces) surfaces a real toast card.
 *      If that bridge weren't wired for state-change error notifications the fix
 *      would stay a silent no-op even once the catch fires.
 */
test.describe('PR #207 — file-tree op-failure toast', () => {
  test('the file-tree renders on the Files tab (import rewire intact)', async ({
    window,
  }) => {
    await expect(window.locator(sel.shell)).toBeVisible()
    // Post-#674 the default active rail item is Threads; open the Files pane.
    await window.locator('[data-rail-item="files"]').click()
    await expect(window.locator('[data-rail-item="files"]')).toHaveClass(/active/)
    // The file-tree mounted — its "Open Folder…" affordance is in the DOM (the
    // empty-state hint stays display:none until the first roots refresh, so we
    // assert attached, not visible). Proof file-tree.ts (now importing
    // fileOpFailedToast) rendered without throwing on the Files tab.
    // Scoped to the Files pane: the Source Control pane renders its own
    // "Open Folder…" for the same no-project state.
    await expect(
      window.locator(FILES_PANE).locator('fl-button').filter({ hasText: 'Open Folder' }),
    ).toBeAttached()
  })

  test('a file-op failure notification surfaces a toast via the flow:notify bridge', async ({
    window,
  }) => {
    // Emit the exact event `#notifyError` dispatches for a failed create, with
    // the exact title `fileOpFailedToast('create', 'src/util/new.ts', …)` builds
    // (basename only) and the error text as the body.
    await window.evaluate(() => {
      document.dispatchEvent(
        new CustomEvent('flow:notify', {
          detail: {
            kind: 'state-change',
            rootId: '/tmp/qa-pr-207',
            title: "Couldn't create new.ts",
            body: 'already exists',
            timestamp: new Date().toISOString(),
            level: 'error',
          },
        }),
      )
    })

    const toast = window.locator('.fl-flow-toast').filter({ hasText: "Couldn't create new.ts" })
    await expect(toast).toHaveCount(1)
    await expect(toast.locator('.fl-flow-title')).toHaveText("Couldn't create new.ts")
    await expect(toast.locator('.fl-flow-toast-body')).toHaveText('already exists')
  })
})
