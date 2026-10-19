import { test, expect } from '../fixtures/electron'
import { seedProject, activateProject, cleanupSeeds, pickFilesProject } from './fixtures/seed'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'

/**
 * UX regression probe — flow `editor`, round 22 (second seam): **dragging a
 * file in from Finder**.
 *
 * Dropping a file onto the window is how every desktop editor is taught to
 * users — Finder → editor opens it. Flow used to register exactly two drop
 * targets in the whole renderer (composer attachments, kanban cards), so a
 * dropped file was ignored everywhere the user would aim it — except over an
 * open buffer, where Monaco's default "drop into editor" provider pasted the
 * absolute path (plus a literal `$0`, its snippet terminator) straight into
 * the source file and dirtied the tab. That was **#1339**, fixed since: a
 * window-level handler (`renderer/main.ts`) preventDefault()s every OS file
 * drag and routes the paths through `planDrop` to the editor, and Monaco's
 * `dropIntoEditor` provider is disabled (`editor/monaco-host.ts`).
 *
 * These tests pin the fixed behaviour — a drop opens the file wherever it
 * lands, never navigates the shell away, and never edits an open buffer.
 * Drops are dispatched over CDP (`Input.dispatchDragEvent`) because only a
 * trusted drag produces a real DataTransfer with `files`.
 */

const SCREENS = 'e2e/ux/__screens'

function appErrors(errors: string[]): string[] {
  return errors.filter((m) => m !== 'Canceled')
}

/** A trusted-looking file drop at viewport (x, y) — what Finder hands over. */
async function dropFile(win: Page, x: number, y: number, filePath: string): Promise<void> {
  const cdp = await win.context().newCDPSession(win)
  const data = {
    items: [{ mimeType: 'text/uri-list', data: `file://${filePath}` }],
    files: [filePath],
    dragOperationsMask: 1,
  }
  for (const type of ['dragEnter', 'dragOver', 'drop'] as const) {
    await cdp.send('Input.dispatchDragEvent', { type, x, y, data })
    await win.waitForTimeout(250)
  }
  await win.waitForTimeout(1200)
}

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

async function bufferText(win: Page): Promise<string> {
  return (await win.locator('.monaco-editor .view-lines').innerText()).replace(/\u00a0/g, ' ')
}

// Editor tabs only — the terminal panel has its own fl-tabs strip, and a
// docked terminal tab would otherwise leak into every count.
const tabs = (win: Page) => win.locator('#fl-panel-editor fl-tabs .tab')

/** Seed a repo with the file to open and the file to drag in. */
async function seedWithDropTarget(win: Page): Promise<{ dir: string; dropped: string }> {
  const dir = await seedProject(win)
  writeFileSync(join(dir, 'alpha.ts'), 'const ORIGINAL = 1\n')
  writeFileSync(join(dir, 'dropped.txt'), 'DROPPED FILE CONTENT MARKER\n')
  await activateProject(win, dir)
  return { dir, dropped: join(dir, 'dropped.txt') }
}

test.afterAll(() => cleanupSeeds())

test('a dropped file never navigates the window away (the app survives)', async ({ window }) => {
  // The classic Electron failure is the shell being replaced by file:///…,
  // taking every unsaved buffer with it. The window-level dragover/drop
  // preventDefault (#1339) is what stands between a drop and that.
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))
  const { dropped } = await seedWithDropTarget(window)
  const before = window.url()

  const box = await window.locator('.fl-sidebar-pane:visible').first().boundingBox()
  await dropFile(window, (box?.x ?? 100) + 80, (box?.y ?? 200) + 120, dropped)

  expect(window.url()).toBe(before)
  await expect(window.locator('#app.fl-shell')).toHaveCount(1)
  expect(appErrors(errors), appErrors(errors).join(', ')).toEqual([])
})

test('dropping a file on the file tree opens it', async ({ window }) => {
  const { dropped } = await seedWithDropTarget(window)
  await expect(tabs(window)).toHaveCount(0)

  const box = await window.locator('.fl-sidebar-pane:visible').first().boundingBox()
  await dropFile(window, (box?.x ?? 100) + 80, (box?.y ?? 200) + 120, dropped)

  await expect(tabs(window)).toHaveCount(1, { timeout: 8000 })
  await expect(window.locator('.monaco-editor .view-lines')).toContainText(
    'DROPPED FILE CONTENT MARKER',
  )
})

test('dropping a file on the empty editor area opens it', async ({ window }) => {
  const { dropped } = await seedWithDropTarget(window)
  await expect(tabs(window)).toHaveCount(0)

  const box = await window.locator('#fl-panel-editor, .fl-editor').first().boundingBox()
  await dropFile(window, (box?.x ?? 900) + 100, (box?.y ?? 300) + 200, dropped)

  await expect(tabs(window)).toHaveCount(1, { timeout: 8000 })
})

test('dropping a file on an open buffer opens it, never edits it', async ({ window }) => {
  const { dropped } = await seedWithDropTarget(window)
  await openFromTree(window, 'alpha.ts')
  await expect(window.locator('.monaco-editor .view-lines')).toContainText('const ORIGINAL', {
    timeout: 15000,
  })

  const box = await window.locator('.monaco-editor').first().boundingBox()
  await dropFile(window, (box?.x ?? 700) + 200, (box?.y ?? 100) + 60, dropped)

  // The file the user dragged is what should be on screen — and alpha.ts must
  // not have grown an absolute path (with Monaco's literal `$0`) or a dirty dot.
  await expect(tabs(window)).toHaveCount(2, { timeout: 8000 })
  const text = await bufferText(window)
  expect(text, 'the dragged file should be on screen').toContain('DROPPED FILE CONTENT MARKER')
  expect(text, 'Monaco’s snippet terminator must not leak in as text').not.toContain('$0')
  expect(text, 'the drop must not paste a path into the source').not.toContain('dropped.txt')
  await window.screenshot({ path: `${SCREENS}/editor-finder-drop-opens-file.png` })
})
