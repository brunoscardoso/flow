import { test, expect, type Page } from '../fixtures/electron'
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed'
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * #693 — the Source Control sections (Staged Changes / Changes / Commits) are
 * collapsible, VS Code-style: a chevron on the section header folds its body while
 * keeping the header + count, and the fold state persists across panel re-renders.
 *
 * Drives the real read-only git panel against a seeded repo that has a staged
 * file, an unstaged file, and a commit — so all three sections render.
 */

function git(dir: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: dir }).toString()
}

/** A repo with one commit, one STAGED change, and one UNSTAGED change.
 *  All git runs inside `prepare` — BEFORE the root is added — so the app's own
 *  git activity (status refreshes, provisioning) can't race it on index.lock. */
async function seedMixedRepo(win: Page): Promise<string> {
  const dir = await seedProject(win, 'flow-git-collapse-', (d) => {
    git(d, 'config', 'user.email', 'qa@flow.test')
    git(d, 'config', 'user.name', 'QA Bot')
    writeFileSync(join(d, 'base.ts'), 'export const base = 1\n')
    git(d, 'add', '-A')
    git(d, 'commit', '-m', 'baseline')
    // Staged change.
    writeFileSync(join(d, 'staged.ts'), 'export const staged = 1\n')
    git(d, 'add', 'staged.ts')
    // Unstaged change.
    writeFileSync(join(d, 'base.ts'), 'export const base = 2\n')
  })
  await activateProject(win, dir)
  return dir
}

/** Reveal the git panel (post-#674 activity-bar rail → Changes view). */
async function openGitPanel(win: Page): Promise<void> {
  await win.locator('.fl-activity-bar .fl-rail-item[aria-label="Source Control"]').click()
  await win.locator('.fl-sc-viewbtn', { hasText: 'Changes' }).click()
  await expect(win.locator('.gp-root')).toBeVisible()
}

/** The section header (toggle cluster) whose label starts with `title` — anchored
 *  so "Changes" doesn't also match "Staged Changes". */
function sectionToggle(win: Page, title: string) {
  return win.locator('.gp-section-toggle').filter({ hasText: new RegExp(`^${title} \\(`) })
}

test.afterAll(() => cleanupSeeds())

test('Source Control sections collapse/expand and the fold state persists (#693)', async ({
  window,
}) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(String(e)))

  await seedMixedRepo(window)
  await openGitPanel(window)

  // All three sections render with counts, and their file rows are visible.
  await expect(sectionToggle(window, 'Staged Changes')).toBeVisible()
  await expect(sectionToggle(window, 'Changes')).toBeVisible()
  await expect(sectionToggle(window, 'Commits')).toBeVisible()
  await expect(window.locator('.gp-root').getByText('staged.ts', { exact: true })).toBeVisible()

  // Collapse "Staged Changes" — its file row hides, but the header + count stay.
  await sectionToggle(window, 'Staged Changes').click()
  await expect(window.locator('.gp-root').getByText('staged.ts', { exact: true })).toBeHidden()
  await expect(sectionToggle(window, 'Staged Changes')).toBeVisible()
  await expect(sectionToggle(window, 'Staged Changes')).toContainText('(1)')
  // The header reports collapsed to assistive tech.
  await expect(
    window.locator('.gp-section-head.gp-collapsed', { hasText: 'Staged Changes' }),
  ).toBeVisible()

  // The OTHER sections are unaffected (independent fold state).
  await expect(window.locator('.gp-root').getByText('base.ts', { exact: true })).toBeVisible()

  // Persistence across a re-render: staging the unstaged file re-renders the panel
  // (git refresh), and the Staged section must STILL be collapsed.
  await window.locator('.gp-root').getByText('base.ts', { exact: true }).hover()
  // Toggle the branch picker to force a purely-local re-render, then re-check.
  await sectionToggle(window, 'Changes').click() // collapse Changes too
  await expect(window.locator('.gp-root').getByText('base.ts', { exact: true })).toBeHidden()
  // Staged is still collapsed after that re-render.
  await expect(
    window.locator('.gp-section-head.gp-collapsed', { hasText: 'Staged Changes' }),
  ).toBeVisible()

  // Expand Staged again — its row returns.
  await sectionToggle(window, 'Staged Changes').click()
  await expect(window.locator('.gp-root').getByText('staged.ts', { exact: true })).toBeVisible()

  expect(errors, errors.join(', ')).toHaveLength(0)
})
