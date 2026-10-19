/**
 * UX sweep — flow `git` (rotation index 6), round 6: the previously un-probed
 * UNSTAGE (per-file + bulk "Unstage all") and bulk "Approve all" / "Revert all"
 * section-header actions on the unified Source Control panel (#335). The
 * stage/commit/discard lifecycle is guarded by git-stage-commit.spec.ts; this
 * locks in the staged-section round trip a real user performs.
 *
 * This cycle's UX sweep drove all of these and found NO new user-facing defect —
 * unstage round-trips correctly, the commit-message draft survives an Unstage all
 * (with the Commit button re-disabling), and Revert all cleans the tree AND the
 * panel to "Working tree clean". This spec guards that healthy behavior.
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
function configure(dir: string): void {
  git(dir, 'config', 'user.email', 'qa@flow.test')
  git(dir, 'config', 'user.name', 'QA Bot')
}
function populateRepo(dir: string): void {
  configure(dir)
  writeFileSync(join(dir, 'alpha.txt'), 'first line\nsecond line\n')
  git(dir, 'add', 'alpha.txt')
  git(dir, 'commit', '-q', '-m', 'feat: add alpha')
  writeFileSync(join(dir, 'alpha.txt'), 'first line CHANGED\nsecond line\nthird\n')
  writeFileSync(join(dir, 'beta.txt'), 'brand new untracked file\n')
}
async function openGitPanel(window: Page): Promise<string> {
  // Populate inside `prepare` (pre-addRoot) so the app's own git activity
  // (status refreshes, provisioning) can't race the seed on index.lock.
  const dir = await seedProject(window, undefined, populateRepo)
  await activateProject(window, dir)
  // Post-#674 activity-bar rail opener (was the removed `.fl-sidetabs-tab`).
  await window.locator('.fl-activity-bar .fl-rail-item[aria-label="Source Control"]').click()
  await window.locator('.fl-sc-viewbtn', { hasText: 'Changes' }).click()
  await expect(window.locator('.gp-root')).toBeVisible()
  await expect(async () => {
    expect(await window.locator('.gp-name').count()).toBeGreaterThan(0)
  }).toPass({ timeout: 6000 })
  return dir
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

test.describe('git unstage + bulk actions', () => {
  test('a staged file can be unstaged and returns to Changes', async ({ window }) => {
    const errors: string[] = []
    window.on('pageerror', (e) => errors.push(String(e)))

    await openGitPanel(window)
    await expectPanel(window, 'CHANGES (2)')

    // Stage alpha via its inline (+) button.
    const alphaRow = window
      .locator('.gp-row', { has: window.locator('.gp-name', { hasText: 'alpha.txt' }) })
      .first()
    await alphaRow.locator('.gp-action-btn[title="Stage"]').click()
    await expectPanel(window, 'STAGED CHANGES (1)')
    await window.screenshot({ path: join(SHOTS, 'git-unstage-1-staged.png') })

    // Unstage it via the staged-row Unstage button.
    const stagedAlpha = window
      .locator('.gp-row', { has: window.locator('.gp-name', { hasText: 'alpha.txt' }) })
      .filter({ has: window.locator('.gp-action-btn[title="Unstage"]') })
      .first()
    await stagedAlpha.locator('.gp-action-btn[title="Unstage"]').click()

    // alpha returns to Changes; the staged section disappears.
    await expectPanel(window, 'CHANGES (2)')
    await expect(async () => {
      expect(await panelText(window)).not.toContain('STAGED CHANGES')
    }).toPass({ timeout: 8000 })
    await window.screenshot({ path: join(SHOTS, 'git-unstage-2-unstaged.png') })

    expect(errors).toEqual([])
  })

  test('Approve all → Unstage all round trips; the commit draft survives and Commit re-gates', async ({
    window,
  }) => {
    const errors: string[] = []
    window.on('pageerror', (e) => errors.push(String(e)))

    await openGitPanel(window)
    await expectPanel(window, 'CHANGES (2)')

    // "Approve all" stages every change — nothing left under a plain Changes header.
    await window.locator('.gp-bulk-btn.gp-bulk-approve').first().click()
    await expectPanel(window, 'STAGED CHANGES (2)')
    await expect(async () => {
      expect(await panelText(window)).not.toMatch(/(^|\n)CHANGES \(/)
    }).toPass({ timeout: 8000 })
    await window.screenshot({ path: join(SHOTS, 'git-unstage-3-approveall.png') })

    // Type a commit message while everything is staged, then Unstage all.
    const msg = window.locator('.gp-commit-msg')
    await msg.fill('chore: message typed while staged')
    await expect(window.locator('.gp-commit-btn')).toBeEnabled()

    await window.locator('.gp-bulk-btn', { hasText: 'Unstage all' }).first().click()

    // Everything returns to Changes; Commit re-disables (nothing staged); the typed
    // draft is preserved (VS Code parity — the message isn't lost by unstaging).
    await expectPanel(window, 'CHANGES (2)')
    await expect(async () => {
      expect(await panelText(window)).not.toContain('STAGED CHANGES')
    }).toPass({ timeout: 8000 })
    await expect(window.locator('.gp-commit-btn')).toBeDisabled()
    await expect(msg).toHaveValue('chore: message typed while staged')
    await window.screenshot({ path: join(SHOTS, 'git-unstage-4-unstageall.png') })

    expect(errors).toEqual([])
  })

  test('Revert all cleans both the working tree AND the panel to "Working tree clean"', async ({
    window,
  }) => {
    const errors: string[] = []
    window.on('pageerror', (e) => errors.push(String(e)))
    window.on('dialog', (d) => void d.accept()) // Revert all confirms once.

    const dir = await openGitPanel(window)
    await expectPanel(window, 'CHANGES (2)')

    // GitPanel re-renders wipe its subtree (provisioning triggers refreshes
    // right after a root is added), so a single click can land on a detached
    // node and no-op — retry against git itself, the observable effect.
    await expect(async () => {
      if (git(dir, 'status', '--porcelain').trim() !== '') {
        await window.locator('.gp-bulk-btn.gp-bulk-revert').first().click({ timeout: 2000 })
      }
      expect(git(dir, 'status', '--porcelain').trim()).toBe('')
    }).toPass({ timeout: 20000 })

    // The tree becomes clean (alpha reverted to HEAD, untracked beta removed) AND
    // the panel refreshes to match — never a stale "CHANGES (2)" over a clean repo.
    await expectPanel(window, 'Working tree clean')
    await expect(async () => {
      expect(await panelText(window)).not.toMatch(/CHANGES \(/)
    }).toPass({ timeout: 8000 })
    expect(git(dir, 'status', '--porcelain').trim()).toBe('')
    await window.screenshot({ path: join(SHOTS, 'git-unstage-5-revertall.png') })

    expect(errors).toEqual([])
  })
})
