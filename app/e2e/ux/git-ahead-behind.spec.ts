/**
 * UX sweep — flow `git` (rotation index 6, round 12): the Source Control branch
 * header's AHEAD/BEHIND divergence indicator (`.gp-ahead-behind`, git-panel.ts
 * 618-626), driven live for the first time.
 *
 * Why this is un-probed: the git flow is heavily covered (stage / commit /
 * keyboard-commit / selective-commit / unstage-bulk / commit-gate / commit-fail /
 * merge-branch / merge-abort / pull-rebase / staged-diff / stale-diff / history-
 * diff / untracked-expand …), but EVERY prior spec seeds a repo with NO upstream,
 * so the branch header always renders `↑`/`↓`-free. The `↑N ↓M` divergence badge —
 * the header signal a real user relies on to know they need to push/pull — has
 * ZERO executing coverage. It's parsed from `git status --porcelain=v2 --branch`
 * (`# branch.ab +A -B`, git-manager.ts:200-205) and only rendered when
 * `ahead > 0 || behind > 0`.
 *
 * Two guards, both account-independent (git-only, local file-based upstream — no
 * network, no credentials):
 *
 *   1. DIVERGED. A repo whose branch is 2 commits ahead and 1 behind its upstream
 *      shows `↑2 ↓1` in the header. This proves the panel surfaces divergence
 *      honestly — a user with unpushed/unpulled work sees it.
 *
 *   2. IN SYNC. A repo whose branch exactly matches its upstream shows NO
 *      `.gp-ahead-behind` badge (the header stays clean). This proves the badge is
 *      not a false-positive that nags when there's nothing to push/pull.
 *
 * Reuses the standard seed + Source Control opener (#335). The upstream is a local
 * bare repo on disk (a second working clone pushes the "behind" commit), so the
 * whole scenario is deterministic and offline.
 */
import { test, expect, type Page } from '../fixtures/electron'
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, appendFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SHOTS = join(__dirname, '__screens')
const scratch: string[] = []

function git(dir: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: dir }).toString()
}

function initRepo(dir: string): void {
  git(dir, 'config', 'user.email', 'qa@flow.test')
  git(dir, 'config', 'user.name', 'QA Bot')
}

/** Reveal Source Control → Changes and wait for the git panel to mount + load. */
async function openGitPanel(window: Page): Promise<void> {
  await window.locator('.fl-activity-bar .fl-rail-item[aria-label="Source Control"]').click()
  await window.locator('.fl-sc-viewbtn', { hasText: 'Changes' }).click()
  await expect(window.locator('.gp-root')).toBeVisible()
  // The branch header renders as soon as a git status resolves.
  await expect(window.locator('.gp-branch-name')).toBeVisible({ timeout: 6000 })
}

test.afterAll(() => {
  cleanupSeeds()
  while (scratch.length) {
    const d = scratch.pop()
    if (d) rmSync(d, { recursive: true, force: true })
  }
})

test.describe('git branch header — ahead/behind divergence indicator', () => {
  test('a diverged branch (2 ahead, 1 behind upstream) shows ↑2 ↓1', async ({ window }) => {
    const errors: string[] = []
    window.on('pageerror', (e) => errors.push(String(e)))

    // Seed a repo, then wire a local bare upstream and diverge it: HEAD is 2
    // commits ahead of and 1 commit behind origin/main.
    const dir = await seedProject(window, 'flow-git-ab-diverge-')
    initRepo(dir)
    const bare = mkdtempSync(join(tmpdir(), 'flow-git-ab-remote-'))
    scratch.push(bare)
    git(bare, 'init', '-q', '--bare')

    writeFileSync(join(dir, 'f.txt'), 'A\n')
    git(dir, 'add', 'f.txt')
    git(dir, 'commit', '-q', '-m', 'A')
    git(dir, 'branch', '-M', 'main')
    git(dir, 'remote', 'add', 'origin', bare)
    git(dir, 'push', '-q', '-u', 'origin', 'main') // upstream set, in sync

    // A second working clone pushes commit B → origin is now 1 ahead of our HEAD.
    const other = mkdtempSync(join(tmpdir(), 'flow-git-ab-other-'))
    scratch.push(other)
    git(other, 'clone', '-q', bare, '.')
    initRepo(other)
    appendFileSync(join(other, 'f.txt'), 'B-upstream\n')
    git(other, 'commit', '-q', '-am', 'B (upstream)')
    git(other, 'push', '-q', 'origin', 'main')

    // Back in our repo: two local commits C, D (→ ahead 2), then fetch so the
    // local origin/main ref learns about B (→ behind 1). All offline.
    appendFileSync(join(dir, 'f.txt'), 'C-local\n')
    git(dir, 'commit', '-q', '-am', 'C (local)')
    writeFileSync(join(dir, 'g.txt'), 'D-local\n')
    git(dir, 'add', 'g.txt')
    git(dir, 'commit', '-q', '-am', 'D (local)')
    git(dir, 'fetch', '-q', 'origin')

    // Sanity-check the fixture itself before trusting the assertion below.
    const ab = git(dir, 'status', '--porcelain=v2', '--branch')
    expect(ab).toContain('# branch.ab +2 -1')

    await activateProject(window, dir)
    await openGitPanel(window)

    const badge = window.locator('.gp-ahead-behind')
    await expect(badge).toBeVisible({ timeout: 6000 })
    // ahead → ↑, behind → ↓, in that order.
    await expect(badge).toHaveText('↑2 ↓1')
    await window.screenshot({ path: join(SHOTS, 'git-ab-1-diverged.png') })

    expect(errors).toEqual([])
  })

  test('an in-sync branch shows no ahead/behind badge', async ({ window }) => {
    const errors: string[] = []
    window.on('pageerror', (e) => errors.push(String(e)))

    // Seed a repo with an upstream it exactly matches — nothing to push or pull.
    const dir = await seedProject(window, 'flow-git-ab-insync-')
    initRepo(dir)
    const bare = mkdtempSync(join(tmpdir(), 'flow-git-ab-remote2-'))
    scratch.push(bare)
    git(bare, 'init', '-q', '--bare')

    writeFileSync(join(dir, 'f.txt'), 'A\n')
    git(dir, 'add', 'f.txt')
    git(dir, 'commit', '-q', '-m', 'A')
    git(dir, 'branch', '-M', 'main')
    git(dir, 'remote', 'add', 'origin', bare)
    git(dir, 'push', '-q', '-u', 'origin', 'main') // in sync: ahead 0, behind 0

    const ab = git(dir, 'status', '--porcelain=v2', '--branch')
    expect(ab).toContain('# branch.ab +0 -0')

    await activateProject(window, dir)
    await openGitPanel(window)

    // The branch name + clean-tree marker render; the ↑/↓ badge must NOT.
    await expect(window.locator('.gp-branch-name')).toHaveText('main')
    await expect(window.locator('.gp-ahead-behind')).toHaveCount(0)
    await window.screenshot({ path: join(SHOTS, 'git-ab-2-insync.png') })

    expect(errors).toEqual([])
  })
})
