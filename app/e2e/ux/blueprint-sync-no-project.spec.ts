import { test, expect } from '../fixtures/electron'

/**
 * UX sweep — flow 10 (Blueprint): the "Sync status" affordance in the
 * "No active project" empty state (blueprint-connections, #706 → #711).
 *
 * Background: #449/#676 (both CLOSED) established that with no active project a
 * derive is impossible, so derive-dependent header actions ("New Blueprint",
 * "Refresh") are dead clicks. #706 then added a "Sync status" header button that
 * bypassed that honesty fix — filed as #711.
 *
 * Resolution (supersedes the #711 gating): the Sync-status header button was
 * RETIRED for every state. Its content (verdict · graph freshness · annotations
 * · Re-check all) folded into the Learning panel, reached via the learn chip —
 * which is hidden whenever there is no project/graph, so the no-project honesty
 * now holds by construction. This spec keeps the #676 contrast guard and pins
 * the button's absence.
 */

const openBlueprint = async (window: import('@playwright/test').Page) => {
  await window.locator('.fl-editor-actions .fl-rail-item[aria-label="Blueprint"]').click()
  await expect(window.locator('.flow-board-root')).toBeVisible({ timeout: 10_000 })
  await expect(window.locator('.flow-board-root .fb-pane-text')).toHaveText('No active project')
}

// Live contrast guard (passes today): the #676 fix still holds — with no project
// the primary is the honest "Open Project…" and the derive-only "Refresh" button
// is hidden.
test('the #676 fix still hides Refresh + offers Open Project… in the no-project state', async ({
  window,
}) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
  await openBlueprint(window)
  const primary = window
    .locator('.flow-board-root .fb-header fl-button')
    .filter({ hasText: 'Open Project…' })
  await expect(primary).toBeVisible()
  // Refresh is not offered at all: the header's Refresh was retired for every
  // state (the Learning panel's ⟳ is the board's one manual re-derive —
  // blueprint-recheck-feedback.spec.ts), so it is not even in the DOM.
  const refresh = window
    .locator('.flow-board-root .fb-header fl-button')
    .filter({ hasText: 'Refresh' })
  await expect(refresh).toHaveCount(0)
  expect(errors, `uncaught errors:\n${errors.join('\n')}`).toEqual([])
})

// #711 resolution: the Sync-status header button does not exist in ANY state —
// its content lives inside the Learning panel now. With no project the learn
// chip (the panel's entry point) is hidden too, so nothing claims sync
// freshness about a project-less window.
test('the Sync status header button is gone — no sync claim exists in the no-project state', async ({
  window,
}) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
  await openBlueprint(window)

  const sync = window
    .locator('.flow-board-root .fb-header fl-button')
    .filter({ hasText: 'Sync status' })
  await expect(sync).toHaveCount(0)

  // BOTH ways into the Learning panel are shut with no project, so no dead
  // click is offered: the learn chip is hidden, and so is the header Learning
  // button that now stands where "New Blueprint" used to.
  await expect(window.locator('.flow-board-root .fb-learn-chip')).toBeHidden()
  const learning = window
    .locator('.flow-board-root .fb-header fl-button')
    .filter({ hasText: 'Learn' })
  if ((await learning.count()) > 0) await expect(learning.first()).toBeHidden()

  expect(errors, `uncaught errors:\n${errors.join('\n')}`).toEqual([])
})
