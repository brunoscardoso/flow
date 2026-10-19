import type { Page } from '@playwright/test'
import { test, expect } from '../fixtures/electron'
import { activateProject } from './fixtures/seed'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Source Control merge-section actions — the reported bug was that "Resolve all
 * with AI" was CLIPPED OFF the panel: three branch-named "Keep all from
 * <branch>" buttons sat ahead of it in one non-wrapping header row, and a real
 * branch name (ACME-2446-rework-the-session-cache-for-the-new-router) alone
 * overflowed the panel width.
 *
 * What this guards, against a REAL conflicted repo with a long branch name:
 *   1. the primary "Resolve all" control is VISIBLE and inside the panel's box,
 *   2. every keep-all resolution is still reachable — with its full identity
 *      label — from the "Keep all" dropdown,
 *   3. a conflicted row can be opened for MANUAL editing (not only the diff and
 *      merge viewers), landing an editable tab on the markered file.
 */

const LONG_BRANCH = 'ACME-2446-rework-the-session-cache-for-the-new-router'

function git(dir: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: dir }).toString()
}

const seededDirs: string[] = []

/** A repo with a genuine merge conflict whose incoming branch name is long
 *  enough to overflow the panel — the condition that hid the control. */
function seedConflictRepo(): { dir: string; file: string } {
  const dir = mkdtempSync(join(tmpdir(), 'flow-ux-merge-header-'))
  seededDirs.push(dir)
  git(dir, 'init', '-q')
  git(dir, 'config', 'user.email', 'qa@flow.test')
  git(dir, 'config', 'user.name', 'QA Bot')
  // The IDE provisions every added root; keep its scaffold out of the panel's
  // lists (repo-local exclude, as seed.ts does).
  writeFileSync(join(dir, '.git', 'info', 'exclude'), '.claude/\nflow\n.gitignore\nloops/\n')

  const file = 'streamTurn.ts'
  writeFileSync(join(dir, file), 'export const mode = "base"\n')
  git(dir, 'add', file)
  git(dir, 'commit', '-q', '-m', 'base')
  const mainBranch = git(dir, 'rev-parse', '--abbrev-ref', 'HEAD').trim()

  git(dir, 'checkout', '-q', '-b', LONG_BRANCH)
  writeFileSync(join(dir, file), 'export const mode = "engine"\n')
  git(dir, 'commit', '-q', '-am', 'engine persistence')

  git(dir, 'checkout', '-q', mainBranch)
  writeFileSync(join(dir, file), 'export const mode = "next"\n')
  git(dir, 'commit', '-q', '-am', 'trunk change')
  try {
    git(dir, 'merge', LONG_BRANCH)
  } catch {
    // Expected — merge exits non-zero on conflict; the tree now carries markers.
  }
  return { dir, file }
}

async function openGitPanel(window: Page, dir: string): Promise<void> {
  await window.evaluate(async (p) => {
    await (
      window as unknown as {
        flow: { project: { add(r: { path: string }): Promise<unknown> } }
      }
    ).flow.project.add({ path: p })
  }, dir)
  await activateProject(window, dir)
  await window.locator('.fl-activity-bar .fl-rail-item[aria-label="Source Control"]').click()
  await expect(window.locator('.gp-root')).toBeVisible()
  await expect(async () => {
    expect(await window.locator('.gp-name').count()).toBeGreaterThan(0)
  }).toPass({ timeout: 8000 })
}

test.afterAll(() => {
  for (const dir of seededDirs) rmSync(dir, { recursive: true, force: true })
})

test('merge header keeps the primary resolve action visible, with every keep-all option reachable', async ({
  window,
}) => {
  const { dir } = seedConflictRepo()
  await openGitPanel(window, dir)

  const panelBox = await window.locator('.gp-root').boundingBox()
  expect(panelBox).not.toBeNull()
  const inside = async (selector: string, label: string): Promise<void> => {
    const box = await window.locator(selector).first().boundingBox()
    expect(box, `${label} has no box`).not.toBeNull()
    expect(box!.x, `${label} starts left of the panel`).toBeGreaterThanOrEqual(panelBox!.x)
    expect(box!.x + box!.width, `${label} runs past the panel's right edge`).toBeLessThanOrEqual(
      panelBox!.x + panelBox!.width + 1,
    )
  }

  // The regression itself: the primary control must sit INSIDE the panel, not
  // past its right edge (where it was unreachable however hard the user looked).
  const resolveAll = window.locator('.gp-section-head .gp-action-resolve')
  await expect(resolveAll).toBeVisible()
  await inside('.gp-section-head .gp-action-resolve', 'Resolve all with AI')

  // The header does not spell the long branch name into its buttons…
  const header = window.locator('.gp-section-head', { has: window.locator('.gp-action-resolve') })
  await expect(header).not.toContainText(LONG_BRANCH)

  // …and since the merge toolbar (2026-09-04) the three keep-all choices are
  // inline, under FIXED labels, with the branch identity said once in a legend
  // rather than three times in the buttons. Every one is reachable and fits.
  const keepAll = window.locator('.gp-merge-toolbar .gp-bulk-keepall')
  await expect(keepAll).toHaveText(['Use current', 'Use incoming', 'Keep both'])
  for (let index = 0; index < 3; index += 1) {
    const box = await keepAll.nth(index).boundingBox()
    expect(box!.x + box!.width).toBeLessThanOrEqual(panelBox!.x + panelBox!.width + 1)
  }
  await expect(keepAll.nth(1)).toHaveAttribute('title', new RegExp(LONG_BRANCH))
  await expect(window.locator('.gp-merge-toolbar')).toContainText(LONG_BRANCH)

  // The conflict ROW fits the panel: the filename keeps its own line, and the
  // per-side choices sit on the line below it instead of squeezing it out.
  const row = window.locator('.gp-row-conflict').first()
  await inside('.gp-row-conflict', 'the conflict row')
  const name = row.locator('.gp-name')
  await expect(name).toBeVisible()
  expect((await name.boundingBox())!.width).toBeGreaterThan(40)
  await expect(window.locator('.gp-conflict-choice .gp-action-side')).toHaveCount(2)
  await inside('.gp-conflict-choice', 'the side-choice line')
  await window.screenshot({ path: '/tmp/merge-row-fit.png' })

  // The merge banner's controls stay inside the panel too — Abort used to be
  // sliced off the right edge at this width.
  for (const label of ['Complete merge', 'Abort']) {
    const button = window.locator('.gp-merge-banner-btn', { hasText: label })
    await expect(button).toBeVisible()
    const box = await button.boundingBox()
    expect(box!.x + box!.width).toBeLessThanOrEqual(panelBox!.x + panelBox!.width + 1)
  }
})

