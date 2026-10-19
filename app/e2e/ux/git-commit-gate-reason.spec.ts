/**
 * UX sweep — flow `git` (rotation index 6, round 10): the Source Control commit
 * box's GATE-REASON differential and its DRAFT-SURVIVES-RE-RENDER data-loss guard.
 *
 * Why this is un-probed: git-stage-commit / git-selective-commit / git-unstage-bulk
 * all drive the commit button through the HAPPY ordering — stage first, THEN type a
 * message, then commit — and only assert the coarse disabled↔enabled flip. Two
 * user-facing guards behind `commitBoxState(stagedCount, message)` (commit-box.ts)
 * are never driven live:
 *
 *   1. GATE REASON. The button has TWO distinct disabled states with different
 *      tooltips: "Stage changes to commit" (nothing staged) vs "Enter a commit
 *      message" (staged but blank). The stagedCount gate wins FIRST — typing a
 *      message while nothing is staged must NOT enable the button and the tooltip
 *      must still say "Stage changes to commit", not flip to the message gate. A
 *      mislabeled/dead tooltip here would tell the user the wrong thing to fix.
 *      Only the pure unit test (commit-box.test.ts) covers these strings; no spec
 *      asserts them on the live button `title`.
 *
 *   2. DRAFT SURVIVES A BACKGROUND RE-RENDER. Staging a file is an async IPC round
 *      trip that triggers a git-status refresh → full panel rebuild, which recreates
 *      the commit textarea (#renderCommitBox). A message the user typed BEFORE
 *      staging must survive that rebuild (restored from #commitDrafts), not get
 *      wiped to empty. This is the classic "typed text lost on background refresh"
 *      data-loss class — and the message-typed-BEFORE-staging ordering is never
 *      driven (every sibling spec stages first).
 *
 * Account-independent: git-only, no agent. Reuses the standard seed + Source
 * Control opener (#335).
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

/** Seed a repo with one commit, a modified tracked file, and an untracked file. */
function populateRepo(dir: string): void {
  git(dir, 'config', 'user.email', 'qa@flow.test')
  git(dir, 'config', 'user.name', 'QA Bot')
  writeFileSync(join(dir, 'alpha.txt'), 'first line\nsecond line\n')
  git(dir, 'add', 'alpha.txt')
  git(dir, 'commit', '-q', '-m', 'feat: add alpha')
  writeFileSync(join(dir, 'alpha.txt'), 'first line CHANGED\nsecond line\nthird\n')
  writeFileSync(join(dir, 'beta.txt'), 'brand new untracked file\n')
}

/** Reveal Source Control → Changes and wait for the git panel to mount + load.
 *  The repo is populated inside `prepare` (pre-addRoot) so the app's own git
 *  activity can't race the seed on index.lock. */
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

function alphaRow(window: Page) {
  return window
    .locator('.gp-row', { has: window.locator('.gp-name', { hasText: 'alpha.txt' }) })
    .first()
}

test.afterAll(() => cleanupSeeds())

test.describe('git commit gate-reason + draft survival', () => {
  test('commit tooltip names the right gate: staged-count wins over an empty message', async ({
    window,
  }) => {
    const errors: string[] = []
    window.on('pageerror', (e) => errors.push(String(e)))

    await openGitPanel(window)
    await expectPanel(window, 'CHANGES (2)')

    const commit = window.locator('.gp-commit-btn')
    const msg = window.locator('.gp-commit-msg')

    // Baseline: nothing staged, blank message → disabled, tooltip = staged gate.
    await expect(commit).toBeDisabled()
    await expect(commit).toHaveAttribute('title', 'Stage changes to commit')
    await window.screenshot({ path: join(SHOTS, 'git-gatereason-1-nothing-staged.png') })

    // Type a message with NOTHING staged. The stagedCount gate wins FIRST — the
    // button must STAY disabled and the tooltip must STILL name the staged gate,
    // NOT flip to "Enter a commit message" (that would tell the user the wrong fix).
    await msg.fill('feat: message typed before staging anything')
    await expect(commit).toBeDisabled()
    await expect(commit).toHaveAttribute('title', 'Stage changes to commit')

    // Clear the message and stage alpha → now the OTHER gate applies: staged but
    // blank message → disabled with the message-gate tooltip.
    await msg.fill('')
    await alphaRow(window).locator('.gp-action-btn[title="Stage"]').click()
    await expectPanel(window, 'STAGED CHANGES (1)')
    await expect(commit).toBeDisabled()
    await expect(commit).toHaveAttribute('title', 'Enter a commit message')
    await window.screenshot({ path: join(SHOTS, 'git-gatereason-2-staged-no-msg.png') })

    // Whitespace-only is still "blank" — the message gate must not be fooled.
    await msg.fill('   ')
    await expect(commit).toBeDisabled()
    await expect(commit).toHaveAttribute('title', 'Enter a commit message')

    // A real message → enabled, tooltip flips to the ready state.
    await msg.fill('chore: commit alpha')
    await expect(commit).toBeEnabled()
    await expect(commit).toHaveAttribute('title', 'Commit staged changes')

    expect(errors).toEqual([])
  })

  test('a message typed BEFORE staging survives the stage re-render (no data loss)', async ({
    window,
  }) => {
    const errors: string[] = []
    window.on('pageerror', (e) => errors.push(String(e)))

    await openGitPanel(window)
    await expectPanel(window, 'CHANGES (2)')

    const commit = window.locator('.gp-commit-btn')
    const msg = window.locator('.gp-commit-msg')
    const DRAFT = 'fix: draft I typed before I remembered to stage'

    // Type the message FIRST, while nothing is staged (button still gated).
    await msg.fill(DRAFT)
    await expect(commit).toBeDisabled()

    // Now stage alpha. This is an async IPC round trip → git-status refresh → full
    // panel rebuild that RECREATES the commit textarea. The draft must survive.
    await alphaRow(window).locator('.gp-action-btn[title="Stage"]').click()
    await expectPanel(window, 'STAGED CHANGES (1)')

    // The recreated textarea still carries the typed draft — not wiped to empty.
    await expect(msg).toHaveValue(DRAFT)
    // And with something now staged + a non-blank message, the button is live.
    await expect(commit).toBeEnabled()
    await window.screenshot({ path: join(SHOTS, 'git-gatereason-3-draft-survived.png') })

    // Committing consumes the draft cleanly: alpha leaves the panel and the box clears.
    await commit.click()
    await expect(async () => {
      expect(await panelText(window)).not.toContain('STAGED CHANGES')
    }).toPass({ timeout: 8000 })
    await expect(msg).toHaveValue('')
    await expect(
      window.locator('.gp-subject', { hasText: DRAFT }),
    ).toBeVisible({ timeout: 6000 })
    await window.screenshot({ path: join(SHOTS, 'git-gatereason-4-committed.png') })

    expect(errors).toEqual([])
  })
})
