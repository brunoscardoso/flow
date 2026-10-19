import { basename } from 'node:path'
import type { Page } from '@playwright/test'
import { test, expect } from '../fixtures/electron'
import { sel } from '../selectors'
import { seedProject, activateProject, dismissFlowOverlay, cleanupSeeds, activeProjectName } from './fixtures/seed'
import { openProjectActions, switcherListsProject } from './fixtures/project-actions'

/**
 * Flow 1 — Project ACTIVE-context invariants. Sibling flow-1 probes
 * (project / project-switch-reorder / project-manage / project-switcher-escape)
 * cover the switcher's happy + dismiss paths and assert bridge order after a
 * reorder / removal. They do NOT pin the one thing a user actually feels: that
 * *managing* projects never silently yanks the active project out from under you.
 * This probe guards those invariants:
 *
 *   - Reordering a NON-active project (Move to top) must leave the ACTIVE project
 *     and every bound surface unchanged.
 *   - Removing a NON-active project must leave the ACTIVE project unchanged (only
 *     the removed row disappears) — no accidental re-activation / empty state.
 *   - Re-adding an already-open folder dedups to a single switcher row
 *     (`ProjectRegistry.addRoot` returns the existing root) — no phantom
 *     duplicate project.
 *   - The empty "No project" dropdown offers exactly the "+ Open Project…"
 *     affordance and no phantom project rows.
 *
 * Credential-free: everything here is immediate `project:*` IPC; the native
 * "Open Project…" picker is never clicked. Watches pageerrors throughout.
 */
const SCREENS = 'e2e/ux/__screens'

async function switcherLabel(win: Page): Promise<string> {
  return activeProjectName(win)
}
async function rootPaths(win: Page): Promise<string[]> {
  return win.evaluate(
    async () =>
      (
        await (
          window as unknown as { flow: { project: { list(): Promise<{ rootPath: string }[]> } } }
        ).flow.project.list()
      ).map((r) => r.rootPath),
  )
}
/** The ⋯ "Project actions" button inside the sidebar group header row for `name`. */
function moreBtnFor(win: Page, name: string) {
  return win.locator(
    `.row:has([aria-label="New thread or task in ${name}"]) [aria-label="Project actions"]`,
  )
}

test.describe('project active-context invariants', () => {
  test.afterAll(() => cleanupSeeds())

  // STILL FIXME (2026-10-09): the project menu is reachable again (the ⋯ on
  // the project's row in the Workspace switcher), but it no longer offers
  // "Move to top" — a Workspace lists its projects in its own order, and
  // reordering them is not a sidebar action any more. Kept as the record.
  test.fixme('reordering a NON-active project leaves the active project untouched', async ({ window }) => {
    const errors: string[] = []
    window.on('pageerror', (e) => errors.push(String(e)))

    const a = await seedProject(window)
    await seedProject(window) // b
    const c = await seedProject(window)
    await activateProject(window, a) // a is active
    expect(await switcherLabel(window)).toBe(basename(a))

    // Move a NON-active project (c) to the top via its ⋯ menu.
    await moreBtnFor(window, basename(c)).click()
    const menu = window.locator('.fl-thread-menu')
    await expect(menu).toBeVisible()
    await menu.locator('.fl-thread-menu-item', { hasText: 'Move to top' }).click()

    // Bridge order now leads with c …
    await expect(async () => {
      expect((await rootPaths(window)).map((p) => basename(p))[0]).toBe(basename(c))
    }).toPass({ timeout: 4000 })
    // … but the ACTIVE project — and its bound surfaces — must be exactly a still.
    expect(await switcherLabel(window)).toBe(basename(a))
    await expect(window.getByText('No project open')).toBeHidden()

    await window.screenshot({ path: `${SCREENS}/project-reorder-keeps-active.png` })
    expect(errors, errors.join(', ')).toEqual([])
  })

  // The door: the ⋯ on the project's row in the Workspace switcher.
  test('removing a NON-active project leaves the active project untouched', async ({ window }) => {
    const errors: string[] = []
    window.on('pageerror', (e) => errors.push(String(e)))

    const a = await seedProject(window)
    const b = await seedProject(window)
    await activateProject(window, a) // a is active
    expect(await switcherLabel(window)).toBe(basename(a))

    // Remove b (NOT active) → inline confirm → Remove.
    const menu = await openProjectActions(window, basename(b))
    await menu.locator('.fl-thread-menu-item', { hasText: 'Remove from sidebar' }).click()
    await menu.locator('.fl-thread-menu-item.danger', { hasText: 'Remove' }).click()

    await expect(async () => {
      expect((await rootPaths(window)).length).toBe(1)
    }).toPass({ timeout: 4000 })
    // The active project must be undisturbed — not reset, not the empty state.
    expect(await switcherLabel(window)).toBe(basename(a))
    await expect(window.getByText('No project open')).toBeHidden()
    await expect.poll(() => switcherListsProject(window, basename(b)), { timeout: 5000 }).toBe(false)

    expect(errors, errors.join(', ')).toEqual([])
  })

  test('re-adding an already-open folder dedups to a single switcher row', async ({ window }) => {
    const errors: string[] = []
    window.on('pageerror', (e) => errors.push(String(e)))

    const a = await seedProject(window)
    await activateProject(window, a)

    // Re-open the SAME folder (addRoot again) — the main process dedups.
    await window.evaluate(async (p) => {
      await (
        window as unknown as { flow: { project: { add(r: { path: string }): Promise<unknown> } } }
      ).flow.project.add({ path: p })
    }, a)
    await dismissFlowOverlay(window)

    expect((await rootPaths(window)).length).toBe(1)
    // The (Workspace) switcher lists the project exactly once.
    await window.locator('.fl-project-current').click()
    const menu = window.locator('.fl-project-menu')
    await expect(menu).toBeVisible()
    await expect(menu.locator('.fl-ws-project', { hasText: basename(a) })).toHaveCount(1)
    await window.keyboard.press('Escape').catch(() => undefined)

    expect(errors, errors.join(', ')).toEqual([])
  })

  // RETIRED 2026-10-09: "the empty No project dropdown offers only the Open
  // affordance" asserted the titlebar PROJECT switcher's empty menu; the
  // switcher names Workspaces since the hard migration (41a6322d), and a fresh
  // launch always has its Default Workspace.
})
