import { test, expect } from '../fixtures/electron'
import { seedProject, activateProject, dismissFlowOverlay, cleanupSeeds } from './fixtures/seed'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'

/**
 * UX sweep — flow 7 (Editor): the editor open-tab set FOLLOWS the active project
 * across a switch (ADR-002 per-project tab persistence). Genuinely un-probed —
 * every prior flow-7 editor probe (open/tabs/dirty-save/close/reopen, tab-nav,
 * overflow/scroll, conflict merge, markdown preview, select-to-chat, save-fail)
 * drives a SINGLE seeded project; none drives what happens to the editor tabs
 * when the active project changes out from under them.
 *
 * The seam is a data-integrity guard, not cosmetics. On an activeProjectChanged
 * broadcast, project-context.ts persists the OUTGOING project's tabs
 * (`saveOpenFiles`) and rebinds the editor to the new project via
 * `editorApi.setActiveProject(context)`, which closes all current tabs silently
 * (no dirty prompt — programmatic) and reopens the NEW project's saved tabs in
 * order, activating its saved active file (editor/index.ts 595-634). The main
 * process persists `open_files`/`active_file` per project row and reloads them
 * into the broadcast context (project/project-context.ts #load).
 *
 * Two ways this can hurt a real user:
 *   - LEAK: project A's tabs stay visible while B is active → the user edits/saves
 *     against the wrong project's files (the #426-class silent mis-target).
 *   - LOSS: switching away and back drops A's open tabs (or its active tab) → the
 *     user's working set silently vanishes on every project hop.
 *
 * Account-independent, git-independent, no agent. Both switch directions are
 * driven through the real `project:setActive` IPC (the same broadcast
 * the titlebar switcher fires); files open via the decoupled `flow:open-file`
 * event (independent of the #663/#664 activity-bar markup). Monaco's benign
 * internal "Canceled" on model dispose is filtered — see editor.spec.ts.
 */

const SCREENS = 'e2e/ux/__screens'

function appErrors(errors: string[]): string[] {
  return errors.filter((m) => m !== 'Canceled')
}

function trackErrors(win: Page): string[] {
  const errors: string[] = []
  win.on('pageerror', (e) => errors.push(e.message))
  win.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console.error: ${m.text()}`)
  })
  return errors
}

/** Open a project file through the app's real decoupled `flow:open-file` event —
 *  the same path the Files tree / blueprint file-rows dispatch. */
async function openFile(win: Page, rootPath: string, relPath: string): Promise<void> {
  await win.evaluate(
    ({ rootPath, relPath }) => {
      document.dispatchEvent(new CustomEvent('flow:open-file', { detail: { rootPath, relPath } }))
    },
    { rootPath, relPath },
  )
}

/** Switch the active project via the real IPC (broadcasts activeProjectChanged).
 *  Not the seed helper's `activateProject` — that also seeds; here the roots
 *  already exist and we just flip which one is active. Dismisses the per-project
 *  flow-settings overlay in case an unconfigured project auto-opens it. */
async function switchTo(win: Page, rootPath: string): Promise<void> {
  await win.evaluate(async (p) => {
    await (
      window as unknown as {
        flow: { project: { setActive(r: { rootPath: string }): Promise<unknown> } }
      }
    ).flow.project.setActive({ rootPath: p })
  }, rootPath)
  await dismissFlowOverlay(win)
}

/** The editor tab strip button whose visible label matches `name`. */
function tab(win: Page, name: string) {
  return win.locator('.fl-shell fl-tabs .tab', { hasText: name })
}

/** Wait until Monaco shows a line containing `text` (content actually rendered). */
async function expectEditorShows(win: Page, text: string): Promise<void> {
  await expect(win.locator('.monaco-editor .view-lines')).toContainText(text, { timeout: 15000 })
}

test.afterAll(() => cleanupSeeds())

test('editor tabs follow the active project: restored on return, never leaked into a sibling', async ({
  window,
}) => {
  const errors = trackErrors(window)

  // ── Project A: two files with distinct markers, shared.ts opened LAST (active).
  const dirA = await seedProject(window, 'flow-ux-projA-')
  writeFileSync(join(dirA, 'alpha.ts'), 'export const ALPHA = "alpha-marker-A"\n')
  writeFileSync(join(dirA, 'shared.ts'), 'export const SHARED = "shared-marker-A"\n')
  await activateProject(window, dirA)

  await openFile(window, dirA, 'alpha.ts')
  await expect(tab(window, 'alpha.ts')).toBeVisible({ timeout: 10000 })
  await openFile(window, dirA, 'shared.ts')
  await expect(tab(window, 'shared.ts')).toBeVisible({ timeout: 10000 })
  await expectEditorShows(window, 'shared-marker-A')
  // shared.ts (opened last) is A's active tab — the state that must survive.
  await expect(tab(window, 'shared.ts')).toHaveClass(/active/)
  await window.screenshot({ path: `${SCREENS}/editor-tabs-follow-01-projA.png` })

  // ── Project B: a single distinctly-named file, no tabs yet.
  const dirB = await seedProject(window, 'flow-ux-projB-')
  writeFileSync(join(dirB, 'beta.ts'), 'export const BETA = "beta-marker-B"\n')

  // Switch to B. A's tabs must be torn down — NOT leaked into B (mis-target guard).
  await switchTo(window, dirB)
  await expect(tab(window, 'alpha.ts')).toHaveCount(0)
  await expect(tab(window, 'shared.ts')).toHaveCount(0)

  // Open beta.ts in B → B now owns exactly one tab.
  await openFile(window, dirB, 'beta.ts')
  await expect(tab(window, 'beta.ts')).toBeVisible({ timeout: 10000 })
  await expectEditorShows(window, 'beta-marker-B')
  await window.screenshot({ path: `${SCREENS}/editor-tabs-follow-02-projB.png` })

  // ── Switch back to A: its BOTH tabs must be RESTORED (loss guard), B's beta.ts
  //    must be GONE (leak guard), and A's active tab (shared.ts) must be re-armed.
  await switchTo(window, dirA)
  await expect(tab(window, 'alpha.ts')).toBeVisible({ timeout: 10000 })
  await expect(tab(window, 'shared.ts')).toBeVisible({ timeout: 10000 })
  await expect(tab(window, 'beta.ts')).toHaveCount(0)
  await expect(tab(window, 'shared.ts')).toHaveClass(/active/)
  await expectEditorShows(window, 'shared-marker-A')
  await window.screenshot({ path: `${SCREENS}/editor-tabs-follow-03-back-to-projA.png` })

  // ── Round-trip back to B: beta.ts restored, A's tabs gone again (no stuck state).
  await switchTo(window, dirB)
  await expect(tab(window, 'beta.ts')).toBeVisible({ timeout: 10000 })
  await expect(tab(window, 'alpha.ts')).toHaveCount(0)
  await expect(tab(window, 'shared.ts')).toHaveCount(0)
  await expectEditorShows(window, 'beta-marker-B')

  expect(
    appErrors(errors),
    `uncaught errors during editor tab project-switch:\n${errors.join('\n')}`,
  ).toEqual([])
})
