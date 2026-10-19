import { test, expect } from '../fixtures/electron'
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'

/**
 * Monaco raises a benign internal `CancellationError` ("Canceled") on ordinary
 * model dispose (tab close). It escapes to `pageerror` but nothing surfaces to
 * the user and no state corrupts — filter it so the guard flags only real errors.
 * (Same rationale as editor.spec.ts / editor-external-reload.spec.ts.)
 */
function appErrors(errors: string[]): string[] {
  return errors.filter((m) => m !== 'Canceled')
}

/**
 * UX sweep — flow 7: Editor, over-size-limit file open (the >10MB placeholder).
 *
 * A real user clicks a file that happens to be large — a derived DB, a bundled
 * asset, a giant log. `readProjectFile` (files.ts:335) short-circuits any file
 * over MAX_FILE_SIZE_BYTES (10MB) BEFORE reading its bytes into memory, returning
 * `{ content:'', binary:true, tooLarge:true }`. The editor must then show a clear
 * "(file too large to preview)" placeholder — read-only, never the raw bytes, and
 * never a hang or an unhandled IPC error. This is the graceful-degradation state
 * the user expects; if it broke, opening any big file would freeze or crash the
 * editor.
 *
 * The too-large branch (monaco-host.ts open() with tooLarge=true → nonEditable
 * placeholder + #binaryPaths gate) is distinct from the binary-magic-bytes branch
 * that editor.spec.ts already covers (different message, different main-side
 * trigger — a size stat vs a content sniff). This probe drives it end-to-end
 * through the real `project:readFile` IPC + Monaco.
 *
 * Open path: `flow:open-file` — the exact `openFile(rootPath, relPath)` a Files
 * tree-row click resolves to (index.ts:262 callback), kept deterministic so the
 * subject is the too-large placeholder, not the cold-launch tree-populate race
 * (a seeding artifact already covered elsewhere).
 */

const SCREENS = 'e2e/ux/__screens'

/** 11 MB of plain ASCII — over the 10 MB MAX_FILE_SIZE_BYTES limit. */
const OVER_LIMIT_BYTES = 11 * 1024 * 1024

async function openInEditor(win: Page, rootPath: string, relPath: string): Promise<void> {
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

test('opening a >10MB file shows a read-only "too large" placeholder, not a hang or garbage', async ({
  window,
}) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  const dir = await seedProject(window)
  // A genuinely over-limit plain-text file (11MB > 10MB). readProjectFile stats
  // the size and returns tooLarge BEFORE ever reading these bytes into memory.
  writeFileSync(join(dir, 'huge.log'), Buffer.alloc(OVER_LIMIT_BYTES, 0x61 /* 'a' */))
  await activateProject(window, dir)

  await openInEditor(window, dir, 'huge.log')

  // The tab opens active — the click was not a dead click.
  await expect(tab(window, 'huge.log')).toBeVisible({ timeout: 15000 })
  await expect(tab(window, 'huge.log')).toHaveClass(/active/)

  // A clear, accurate placeholder — never the 11MB of raw content, never blank.
  await expectEditorShows(window, 'too large')

  // The placeholder is read-only: typing changes nothing and never dirties the tab.
  await window.locator('.monaco-editor').click()
  await window.keyboard.type('SHOULD_NOT_APPEAR')
  await expect(window.locator('.monaco-editor .view-lines')).not.toContainText('SHOULD_NOT_APPEAR')
  await expect(tab(window, 'huge.log').locator('.dirty-dot')).toHaveCount(0)

  await window.screenshot({ path: `${SCREENS}/editor-too-large-file.png` })

  // No unhandled error escaped while opening the oversize file.
  const appErrs = appErrors(errors)
  expect(appErrs, appErrs.join(', ')).toHaveLength(0)
})
