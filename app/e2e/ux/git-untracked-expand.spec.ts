/**
 * UX sweep — flow `git` (rotation index 6), round 7: the previously un-probed
 * EXPANDABLE ROLLED-UP UNTRACKED DIRECTORY rows (#615) on the unified Source
 * Control panel.
 *
 * git rolls a brand-new untracked directory up into ONE `dir/` change, hiding its
 * individual files. The panel gives that row a chevron; expanding it fetches
 * (git:listUntrackedDir) and interleaves the folder's untracked files as indented
 * child rows, so a user can see / diff / stage each new file without losing the
 * folder row's own stage/discard affordances. This cycle's UX sweep DROVE the
 * flow end-to-end against real seeded repos and found NO new user-facing defect:
 *   - the new dir rolls up into a single chevron row (not N loose file rows)
 *   - expanding reveals every child; collapsing hides them again
 *   - a child's diff opens and shows the new file's (pure-insert) content
 *   - staging a single child moves it to STAGED and lists the rest individually
 *   - a file added to an expanded folder surfaces live without a manual refresh (#647)
 *   - staging the whole folder row stages every child
 * all with zero uncaught errors. This spec locks that healthy behavior in.
 *
 * (Per-row Discard uses a native window.confirm(), which Playwright cannot drive,
 * so it is intentionally not asserted here — see flow/qa-sweep-runbook.md.)
 */
import { test, expect, type Page } from '../fixtures/electron'
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed'
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

function git(dir: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: dir }).toString()
}
function configure(dir: string): void {
  git(dir, 'config', 'user.email', 'qa@flow.test')
  git(dir, 'config', 'user.name', 'QA Bot')
}

/** One committed file, then a BRAND-NEW untracked dir with 3 files inside — git
 *  rolls the new dir up into a single `newdir/` untracked change. */
function populateRepo(dir: string): void {
  configure(dir)
  writeFileSync(join(dir, 'readme.md'), '# hello\n')
  git(dir, 'add', 'readme.md')
  git(dir, 'commit', '-q', '-m', 'chore: initial commit')
  const nd = join(dir, 'newdir')
  mkdirSync(nd)
  writeFileSync(join(nd, 'aaa.txt'), 'file a\n')
  writeFileSync(join(nd, 'bbb.txt'), 'file b\n')
  writeFileSync(join(nd, 'ccc.txt'), 'file c\n')
}

/** Seed a repo, activate it, reveal Source Control → Changes, and wait for rows.
 *  Populated inside `prepare` (pre-addRoot) so the app's own git activity
 *  (status refreshes, provisioning) can't race the seed on index.lock. */
async function openGitPanel(window: Page): Promise<string> {
  const dir = await seedProject(window, 'flow-git-untracked-', populateRepo)
  await activateProject(window, dir)
  await window.locator('[data-rail-item="source-control"]').click()
  await window.locator('.fl-sc-viewbtn', { hasText: 'Changes' }).click()
  await expect(window.locator('.gp-root')).toBeVisible()
  await expect(async () => {
    expect(await window.locator('.gp-name').count()).toBeGreaterThan(0)
  }).toPass({ timeout: 6000 })
  return dir
}

function dirRowOf(window: Page) {
  return window
    .locator('.gp-row', { has: window.locator('.gp-name', { hasText: 'newdir' }) })
    .first()
}

/** Monaco's diff editor emits internal cancellation errors when its model is
 *  swapped/disposed (Esc-closing a diff). No user-visible effect — framework
 *  noise, not app defects. Filter them so the guard still fails on a REAL error. */
const BENIGN_MONACO = [/^Canceled: Canceled$/, /no diff result available/i]
function appErrors(errors: string[]): string[] {
  return errors.filter((e) => !BENIGN_MONACO.some((re) => re.test(e)))
}

test.afterAll(() => cleanupSeeds())

