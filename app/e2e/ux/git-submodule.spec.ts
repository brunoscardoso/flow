/**
 * UX sweep — flow `git` (rotation index 6, round 25): the Source Control panel
 * against a repo containing a **git submodule**, the repo shape 34 prior git
 * specs never used as a subject.
 *
 * Every existing git spec seeds a repo of ordinary files (plus, over the rounds,
 * a rename, a delete, a chmod, a merge conflict, a detached HEAD, multi-root,
 * 40-file scale). Nobody had asked what the panel does with a **gitlink** — the
 * `160000`-mode entry a submodule occupies in the tree. Real users hit it
 * constantly: vendored deps, shared design systems, `themes/` in a static site.
 *
 * What git reports when a submodule's checked-out commit differs from the one
 * the superproject records:
 *
 *     $ git status --porcelain=v2 --branch -z
 *     1 .M SC.. 160000 160000 160000 <hash> <hash> vendor/lib
 *                ^^^^                 ^^^^^^ the <sub> field says "S" = submodule
 *
 * `parsePorcelainV2Status` (git-manager.ts:245-256) reads `<XY>` and the path and
 * DROPS the `<sub>` field, so the entry becomes an ordinary `modified` change —
 * indistinguishable downstream from a text file. The panel then offers it the
 * file affordances: click-to-diff, Stage, and Discard changes.
 *
 * Two of those three are not files at all:
 *
 *   - the diff reads the path as bytes (`readWorkingTreeFileBytes`,
 *     git-manager.ts:753) and a submodule path is a DIRECTORY → EISDIR;
 *   - discard runs `git checkout -- <path>` (`discardWorktreeChanges`,
 *     git-manager.ts:1236), which for a gitlink exits 0 and changes nothing —
 *     resetting a submodule needs `git submodule update`.
 *
 * Guards here (account-independent — git only, no agent, no network; every
 * precondition built with real git before the root is attached):
 *
 *   1. LIVE — the submodule IS surfaced. The panel lists `vendor/lib` under
 *      Changes with an `M`, so the user is told something changed.
 *   2. LIVE — Stage + Commit work. The pointer bump is a legitimate commit and
 *      the app makes it correctly; the tree goes clean afterwards.
 *   3. LIVE — nothing is destroyed by the discard attempt: the submodule's own
 *      working tree and its commit survive (the no-op is at least safe).
 *   4. TRIPWIRE (#1479) — clicking the row must show something about the
 *      submodule, not fail. MEASURED today: 0 diff overlays and a red toast
 *      reading `vendor/lib — fatal: bad object HEAD:vendor/lib` — git's own
 *      plumbing error, because `HEAD:<gitlink>` names a commit that lives in the
 *      SUBMODULE's object store. (The worktree side would then hit EISDIR; the
 *      HEAD side just throws first.) Raw-error leakage has precedent here: #988.
 *   5. TRIPWIRE (#1478) — "Discard changes" must either reset the submodule or
 *      refuse. MEASURED today: the confirm reads verbatim `Discard changes in
 *      vendor/lib? This can't be undone.`, and after accepting it the panel text,
 *      `git status --porcelain=v2` and the submodule's HEAD are all byte-identical,
 *      with ZERO toasts. `git checkout -- <gitlink>` exits 0 and does nothing.
 *
 * Zero uncaught errors throughout.
 *
 * HARNESS NOTES (each cost a wrong reading first):
 *  - `git submodule add` over a local path needs `-c protocol.file.allow=always`
 *    on git ≥ 2.38 (CVE-2022-39253) or it refuses with "transport 'file' not
 *    allowed" — the seed silently produced a repo with NO submodule.
 *  - File rows live in `fl-list`'s OPEN shadow DOM: `.gp-root` innerText carries
 *    section headers but NO file names. Assert rows with `.gp-row` / `.gp-name`
 *    locators (Playwright pierces open shadow roots), never a text substring.
 *  - `.gp-name` holds only the BASENAME (`lib`); the directory prefix is a
 *    sibling `.gp-dir`. The whole path is on the row's `title`, so
 *    `.gp-row[title="vendor/lib"]` is the stable handle.
 *  - Discard is a `window.confirm` — accept it via a `dialog` listener.
 *  - A freshly seeded project raises the "Run a basic discovery?" card, which is
 *    an `fl-button`-based overlay in the SAME bottom-right corner as the toast
 *    stack: the error toast is `visibility: visible` with `opacity: 1` and still
 *    hit-tests to `fl-learn-body`. Screenshot evidence needs it dismissed first
 *    (`fl-button` hasText "Not now" — a plain `button` locator never matches).
 */
