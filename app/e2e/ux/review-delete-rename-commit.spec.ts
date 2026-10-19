import { test, expect } from '../fixtures/electron'
import { sel } from '../selectors'
import { seedProject, activateProject, cleanupSeeds, gitRetry, waitForStableNode } from './fixtures/seed'
import { execFileSync } from 'node:child_process'
import { writeFileSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'

/**
 * UX sweep — flow 5: Review (Phases), the DELETED and RENAMED file states.
 *
 * The existing review specs cover modified / added / untracked / conflicted
 * rows end to end, but nothing drove a `D` or an `R` row through approve →
 * commit. Both turn out to be broken, and both for the same reason: the commit
 * and staging paths run `git add -- <path>`, which is a *fatal* error for a path
 * that is no longer on disk (an already-staged deletion), and the commit is
 * path-scoped to the row's single path (#1051), which for a rename excludes the
 * old path's staged deletion.
 *
 * Green guards here (behavior that is correct today and must stay correct):
 *   - a deleted file is listed as `D` and its diff shows the removed content
 *   - ✓ on a deleted file really stages the deletion
 *   - "Discard all" on a deleted file restores it to disk and empties the panel
 *   - a staged rename is listed and offered as committable
 *
 * fixme tripwires for the bugs this round filed (verified RED un-fixmed):
 *   - #1181 — approving a deletion and clicking "Commit phase" commits nothing,
 *     forever ("fatal: pathspec ... did not match any files")
 *   - #1182 — "Commit phase" on a staged rename lands only the new path, leaving
 *     the old file in HEAD and a stuck `D` row behind
 *   - #1182 — one ✓ click shatters the staged rename into `D` + `??` and the
 *     group can never be re-approved
 */

const SCREENS = 'e2e/ux/__screens'

/** A repo with a committed baseline; `mutate` makes the change under review. */
async function seedRepo(
  win: Page,
  prefix: string,
  mutate: (dir: string) => void,
): Promise<string> {
  const dir = await seedProject(win, prefix)
  execFileSync('git', ['config', 'user.email', 'qa@flow.test'], { cwd: dir })
  execFileSync('git', ['config', 'user.name', 'Flow QA'], { cwd: dir })
  writeFileSync(join(dir, 'legacy-widget.ts'), 'export const legacy = true\nexport const old = 1\n')
  writeFileSync(join(dir, 'keep.ts'), 'export const keep = 1\n')
  execFileSync('git', ['add', '-A'], { cwd: dir })
  execFileSync('git', ['commit', '-q', '-m', 'baseline'], { cwd: dir })
  mutate(dir)
  await activateProject(win, dir)
  return dir
}

/** Open Source Control → Phases (the folded-in review, #335). */
async function openReview(win: Page): Promise<void> {
  await win.locator('[data-rail-item="source-control"]').click()
  await win.locator(sel.scViewBtn).filter({ hasText: 'Phases' }).click()
  await expect(win.locator('.fl-review')).toBeAttached()
  // The list rebuilds a couple of times as a fresh project settles; a click
  // landing on a replaced node is lost (#1093/#1094).
  await waitForStableNode(win, '.fl-review-file')
}

const deleteLegacy = (dir: string): void => rmSync(join(dir, 'legacy-widget.ts'))
const renameLegacy = (dir: string): void => {
  gitRetry(dir, 'mv', 'legacy-widget.ts', 'widget.ts')
}

test.afterAll(() => cleanupSeeds())

// ── Deleted file ──────────────────────────────────────────────────────────

test('a deleted tracked file is listed as D and its diff shows the removed content', async ({
  window,
}) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  await seedRepo(window, 'flow-ux-del-list-', deleteLegacy)
  await openReview(window)

  const row = window.locator('.fl-review-file', { hasText: 'legacy-widget.ts' })
  await expect(row).toBeVisible({ timeout: 15_000 })
  await expect(row.locator('.fl-review-state')).toHaveText('D')

  // Clicking it must open the working-tree diff of what is being removed — a
  // reviewer approving a deletion has to see the content that disappears.
  await row.locator('.fl-review-file-name').click()
  await expect(window.locator('.gd-overlay')).toBeVisible()
  await expect(window.locator('.gd-title')).toContainText('legacy-widget.ts')
  await expect(window.locator('.gd-body')).toContainText('export const legacy = true')

  expect(errors, errors.join(', ')).toHaveLength(0)
})

test('✓ on a deleted file stages the deletion', async ({ window }) => {
  const dir = await seedRepo(window, 'flow-ux-del-stage-', deleteLegacy)
  await openReview(window)

  const row = window.locator('.fl-review-file', { hasText: 'legacy-widget.ts' })
  await expect(row).toBeVisible({ timeout: 15_000 })
  expect(gitRetry(dir, 'status', '--porcelain')).toContain(' D legacy-widget.ts')

  await row.locator('.fl-review-approve').click()
  await expect(row.locator('.fl-review-approve')).toHaveClass(/active/)
  // Staged: index-side D (#857 — approval mirrors into the staging area).
  await expect
    .poll(() => gitRetry(dir, 'status', '--porcelain'), { timeout: 8000 })
    .toContain('D  legacy-widget.ts')
})

