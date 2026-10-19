import { test, expect } from '../fixtures/electron'
import { sel } from '../selectors'
import { activateProject, cleanupSeeds } from './fixtures/seed'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from '@playwright/test'

/**
 * UX sweep — flow 5 (Review): rejecting a file when NO thread is selected.
 *
 * The ✕ (Reject) action reverts the file to HEAD *and* dispatches a
 * `flow:agent-redo` asking the active thread's agent to redo it. On a project
 * with no active thread (a freshly-opened repo whose working tree already has
 * uncommitted edits — before any conversation), an unguarded reject would revert
 * the file (uncommitted work lost) with no redo and no feedback.
 *
 * Filed and FIXED as #397: `rejectGuard` now refuses BEFORE reverting when no
 * thread is active, preserving the edit and surfacing a "No active thread"
 * notice. These specs are the end-to-end regression guard for that fix.
 */

const SCREENS = 'e2e/ux/__screens'

/**
 * Seed a repo with one committed baseline + one modified tracked file, no thread.
 * The repo is built and committed BEFORE it's added as a project root, so the
 * app's git watcher can never race the baseline commit for `.git/index.lock`.
 */
async function seedReviewRepo(win: Page): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'flow-ux-reject-'))
  execFileSync('git', ['init', '-q'], { cwd: dir })
  // Keep the IDE's provisioning scaffold out of `git status` (as seed.ts does)
  // — the assertion below is about the user's own edit.
  writeFileSync(
    join(dir, '.git', 'info', 'exclude'),
    '.claude/\nflow\n.gitignore\nloops/\nflow.pre-workspace*\nCLAUDE.md\ngraphify-out/\n',
  )
  execFileSync('git', ['config', 'user.email', 'qa@flow.test'], { cwd: dir })
  execFileSync('git', ['config', 'user.name', 'Flow QA'], { cwd: dir })
  writeFileSync(join(dir, 'app.ts'), 'export const version = 1\n')
  execFileSync('git', ['add', '-A'], { cwd: dir })
  execFileSync('git', ['commit', '-q', '-m', 'baseline'], { cwd: dir })
  // The uncommitted edit under review — the "precious work" #397 must not drop.
  writeFileSync(join(dir, 'app.ts'), 'export const version = 2 // my precious edit\n')
  await win.evaluate(async (p) => {
    await (
      window as unknown as {
        flow: { project: { add(r: { path: string }): Promise<unknown> } }
      }
    ).flow.project.add({ path: p })
  }, dir)
  await activateProject(win, dir)
  return dir
}

/** Open Source Control → Phases (the folded-in review, #335). */
async function openReview(win: Page): Promise<void> {
  await win.locator('[data-rail-item="source-control"]').click()
  await win.locator(sel.scViewBtn).filter({ hasText: 'Phases' }).click()
  await expect(win.locator('.fl-review')).toBeAttached()
}

test.afterAll(() => cleanupSeeds())

test('reject: the ✕ reaches an inline feedback prompt with a Redo action', async ({ window }) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  await seedReviewRepo(window)
  await openReview(window)

  await window.locator('.fl-review-file').first().locator('.fl-review-reject').click()
  const prompt = window.locator('.fl-review-reject-prompt')
  await expect(prompt).toBeVisible()
  await expect(prompt.locator('input')).toBeFocused()
  await prompt.locator('input').fill('please redo this properly')
  await expect(prompt.locator('.fl-review-commit-btn', { hasText: 'Redo' })).toBeVisible()
  // #697: the prompt now also offers a non-destructive Cancel alongside Redo.
  await expect(prompt.locator('.fl-review-commit-btn', { hasText: 'Cancel' })).toBeVisible()

  expect(errors, errors.join(', ')).toHaveLength(0)
})

/**
 * #397 (FIXED) — rejecting with no active thread must NOT silently revert the
 * uncommitted edit. The guard refuses before reverting and tells the user why.
 * This asserts the shipped behavior: the working-tree edit survives AND a
 * "No active thread" notice is surfaced.
 */
test('#397 reject with no thread preserves the edit and surfaces feedback', async ({ window }) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  const dir = await seedReviewRepo(window)
  await openReview(window)

  await window.locator('.fl-review-file').first().locator('.fl-review-reject').click()
  const prompt = window.locator('.fl-review-reject-prompt')
  await expect(prompt).toBeVisible()
  await prompt.locator('input').fill('please redo this properly')
  await prompt.locator('.fl-review-commit-btn', { hasText: 'Redo' }).click()
  await window.waitForTimeout(1200)

  // The uncommitted edit must still be there — nothing was reverted.
  const status = execFileSync('git', ['status', '--porcelain'], { cwd: dir }).toString().trim()
  expect(status).toBe('M app.ts')
  expect(
    execFileSync('git', ['diff', '--', 'app.ts'], { cwd: dir }).toString(),
  ).toContain('my precious edit')

  // …and the user was told why the redo couldn't be requested (not silent).
  await expect(window.getByText('No active thread', { exact: false }).first()).toBeVisible()

  await window.screenshot({ path: `${SCREENS}/review-reject-nothread.png` })
  expect(errors, errors.join(', ')).toHaveLength(0)
})
