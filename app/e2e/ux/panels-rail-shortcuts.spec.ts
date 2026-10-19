import { test, expect } from '../fixtures/electron'
import { sel } from '../selectors'
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed'

/**
 * Flow 12 — activity-bar keyboard shortcuts (⌘/Ctrl+1-5) and rail-item opens.
 *
 * The VS-Code-style activity bar (#663/#668) introduced a new set of keyboard
 * bindings wired in `shell.ts`' capture-phase keydown handler:
 *   - ⌘1 / ⌘2 / ⌘3 switch the swappable sidebar to Threads / Files / Source
 *     Control (`onRailSelect`), re-pressing the ACTIVE item collapsing the
 *     sidebar (VS Code parity);
 *   - ⌘4 / ⌘5 open the Tasks board / Blueprint as editor tabs
 *     (flow:open-board / flow:open-blueprint) — mirrored by the rail's Tasks /
 *     Blueprint action items.
 * None of this had regression coverage; the pre-existing panels.spec.ts predates
 * the activity bar. This guards the new digit-shortcut + rail wiring against a
 * silent break (a dead ⌘-digit is invisible until a user reaches for it).
 *
 * All assertions were confirmed green by driving the built app during the
 * flow-12 UX sweep (round 6) — no bug found in this surface.
 */
const mod = process.platform === 'darwin' ? 'Meta' : 'Control'

const railItem = (id: string) => `.fl-activity-bar .fl-rail-item[data-rail-item="${id}"]`
// Tasks and Blueprint moved from the rail to the editor's top bar (the rail
// holds only sidebar surfaces now — shell.ts buildActivityBar).
const railAction = (label: string) => `.fl-editor-actions .fl-rail-item[aria-label="${label}"]`
const activitySidebarInRoot = '#fl-split-root > .fl-activity-sidebar'

test.describe('activity-bar shortcuts & rail opens (flow 12)', () => {
  test.afterAll(() => cleanupSeeds())

  test('⌘1-3 switch the sidebar pane and re-pressing the active item collapses it', async ({
    window,
  }) => {
    const errors: string[] = []
    window.on('pageerror', (e) => errors.push(String(e)))

    const root = await seedProject(window)
    await activateProject(window, root)

    // ⌘2 → Files: rail highlights Files, threads pane hidden.
    await window.keyboard.press(`${mod}+2`)
    await expect(window.locator(railItem('files'))).toHaveClass(/active/)
    await expect(window.locator('.fl-sidebar-threads')).toBeHidden()

    // ⌘3 → Source Control: rail highlights SC, the SC body is shown.
    await window.keyboard.press(`${mod}+3`)
    await expect(window.locator(railItem('source-control'))).toHaveClass(/active/)
    await expect(window.locator('.fl-sc-body')).toBeVisible()

    // ⌘1 → Threads: rail highlights Threads, the thread list is shown.
    await window.keyboard.press(`${mod}+1`)
    await expect(window.locator(railItem('threads'))).toHaveClass(/active/)
    await expect(window.locator(sel.threadList)).toBeVisible()
    // Sidebar is open — its wrapper is a root-split child.
    await expect(window.locator(activitySidebarInRoot)).toHaveCount(1)

    // Re-pressing the ACTIVE item (⌘1) collapses the sidebar (VS Code parity):
    // the activity-sidebar wrapper leaves the root split entirely.
    await window.keyboard.press(`${mod}+1`)
    await expect(window.locator(activitySidebarInRoot)).toHaveCount(0)

    // Pressing it once more re-opens it on the same pane.
    await window.keyboard.press(`${mod}+1`)
    await expect(window.locator(activitySidebarInRoot)).toHaveCount(1)
    await expect(window.locator(railItem('threads'))).toHaveClass(/active/)

    expect(errors, errors.join(', ')).toEqual([])
  })

  test('⌘4 opens the Tasks board and ⌘5 opens the Blueprint (the top-bar actions mirror them)', async ({
    window,
  }) => {
    const errors: string[] = []
    window.on('pageerror', (e) => errors.push(String(e)))

    const root = await seedProject(window)
    await activateProject(window, root)

    // ⌘4 → Tasks board opens as an editor tab and is visible.
    await window.keyboard.press(`${mod}+4`)
    await expect(window.locator(sel.board)).toBeVisible({ timeout: 8000 })

    // ⌘5 → Blueprint opens and becomes the active editor surface.
    await window.keyboard.press(`${mod}+5`)
    await expect(window.locator('.flow-board-root')).toBeVisible({ timeout: 10000 })

    // The top bar's Tasks / Blueprint actions dispatch the same opens — clicking
    // Tasks brings its board back to the foreground without error.
    await window.locator(railAction('Tasks')).click()
    await expect(window.locator(sel.board)).toBeVisible({ timeout: 8000 })
    await window.locator(railAction('Blueprint')).click()
    await expect(window.locator('.flow-board-root')).toBeVisible({ timeout: 10000 })

    expect(errors, errors.join(', ')).toEqual([])
  })
})