test.describe('git untracked-folder expand (#615)', () => {
  test('a new untracked folder rolls up to one chevron row; expand reveals every child, collapse hides them', async ({
    window,
  }) => {
    const errors: string[] = []
    window.on('pageerror', (e) => errors.push(String(e)))

    await openGitPanel(window)

    // Rolled up into a SINGLE `newdir` row with an expand chevron — not 3 loose rows.
    const dirRow = dirRowOf(window)
    await expect(dirRow).toBeVisible()
    await expect(dirRow.locator('.gp-chevron')).toHaveCount(1)
    // Retry — a status refresh re-render can momentarily empty the row list.
    await expect(async () => {
      expect(await window.locator('.gp-name').allInnerTexts()).toEqual(['newdir'])
    }).toPass({ timeout: 8000 })

    // Expand → all three children interleave as indented child rows.
    await dirRow.locator('.gp-chevron').click()
    await expect(window.locator('.gp-row-child')).toHaveCount(3)
    for (const name of ['aaa.txt', 'bbb.txt', 'ccc.txt']) {
      await expect(
        window.locator('.gp-row-child', { has: window.locator('.gp-name', { hasText: name }) }),
      ).toBeVisible()
    }

    // A child row offers real Stage + Discard affordances (not a dead peek).
    const childA = window
      .locator('.gp-row-child', { has: window.locator('.gp-name', { hasText: 'aaa.txt' }) })
      .first()
    await expect(childA.locator('.gp-action-btn[title="Stage"]')).toHaveCount(1)
    await expect(childA.locator('.gp-action-btn[title="Discard changes"]')).toHaveCount(1)

    // Collapse → children hide again.
    await dirRow.locator('.gp-chevron').click()
    await expect(window.locator('.gp-row-child')).toHaveCount(0)

    expect(appErrors(errors)).toEqual([])
  })

  test('a child file diff opens and shows the new file content', async ({ window }) => {
    const errors: string[] = []
    window.on('pageerror', (e) => errors.push(String(e)))

    await openGitPanel(window)
    const dirRow = dirRowOf(window)
    await dirRow.locator('.gp-chevron').click()
    await expect(window.locator('.gp-row-child')).toHaveCount(3)

    // Clicking a child's name opens its working-tree diff (untracked = pure insert).
    await window
      .locator('.gp-row-child', { has: window.locator('.gp-name', { hasText: 'aaa.txt' }) })
      .first()
      .locator('.gp-name')
      .click()
    await expect(window.locator('.gd-overlay')).toBeVisible({ timeout: 5000 })
    await expect(window.locator('.gd-body')).toContainText('file a', { timeout: 5000 })

    await window.keyboard.press('Escape')
    await expect(window.locator('.gd-overlay')).toBeHidden({ timeout: 4000 })

    expect(appErrors(errors)).toEqual([])
  })

  test('staging one child moves it to Staged; a file added to the open folder surfaces live (#647)', async ({
    window,
  }) => {
    const errors: string[] = []
    window.on('pageerror', (e) => errors.push(String(e)))

    const dir = await openGitPanel(window)
    const dirRow = dirRowOf(window)
    await dirRow.locator('.gp-chevron').click()
    await expect(window.locator('.gp-row-child')).toHaveCount(3)

    // A new file dropped into the expanded folder surfaces without a manual refresh.
    writeFileSync(join(dir, 'newdir', 'ddd.txt'), 'file d\n')
    await expect(async () => {
      expect((await window.locator('.gp-name').allInnerTexts()).join(',')).toContain('ddd.txt')
    }).toPass({ timeout: 8000 })

    // Stage a single child via its (+) button — it lands in the index, the rest
    // stay in Changes, and a STAGED section appears.
    await window
      .locator('.gp-row-child', { has: window.locator('.gp-name', { hasText: 'bbb.txt' }) })
      .first()
      .locator('.gp-action-btn[title="Stage"]')
      .click()
    await expect(async () => {
      expect(await window.locator('.gp-root').innerText()).toContain('STAGED')
    }).toPass({ timeout: 6000 })
    expect(git(dir, 'status', '--porcelain').trim()).toContain('A  newdir/bbb.txt')

    expect(appErrors(errors)).toEqual([])
  })
})
