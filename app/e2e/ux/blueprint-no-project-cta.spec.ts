import { test, expect } from '../fixtures/electron'

/**
 * UX sweep — flow 10 (Blueprint): the "No active project" empty-state header CTA.
 *
 * Regression guard for #449 (reopened as #676, now fixed). With no project a
 * derive is impossible, so the loud "New Blueprint" primary + "Refresh" were
 * dead clicks (derive() early-returns on a null root, no feedback). The fix
 * added `resolveHeaderActions('no-project')` (view-state.ts) so the empty state
 * offers an honest primary "Open Project…" (mirroring the Files panel) and hides
 * Refresh — but the board only applied it from #render(), while the no-project
 * pane was painted via the direct #renderPaneMessage shortcut (constructor +
 * refresh() when the root is null), so the fix was dead code on the real flow.
 *
 * #676 routes both no-project shortcuts through #render(), so #applyHeaderActions
 * runs and the header is honest. Driven end to end on a fresh, project-less
 * launch (the `window` fixture).
 */

const openBlueprint = async (window: import('@playwright/test').Page) => {
  await window.locator('.fl-editor-actions .fl-rail-item[aria-label="Blueprint"]').click()
  await expect(window.locator('.flow-board-root')).toBeVisible({ timeout: 10_000 })
}

test('the Blueprint board opens in the No active project empty state', async ({ window }) => {
  await openBlueprint(window)
  await expect(window.locator('.flow-board-root .fb-pane-text')).toHaveText('No active project')
})

// #449/#676: the no-project header presents an honest "Open Project…" primary
// and hides Refresh — no dead clicks. This flipped live once both no-project
// render paths (constructor + refresh-null-root) route through #render().
test('#449 — no-project header offers Open Project… and hides Refresh', async ({ window }) => {
  await openBlueprint(window)
  // The first VISIBLE header button: the Learn button sits ahead of it in the
  // DOM and is hidden (display:none) with no project — it is the CTA a person
  // sees first that this guards.
  const primary = window.locator('.flow-board-root .fb-header fl-button:visible').first()
  await expect(primary).toHaveText(/Open Project/)
  await expect(window.locator('.flow-board-root .fb-header fl-button:visible', { hasText: 'Learn' })).toHaveCount(0)
  await expect(
    window.locator('.flow-board-root .fb-header fl-button:has-text("Refresh")'),
  ).toHaveCount(0)
})
