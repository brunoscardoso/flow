/**
 * #SCMS — multi-select staging on the unified Source Control panel.
 *
 * Cursor-style selection the panel did not have before: a plain click selects a
 * row (and opens its diff), Shift-click selects a contiguous range, Cmd/Ctrl-click
 * toggles a row, and a right-click offers Stage/Unstage/Discard Selected over the
 * whole selection — above the existing "Reveal" item. This spec drives the DOM
 * behavior the pure unit tests (source-control-selection, selectionMenuItems)
 * cannot: the real `.fl-row-marked` highlight, the extended context menu, and a
 * context-menu stage that actually moves the selected files into the index.
 *
 * The four files live under `pkg/` so they are contiguous in the list and isolated
 * from the IDE's own provisioning scaffold (CLAUDE.md etc.), which can add its own
 * top-level change rows — so this spec targets files BY NAME, never by a global
 * row count or index.
 *
 * (Discard Selected uses a native window.confirm(), which Playwright cannot drive,
 * so it is intentionally not asserted here — same reason as git-untracked-expand.)
 */
import { test, expect, type Page, type Locator } from '../fixtures/electron'
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed'
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

function git(dir: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: dir }).toString()
}
function configure(dir: string): void {
  git(dir, 'config', 'user.email', 'qa@flow.test')
  git(dir, 'config', 'user.name', 'QA Bot')
}

const NAMES = ['a.txt', 'b.txt', 'c.txt', 'd.txt']

/** Commit four files under pkg/, then modify all four — so the Changes section
 *  holds four contiguous modified rows to select across. */
function populateRepo(dir: string): void {
  configure(dir)
  mkdirSync(join(dir, 'pkg'))
  for (const n of NAMES) writeFileSync(join(dir, 'pkg', n), `${n} v1\n`)
  git(dir, 'add', '-A')
  git(dir, 'commit', '-q', '-m', 'chore: initial commit')
  for (const n of NAMES) writeFileSync(join(dir, 'pkg', n), `${n} v2\n`)
}

/** The Changes row for one of our files, located by its filename. */
function fileRow(window: Page, name: string): Locator {
  return window.locator('.gp-row', { has: window.locator('.gp-name', { hasText: name }) }).first()
}

async function openGitPanel(window: Page): Promise<string> {
  const dir = await seedProject(window, 'flow-git-multiselect-', populateRepo)
  await activateProject(window, dir)
  await window.locator('[data-rail-item="source-control"]').click()
  await window.locator('.fl-sc-viewbtn', { hasText: 'Changes' }).click()
  await expect(window.locator('.gp-root')).toBeVisible()
  // Our four files are present (a status refresh re-render may briefly empty rows).
  await expect(async () => {
    for (const n of NAMES) expect(await fileRow(window, n).count()).toBe(1)
  }).toPass({ timeout: 8000 })
  return dir
}

const BENIGN_MONACO = [/^Canceled: Canceled$/, /no diff result available/i]
function appErrors(errors: string[]): string[] {
  return errors.filter((e) => !BENIGN_MONACO.some((re) => re.test(e)))
}

test.afterAll(() => cleanupSeeds())

