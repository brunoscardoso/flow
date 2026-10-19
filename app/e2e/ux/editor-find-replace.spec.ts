import { test, expect } from '../fixtures/electron'
import { seedProject, activateProject, cleanupSeeds, pickFilesProject } from './fixtures/seed'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'

/**
 * UX regression probe — flow `editor` (open file / tabs / Monaco / conflict
 * resolve), round 19: **find & replace inside the editor** (⌘F / ⌘⌥F / Enter /
 * Esc).
 *
 * Every prior flow-7 probe drives the *tab* layer (open/close/nav/overflow/
 * same-name/close-ops/project-follow), the *disk* layer (external reload, save
 * failure, too-large, undo history) or the conflict UI. Nobody had asked whether
 * the most-used in-file interaction — search this file, jump to the next hit,
 * replace it, save — works in Flow's Monaco host, which is a SINGLE editor
 * instance shared by every tab (`monaco-host` `#setModel` swaps the model in
 * place). That sharing is what makes the widget worth guarding: find state lives
 * on the editor, not on the model, so a tab switch could easily leave the user
 * looking at another file's match count.
 *
 * Driven end-to-end against the real app; no account needed. Result: the seam is
 * healthy — ⌘F counts and walks matches (scrolling the far-away one into view),
 * ⌘⌥F replace-all rewrites the buffer, dirties the tab and ⌘S persists exactly
 * the replaced text, and the widget re-searches the buffer you switch to. These
 * are pure coverage guards (no bug filed from this seam); the round's two filed
 * defects came from the sibling save-fidelity probe (editor-save-fidelity.spec.ts).
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

async function expectEditorShows(win: Page, text: string): Promise<void> {
  await expect(win.locator('.monaco-editor .view-lines')).toContainText(text, { timeout: 15000 })
}

/** Monaco's in-editor find widget. */
function findWidget(win: Page) {
  return win.locator('.monaco-editor .find-widget').first()
}

function matchCount(win: Page) {
  return findWidget(win).locator('.matchesCount')
}

test.afterAll(() => cleanupSeeds())

test('cmd+F counts the matches, Enter walks them (scrolling the far one into view), Esc closes', async ({
  window,
}) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  const dir = await seedProject(window)
  // The needle sits on file lines 3, 41 and 79 — the last two are well below the
  // fold, so "next match" has to actually scroll, not just select off-screen.
  const lines = ['export const HEAD = "find-probe-head"']
  for (let i = 1; i <= 80; i++) {
    if (i === 2 || i === 40 || i === 78) lines.push(`const hit${i} = "needle-token"`)
    else lines.push(`const filler${i} = ${i}`)
  }
  writeFileSync(join(dir, 'alpha.ts'), `${lines.join('\n')}\n`)
  await activateProject(window, dir)

  await openFromTree(window, 'alpha.ts')
  await expectEditorShows(window, 'find-probe-head')

  await window.keyboard.press('ControlOrMeta+f')
  await expect(findWidget(window)).toBeVisible({ timeout: 5000 })

  await window.keyboard.type('needle-token')
  await expect(matchCount(window)).toHaveText(/1 of 3/, { timeout: 5000 })

  // Enter walks forward through all three, then wraps back to the first.
  await window.keyboard.press('Enter')
  await expect(matchCount(window)).toHaveText(/2 of 3/)
  await expectEditorShows(window, 'const hit40')
  await window.keyboard.press('Enter')
  await expect(matchCount(window)).toHaveText(/3 of 3/)
  await expectEditorShows(window, 'const hit78')
  // The current match must be on screen — "found it, but you can't see it" is a
  // dead end for the user.
  await expect(window.locator('.monaco-editor .currentFindMatch')).toBeInViewport()
  await window.screenshot({ path: `${SCREENS}/editor-find-third-match.png` })

  await window.keyboard.press('Enter')
  await expect(matchCount(window)).toHaveText(/1 of 3/)

  // Esc closes the widget and hands focus back to the buffer. (Monaco keeps the
  // closed widget in the DOM, translated out of the editor box, so Playwright
  // still calls it "visible" — the `visible` class is the real open/closed
  // state, and typing landing in the file is the real focus proof.)
  await window.keyboard.press('Escape')
  await expect(findWidget(window)).not.toHaveClass(/\bvisible\b/, { timeout: 5000 })
  await window.keyboard.press('ControlOrMeta+ArrowUp')
  await window.keyboard.press('Home')
  await window.keyboard.type('typed-after-esc ')
  await expectEditorShows(window, 'typed-after-esc')

  const appErrs = appErrors(errors)
  expect(appErrs, appErrs.join(', ')).toHaveLength(0)
})

