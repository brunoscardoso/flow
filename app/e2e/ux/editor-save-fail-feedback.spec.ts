import { test, expect } from '../fixtures/electron'
import { seedProject, activateProject, cleanupSeeds, pickFilesProject } from './fixtures/seed'
import { chmodSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'

/**
 * UX sweep — flow 7 (Editor), round 9: cmd+S SAVE-FAILURE feedback (#195/#200).
 *
 * The whole editor flow is heavily probed (editor.spec open/tabs/dirty+save/
 * close/reopen/binary, tab-nav ctrl+Tab, tab-overflow #700, conflict-merge,
 * markdown-preview, select→chat ⌘L) — but every dirty+save assertion drives the
 * SUCCESS path only. The FAILURE path (project:writeFile rejects → the tab
 * used to keep its dirty dot with no other signal, indistinguishable from
 * ordinary unsaved edits: a user closes the file / quits believing the change is
 * on disk when it never hit disk — a silent data-loss trap, forbidden pattern
 * #2). #200 added `saveFailedToast` and dispatches it from saveFile's catch,
 * keeping the buffer dirty (it rethrows, so nothing typed is lost).
 *
 * That END-TO-END path had ZERO live coverage: e2e/pr/pr-200.spec.ts states the
 * toast "needs a real project + an open dirty file + a project:writeFile
 * failure to fire — none of which is drivable from a fresh, credential-less
 * launch" and only asserts the reworked editor bundle still mounts; the toast
 * content is covered by pure unit tests. It IS drivable: seed a project, open a
 * file, dirty it, then make the file's parent directory read-only (chmod 0555).
 * project:writeFile is an atomic temp-file-beside-target + rename, so the temp
 * write fails with EACCES — a real, deterministic, credential-less, git- and
 * agent-independent failure (mirrors the git/review commit-fail-feedback probes).
 *
 * Asserts the anti-data-loss contract: (1) a 'Save failed' toast surfaces (not
 * silent), (2) the tab STAYS dirty (nothing typed is lost), (3) the file on disk
 * is UNCHANGED (no partial/torn write), and (4) recovery — restoring write
 * permission and re-saving clears the dot and lands the exact typed change,
 * proving the buffer was preserved intact through the failure.
 */

const SCREENS = 'e2e/ux/__screens'

/**
 * Monaco raises a benign internal `CancellationError` ("Canceled") when a model
 * is disposed with a pending WordHighlighter delayer (ordinary tab close). It
 * escapes to pageerror but surfaces nothing to the user; the editor guard filters
 * it rather than red-flagging. Same rationale as editor.spec.ts.
 */
function appErrors(errors: string[]): string[] {
  return errors.filter((m) => m !== 'Canceled')
}

/** Click a Files-tree row by filename, self-healing against the Threads default
 *  rail and the per-project flow-settings overlay (mirrors editor.spec.ts). */
async function openFromTree(win: Page, name: string): Promise<void> {
  const row = win.locator('.fl-sidebar-pane:visible').getByText(name, { exact: true })
  for (let attempt = 0; attempt < 3; attempt++) {
    const overlay = win.locator('.fl-settings-overlay:not([hidden])')
    if (await overlay.count()) {
      await win.keyboard.press('Escape')
      await overlay.waitFor({ state: 'hidden', timeout: 2000 }).catch(() => undefined)
    }
    const files = win.locator('[data-rail-item="files"]')
    const cls = (await files.getAttribute('class')) ?? ''
    if (!/\bactive\b/.test(cls)) await files.click().catch(() => undefined)
    await pickFilesProject(win)
    try {
      await row.waitFor({ state: 'visible', timeout: 8000 })
      await row.click({ timeout: 4000 })
      return
    } catch (error) {
      if (attempt === 2) throw error
    }
  }
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

test('cmd+S save failure surfaces a "Save failed" toast, keeps the tab dirty, and the buffer survives to a successful retry (#195)', async ({
  window,
}) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  const dir = await seedProject(window)
  const ORIGINAL = 'export const ALPHA = "alpha-marker"\n'
  writeFileSync(join(dir, 'alpha.ts'), ORIGINAL)
  await activateProject(window, dir)

  await openFromTree(window, 'alpha.ts')
  await expectEditorShows(window, 'alpha-marker')

  // Type into Monaco like a user: focus, jump to end, add a distinctive line.
  await window.locator('.monaco-editor .view-lines').click()
  await window.keyboard.press('End')
  await window.keyboard.type('\nexport const ADDED = "typed-by-probe"')

  const dirtyDot = tab(window, 'alpha.ts').locator('.dirty-dot')
  await expect(dirtyDot).toBeVisible()

  try {
    // Make the file's parent directory read-only. project:writeFile writes a
    // temp file BESIDE the target then renames over it — creating the temp file
    // in a 0555 dir fails with EACCES. A real, deterministic save failure.
    chmodSync(dir, 0o555)

    await window.keyboard.press('ControlOrMeta+s')

    // 1. Feedback on failure: a 'Save failed' toast must appear (not silent).
    const toast = window.locator('.fl-flow-toast').filter({ hasText: 'Save failed' })
    await expect(toast).toBeVisible({ timeout: 8000 })
    // The body names the file and states plainly the change is NOT on disk.
    await expect(toast).toContainText('alpha.ts')
    await expect(toast).toContainText('not on disk')

    await window.screenshot({ path: `${SCREENS}/editor-save-fail.png` })

    // 2. The tab STAYS dirty — nothing typed is lost (buffer kept, save rethrew).
    await expect(dirtyDot).toBeVisible()

    // 3. The file on disk is UNCHANGED — no partial / torn write landed.
    const afterFail = readFileSync(join(dir, 'alpha.ts'), 'utf8')
    expect(afterFail).toBe(ORIGINAL)
    expect(afterFail).not.toContain('typed-by-probe')
  } finally {
    // Restore write permission so the retry can land and cleanupSeeds can rm.
    chmodSync(dir, 0o755)
  }

  // 4. Recovery: with write permission back, cmd+S now succeeds — the dirty dot
  // clears AND the exact typed change reaches disk, proving the buffer survived
  // the failure intact (a real user's edit was never lost, just held).
  await window.keyboard.press('ControlOrMeta+s')
  await expect(dirtyDot).toHaveCount(0, { timeout: 8000 })
  const recovered = readFileSync(join(dir, 'alpha.ts'), 'utf8')
  expect(recovered).toContain('typed-by-probe')

  const appErrs = appErrors(errors)
  expect(appErrs, appErrs.join(', ')).toHaveLength(0)
})
