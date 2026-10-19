/**
 * UX journey — aborting a CONFLICTING merge recovers the working tree (#335 P6).
 *
 * git-merge-branch.spec drives a conflicting merge only far enough to surface the
 * Merge Changes section + the in-progress banner (Complete/Abort) — it never
 * clicks Abort, so the recovery path is unguarded. This continues that scenario:
 * reach the conflict, click Abort (a window.confirm-gated destructive action that
 * routes to `git merge --abort` for a merge / `git rebase --abort` for a rebase,
 * #571), and assert — via the PANEL and git — that the tree returns to the clean
 * pre-merge state: banner gone, MERGE CHANGES gone, "Working tree clean", no
 * MERGE_HEAD, and the conflicted file restored to the current branch's version.
 *
 * Deterministic: the merge conflict lives entirely in .git (seeded via the git
 * CLI before the root attaches), and the post-abort refresh is an EXPLICIT
 * refreshRoot in onAbortMerge (#507), not a working-tree watcher.
 */
import { test, expect, type Page } from '../fixtures/electron'
import { activateProject } from './fixtures/seed'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SHOTS = join(__dirname, '__screens')
const madeDirs: string[] = []

function git(dir: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: dir }).toString()
}

/** Build main + feature that edit the same line → a guaranteed merge conflict. */
function buildConflictRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'flow-git-abort-'))
  madeDirs.push(dir)
  git(dir, 'init', '-q', '-b', 'main')
  // Hide the IDE's auto-provisioned scaffold (.claude/, flow, .gitignore) from
  // git status — it lands mid-test and would break the clean-tree assertions.
  writeFileSync(join(dir, '.git', 'info', 'exclude'), '.claude/\nflow\n.gitignore\nloops/\n')
  git(dir, 'config', 'user.email', 'qa@flow.test')
  git(dir, 'config', 'user.name', 'QA Bot')
  writeFileSync(join(dir, 'shared.txt'), 'line one\nline two\n')
  git(dir, 'add', 'shared.txt')
  git(dir, 'commit', '-q', '-m', 'feat: base')
  git(dir, 'checkout', '-q', '-b', 'feature')
  writeFileSync(join(dir, 'shared.txt'), 'line one FROM FEATURE\nline two\n')
  git(dir, 'add', 'shared.txt')
  git(dir, 'commit', '-q', '-m', 'feat: feature edits line one')
  git(dir, 'checkout', '-q', 'main')
  writeFileSync(join(dir, 'shared.txt'), 'line one FROM MAIN\nline two\n')
  git(dir, 'add', 'shared.txt')
  git(dir, 'commit', '-q', '-m', 'feat: main edits line one')
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

test.describe('git merge abort recovery', () => {
  test('aborting a conflicting merge returns the tree to the clean pre-merge state', async ({
    window,
  }) => {
    const errors: string[] = []
    window.on('pageerror', (e) => errors.push(String(e)))
    // The Abort action is gated by window.confirm — accept it.
    window.on('dialog', (d) => void d.accept())

    const dir = buildConflictRepo()
    await attachRoot(window, dir)
    await activateProject(window, dir)
    await window.locator('.fl-activity-bar .fl-rail-item[aria-label="Source Control"]').click()
    await window.locator('.fl-sc-viewbtn', { hasText: 'Changes' }).click()
    await expect(window.locator('.gp-root')).toBeVisible({ timeout: 15000 })
    await expect(window.locator('.gp-branch-name')).toBeVisible({ timeout: 15000 })
    await expectPanel(window, 'Working tree clean')

    // Trigger the conflicting merge from a terminal — Source Control's Merge
    // branch… picker was removed (2026-09-04). What this guards is the panel's
    // recovery from a conflict, wherever the merge was started.
    try {
      git(dir, 'merge', 'feature')
    } catch {
      // Expected: a conflicting merge exits non-zero and leaves markers on disk.
    }
    expect(git(dir, 'status', '--porcelain')).toMatch(/UU\s+shared\.txt/)
    await expectPanel(window, 'MERGE CHANGES (1)')
    await expect(window.locator('.gp-merge-banner')).toBeVisible()
    await window.screenshot({ path: join(SHOTS, 'git-abort-1-conflict.png') })

    // Abort the merge from the banner.
    await window.locator('.gp-merge-abort').click()

    // Panel recovers: banner gone, no Merge Changes section, tree reads clean.
    await expect(window.locator('.gp-merge-banner')).toHaveCount(0, { timeout: 12000 })
    await expect(async () => {
      expect(await panelText(window)).not.toContain('MERGE CHANGES')
    }).toPass({ timeout: 12000 })
    await expectPanel(window, 'Working tree clean')
    await window.screenshot({ path: join(SHOTS, 'git-abort-2-recovered.png') })

    // git is the source of truth: no in-progress merge, and shared.txt is restored
    // to main's version (the feature edit is gone — the abort undid the merge).
    expect(git(dir, 'status', '--porcelain').trim()).toBe('')
    let mergeHeadPresent = true
    try {
      git(dir, 'rev-parse', '-q', '--verify', 'MERGE_HEAD')
    } catch {
      mergeHeadPresent = false // rev-parse exits non-zero → no merge in progress
    }
    expect(mergeHeadPresent).toBe(false)
    const restored = readFileSync(join(dir, 'shared.txt'), 'utf8')
    expect(restored).toBe('line one FROM MAIN\nline two\n')
    expect(restored).not.toContain('<<<<<<<') // no conflict markers left behind

    expect(errors).toEqual([])
  })
})