test('cmd+alt+F replace-all rewrites the buffer, dirties the tab, and cmd+S persists it', async ({
  window,
}) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  const dir = await seedProject(window)
  const file = join(dir, 'beta.ts')
  writeFileSync(
    file,
    ['const one = "swap-me"', 'const two = "swap-me"', 'const three = "keep-me"', ''].join('\n'),
  )
  await activateProject(window, dir)

  await openFromTree(window, 'beta.ts')
  await expectEditorShows(window, 'swap-me')

  // ⌘⌥F must open the widget with the REPLACE row expanded, not just find.
  await window.keyboard.press('ControlOrMeta+Alt+f')
  const widget = findWidget(window)
  await expect(widget).toBeVisible({ timeout: 5000 })
  const replaceInput = widget.locator('.replace-part textarea.input').first()
  await expect(replaceInput).toBeVisible({ timeout: 5000 })

  await window.keyboard.type('swap-me')
  await expect(matchCount(window)).toHaveText(/of 2/, { timeout: 5000 })

  await replaceInput.click()
  await window.keyboard.type('swapped-ok')
  await widget.locator('.replace-actions .codicon-find-replace-all').first().click()

  await expectEditorShows(window, 'swapped-ok')
  await expect(window.locator('.monaco-editor .view-lines')).not.toContainText('swap-me')
  // Content the user did not type by hand still counts as an unsaved edit.
  await expect(tab(window, 'beta.ts').locator('.dirty-dot')).toBeVisible()

  await window.keyboard.press('Escape')
  await window.locator('.monaco-editor .view-lines').click()
  await window.keyboard.press('ControlOrMeta+s')
  await expect(tab(window, 'beta.ts').locator('.dirty-dot')).toBeHidden({ timeout: 8000 })

  const onDisk = readFileSync(file, 'utf8')
  expect(onDisk).toContain('swapped-ok')
  expect(onDisk).not.toContain('"swap-me"')
  expect(onDisk).toContain('keep-me')
  await window.screenshot({ path: `${SCREENS}/editor-replace-saved.png` })

  const appErrs = appErrors(errors)
  expect(appErrs, appErrs.join(', ')).toHaveLength(0)
})

test('the find widget re-searches the tab you switch to — never another file’s match count', async ({
  window,
}) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  const dir = await seedProject(window)
  writeFileSync(
    join(dir, 'alpha.ts'),
    ['const a1 = "shared-token"', 'const a2 = "shared-token"', 'const a3 = "shared-token"', ''].join(
      '\n',
    ),
  )
  writeFileSync(
    join(dir, 'beta.ts'),
    ['const b1 = "shared-token"', 'const b2 = "beta-only"', ''].join('\n'),
  )
  await activateProject(window, dir)

  await openFromTree(window, 'alpha.ts')
  await expectEditorShows(window, 'const a1')
  await openFromTree(window, 'beta.ts')
  await expectEditorShows(window, 'beta-only')

  // Search in beta (1 match), then switch to alpha (3 matches) — one editor
  // instance serves both tabs, so a stale count here would send the user
  // hunting for matches that aren't in the file they're looking at.
  await window.keyboard.press('ControlOrMeta+f')
  await expect(findWidget(window)).toBeVisible({ timeout: 5000 })
  await window.keyboard.type('shared-token')
  await expect(matchCount(window)).toHaveText(/of 1/, { timeout: 5000 })

  await tab(window, 'alpha.ts').click()
  await expectEditorShows(window, 'const a3')
  if (await findWidget(window).isVisible()) {
    await expect(matchCount(window)).toHaveText(/of 3/, { timeout: 5000 })
  }

  await window.screenshot({ path: `${SCREENS}/editor-find-tab-switch.png` })
  const appErrs = appErrors(errors)
  expect(appErrs, appErrs.join(', ')).toHaveLength(0)
})