// NOT SHIPPED: the three tests below were written with this spec (c6df3662)
// against conflict-row controls — a row ⋯ menu with "Open in editor", and a
// "Mark resolved (stage this file)" button — that do not exist in
// git-panel.ts and never did on this branch (`git log -S` finds them only in
// this file). A conflicted row today offers the two side choices and "Open in
// merge editor". Kept as fixme: they state wanted behaviour, not a regression.
test.fixme('a conflicted file can be opened for manual editing, not just viewed', async ({ window }) => {
  const { dir, file } = seedConflictRepo()
  await openGitPanel(window, dir)

  const row = window.locator('.gp-row', { hasText: file }).first()
  await row.hover()
  // Narrow panel → the edit action lives in the row's overflow menu.
  await row.locator('.gp-row-more').click()
  await window.locator('.gp-menu-item', { hasText: 'Open in editor' }).click()

  // An editable Monaco tab on the markered working-tree file — the row click and
  // the merge controls all land in viewers, which is what the user hit.
  const editor = window.locator('.monaco-editor').first()
  await expect(editor).toBeVisible({ timeout: 10_000 })
  await expect(window.locator('fl-tabs .tab', { hasText: file }).first()).toBeVisible()
  expect(readFileSync(join(dir, file), 'utf8')).toContain('<<<<<<<')
  await expect(editor.locator('.view-lines')).toContainText('<<<<<<<')
  await window.screenshot({ path: '/tmp/merge-open-in-editor.png' })
})

test.fixme('a hand-edited conflict can be marked resolved from its row', async ({ window }) => {
  const { dir, file } = seedConflictRepo()
  await openGitPanel(window, dir)

  // Resolve it by hand, exactly as a user would after opening the file.
  writeFileSync(join(dir, file), 'export const mode = "engine"\n')

  // The row's "+" — the git add that ends a manual resolution. It was missing
  // entirely: a hand-fixed file had no way out of the Merge section.
  const row = window.locator('.gp-row', { hasText: file }).first()
  await row.hover()
  await row.locator('button[title="Mark resolved (stage this file)"]').click()

  // Staged → git no longer reports it unmerged, and the panel moves it out of
  // Merge Changes into Staged Changes.
  await expect(async () => {
    const unmerged = execFileSync('git', ['diff', '--name-only', '--diff-filter=U'], { cwd: dir })
      .toString()
      .trim()
    expect(unmerged).toBe('')
  }).toPass({ timeout: 8000 })
  await expect(window.locator('.gp-section-head', { hasText: 'MERGE CHANGES' })).toHaveCount(0)
  await window.screenshot({ path: '/tmp/merge-mark-resolved.png' })
})

test.fixme('staging a file that still has conflict markers asks first', async ({ window }) => {
  const { dir, file } = seedConflictRepo()
  await openGitPanel(window, dir)

  // Decline the confirm — `git add` would otherwise commit `<<<<<<<` markers.
  await window.evaluate(() => {
    ;(window as unknown as { confirm: () => boolean }).confirm = () => false
  })
  const row = window.locator('.gp-row', { hasText: file }).first()
  await row.hover()
  await row.locator('button[title="Mark resolved (stage this file)"]').click()

  // Nothing staged: the file is still unmerged, markers intact.
  await expect(window.locator('.gp-section-head', { hasText: 'MERGE CHANGES' })).toBeVisible()
  const unmerged = execFileSync('git', ['diff', '--name-only', '--diff-filter=U'], { cwd: dir })
    .toString()
    .trim()
  expect(unmerged).toBe(file)
  expect(readFileSync(join(dir, file), 'utf8')).toContain('<<<<<<<')
})
