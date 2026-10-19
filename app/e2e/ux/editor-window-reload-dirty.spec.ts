import { test, expect, dismissOnboarding } from '../fixtures/electron'
import { seedProject, activateProject, dismissFlowOverlay, cleanupSeeds } from './fixtures/seed'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'

/**
 * UX sweep — flow: panel toggles & keyboard shortcuts, round 17 follow-up (#1072).
 *
 * View ▸ Reload (⌘R — the stock Electron `role: 'viewMenu'` in main/menu.ts)
 * tears the renderer down in place. Before the fix nothing guarded it: no
 * `beforeunload`, no `will-prevent-unload`, and the per-project dirty-buffer
 * persistence from #955 only ran on project switches — so every unsaved editor
 * edit was silently destroyed and the restored tab looked clean (the worst kind
 * of loss: invisible).
 *
 * The fix is VS Code-style hot exit (#1072's "best" shape): project-context.ts
 * snapshots the active project's tabs + dirty buffers at `beforeunload` (the
 * IPC write is queued to the main process before the frame goes away), and the
 * existing boot-restore path (project:active → setActiveProject →
 * restoreDirtyContent, #955/0f98afd) rehydrates the typed work — dirty — after
 * the reload.
 *
 * This spec drives the REAL reload seam (`webContents.reload()`, exactly what
 * the menu's `role: 'reload'` invokes) via the Electron API, and locks in:
 *  - the typed-but-unsaved content survives the reload and comes back DIRTY
 *  - the unsaved text never leaks onto disk (blast-radius guard — hot exit
 *    must persist to the app database, not to the user's file)
 */

const SCREENS = 'e2e/ux/__screens'

function appErrors(errors: string[]): string[] {
  return errors.filter((m) => m !== 'Canceled')
}

/** Open a project file through the app's real decoupled `flow:open-file` event. */
async function openFile(win: Page, rootPath: string, relPath: string): Promise<void> {
  await win.evaluate(
    ({ rootPath, relPath }) => {
      document.dispatchEvent(new CustomEvent('flow:open-file', { detail: { rootPath, relPath } }))
    },
    { rootPath, relPath },
  )
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

test('an in-place renderer reload (View ▸ Reload / cmd+R) must not silently destroy an unsaved editor buffer (#1072)', async ({
  app,
  window,
}) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  const dir = await seedProject(window)
  writeFileSync(join(dir, 'alpha.ts'), 'export const ALPHA = "on-disk-v1"\n')
  await activateProject(window, dir)

  await openFile(window, dir, 'alpha.ts')
  await expect(tab(window, 'alpha.ts')).toBeVisible({ timeout: 10000 })
  await expectEditorShows(window, 'on-disk-v1')

  // Type an unsaved edit — the tab shows its dirty dot.
  await window.locator('.monaco-editor .view-lines').click()
  await window.keyboard.press('End')
  await window.keyboard.type('\nexport const PRECIOUS = "unsaved-across-reload"')
  await expect(tab(window, 'alpha.ts').locator('.dirty-dot')).toBeVisible()
  await window.screenshot({ path: `${SCREENS}/editor-window-reload-01-dirty.png` })

  // Reload the renderer in place through the same call the menu's
  // `role: 'reload'` item makes — the #1072 keystroke, driven via Electron.
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.webContents.reload()
  })
  // The Page object survives an in-place reload; wait for the new document,
  // then clear the first-run overlays the fresh renderer re-raises.
  await window.waitForTimeout(500)
  await window.waitForLoadState('domcontentloaded')
  await dismissOnboarding(window)
  await dismissFlowOverlay(window)

  // The tab comes back WITH the typed work, and it comes back DIRTY — the
  // reload was not allowed to silently discard it (or disguise the loss as a
  // clean tab, the exact failure #1072 measured).
  await expect(tab(window, 'alpha.ts')).toBeVisible({ timeout: 15000 })
  await expectEditorShows(window, 'unsaved-across-reload')
  await expect(tab(window, 'alpha.ts').locator('.dirty-dot')).toBeVisible()
  await window.screenshot({ path: `${SCREENS}/editor-window-reload-02-restored.png` })

  // Blast-radius guard: hot exit persists to the app database, never to the
  // user's file — the unsaved text must not have leaked onto disk.
  expect(readFileSync(join(dir, 'alpha.ts'), 'utf8')).toBe('export const ALPHA = "on-disk-v1"\n')

  const appErrs = appErrors(errors)
  expect(appErrs, appErrs.join(', ')).toHaveLength(0)
})
