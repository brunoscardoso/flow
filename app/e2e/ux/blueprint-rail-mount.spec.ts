import { test, expect } from '../fixtures/electron'
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed'

/**
 * UX sweep — flow 10 (Blueprint): can a user actually reach the blueprint board?
 *
 * History: post-#663 the Blueprint board briefly lived as a sidebar rail PANE,
 * unreachable because the whole sidebar body was detached at boot (#664). The
 * #668 rewire resolved this by making Blueprint an activity-bar ACTION item
 * (aria-label "Blueprint", no `data-rail-item`) that dispatches
 * `flow:open-blueprint` — the board opens as an editor tab
 * (blueprint/index.ts's openBlueprintTab), the surface it originally targeted.
 *
 * This spec drives that real flow end to end: seed a project → click the
 * Blueprint rail action → the live board root mounts.
 */

test.afterAll(() => cleanupSeeds())

// The opener moved from the activity rail to the editor's top bar: the rail
// holds only sidebar surfaces now (Threads / Files / Source Control,
// shell.ts buildActivityBar), and Blueprint sits with the other view actions.
test('the editor top bar renders the Blueprint action (and the rail does not)', async ({ window }) => {
  const actions = window.locator('.fl-editor-actions')
  await expect(actions).toBeVisible()
  await expect(actions.locator('.fl-rail-item[aria-label="Blueprint"]')).toBeVisible()
  await expect(window.locator('.fl-activity-bar .fl-rail-item[aria-label="Blueprint"]')).toHaveCount(0)
})

test('clicking the Blueprint action opens the LIVE blueprint board (#664)', async ({
  window,
}) => {
  const proj = await seedProject(window)
  await activateProject(window, proj)

  await window.locator('.fl-editor-actions .fl-rail-item[aria-label="Blueprint"]').click()

  // The blueprint opens as an editor tab with the live board root — not an
  // empty/absent pane. `.flow-board-root` (blueprint-board.ts:620) is that
  // root; the retired BlueprintView's `.bpv-root` this used to also assert no
  // longer exists anywhere in the source (see the note in blueprint.spec.ts),
  // so the assertion could only ever fail — rotted guard, dropped.
  await expect(window.locator('.flow-board-root')).toBeVisible({ timeout: 10_000 })
})
