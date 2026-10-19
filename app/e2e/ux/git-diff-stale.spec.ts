/**
 * UX regression probe — flow `git` (rotation index 6), targeting issue #402.
 *
 * The Git side-panel diff overlay is opened once and never re-synced to the live
 * working-tree state it claims to show. Its header reads "Working tree vs HEAD"
 * (a live diff), but once open it is a frozen snapshot: when the diffed file's
 * content changes on disk, the panel's CHANGES list refreshes (a new untracked
 * file shows up) while the open diff keeps rendering the OLD before/after pair.
 * The diff and the list next to it drift out of sync and the title becomes false.
 *
 * This is distinct from the already-fixed project-switch / root-removal / file-open
 * cases (#191/#288/#315/#345), which only close the diff on a focus/context change —
 * never on the diffed file's own content changing.
 *
 * #402 is FIXED: the open working-tree diff now reflects the diffed file's own
 * content changing underneath it. This asserts that fixed behavior as a passing
 * regression guard (the earlier test.fail() marker has been removed).
 */
import { test, expect } from '../fixtures/electron'
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed'
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** Run git, retrying briefly through the app watcher holding .git/index.lock. */
function git(dir: string, args: string[]): void {
  for (let i = 0; i < 20; i++) {
    try {
      execFileSync('git', args, { cwd: dir })
      return
    } catch (e) {
      if (i === 19 || !String(e).includes('index.lock')) throw e
      execFileSync('sleep', ['0.2'])
    }
  }
}

/** Fresh `git init` seed → one commit + a dirty working tree. */
function populateRepo(dir: string): void {
  git(dir, ['config', 'user.email', 'qa@flow.test'])
  git(dir, ['config', 'user.name', 'QA Bot'])
  writeFileSync(join(dir, 'alpha.txt'), 'first line\nsecond line\n')
  git(dir, ['add', 'alpha.txt'])
  git(dir, ['commit', '-q', '-m', 'feat: add alpha'])
  writeFileSync(join(dir, 'alpha.txt'), 'first line CHANGED\nsecond line\nthird\n')
  writeFileSync(join(dir, 'beta.txt'), 'brand new untracked file\n')
}

async function openGitPanel(window: import('@playwright/test').Page): Promise<string> {
  const dir = await seedProject(window)
  populateRepo(dir)
  await activateProject(window, dir)
  // Post-#674 activity-bar: "Source Control" rail item → "Changes" view (the
  // removed `.fl-sidetabs-tab 'Git'` silently broke this).
  await window.locator('.fl-activity-bar .fl-rail-item[aria-label="Source Control"]').click()
  await window.locator('.fl-sc-viewbtn', { hasText: 'Changes' }).click()
  await expect(window.locator('.gp-root')).toBeVisible()
  await expect(async () => {
    expect(await window.locator('.gp-name').count()).toBeGreaterThan(0)
  }).toPass({ timeout: 5000 })
  return dir
}

test.afterAll(() => cleanupSeeds())

test.describe('git diff overlay staleness (#402)', () => {
  test('open working-tree diff should reflect the file changing underneath it', async ({
    window,
  }) => {
    const dir = await openGitPanel(window)

    // Open alpha.txt's working-tree diff.
    await window
      .locator('.gp-row', { has: window.locator('.gp-name', { hasText: 'alpha.txt' }) })
      .first()
      .click()
    await expect(window.locator('.gd-overlay')).toBeVisible({ timeout: 5000 })
    await expect(window.locator('.gd-title')).toHaveText('alpha.txt')
    await expect(window.locator('.gd-subtitle')).toHaveText('Working tree vs HEAD')

    const NEW_LINE = 'FOURTH_ADDED_WHILE_DIFF_OPEN'
    // Edit the diffed file AND drop a brand-new file. The new file proves the
    // panel refreshed; the edited line is what the open diff should pick up.
    writeFileSync(join(dir, 'alpha.txt'), `first line CHANGED\nsecond line\nthird\n${NEW_LINE}\n`)
    writeFileSync(join(dir, 'delta.txt'), 'proves the watcher fired\n')

    // The panel DID refresh — delta.txt appears in CHANGES.
    await expect(window.locator('.gp-name', { hasText: 'delta.txt' })).toBeVisible({
      timeout: 6000,
    })

    // DESIRED: the still-"Working tree vs HEAD" diff now includes the added line.
    // ACTUAL (#402): the overlay is a frozen snapshot and never shows it → this fails.
    await expect(window.locator('.gd-body')).toContainText(NEW_LINE, { timeout: 4000 })
  })
})
