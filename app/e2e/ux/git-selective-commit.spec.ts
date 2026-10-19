/**
 * UX journey — Source Control commit SELECTIVITY (multi-file). The Commit button
 * calls `git:commitIndex` (renderer/git/index.ts onCommit), so a commit must
 * include ONLY the staged index and leave every unstaged change untouched — both
 * in the panel and in git.
 *
 * Why this isn't already covered: git-stage-commit.spec stages one file and
 * checks that an UNTRACKED sibling (beta.txt) survives the commit — but an
 * untracked file is never swept into a commit anyway (`git commit -a` skips it),
 * so that test does NOT distinguish index-only commit from commit-all. The real
 * selectivity guard needs a TRACKED, modified, UNSTAGED file: index-only commit
 * leaves it dirty, whereas a `-a` regression would wrongly commit it. This drives
 * two tracked modifications, stages one, commits, and asserts — via the panel AND
 * `git` — that the other stayed out of the commit and remains a working change.
 *
 * Deterministic: the working tree is seeded with the git CLI before the project
 * activates (no editor-save/new-file watcher in the loop), and the post-commit
 * refresh rides the `.git/index` watcher the sibling commit test already relies on.
 */
import { test, expect, type Page } from '../fixtures/electron'
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed'
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

const SHOTS = join(__dirname, '__screens')

function git(dir: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: dir }).toString()
}

/** One commit with two tracked files, then modify BOTH so each is a tracked change. */
function seedTwoTrackedChanges(dir: string): void {
  git(dir, 'config', 'user.email', 'qa@flow.test')
  git(dir, 'config', 'user.name', 'QA Bot')
  writeFileSync(join(dir, 'alpha.txt'), 'alpha base\n')
  writeFileSync(join(dir, 'gamma.txt'), 'gamma base\n')
  git(dir, 'add', 'alpha.txt', 'gamma.txt')
  git(dir, 'commit', '-q', '-m', 'feat: add alpha + gamma')
  writeFileSync(join(dir, 'alpha.txt'), 'alpha base\nALPHA_STAGED_EDIT\n')
  writeFileSync(join(dir, 'gamma.txt'), 'gamma base\nGAMMA_UNSTAGED_EDIT\n')
}

async function panelText(window: Page): Promise<string> {
  return window.locator('.gp-root').innerText()
}

async function expectPanel(window: Page, needle: string): Promise<void> {
  await expect(async () => {
    expect(await panelText(window)).toContain(needle)
  }).toPass({ timeout: 8000 })
}

test.afterAll(() => cleanupSeeds())

test.describe('Source Control commit selectivity', () => {
  test('commits only the staged file; a tracked unstaged change stays out of the commit', async ({
    window,
  }) => {
    const errors: string[] = []
    window.on('pageerror', (e) => errors.push(String(e)))

    const dir = await seedProject(window)
    seedTwoTrackedChanges(dir)
    await activateProject(window, dir)
    await window.locator('.fl-activity-bar .fl-rail-item[aria-label="Source Control"]').click()
    await window.locator('.fl-sc-viewbtn', { hasText: 'Changes' }).click()
    await expect(window.locator('.gp-root')).toBeVisible()

    // Both tracked modifications land under Changes.
    await expectPanel(window, 'CHANGES (2)')

    // Stage alpha only (gamma stays a working change).
    const alphaRow = window
      .locator('.gp-row', { has: window.locator('.gp-name', { hasText: 'alpha.txt' }) })
      .first()
    await alphaRow.locator('.gp-action-btn[title="Stage"]').click()
    await expectPanel(window, 'STAGED CHANGES (1)')
    await expectPanel(window, 'CHANGES (1)')

    // Commit the index.
    await window.locator('.gp-commit-msg').fill('chore: commit alpha only')
    await expect(window.locator('.gp-commit-btn')).toBeEnabled()
    await window.locator('.gp-commit-btn').click()

    // Panel: the staged section clears; gamma remains the sole working change.
    await expect(async () => {
      expect(await panelText(window)).not.toContain('STAGED CHANGES')
    }).toPass({ timeout: 8000 })
    await expectPanel(window, 'CHANGES (1)')
    await expect(window.locator('.gp-name', { hasText: 'gamma.txt' })).toBeVisible()
    await expect(window.locator('.gp-name', { hasText: 'alpha.txt' })).toHaveCount(0)
    await window.screenshot({ path: join(SHOTS, 'git-selective-commit-1.png') })

    // git is the source of truth: the HEAD commit touched ONLY alpha, and gamma
    // is still a modified-but-unstaged working change (never swept in).
    const headFiles = git(dir, 'show', '--name-only', '--format=', 'HEAD').trim()
    expect(headFiles.split('\n').filter(Boolean)).toEqual(['alpha.txt'])
    const status = git(dir, 'status', '--porcelain')
    expect(status).toContain(' M gamma.txt') // unstaged modification survives
    expect(status).not.toContain('alpha.txt') // fully committed, nothing left
    // And gamma's actual edit is still on disk (not reverted).
    expect(execFileSync('cat', [join(dir, 'gamma.txt')]).toString()).toContain('GAMMA_UNSTAGED_EDIT')

    expect(errors).toEqual([])
  })
})
