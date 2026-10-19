/**
 * Regression for PR #585 — "clean untracked/conflict badges" (#581).
 *
 * The Source Control panel used to render the RAW git porcelain code `??` for a
 * new (untracked) file, and letter `U` for a merge conflict. #585 switched the
 * status badges to single VS Code-style letters:
 *   - untracked → `U` (was the raw two-char `??`)
 *   - conflict  → `C` (was a colliding `U`)
 *
 * These letters live in `git-panel.ts`'s STATE_LETTERS map and are rendered into
 * each change row's `.gp-letter` span (coloured by the `.gp-state-*` class). This
 * spec drives the REAL read-only Source Control panel against seeded throwaway
 * repos and asserts the observable badges a user actually sees:
 *   - a plain untracked file shows a single `U` badge, and the panel never leaks
 *     the raw porcelain `??` code anywhere in its text.
 *   - a real merge conflict shows a single `C` badge in Merge Changes.
 *
 * Observable-behavior only (rendered badge text + colour class); never asserts
 * internals. Complements pr-560.spec.ts (which guards that the panel still boots).
 */
import { test, expect, type Page } from '../fixtures/electron'
import { sel } from '../selectors'
import { seedProject, activateProject, cleanupSeeds } from '../ux/fixtures/seed'
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Run git in `dir`, retrying only on a transient `.git/index.lock` collision —
 * the app's git watcher (started by addRoot) briefly holds the index while we
 * seed the repo. `allowFail` swallows an expected non-zero exit (a conflicting
 * `git merge` exits 1 by design) once the command actually ran (not a lock).
 */
function runGit(dir: string, args: string[], allowFail = false): string {
  const MAX_TRIES = 20
  for (let attempt = 0; attempt < MAX_TRIES; attempt++) {
    try {
      return execFileSync('git', args, { cwd: dir }).toString()
    } catch (err) {
      const msg = String(
        (err as { stderr?: Buffer }).stderr ?? (err as Error).message ?? err,
      )
      if (msg.includes('index.lock') && attempt < MAX_TRIES - 1) {
        execFileSync('sleep', ['0.15']) // let the app release the index, then retry
        continue
      }
      if (allowFail) return '' // the command ran; a conflict/expected non-zero is fine
      throw err
    }
  }
  return ''
}

function git(dir: string, ...args: string[]): string {
  return runGit(dir, args)
}

/** git that tolerates a non-zero exit (a conflicting merge exits 1 by design). */
function gitAllowFail(dir: string, ...args: string[]): void {
  runGit(dir, args, true)
}

/** Configure identity so commits succeed under the throwaway repo. */
function configure(dir: string): void {
  git(dir, 'config', 'user.email', 'qa@flow.test')
  git(dir, 'config', 'user.name', 'QA Bot')
}

/** Reveal the Source Control side tab and wait for the panel to mount (#335). */
async function openSourceControl(window: Page): Promise<void> {
  const scTab = window.locator('[data-rail-item="source-control"]')
  await scTab.click()
  await expect(window.locator(sel.gitPanelRoot)).toBeAttached()
}

/** Poll the panel's rendered text until it settles into an expected shape. */
async function expectPanelText(window: Page, needle: string): Promise<void> {
  await expect(async () => {
    expect(await window.locator(sel.gitPanelRoot).innerText()).toContain(needle)
  }).toPass({ timeout: 6000 })
}

test.afterAll(() => cleanupSeeds())

test.describe('PR #585 — Source Control status badges (single-letter, #581)', () => {
  test('an untracked file shows a single `U` badge, never the raw porcelain `??`', async ({
    window,
  }) => {
    const errors: string[] = []
    window.on('pageerror', (e) => errors.push(String(e)))

    const dir = await seedProject(window, 'flow-git-untracked-')
    configure(dir)
    // A committed repo so the panel has a HEAD, then a brand-new UNTRACKED file
    // (no `git add`) — the exact case #581 was about.
    writeFileSync(join(dir, 'tracked.txt'), 'committed\n')
    git(dir, 'add', 'tracked.txt')
    git(dir, 'commit', '-q', '-m', 'chore: initial commit')
    writeFileSync(join(dir, 'brand-new.txt'), 'i am untracked\n')

    await activateProject(window, dir)
    await openSourceControl(window)

    // The untracked file surfaces in the panel via the project file watcher.
    await expect(
      window.locator(`${sel.gitPanelRoot} .gp-name`, { hasText: 'brand-new.txt' }),
    ).toBeVisible({ timeout: 6000 })

    // Its status badge is the single letter `U` on the untracked colour class —
    // NOT the old raw two-char porcelain code.
    const untrackedBadge = window.locator(
      `${sel.gitPanelRoot} .gp-letter.gp-state-untracked`,
    )
    await expect(untrackedBadge.first()).toHaveText('U')

    // The raw porcelain code must not leak into the panel's visible text anywhere.
    expect(await window.locator(sel.gitPanelRoot).innerText()).not.toContain('??')

    expect(errors).toEqual([])
  })

  test('a merge conflict shows a single `C` badge in Merge Changes', async ({ window }) => {
    const dir = await seedProject(window, 'flow-git-conflict-')
    configure(dir)

    // Build a real conflicting merge: a shared file edited divergently on two
    // branches, then merged — leaving `shared.txt` unmerged (conflicted state).
    writeFileSync(join(dir, 'shared.txt'), 'line one\nline two\n')
    git(dir, 'add', 'shared.txt')
    git(dir, 'commit', '-q', '-m', 'base')
    const base = git(dir, 'branch', '--show-current').trim() || 'master'

    git(dir, 'checkout', '-q', '-b', 'other')
    writeFileSync(join(dir, 'shared.txt'), 'line one\ntheir change\n')
    git(dir, 'add', 'shared.txt')
    git(dir, 'commit', '-q', '-m', 'their side')

    git(dir, 'checkout', '-q', base)
    writeFileSync(join(dir, 'shared.txt'), 'line one\nour change\n')
    git(dir, 'add', 'shared.txt')
    git(dir, 'commit', '-q', '-m', 'our side')

    gitAllowFail(dir, 'merge', 'other') // leaves shared.txt conflicted

    await activateProject(window, dir)
    await openSourceControl(window)

    // The conflicted file lands in the Merge Changes section (the subheader is
    // CSS-uppercased, so innerText reads "MERGE CHANGES")...
    await expectPanelText(window, 'MERGE CHANGES')
    await expect(
      window.locator(`${sel.gitPanelRoot} .gp-name`, { hasText: 'shared.txt' }),
    ).toBeVisible({ timeout: 6000 })

    // ...badged with the single conflict letter `C` (was a colliding `U` pre-#581).
    const conflictBadge = window.locator(
      `${sel.gitPanelRoot} .gp-letter.gp-state-conflicted`,
    )
    await expect(conflictBadge.first()).toHaveText('C')
  })
})
