/**
 * UX sweep — flow `git` (rotation index 6, round 24): what happens to the commit
 * history *after* you page it in.
 *
 * Round 22 filed #1335 ("`Commits (100)` is a page size wearing an exact count's
 * clothes") and it shipped: the IPC boundary now forwards the `before` cursor,
 * the header says `Commits · latest 100` while the window is a page, and a
 * `Load older commits` button appends the next page. Thirty-plus git specs drive
 * the panel's ACTIONS and the round-22 spec audits the header BELOW the page cap
 * (12 commits) — deliberately staying under it. **Nothing drives what happens to
 * a paged-in window once an ordinary panel refresh lands**, and nothing drives
 * the button on a history that is exactly one page long.
 *
 * ── Guards (live, must stay green) ──────────────────────────────────────────
 *
 *  1. PAGING ITSELF WORKS. A 130-commit repo opens on `Commits · latest 100`
 *     holding 100 rows with a `Load older commits` button; one click appends the
 *     remaining 30, the header becomes the exact `Commits (130)`, the oldest
 *     commit (`commit number 001`) is in the list, and the button retires. This
 *     is the control for tripwire A — the feature it says is undone must first
 *     be shown to work.
 *
 *  2. STAGING REALLY REFRESHES THE PANEL. In the same repo, staging the one
 *     modified file moves it from `Changes` to `Staged Changes`. That is the
 *     control for tripwire A's *trigger*: the refresh path demonstrably fires on
 *     an ordinary click, so a collapse measured after it is caused by the
 *     refresh, not by a dead button.
 *
 * ── Tripwires (fixed in #1438 / #1439; live guards now) ─────────────────────
 *
 *  A. (#1439) A PAGED-IN WINDOW IS SILENTLY THROWN AWAY BY THE NEXT REFRESH. The
 *     renderer tries to preserve it — `refreshRoot` asks for
 *     `Math.max(LOG_PAGE_SIZE, loadedCommits)` with the comment "a refresh
 *     re-reads AT LEAST as many commits as the user has paged in, so loading
 *     older history isn't undone by the next git event" (renderer/git/index.ts).
 *     But the main process clamps every `log` request to `DEFAULT_LOG_LIMIT`
 *     (= 100, the same number as `LOG_PAGE_SIZE`): `clampLimit` is
 *     `Math.min(Math.floor(limit), DEFAULT_LOG_LIMIT)` (main/git/git-manager.ts).
 *     So `wanted` can never exceed one page and the guarantee is void. Measured:
 *     after paging to 130, one ordinary Stage click drops the list back to 100
 *     and the header back to `Commits · latest 100`, with no notice. Every
 *     refresh trigger does it — stage, unstage, discard, commit, resolve,
 *     project switch, and the `.git` watcher.
 *
 *  B. (#1438) `Load older commits` IS A PERMANENT DEAD CLICK WHEN THE HISTORY IS EXACTLY
 *     ONE PAGE. `commitLogWindow` infers "there may be more" from
 *     `loaded % pageSize === 0`, so a repo with exactly 100 commits (or 200,
 *     300 …) offers the button. Clicking it asks for the page before the ROOT
 *     commit, git returns nothing, and `onLoadOlderCommits` just re-renders:
 *     no rows appended, no toast — the button sits there inviting the same
 *     nothing (and, per tripwire C, latches disabled on the way).
 *
 *  C. (#1438) PAGING IS A ONE-SHOT. `GitPanel.#loadingOlderCommits` is set true by the
 *     click and cleared in exactly one place — `setRoots()`, which NOTHING in
 *     production calls: the coordinator's `render()` goes through `setState()`
 *     (renderer/git/index.ts). So the flag latches true for the panel's
 *     lifetime and every later render draws
 *     `<button disabled class="gp-load-older">Loading…</button>`. Measured on a
 *     250-commit repo: one click reaches `Commits · latest 200`, and the button
 *     that should carry you to the last 50 is already dead — 33 polls over 15 s
 *     all resolved to the disabled "Loading…" element. Together with A this is
 *     the whole bug: refresh collapses you back to 100 AND the route out is
 *     now disabled, so history past the 100th commit is unreachable until the
 *     window is reloaded.
 *
 * Account-independent throughout: real git only, no network, no credentials.
 * Every commit is created BEFORE the root is attached so the app's watcher can
 * never race the seed on `.git/index.lock`.
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

/** A repo with exactly `commits` commits on `main`, plus one modified tracked
 *  file in the working tree so the panel has something to stage. */
