import { test, expect } from '../fixtures/electron'
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'

/**
 * UX sweep — flow 7 (Editor), markdown-preview per-file-state + keyboard + live buffer.
 *
 * PR #586's spec covers the BASIC single-file toggle (pill label flips, rendered
 * <h1> appears/hides, non-md file hides the pill). This spec guards the three
 * credential-less behaviors the editor's markdown-preview (#575) PROMISES but
 * that were previously unprobed:
 *
 *  - Per-file preview state (index.ts `previewOn` Set, syncPreviewChrome): turning
 *    preview ON for A.md then switching to B.md must show B as SOURCE (its own
 *    off state), and switching back to A.md must RESTORE A's preview — the code
 *    claims "switching tabs restores each file's own mode".
 *  - ⌘⇧V / ctrl+shift+V toggles the active md file's preview (onKeydown → v).
 *  - The preview renders from the LIVE buffer (host.getContent): an unsaved edit
 *    typed in source mode must appear rendered when preview is toggled ON.
 *
 * Observable behavior only (pill label, rendered heading DOM, active-tab content);
 * never asserts internals. Zero uncaught errors (Monaco's benign internal
 * "Canceled" on model dispose is filtered — see editor.spec.ts for the rationale).
 */

const SCREENS = 'e2e/ux/__screens'
const EDITOR = '#fl-panel-editor'

function appErrors(errors: string[]): string[] {
  return errors.filter((m) => m !== 'Canceled')
}

/** Open a project file through the app's real `flow:open-file` event — the same
 *  decoupled open path the Files tree and blueprint file-rows dispatch. Used
 *  instead of a tree click so this preview probe is independent of the sidebar
 *  activity-bar markup (#663). */
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

/** The floating Preview/Source pill (the only labelled fl-button in the editor body). */
function previewPill(win: Page, label: 'Preview' | 'Source') {
  return win.locator(`${EDITOR} fl-button`).filter({ hasText: label })
}

/** Wait until Monaco shows a line containing `text` (source content actually rendered). */
async function expectEditorShows(win: Page, text: string): Promise<void> {
  await expect(win.locator('.monaco-editor .view-lines')).toContainText(text, { timeout: 15000 })
}

test.afterAll(() => cleanupSeeds())

test('per-file preview state: preview follows each md tab and restores on switch-back', async ({
  window,
}) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  const dir = await seedProject(window)
  writeFileSync(join(dir, 'alpha.md'), '# Alpha Heading\n\nalpha-marker body\n')
  writeFileSync(join(dir, 'beta.md'), '# Beta Heading\n\nbeta-marker body\n')
  await activateProject(window, dir)

  // Open alpha.md and turn its preview ON → a rendered <h1> appears.
  await openFile(window, dir, 'alpha.md')
  await expect(previewPill(window, 'Preview')).toBeVisible({ timeout: 6000 })
  await previewPill(window, 'Preview').click()
  await expect(previewPill(window, 'Source')).toBeVisible()
  await expect(window.locator(`${EDITOR} h1`, { hasText: 'Alpha Heading' })).toBeVisible({
    timeout: 6000,
  })

  // Open beta.md → it is a fresh md tab, so it must show SOURCE (pill "Preview"),
  // NOT inherit alpha's preview mode. A regression here would render beta's preview
  // (state leaking across tabs) or worse show alpha's stale rendered pane.
  await openFile(window, dir, 'beta.md')
  await expect(tab(window, 'beta.md')).toHaveClass(/active/)
  await expect(previewPill(window, 'Preview')).toBeVisible({ timeout: 6000 })
  // No rendered heading is VISIBLE over beta's source — the preview pane is hidden
  // (its stale alpha content lingers in the DOM but display:none, so never shown).
  await expect(window.locator(`${EDITOR} h1`)).toBeHidden()
  await expectEditorShows(window, 'beta-marker')

  // Switch back to alpha.md → its OWN preview mode is restored (pill "Source",
  // rendered <h1> back). This is the per-file-state guarantee.
  await tab(window, 'alpha.md').click()
  await expect(tab(window, 'alpha.md')).toHaveClass(/active/)
  await expect(previewPill(window, 'Source')).toBeVisible({ timeout: 6000 })
  await expect(window.locator(`${EDITOR} h1`, { hasText: 'Alpha Heading' })).toBeVisible({
    timeout: 6000,
  })

  await window.screenshot({ path: `${SCREENS}/editor-md-preview-per-file.png` })
  const appErrs = appErrors(errors)
  expect(appErrs, appErrs.join(', ')).toHaveLength(0)
})

