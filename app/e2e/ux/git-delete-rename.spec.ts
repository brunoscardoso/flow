/**
 * UX sweep — flow `git` (rotation index 6), round 14: the two working-tree
 * shapes NO prior git probe drives — a DELETED tracked file and a RENAMED
 * (`git mv`) one.
 *
 * Every existing git spec exercises modified / added / untracked / staged /
 * conflicted rows (git-states, git-stage-commit, git-staged-diff,
 * git-untracked-expand, git-selective-commit, git-unstage-bulk, merge/rebase
 * specs). Deletion and rename are ordinary user actions (delete a file in the
 * editor or Finder, `git mv` in the terminal) that take DIFFERENT code paths:
 * porcelain v2 emits deletions as `1 .D`/`1 D.` and renames as a two-field `2 …`
 * record whose ORIGINAL path is a separate NUL-terminated token, and the diff
 * for a deleted file has a MISSING working-tree side.
 *
 * What a user must be able to do, and what this asserts end-to-end:
 *   1. see a deleted file in CHANGES, open its diff (old content on the before
 *      side, empty after side — a pure removal, not a broken/blank overlay),
 *      stage it, and commit the deletion away
 *   2. recover from an accidental delete via the row's Discard action — the file
 *      comes back on disk and the row clears
 *   3. see a `git mv` as ONE staged rename row under the NEW name, with no
 *      phantom row for the old path, and open its diff
 */
import { test, expect, type Page } from '../fixtures/electron'
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const SHOTS = join(__dirname, '__screens')

/** The app refreshes `git status` continuously, which takes `.git/index.lock` — a
 *  test-side write (`git mv`, `git rm`) can collide with it. Retry briefly: this is
 *  a harness race against our own polling, not a product defect. */
function git(dir: string, ...args: string[]): string {
  let lastError: unknown
  for (let attempt = 0; attempt < 25; attempt += 1) {
    try {
      return execFileSync('git', args, { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] }).toString()
    } catch (error) {
      lastError = error
      if (!String((error as { stderr?: Buffer }).stderr ?? '').includes('index.lock')) throw error
      execFileSync('sleep', ['0.2'])
    }
  }
  throw lastError
}

function configure(dir: string): void {
  git(dir, 'config', 'user.email', 'qa@flow.test')
  git(dir, 'config', 'user.name', 'QA Bot')
}

/**
 * Monaco's diff editor throws internal cancellation errors to window.onerror
 * when its model is swapped/disposed mid-computation (overlay open/close). They
 * have no user-visible effect — filter them so this guard still fails on a real
 * uncaught app error. Same list as git-states.spec.ts.
 */
const BENIGN_MONACO = [/^Canceled: Canceled$/, /no diff result available/i]
function appErrors(errors: string[]): string[] {
  return errors.filter((e) => !BENIGN_MONACO.some((re) => re.test(e)))
}

async function openGitPanel(window: Page): Promise<void> {
  await window.locator('.fl-activity-bar .fl-rail-item[aria-label="Source Control"]').click()
  await window.locator('.fl-sc-viewbtn', { hasText: 'Changes' }).click()
  await expect(window.locator('.gp-root')).toBeVisible()
}

async function expectPanelText(window: Page, needle: string): Promise<void> {
  await expect(async () => {
    expect(await window.locator('.gp-root').innerText()).toContain(needle)
  }).toPass({ timeout: 15000 })
}

/** Repo with two committed files; returns the seeded dir. */
async function seedTwoFileRepo(window: Page, prefix: string): Promise<string> {
  const dir = await seedProject(window, prefix)
  configure(dir)
  writeFileSync(join(dir, 'alpha.txt'), 'alpha one\nalpha two\nalpha three\n')
  writeFileSync(join(dir, 'keep.txt'), 'untouched\n')
  git(dir, 'add', 'alpha.txt', 'keep.txt')
  git(dir, 'commit', '-q', '-m', 'feat: seed alpha + keep')
  return dir
}

test.afterAll(() => cleanupSeeds())