async function seedHistory(window: Page, prefix: string, commits: number): Promise<string> {
  return seedProject(window, prefix, (dir) => {
    git(dir, 'config', 'user.email', 'qa@flow.test')
    git(dir, 'config', 'user.name', 'QA Bot')
    writeFileSync(join(dir, 'log.txt'), 'seed\n')
    git(dir, 'add', 'log.txt')
    git(dir, 'commit', '-q', '-m', 'commit number 001')
    for (let i = 2; i <= commits; i += 1) {
      git(dir, 'commit', '-q', '--allow-empty', '-m', `commit number ${String(i).padStart(3, '0')}`)
    }
    git(dir, 'branch', '-M', 'main')
    // An uncommitted tracked edit — the Stage click that triggers the refresh.
    writeFileSync(join(dir, 'log.txt'), 'seed\nedited by the user\n')
  })
}

/** Reveal Source Control → Changes and wait for the git panel to mount + load.
 *  Idempotent: clicking an already-active rail item would toggle the sidebar shut. */
async function openGitPanel(window: Page): Promise<void> {
  if (!(await window.locator('.gp-root').isVisible().catch(() => false))) {
    await window.locator('.fl-activity-bar .fl-rail-item[aria-label="Source Control"]').click()
    await window.locator('.fl-sc-viewbtn', { hasText: 'Changes' }).click()
  }
  await expect(window.locator('.gp-root')).toBeVisible()
  await expect(window.locator('.gp-branch-name')).toBeVisible({ timeout: 15000 })
}

/** The commits section label as authored (textContent — CSS uppercases it). */
async function commitsHeaderText(window: Page): Promise<string> {
  return window.evaluate(() => {
    const head = [...document.querySelectorAll('.gp-section-head')].find((el) =>
      /commits/i.test(el.textContent ?? ''),
    )
    return (head?.textContent ?? '').trim()
  })
}

/** The subjects the commits `fl-list` actually holds (it virtualizes rows). */
async function commitSubjects(window: Page): Promise<string[]> {
  return window.evaluate(() => {
    const list = [...document.querySelectorAll('fl-list')].find((l) =>
      l.getAttribute('data-list-key')?.endsWith('commits'),
    )
    const items = (list as unknown as { items?: Array<{ subject?: string }> } | undefined)?.items
    return (items ?? []).map((item) => item.subject ?? '')
  })
}

/** File-row names under one section title, read out of the panel's open shadow DOM. */
function sectionRowNames(window: Page, section: 'staged' | 'changes'): Promise<string[]> {
  return window.evaluate((key) => {
    const list = [...document.querySelectorAll('fl-list')].find(
      (l) => l.getAttribute('data-section') === key,
    )
    if (!list) return []
    const root = (list as Element & { shadowRoot?: ShadowRoot }).shadowRoot ?? list
    return [...root.querySelectorAll('.gp-name')].map((el) => el.textContent ?? '')
  }, section)
}

const loadOlder = (window: Page) => window.locator('.gp-load-older')

