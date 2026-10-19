import { test, expect } from '../fixtures/electron'
import { seedProject, activateProject, cleanupSeeds, gitRetry, pickFilesProject } from './fixtures/seed'
import { lstatSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'

/**
 * UX regression probe — flow `editor`, round 19: **does one small edit round-trip
 * the file byte-for-byte?**
 *
 * Flow's save path is an atomic temp-write + rename (`writeProjectFile`), which
 * has already lost one property of the original file silently (#159, the
 * executable bit). This probe asks the same question of the other properties a
 * user never expects a text edit to touch: line endings, a missing EOF newline,
 * tabs/trailing whitespace, the UTF-8 BOM, and the file's identity as a symlink.
 * Every failure here is invisible in the editor and only shows up later as diff
 * noise, broken tooling, or an edit that never reached the file the user meant.
 *
 * Test 1 is the live guard (green on main): LF, CRLF, no-newline-at-EOF and
 * tab/trailing-whitespace files all survive a one-character edit with nothing
 * else changed — the CRLF case matters most, since a normalized buffer would
 * rewrite every line of the file.
 *
 * Tests 2-3 are `test.fixme` tripwires for the two defects this round filed:
 *
 *  - #1147 — a UTF-8 BOM is silently dropped on save. `readProjectFile` hands
 *    the raw `buffer.toString('utf8')` (BOM included) to Monaco, whose text-buffer
 *    builder strips the BOM into state the standalone editor never re-emits, so
 *    `model.getValue()` — and therefore the atomic write — has no BOM. Edit line 2
 *    of a BOM'd file and git reports line 1 changed too.
 *  - #1146 — saving a symlinked file replaces the link with a regular file. The
 *    temp+rename lands ON the link path, so the link is destroyed and the target
 *    it pointed at never receives the edit: the user's change silently applies to
 *    a detached copy.
 *
 * Both were confirmed end-to-end against the real app (byte dumps + `git diff`),
 * with zero uncaught renderer errors. Un-fixme each test when its fix lands.
 */

const SCREENS = 'e2e/ux/__screens'

function appErrors(errors: string[]): string[] {
  return errors.filter((m) => m !== 'Canceled')
}

/** Click a file-tree row by filename (self-heals against the late flow overlay). */
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

function tab(win: Page, name: string) {
  return win.locator('.fl-shell fl-tabs .tab', { hasText: name })
}

/** Open `name`, type one character at the very start of the buffer, ⌘S. */
async function prependCharAndSave(win: Page, name: string, char = 'X'): Promise<void> {
  await openFromTree(win, name)
  await expect(win.locator('.monaco-editor .view-lines')).not.toBeEmpty({ timeout: 15000 })
  await win.locator('.monaco-editor .view-lines').click()
  await win.keyboard.press('ControlOrMeta+ArrowUp')
  await win.keyboard.press('Home')
  await win.keyboard.type(char)
  await expect(tab(win, name).locator('.dirty-dot')).toBeVisible()
  await win.keyboard.press('ControlOrMeta+s')
  await expect(tab(win, name).locator('.dirty-dot')).toBeHidden({ timeout: 8000 })
}

test.afterAll(() => cleanupSeeds())

test('one typed character changes exactly one byte — LF, CRLF, no-EOF-newline and tabs all survive', async ({
  window,
}) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  const dir = await seedProject(window)
  const cases = [
    { name: 'lf.ts', text: 'const a = 1\nconst b = 2\n' },
    // A normalized buffer would rewrite every line of this file on save.
    { name: 'crlf.ts', text: 'const a = 1\r\nconst b = 2\r\n' },
    { name: 'noeof.ts', text: 'const a = 1\nconst b = 2' },
    { name: 'tabs.ts', text: 'function f() {\n\treturn 1   \n}\n' },
  ]
  for (const c of cases) writeFileSync(join(dir, c.name), c.text, 'utf8')
  await activateProject(window, dir)

  for (const c of cases) {
    await prependCharAndSave(window, c.name)
    expect(readFileSync(join(dir, c.name), 'utf8'), `${c.name} round-trip`).toBe(`X${c.text}`)
  }

  await window.screenshot({ path: `${SCREENS}/editor-save-roundtrip.png` })
  const appErrs = appErrors(errors)
  expect(appErrs, appErrs.join(', ')).toHaveLength(0)
})

// Remove `.fixme` once the read/write path carries the BOM across a save (#1147).
test('a UTF-8 BOM survives a save — editing line 2 does not rewrite line 1', async ({
  window,
}) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  const dir = await seedProject(window)
  const rel = 'settings.ts'
  const file = join(dir, rel)
  const original = '﻿export const NAME = "café"\nexport const OTHER = 2\n'
  writeFileSync(file, original, 'utf8')
  gitRetry(dir, 'add', rel)
  gitRetry(dir, '-c', 'user.email=qa@flow', '-c', 'user.name=QA', 'commit', '-qm', 'seed')
  expect(readFileSync(file).subarray(0, 3).toString('hex')).toBe('efbbbf')
  await activateProject(window, dir)

  // Touch the LAST line only — line 1 is none of the user's business here.
  await openFromTree(window, rel)
  await expect(window.locator('.monaco-editor .view-lines')).toContainText('café')
  await window.locator('.monaco-editor .view-lines').click()
  await window.keyboard.press('ControlOrMeta+ArrowDown')
  await window.keyboard.press('End')
  await window.keyboard.type('\nexport const ADDED = 3')
  await window.keyboard.press('ControlOrMeta+s')
  await expect(tab(window, rel).locator('.dirty-dot')).toBeHidden({ timeout: 8000 })

  // The BOM is still the first three bytes, and git sees only the added line.
  expect(readFileSync(file).subarray(0, 3).toString('hex')).toBe('efbbbf')
  expect(gitRetry(dir, 'diff', '--', rel)).not.toContain('-﻿export const NAME')

  const appErrs = appErrors(errors)
  expect(appErrs, appErrs.join(', ')).toHaveLength(0)
})

// #1146 (fixed): the save path resolves the target through symlinks before the
// atomic replace, so it writes THROUGH the link instead of renaming over it.
test('saving a symlinked file edits its target and keeps the link intact', async ({
  window,
}) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  const dir = await seedProject(window)
  writeFileSync(join(dir, 'real.md'), '# real target\n')
  symlinkSync(join(dir, 'real.md'), join(dir, 'link.md'))
  expect(lstatSync(join(dir, 'link.md')).isSymbolicLink()).toBe(true)
  await activateProject(window, dir)

  await openFromTree(window, 'link.md')
  await expect(window.locator('.monaco-editor .view-lines')).toContainText('real target')
  await window.locator('.monaco-editor .view-lines').click()
  await window.keyboard.press('ControlOrMeta+ArrowDown')
  await window.keyboard.press('End')
  await window.keyboard.type('\nedited-through-link')
  await window.keyboard.press('ControlOrMeta+s')
  await expect(tab(window, 'link.md').locator('.dirty-dot')).toBeHidden({ timeout: 8000 })

  // The edit must reach the file the link points at, and link.md must still be
  // a link — not a detached regular file holding a divergent copy.
  expect(readFileSync(join(dir, 'real.md'), 'utf8')).toContain('edited-through-link')
  expect(lstatSync(join(dir, 'link.md')).isSymbolicLink()).toBe(true)

  const appErrs = appErrors(errors)
  expect(appErrs, appErrs.join(', ')).toHaveLength(0)
})
