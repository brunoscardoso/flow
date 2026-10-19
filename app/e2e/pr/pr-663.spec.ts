import { pickFilesProject } from '../ux/fixtures/seed'
import { test, expect } from '../fixtures/electron'

/**
 * Regression spec for PR #663/#668 — VS Code-style activity bar + swappable
 * sidebar.
 *
 * The #668 rewire settled the rail on a two-group model:
 *   - Sidebar items (carry `data-rail-item`, get the active indicator and swap
 *     the sidebar body): Threads / Files / Source Control.
 *   - Action items (aria-labeled buttons, no active state): Tasks (kanban tab),
 *     Blueprint (editor tab), Terminal (editor-stack toggle).
 *
 * The #664 detachment (mountShell appended the sidebar into the threads panel
 * and initThreads replaceChildren'd it away) is fixed by giving the activity
 * sidebar its own root-split child (`.fl-activity-sidebar`) with threads
 * mounted into a dedicated pane — so the second test asserts the previously
 * broken behavior live: the sidebar body is attached and a rail click
 * surfaces a visible content pane.
 */

const SIDEBAR_ITEMS: Array<{ id: string; label: string }> = [
  { id: 'threads', label: 'Threads' },
  { id: 'files', label: 'Files' },
  { id: 'source-control', label: 'Source Control' },
]

// The rail is ONE KIND OF THING since the Workspaces layout: sidebar surfaces
// only. The controls that open views moved to the editor area's own toolbar
// (`.fl-editor-actions`, "Open a view") — next to where their result appears.
const ACTION_ITEMS = ['Tasks', 'Blueprint', 'Browser', 'Terminal']

test('activity bar renders sidebar items + action items', async ({ window }) => {
  const rail = window.locator('.fl-activity-bar')
  await expect(rail).toBeVisible()
  for (const { id, label } of SIDEBAR_ITEMS) {
    const btn = rail.locator(`[data-rail-item="${id}"]`)
    await expect(btn).toBeVisible()
    await expect(btn).toHaveAttribute('aria-label', label)
  }
  const actions = window.locator('.fl-editor-actions')
  for (const label of ACTION_ITEMS) {
    await expect(actions.locator(`.fl-rail-item[aria-label="${label}"]`)).toBeVisible()
    // …and only there: the rail does not carry them twice.
    await expect(rail.locator(`.fl-rail-item[aria-label="${label}"]`)).toHaveCount(0)
  }
  // Threads is the default active sidebar item.
  await expect(rail.locator('[data-rail-item="threads"]')).toHaveClass(/active/)
})

test('clicking a rail item reveals its sidebar content pane (#664)', async ({ window }) => {
  // The swappable sidebar body must actually be in the document...
  const sidebarBody = window.locator('.fl-sidebar')
  await expect(sidebarBody).toBeAttached()

  // ...and clicking the Files rail item must surface a visible content pane
  // (not blank the column). Pre-fix the sidebar body was detached, so no
  // `.fl-sidebar-pane` was ever present.
  await window.locator('[data-rail-item="files"]').click()
  await pickFilesProject(window)
  const anyVisiblePane = window.locator('.fl-sidebar-pane:visible')
  await expect(anyVisiblePane.first()).toBeVisible({ timeout: 5000 })
})
