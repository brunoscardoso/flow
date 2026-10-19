import { test, expect } from '../fixtures/electron'
import { sel } from '../selectors'
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed'
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'

/**
 * UX sweep — flow 5: Review, stale diff overlay (#659).
 *
 * The phase-grouped Review panel (Source Control → Phases) opens a working-tree
 * diff when a changed file is clicked. That overlay is a one-shot frozen
 * snapshot: unlike the git side panel (which closes its open diff once the file
 * leaves the changes list — the #402 fix, `resolveOpenDiffFate`), the review
 * coordinator's `openDiff` never re-syncs or closes. So after Commit phase /
 * Discard all, the review list correctly empties to "No changes to review"
 * while the diff overlay keeps rendering the old "Working tree vs HEAD" for a
 * now-clean file — the overlay contradicts the emptied list beside it.
 *
 * Live guards below cover the account-independent review paths that DO work.
 * The stale-overlay tripwire is live since #659's fix: the review coordinator
 * now tracks the open diff and applies `resolveOpenDiffFate` on every refresh
 * (close when the file leaves the review groups, re-issue while it stays).
 */

const SCREENS = 'e2e/ux/__screens'

async function seedReviewRepo(win: Page): Promise<string> {
  const dir = await seedProject(win, 'flow-ux-revstale-')
  execFileSync('git', ['config', 'user.email', 'qa@flow.test'], { cwd: dir })
  execFileSync('git', ['config', 'user.name', 'Flow QA'], { cwd: dir })
  writeFileSync(join(dir, 'app.ts'), 'export const version = 1\n')
  execFileSync('git', ['add', '-A'], { cwd: dir })
  execFileSync('git', ['commit', '-q', '-m', 'baseline'], { cwd: dir })
  writeFileSync(join(dir, 'app.ts'), 'export const version = 2\n')
  await activateProject(win, dir)
  return dir
}

async function openReview(win: Page): Promise<void> {
  await win.locator('[data-rail-item="source-control"]').click()
  await win.locator(sel.scViewBtn).filter({ hasText: 'Phases' }).click()
  await expect(win.locator('.fl-review')).toBeAttached()
}

test.afterAll(() => cleanupSeeds())

test('clicking a changed file opens its working-tree diff overlay', async ({ window }) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))
  await seedReviewRepo(window)
  await openReview(window)

  await window.locator('.fl-review-file-name', { hasText: 'app.ts' }).click()
  const overlay = window.locator('.gd-overlay')
  await expect(overlay).toBeVisible({ timeout: 5000 })
  await expect(window.locator('.gd-title')).toHaveText('app.ts')
  await expect(window.locator('.gd-subtitle')).toHaveText('Working tree vs HEAD')
  // The overlay is actually laid out on screen (not a zero-size dead surface).
  const box = await overlay.boundingBox()
  expect(box && box.width > 100 && box.height > 100).toBeTruthy()

  await window.screenshot({ path: `${SCREENS}/revstale-diff-open.png` })
  expect(errors, errors.join(', ')).toHaveLength(0)
})

test(
  'committing away the diffed file should close its now-stale diff overlay (#659)',
  async ({ window }) => {
    const errors: string[] = []
    window.on('pageerror', (e) => errors.push(e.message))
    const dir = await seedReviewRepo(window)
    await openReview(window)

    await window.locator('.fl-review-file-name', { hasText: 'app.ts' }).click()
    const overlay = window.locator('.gd-overlay')
    await expect(overlay).toBeVisible({ timeout: 5000 })

    // Approve + commit the phase — the file is committed away, panel empties.
    const commitBtn = window.locator('.fl-review-commit-btn')
    await commitBtn.click() // "Approve all (0/1)" → approves
    await expect(commitBtn).toContainText('Commit phase')
    await commitBtn.click()
    await expect(window.locator('.fl-review-empty')).toContainText('No changes to review', {
      timeout: 5000,
    })
    const status = execFileSync('git', ['status', '--porcelain'], { cwd: dir }).toString().trim()
    expect(status).toBe('') // commit succeeded, working tree clean

    // DESIRED (#659): the diff for the now-clean file should not linger over the
    // editor contradicting the emptied review list. ACTUAL today: it stays
    // visible, still titled "app.ts — Working tree vs HEAD".
    await window.waitForTimeout(500)
    await window.screenshot({ path: `${SCREENS}/revstale-after-commit.png` })
    await expect(overlay).toBeHidden()
    expect(errors, errors.join(', ')).toHaveLength(0)
  },
)