test('⌘⇧V toggles the active md file preview; a non-md tab ignores the shortcut', async ({
  window,
}) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  const dir = await seedProject(window)
  writeFileSync(join(dir, 'doc.md'), '# Doc Heading\n\ndoc-marker body\n')
  writeFileSync(join(dir, 'plain.txt'), 'plain-marker text\n')
  await activateProject(window, dir)

  // Open the md file → source mode, pill reads "Preview".
  await openFile(window, dir, 'doc.md')
  await expect(previewPill(window, 'Preview')).toBeVisible({ timeout: 6000 })

  // ⌘⇧V flips to preview → pill "Source" + rendered <h1>.
  await window.keyboard.press('ControlOrMeta+Shift+V')
  await expect(previewPill(window, 'Source')).toBeVisible({ timeout: 6000 })
  await expect(window.locator(`${EDITOR} h1`, { hasText: 'Doc Heading' })).toBeVisible()

  // ⌘⇧V again flips back to source → pill "Preview", pane hidden.
  await window.keyboard.press('ControlOrMeta+Shift+V')
  await expect(previewPill(window, 'Preview')).toBeVisible({ timeout: 6000 })
  await expect(window.locator(`${EDITOR} h1`)).toBeHidden()

  // Switch to a non-md tab → the pill is gone and ⌘⇧V is a no-op (no error, no
  // stray rendered pane over plain text).
  await openFile(window, dir, 'plain.txt')
  await expect(previewPill(window, 'Preview')).toBeHidden({ timeout: 6000 })
  await window.keyboard.press('ControlOrMeta+Shift+V')
  await expect(previewPill(window, 'Source')).toBeHidden()
  // No rendered heading is visible over the plain-text source (preview pane hidden).
  await expect(window.locator(`${EDITOR} h1`)).toBeHidden()
  await expectEditorShows(window, 'plain-marker')

  await window.screenshot({ path: `${SCREENS}/editor-md-preview-keyboard.png` })
  const appErrs = appErrors(errors)
  expect(appErrs, appErrs.join(', ')).toHaveLength(0)
})

test('preview renders the LIVE buffer: an unsaved edit shows in the rendered pane', async ({
  window,
}) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  const dir = await seedProject(window)
  writeFileSync(join(dir, 'live.md'), '# Original Title\n\nbody\n')
  await activateProject(window, dir)

  await openFile(window, dir, 'live.md')
  await expect(previewPill(window, 'Preview')).toBeVisible({ timeout: 6000 })
  await expectEditorShows(window, 'Original Title')

  // Type an UNSAVED new heading into the Monaco source buffer.
  await window.locator('.monaco-editor .view-lines').click()
  await window.keyboard.press('ControlOrMeta+ArrowDown') // move toward the end
  await window.keyboard.press('End')
  await window.keyboard.type('\n\n## Unsaved Subheading')
  await expect(tab(window, 'live.md').locator('.dirty-dot')).toBeVisible()

  // Toggle preview ON → it renders from the LIVE buffer, so the unsaved heading
  // must appear as a real rendered <h2> — proof the pane is not showing the last
  // saved content on disk.
  await previewPill(window, 'Preview').click()
  await expect(previewPill(window, 'Source')).toBeVisible()
  await expect(window.locator(`${EDITOR} h2`, { hasText: 'Unsaved Subheading' })).toBeVisible({
    timeout: 6000,
  })

  await window.screenshot({ path: `${SCREENS}/editor-md-preview-live-buffer.png` })
  const appErrs = appErrors(errors)
  expect(appErrs, appErrs.join(', ')).toHaveLength(0)
})
