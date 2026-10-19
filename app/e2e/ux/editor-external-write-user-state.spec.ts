/**
 * UX regression probe — flow `editor` (open file / tabs / Monaco / conflict
 * resolve), round 18.
 *
 * Un-probed shape: what a write that the user did NOT type — an agent rewriting
 * the file on disk, or Flow's own conflict resolve — does to the *editing state*
 * of the person sitting in that buffer. The 22 prior flow-7 specs all ask whether
 * the CONTENT and the TAB SET are right afterwards (external reload #353/#357,
 * dirty project switch #955, tab nav/overflow/same-name/close-ops, markdown
 * preview #575/#588, LSP, save-fail #195, too-large, hidden-editor #1057,
 * conflict identity/reveal/review). Nobody asked what the reload does to the
 * user's undo history, or what Flow's own conflict write does to the tab's dirty
 * state.
 *
 * Two defects found and filed:
 *
 *  - #1096 — `MonacoHost.reloadFromDisk` applies the external content with
 *    `model.setValue()`, which flushes Monaco's undo stack: after an agent
 *    rewrites your open (clean) file, ⌘Z and ⌘⇧Z are dead keys and your own
 *    earlier edit history for that file is gone. The undoable technique is used
 *    two methods below (`restoreDirtyContent`, "so the restore is undoable") and
 *    in `conflict-codelens.ts` — `reloadFromDisk` is the outlier.
 *
 *  - #1097 — resolving a hunk from the editor's own `Accept Current` CodeLens
 *    syncs the buffer with a raw `model.pushEditOperations`, so the tab goes
 *    DIRTY for content nobody typed; the watcher event for Flow's own write then
 *    takes the #357 dirty-tab branch and raises "File changed on disk — … Saving
 *    will overwrite that change — close and reopen to load it", and a later ⌘S
 *    asks to overwrite "the newer version" mid-merge.
 *
 * Tests 1-3 are the live guards (green on main): undo works and survives a tab
 * round-trip; the #353 clean reload still lands the new content and stays clean;
 * and the SIBLING conflict path (Source Control per-side accept) leaves the same
 * tab clean with no alarm — the control that makes #1097 attributable to the
 * CodeLens path. Tests 4-5 were the fix-agnostic tripwires for the two filed
 * bugs and are now regression guards — #1096 landed in ef58f07 (reloadFromDisk
 * applies the reload as an undoable edit), #1097 landed alongside it (the
 * CodeLens resolve routes through `EditorApi.syncBufferFromDisk`, so the clean
 * baseline moves with the content). Both re-verified non-vacuous against the
 * unfixed code before being un-fixme'd.
 */
import { test, expect } from '../fixtures/electron'
import { activateProject, seedProject, cleanupSeeds, removeTempDir } from './fixtures/seed'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from '@playwright/test'

const SCREENS = 'e2e/ux/__screens'

/** Monaco raises a benign internal `CancellationError` ("Canceled") on ordinary
 *  model dispose — filter it so the guards flag only real app errors. */
function appErrors(errors: string[]): string[] {
  return errors.filter((m) => m !== 'Canceled')
}

/** Throwaway conflict repos seeded by this file (the shared seed fixture owns the
 *  plain ones). */
const conflictDirs: string[] = []

function git(dir: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: dir }).toString()
}

/**
 * A repo carrying a REAL merge conflict with two hunks in one file (the recipe
 * conflict-identity-resolve.spec.ts uses): two edit regions ten context lines
 * apart so git does not coalesce them, seeded BEFORE the root is added so the
 * git watcher never races the seed commits for the index lock.
 */
