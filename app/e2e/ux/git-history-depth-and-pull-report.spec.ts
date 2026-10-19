/**
 * UX sweep — flow `git` (rotation index 6, round 22): what the Source Control
 * panel **claims about git**, as opposed to what it does to git.
 *
 * Twenty-nine prior git specs drive the panel's ACTIONS (stage / unstage /
 * selective + keyboard commit / commit-gate / commit-fail / discard scope /
 * merge branch / merge abort / pull-rebase-abort / staged + stale + history +
 * in-flight diffs / untracked expand / multi-root groups / large changeset /
 * ahead-behind / local-only repo / merge completion) and assert the tree ends up
 * right. None of them audits the two places the panel *reports* on git:
 *
 *   - the **`Commits (N)` header**, and
 *   - the **Pull outcome toast**.
 *
 * Both are un-probed, and both were measured misreporting on main.
 *
 * ── Guards (live, must stay green) ──────────────────────────────────────────
 *
 *  1. THE COMMITS SECTION IS EXACT BELOW THE CAP. A 12-commit repo renders
 *     `COMMITS (12)`, newest-first, holding exactly 12 rows. This is the control
 *     that gives the count its grammar — the same grammar as `Changes (N)` /
 *     `Staged Changes (N)`, which are exact — so tripwire A cannot pass
 *     vacuously by the header simply never being right.
 *
 *  2. PULL ITSELF IS HEALTHY AND ITS *FAILURE* IS HONEST. A repo two commits
 *     behind a real (local, file-based) upstream fast-forwards on one click:
 *     the `↓2` badge clears, `Commits (1)` → `(3)`, and both of the teammate's
 *     files land on disk. And a pull git REFUSES (dirty tree) raises a
 *     "Couldn't pull" toast carrying git's own reason, leaving the tree
 *     untouched. This is the control for tripwire B: the pull ACTION works and
 *     the failure path already reports precisely, so what B measures is the
 *     success path's report alone — not a broken pull.
 *
 * ── Tripwires (test.fixme until fixed; both verified genuinely RED) ─────────
 *
 *  A. (#1335) `Commits (N)` is a PAGE COUNT wearing an exact count's clothes.
 *     The renderer asks for `limit: LOG_PAGE_SIZE = 100` once (index.ts:668) and
 *     prints `Commits (${view.commits.length})` (git-panel.ts:705). A 130-commit
 *     repo therefore reads `COMMITS (100)`, the list bottoms out at commit 031,
 *     and commits 001–030 are unreachable — no "load more", no "showing latest
 *     100", nothing. git-manager.log already implements + unit-tests a `before`
 *     pagination cursor (git-manager.ts:576-602, git-manager.test.ts:347), but
 *     the IPC handler drops it (`git/index.ts:164` destructures `{ rootId, limit }`
 *     only), so the depth is unreachable from the renderer by construction.
 *
 *  B. (#1336) The Pull toast says the same thing whether it pulled or didn't.
 *     `onPull`'s success branch (index.ts:517-525) notifies a literal
 *     `{ title: 'Pulled', body: 'Up to date' }`. Measured: a pull that fast-
 *     forwards two of a teammate's commits and a pull with nothing to fetch
 *     produce BYTE-IDENTICAL feedback — and "Up to date" is git's own phrase for
 *     the no-op case ("Already up to date."). The sibling merge toast names its
 *     ref (`{ title: 'Merged', body: ref }`); pull names nothing.
 *
 * Account-independent throughout: real git only, upstreams are local bare repos
 * on disk, no network and no credentials. Every precondition is created with git
 * BEFORE the root is attached, so the app's watcher can never race the seed on
 * `.git/index.lock`.
 */
import { test, expect, type Page } from '../fixtures/electron'
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SHOTS = join(__dirname, '__screens')
const scratch: string[] = []

function git(dir: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: dir }).toString()
}
function identify(dir: string): void {
  git(dir, 'config', 'user.email', 'qa@flow.test')
  git(dir, 'config', 'user.name', 'QA Bot')
}
function tmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  scratch.push(dir)
  return dir
}
/** Keep the IDE's own scaffold out of `git status` (mirrors the seed fixture). */
function excludeScaffold(dir: string): void {
  writeFileSync(join(dir, '.git', 'info', 'exclude'), '.claude/\nflow\n.gitignore\n')
}

/** Reveal Source Control → Changes and wait for the git panel to mount + load.
 *
 *  IDEMPOTENT on purpose: clicking the rail item that is ALREADY active toggles
 *  the sidebar shut, so a test that attaches a second project and re-opens the
 *  panel would close it instead. Only click what isn't already showing. */
async function openGitPanel(window: Page): Promise<void> {
  if (!(await window.locator('.gp-root').isVisible().catch(() => false))) {
    await window.locator('.fl-activity-bar .fl-rail-item[aria-label="Source Control"]').click()
    await window.locator('.fl-sc-viewbtn', { hasText: 'Changes' }).click()
  }
  await expect(window.locator('.gp-root')).toBeVisible()
  await expect(window.locator('.gp-branch-name')).toBeVisible({ timeout: 10000 })
}