test('"Discard all" on a deleted file brings it back and empties the panel', async ({ window }) => {
  const dir = await seedRepo(window, 'flow-ux-del-discard-', deleteLegacy)
  await openReview(window)
  await expect(window.locator('.fl-review-file')).toHaveCount(1, { timeout: 15_000 })

  await window.locator('.fl-review-discard-btn').first().click()
  await window.locator('.fl-review-discard-btn.confirm').click()

  await expect(window.locator('.fl-review-empty')).toHaveText('No changes to review')
  expect(existsSync(join(dir, 'legacy-widget.ts'))).toBe(true)
  expect(gitRetry(dir, 'status', '--porcelain').trim()).toBe('')
})

// #1181 — RED today: `commit()` runs `git add -- <path>` before committing, and
// that is fatal once the deletion is staged, so nothing is ever committed.
test('#1181: approving a deleted file lets "Commit phase" commit the deletion', async ({
  window,
}) => {
  const dir = await seedRepo(window, 'flow-ux-del-commit-', deleteLegacy)
  await openReview(window)
  const row = window.locator('.fl-review-file', { hasText: 'legacy-widget.ts' })
  await expect(row).toBeVisible({ timeout: 15_000 })

  await row.locator('.fl-review-approve').click()
  const button = window.locator('.fl-review-commit-btn').first()
  await expect(button).toHaveText(/Commit phase/)
  await button.click()

  await window.screenshot({ path: `${SCREENS}/review-deleted-file-commit.png` })
  // The deletion must land in history and the panel must go clean. Polled on
  // the OUTCOME: the old wait (`git log --oneline` not equal to "baseline\n")
  // could never fail — the line carries a hash — so it read HEAD before the
  // commit had happened.
  await expect
    .poll(() => gitRetry(dir, 'log', '--format=%s'), { timeout: 10_000 })
    .not.toBe('baseline\n')
  expect(gitRetry(dir, 'ls-tree', '--name-only', 'HEAD')).not.toContain('legacy-widget.ts')
  await expect(window.locator('.fl-review-empty')).toHaveText('No changes to review')
})

// ── Renamed file ──────────────────────────────────────────────────────────

test('a staged rename is listed and offered as committable', async ({ window }) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  const dir = await seedRepo(window, 'flow-ux-ren-list-', renameLegacy)
  await openReview(window)

  const row = window.locator('.fl-review-file', { hasText: 'widget.ts' }).first()
  await expect(row).toBeVisible({ timeout: 15_000 })
  expect(gitRetry(dir, 'status', '--porcelain')).toContain('R  legacy-widget.ts -> widget.ts')
  // Already staged ⇒ already approved (#857), so the group is commit-ready.
  await expect(window.locator('.fl-review-commit-btn').first()).toHaveText(/Commit phase/)

  expect(errors, errors.join(', ')).toHaveLength(0)
})

// #1182 — RED today: the commit is path-scoped to the NEW path only, so the old
// path's staged deletion is left out; HEAD keeps both files.
test('#1182: "Commit phase" on a rename records the whole rename', async ({ window }) => {
  const dir = await seedRepo(window, 'flow-ux-ren-commit-', renameLegacy)
  await openReview(window)
  await expect(window.locator('.fl-review-file')).toHaveCount(1, { timeout: 15_000 })

  await window.locator('.fl-review-commit-btn').first().click()
  // Polled on the subject line: `--oneline` carries the hash, so the old
  // comparison with "baseline\n" was true before the commit had happened.
  await expect
    .poll(() => gitRetry(dir, 'log', '--format=%s'), { timeout: 10_000 })
    .not.toBe('baseline\n')

  await window.screenshot({ path: `${SCREENS}/review-rename-commit.png` })
  // The renamed-away file must NOT survive in HEAD, and nothing may be left over.
  expect(gitRetry(dir, 'ls-tree', '--name-only', 'HEAD')).not.toContain('legacy-widget.ts')
  expect(gitRetry(dir, 'status', '--porcelain').trim()).toBe('')
  await expect(window.locator('.fl-review-empty')).toHaveText('No changes to review')
})

// #1182 — RED today: un-approving unstages only the new path, shattering the
// rename into `D old` + `?? new`; re-approving runs `git add -- old new`, which
// is fatal on the missing old path, so the group is stuck at "Approve all (1/2)".
test('#1182: un-approving a rename does not wedge the group', async ({ window }) => {
  const dir = await seedRepo(window, 'flow-ux-ren-toggle-', renameLegacy)
  await openReview(window)
  const row = window.locator('.fl-review-file', { hasText: 'widget.ts' }).first()
  await expect(row).toBeVisible({ timeout: 15_000 })

  // Un-approve (the ✓ is a toggle) …
  await row.locator('.fl-review-approve').click()
  await window.waitForTimeout(1500)
  await window.screenshot({ path: `${SCREENS}/review-rename-unapproved.png` })

  // … then re-approve via the group button: it must become committable again.
  // The button paints "Commit phase" optimistically before the staging call
  // returns, so let the round-trip + refresh settle before judging it.
  await window.locator('.fl-review-commit-btn').first().click()
  await window.waitForTimeout(4000)
  await expect(window.locator('.fl-review-commit-btn').first()).toHaveText(/Commit phase/)
  // And the rename must have survived the toggle, not been split into D + ??.
  expect(gitRetry(dir, 'status', '--porcelain')).toContain('->')
})