function seedTwoHunkConflictRepo(prefix: string): { dir: string; file: string } {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  conflictDirs.push(dir)
  git(dir, 'init', '-q')
  git(dir, 'config', 'user.email', 'qa@flow.test')
  git(dir, 'config', 'user.name', 'QA Bot')
  const file = 'notes.txt'
  const withRegions = (alpha: string, omega: string): string =>
    [
      'intro line',
      alpha,
      ...Array.from({ length: 10 }, (_v, i) => `pad ${i + 1}`),
      omega,
      'outro line',
      '',
    ].join('\n')
  writeFileSync(join(dir, file), withRegions('ALPHA base', 'OMEGA base'))
  git(dir, 'add', file)
  git(dir, 'commit', '-q', '-m', 'base')
  const mainBranch = git(dir, 'rev-parse', '--abbrev-ref', 'HEAD').trim()
  git(dir, 'checkout', '-q', '-b', 'topic-blue')
  writeFileSync(join(dir, file), withRegions('ALPHA blue', 'OMEGA blue'))
  git(dir, 'commit', '-q', '-am', 'topic-blue change')
  git(dir, 'checkout', '-q', mainBranch)
  writeFileSync(join(dir, file), withRegions('ALPHA trunk', 'OMEGA trunk'))
  git(dir, 'commit', '-q', '-am', 'trunk change')
  try {
    git(dir, 'merge', 'topic-blue')
  } catch {
    // Expected: git exits non-zero on a conflicting merge.
  }
  return { dir, file }
}

/** Add a pre-built repo as a project root (no native dialog, unlike openProject). */
async function addRoot(window: Page, dir: string): Promise<void> {
  await window.evaluate(async (p) => {
    await (
      window as unknown as { flow: { project: { add(r: { path: string }): Promise<unknown> } } }
    ).flow.project.add({ path: p })
  }, dir)
}

/** Open a project file through the app's real `flow:open-file` channel — the same
 *  call a Files-tree row click ends up making. */
async function openInEditor(window: Page, rootPath: string, relPath: string): Promise<void> {
  await window.evaluate(
    ({ rootPath: root, relPath: rel }) => {
      document.dispatchEvent(new CustomEvent('flow:open-file', { detail: { rootPath: root, relPath: rel } }))
    },
    { rootPath, relPath },
  )
}

function tab(window: Page, name: string) {
  return window.locator('.fl-shell fl-tabs .tab', { hasText: name })
}

function editorText(window: Page) {
  return window.locator('.monaco-editor .view-lines')
}

/** The file's own editor — not either side of a diff editor that may be open. */
function fileEditorText(window: Page) {
  return window
    .locator(
      '.monaco-editor:not(.modified-in-monaco-diff-editor):not(.original-in-monaco-diff-editor) .view-lines',
    )
    .first()
}

/** The per-hunk conflict CodeLens command link whose label matches (one per open hunk). */
function conflictLens(window: Page, label: string) {
  return window.locator('.monaco-editor .codelens-decoration a').filter({ hasText: label })
}

/** The "File changed on disk" toast — the #357 dirty-tab alarm. */
function changedOnDiskToast(window: Page) {
  return window.locator('.fl-flow-toast').filter({ hasText: 'File changed on disk' })
}

test.afterAll(() => {
  while (conflictDirs.length) {
    const dir = conflictDirs.pop()
    if (dir) removeTempDir(dir)
  }
  try {
    cleanupSeeds()
  } catch {
    // A seeded project's background writers can race the temp-dir rm (ENOTEMPTY);
    // cleanup is best-effort and never fails a run.
  }
})

test('undo walks the user\'s edits back and survives a tab round-trip', async ({ window }) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  const dir = await seedProject(window, 'flow-ux-undo-ctl-')
  writeFileSync(join(dir, 'a.txt'), 'alpha base line\n')
  writeFileSync(join(dir, 'b.txt'), 'beta only line\n')
  await activateProject(window, dir)

  await openInEditor(window, dir, 'a.txt')
  await expect(editorText(window)).toContainText('alpha base line', { timeout: 25000 })
  await editorText(window).click()
  await window.keyboard.press('Control+End')
  await window.keyboard.type('EDIT-ONE')
  await window.waitForTimeout(300)
  await window.keyboard.press('Enter')
  await window.keyboard.type('EDIT-TWO')
  await window.waitForTimeout(300)
  await expect(editorText(window)).toContainText('EDIT-TWO')

  // Enough undos to unwind both typed chunks (Monaco groups typing into a few
  // stack entries) — the buffer must return to its pristine text and go clean.
  for (let i = 0; i < 8; i++) {
    await window.keyboard.press('ControlOrMeta+z')
    await window.waitForTimeout(120)
  }
  await expect(editorText(window)).not.toContainText('EDIT-ONE')
  await expect(editorText(window)).not.toContainText('EDIT-TWO')
  await expect(tab(window, 'a.txt').locator('.dirty-dot')).toHaveCount(0)

  // …and the stack belongs to the MODEL, so leaving the tab and coming back keeps it.
  await editorText(window).click()
  await window.keyboard.press('Control+End')
  await window.keyboard.type('KEEP-ME')
  await window.waitForTimeout(300)
  await openInEditor(window, dir, 'b.txt')
  await expect(editorText(window)).toContainText('beta only line', { timeout: 15000 })
  await tab(window, 'a.txt').click()
  await expect(editorText(window)).toContainText('KEEP-ME', { timeout: 10000 })
  await editorText(window).click()
  await window.keyboard.press('ControlOrMeta+z')
  await window.waitForTimeout(400)
  await expect(editorText(window)).not.toContainText('KEEP-ME')

  const appErrs = appErrors(errors)
  expect(appErrs, appErrs.join(', ')).toHaveLength(0)
})

