import { test, expect, type Page } from '../fixtures/electron'
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed'
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * A partially-staged file (staged, then re-edited in the working tree — porcelain
 * "MM") appears in BOTH the Staged Changes and Changes sections. Clicking it in
 * Staged Changes must show the STAGED diff (HEAD vs index = what the commit will
 * contain), while clicking it in Changes shows the working-tree diff. Before this
 * fix both opened the working-tree diff, so the Staged row leaked the later
 * unstaged edit — the same class of bug as the #694 AI-commit-message fix.
 */
function git(dir: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: dir }).toString()
}

/** A repo with one file that is STAGED at v1 and then re-edited to v2 (MM).
 *  All git runs inside `prepare` — BEFORE the root is added — so the app's own
 *  git activity (status refreshes, provisioning) can't race it on index.lock. */
async function seedPartiallyStaged(win: Page): Promise<string> {
  const dir = await seedProject(win, 'flow-git-staged-diff-', (d) => {
    git(d, 'config', 'user.email', 'qa@flow.test')
    git(d, 'config', 'user.name', 'QA Bot')
    writeFileSync(join(d, 'alpha.txt'), 'v0\n')
    git(d, 'add', '-A')
    git(d, 'commit', '-m', 'v0')
    writeFileSync(join(d, 'alpha.txt'), 'v0\nSTAGED_v1\n') // stage this
    git(d, 'add', 'alpha.txt')
    writeFileSync(join(d, 'alpha.txt'), 'v0\nSTAGED_v1\nUNSTAGED_v2\n') // worktree only
  })
  await activateProject(win, dir)
  return dir
}

async function openGitPanel(win: Page): Promise<void> {
  await win.locator('.fl-activity-bar .fl-rail-item[aria-label="Source Control"]').click()
  await win.locator('.fl-sc-viewbtn', { hasText: 'Changes' }).click()
  await expect(win.locator('.gp-root')).toBeVisible()
  await expect(async () => {
    expect(await win.locator('.gp-name').count()).toBeGreaterThan(0)
  }).toPass({ timeout: 5000 })
}

/** The alpha.txt row inside a given section's list (data-section on the fl-list). */
function sectionRow(win: Page, section: 'staged' | 'changes') {
  return win
    .locator(`[data-section="${section}"] .gp-row`, {
      has: win.locator('.gp-name', { hasText: 'alpha.txt' }),
    })
    .first()
}

test.afterAll(() => cleanupSeeds())

test('a partially-staged file shows the STAGED diff in Staged Changes, working-tree in Changes (#694)', async ({
  window,
}) => {
  await seedPartiallyStaged(window)
  await openGitPanel(window)

  // The file is in BOTH sections (MM).
  await expect(sectionRow(window, 'staged')).toBeVisible()
  await expect(sectionRow(window, 'changes')).toBeVisible()

  // Staged Changes → the STAGED diff: contains the staged line, NOT the later
  // unstaged edit (what a commit would actually include).
  await sectionRow(window, 'staged').click()
  await expect(window.locator('.gd-overlay')).toBeVisible({ timeout: 5000 })
  await expect(window.locator('.gd-subtitle')).toHaveText('Staged vs HEAD')
  await expect(window.locator('.gd-body')).toContainText('STAGED_v1')
  await expect(window.locator('.gd-body')).not.toContainText('UNSTAGED_v2')

  // Changes → the working-tree diff: includes the unstaged edit.
  await sectionRow(window, 'changes').click()
  await expect(window.locator('.gd-subtitle')).toHaveText('Working tree vs HEAD')
  await expect(window.locator('.gd-body')).toContainText('UNSTAGED_v2')
})

/** A repo with a NEW file staged as an addition (only in Staged Changes).
 *  Seeded inside `prepare` (pre-addRoot) to dodge index.lock races — see above. */
async function seedStagedAddition(win: Page): Promise<string> {
  const dir = await seedProject(win, 'flow-git-staged-add-', (d) => {
    git(d, 'config', 'user.email', 'qa@flow.test')
    git(d, 'config', 'user.name', 'QA Bot')
    writeFileSync(join(d, 'base.txt'), 'base\n')
    git(d, 'add', '-A')
    git(d, 'commit', '-m', 'base')
    writeFileSync(join(d, 'beta.txt'), 'ADDED_CONTENT\n')
    git(d, 'add', 'beta.txt') // staged addition, no worktree remainder
  })
  await activateProject(win, dir)
  return dir
}

test('a newly-staged (added) file opens the STAGED diff in Staged Changes', async ({ window }) => {
  await seedStagedAddition(window)
  await openGitPanel(window)

  // A staged addition lives only in Staged Changes.
  const row = window
    .locator('[data-section="staged"] .gp-row', {
      has: window.locator('.gp-name', { hasText: 'beta.txt' }),
    })
    .first()
  await expect(row).toBeVisible()

  // Clicking it opens the staged (index-vs-HEAD) diff — an addition: empty before,
  // the staged content after.
  await row.click()
  await expect(window.locator('.gd-overlay')).toBeVisible({ timeout: 5000 })
  await expect(window.locator('.gd-subtitle')).toHaveText('Staged vs HEAD')
  await expect(window.locator('.gd-body')).toContainText('ADDED_CONTENT')
})
