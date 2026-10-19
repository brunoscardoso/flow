import { test, expect } from '../fixtures/electron'
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'

/**
 * Monaco raises a benign internal `CancellationError` ("Canceled") on ordinary
 * model dispose (tab close). It escapes to `pageerror` but nothing surfaces to
 * the user and no state corrupts — filter it so the guard flags only real errors.
 * (Same rationale as editor.spec.ts.)
 */
function appErrors(errors: string[]): string[] {
  return errors.filter((m) => m !== 'Canceled')
}

/**
 * UX sweep — flow 7: Editor, external-disk-change reconcile (#353 / #357).
 *
 * The core AI-IDE scenario: you have a file open, an agent (or any external tool)
 * rewrites it on disk while you watch. The editor must:
 *  - CLEAN tab → silently reload to the new content (never show stale text that a
 *    reflex cmd+S would clobber), and stay CLEAN (a reload is not a user edit).
 *  - DIRTY tab → NEVER reload out from under the user's unsaved edits, and raise a
 *    "File changed on disk" toast so a later save doesn't blindly overwrite (#357).
 *
 * The reconcile path (tab-reconcile.ts → index.ts onFileChanged → reloadTab) is
 * unit-tested (tab-reconcile.test.ts) but was never driven end-to-end through the
 * real chokidar watcher + IPC + Monaco. This probe drives it live: it writes the
 * file on disk directly (as an external tool would) and asserts the editor UX.
 *
 * NOTE: rename/delete reconcile is chokidar-timing-sensitive on macOS and out of
 * scope here (see the editor-tab-reconcile ledger note); a content-`change` edit
 * fires a reliable watcher event (awaitWriteFinish 200ms + debounce), so this
 * probe waits generously and asserts on the settled state, never a race.
 */

const SCREENS = 'e2e/ux/__screens'

/**
 * Open a project file into the editor through the app's real `flow:open-file`
 * channel — the exact `openFile(rootPath, relPath)` a Files-tree row click ends
 * up calling (file-tree.ts `#activate` → the index.ts:262 callback), and the same
 * channel the Blueprint/chat file-row surfaces use. This is a genuine user-open
 * path; it deliberately does NOT depend on the file-tree *populating* the seeded
 * file, which is a cold-launch race (two Electron launches back-to-back) already
 * covered by editor.spec.ts / project.spec.ts. This probe's subject is the
 * external-reload reconcile, so we keep the open deterministic and assert only on
 * the reload behavior.
 */
