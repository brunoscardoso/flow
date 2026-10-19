/**
 * UX sweep — flow `git` (rotation index 6, round 9): the COMMITS section's
 * history browser, specifically clicking a **non-root** commit (one that HAS a
 * parent) to review what it actually changed.
 *
 * Why this is un-probed: git-states.spec.ts already covers clicking the INITIAL
 * (root, parentless) commit — but that path is special: the "before" side
 * resolves against a nonexistent parent and renders EMPTY (#289). The real
 * payoff of the history section is browsing an ordinary commit: the whole-commit
 * diff must show the file's genuine BEFORE snapshot next to its AFTER snapshot.
 *
 * That before side goes through a distinct git-manager path —
 * `git show <commit>^:<path>` (git-manager.ts wholeCommitDiff ~1096) — which the
 * root-commit test never exercises. If it were broken, a user reviewing history
 * would see a diff with no "before" content (as if every historical commit added
 * everything from scratch), silently misrepresenting what changed.
 *
 * Non-vacuous assertion: the seed removes a line ("remove-me", present ONLY in
 * the parent) and adds a line ("add-me-now", present ONLY in the commit). The
 * whole-commit diff body must contain BOTH — "remove-me" proves the parent
 * (before) snapshot loaded; "add-me-now" proves the commit (after) snapshot did.
 *
 * Confirmed-healthy this cycle (no user-facing defect found); the spec locks it in.
 */
import { test, expect, type Page } from '../fixtures/electron'
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed'
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

function git(dir: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: dir }).toString()
}

/** Configure identity so commits succeed under the throwaway repo. */
function configure(dir: string): void {
  git(dir, 'config', 'user.email', 'qa@flow.test')
  git(dir, 'config', 'user.name', 'QA Bot')
}

/**
 * Monaco's diff editor throws internal cancellation errors to window.onerror
 * whenever its model is swapped or disposed mid-computation (e.g. Esc-closing the
 * overlay). No user-visible effect — framework noise, not app defects. Filter
 * them so this guard still fails on a *real* uncaught app error.
 */
const BENIGN_MONACO = [/^Canceled: Canceled$/, /no diff result available/i]
function appErrors(errors: string[]): string[] {
  return errors.filter((e) => !BENIGN_MONACO.some((re) => re.test(e)))
}

/** Reveal the git panel and wait for it to mount (post-#674 activity-bar). */
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

test.describe('git commit-history diff', () => {
  test('clicking a non-root commit opens its whole-commit diff with real before + after content', async ({
    window,
  }) => {
    const errors: string[] = []
    window.on('pageerror', (e) => errors.push(String(e)))

    const dir = await seedProject(window, 'flow-git-history-')
    configure(dir)

    // Parent commit: a file with a line that the NEXT commit will delete.
    writeFileSync(join(dir, 'alpha.txt'), 'keep-line\nremove-me\n')
    git(dir, 'add', 'alpha.txt')
    git(dir, 'commit', '-q', '-m', 'feat: seed alpha')

    // Non-root commit: delete "remove-me", add "add-me-now". Reviewing THIS
    // commit must show both sides — the parent snapshot (before) and this one
    // (after) — not an empty before as the root commit would.
    writeFileSync(join(dir, 'alpha.txt'), 'keep-line\nadd-me-now\n')
    git(dir, 'add', 'alpha.txt')
    git(dir, 'commit', '-q', '-m', 'feat: rework alpha')

    await activateProject(window, dir)
    await openGitPanel(window)

    // Clean tree, and BOTH commits present in the history section. The COMMITS
    // rows render inside the fl-list's OPEN shadow DOM (invisible to .gp-root
    // innerText), so assert the header count via panel text but the commit
    // subjects via shadow-piercing .gp-subject locators.
    await expectPanelText(window, 'Working tree clean')
    await expectPanelText(window, 'COMMITS (2)')
    await expect(window.locator('.gp-subject', { hasText: 'feat: rework alpha' })).toBeVisible()
    await expect(window.locator('.gp-subject', { hasText: 'feat: seed alpha' })).toBeVisible()

    // Click the non-root commit → whole-commit diff overlay opens, titled by it.
    await window.locator('.gp-subject', { hasText: 'feat: rework alpha' }).click()
    await expect(window.locator('.gd-overlay')).toBeVisible({ timeout: 5000 })
    await expect(window.locator('.gd-title')).toHaveText('feat: rework alpha')

    // The payoff: the diff shows the file's real BEFORE (parent) content next to
    // its AFTER content. "remove-me" exists ONLY in the parent → its presence
    // proves `git show <commit>^:alpha.txt` (the before side) loaded; "add-me-now"
    // exists ONLY in this commit → proves the after side loaded. A broken before
    // path would drop "remove-me" entirely.
    const body = window.locator('.gd-body')
    await expect(body).toContainText('remove-me', { timeout: 6000 })
    await expect(body).toContainText('add-me-now', { timeout: 6000 })

    await window.keyboard.press('Escape')
    await expect(window.locator('.gd-overlay')).toBeHidden()

    expect(appErrors(errors)).toEqual([])
  })
})