test.describe('Source Control — commit-history paging', () => {
  test.afterAll(() => cleanupSeeds())

  // ── Guard 1 ───────────────────────────────────────────────────────────────
  test('Load older commits appends the rest of the history and the header becomes exact', async ({
    window,
  }) => {
    test.setTimeout(180_000)
    const errors: string[] = []
    window.on('pageerror', (error) => errors.push(String(error)))

    const dir = await seedHistory(window, 'flow-ux-pagein-', 130)
    await activateProject(window, dir)
    await openGitPanel(window)

    // One page in: a window, not a count — and a route to the rest.
    await expect
      .poll(() => commitsHeaderText(window), { timeout: 20000 })
      .toContain('latest 100')
    expect((await commitSubjects(window)).length).toBe(100)
    await expect(loadOlder(window)).toBeVisible()

    await loadOlder(window).click()

    await expect.poll(() => commitsHeaderText(window), { timeout: 20000 }).toContain('(130)')
    const subjects = await commitSubjects(window)
    expect(subjects.length).toBe(130)
    expect(subjects).toContain('commit number 001') // the oldest is genuinely reachable
    await expect(loadOlder(window)).toHaveCount(0) // nothing older to offer
    await window.screenshot({ path: join(SHOTS, 'git-paging-loaded-full-history.png') })

    expect(errors).toEqual([])
  })

  // ── Guard 2 (the refresh control for tripwire A) ──────────────────────────
  test('staging a file refreshes the panel — the file moves to Staged Changes', async ({
    window,
  }) => {
    test.setTimeout(180_000)
    const errors: string[] = []
    window.on('pageerror', (error) => errors.push(String(error)))

    const dir = await seedHistory(window, 'flow-ux-pagestage-', 130)
    await activateProject(window, dir)
    await openGitPanel(window)

    await expect
      .poll(() => sectionRowNames(window, 'changes'), { timeout: 20000 })
      .toContain('log.txt')

    await window.locator('.gp-row', { hasText: 'log.txt' }).locator('button[title="Stage"]').first().click()

    await expect
      .poll(() => sectionRowNames(window, 'staged'), { timeout: 20000 })
      .toContain('log.txt')
    // Untouched history stays put across that refresh.
    expect(await commitsHeaderText(window)).toContain('latest 100')
    expect((await commitSubjects(window)).length).toBe(100)

    expect(errors).toEqual([])
  })

  // ── Tripwire A ────────────────────────────────────────────────────────────
  test(
    'paged-in history survives an ordinary refresh (staging a file)',
    async ({ window }) => {
      test.setTimeout(180_000)

      const dir = await seedHistory(window, 'flow-ux-pagelost-', 130)
      await activateProject(window, dir)
      await openGitPanel(window)

      await expect(loadOlder(window)).toBeVisible({ timeout: 20000 })
      await loadOlder(window).click()
      await expect.poll(() => commitsHeaderText(window), { timeout: 20000 }).toContain('(130)')

      // An ordinary click anywhere in the panel refreshes the root.
      await window.locator('.gp-row', { hasText: 'log.txt' }).locator('button[title="Stage"]').first().click()
      await expect
        .poll(() => sectionRowNames(window, 'staged'), { timeout: 20000 })
        .toContain('log.txt')

      // The 30 commits the user explicitly paged in are still there.
      const subjects = await commitSubjects(window)
      expect(subjects.length).toBe(130)
      expect(subjects).toContain('commit number 001')
      expect(await commitsHeaderText(window)).toContain('(130)')
    },
  )

  // ── Tripwire B ────────────────────────────────────────────────────────────
  test(
    'a history that is exactly one page long offers no dead "Load older commits"',
    async ({ window }) => {
      test.setTimeout(180_000)

      const dir = await seedHistory(window, 'flow-ux-pageexact-', 100)
      await activateProject(window, dir)
      await openGitPanel(window)

      await expect
        .poll(() => commitSubjects(window).then((s) => s.length), { timeout: 20000 })
        .toBe(100)

      // Either the panel knows this is the whole history (no button), or the
      // click that finds nothing says so and stops inviting a repeat.
      if ((await loadOlder(window).count()) === 0) return
      await loadOlder(window).click()
      await window.waitForTimeout(3000)

      const stillOffered = (await loadOlder(window).count()) > 0
      const toldTheUser =
        (await window.locator('.fl-flow-toast').count()) > 0 ||
        /no older|nothing older|beginning|oldest/i.test(await commitsHeaderText(window))
      expect(stillOffered && !toldTheUser).toBe(false)
    },
  )

  // ── Tripwire C ────────────────────────────────────────────────────────────
  test('Load older commits can be used more than once (page 3 is reachable)', async ({
    window,
  }) => {
    test.setTimeout(240_000)

    const dir = await seedHistory(window, 'flow-ux-pagetwice-', 250)
    await activateProject(window, dir)
    await openGitPanel(window)

    await expect(loadOlder(window)).toBeVisible({ timeout: 25000 })
    await loadOlder(window).click()
    await expect.poll(() => commitsHeaderText(window), { timeout: 25000 }).toContain('latest 200')

    // Two pages in, 50 commits still older: the route to them must still be live.
    await expect(loadOlder(window)).toBeEnabled({ timeout: 15000 })
    expect(await loadOlder(window).textContent()).toBe('Load older commits')

    await loadOlder(window).click()
    await expect.poll(() => commitsHeaderText(window), { timeout: 25000 }).toContain('(250)')
    expect(await commitSubjects(window)).toContain('commit number 001')
  })
})
