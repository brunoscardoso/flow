import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import type { Page } from '@playwright/test'
import { test, expect } from '../fixtures/electron'
import { sel } from '../selectors'
import { activateProject, activeProjectName, showActiveProjectFiles, FILES_PANE, removeTempDir } from './fixtures/seed'

/**
 * Flow 1 — same-basename project disambiguation (#426) DRIVEN end-to-end.
 *
 * Two project roots that share a folder basename (e.g. ~/work/api and
 * ~/personal/api) must NOT render as two identical "api" rows — that is a silent
 * mis-target risk (a user switches to, or commits into, the wrong project because
 * the switcher can't tell them apart). `projectLabel` (#426) disambiguates by
 * appending the parent segment: "api — work" / "api — personal". That logic is
 * unit-tested (project-label.test.ts) but has never been DRIVEN through the real
 * switcher/dropdown/sidebar surfaces. This probe seeds two same-basename projects
 * and asserts the disambiguated labels reach every user-facing surface AND that
 * clicking a disambiguated row switches to the RIGHT project (tree rebinds).
 *
 * Sibling flow-1 probes (project / project-switch-reorder / project-manage /
 * project-active-invariants / project-group-switch / project-switcher-escape) all
 * use `seedProject`, whose `mkdtempSync` gives every root a UNIQUE basename — so
 * the collision path is never exercised there.
 *
 * Credential-free: everything here is immediate `project:*` IPC; the native
 * "+ Open Project…" picker is never clicked. Watches pageerrors throughout.
 */
const SCREENS = 'e2e/ux/__screens'

/** Throwaway parent dirs created here (seedProject's cleanupSeeds won't see them). */
const scratchParents: string[] = []

/**
 * Create a git repo whose LEAF folder name is exactly `leaf`, nested under a
 * fresh unique parent, and add it as a project root. Returns its root path.
 * Two calls with the same `leaf` produce a basename collision across distinct
 * parents — the #426 scenario.
 */
async function seedNamedProject(win: Page, leaf: string): Promise<string> {
  const parent = mkdtempSync(join(tmpdir(), 'flow-ux-samebase-'))
  scratchParents.push(parent)
  const root = join(parent, leaf)
  mkdirSync(root)
  execFileSync('git', ['init', '-q'], { cwd: root })
  await win.evaluate(async (p) => {
    await (
      window as unknown as {
        flow: { project: { add(r: { path: string }): Promise<unknown> } }
      }
    ).flow.project.add({ path: p })
  }, root)
  return root
}

async function switcherLabel(win: Page): Promise<string> {
  return activeProjectName(win)
}

/** Expected disambiguated label for a collided root: "<leaf> — <parent-name>". */
function expectedLabel(root: string): string {
  return `${basename(root)} — ${basename(dirname(root))}`
}

/** Open the titlebar switcher dropdown (idempotent-ish: opens if closed). */
async function openSwitcher(win: Page): Promise<void> {
  await win.locator('.fl-project-current').click()
  await win.locator('.fl-project-menu').waitFor({ state: 'visible', timeout: 3000 })
}

/** The group-header row for a disambiguated label in the thread sidebar. */
function groupRowFor(win: Page, label: string) {
  return win.locator(`.row:has([aria-label="New thread or task in ${label}"])`)
}

async function selectRail(win: Page, id: 'threads' | 'files'): Promise<void> {
  await win.locator(`.fl-activity-bar [data-rail-item="${id}"]`).click()
}

/**
 * Robustly clear the per-project flow-settings overlay that auto-opens the first
 * time a config-less project becomes active. It sits above the main content and
 * intercepts sidebar clicks (the titlebar switcher stays reachable above it), so
 * it must be gone before driving the sidebar / file tree. Escape can need a beat.
 */
async function clearFlowOverlay(win: Page): Promise<void> {
  for (let k = 0; k < 4; k++) {
    const open = win.locator('.fl-settings-overlay:not([hidden])')
    if ((await open.count()) === 0) return
    await win.keyboard.press('Escape')
    await win.waitForTimeout(400)
  }
}