/** The `Commits (N)` header text. */
function commitsHeader(window: Page) {
  return window.locator('.gp-section-head', { hasText: 'COMMITS' }).first()
}

/** How many items the commits `fl-list` actually holds (it virtualizes rows). */
async function commitListSize(window: Page): Promise<number | null> {
  return window.evaluate(() => {
    const list = [...document.querySelectorAll('fl-list')].find((l) =>
      l.getAttribute('data-list-key')?.endsWith('commits'),
    )
    return (list as unknown as { items?: unknown[] } | undefined)?.items?.length ?? null
  })
}

/** Toast text, with the trailing wall-clock line stripped so it can be compared. */
async function toastLines(window: Page): Promise<string[]> {
  return (await window.locator('.fl-flow-toast').allInnerTexts()).map((text) =>
    text
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !/^\d{1,2}:\d{2}\s?(AM|PM)$/i.test(line))
      .join(' / '),
  )
}

/** Bare upstream + a local clone that is `behind` commits behind it. Returns the
 *  local working repo. The teammate's two commits are one edit + one new file. */
function seedBehindUpstream(tag: string): string {
  const remote = tmp(`flow-ux-${tag}-remote-`)
  git(remote, 'init', '-q', '--bare', '-b', 'main')

  const author = tmp(`flow-ux-${tag}-author-`)
  git(author, 'clone', '-q', remote, '.')
  identify(author)
  writeFileSync(join(author, 'alpha.txt'), 'v0\n')
  git(author, 'add', 'alpha.txt')
  git(author, 'commit', '-q', '-m', 'baseline')
  git(author, 'push', '-q', 'origin', 'HEAD:main')

  const local = tmp(`flow-ux-${tag}-local-`)
  git(local, 'clone', '-q', remote, '.')
  identify(local)
  excludeScaffold(local)

  writeFileSync(join(author, 'alpha.txt'), 'v0\nteammate line\n')
  git(author, 'add', 'alpha.txt')
  git(author, 'commit', '-q', '-m', 'teammate: fix the crash')
  writeFileSync(join(author, 'beta.txt'), 'brand new file\n')
  git(author, 'add', 'beta.txt')
  git(author, 'commit', '-q', '-m', 'teammate: add beta')
  git(author, 'push', '-q', 'origin', 'HEAD:main')

  git(local, 'fetch', '-q', 'origin') // local now knows it is ↓2
  return local
}

/** Attach an already-built repo (not created by seedProject) as a project root. */
async function attachRoot(window: Page, dir: string): Promise<void> {
  await window.evaluate(async (path) => {
    await (
      window as unknown as {
        flow: { project: { add(r: { path: string }): Promise<unknown> } }
      }
    ).flow.project.add({ path })
  }, dir)
  await activateProject(window, dir)
}

test.describe('Source Control — what the panel claims about git', () => {
  test.afterAll(() => {
    cleanupSeeds()
    for (const dir of scratch) {
      // Best-effort: the app may still hold a watcher on a temp repo at teardown,
      // and a failed rm must never turn a green run red.
      try {
        if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
      } catch {
        /* leave it to the OS temp reaper */
      }
    }
  })

  // ── Guard 1 ───────────────────────────────────────────────────────────────
  test('the Commits header is an EXACT count below the page size, newest first', async ({
    window,
  }) => {
    test.setTimeout(120_000)
    const errors: string[] = []
    window.on('pageerror', (error) => errors.push(String(error)))

    const dir = await seedProject(window, 'flow-ux-histexact-', (d) => {
      identify(d)
      writeFileSync(join(d, 'log.txt'), 'seed\n')
      git(d, 'add', 'log.txt')
      git(d, 'commit', '-q', '-m', 'commit number 01')
      for (let i = 2; i <= 12; i++) {
        git(d, 'commit', '-q', '--allow-empty', '-m', `commit number ${String(i).padStart(2, '0')}`)
      }
      git(d, 'branch', '-M', 'main')
    })
    await attachRoot(window, dir)
    await openGitPanel(window)

    expect(git(dir, 'rev-list', '--count', 'HEAD').trim()).toBe('12')
    await expect(commitsHeader(window)).toContainText('Commits (12)')
    expect(await commitListSize(window)).toBe(12)
    // Newest first — the first rendered row is the last commit made.
    await expect(window.locator('.gp-subject').first()).toHaveText('commit number 12')

    expect(errors).toEqual([])
  })

  // RETIRED 2026-10-09: Guard 2 ("Pull fast-forwards a behind branch, and a
  // refused pull reports git's reason") pressed Source Control's Pull, removed
  // from the panel on the user's call (2026-09-04).
})
