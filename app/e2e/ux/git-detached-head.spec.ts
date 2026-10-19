/**
 * UX sweep — flow `git` (rotation index 6, round 23): the Source Control panel
 * against a **detached HEAD**, the one repo shape 30+ prior git specs never used
 * as a subject.
 *
 * Every existing git spec seeds a repo sitting on a named branch (`main`, or a
 * feature branch for the merge/rebase probes). Nobody had asked what the panel
 * says — or what its mutating actions *do* — when HEAD points at a commit
 * instead of a branch. Users land there routinely: `git checkout <sha>` or
 * `git checkout <tag>` in Flow's own terminal, a bisect, or an agent inspecting
 * an older revision.
 *
 * What git reports in that state is a placeholder, not a name:
 *
 *     $ git status --porcelain=v2 --branch -z
 *     # branch.oid 7d090d7b…
 *     # branch.head (detached)          ← the literal string
 *
 * `parsePorcelainV2Status` (git-manager.ts:222-224) assigns that verbatim to
 * `status.branch`, and `#renderBranchHeader` (git-panel.ts:1078-1081) paints it
 * into `.gp-branch-name` next to the git-branch icon — the same slot that says
 * `main`. `# branch.ab` is absent while detached, so the ahead/behind badge
 * (#826) is silent too. Nothing in the panel is detached-aware: `#renderGitActions`
 * offers Pull + "Merge branch…" unconditionally, and `#renderCommitBox`'s only
 * gates are staged-count and message text (#760).
 *
 * Three live guards + one tripwire, all account-independent (git only, no agent,
 * no network) and deterministic — every precondition is created with real git
 * before the root is attached:
 *
 *   1. COMMITTING WHILE DETACHED. Stage + message + Commit lands a real commit
 *      that NO branch contains (verified with `git branch --contains`), while
 *      the app's feedback is the ordinary success path — box clears, "Working
 *      tree clean", no warning anywhere outside the branch slot's "(detached)".
 *   2. MERGING WHILE DETACHED. "Merge branch… → main" fast-forwards HEAD onto
 *      main's tip and toasts "Merged", but `main` itself never moves and HEAD
 *      stays detached — the panel looks identical before and after.
 *   3. PULL WHILE DETACHED IS HONEST. git refuses ("You are not currently on a
 *      branch"); that surfaces as a "Couldn't pull" toast (never the raw
 *      Electron IPC wrapper, #988) and nothing mutates.
 *   4. TRIPWIRE (#1382): the branch header must identify the commit HEAD sits on
 *      and/or warn that work committed here belongs to no branch. Today it
 *      renders the bare porcelain placeholder `(detached)`.
 *
 * Zero uncaught errors throughout.
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

/* NOTE: seed dir prefixes deliberately avoid the word "detached" — the panel's
 * root header prints the folder name, which would make the tripwire's
 * "does anything say we're off-branch?" scan pass vacuously. */

/** Local branches (real refs only) that contain the given rev. `git branch
 *  --contains` also prints the detached pseudo-entry "(HEAD detached from …)",
 *  which is not a branch — drop parenthesised lines. */
function branchesContaining(dir: string, rev: string): string[] {
  return git(dir, 'branch', '--format=%(refname:short)', '--contains', rev)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('('))
}

/**
 * A repo with two commits on `main`, then HEAD detached onto the FIRST one.
 * All git runs inside `prepare` (before the root is attached) so the app's git
 * watcher can't race the seed on `.git/index.lock`.
 */
async function seedDetached(window: Page, prefix: string): Promise<{ dir: string; sha: string }> {
  let sha = ''
  const dir = await seedProject(window, prefix, (d) => {
    identify(d)
    writeFileSync(join(d, 'alpha.txt'), 'v0\n')
    git(d, 'add', 'alpha.txt')
    git(d, 'commit', '-q', '-m', 'baseline')
    git(d, 'branch', '-M', 'main')
    writeFileSync(join(d, 'alpha.txt'), 'v1\n')
    git(d, 'commit', '-q', '-a', '-m', 'second commit on main')
    sha = git(d, 'rev-parse', '--short', 'HEAD~1').trim()
    git(d, 'checkout', '-q', 'HEAD~1')
  })
  return { dir, sha }
}

test.afterAll(() => cleanupSeeds())

