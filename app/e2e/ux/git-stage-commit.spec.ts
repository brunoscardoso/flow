/**
 * UX sweep — flow `git` (rotation index 6), round 5: the INTERACTIVE
 * stage → commit → unstage → discard lifecycle of the unified Source Control
 * panel (#335). The read-only states are guarded by git-states.spec.ts; this
 * drives the *write* actions a real user performs and asserts the panel ends up
 * in the correct state after each — the area #507 (staging refresh race) touched.
 *
 * Opener (current, #335): the old separate "Git" tab is gone — reach the panel
 * via the "Source Control" side tab → "Changes" view mode → `.gp-root`.
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

/** Seed a repo with one commit, a modified tracked file, and an untracked file. */
function populateRepo(dir: string): void {
  configure(dir)
  writeFileSync(join(dir, 'alpha.txt'), 'first line\nsecond line\n')
  git(dir, 'add', 'alpha.txt')
  git(dir, 'commit', '-q', '-m', 'feat: add alpha')
  writeFileSync(join(dir, 'alpha.txt'), 'first line CHANGED\nsecond line\nthird\n')
  writeFileSync(join(dir, 'beta.txt'), 'brand new untracked file\n')
}

/** Reveal Source Control → Changes and wait for the git panel to mount + load.
 *  The repo is populated inside `prepare` — BEFORE the root is added — so the
 *  app's own git activity (status refreshes, provisioning) can't race the
 *  seed's `git add`/`git commit` on index.lock. */