import { test, expect, type Page } from '../fixtures/electron'
import { seedProject, activateProject, cleanupSeeds, removeTempDir } from './fixtures/seed'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SHOTS = join(__dirname, '__screens')

/** The submodule's path inside the superproject. */
const SUB = 'vendor/lib'

function git(dir: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: dir }).toString()
}

function identify(dir: string): void {
  git(dir, 'config', 'user.email', 'qa@flow.test')
  git(dir, 'config', 'user.name', 'QA Bot')
}

/** Standalone repos created for use AS submodules (cleaned up in afterAll). */
const upstreamDirs: string[] = []

/** A two-commit repo to be embedded as a submodule. Returns its path + shas. */
function makeUpstream(): { dir: string; first: string; second: string } {
  const dir = mkdtempSync(join(tmpdir(), 'flow-git-upstream-'))
  upstreamDirs.push(dir)
  git(dir, 'init', '-q', '.')
  identify(dir)
  writeFileSync(join(dir, 'libfile.txt'), 'v0\n')
  git(dir, 'add', '-A')
  git(dir, 'commit', '-q', '-m', 'lib v0')
  const first = git(dir, 'rev-parse', 'HEAD').trim()
  writeFileSync(join(dir, 'libfile.txt'), 'v1\n')
  git(dir, 'commit', '-q', '-a', '-m', 'lib v1')
  const second = git(dir, 'rev-parse', 'HEAD').trim()
  return { dir, first, second }
}

/**
 * A superproject whose submodule `vendor/lib` is checked out at a DIFFERENT
 * commit than the one recorded in HEAD — git's "modified content / new commits"
 * state, the everyday shape after `git pull` inside a submodule.
 */
