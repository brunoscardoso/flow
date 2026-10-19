import { test, expect, type Page } from '../fixtures/electron'
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed'
import { execFileSync } from 'node:child_process'
import { chmodSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * UX sweep — flow `git` (rotation index 6): "feedback on failure" for the
 * Source-Control **commit box** (#335), the git-panel analog of the Review
 * commit-fail surface (#73/#724, review-commit-fail-feedback.spec.ts).
 *
 * The commit box commits the staged index via git:commitIndex → real
 * `git commit -m …` (git-manager.ts:582), which runs the repo's pre-commit
 * hook. Real repos routinely install a blocking hook (lint/format/tests) that
 * exits non-zero and aborts the commit — an account-independent failure a real
 * user hits. On that failure the git coordinator (renderer/git/index.ts
 * onCommit catch, ~276-280) must:
 *   1. surface a "Couldn't commit" toast (not fail silently / console-only),
 *   2. keep the file STAGED (the user explicitly staged it; commit never ran),
 *   3. preserve the typed draft in the commit box for a retry,
 *   4. leave the Commit button re-enabled so the retry is actually possible,
 *   5. leave HEAD at the baseline (no commit landed), with no pageerror.
 */

const SCREENS = 'e2e/ux/__screens'

function git(dir: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: dir }).toString()
}

/** Committed baseline + one modified tracked file + a pre-commit hook that
 *  always aborts the commit (exit 1). All git runs inside `prepare` — BEFORE
 *  the root is added — so the app's own git activity (status refreshes,
 *  provisioning) can't race the seed on index.lock. */
async function seedRepoWithBlockingHook(win: Page): Promise<string> {
  const dir = await seedProject(win, 'flow-ux-gitcommitfail-', (d) => {
    git(d, 'config', 'user.email', 'qa@flow.test')
    git(d, 'config', 'user.name', 'Flow QA')
    writeFileSync(join(d, 'app.ts'), 'export const version = 1\n')
    git(d, 'add', '-A')
    git(d, 'commit', '-q', '-m', 'baseline')
    // The working-tree change to stage + commit.
    writeFileSync(join(d, 'app.ts'), 'export const version = 2\n')
    // A blocking pre-commit hook — the realistic cause of a commit failure.
    const hook = join(d, '.git', 'hooks', 'pre-commit')
    writeFileSync(hook, '#!/bin/sh\necho "blocked by pre-commit hook" >&2\nexit 1\n')
    chmodSync(hook, 0o755)
  })
  await activateProject(win, dir)
  return dir
}

/** Reveal Source Control → Changes and wait for the git panel to mount + load. */
async function openGitPanel(win: Page): Promise<void> {
  await win.locator('.fl-activity-bar .fl-rail-item[aria-label="Source Control"]').click()
  await win.locator('.fl-sc-viewbtn', { hasText: 'Changes' }).click()
  await expect(win.locator('.gp-root')).toBeVisible()
  await expect(async () => {
    expect(await win.locator('.gp-name').count()).toBeGreaterThan(0)
  }).toPass({ timeout: 6000 })
}

async function panelText(win: Page): Promise<string> {
  return win.locator('.gp-root').innerText()
}

test.afterAll(() => cleanupSeeds())

test('commit box blocked by a pre-commit hook surfaces a "Couldn\'t commit" toast and preserves the draft (#335)', async ({
  window,
}) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  const dir = await seedRepoWithBlockingHook(window)
  await openGitPanel(window)

  // One working-tree change under Changes.
  await expect(async () => {
    expect(await panelText(window)).toContain('CHANGES (1)')
  }).toPass({ timeout: 8000 })

  // Stage app.ts via its inline (+) button → it moves to Staged Changes.
  const appRow = window
    .locator('.gp-row', { has: window.locator('.gp-name', { hasText: 'app.ts' }) })
    .first()
  await appRow.locator('.gp-action-btn[title="Stage"]').click()
  await expect(async () => {
    expect(await panelText(window)).toContain('STAGED CHANGES (1)')
  }).toPass({ timeout: 8000 })

  // Type a message; Commit enables; commit — the hook aborts it.
  const msg = window.locator('.gp-commit-msg')
  await msg.fill('feat: change the hook will block')
  const commitBtn = window.locator('.gp-commit-btn')
  await expect(commitBtn).toBeEnabled()
  await commitBtn.click()

  // 1. Feedback on failure: a "Couldn't commit" toast must appear (not silent).
  const toast = window.locator('.fl-flow-toast').filter({ hasText: "Couldn't commit" })
  await expect(toast).toBeVisible({ timeout: 5000 })
  await window.screenshot({ path: `${SCREENS}/git-commit-fail.png` })

  // 2. The file stays STAGED — the commit never ran, no false "clean" state.
  await expect(async () => {
    expect(await panelText(window)).toContain('STAGED CHANGES (1)')
  }).toPass({ timeout: 8000 })
  expect(await panelText(window)).not.toContain('Working tree clean')

  // 3. The typed draft survives for a retry (not cleared like the success path).
  await expect(window.locator('.gp-commit-msg')).toHaveValue('feat: change the hook will block')

  // 4. The Commit button is re-enabled so the retry is actually possible.
  await expect(commitBtn).toBeEnabled()

  // 5. git agrees the commit never landed: HEAD is still the baseline.
  const head = git(dir, 'log', '-1', '--format=%s').trim()
  expect(head).toBe('baseline')

  expect(errors, errors.join(', ')).toHaveLength(0)
})
