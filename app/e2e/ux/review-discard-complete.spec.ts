import { test, expect } from '../fixtures/electron'
import { sel } from '../selectors'
import { seedProject, activateProject, cleanupSeeds, waitForStableNode } from './fixtures/seed'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'

/**
 * UX sweep — flow 5: Review, the "Discard all" COMPLETION path.
 *
 * review.spec asserts only that the destructive "Discard all" surfaces a
 * two-step confirm — it never clicks the second "Discard N" button, so the
 * actual revert (the thing the user is confirming) has zero live E2E coverage.
 * This drives the confirm-then-discard to completion and asserts the real
 * effect: the modified tracked file reverts to HEAD, the brand-new untracked
 * file is removed from disk (revertFile #136), the panel empties, and the git
 * working tree is clean — all account-independent (git revert, no agent).
 */

const SCREENS = 'e2e/ux/__screens'

/**
 * Seed a git repo with a committed baseline plus uncommitted working-tree
 * changes (one modified tracked file, one brand-new untracked file), add it as a
 * project root, and activate it. Mirrors review.spec's seedReviewRepo so the
 * Review panel shows the exact "Other changes" group a real user reviews.
 */
async function seedReviewRepo(win: Page): Promise<string> {
  const dir = await seedProject(win, 'flow-ux-review-discard-')
  execFileSync('git', ['config', 'user.email', 'qa@flow.test'], { cwd: dir })
  execFileSync('git', ['config', 'user.name', 'Flow QA'], { cwd: dir })
  writeFileSync(join(dir, 'app.ts'), 'export const version = 1\n')
  writeFileSync(join(dir, 'README.md'), '# Seeded review repo\n')
  execFileSync('git', ['add', '-A'], { cwd: dir })
  execFileSync('git', ['commit', '-q', '-m', 'baseline'], { cwd: dir })
  // Working-tree changes to review: modify one tracked file, add one new file.
  writeFileSync(join(dir, 'app.ts'), 'export const version = 2\n')
  writeFileSync(join(dir, 'feature.ts'), 'export const feature = true\n')
  await activateProject(win, dir)
  return dir
}

/** Open Source Control → Phases (the folded-in review, #335) and wait for the
 *  review body to mount. */
async function openReview(win: Page): Promise<void> {
  await win.locator('[data-rail-item="source-control"]').click()
  await win.locator(sel.scViewBtn).filter({ hasText: 'Phases' }).click()
  await expect(win.locator('.fl-review')).toBeAttached()
  // The list rebuilds a couple of times as a fresh project settles; a click
  // landing on a replaced node is lost (#1093/#1094).
  await waitForStableNode(win, '.fl-review-file')
}

test.afterAll(() => cleanupSeeds())

test('discard all → confirm actually reverts every change and empties the panel', async ({
  window,
}) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  const dir = await seedReviewRepo(window)
  await openReview(window)

  // Baseline: two changes to review, one modified (app.ts), one untracked (feature.ts).
  await expect(window.locator('.fl-review-file')).toHaveCount(2)
  expect(existsSync(join(dir, 'feature.ts'))).toBe(true)
  expect(readFileSync(join(dir, 'app.ts'), 'utf8')).toContain('version = 2')

  // Step 1 — first click reveals the confirm (does NOT act destructively).
  await window.locator('.fl-review-discard-btn').click()
  const confirm = window.locator('.fl-review-discard-confirm')
  await expect(confirm).toBeVisible()
  // Nothing reverted yet — the confirm is genuinely a hold, not a delayed act.
  await expect(window.locator('.fl-review-file')).toHaveCount(2)
  expect(existsSync(join(dir, 'feature.ts'))).toBe(true)
  await window.screenshot({ path: `${SCREENS}/review-discard-confirm-hold.png` })

  // Step 2 — the confirm's "Discard N" button carries the destructive commit.
  await confirm.locator('.fl-review-discard-btn.confirm').click()

  // The panel empties — every change was reverted, nothing left to review.
  await expect(window.locator('.fl-review-empty')).toContainText('No changes to review')

  // And the working tree matches: modified file back to HEAD, untracked file gone.
  expect(readFileSync(join(dir, 'app.ts'), 'utf8')).toContain('version = 1')
  expect(existsSync(join(dir, 'feature.ts'))).toBe(false)
  const status = execFileSync('git', ['status', '--porcelain'], { cwd: dir }).toString().trim()
  expect(status).toBe('')

  await window.screenshot({ path: `${SCREENS}/review-discard-complete.png` })
  expect(errors, errors.join(', ')).toHaveLength(0)
})
