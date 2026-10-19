/**
 * #941 — ⌘N starts a note you can type into immediately: no file dialog, no
 * pre-chosen path. Ignore it and it costs nothing; ⌘S turns it into a real
 * file (one name prompt) and it behaves like any other file from then on.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test, expect } from '../fixtures/electron'
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed'

test.afterAll(() => cleanupSeeds())

test('#941: cmd+N opens a typable note; cmd+S names and writes it', async ({ window }) => {
  test.setTimeout(120_000)
  const root = await seedProject(window, 'flow-ux-note-')
  await activateProject(window, root)

  // ⌘N — a tab appears with no file having been chosen.
  await window.keyboard.press('ControlOrMeta+n')
  const tabs = window.locator('.fl-editor-tabs .tab, fl-tabs .tab')
  await expect(window.locator('body')).toContainText('Untitled-1', { timeout: 15_000 })

  // Type straight into it — this is the whole point of the feature. Click the
  // editor surface first: the app may have booted focus elsewhere, and this
  // asserts the note is reachable the way a user reaches it.
  await window.locator('.monaco-editor .view-lines').click()
  await window.keyboard.type('a quick note to self', { delay: 20 })
  await expect(window.locator('.monaco-editor .view-lines')).toContainText('a quick note', {
    timeout: 10_000,
  })

  // ⌘S asks for a name INLINE (Electron has no window.prompt) and writes it.
  await window.keyboard.press('ControlOrMeta+s')
  const bar = window.locator('.fl-note-save-bar')
  await expect(bar).toBeVisible({ timeout: 10_000 })
  await bar.locator('input').fill('notes/scratch.md')
  await bar.locator('.fl-note-save-confirm').click()
  await expect
    .poll(() => existsSync(join(root, 'notes', 'scratch.md')), { timeout: 15_000 })
    .toBe(true)
  expect(readFileSync(join(root, 'notes', 'scratch.md'), 'utf8')).toContain('a quick note')

  // The tab is now the real file — the untitled label is gone.
  await expect(window.locator('body')).not.toContainText('Untitled-1')
  void tabs
})
