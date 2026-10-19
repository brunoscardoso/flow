/**
 * UX sweep — flow `git` (rotation index 6): the Git side panel's *states* and
 * live-sync behavior, complementary to `git.spec.ts` (which guards the diff
 * stale-overlay bug #345). Drives the real read-only Git panel against seeded
 * throwaway repos and asserts the expected user experience for:
 *
 *   - the empty repo (git init, no commits, no changes) — clean + "No commits"
 *   - the clean repo (one commit, no working changes) — "Working tree clean"
 *   - opening the INITIAL (root, parentless) commit's whole-commit diff
 *   - a plain working-tree edit (NO git command) surfacing live in CHANGES via
 *     the project file watcher, and an open diff following the file's content (#402)
 *   - the open working-tree diff auto-closing once its file is committed away (#402)
 *
 * All of these are confirmed-healthy today (this cycle's UX sweep found no new
 * user-facing defect in the git flow); the spec locks that behavior in.
 */
import { test, expect, type Page } from '../fixtures/electron'
import { seedProject, activateProject, cleanupSeeds, gitRetry } from './fixtures/seed'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

// Lock-retrying git — the app's status refreshes + provisioning briefly take
// .git/index.lock, so plain execFileSync races them (see fixtures/seed.ts).
const git = gitRetry

/** Configure identity so commits succeed under the throwaway repo. */
function configure(dir: string): void {
  git(dir, 'config', 'user.email', 'qa@flow.test')
  git(dir, 'config', 'user.name', 'QA Bot')
}

/**
 * Monaco's diff editor throws internal cancellation errors to window.onerror
 * whenever its model is swapped or disposed mid-computation — e.g. Esc-closing a
 * diff, or the #402 live-refresh/close on a git status change. They have NO
 * user-visible effect (the overlay opens/closes correctly) and are framework
 * noise, not app defects (confirmed benign in the flow-12 UX sweep). Filter them
 * so this guard still fails on a *real* uncaught app error.
 */
const BENIGN_MONACO = [/^Canceled: Canceled$/, /no diff result available/i]
function appErrors(errors: string[]): string[] {
  return errors.filter((e) => !BENIGN_MONACO.some((re) => re.test(e)))
}

/** Reveal the git panel and wait for it to mount. Post-#674 activity-bar: the
 *  removed `.fl-sidetabs-tab 'Git'` is now the "Source Control" rail item →
 *  "Changes" view. */
async function openGitPanel(window: Page): Promise<void> {
  await window.locator('.fl-activity-bar .fl-rail-item[aria-label="Source Control"]').click()
  await window.locator('.fl-sc-viewbtn', { hasText: 'Changes' }).click()
  await expect(window.locator('.gp-root')).toBeVisible()
}

/** Poll the panel's rendered text until it settles into an expected shape. */
async function expectPanelText(window: Page, needle: string): Promise<void> {
  await expect(async () => {
    expect(await window.locator('.gp-root').innerText()).toContain(needle)
  }).toPass({ timeout: 6000 })
}

test.afterAll(() => cleanupSeeds())

