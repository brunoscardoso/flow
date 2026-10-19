import { test, expect } from '../fixtures/electron'
import { sel } from '../selectors'
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from '@playwright/test'

/**
 * UX sweep — flow 5 (Review): what the Phases panel says when git can't answer.
 *
 * The source-control rail has two view-modes over the SAME `git status`:
 *   - **Changes** (git panel) names each non-answer: "No project roots" for no
 *     project, "Not a git repository" for a plain folder — and a FAILED refresh
 *     keeps the previous rows rather than a wrong empty state (#289).
 *   - **Phases** (review panel) folds every non-answer into `groups: []`
 *     (`review-service.ts`: `status?.changes ?? []`) → the single sentence
 *     "No changes to review"; and `refresh()`'s only error handler is a
 *     `console.warn` (`renderer/review/index.ts`), so a failed listing is
 *     indistinguishable from a fresh one.
 *
 * Green here: the listing contract that DOES hold (a real repo lists its change
 * in both view-modes) and the naming contract that already exists next door in
 * Changes. The `test.fixme` blocks are the tripwires for #1332 (empty state) and #1333 (silent failure) — they
 * flip green when the Phases panel stops reporting "git didn't answer" as
 * "your tree is clean".
 */

const SCREENS = 'e2e/ux/__screens'

/** Non-git folders aren't seeded by `seedProject` (which runs `git init`). */
const strays: string[] = []

async function seedNonRepo(win: Page): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'flow-ux-norepo-'))
  writeFileSync(join(dir, 'notes.txt'), 'work in progress\n')
  strays.push(dir)
  await win.evaluate(async (p) => {
    await (
      window as unknown as {
        flow: { project: { add(r: { path: string }): Promise<unknown> } }
      }
    ).flow.project.add({ path: p })
  }, dir)
  await activateProject(win, dir)
  return dir
}

/** A repo with one committed baseline and one modified tracked file. */
async function seedDirtyRepo(win: Page, prefix: string): Promise<string> {
  const dir = await seedProject(win, prefix)
  execFileSync('git', ['config', 'user.email', 'qa@flow.test'], { cwd: dir })
  execFileSync('git', ['config', 'user.name', 'Flow QA'], { cwd: dir })
  writeFileSync(join(dir, 'app.ts'), 'export const version = 1\n')
  execFileSync('git', ['add', '-A'], { cwd: dir })
  execFileSync('git', ['commit', '-q', '-m', 'baseline'], { cwd: dir })
  writeFileSync(join(dir, 'app.ts'), 'export const version = 2\n')
  await activateProject(win, dir)
  return dir
}

async function openRail(win: Page): Promise<void> {
  await win.locator('[data-rail-item="source-control"]').click()
}

async function viewMode(win: Page, name: 'Changes' | 'Phases'): Promise<void> {
  await win.locator(sel.scViewBtn).filter({ hasText: name }).click()
}

/** The side panel's text in the Changes view-mode. */
async function changesText(win: Page): Promise<string> {
  return (
    await win.locator('.fl-git-panel, .fl-sc-body, .fl-side-panel').first().innerText()
  ).trim()
}

test.afterAll(() => {
  cleanupSeeds()
  for (const dir of strays) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* best effort */
    }
  }
})

test('a real repo lists its working-tree change in both view-modes', async ({ window }) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  await seedDirtyRepo(window, 'flow-ux-reviewgit-')
  await openRail(window)

  await viewMode(window, 'Phases')
  await expect(window.locator('.fl-review-file')).toHaveCount(1)
  await expect(window.locator('.fl-review-file-name')).toHaveText('app.ts')
  // Non-vacuous: the empty-state sentence is NOT what a live listing shows.
  await expect(window.locator('.fl-review')).not.toContainText('No changes to review')

  await viewMode(window, 'Changes')
  await expect
    .poll(async () => await changesText(window), { timeout: 8000 })
    .toContain('CHANGES (1)')

  expect(errors).toEqual([])
})

test('the Changes view names a non-git project (the contract next door)', async ({ window }) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  await seedNonRepo(window)
  await openRail(window)
  await viewMode(window, 'Changes')

  // git-panel.ts renders `status: null` as its own sentence — the Phases side
  // owes the user the same distinction.
  await expect
    .poll(async () => await changesText(window), { timeout: 8000 })
    .toContain('Not a git repository')

  await viewMode(window, 'Phases')
  await expect(window.locator('.fl-review')).toBeAttached()
  await window.screenshot({ path: `${SCREENS}/review-norepo-phases.png` })

  expect(errors).toEqual([])
})

test.fixme('Phases distinguishes a non-git project from a clean one', async ({ window }) => {
  await seedNonRepo(window)
  await openRail(window)
  await viewMode(window, 'Phases')
  await expect(window.locator('.fl-review')).toBeAttached()

  // Today: "No changes to review" — a confident clean claim over a folder git
  // was never asked about. Expected: the same distinction Changes already makes.
  await expect(window.locator('.fl-review')).not.toContainText('No changes to review')
})

test.fixme('a FAILED review listing says so instead of going quiet', async ({ window }) => {
  const dir = await seedDirtyRepo(window, 'flow-ux-reviewfail-')
  await openRail(window)
  await viewMode(window, 'Phases')
  await expect(window.locator('.fl-review-file')).toHaveCount(1)

  // git itself starts failing (a bad config line — real and recoverable).
  writeFileSync(join(dir, '.git', 'config'), '!!! not a config\n')
  await window.locator('.fl-review-refresh').click()

  // Today: `console.warn` only — the stale row stays fully actionable (✓, ✕,
  // Discard all, Approve all) and ⟳ is a silent no-op. Every SIBLING failure in
  // this panel raises a toast (commit #73, diff #659, reject #103, discard,
  // approve-stage sync); the listing is the one channel with none.
  await expect(window.locator('.fl-flow-toast')).toHaveCount(1, { timeout: 8000 })
})
