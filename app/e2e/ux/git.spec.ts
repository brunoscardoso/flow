/**
 * UX sweep — flow `git` (rotation index 6): status list, diff open, commit diff,
 * empty/clean state. Drives the real Git side-panel against a seeded throwaway
 * repo and asserts the expected user experience.
 *
 * Seed: a git repo with one commit (so the log + a clean baseline exist), plus a
 * working-tree modification and an untracked file (so the Changes list is
 * populated and a file row is diff-able).
 */
import { test, expect } from '../fixtures/electron'
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed'
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** Turn a freshly `git init`'d seed dir into a repo with a commit + dirty tree. */
function populateRepo(dir: string): void {
  execFileSync('git', ['config', 'user.email', 'qa@flow.test'], { cwd: dir })
  execFileSync('git', ['config', 'user.name', 'QA Bot'], { cwd: dir })
  writeFileSync(join(dir, 'alpha.txt'), 'first line\nsecond line\n')
  execFileSync('git', ['add', 'alpha.txt'], { cwd: dir })
  execFileSync('git', ['commit', '-q', '-m', 'feat: add alpha'], { cwd: dir })
  // Working-tree change + an untracked file so the Changes list has rows.
  writeFileSync(join(dir, 'alpha.txt'), 'first line CHANGED\nsecond line\nthird\n')
  writeFileSync(join(dir, 'beta.txt'), 'brand new untracked file\n')
}

/** Seed + activate a populated repo and reveal the Git side tab with a loaded list. */
async function openGitPanel(window: import('@playwright/test').Page): Promise<string> {
  const dir = await seedProject(window)
  populateRepo(dir)
  await activateProject(window, dir)
  // Post-#674 activity-bar: reach the git panel via the "Source Control" rail
  // item → "Changes" view (the removed `.fl-sidetabs-tab 'Git'` silently broke this).
  await window.locator('.fl-activity-bar .fl-rail-item[aria-label="Source Control"]').click()
  await window.locator('.fl-sc-viewbtn', { hasText: 'Changes' }).click()
  await expect(window.locator('.gp-root')).toBeVisible()
  await expect(async () => {
    expect(await window.locator('.gp-name').count()).toBeGreaterThan(0)
  }).toPass({ timeout: 5000 })
  return dir
}

test.afterAll(() => cleanupSeeds())

test.describe('git side panel', () => {
  test('shows branch header + changes + commits and opens a diff on click', async ({ window }) => {
    const errors: string[] = []
    window.on('pageerror', (e) => errors.push(String(e)))

    await openGitPanel(window)

    // Branch header, a populated Changes list, and the commit log all render.
    await expect(window.locator('.gp-branch-name')).toBeVisible()
    await expect(window.locator('.gp-name', { hasText: 'alpha.txt' })).toBeVisible()
    await expect(window.locator('.gp-subject', { hasText: 'feat: add alpha' })).toBeVisible()

    // Clicking a changed-file row opens the diff overlay titled with that file.
    await window
      .locator('.gp-row', { has: window.locator('.gp-name', { hasText: 'alpha.txt' }) })
      .first()
      .click()
    await expect(window.locator('.gd-overlay')).toBeVisible({ timeout: 5000 })
    await expect(window.locator('.gd-title')).toHaveText('alpha.txt')

    expect(errors).toEqual([])
  })

  // #345 is FIXED: opening a file in the SAME project now closes the diff overlay
  // (previously it only closed on project switch / root removal — #191/#288/#315 —
  // leaving the overlay covering the just-opened file). Guards that fixed behavior.
  test('opening a file while a git diff is open should reveal the file, not the stale diff', async ({
    window,
  }) => {
    const dir = await openGitPanel(window)

    // Open the alpha.txt diff.
    await window
      .locator('.gp-row', { has: window.locator('.gp-name', { hasText: 'alpha.txt' }) })
      .first()
      .click()
    const diffOverlay = window.locator('.gd-overlay')
    await expect(diffOverlay).toBeVisible({ timeout: 5000 })
    await expect(window.locator('.gd-title')).toHaveText('alpha.txt')

    // The user opens a DIFFERENT file, expecting to see it.
    await window.evaluate(
      ([rootPath, relPath]) => {
        document.dispatchEvent(
          new CustomEvent('flow:open-file', { detail: { rootPath, relPath } }),
        )
      },
      [dir, 'beta.txt'],
    )

    // The editor genuinely opens beta.txt underneath (its tab becomes active)…
    const betaTab = window.locator('fl-tabs .tab', { hasText: 'beta.txt' })
    await expect(betaTab).toBeVisible({ timeout: 5000 })
    await expect(betaTab).toHaveClass(/active/)

    // …so the stale alpha.txt diff overlay should no longer be covering the editor.
    await expect(diffOverlay).toBeHidden()
  })
})