async function seedSuperproject(
  window: Page,
  prefix: string,
): Promise<{ dir: string; recorded: string; checkedOut: string }> {
  const upstream = makeUpstream()
  const dir = await seedProject(window, prefix, (d) => {
    identify(d)
    writeFileSync(join(d, 'README.md'), 'superproject\n')
    git(d, 'add', '-A')
    git(d, 'commit', '-q', '-m', 'baseline')
    git(d, 'branch', '-M', 'main')
    // Local-path submodules are refused by default since git 2.38 (CVE-2022-39253).
    git(d, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', upstream.dir, SUB)
    git(d, 'commit', '-q', '-m', 'add vendor/lib submodule')
    // Move the submodule's own HEAD back one commit → superproject sees `.M`.
    git(join(d, SUB), 'checkout', '-q', upstream.first)
  })
  return { dir, recorded: upstream.second, checkedOut: upstream.first }
}

/** The gitlink the superproject's HEAD records for the submodule. */
function recordedGitlink(dir: string): string {
  return git(dir, 'rev-parse', 'HEAD:vendor/lib').trim()
}

/** The commit the submodule's working tree is actually on. */
function checkedOutGitlink(dir: string): string {
  return git(join(dir, SUB), 'rev-parse', 'HEAD').trim()
}

/** Reveal Source Control → Changes and wait for the git panel to mount + load. */
async function openGitPanel(window: Page): Promise<void> {
  await window.locator('.fl-activity-bar .fl-rail-item[aria-label="Source Control"]').click()
  await window.locator('.fl-sc-viewbtn', { hasText: 'Changes' }).click()
  await expect(window.locator('.gp-root')).toBeVisible()
  await expect(window.locator('.gp-branch-name')).toBeVisible({ timeout: 10000 })
}

/** The submodule's row in the panel (title carries the full repo-relative path). */
function subRow(window: Page) {
  return window.locator(`.gp-row[title="${SUB}"]`).first()
}

test.afterAll(() => {
  cleanupSeeds()
  while (upstreamDirs.length) {
    const dir = upstreamDirs.pop()
    if (dir) removeTempDir(dir)
  }
})

test.describe('git — submodule', () => {
  test('a submodule with a moved HEAD is listed, stageable and committable', async ({ window }) => {
    const errors: string[] = []
    window.on('pageerror', (e) => errors.push(String(e)))

    const { dir, recorded, checkedOut } = await seedSuperproject(window, 'flow-git-sub-commit-')
    // Fixture self-check: the submodule really exists and really diverges.
    expect(recordedGitlink(dir)).toBe(recorded)
    expect(checkedOutGitlink(dir)).toBe(checkedOut)
    expect(recorded).not.toBe(checkedOut)

    await activateProject(window, dir)
    await openGitPanel(window)

    // 1. The change IS surfaced — the user is told the submodule moved.
    await expect(window.locator('.gp-root')).toContainText('Changes (1)', { timeout: 15000 })
    await expect(subRow(window)).toBeVisible()
    await expect(subRow(window).locator('.gp-name')).toHaveText('lib')
    await expect(subRow(window).locator('.gp-letter')).toHaveText('M')
    await window.screenshot({ path: join(SHOTS, 'git-submodule-listed.png') })

    // 2. Stage + commit the pointer bump. Retried to effect, not clicked once:
    // the panel rebuilds wholesale on every background refresh (#1093/#1094)
    // and a rebuild between "visible" and "click" swallows the click.
    await expect(async () => {
      const stage = subRow(window).locator('.gp-action-btn[title="Stage"]')
      if ((await stage.count()) > 0) await stage.click({ timeout: 5000 })
      await expect(window.locator('.gp-root')).toContainText('Staged Changes (1)', {
        timeout: 5000,
      })
    }).toPass({ timeout: 45000 })

    const SUBJECT = 'chore: bump vendor/lib'
    const landed = (): boolean => git(dir, 'log', '-1', '--format=%s').trim() === SUBJECT
    await expect(async () => {
      if (landed()) return // a click that DID land clears the staged set
      const msg = window.locator('.gp-commit-msg')
      await expect(msg).toBeVisible({ timeout: 5000 })
      await msg.fill(SUBJECT)
      const commit = window.locator('.gp-commit-btn')
      await expect(commit).toBeEnabled({ timeout: 5000 })
      await commit.click({ timeout: 5000 })
      await expect(async () => expect(landed()).toBe(true)).toPass({ timeout: 10000 })
    }).toPass({ timeout: 45000 })

    // The commit records the gitlink the submodule is actually on — correct.
    expect(landed()).toBe(true)
    expect(recordedGitlink(dir)).toBe(checkedOut)
    await expect(window.locator('.gp-root')).toContainText('Working tree clean', { timeout: 15000 })
    await window.screenshot({ path: join(SHOTS, 'git-submodule-committed.png') })

    expect(errors).toEqual([])
  })

  test('discarding a submodule resets the pointer and destroys nothing inside it', async ({ window }) => {
    const errors: string[] = []
    window.on('pageerror', (e) => errors.push(String(e)))
    window.on('dialog', (d) => void d.accept())

    const { dir, recorded, checkedOut } = await seedSuperproject(window, 'flow-git-sub-safe-')
    await activateProject(window, dir)
    await openGitPanel(window)
    await expect(subRow(window)).toBeVisible({ timeout: 15000 })

    await expect(async () => {
      const discard = subRow(window).locator('.gp-action-btn[title="Discard changes"]')
      await expect(discard).toHaveCount(1, { timeout: 5000 })
      await discard.click({ timeout: 5000 })
    }).toPass({ timeout: 30000 })
    await window.waitForTimeout(3000)

    // #1478: this guard was written against the no-op, so it asserted the
    // submodule's HEAD never moved — which was the BUG's side effect, not the
    // contract. Discarding a moved pointer is supposed to put it back. What must
    // still hold is that nothing is DESTROYED: the submodule lands exactly on the
    // commit this repo records, its work tree is clean rather than clobbered, and
    // the commit it was sitting on is still in its history.
    await expect(async () => expect(checkedOutGitlink(dir)).toBe(recorded)).toPass({
      timeout: 15000,
    })
    expect(git(join(dir, SUB), 'status', '--porcelain')).toBe('')
    expect(git(join(dir, SUB), 'cat-file', '-t', checkedOut).trim()).toBe('commit')
    await window.screenshot({ path: join(SHOTS, 'git-submodule-after-discard.png') })

    expect(errors).toEqual([])
  })

  test(
    'clicking a submodule row opens something about the submodule, not an EISDIR failure',
    async ({ window }) => {
      const errors: string[] = []
      window.on('pageerror', (e) => errors.push(String(e)))

      const { dir } = await seedSuperproject(window, 'flow-git-sub-diff-')
      await activateProject(window, dir)
      await openGitPanel(window)
      await expect(subRow(window)).toBeVisible({ timeout: 15000 })

      await subRow(window).locator('.gp-name').click()

      // Either a diff overlay opens, or a toast explains the submodule in the
      // user's terms. What must NOT happen is a raw filesystem error.
      const toast = window.locator('.fl-flow-toast')
      // .gd-overlay is the diff surface this panel actually opens (diff-view.ts).
      // The original selector named a class that exists nowhere — harmless while
      // this click could only ever produce an error toast, load-bearing now.
      const overlay = window.locator('.gd-overlay')
      await expect(async () => {
        expect((await toast.count()) + (await overlay.count())).toBeGreaterThan(0)
      }).toPass({ timeout: 15000 })
      const toastText = (await toast.count()) > 0 ? await toast.first().innerText() : ''
      await window.screenshot({ path: join(SHOTS, 'git-submodule-diff-click.png') })

      expect(toastText).not.toMatch(/EISDIR|illegal operation on a directory/i)
      expect(toastText).not.toMatch(/Could not open diff/i)
      expect(toastText).not.toMatch(/fatal:|bad object/i)
      // Non-vacuous: something opened AND it describes the pointer move, in the
      // user's terms, naming both ends of it.
      if ((await overlay.count()) > 0) {
        const body = await overlay.first().innerText()
        expect(body).toMatch(/submodule/i)
        expect(body).toMatch(/Subproject commit|→/)
      }
      expect(errors).toEqual([])
    },
  )

  test(
    'Discard changes on a submodule either resets it or refuses — never a silent no-op',
    async ({ window }) => {
      const errors: string[] = []
      window.on('pageerror', (e) => errors.push(String(e)))
      const dialogs: string[] = []
      window.on('dialog', (d) => {
        dialogs.push(d.message())
        void d.accept()
      })

      const { dir, recorded, checkedOut } = await seedSuperproject(window, 'flow-git-sub-discard-')
      await activateProject(window, dir)
      await openGitPanel(window)
      await expect(subRow(window)).toBeVisible({ timeout: 15000 })

      await expect(async () => {
        const discard = subRow(window).locator('.gp-action-btn[title="Discard changes"]')
        await expect(discard).toHaveCount(1, { timeout: 5000 })
        await discard.click({ timeout: 5000 })
        expect(dialogs.length).toBeGreaterThan(0)
      }).toPass({ timeout: 30000 })
      await window.waitForTimeout(3000)

      const toastText = (await window.locator('.fl-flow-toast').count())
        ? await window.locator('.fl-flow-toast').first().innerText()
        : ''
      await window.screenshot({ path: join(SHOTS, 'git-submodule-discard-noop.png') })

      // The user confirmed a destructive-sounding action. Either it happened
      // (submodule back on the recorded commit) or the app said it couldn't.
      const reset = checkedOutGitlink(dir) === recorded
      const refused = /couldn'?t|can'?t|submodule|failed/i.test(toastText)
      expect(reset || refused, `still on ${checkedOut}, toast: ${toastText || '(none)'}`).toBe(true)
      expect(errors).toEqual([])
    },
  )
})
