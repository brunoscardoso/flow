import { basename, join } from 'node:path'
import { writeFileSync } from 'node:fs'
import type { Page } from '@playwright/test'
import { test, expect } from '../fixtures/electron'
import { sel } from '../selectors'
import { seedProject, activateProject, dismissFlowOverlay, cleanupSeeds, activeProjectName, showActiveProjectFiles, FILES_PANE } from './fixtures/seed'

/**
 * Flow 1 — switching the active project by CLICKING its sidebar group header.
 *
 * Every sibling flow-1 probe switches projects via the titlebar switcher menu
 * (project-switch-reorder / project-switcher-escape) or directly via IPC
 * (project-active-invariants). None drive the most natural switch a user makes:
 * clicking the project's group-header row in the thread sidebar
 * (`thread-sidebar.ts` list click → `#activateProject`, ~207-212). This probe
 * asserts that click rebinds the WHOLE window, not just the titlebar:
 *
 *   - the titlebar switcher label follows to the clicked project, AND
 *   - the Files-rail file tree rebinds to the clicked project's contents
 *     (a distinctly-named marker file per project proves the tree actually
 *     reloaded — the strongest "project surfaces followed the switch" signal
 *     a user feels).
 *
 * Credential-free (all immediate `project:*` IPC; the native picker is never
 * clicked). Watches pageerrors throughout.
 */
const SCREENS = 'e2e/ux/__screens'

async function switcherLabel(win: Page): Promise<string> {
  return activeProjectName(win)
}

/** The group-header row for `name` in the thread sidebar (clicking it activates). */
function groupRowFor(win: Page, name: string) {
  return win.locator(`.row:has([aria-label="New thread or task in ${name}"])`)
}

/** Switch the activity sidebar to a rail pane (threads/files/source-control). */
async function selectRail(win: Page, id: 'threads' | 'files'): Promise<void> {
  await win.locator(`.fl-activity-bar [data-rail-item="${id}"]`).click()
}

test.describe('project group-header switch rebinds every project surface', () => {
  test.afterAll(() => cleanupSeeds())

  // RETIRED 2026-10-09: the sidebar's per-project GROUP HEADER rows this
  // clicked went with the Workspaces hard migration (41a6322d) — the thread
  // list is one list now. Switching projects by a header no longer exists.
  test.skip('clicking a project group header switches titlebar + file tree', async ({ window }) => {
    const errors: string[] = []
    window.on('pageerror', (e) => errors.push(String(e)))

    // Two projects, each with a distinctly-named marker file so the file tree's
    // contents unambiguously identify which project is bound.
    const a = await seedProject(window)
    writeFileSync(join(a, 'AAA_MARKER_A.txt'), 'a')
    const b = await seedProject(window)
    writeFileSync(join(b, 'BBB_MARKER_B.txt'), 'b')
    await activateProject(window, a) // a active
    expect(await switcherLabel(window)).toBe(basename(a))

    // Files rail shows A's tree (marker A present, marker B absent). Scope to the
    // Files pane (exact class — filesBody) so the marker's git/review-panel echoes
    // (.gp-name / .fl-review-file-name, it's an untracked change) don't collide.
    await showActiveProjectFiles(window)
    const filesPane = window.locator(FILES_PANE)
    await expect(filesPane.getByText('AAA_MARKER_A.txt')).toBeVisible({ timeout: 5000 })
    await expect(filesPane.getByText('BBB_MARKER_B.txt')).toHaveCount(0)

    // Back to Threads rail and CLICK project B's group-header row to switch.
    await selectRail(window, 'threads')
    await groupRowFor(window, basename(b)).click()
    await dismissFlowOverlay(window)

    // Titlebar follows to B …
    await expect(async () => {
      expect(await switcherLabel(window)).toBe(basename(b))
    }).toPass({ timeout: 4000 })

    // … and the file tree rebinds: B's marker now present, A's gone.
    await selectRail(window, 'files')
    await expect(filesPane.getByText('BBB_MARKER_B.txt')).toBeVisible({ timeout: 5000 })
    await expect(filesPane.getByText('AAA_MARKER_A.txt')).toHaveCount(0)

    await window.screenshot({ path: `${SCREENS}/project-group-switch.png` })
    expect(errors, errors.join(', ')).toEqual([])
  })
})
