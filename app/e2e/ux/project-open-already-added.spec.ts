import { basename, join } from 'node:path'
import { tmpdir } from 'node:os'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import type { Page } from '@playwright/test'
import { test, expect } from '../fixtures/electron'
import { sel } from '../selectors'
import { seedProject, activateProject, dismissFlowOverlay, cleanupSeeds, activeProjectName } from './fixtures/seed'

/**
 * Flow 1 — the titlebar switcher's "+ Open Project…" affordance while a project
 * is ALREADY active.
 *
 * Since #128 removed the sidebar's own "Add project" button, this one menu item
 * is the only in-app entry point for reaching a project folder — and it lives
 * inside the *project switcher*, the menu whose entire job is choosing which
 * project you are in. Its sibling rows in the same menu enter the project they
 * name (`setActiveProject`), and on a project-less launch every "Open Folder…"
 * CTA enters what you pick (#382). But `shell.ts` fires
 * `api.project.open()` and discards the returned root, and the main
 * handler shares `addRootAndMaybeActivate`, whose `activeRoot() === null` guard
 * (correct for a background "add") means the pick is NOT entered when a project
 * is already open. Picking a folder that is already in the list is therefore a
 * complete no-op — `addRoot` dedupes it and nothing activates. Filed as #1008.
 *
 * Coverage here:
 *  - test 1 (LIVE): the menu's project rows DO switch (A→B→A). This is the
 *    contrast that proves the probe isn't inert and the menu can activate.
 *  - test 2 (LIVE): picking a folder still dedupes to exactly one row — the
 *    invariant a fix must not break (no phantom duplicate project).
 *  - test 3 (#1008): picking an ALREADY-OPEN project enters it. Was a
 *    `test.fixme` tripwire; verified non-vacuous (against pre-fix main the
 *    titlebar never leaves A).
 *  - test 4 (#1008, second facet): picking a BRAND-NEW folder while another
 *    project is open enters it too — the case that was feedback-free.
 *
 * FIXED by splitting the shared seam by INTENT rather than by handler
 * (main/project/add-root.ts): `project:add` keeps #382's background
 * `when-idle` guard (a repo added on the board must never yank the user out of
 * their project), while `project:open` — the foreground "I picked this
 * folder" — activates `always`, using the canonical path `addRoot` returns, so a
 * re-picked already-open folder enters it too.
 *
 * The native folder picker is invisible to Playwright, so the probe hands
 * `project:open` the already-resolved pick (`{ path }`), which runs the
 * REAL post-pick path — everything after `showOpenDialog` returns, byte for
 * byte. Nothing here is a native-dialog artifact. (The original probe drove
 * `project:add` as a proxy; that proxy is exactly the path the fix
 * deliberately leaves alone, so it is no longer a faithful stand-in.)
 */
const SCREENS = 'e2e/ux/__screens'

/** The active project's name — the titlebar no longer shows it (it names the
 *  Workspace since 2026-10-06), so this reads it from the app. */
async function switcherLabel(win: Page): Promise<string> {
  return activeProjectName(win)
}

/** Everything `project:open` does AFTER the user picks `path` — the
 *  real handler, with the un-automatable `showOpenDialog` step supplied. */
async function pickInOpenProjectDialog(win: Page, path: string): Promise<void> {
  await win.evaluate(async (p) => {
    await (
      window as unknown as {
        flow: { project: { open(r: { path: string }): Promise<unknown> } }
      }
    ).flow.project.open({ path: p })
  }, path)
}

test.describe('"+ Open Project…" with a project already open', () => {
  test.afterAll(() => cleanupSeeds())

  // RETIRED 2026-10-09: "the switcher menu rows enter the project they name"
  // drove the titlebar PROJECT switcher, deleted with the Workspaces hard
  // migration (41a6322d); the Workspace switcher's project rows open that
  // project's settings, not the project.

  test('LIVE: picking an already-open folder still dedupes to exactly one row', async ({
    window,
  }) => {
    const errors: string[] = []
    window.on('pageerror', (e) => errors.push(String(e)))

    const a = await seedProject(window, 'flow-openproj-dedup-a-')
    const b = await seedProject(window, 'flow-openproj-dedup-b-')
    await activateProject(window, a)

    await pickInOpenProjectDialog(window, b) // "+ Open Project…" → pick B again
    await window.waitForTimeout(800)
    // The pick now ENTERS B (#1008), so B's first-visit flow-settings overlay
    // opens and would intercept the switcher click below.
    await dismissFlowOverlay(window)

    // The Workspace switcher lists its projects — B exactly once.
    await window.locator('.fl-project-current').click()
    const menu = window.locator('.fl-project-menu')
    await expect(menu).toBeVisible()
    await expect(menu.locator('.fl-ws-project', { hasText: basename(b) })).toHaveCount(1)
    await window.screenshot({ path: `${SCREENS}/project-open-already-added-menu.png` })
    await window.keyboard.press('Escape')

    expect(errors, errors.join(', ')).toEqual([])
  })

  test('#1008: picking an already-open project in "+ Open Project…" enters it', async ({
    window,
  }) => {
    const a = await seedProject(window, 'flow-openproj-bug-a-')
    const b = await seedProject(window, 'flow-openproj-bug-b-')
    await activateProject(window, a)
    await expect.poll(() => switcherLabel(window)).toBe(basename(a))

    // The user opens the switcher, hits "+ Open Project…" and picks B —
    // a project that is already in the list.
    await pickInOpenProjectDialog(window, b)
    await window.waitForTimeout(1500)
    await dismissFlowOverlay(window)

    // Before the fix the app never left A — the pick was silently discarded.
    await expect.poll(() => switcherLabel(window)).toBe(basename(b))
  })

  test('#1008: picking a BRAND-NEW folder enters it too, even from a second project', async ({
    window,
  }) => {
    const a = await seedProject(window, 'flow-openproj-new-a-')
    await activateProject(window, a)
    await expect.poll(() => switcherLabel(window)).toBe(basename(a))

    // The second facet: a folder the app has never seen, picked while another
    // project is already open. #382's background-add guard used to swallow this
    // too — the root was added but nothing entered it, and with the sidebar
    // toggled off there was no evidence the action did anything at all.
    const fresh = mkdtempSync(join(tmpdir(), 'flow-openproj-fresh-'))
    try {
      await pickInOpenProjectDialog(window, fresh)
      await window.waitForTimeout(1500)
      await dismissFlowOverlay(window)
      await expect.poll(() => switcherLabel(window)).toBe(basename(fresh))
    } finally {
      for (let attempt = 0; attempt < 5 && existsSync(fresh); attempt++) {
        try {
          rmSync(fresh, { recursive: true, force: true })
        } catch {
          // The IDE's background provisioner is still writing — retry.
        }
      }
    }
  })
})