async function openInEditor(win: Page, rootPath: string, relPath: string): Promise<void> {
  await win.evaluate(
    ({ rootPath, relPath }) => {
      document.dispatchEvent(
        new CustomEvent('flow:open-file', { detail: { rootPath, relPath } }),
      )
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

test('clean tab reloads live when its file is rewritten on disk (#353)', async ({ window }) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  const dir = await seedProject(window)
  const file = join(dir, 'watched.ts')
  writeFileSync(file, 'export const MARK = "reload-old-marker"\n')
  await activateProject(window, dir)

  // Open it (real app open channel) and confirm the pre-edit content is showing, clean.
  await openInEditor(window, dir, 'watched.ts')
  await expect(tab(window, 'watched.ts')).toHaveClass(/active/)
  await expectEditorShows(window, 'reload-old-marker')
  await expect(tab(window, 'watched.ts').locator('.dirty-dot')).toHaveCount(0)

  // An external tool (agent) rewrites the file on disk while the tab is open.
  writeFileSync(file, 'export const MARK = "reload-new-marker"\n')

  // The editor must live-reload to the new content — not strand the user on stale
  // text that a reflex save would clobber.
  await expectEditorShows(window, 'reload-new-marker')
  // A reload is not a user edit: the tab stays clean (no dirty dot, no phantom
  // "unsaved" state), so cmd+S wouldn't re-write the same bytes over the change.
  await expect(tab(window, 'watched.ts').locator('.dirty-dot')).toHaveCount(0)
  // The stale content is truly gone from the viewport.
  await expect(window.locator('.monaco-editor .view-lines')).not.toContainText('reload-old-marker')

  await window.screenshot({ path: `${SCREENS}/editor-external-reload-clean.png` })
  const appErrs = appErrors(errors)
  expect(appErrs, appErrs.join(', ')).toHaveLength(0)
})

test('undo history survives an external reload — cmd+Z steps back to the pre-agent content (#1096)', async ({
  window,
}) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  const dir = await seedProject(window)
  const file = join(dir, 'undoable.ts')
  writeFileSync(file, 'export const MARK = "undo-base"\n')
  await activateProject(window, dir)

  await openInEditor(window, dir, 'undoable.ts')
  await expectEditorShows(window, 'undo-base')

  // Establish the user's OWN edit history first: type a line and save, so the
  // tab is CLEAN again when the agent rewrite lands (#1096's exact scenario —
  // the reload must not destroy this earlier history either).
  await window.locator('.monaco-editor .view-lines').click()
  await window.keyboard.press('End')
  await window.keyboard.type('\nexport const MINE = "my-own-edit"')
  await expect(tab(window, 'undoable.ts').locator('.dirty-dot')).toBeVisible()
  await window.keyboard.press(process.platform === 'darwin' ? 'Meta+s' : 'Control+s')
  await expect(tab(window, 'undoable.ts').locator('.dirty-dot')).toHaveCount(0)
  // Let the save's own watcher echo settle (reload no-ops on identical content)
  // before the external write, so the two disk events never coalesce.
  await window.waitForTimeout(1500)

  // The agent rewrites the file on disk while the clean tab is open → silent
  // reload to the new content (#353 contract, covered by the spec above).
  writeFileSync(file, 'export const MARK = "agent-rewrite"\n')
  await expectEditorShows(window, 'agent-rewrite')
  await expect(window.locator('.monaco-editor .view-lines')).not.toContainText('my-own-edit')
  await expect(tab(window, 'undoable.ts').locator('.dirty-dot')).toHaveCount(0)

  // cmd+Z must step back THROUGH the reload: first press restores the
  // pre-agent content (buffer now differs from disk → dirty is correct).
  await window.locator('.monaco-editor .view-lines').click()
  const undoChord = process.platform === 'darwin' ? 'Meta+z' : 'Control+z'
  await window.keyboard.press(undoChord)
  await expectEditorShows(window, 'my-own-edit')
  await expect(window.locator('.monaco-editor .view-lines')).not.toContainText('agent-rewrite')
  await expect(tab(window, 'undoable.ts').locator('.dirty-dot')).toBeVisible()

  // The user's own earlier history is intact too: keep undoing until the typed
  // line is gone (typing may span several undo units) — back to the base file.
  for (let i = 0; i < 12; i += 1) {
    await window.keyboard.press(undoChord)
  }
  await expect(window.locator('.monaco-editor .view-lines')).not.toContainText('my-own-edit')
  await expectEditorShows(window, 'undo-base')

  // Redo walks the whole history forward again, ending clean on the agent
  // content (extra presses past the top of the stack are harmless no-ops).
  const redoChord = process.platform === 'darwin' ? 'Meta+Shift+z' : 'Control+Shift+z'
  for (let i = 0; i < 16; i += 1) {
    await window.keyboard.press(redoChord)
  }
  await expectEditorShows(window, 'agent-rewrite')
  await expect(tab(window, 'undoable.ts').locator('.dirty-dot')).toHaveCount(0)

  await window.screenshot({ path: `${SCREENS}/editor-external-reload-undo.png` })
  const appErrs = appErrors(errors)
  expect(appErrs, appErrs.join(', ')).toHaveLength(0)
})

test('dirty tab is NOT clobbered by an external change and is flagged with a toast (#357)', async ({
  window,
}) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  const dir = await seedProject(window)
  const file = join(dir, 'edited.ts')
  writeFileSync(file, 'export const MARK = "dirty-base"\n')
  await activateProject(window, dir)

  await openInEditor(window, dir, 'edited.ts')
  await expectEditorShows(window, 'dirty-base')

  // The user types an unsaved edit — the tab is now dirty.
  await window.locator('.monaco-editor .view-lines').click()
  await window.keyboard.press('End')
  await window.keyboard.type('\nexport const MINE = "user-unsaved-edit"')
  const dirtyDot = tab(window, 'edited.ts').locator('.dirty-dot')
  await expect(dirtyDot).toBeVisible()

  // An external tool rewrites the same file on disk underneath the dirty buffer.
  writeFileSync(file, 'export const MARK = "external-overwrite"\n')

  // The user's unsaved edit must survive — the editor must NOT silently reload the
  // external content over it.
  const toast = window.locator('.fl-flow-toast', { hasText: 'File changed on disk' })
  await expect(toast).toBeVisible({ timeout: 15000 })
  await expect(window.locator('.monaco-editor .view-lines')).toContainText('user-unsaved-edit')
  await expect(dirtyDot).toBeVisible()
  // The external content did NOT replace the buffer.
  await expect(window.locator('.monaco-editor .view-lines')).not.toContainText('external-overwrite')

  await window.screenshot({ path: `${SCREENS}/editor-external-reload-dirty.png` })
  const appErrs = appErrors(errors)
  expect(appErrs, appErrs.join(', ')).toHaveLength(0)
})