test.describe('git deleted + renamed files', () => {
  test('a deleted tracked file diffs as a pure removal and stages + commits away', async ({
    window,
  }) => {
    const errors: string[] = []
    window.on('pageerror', (e) => errors.push(String(e)))

    const dir = await seedTwoFileRepo(window, 'flow-git-del-')
    await activateProject(window, dir)
    await openGitPanel(window)
    await expectPanelText(window, 'Working tree clean')

    // Plain filesystem delete — exactly what "Delete" in the file tree or Finder
    // does. The watcher must surface it in CHANGES with no git command run.
    rmSync(join(dir, 'alpha.txt'))
    await expectPanelText(window, 'CHANGES (1)')
    await expect(window.locator('.gp-name', { hasText: 'alpha.txt' })).toBeVisible()

    // Its diff opens and shows the REMOVED content (before side) — not a blank
    // overlay, not an error toast. The file no longer exists on disk, so the
    // after side is empty and this renders as a pure deletion.
    await window.locator('.gp-name', { hasText: 'alpha.txt' }).first().click()
    await expect(window.locator('.gd-overlay')).toBeVisible({ timeout: 12000 })
    await expect(window.locator('.gd-body')).toContainText('alpha two', { timeout: 12000 })
    await window.screenshot({ path: join(SHOTS, 'git-del-1-diff.png') })

    // Stage the deletion via the row's inline (+) — it must move to Staged.
    const row = window
      .locator('.gp-row', { has: window.locator('.gp-name', { hasText: 'alpha.txt' }) })
      .first()
    await row.locator('.gp-action-btn[title="Stage"]').click()
    await expectPanelText(window, 'STAGED CHANGES (1)')

    // Commit the deletion: panel returns to clean and the file is gone at HEAD.
    await window.locator('.gp-commit-msg').fill('chore: remove alpha')
    await expect(window.locator('.gp-commit-btn')).toBeEnabled()
    await window.locator('.gp-commit-btn').click()

    await expectPanelText(window, 'Working tree clean')
    expect(git(dir, 'ls-files')).not.toContain('alpha.txt')
    expect(git(dir, 'ls-files')).toContain('keep.txt')
    await window.screenshot({ path: join(SHOTS, 'git-del-2-committed.png') })

    expect(appErrors(errors)).toEqual([])
  })

  test('Discard on a deleted file restores it to disk and clears the row', async ({ window }) => {
    const errors: string[] = []
    window.on('pageerror', (e) => errors.push(String(e)))
    window.on('dialog', (d) => void d.accept()) // Discard confirms via window.confirm

    const dir = await seedTwoFileRepo(window, 'flow-git-delundo-')
    await activateProject(window, dir)
    await openGitPanel(window)
    await expectPanelText(window, 'Working tree clean')

    rmSync(join(dir, 'alpha.txt'))
    await expectPanelText(window, 'CHANGES (1)')

    // The user's undo path for an accidental delete.
    const row = window
      .locator('.gp-row', { has: window.locator('.gp-name', { hasText: 'alpha.txt' }) })
      .first()
    await row.locator('.gp-action-btn[title="Discard changes"]').click()

    await expectPanelText(window, 'Working tree clean')
    await expect(window.locator('.gp-name', { hasText: 'alpha.txt' })).toHaveCount(0)
    expect(existsSync(join(dir, 'alpha.txt'))).toBe(true)
    expect(readFileSync(join(dir, 'alpha.txt'), 'utf8')).toContain('alpha two')
    await window.screenshot({ path: join(SHOTS, 'git-del-3-restored.png') })

    expect(appErrors(errors)).toEqual([])
  })

  test('a `git mv` rename shows as one staged row under the new name, and its diff opens', async ({
    window,
  }) => {
    const errors: string[] = []
    window.on('pageerror', (e) => errors.push(String(e)))

    const dir = await seedTwoFileRepo(window, 'flow-git-mv-')
    await activateProject(window, dir)
    await openGitPanel(window)
    await expectPanelText(window, 'Working tree clean')

    // Rename in the terminal — porcelain v2 reports this as a `2 R.` record whose
    // ORIGINAL path is an extra NUL-separated field. A parser that mis-consumes
    // that field would either drop the row or invent a phantom one.
    git(dir, 'mv', 'alpha.txt', 'renamed.txt')
    await expectPanelText(window, 'STAGED CHANGES (1)')

    // Exactly one row, under the NEW name; the old path must not linger.
    await expect(window.locator('.gp-name', { hasText: 'renamed.txt' })).toHaveCount(1)
    await expect(window.locator('.gp-name', { hasText: /^alpha\.txt$/ })).toHaveCount(0)
    await window.screenshot({ path: join(SHOTS, 'git-mv-1-renamed.png') })

    // Its diff opens with the file's content — not an empty/broken overlay.
    await window.locator('.gp-name', { hasText: 'renamed.txt' }).first().click()
    await expect(window.locator('.gd-overlay')).toBeVisible({ timeout: 12000 })
    await expect(window.locator('.gd-body')).toContainText('alpha two', { timeout: 12000 })
    await window.screenshot({ path: join(SHOTS, 'git-mv-2-diff.png') })

    expect(appErrors(errors)).toEqual([])
  })
})