test.describe('git — detached HEAD', () => {
  test('a commit made while detached lands on no branch, reported as an ordinary success', async ({
    window,
  }) => {
    const errors: string[] = []
    window.on('pageerror', (e) => errors.push(String(e)))

    const { dir, sha } = await seedDetached(window, 'flow-git-dh-commit-')
    // Fixture self-check: HEAD really is detached, on a known commit.
    // (`rev-parse --abbrev-ref HEAD` answers the literal "HEAD" when detached.)
    expect(git(dir, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('HEAD')
    expect(git(dir, 'rev-parse', '--short', 'HEAD').trim()).toBe(sha)

    await activateProject(window, dir)
    await openGitPanel(window)

    // The panel mounts and works — the branch slot names the STATE and the
    // commit (#1382 fixed: it used to print git's bare `(detached)`).
    await expect(window.locator('.gp-branch-name')).toHaveText(`detached HEAD at ${sha}`)
    await expect(window.locator('.gp-branch-name')).toHaveClass(/gp-branch-detached/)
    // No divergence badge: porcelain emits no `# branch.ab` while detached.
    await expect(window.locator('.gp-ahead-behind')).toHaveCount(0)

    writeFileSync(join(dir, 'notes.txt'), 'work done while detached\n')

    // Stage + commit are RETRIED to effect, not clicked once: the panel rebuilds
    // itself wholesale on every background git refresh (#1093/#1094), and a
    // rebuild landing between "row is visible" and "click" swallows the click
    // on the now-detached node. Retrying is a harness concession to that known,
    // already-filed behaviour — never a mask for the assertions below.
    await expect(async () => {
      const row = window
        .locator('.gp-row', { has: window.locator('.gp-name', { hasText: 'notes.txt' }) })
        .first()
      await expect(row).toBeVisible({ timeout: 5000 })
      const stage = row.locator('.gp-action-btn[title="Stage"]')
      if ((await stage.count()) > 0) await stage.click({ timeout: 5000 })
      await expect(window.locator('.gp-root')).toContainText('Staged Changes (1)', {
        timeout: 5000,
      })
    }).toPass({ timeout: 45000 })

    const SUBJECT = 'chore: work committed from a detached HEAD'
    const landed = (): boolean => git(dir, 'log', '-1', '--format=%s').trim() === SUBJECT
    await expect(async () => {
      // Short-circuit once the commit is in: a click that DID land clears the
      // staged set, so re-entering the click path would wait forever on a
      // correctly-disabled Commit button.
      if (landed()) return
      const msg = window.locator('.gp-commit-msg')
      await expect(msg).toBeVisible({ timeout: 5000 })
      await msg.fill(SUBJECT)
      const commit = window.locator('.gp-commit-btn')
      await expect(commit).toBeEnabled({ timeout: 5000 })
      await commit.click({ timeout: 5000 })
      await expect(async () => expect(landed()).toBe(true)).toPass({ timeout: 10000 })
    }).toPass({ timeout: 45000 })

    // The commit really landed…
    expect(landed()).toBe(true)

    // …and it is reachable from NO branch — reflog-only work.
    expect(branchesContaining(dir, 'HEAD')).toEqual([])
    expect(git(dir, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('HEAD')

    // The panel's feedback is the plain success path: box cleared, tree clean.
    await expect(window.locator('.gp-commit-msg')).toHaveValue('')
    await expect(window.locator('.gp-root')).toContainText('Working tree clean', {
      timeout: 15000,
    })
    await window.screenshot({ path: join(SHOTS, 'git-detached-head-committed.png') })

    expect(errors).toEqual([])
  })

    /**
   * SKIPPED 2026-09-04 — the control it drives was removed.
   *
   * Source Control's "Merge branch… / Pull" row was taken out on the user's
   * call: two buttons for operations nobody reaches for mid-review, sitting
   * between the branch line and the commit box. The detached-HEAD BEHAVIOUR
   * this asserts is unchanged in git and in the main process; there is simply
   * no button left to press it with, so the spec is kept as the record of what
   * that behaviour was and the thing to un-skip if the row ever returns.
   *
   * (It was already failing before the removal — see the baseline note in the
   * header — so this is not hiding a regression.)
   */
test.skip('Merge branch… while detached moves HEAD but never the branch it merged', async ({
    window,
  }) => {
    const errors: string[] = []
    window.on('pageerror', (e) => errors.push(String(e)))

    const { dir } = await seedDetached(window, 'flow-git-dh-merge-')
    await activateProject(window, dir)
    await openGitPanel(window)

    const headBefore = git(dir, 'rev-parse', 'HEAD').trim()
    const mainBefore = git(dir, 'rev-parse', 'main').trim()
    expect(headBefore).not.toBe(mainBefore)

    // Same rebuild concession as above (#1093/#1094): re-open the picker if a
    // background refresh closed it, and retry the row click until the merge
    // actually reports.
    const toast = window.locator('.fl-flow-toast').filter({ hasText: 'Merged' })
    await expect(async () => {
      // Short-circuit once HEAD has moved — a merge that landed must not be
      // re-driven just because its toast was missed.
      if (git(dir, 'rev-parse', 'HEAD').trim() === mainBefore) return
      if ((await window.locator('.gp-branch-picker').count()) === 0) {
        await window.locator('.gp-git-action-btn', { hasText: 'Merge branch…' }).click()
      }
      const branchRow = window.locator('.gp-branch-picker .gp-name', { hasText: 'main' }).first()
      await expect(branchRow).toBeVisible({ timeout: 5000 })
      await branchRow.click({ timeout: 5000 })
      await expect(toast).toBeVisible({ timeout: 5000 })
    }).toPass({ timeout: 45000 })
    await window.screenshot({ path: join(SHOTS, 'git-detached-head-merged.png') })

    // HEAD fast-forwarded onto main's tip…
    await expect(async () => {
      expect(git(dir, 'rev-parse', 'HEAD').trim()).toBe(mainBefore)
    }).toPass({ timeout: 15000 })
    // …`main` itself never moved, and HEAD is still detached.
    expect(git(dir, 'rev-parse', 'main').trim()).toBe(mainBefore)
    expect(git(dir, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('HEAD')
    // The panel reads exactly as it did before the merge.
    await expect(window.locator('.gp-branch-name')).toHaveText(/^detached HEAD at [0-9a-f]{7}$/)

    expect(errors).toEqual([])
  })

    /**
   * SKIPPED 2026-09-04 — the control it drives was removed.
   *
   * Source Control's "Merge branch… / Pull" row was taken out on the user's
   * call: two buttons for operations nobody reaches for mid-review, sitting
   * between the branch line and the commit box. The detached-HEAD BEHAVIOUR
   * this asserts is unchanged in git and in the main process; there is simply
   * no button left to press it with, so the spec is kept as the record of what
   * that behaviour was and the thing to un-skip if the row ever returns.
   *
   * (It was already failing before the removal — see the baseline note in the
   * header — so this is not hiding a regression.)
   */
test.skip("Pull while detached reports git's own reason and mutates nothing", async ({ window }) => {
    const errors: string[] = []
    window.on('pageerror', (e) => errors.push(String(e)))

    const { dir } = await seedDetached(window, 'flow-git-dh-pull-')
    await activateProject(window, dir)
    await openGitPanel(window)

    const headBefore = git(dir, 'rev-parse', 'HEAD').trim()

    const pull = window.locator('.gp-git-action-btn', { hasText: 'Pull' })
    await expect(pull).toBeVisible()
    await pull.click()

    const toast = window.locator('.fl-flow-toast').filter({ hasText: "Couldn't pull" })
    await expect(toast).toBeVisible({ timeout: 15000 })
    // Feedback, not silence — and never the raw Electron IPC wrapper (#988).
    await expect(toast).not.toContainText('Error invoking remote method')

    // Safe: a refused pull changes nothing.
    expect(git(dir, 'rev-parse', 'HEAD').trim()).toBe(headBefore)
    expect(git(dir, 'status', '--porcelain').trim()).toBe('')

    expect(errors).toEqual([])
  })

  // ── Tripwire ──────────────────────────────────────────────────────────────
  test.fixme(
    '#1382 — Source Control says WHERE a detached HEAD is, and that commits there are off-branch',
    async ({ window }) => {
      const { dir, sha } = await seedDetached(window, 'flow-git-dh-tripwire-')
      await activateProject(window, dir)
      await openGitPanel(window)
      await window.screenshot({ path: join(SHOTS, 'git-detached-head-header.png') })

      // (a) The branch slot must not read like an ordinary branch name: it has
      //     to identify the commit HEAD is on. `(detached)` alone says neither.
      const shown = (await window.locator('.gp-branch-name').innerText()).trim()
      expect(shown, 'the branch header must name the commit HEAD is detached at').toContain(sha)

      // (b) Committing there must carry an off-branch signal SOMEWHERE outside
      //     the branch slot — a commit no branch contains is reflog-only work.
      writeFileSync(join(dir, 'notes.txt'), 'work done while detached\n')
      const row = window
        .locator('.gp-row', { has: window.locator('.gp-name', { hasText: 'notes.txt' }) })
        .first()
      await expect(row).toBeVisible({ timeout: 15000 })
      await row.locator('.gp-action-btn[title="Stage"]').click()
      await window.locator('.gp-commit-msg').fill('chore: work committed from a detached HEAD')
      await window.locator('.gp-commit-btn').click()
      await expect(window.locator('.gp-commit-msg')).toHaveValue('', { timeout: 15000 })
      expect(branchesContaining(dir, 'HEAD')).toEqual([])

      // Everything the panel says EXCEPT the branch slot (whose "(detached)"
      // would otherwise make this pass vacuously), plus any toast.
      const panel = await window.locator('.gp-root').innerText()
      const header = await window.locator('.gp-branch-name').innerText()
      const toasts = (await window.locator('.fl-flow-toast').allInnerTexts()).join('\n')
      const said = `${panel.split(header).join(' ')}\n${toasts}`.toLowerCase()
      expect(
        /detach|no branch|not on a branch|reflog|unreachable/.test(said),
        `nothing outside the branch slot says the commit landed off-branch:\n${said}`,
      ).toBe(true)
    },
  )
})
