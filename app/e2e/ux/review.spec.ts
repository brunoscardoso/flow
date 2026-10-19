import { test, expect } from '../fixtures/electron'
import { sel } from '../selectors'
import { seedProject, activateProject, cleanupSeeds, waitForStableNode } from './fixtures/seed'
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'

/**
 * UX sweep — flow 5: Review (file list, approve/reject, manual commit, ✨ message,
 * feedback on failure). Drives the real phase-grouped Review panel against a
 * seeded project whose working tree has uncommitted changes — `review:list`
 * groups the git status, so no Claude account is needed to reach the file list,
 * approve/commit gating, discard confirm, reject prompt, and manual mode. The ✨
 * commit-message generation is the one path that needs a Claude account, so we
 * assert only its account-independent gating (disabled until a file is approved).
 */

const SCREENS = 'e2e/ux/__screens'

/**
 * Seed a git repo with a committed baseline plus uncommitted working-tree
 * changes (one modified tracked file, one brand-new untracked file), add it as a
 * project root, and activate it. Returns the repo dir. A real user reaches the
 * Review panel exactly here: a project with pending edits to review.
 */
async function seedReviewRepo(win: Page): Promise<string> {
  const dir = await seedProject(win, 'flow-ux-review-')
  // A commit needs an identity; a fresh `git init` repo has none.
  execFileSync('git', ['config', 'user.email', 'qa@flow.test'], { cwd: dir })
  execFileSync('git', ['config', 'user.name', 'Flow QA'], { cwd: dir })
  // Committed baseline so tracked files can show as *modified* (not just added).
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

test('file list: uncommitted working-tree changes appear as reviewable files', async ({
  window,
}) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  await seedReviewRepo(window)
  await openReview(window)

  // The two working-tree changes land in the "Other changes" group (no plan).
  const group = window.locator('.fl-review-group')
  await expect(group).toHaveCount(1)
  await expect(group.locator('.fl-review-group-label')).toContainText('Other changes')

  const rows = window.locator('.fl-review-file')
  await expect(rows).toHaveCount(2)
  await expect(window.locator('.fl-review-file-name', { hasText: 'app.ts' })).toBeVisible()
  await expect(window.locator('.fl-review-file-name', { hasText: 'feature.ts' })).toBeVisible()

  await window.screenshot({ path: `${SCREENS}/review-file-list.png` })
  expect(errors, errors.join(', ')).toHaveLength(0)
})

test('approve + commit: approving all then committing clears the change', async ({ window }) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  const dir = await seedReviewRepo(window)
  await openReview(window)

  const commitBtn = window.locator('.fl-review-commit-btn')
  // Before approving, the button is an "Approve all (0/2)" affordance.
  await expect(commitBtn).toContainText('Approve all (0/2)')

  // Approve each file via its ✓ button, then the button flips to "Commit phase".
  for (const approve of await window.locator('.fl-review-approve').all()) await approve.click()
  await expect(commitBtn).toContainText('Commit phase')
  await expect(commitBtn).toBeEnabled()

  await commitBtn.click()

  // A successful commit clears the working tree → the panel empties.
  await expect(window.locator('.fl-review-empty')).toContainText('No changes to review')
  // And git agrees: nothing left uncommitted.
  const status = execFileSync('git', ['status', '--porcelain'], { cwd: dir }).toString().trim()
  expect(status).toBe('')

  await window.screenshot({ path: `${SCREENS}/review-after-commit.png` })
  expect(errors, errors.join(', ')).toHaveLength(0)
})

test('reject: the ✕ opens an inline feedback prompt', async ({ window }) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  await seedReviewRepo(window)
  await openReview(window)

  const firstRow = window.locator('.fl-review-file').first()
  await firstRow.locator('.fl-review-reject').click()

  // The row becomes a "why reject?" feedback input the user can type into.
  const prompt = window.locator('.fl-review-reject-prompt')
  await expect(prompt).toBeVisible()
  await expect(prompt.locator('input')).toBeFocused()

  await window.screenshot({ path: `${SCREENS}/review-reject-prompt.png` })
  expect(errors, errors.join(', ')).toHaveLength(0)
})

test('discard: "Discard all" asks for a two-step confirm before reverting', async ({ window }) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  await seedReviewRepo(window)
  await openReview(window)

  await window.locator('.fl-review-discard-btn').click()
  // A destructive action must confirm, not act on the first click.
  await expect(window.locator('.fl-review-discard-confirm')).toBeVisible()
  // The label says exactly what it destroys (#697): every change, and the
  // untracked paths it will DELETE — the old "revert to HEAD" said neither.
  await expect(window.locator('.fl-review-discard-label')).toContainText(
    'Discard ALL 2 working-tree change(s)',
  )
  await expect(window.locator('.fl-review-discard-label')).toContainText('DELETED')

  await window.screenshot({ path: `${SCREENS}/review-discard-confirm.png` })
  expect(errors, errors.join(', ')).toHaveLength(0)
})

test('bulk "Approve all" + message gating: the phase button drives approve→commit', async ({
  window,
}) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  const dir = await seedReviewRepo(window)
  await openReview(window)

  const commitBtn = window.locator('.fl-review-commit-btn')
  // A single click on the "Approve all (0/2)" affordance approves every file in
  // the phase at once (the bulk path, distinct from the per-file ✓ buttons) …
  await expect(commitBtn).toContainText('Approve all (0/2)')
  await commitBtn.click()
  await expect(commitBtn).toContainText('Commit phase')
  await expect(window.locator('.fl-review-file-approved')).toHaveCount(2)

  // … then the phase can't commit with an empty message (blank commits are a
  // no-op/error, so the button must gate on a message) …
  const message = window.locator('.fl-review-message').first()
  await message.fill('')
  await expect(commitBtn).toBeDisabled()

  // … and typing a message re-enables it and commits the whole phase.
  await message.fill('chore: approve-all commit')
  await expect(commitBtn).toBeEnabled()
  await commitBtn.click()
  await expect(window.locator('.fl-review-empty')).toContainText('No changes to review')
  const status = execFileSync('git', ['status', '--porcelain'], { cwd: dir }).toString().trim()
  expect(status).toBe('')

  await window.screenshot({ path: `${SCREENS}/review-approve-all-commit.png` })
  expect(errors, errors.join(', ')).toHaveLength(0)
})