test.describe('git panel states + live sync', () => {
  test('empty repo shows a clean tree and "No commits", never a broken state', async ({
    window,
  }) => {
    const errors: string[] = []
    window.on('pageerror', (e) => errors.push(String(e)))

    const dir = await seedProject(window, 'flow-git-empty-')
    configure(dir) // git init only — no commit, no working change
    await activateProject(window, dir)
    await openGitPanel(window)

    // Branch header renders, tree is clean, and the log is explicitly empty —
    // not a spinner stuck forever or a misleading "No project roots".
    await expectPanelText(window, 'Working tree clean')
    const text = await window.locator('.gp-root').innerText()
    expect(text).toContain('No commits')
    expect(text).not.toContain('No project roots')

    expect(appErrors(errors)).toEqual([])
  })

  test('clean repo (one commit) shows "Working tree clean" and a clickable root commit diff', async ({
    window,
  }) => {
    const errors: string[] = []
    window.on('pageerror', (e) => errors.push(String(e)))

    const dir = await seedProject(window, 'flow-git-clean-')
    configure(dir)
    writeFileSync(join(dir, 'readme.md'), '# hello\n')
    git(dir, 'add', 'readme.md')
    git(dir, 'commit', '-q', '-m', 'chore: initial commit')
    await activateProject(window, dir)
    await openGitPanel(window)

    await expectPanelText(window, 'Working tree clean')

    // The INITIAL (root, parentless) commit is diff-able — clicking it opens the
    // whole-commit diff overlay (its "before" side renders empty, #289).
    await window.locator('.gp-subject', { hasText: 'chore: initial commit' }).click()
    await expect(window.locator('.gd-overlay')).toBeVisible({ timeout: 5000 })
    await expect(window.locator('.gd-title')).toHaveText('chore: initial commit')

    await window.keyboard.press('Escape')
    await expect(window.locator('.gd-overlay')).toBeHidden()

    expect(appErrors(errors)).toEqual([])
  })

  test('a plain working-tree edit surfaces live in CHANGES and the open diff follows it (#402)', async ({
    window,
  }) => {
    const errors: string[] = []
    window.on('pageerror', (e) => errors.push(String(e)))

    const dir = await seedProject(window, 'flow-git-live-')
    configure(dir)
    writeFileSync(join(dir, 'alpha.txt'), 'one\ntwo\n')
    git(dir, 'add', 'alpha.txt')
    git(dir, 'commit', '-q', '-m', 'feat: add alpha')
    await activateProject(window, dir)
    await openGitPanel(window)
    await expectPanelText(window, 'Working tree clean')

    // Plain working-tree edit — NO git command. The project file watcher must pick
    // it up so the CHANGES list populates without any user refresh.
    writeFileSync(join(dir, 'alpha.txt'), 'one EDITED\ntwo\nthree\n')
    await expectPanelText(window, 'CHANGES (1)')
    await expect(window.locator('.gp-name', { hasText: 'alpha.txt' })).toBeVisible()

    // Open the diff; it must reflect the current working tree.
    await window.locator('.gp-name', { hasText: 'alpha.txt' }).first().click()
    await expect(window.locator('.gd-overlay')).toBeVisible({ timeout: 5000 })
    await expect(window.locator('.gd-body')).toContainText('one EDITED')

    // Edit again — the OPEN diff must live-refresh to the new content (#402),
    // never drift into a stale snapshot.
    writeFileSync(join(dir, 'alpha.txt'), 'one EDITED TWICE\ntwo\nthree\nfour\n')
    await expect(window.locator('.gd-body')).toContainText('one EDITED TWICE', { timeout: 6000 })
    expect(await window.locator('.gd-overlay').isVisible()).toBe(true)

    expect(appErrors(errors)).toEqual([])
  })

  test('committing the diffed file away auto-closes its open working-tree diff (#402)', async ({
    window,
  }) => {
    const errors: string[] = []
    window.on('pageerror', (e) => errors.push(String(e)))

    const dir = await seedProject(window, 'flow-git-commitaway-')
    configure(dir)
    writeFileSync(join(dir, 'alpha.txt'), 'one\ntwo\n')
    git(dir, 'add', 'alpha.txt')
    git(dir, 'commit', '-q', '-m', 'feat: add alpha')
    writeFileSync(join(dir, 'alpha.txt'), 'one CHANGED\ntwo\nthree\n')
    await activateProject(window, dir)
    await openGitPanel(window)
    await expectPanelText(window, 'CHANGES (1)')

    // Open the working-tree diff for the changed file.
    await window.locator('.gp-name', { hasText: 'alpha.txt' }).first().click()
    await expect(window.locator('.gd-overlay')).toBeVisible({ timeout: 5000 })

    // Commit the file away — it leaves the CHANGES list, so its now-phantom diff
    // must close rather than keep showing a diff that no longer exists (#402).
    git(dir, 'add', '-A')
    git(dir, 'commit', '-q', '-m', 'chore: commit alpha')
    await expectPanelText(window, 'Working tree clean')
    await expect(window.locator('.gd-overlay')).toBeHidden({ timeout: 6000 })

    expect(appErrors(errors)).toEqual([])
  })
})
