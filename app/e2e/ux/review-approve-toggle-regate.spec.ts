import { test, expect } from '../fixtures/electron'
import { sel } from '../selectors'
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed'
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'

/**
 * UX sweep — flow 5 (Review): the per-file ✓ approve TOGGLE and its re-gate of
 * the phase Commit button.
 *
 * review.spec covers the bulk "Approve all" button and the approve-everything→
 * commit happy path, but treats ✓ as a one-way approve. The ✓ is actually a
 * TOGGLE (review-panel.ts #renderFile 317-323: approved.delete when already
 * approved), and the phase button is gated on EVERY file being approved
 * (commitButtonState / allFilesApproved). So un-approving a single file after
 * the button already flipped to "Commit phase" MUST re-gate it back to
 * "Approve all (N-1/N)". If that re-gate were stale, the user could commit a
 * phase they just partially un-approved — silently committing a file they
 * explicitly withdrew. That dynamic toggle-OFF transition has zero live E2E
 * coverage; the pure unit test (review-approval.test.ts) checks the state
 * function but never drives the real ✓ button through the DOM.
 *
 * Fully account-independent: review:list groups the git working tree, so no
 * Claude account or agent is needed — only local approve/commit.
 */

const SCREENS = 'e2e/ux/__screens'

/**
 * Seed a git repo with a committed baseline plus TWO uncommitted working-tree
 * changes (two modified tracked files), add it as a project root, and activate
 * it. Two files are required so a single un-approve can drop the group below the
 * all-approved threshold — the whole point of the re-gate.
 */
async function seedTwoFileRepo(win: Page): Promise<string> {
  const dir = await seedProject(win, 'flow-ux-regate-')
  execFileSync('git', ['config', 'user.email', 'qa@flow.test'], { cwd: dir })
  execFileSync('git', ['config', 'user.name', 'Flow QA'], { cwd: dir })
  writeFileSync(join(dir, 'app.ts'), 'export const version = 1\n')
  writeFileSync(join(dir, 'lib.ts'), 'export const lib = 1\n')
  execFileSync('git', ['add', '-A'], { cwd: dir })
  execFileSync('git', ['commit', '-q', '-m', 'baseline'], { cwd: dir })
  // Two working-tree changes to review.
  writeFileSync(join(dir, 'app.ts'), 'export const version = 2\n')
  writeFileSync(join(dir, 'lib.ts'), 'export const lib = 2\n')
  await activateProject(win, dir)
  return dir
}

/** Open Source Control → Phases (the folded-in review, #335) and wait for mount. */
async function openReview(win: Page): Promise<void> {
  await win.locator('[data-rail-item="source-control"]').click()
  await win.locator(sel.scViewBtn).filter({ hasText: 'Phases' }).click()
  await expect(win.locator('.fl-review')).toBeAttached()
}

test.afterAll(() => cleanupSeeds())

test('per-file ✓ toggle drives the counter and un-approving re-gates the Commit button', async ({
  window,
}) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  const dir = await seedTwoFileRepo(window)
  await openReview(window)

  const commitBtn = window.locator('.fl-review-commit-btn')
  const approves = window.locator('.fl-review-approve')
  await expect(approves).toHaveCount(2)

  // Baseline: nothing approved → the counter reads 0/2, click would approve-all.
  await expect(commitBtn).toContainText('Approve all (0/2)')
  await expect(window.locator('.fl-review-file-approved')).toHaveCount(0)

  // Approve ONE file via its ✓ (the per-file path, not the bulk button). The
  // counter advances to 1/2 and the button STAYS in approve mode — a group with
  // an unapproved file must not be committable.
  await approves.nth(0).click()
  await expect(commitBtn).toContainText('Approve all (1/2)')
  await expect(window.locator('.fl-review-file-approved')).toHaveCount(1)

  // Approve the second file → now every file is approved → the button flips to
  // "Commit phase" (enabled, since the seeded suggested message is non-empty).
  await approves.nth(1).click()
  await expect(commitBtn).toContainText('Commit phase')
  await expect(commitBtn).toBeEnabled()
  await expect(window.locator('.fl-review-file-approved')).toHaveCount(2)

  await window.screenshot({ path: `${SCREENS}/review-regate-all-approved.png` })

  // THE RE-GATE: un-approve the first file by clicking its ✓ again. The button
  // MUST fall back out of "Commit phase" to "Approve all (1/2)" — a stale
  // "Commit phase" here would let the user commit a file they just withdrew.
  await approves.nth(0).click()
  await expect(commitBtn).toContainText('Approve all (1/2)')
  await expect(commitBtn).not.toContainText('Commit phase')
  await expect(window.locator('.fl-review-file-approved')).toHaveCount(1)

  await window.screenshot({ path: `${SCREENS}/review-regate-unapproved.png` })

  // Re-approve it → back to a committable state, and the commit actually lands
  // (proving the re-gate didn't corrupt the approved set — every file commits).
  await approves.nth(0).click()
  await expect(commitBtn).toContainText('Commit phase')
  await commitBtn.click()
  await expect(window.locator('.fl-review-empty')).toContainText('No changes to review')
  const status = execFileSync('git', ['status', '--porcelain'], { cwd: dir }).toString().trim()
  expect(status).toBe('')

  expect(errors, errors.join(', ')).toHaveLength(0)
})