test('a clean tab reloads to the new disk content and stays clean (#353)', async ({ window }) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  const dir = await seedProject(window, 'flow-ux-reload-ctl-')
  const file = join(dir, 'watched.ts')
  writeFileSync(file, 'export const MARK = "before"\n')
  await activateProject(window, dir)
  await openInEditor(window, dir, 'watched.ts')
  await expect(editorText(window)).toContainText('before', { timeout: 25000 })
  await expect(tab(window, 'watched.ts').locator('.dirty-dot')).toHaveCount(0)

  // An agent (any external tool) rewrites the file while the tab is clean.
  writeFileSync(file, 'export const MARK = "after the agent wrote it"\n')
  await expect(editorText(window)).toContainText('after the agent wrote it', { timeout: 25000 })
  // A reload is not a user edit — the tab must not claim unsaved changes.
  await expect(tab(window, 'watched.ts').locator('.dirty-dot')).toHaveCount(0)

  const appErrs = appErrors(errors)
  expect(appErrs, appErrs.join(', ')).toHaveLength(0)
})

test('the Source Control per-side conflict resolve leaves the open tab clean, no disk alarm', async ({
  window,
}) => {
  test.setTimeout(120000)
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  const { dir, file } = seedTwoHunkConflictRepo('flow-ux-conflict-ctl-')
  await addRoot(window, dir)
  await activateProject(window, dir)
  await window.locator('.fl-activity-bar .fl-rail-item[aria-label="Source Control"]').click()
  await window.locator('.fl-sc-viewbtn', { hasText: 'Changes' }).click()
  await expect(window.locator('.gp-root').first()).toBeVisible()

  await openInEditor(window, dir, file)
  await expect(editorText(window)).toContainText('<<<<<<<', { timeout: 25000 })
  await expect(tab(window, file).locator('.dirty-dot')).toHaveCount(0)

  // The merge row's per-side accept button (git:resolveConflict — main writes the
  // file, the editor takes its normal clean-reload path).
  // TWO PRESSES since the per-side buttons became preview-then-apply: the
  // first shows what taking that side would write (a diff tab) and arms the
  // button, the second writes it (behind a confirm, accepted here).
  window.on('dialog', (dialog) => void dialog.accept())
  await window.locator('.gp-name').first().hover()
  const sideButton = window.locator('.gp-action-side').first()
  await expect(sideButton).toBeVisible({ timeout: 10000 })
  await sideButton.click()
  await expect(sideButton).toHaveClass(/gp-action-side-armed/)
  await sideButton.click()

  // Back on the file's own tab (the preview opened a diff beside it): markers
  // gone from the buffer, tab still CLEAN, and no "changed on disk" alarm for a
  // write the app itself made.
  await tab(window, file).click()
  await expect(fileEditorText(window)).not.toContainText('<<<<<<<', { timeout: 20000 })
  await expect(tab(window, file).locator('.dirty-dot')).toHaveCount(0)
  await expect(changedOnDiskToast(window)).toHaveCount(0)

  const appErrs = appErrors(errors)
  expect(appErrs, appErrs.join(', ')).toHaveLength(0)
})

/**
 * TRIPWIRE for #1096 — fix-agnostic: it asserts the user-visible contract (⌘Z
 * still steps back after the editor reloads a file that changed on disk), not the
 * implementation. Un-`fixme` it once `reloadFromDisk` stops flushing the undo
 * stack. Verified non-vacuous: against current main it fails on the documented
 * assertion below, with the buffer byte-identical after five undos.
 */