test.describe('same-basename projects are disambiguated everywhere (#426)', () => {
  test.afterAll(() => {
    while (scratchParents.length) {
      const dir = scratchParents.pop()
      if (dir) removeTempDir(dir)
    }
  })

  // RETIRED 2026-10-09: every step here reads the titlebar PROJECT switcher
  // (its label and its rows) or the sidebar's per-project group headers — both
  // deleted with the Workspaces hard migration (41a6322d). Whether two projects
  // named "api" read apart in the Workspace switcher and the Files picker is the
  // same question asked of the new surfaces; it is open, not ported.
  test.skip('collided project labels disambiguate + switch to the right project', async ({ window }) => {
    const errors: string[] = []
    window.on('pageerror', (e) => errors.push(String(e)))

    // Two projects that share the basename "api" under distinct parents,
    // each with a marker file so the file tree unambiguously identifies the bound
    // project.
    const a = await seedNamedProject(window, 'api')
    writeFileSync(join(a, 'AAA_MARKER_A.txt'), 'a')
    const b = await seedNamedProject(window, 'api')
    writeFileSync(join(b, 'BBB_MARKER_B.txt'), 'b')

    const labelA = expectedLabel(a)
    const labelB = expectedLabel(b)
    // Sanity: the two disambiguated labels differ, and neither is the bare leaf.
    expect(labelA).not.toBe(labelB)
    expect(labelA).not.toBe(basename(a)) // must NOT collapse to bare "api"

    await activateProject(window, a) // A active
    await clearFlowOverlay(window) // the auto-opened settings overlay blocks the sidebar

    // 1) Titlebar shows A's DISAMBIGUATED label, not the bare colliding basename.
    await expect(async () => {
      expect(await switcherLabel(window)).toBe(labelA)
    }).toPass({ timeout: 4000 })

    // 2) Switcher dropdown lists BOTH projects with distinct disambiguated labels
    //    (plus "+ Open Project…") — no two identical "api" rows.
    await openSwitcher(window)
    const items = window.locator('.fl-project-menu .fl-project-item:not(.fl-project-open)')
    await expect(items).toHaveCount(2)
    const itemTexts = (await items.allTextContents()).map((t) => t.trim())
    expect(itemTexts).toContain(labelA)
    expect(itemTexts).toContain(labelB)
    expect(itemTexts).not.toContain(basename(a)) // never a bare "api" row
    // Both rows are genuinely distinct on screen.
    expect(new Set(itemTexts).size).toBe(2)
    await window.screenshot({ path: `${SCREENS}/project-samename-dropdown.png` })

    // 3) Baseline file tree = A's marker (also nudges the sidebar to render).
    await win_close_switcher(window)
    const filesPane = window.locator(FILES_PANE)
    await showActiveProjectFiles(window)
    await expect(filesPane.getByText('AAA_MARKER_A.txt')).toBeVisible({ timeout: 5000 })
    await expect(filesPane.getByText('BBB_MARKER_B.txt')).toHaveCount(0)

    // 4) The sidebar group headers disambiguate too (both distinct rows present),
    //    matching the switcher — no two identical "api" headers.
    await selectRail(window, 'threads')
    await expect(groupRowFor(window, labelA)).toHaveCount(1)
    await expect(groupRowFor(window, labelB)).toHaveCount(1)

    // 5) Switch to B via its disambiguated dropdown row and confirm the project
    //    actually rebinds to B (not A) — proving the label targets the right root.
    await openSwitcher(window)
    await window.locator(`.fl-project-item[title="${b}"]`).click()
    await clearFlowOverlay(window) // B is config-less too → overlay reopens

    await expect(async () => {
      expect(await switcherLabel(window)).toBe(labelB)
    }).toPass({ timeout: 4000 })

    await selectRail(window, 'files')
    await expect(filesPane.getByText('BBB_MARKER_B.txt')).toBeVisible({ timeout: 5000 })
    await expect(filesPane.getByText('AAA_MARKER_A.txt')).toHaveCount(0)

    expect(errors, errors.join(', ')).toEqual([])
  })
})

/** Close the switcher dropdown if open (toggle via the trigger). */
async function win_close_switcher(win: Page): Promise<void> {
  const menu = win.locator('.fl-project-menu')
  if ((await menu.count()) > 0 && (await menu.isVisible())) {
    await win.locator('.fl-project-current').click()
    await menu.waitFor({ state: 'hidden', timeout: 2000 }).catch(() => undefined)
  }
}
