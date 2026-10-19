/**
 * UX sweep — flow `git` (rotation index 6, round 15): the Source Control panel
 * against a LOCAL-ONLY repo — no remote, one branch, and (for the last guard) no
 * commits at all. The most common shape a real user's repo starts in, and the
 * one shape 20+ prior git specs never drove as a subject:
 *
 *   - Every prior spec that clicks **Pull** (git-pull-rebase-abort) first seeds a
 *     real bare upstream. Nobody had clicked Pull with NO upstream configured —
 *     the default state — even though the button is rendered unconditionally and
 *     always enabled (git-panel.ts:850-858).
 *   - The branch picker's EMPTY state ("No other local branches",
 *     git-panel.ts:906-911) never rendered: git-merge-branch always seeds a
 *     second branch, so only the loading → list path executed.
 *   - The unborn-HEAD repo (`git init`, never committed) reaches the panel
 *     through a different git path — `git log` has no HEAD to read — and the
 *     FIRST commit is a real user journey ("Commits (0) / No commits" → commit).
 *
 * Three live guards + one tripwire:
 *
 *   1. PULL WITH NO UPSTREAM is honest and safe. git refuses ("There is no
 *      tracking information for the current branch"), git-manager.pull:997
 *      rethrows, onPull's catch (index.ts:430-433) raises a "Couldn't pull"
 *      toast — NOT silence — and nothing changes: HEAD identical, working tree
 *      clean, panel still rendering its branch header.
 *   2. BRANCH PICKER EMPTY STATE. "Merge branch…" in a single-branch repo shows
 *      "Loading branches…" then "No other local branches", and a second click
 *      closes the picker (no stuck panel).
 *   3. FIRST COMMIT ON AN UNBORN HEAD. A brand-new repo shows its branch,
 *      "Commits (0)" + "No commits", and the untracked file; staging + a message
 *      + Commit lands the repo's very first commit (asserted in git, and the
 *      panel flips to "Working tree clean" / "Commits (1)").
 *
 *   4. (#988, fixed) The git panel's error toasts must not leak Electron's
 *      IPC wrapper. "Couldn't pull" used to read "Error invoking remote method
 *      'git:pull': Error: Command failed: git pull --no-edit …" — the raw
 *      `error.message`, not the `ipcErrorMessage()` unwrap #731 made the one
 *      code path. The git panel now routes through it (gitErrorMessage).
 *
 * Account-independent (git only, no agent, no network) and deterministic: every
 * precondition is created with real git commands before the project is attached.
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

function identify(dir: string): void {
  git(dir, 'config', 'user.email', 'qa@flow.test')
  git(dir, 'config', 'user.name', 'QA Bot')
}

/** Reveal Source Control → Changes and wait for the git panel to mount + load. */
async function openGitPanel(window: Page): Promise<void> {
  await window.locator('.fl-activity-bar .fl-rail-item[aria-label="Source Control"]').click()
  await window.locator('.fl-sc-viewbtn', { hasText: 'Changes' }).click()
  await expect(window.locator('.gp-root')).toBeVisible()
  await expect(window.locator('.gp-branch-name')).toBeVisible({ timeout: 10000 })
}

/** A local-only repo (no remote, single branch) with one baseline commit.
 *
 *  Everything git happens inside `prepare` — i.e. BEFORE the root is attached —
 *  so the app's git watcher can't race the seed's own `git commit` on
 *  `.git/index.lock` (a harness artifact seen under --repeat-each, not a product
 *  bug: the app only starts watching once the root exists). */
async function seedLocalOnly(window: Page, prefix: string): Promise<string> {
  return seedProject(window, prefix, (dir) => {
    identify(dir)
    writeFileSync(join(dir, 'alpha.txt'), 'v0\n')
    git(dir, 'add', 'alpha.txt')
    git(dir, 'commit', '-q', '-m', 'baseline')
    git(dir, 'branch', '-M', 'main')
  })
}

test.afterAll(() => cleanupSeeds())

test.describe('git — local-only repo (no remote, no upstream)', () => {
  // RETIRED 2026-10-09: "Pull with no upstream…", "Merge branch… in a
  // single-branch repo…" and the #988 toast test all pressed Source Control's
  // Pull / Merge branch… row, removed on the user's call (2026-09-04). The
  // first-commit test below is the live one. (#988's unwrap — gitErrorMessage —
  // keeps its unit tests.)

  test('a brand-new repo with no commits makes its first commit from the panel', async ({
    window,
  }) => {
    const errors: string[] = []
    window.on('pageerror', (e) => errors.push(String(e)))

    // `git init` + an untracked file, never committed → unborn HEAD.
    const dir = await seedProject(window, 'flow-git-unborn-', (d) => {
      execFileSync('git', ['config', 'user.email', 'qa@flow.test'], { cwd: d })
      execFileSync('git', ['config', 'user.name', 'QA Bot'], { cwd: d })
      writeFileSync(join(d, 'alpha.txt'), 'first\n')
    })
    // Fixture self-check: HEAD does not resolve yet.
    expect(() => git(dir, 'rev-parse', 'HEAD')).toThrow()

    await activateProject(window, dir)
    await openGitPanel(window)

    // The commit-less repo renders its branch + an honest empty history, and
    // the untracked file as a change — no swallowed error, no "not a repo".
    const panel = window.locator('.gp-root')
    await expect(panel).toContainText('Commits (0)', { timeout: 10000 })
    await expect(panel).toContainText('No commits')
    await expect(panel).not.toContainText('Not a git repository')
    const row = window.locator('.gp-row').filter({ hasText: 'alpha.txt' }).first()
    await expect(row).toBeVisible()
    await window.screenshot({ path: join(SHOTS, 'git-local-only-unborn-head.png') })

    // Stage it, write a message, commit — the repo's very first commit.
    await row.hover()
    await row.locator('.gp-action-btn[title="Stage"]').first().click()
    await expect(panel).toContainText('Staged Changes (1)', { timeout: 10000 })

    await window.locator('.gp-commit-msg').fill('chore: initial commit')
    const commitBtn = window.locator('.gp-commit-btn')
    await expect(commitBtn).toBeEnabled()
    await commitBtn.click()

    // Landed — asserted in git, not just in the panel. The poll callback must
    // not THROW while HEAD is still unborn (expect.poll aborts on a thrown
    // callback rather than retrying): `git log` fails until the commit lands,
    // so degrade that window to '' and keep polling.
    await expect
      .poll(
        () => {
          try {
            return git(dir, 'log', '-1', '--pretty=%s').trim()
          } catch {
            return '' // no commits yet — keep polling
          }
        },
        { timeout: 10000 },
      )
      .toBe('chore: initial commit')
    await expect(panel).toContainText('Working tree clean', { timeout: 10000 })
    await expect(panel).toContainText('Commits (1)')

    expect(errors).toEqual([])
  })
})
