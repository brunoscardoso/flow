/**
 * UX journey — Pull that REBASES into a conflict, then Abort recovers (#66 P9 +
 * #571). The in-app "Pull" button runs `git pull --no-edit`; with the repo's
 * `pull.rebase=true`, a divergent upstream produces a REBASE conflict (not a
 * merge). That drives the untested half of the conflict banner: op === 'rebase'
 * → the finalize button reads "Continue rebase" and Abort routes to
 * `git rebase --abort` (the merge branch is covered by git-merge-abort.spec).
 *
 * No pull/rebase journey existed at all. This seeds a real bare upstream with a
 * conflicting divergence, clicks Pull, asserts the rebase-flavored banner + Merge
 * Changes surface, aborts, and asserts — via the panel AND git — full recovery to
 * the local pre-pull commit.
 *
 * Deterministic: all state lives in git (upstream seeded before attach); Pull and
 * Abort are explicit user actions each followed by an explicit refreshRoot (#507).
 */
import { test, expect, type Page } from '../fixtures/electron'
import { activateProject } from './fixtures/seed'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
function tmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  madeDirs.push(dir)
  return dir
}

/**
 * Build a bare upstream + a local clone (pull.rebase=true) whose HEAD conflicts
 * with a newer upstream commit on the same line. Returns the local working repo.
 */
function seedDivergentRebase(): string {
  const remote = tmp('flow-pullreb-remote-')
  git(remote, 'init', '--bare', '-q', '-b', 'main')

  const local = tmp('flow-pullreb-local-')
  git(tmpdir(), 'clone', '-q', remote, local)
  configure(local)
  // Hide the IDE's auto-provisioned scaffold (.claude/, flow, .gitignore) from
  // git status — it lands mid-test and breaks the clean-tree assertions.
  writeFileSync(join(local, '.git', 'info', 'exclude'), '.claude/\nflow\n.gitignore\nloops/\n')
  git(local, 'config', 'pull.rebase', 'true')
  writeFileSync(join(local, 'shared.txt'), 'line one\nline two\n')
  git(local, 'add', 'shared.txt')
  git(local, 'commit', '-q', '-m', 'feat: base')
  git(local, 'branch', '-M', 'main')
  git(local, 'push', '-q', '-u', 'origin', 'main')

  // A second clone advances the upstream, editing line one one way…
  const other = tmp('flow-pullreb-other-')
  git(tmpdir(), 'clone', '-q', remote, other)
  configure(other)
  writeFileSync(join(other, 'shared.txt'), 'line one FROM UPSTREAM\nline two\n')
  git(other, 'add', 'shared.txt')
  git(other, 'commit', '-q', '-m', 'feat: upstream edits line one')
  git(other, 'push', '-q', 'origin', 'main')

  // …while local commits a DIFFERENT edit to the same line (not pushed) → a
  // pull --rebase will replay this commit onto the upstream tip and conflict.
  writeFileSync(join(local, 'shared.txt'), 'line one FROM LOCAL\nline two\n')
  git(local, 'add', 'shared.txt')
  git(local, 'commit', '-q', '-m', 'feat: local edits line one')
  return local
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

test.describe('git pull --rebase conflict → abort recovery', () => {
  test('a rebasing pull conflict shows the rebase banner and Abort recovers the tree', async ({
    window,
  }) => {
    const errors: string[] = []
    window.on('pageerror', (e) => errors.push(String(e)))
    window.on('dialog', (d) => void d.accept()) // Abort is window.confirm-gated

    const local = seedDivergentRebase()
    await attachRoot(window, local)
    await activateProject(window, local)
    await window.locator('.fl-activity-bar .fl-rail-item[aria-label="Source Control"]').click()
    await window.locator('.fl-sc-viewbtn', { hasText: 'Changes' }).click()
    await expect(window.locator('.gp-root')).toBeVisible({ timeout: 15000 })
    await expect(window.locator('.gp-branch-name')).toBeVisible({ timeout: 15000 })
    await expectPanel(window, 'Working tree clean')

    // Pull → fetch + rebase local's commit onto the upstream tip → conflict.
    // From a terminal: Source Control's Pull button was removed (2026-09-04).
    // The repo's own config (pull.rebase) decides the rebase, as the button did.
    try {
      git(local, 'pull', '--no-edit')
    } catch {
      // Expected: a conflicting rebase exits non-zero and leaves markers on disk.
    }
    await expect(async () => {
      expect(git(local, 'status', '--porcelain')).toMatch(/UU\s+shared\.txt/)
    }).toPass({ timeout: 12000 })

    // The banner is REBASE-flavored: "Continue rebase" (not "Complete merge"),
    // which is the #571 branch the merge-abort spec doesn't reach.
    await expectPanel(window, 'MERGE CHANGES (1)')
    await expect(window.locator('.gp-merge-banner')).toBeVisible()
    await expect(
      window.locator('.gp-merge-complete', { hasText: 'Continue rebase' }),
    ).toBeVisible({ timeout: 12000 })
    await window.screenshot({ path: join(SHOTS, 'git-pullrebase-1-conflict.png') })

    // Abort → git rebase --abort → back to the local pre-rebase state.
    await window.locator('.gp-merge-abort').click()
    await expect(window.locator('.gp-merge-banner')).toHaveCount(0, { timeout: 12000 })
    await expect(async () => {
      expect(await panelText(window)).not.toContain('MERGE CHANGES')
    }).toPass({ timeout: 12000 })
    await expectPanel(window, 'Working tree clean')
    await window.screenshot({ path: join(SHOTS, 'git-pullrebase-2-recovered.png') })

    // git truth: no rebase in progress, HEAD is the local commit again, and
    // shared.txt is the local version (upstream's edit was NOT applied).
    expect(existsSync(join(local, '.git', 'rebase-merge'))).toBe(false)
    expect(existsSync(join(local, '.git', 'rebase-apply'))).toBe(false)
    expect(git(local, 'status', '--porcelain').trim()).toBe('')
    expect(git(local, 'log', '-1', '--format=%s').trim()).toBe('feat: local edits line one')
    const restored = readFileSync(join(local, 'shared.txt'), 'utf8')
    expect(restored).toBe('line one FROM LOCAL\nline two\n')
    expect(restored).not.toContain('<<<<<<<')

    expect(errors).toEqual([])
  })
})