async function openGitPanel(window: Page): Promise<string> {
  const dir = await seedProject(window, undefined, populateRepo)
  await activateProject(window, dir)
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

test.describe('git stage/commit/discard lifecycle', () => {
  test('stage a file, commit it, and the panel + commit box return to a correct state', async ({
    window,
  }) => {
    const errors: string[] = []
    window.on('pageerror', (e) => errors.push(String(e)))

    await openGitPanel(window)

    // Fresh dirty tree: alpha (modified) + beta (untracked) both under Changes.
    await expectPanel(window, 'CHANGES (2)')
    await window.screenshot({ path: join(SHOTS, 'git-stagecommit-1-dirty.png') })

    // The ✨ generate button is disabled until something is staged.
    await expect(window.locator('.gp-commit-generate')).toBeDisabled()
    // Commit is gated too (nothing staged + no message).
    await expect(window.locator('.gp-commit-btn')).toBeDisabled()

    // Stage alpha via its inline (+) button. Scope to the alpha row.
    const alphaRow = window
      .locator('.gp-row', { has: window.locator('.gp-name', { hasText: 'alpha.txt' }) })
      .first()
    await alphaRow.locator('.gp-action-btn[title="Stage"]').click()

    // alpha moves to a "Staged Changes (1)" section; beta stays in "Changes (1)".
    await expectPanel(window, 'STAGED CHANGES (1)')
    await expectPanel(window, 'CHANGES (1)')
    // Now that something is staged, ✨ generate enables.
    await expect(window.locator('.gp-commit-generate')).toBeEnabled()
    await window.screenshot({ path: join(SHOTS, 'git-stagecommit-2-staged.png') })

    // Type a message; Commit enables; commit.
    const msg = window.locator('.gp-commit-msg')
    await msg.fill('chore: commit alpha via source control')
    await expect(window.locator('.gp-commit-btn')).toBeEnabled()
    await window.locator('.gp-commit-btn').click()

    // The commit lands: alpha leaves the panel entirely (only beta's untracked
    // change remains), and the message box clears (draft consumed) — #507.
    await expectPanel(window, 'CHANGES (1)')
    await expect(async () => {
      expect(await panelText(window)).not.toContain('STAGED CHANGES')
    }).toPass({ timeout: 8000 })
    await expect(window.locator('.gp-commit-msg')).toHaveValue('')
    // The new commit is at the top of the log.
    await expect(
      window.locator('.gp-subject', { hasText: 'chore: commit alpha via source control' }),
    ).toBeVisible({ timeout: 6000 })
    await window.screenshot({ path: join(SHOTS, 'git-stagecommit-3-committed.png') })

    expect(errors).toEqual([])
  })

  test('discard a working-tree change reverts it and clears it from the panel', async ({
    window,
  }) => {
    const errors: string[] = []
    window.on('pageerror', (e) => errors.push(String(e)))

    // Discard uses window.confirm — accept it.
    window.on('dialog', (d) => void d.accept())

    await openGitPanel(window)
    await expectPanel(window, 'CHANGES (2)')

    // Discard the tracked modification (alpha). It reverts to HEAD and leaves the list.
    const alphaRow = window
      .locator('.gp-row', { has: window.locator('.gp-name', { hasText: 'alpha.txt' }) })
      .first()
    await alphaRow.locator('.gp-action-btn[title="Discard changes"]').click()

    // Only beta (untracked) remains.
    await expectPanel(window, 'CHANGES (1)')
    await expect(window.locator('.gp-name', { hasText: 'alpha.txt' })).toHaveCount(0)
    await expect(window.locator('.gp-name', { hasText: 'beta.txt' })).toBeVisible()
    await window.screenshot({ path: join(SHOTS, 'git-stagecommit-4-discarded.png') })

    expect(errors).toEqual([])
  })

  // #598 (fixed in #605): per-file "Discard" on a file that is staged AND then
  // re-edited (shown in BOTH Staged Changes and Changes) used to revert the file
  // all the way to HEAD via `git checkout HEAD -- <path>`, silently destroying the
  // staged snapshot. #605 routes Discard through `git checkout -- <path>` (restore
  // from the INDEX), so the working-tree row now returns to the STAGED version and
  // the staged entry survives — VS Code parity. This guards that regression.
  test(
    'discarding a staged-then-edited file keeps the staged snapshot (#598)',
    async ({ window }) => {
      window.on('dialog', (d) => void d.accept())

      // All git inside `prepare` (pre-addRoot) — dodges index.lock races.
      const dir = await seedProject(window, undefined, (d) => {
        configure(d)
        writeFileSync(join(d, 'alpha.txt'), 'v0\n')
        git(d, 'add', 'alpha.txt')
        git(d, 'commit', '-q', '-m', 'feat: add alpha')
        // Stage v1, then edit to v2 on disk → alpha is staged AND worktree-edited.
        writeFileSync(join(d, 'alpha.txt'), 'v0\nSTAGED_LINE_v1\n')
        git(d, 'add', 'alpha.txt')
        writeFileSync(join(d, 'alpha.txt'), 'v0\nSTAGED_LINE_v1\nUNSTAGED_LINE_v2\n')
      })
      await activateProject(window, dir)
      await window.locator('.fl-activity-bar .fl-rail-item[aria-label="Source Control"]').click()
      await window.locator('.fl-sc-viewbtn', { hasText: 'Changes' }).click()
      await expect(window.locator('.gp-root')).toBeVisible()

      // alpha appears in BOTH sections.
      await expectPanel(window, 'STAGED CHANGES (1)')
      await expectPanel(window, 'CHANGES (1)')

      // Discard the working-tree edit (only the Changes-section row exposes it).
      await window.locator('.gp-action-btn[title="Discard changes"]').first().click()

      // DESIRED: only the unstaged edit is discarded — alpha stays staged, and its
      // staged content survives on disk. ACTUAL (#598): it reverts to HEAD, the
      // index empties, and the panel goes "Working tree clean".
      // Poll the DISK for the discard's effect — "STAGED CHANGES (1)" was already
      // true before the click, so it can't gate the async discard IPC landing.
      await expect
        .poll(() => execFileSync('cat', [join(dir, 'alpha.txt')]).toString(), { timeout: 10000 })
        .not.toContain('UNSTAGED_LINE_v2')
      const disk = execFileSync('cat', [join(dir, 'alpha.txt')]).toString()
      expect(disk).toContain('STAGED_LINE_v1')
      await expectPanel(window, 'STAGED CHANGES (1)')
    },
  )
})
