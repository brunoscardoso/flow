import { test, expect } from '../fixtures/electron'
import { sel } from '../selectors'
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed'
import { execFileSync } from 'node:child_process'
import { chmodSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'

/**
 * UX sweep — flow 5 (Review): "feedback on failure" for Commit phase.
 *
 * The Review panel commits an approved phase via git:commitIndex → real
 * `git commit -m …` (git-manager.ts). Real repos routinely install a blocking
 * pre-commit hook (lint/format/tests) that exits non-zero and aborts the commit
 * — a genuine, account-independent failure a real user hits. On that failure the
 * coordinator (renderer/review/index.ts commitGroup catch, #73) must:
 *   1. surface a "Commit failed" toast (not fail silently / console-only),
 *   2. keep the change in the review list (no false empty state),
 *   3. preserve the approvals + typed message for retry.
 */

const SCREENS = 'e2e/ux/__screens'

/** Seed a committed baseline + one modified tracked file, and install a
 *  pre-commit hook that always aborts the commit (exit 1). */
async function seedRepoWithBlockingHook(win: Page): Promise<string> {
  const dir = await seedProject(win, 'flow-ux-commitfail-')
  execFileSync('git', ['config', 'user.email', 'qa@flow.test'], { cwd: dir })
  execFileSync('git', ['config', 'user.name', 'Flow QA'], { cwd: dir })
  writeFileSync(join(dir, 'app.ts'), 'export const version = 1\n')
  execFileSync('git', ['add', '-A'], { cwd: dir })
  execFileSync('git', ['commit', '-q', '-m', 'baseline'], { cwd: dir })
  // The working-tree change to review.
  writeFileSync(join(dir, 'app.ts'), 'export const version = 2\n')
  // A blocking pre-commit hook — the realistic cause of a commit failure.
  const hook = join(dir, '.git', 'hooks', 'pre-commit')
  writeFileSync(hook, '#!/bin/sh\necho "blocked by pre-commit hook" >&2\nexit 1\n')
  chmodSync(hook, 0o755)
  await activateProject(win, dir)
  return dir
}

/** Reach review the way a real user does (post #663/#664): activity-bar rail's
 *  source-control item, then the Phases view-mode button. */
async function openReview(win: Page): Promise<void> {
  await win.locator('[data-rail-item="source-control"]').click()
  await win.locator(sel.scViewBtn).filter({ hasText: 'Phases' }).click()
  await expect(win.locator('.fl-review')).toBeAttached()
}

test.afterAll(() => cleanupSeeds())

test('commit blocked by a pre-commit hook surfaces a "Commit failed" toast and keeps the change', async ({
  window,
}) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  const dir = await seedRepoWithBlockingHook(window)
  await openReview(window)

  await expect(window.locator('.fl-review-file')).toHaveCount(1)

  // Approve the file, then commit — the hook will abort the git commit.
  const commitBtn = window.locator('.fl-review-commit-btn')
  await expect(commitBtn).toContainText('Approve all (0/1)')
  await commitBtn.click()
  await expect(commitBtn).toContainText('Commit phase')
  const message = window.locator('.fl-review-message').first()
  await message.fill('feat: change that the hook will block')
  await expect(commitBtn).toBeEnabled()
  await commitBtn.click()

  // 1. Feedback on failure: a "Commit failed" toast must appear (not silent).
  const toast = window.locator('.fl-flow-toast').filter({ hasText: 'Commit failed' })
  await expect(toast).toBeVisible({ timeout: 5000 })

  // 2. The change must NOT be falsely cleared — the commit did not happen.
  await expect(window.locator('.fl-review-empty')).toHaveCount(0)
  await expect(window.locator('.fl-review-file')).toHaveCount(1)
  // And git agrees the commit never landed: the change is still present (the
  // flow stages then commits, so the blocked commit leaves it staged) and HEAD
  // is still the baseline — no new commit was created.
  const status = execFileSync('git', ['status', '--porcelain'], { cwd: dir }).toString().trim()
  expect(status).toContain('app.ts')
  const head = execFileSync('git', ['log', '-1', '--format=%s'], { cwd: dir }).toString().trim()
  expect(head).toBe('baseline')

  // 3. The typed message survives for a retry.
  await expect(window.locator('.fl-review-message').first()).toHaveValue(
    'feat: change that the hook will block',
  )

  await window.screenshot({ path: `${SCREENS}/review-commit-fail.png` })
  expect(errors, errors.join(', ')).toHaveLength(0)
})