test.describe('git multi-select staging (#SCMS)', () => {
  test('Shift-click selects a contiguous range and the context menu stages exactly those files', async ({
    window,
  }) => {
    const errors: string[] = []
    window.on('pageerror', (e) => errors.push(String(e)))

    const dir = await openGitPanel(window)

    // Plain-click a.txt (selects it AND opens its diff — FR-1); close the diff so
    // it can't cover the panel for the next click.
    await fileRow(window, 'a.txt').locator('.gp-name').click()
    await window.keyboard.press('Escape')

    // Shift-click c.txt → the contiguous range a..c is marked, d is not (FR-3).
    await fileRow(window, 'c.txt').locator('.gp-name').click({ modifiers: ['Shift'] })
    await expect(fileRow(window, 'a.txt')).toHaveClass(/fl-row-marked/)
    await expect(fileRow(window, 'b.txt')).toHaveClass(/fl-row-marked/)
    await expect(fileRow(window, 'c.txt')).toHaveClass(/fl-row-marked/)
    await expect(fileRow(window, 'd.txt')).not.toHaveClass(/fl-row-marked/)

    // Right-click a row IN the selection → a count-aware Stage item (FR-5).
    await fileRow(window, 'b.txt').locator('.gp-name').click({ button: 'right' })
    const menu = window.locator('.fl-reveal-menu')
    await expect(menu).toBeVisible()
    await expect(menu).toContainText('Stage Selected (3)')

    await menu.getByText('Stage Selected (3)').click()

    // Exactly the three selected files land in the index; d.txt stays unstaged (FR-7).
    await expect(async () => {
      const porcelain = git(dir, 'status', '--porcelain')
      expect(porcelain).toMatch(/^M {2}pkg\/a\.txt/m)
      expect(porcelain).toMatch(/^M {2}pkg\/b\.txt/m)
      expect(porcelain).toMatch(/^M {2}pkg\/c\.txt/m)
      expect(porcelain).toMatch(/^ M pkg\/d\.txt/m)
    }).toPass({ timeout: 6000 })

    expect(appErrors(errors)).toEqual([])
  })

  test('Cmd/Ctrl-click toggles a row in and out of the selection', async ({ window }) => {
    const errors: string[] = []
    window.on('pageerror', (e) => errors.push(String(e)))

    await openGitPanel(window)

    await fileRow(window, 'a.txt').locator('.gp-name').click()
    await window.keyboard.press('Escape')
    await expect(fileRow(window, 'a.txt')).toHaveClass(/fl-row-marked/)

    // Toggle a non-adjacent row IN → a and c marked, b not (FR-2).
    await fileRow(window, 'c.txt').locator('.gp-name').click({ modifiers: ['ControlOrMeta'] })
    await expect(fileRow(window, 'a.txt')).toHaveClass(/fl-row-marked/)
    await expect(fileRow(window, 'c.txt')).toHaveClass(/fl-row-marked/)
    await expect(fileRow(window, 'b.txt')).not.toHaveClass(/fl-row-marked/)

    // Toggle c OUT → only a remains.
    await fileRow(window, 'c.txt').locator('.gp-name').click({ modifiers: ['ControlOrMeta'] })
    await expect(fileRow(window, 'c.txt')).not.toHaveClass(/fl-row-marked/)
    await expect(fileRow(window, 'a.txt')).toHaveClass(/fl-row-marked/)

    expect(appErrors(errors)).toEqual([])
  })

  test('right-clicking a row outside the selection makes it the sole selection first', async ({
    window,
  }) => {
    const errors: string[] = []
    window.on('pageerror', (e) => errors.push(String(e)))

    const dir = await openGitPanel(window)

    // Build a two-row selection on a..b.
    await fileRow(window, 'a.txt').locator('.gp-name').click()
    await window.keyboard.press('Escape')
    await fileRow(window, 'b.txt').locator('.gp-name').click({ modifiers: ['Shift'] })
    await expect(fileRow(window, 'a.txt')).toHaveClass(/fl-row-marked/)
    await expect(fileRow(window, 'b.txt')).toHaveClass(/fl-row-marked/)

    // Right-click d.txt (NOT selected) → it becomes the sole selection, so the
    // menu acts on what was pointed at (count 1), not the stale two (FR-5).
    await fileRow(window, 'd.txt').locator('.gp-name').click({ button: 'right' })
    const menu = window.locator('.fl-reveal-menu')
    await expect(menu).toContainText('Stage Selected (1)')
    await menu.getByText('Stage Selected (1)').click()

    // Only d.txt is staged; a..c stay unstaged.
    await expect(async () => {
      const porcelain = git(dir, 'status', '--porcelain')
      expect(porcelain).toMatch(/^M {2}pkg\/d\.txt/m)
      expect(porcelain).toMatch(/^ M pkg\/a\.txt/m)
    }).toPass({ timeout: 6000 })

    expect(appErrors(errors)).toEqual([])
  })
})
