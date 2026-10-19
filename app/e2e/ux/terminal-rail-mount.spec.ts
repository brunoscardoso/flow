import { test, expect } from '../fixtures/electron'
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed'

/**
 * UX sweep — flow 8 (Terminal): can a user actually reach a live shell?
 *
 * History: post-#663 the terminal briefly lived as a sidebar rail PANE, which
 * was doubly broken — the sidebar body was detached at boot (#664) and the
 * pane held only a static placeholder while the live `#fl-panel-terminal`
 * stayed orphaned (the wiring gap this spec originally tripwired). The #668
 * rewire resolved both by moving Terminal to an activity-bar ACTION item
 * (aria-label "Terminal", no `data-rail-item`) that toggles the live terminal
 * panel into the editor stack — the same xterm host the old status-bar toggle
 * mounted.
 *
 * This spec drives that real flow end to end: seed a project → click the
 * Terminal rail action → a real `.xterm` mounts (no placeholder standing in).
 */

test.afterAll(() => cleanupSeeds())

test('the editor area\'s view toolbar renders the Terminal action', async ({ window }) => {
  // The rail is sidebar surfaces only since the Workspaces layout; the controls
  // that open views moved to the editor area's "Open a view" toolbar.
  const actions = window.locator('.fl-editor-actions')
  await expect(actions).toBeVisible()
  await expect(actions.locator('.fl-rail-item[aria-label="Terminal"]')).toBeVisible()
  await expect(window.locator('.fl-activity-bar .fl-rail-item[aria-label="Terminal"]')).toHaveCount(0)
})

test('the Terminal rail action toggles a LIVE terminal in the editor stack', async ({
  window,
}) => {
  const proj = await seedProject(window)
  await activateProject(window, proj)

  // Terminal is in the editor stack by default (terminalVisible defaults on)
  // with its real chrome — not a static `.fl-placeholder`. Activating a
  // project scopes the tab strip, so a fresh project starts at the empty state.
  const termRoot = window.locator('.fl-term-root')
  await expect(termRoot).toBeVisible()
  await expect(window.locator('.fl-placeholder')).toHaveCount(0)

  // The rail action is a true toggle: off removes the panel from the stack...
  const railToggle = window.locator('.fl-editor-actions .fl-rail-item[aria-label="Terminal"]')
  await railToggle.click()
  await expect(termRoot).toBeHidden()

  // ...and on re-reveals it AND auto-starts a live shell for the active
  // project (flow:terminal-shown → ensureStarted, VS Code parity) — the
  // wiring the rail rewire had dropped.
  await railToggle.click()
  await expect(termRoot).toBeVisible()
  await expect(window.locator('.fl-term-host .xterm:visible').first()).toBeVisible({ timeout: 15000 })
})