test('undo still works after an external write reloads the buffer (#1096)', async ({ window }) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  const dir = await seedProject(window, 'flow-ux-undo-tw-')
  const file = join(dir, 'service.ts')
  writeFileSync(file, 'export const VALUE = 1\n')
  await activateProject(window, dir)
  await openInEditor(window, dir, 'service.ts')
  await expect(editorText(window)).toContainText('VALUE = 1', { timeout: 25000 })

  // The user types and saves — a real edit history exists for this model.
  await editorText(window).click()
  await window.keyboard.press('Control+End')
  await window.keyboard.type('// MY-OWN-EDIT')
  await window.waitForTimeout(300)
  await window.keyboard.press('ControlOrMeta+s')
  await expect(tab(window, 'service.ts').locator('.dirty-dot')).toHaveCount(0, { timeout: 10000 })

  // An agent rewrites the same file; the clean tab silently reloads (#353).
  writeFileSync(file, 'export const VALUE = 1\n// MY-OWN-EDIT\n// AGENT-APPENDED\n')
  await expect(editorText(window)).toContainText('AGENT-APPENDED', { timeout: 25000 })

  const beforeUndo = await editorText(window).innerText()
  await editorText(window).click()
  for (let i = 0; i < 5; i++) {
    await window.keyboard.press('ControlOrMeta+z')
    await window.waitForTimeout(200)
  }
  const afterUndo = await editorText(window).innerText()
  expect(
    afterUndo,
    'undo is dead after the external reload — the buffer is byte-identical after five ⌘Z presses (#1096: reloadFromDisk uses model.setValue, which flushes Monaco\'s undo stack)',
  ).not.toBe(beforeUndo)

  const appErrs = appErrors(errors)
  expect(appErrs, appErrs.join(', ')).toHaveLength(0)
})

/**
 * REGRESSION GUARD for #1097 — fix-agnostic: the tab must not claim unsaved
 * changes, and the app must not warn about its own write, after the user resolves
 * the last hunk from the editor CodeLens. Verified non-vacuous: against the
 * unfixed build it fails on the dirty-dot assertion (dot present, plus the "File
 * changed on disk" toast). Green once the CodeLens refresh routes through
 * `EditorApi.syncBufferFromDisk`, which moves the clean baseline with the content.
 */
test(
  'resolving the last hunk from the editor CodeLens leaves the tab clean, no false disk alarm (#1097)',
  async ({ window }) => {
    test.setTimeout(120000)
    const errors: string[] = []
    window.on('pageerror', (e) => errors.push(e.message))

    const { dir, file } = seedTwoHunkConflictRepo('flow-ux-conflict-tw-')
    await addRoot(window, dir)
    await activateProject(window, dir)
    await openInEditor(window, dir, file)
    await expect(editorText(window)).toContainText('<<<<<<<', { timeout: 25000 })
    await expect(conflictLens(window, 'Accept Current')).toHaveCount(2, { timeout: 25000 })

    await conflictLens(window, 'Accept Current').first().click()
    await expect(conflictLens(window, 'Accept Current')).toHaveCount(1, { timeout: 20000 })
    // Each splice triggers a disk refresh that rebuilds the lenses, so a lone click
    // can land on a detaching lens — retry until the buffer actually clears (the
    // splice is a no-op once the hunk is gone, so retries are safe).
    await expect(async () => {
      await conflictLens(window, 'Accept Current').first().click({ timeout: 3000 })
      await expect(editorText(window)).not.toContainText('<<<<<<<', { timeout: 3000 })
    }).toPass({ timeout: 30000 })

    // Flow wrote the file, the buffer matches disk: nothing to save, nothing to warn about.
    await window.waitForTimeout(4000)
    await expect(
      tab(window, file).locator('.dirty-dot'),
      'the editor CodeLens resolve left the tab dirty for content the user never typed (#1097)',
    ).toHaveCount(0)
    await expect(
      changedOnDiskToast(window),
      'Flow warned "File changed on disk" about its own conflict write (#1097)',
    ).toHaveCount(0)
    await window.screenshot({ path: `${SCREENS}/conflict-codelens-tab-state.png` })

    const appErrs = appErrors(errors)
    expect(appErrs, appErrs.join(', ')).toHaveLength(0)
  },
)
