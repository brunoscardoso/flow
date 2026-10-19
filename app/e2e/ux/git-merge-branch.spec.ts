/**
 * UX sweep — flow `git` (rotation index 6), round 6: the previously un-probed
 * "Merge branch…" in-app entry point (#66 P9) on the Source Control panel — the
 * branch picker (loading → list → select), a CLEAN merge (auto-commits, panel
 * returns to clean), and a CONFLICTING merge surfacing the Merge Changes section +
 * in-progress-merge banner (Complete/Abort).
 *
 * This cycle's UX sweep drove all three end-to-end and found NO new user-facing
 * defect — the clean merge lands and refreshes, and the conflict correctly raises
 * the banner + Merge Changes section (after the post-merge refresh). This spec
 * guards that healthy behavior.
 */
import { test, expect, type Page } from '../fixtures/electron'
import { activateProject } from './fixtures/seed'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SHOTS = join(__dirname, '__screens')
const madeDirs: string[] = []

function git(dir: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: dir }).toString()
}
function configure(dir: string): void {
  git(dir, 'config', 'user.email', 'qa@flow.test')
  git(dir, 'config', 'user.name', 'QA Bot')
}

/**
 * Build the FULL repo history (commits + branches) FIRST, then add it as a
 * project root. Adding the root before the setup commits raced the app's live
 * git watcher on `.git/index.lock` — build offline, attach once quiet.
 */
function buildRepo(prefix: string, build: (dir: string) => void): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  madeDirs.push(dir)
  git(dir, 'init', '-q', '-b', 'main')
  configure(dir)
  // The IDE provisions every added root (`.claude/`, `flow`, `.gitignore`,
  // `loops/`) — untracked noise that would keep "Working tree clean" from ever
  // showing. Excluded repo-locally, as seed.ts does for its repos.
  writeFileSync(join(dir, '.git', 'info', 'exclude'), '.claude/\nflow\n.gitignore\nloops/\n')
  build(dir)
  return dir
}
async function attachRoot(window: Page, dir: string): Promise<void> {
  await window.evaluate(async (p) => {
    await (
      window as unknown as {
        flow: { project: { add(r: { path: string }): Promise<unknown> } }
      }
    ).flow.project.add({ path: p })
  }, dir)
}
async function openSourceControl(window: Page, dir: string): Promise<void> {
  await attachRoot(window, dir)
  await activateProject(window, dir)
  // Post-#674 activity-bar rail opener (was the removed `.fl-sidetabs-tab`).
  await window.locator('.fl-activity-bar .fl-rail-item[aria-label="Source Control"]').click()
  await window.locator('.fl-sc-viewbtn', { hasText: 'Changes' }).click()
  await expect(window.locator('.gp-root')).toBeVisible({ timeout: 15000 })
  // Wait for the panel to FULLY load status+log for the active root — a bare
  // branch header with no commits means it's still mid-refresh (flaky if we act
  // on it). The branch name + at least one commit row confirm it settled. Timeouts
  // are generous: Electron boot + first git refresh is slow on a loaded machine
  // (many sequential app launches during a full sweep), and a durable guard must
  // not false-fail on that.
  await expect(window.locator('.gp-branch-name')).toBeVisible({ timeout: 15000 })
  await expect(window.locator('.gp-subject').first()).toBeVisible({ timeout: 15000 })
}
async function panelText(window: Page): Promise<string> {
  return window.locator('.gp-root').innerText()
}
async function expectPanel(window: Page, needle: string): Promise<void> {
  await expect(async () => {
    expect(await panelText(window)).toContain(needle)
  }).toPass({ timeout: 12000 })
}

test.afterAll(() => {
  for (const dir of madeDirs) rmSync(dir, { recursive: true, force: true })
})

test.describe('git merge branch flow', () => {
  // RETIRED 2026-10-09: "branch picker opens, lists branches, and a clean
  // merge lands" drove Source Control's Merge branch… picker, which left the
  // panel on the user's call (2026-09-04). The conflict test below no longer
  // needs it: the merge is started the way it now has to be — outside the
  // panel — and what is guarded is that the panel SHOWS the conflict.

  test('a conflicting merge surfaces the Merge Changes section + conflict banner', async ({
    window,
  }) => {
    const errors: string[] = []
    window.on('pageerror', (e) => errors.push(String(e)))

    const dir = buildRepo('flow-git-merge-conflict-', (d) => {
      writeFileSync(join(d, 'shared.txt'), 'line one\nline two\n')
      git(d, 'add', 'shared.txt')
      git(d, 'commit', '-q', '-m', 'feat: base')
      // feature edits line one one way…
      git(d, 'checkout', '-q', '-b', 'feature')
      writeFileSync(join(d, 'shared.txt'), 'line one FROM FEATURE\nline two\n')
      git(d, 'add', 'shared.txt')
      git(d, 'commit', '-q', '-m', 'feat: feature edits line one')
      // …main edits the same line the other way → conflict on merge.
      git(d, 'checkout', '-q', 'main')
      writeFileSync(join(d, 'shared.txt'), 'line one FROM MAIN\nline two\n')
      git(d, 'add', 'shared.txt')
      git(d, 'commit', '-q', '-m', 'feat: main edits line one')
    })

    await openSourceControl(window, dir)
    await expectPanel(window, 'Working tree clean')

    // The merge, from a terminal — the panel has no merge button any more.
    try {
      git(dir, 'merge', 'feature')
    } catch {
      // Expected: git exits non-zero on a conflict.
    }

    // First: confirm git itself reached the conflicted mid-merge state on disk.
    await expect(async () => {
      const raw = git(dir, 'status', '--porcelain')
      expect(raw).toMatch(/UU\s+shared\.txt/)
    }).toPass({ timeout: 12000 })

    // The panel must refresh (the working-tree write the merge made) to surface the conflict:
    // an in-progress-merge banner (Complete/Abort) + a "MERGE CHANGES" section header
    // (light DOM) listing the conflicted file row (fl-list renders rows in an OPEN
    // shadow DOM — invisible to innerText but pierced by Playwright locators, hence
    // the .gp-name locator rather than a panelText substring). A stale "Working tree
    // clean" here would leave the user stuck mid-merge blind.
    await expectPanel(window, 'MERGE CHANGES (1)')
    await expect(window.locator('.gp-merge-banner')).toBeVisible()
    await expect(
      window.locator('.gp-name', { hasText: 'shared.txt' }),
    ).toBeVisible({ timeout: 12000 })
    await window.screenshot({ path: join(SHOTS, 'git-merge-3-conflict.png') })

    expect(errors).toEqual([])
  })
})
