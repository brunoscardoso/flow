import { test, expect } from '../fixtures/electron'
import { sel } from '../selectors'
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed'
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'

/**
 * UX sweep — flow 5: Review, the "click a file → see the diff" content path.
 *
 * The most central review action is: before approving, click a changed file's
 * name to actually SEE what changed. Prior review specs cover the file list,
 * approve/commit gating, reject/discard prompts, and the stale-diff lifecycle
 * (review-stale-diff), but none asserts the diff overlay renders the real
 * before/after CONTENT for a review-panel-opened file. This drives that: a
 * modified tracked file must show both its old and new line in the working-tree
 * diff; an added (untracked) file must show its new content. Uncaught errors
 * during the flow are treated as bugs.
 */

const SCREENS = 'e2e/ux/__screens'

async function seedReviewRepo(win: Page): Promise<string> {
  const dir = await seedProject(win, 'flow-ux-review-diff-')
  execFileSync('git', ['config', 'user.email', 'qa@flow.test'], { cwd: dir })
  execFileSync('git', ['config', 'user.name', 'Flow QA'], { cwd: dir })
  writeFileSync(join(dir, 'app.ts'), 'export const version = 1\n')
  execFileSync('git', ['add', '-A'], { cwd: dir })
  execFileSync('git', ['commit', '-q', '-m', 'baseline'], { cwd: dir })
  // Working-tree changes to review: a modified tracked file + a new untracked one.
  writeFileSync(join(dir, 'app.ts'), 'export const version = 2\n')
  writeFileSync(join(dir, 'feature.ts'), 'export const feature = true\n')
  await activateProject(win, dir)
  return dir
}

async function openReview(win: Page): Promise<void> {
  await win.locator('[data-rail-item="source-control"]').click()
  await win.locator(sel.scViewBtn).filter({ hasText: 'Phases' }).click()
  await expect(win.locator('.fl-review')).toBeAttached()
}

test.afterAll(() => cleanupSeeds())

test('modified file: clicking its name opens the diff showing old AND new content', async ({
  window,
}) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  await seedReviewRepo(window)
  await openReview(window)

  // Click the modified file's name — the core "let me see what changed" action.
  await window.locator('.fl-review-file-name', { hasText: 'app.ts' }).click()

  // The working-tree-vs-HEAD overlay opens …
  const overlay = window.locator('.gd-overlay')
  await expect(overlay).toBeVisible()
  await expect(window.locator('.gd-subtitle')).toContainText('Working tree vs HEAD')
  await expect(window.locator('.gd-title')).toContainText('app.ts')

  // … and it must show the REAL diff: the old line (version = 1) removed and the
  // new line (version = 2) added. A blank/empty diff body would mean the reviewer
  // is approving blind.
  const body = window.locator('.gd-body')
  await expect(body).toContainText('version = 1')
  await expect(body).toContainText('version = 2')

  await window.screenshot({ path: `${SCREENS}/review-diff-modified.png` })
  expect(errors, errors.join(', ')).toHaveLength(0)
})

test('added file: clicking its name opens the diff showing the new content', async ({ window }) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  await seedReviewRepo(window)
  await openReview(window)

  await window.locator('.fl-review-file-name', { hasText: 'feature.ts' }).click()

  const overlay = window.locator('.gd-overlay')
  await expect(overlay).toBeVisible()
  await expect(window.locator('.gd-title')).toContainText('feature.ts')

  // A brand-new file's diff must show its content (the whole file is "added").
  await expect(window.locator('.gd-body')).toContainText('feature = true')

  await window.screenshot({ path: `${SCREENS}/review-diff-added.png` })
  expect(errors, errors.join(', ')).toHaveLength(0)
})

test('untracked directory row: clicking it opens the #247 listing — not a silent dead click (#854)', async ({
  window,
}) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  const dir = await seedReviewRepo(window)
  // A brand-new module folder — git rolls it up into one `newmodule/` row.
  const { mkdirSync } = await import('node:fs')
  mkdirSync(join(dir, 'newmodule'))
  writeFileSync(join(dir, 'newmodule', 'a.ts'), 'export const a = 1\n')
  writeFileSync(join(dir, 'newmodule', 'b.ts'), 'export const b = 2\n')
  await openReview(window)

  await window.locator('.fl-review-file-name', { hasText: 'newmodule/' }).click()

  // The overlay opens with the directory's file LISTING (directoryDiff, #247) —
  // the same preview the git panel's Changes view gives this row.
  const overlay = window.locator('.gd-overlay')
  await expect(overlay).toBeVisible()
  await expect(window.locator('.gd-body')).toContainText('a.ts')
  await expect(window.locator('.gd-body')).toContainText('b.ts')

  expect(errors, errors.join(', ')).toHaveLength(0)
})
