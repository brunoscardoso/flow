/**
 * UX sweep — flow `git` (rotation index 6), round 14: opening a file while a git
 * diff is still LOADING.
 *
 * #345 (fixed) made an ALREADY-PAINTED diff overlay close when the user opens a
 * file in the same project — git.spec.ts guards that. This spec drives the seam
 * that guard can't reach: the window where the diff has been REQUESTED but its
 * `git:diff` IPC hasn't resolved yet. Two ways a real user lands in it:
 *
 *   E — they click a Source-Control row for a large file (bundle, lockfile,
 *       generated code), then open a file from the tree/search before the diff
 *       paints
 *   F — a diff is open on a file an agent/build keeps rewriting, so the #402
 *       live-refresh re-opens it asynchronously, and the user opens a file
 *       mid-flight
 *
 * In both, the LAST user action is "open this file" — so the file must end up
 * visible. Today the late diff paints on top of it (filed as #953 — a #345
 * residual, exactly like #315 was the in-flight residual of #288): `closeDiff()` doesn't
 * bump `diffRequestSeq`, and the `flow:editor-file-opened` listener only acts
 * `if (diffView.isOpen)` — an in-flight request passes both gates and `show()`s.
 */
import { test, expect, type Page } from '../fixtures/electron'
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed'
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

const SHOTS = join(__dirname, '__screens')

/** Retry on `.git/index.lock` — the app's own status polling holds it briefly. */
function git(dir: string, ...args: string[]): string {
  let lastError: unknown
  for (let attempt = 0; attempt < 25; attempt += 1) {
    try {
      return execFileSync('git', args, { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] }).toString()
    } catch (error) {
      lastError = error
      if (!String((error as { stderr?: Buffer }).stderr ?? '').includes('index.lock')) throw error
      execFileSync('sleep', ['0.2'])
    }
  }
  throw lastError
}

/** ~6 MB of text, so `git:diff` stays in flight long enough to drive the race. */
function bigText(marker: string): string {
  return `${marker} lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod\n`.repeat(
    80_000,
  )
}

async function openGitPanel(window: Page): Promise<void> {
  await window.locator('.fl-activity-bar .fl-rail-item[aria-label="Source Control"]').click()
  await window.locator('.fl-sc-viewbtn', { hasText: 'Changes' }).click()
  await expect(window.locator('.gp-root')).toBeVisible()
}

async function expectPanelText(window: Page, needle: string): Promise<void> {
  await expect(async () => {
    expect(await window.locator('.gp-root').innerText()).toContain(needle)
  }).toPass({ timeout: 10000 })
}

/** Open a project file through the app's real decoupled `flow:open-file` event. */
async function openFile(window: Page, dir: string, rel: string): Promise<void> {
  await window.evaluate(
    ([rootPath, relPath]) => {
      document.dispatchEvent(new CustomEvent('flow:open-file', { detail: { rootPath, relPath } }))
    },
    [dir, rel],
  )
}

/** Repo with a large tracked+modified file and a small file to open. */
async function seedBigRepo(window: Page, prefix: string): Promise<string> {
  const dir = await seedProject(window, prefix)
  git(dir, 'config', 'user.email', 'qa@flow.test')
  git(dir, 'config', 'user.name', 'QA Bot')
  writeFileSync(join(dir, 'big.txt'), bigText('V1'))
  writeFileSync(join(dir, 'beta.txt'), 'beta content BETA_MARKER\n')
  git(dir, 'add', 'big.txt', 'beta.txt')
  git(dir, 'commit', '-q', '-m', 'feat: seed big')
  writeFileSync(join(dir, 'big.txt'), bigText('V2'))
  return dir
}

test.afterAll(() => cleanupSeeds())

test.describe('git diff in flight vs opening a file', () => {
  // Live guard: the file-open path itself works while a diff is loading — the
  // editor really does open and activate the requested file. This isolates the
  // defect below to the overlay (the file is open, just hidden), and would catch
  // a regression that made the open silently no-op during a pending diff.
  test('the requested file is genuinely opened even while a diff is still loading', async ({
    window,
  }) => {
    const dir = await seedBigRepo(window, 'flow-git-race-live-')
    await activateProject(window, dir)
    await openGitPanel(window)
    await expectPanelText(window, 'CHANGES (1)')

    await window.locator('.gp-name', { hasText: 'big.txt' }).first().click()
    await window.waitForTimeout(120) // diff requested, not yet painted
    await openFile(window, dir, 'beta.txt')

    const betaTab = window.locator('fl-tabs .tab', { hasText: 'beta.txt' })
    await expect(betaTab).toBeVisible({ timeout: 8000 })
    await expect(betaTab).toHaveClass(/active/)
  })

  // #953 (fixed — #345 residual, in-flight variant): `closeDiff()` invalidates
  // pending requests (bumps diffRequestSeq), and `flow:editor-file-opened`
  // invalidates unconditionally — not only `if (diffView.isOpen)`.
  test(
    'E: a diff that resolves AFTER the user opened a file must not paint over it',
    async ({ window }) => {
      const dir = await seedBigRepo(window, 'flow-git-race-e-')
      await activateProject(window, dir)
      await openGitPanel(window)
      await expectPanelText(window, 'CHANGES (1)')

      // Click the big file's row — its diff takes a while to compute.
      await window.locator('.gp-name', { hasText: 'big.txt' }).first().click()
      // Before it resolves, the user opens another file (file tree / search hit).
      await window.waitForTimeout(120)
      await openFile(window, dir, 'beta.txt')

      const betaTab = window.locator('fl-tabs .tab', { hasText: 'beta.txt' })
      await expect(betaTab).toBeVisible({ timeout: 8000 })
      await expect(betaTab).toHaveClass(/active/)

      // The user's LAST action was "open beta.txt" — the late diff must not cover it.
      await window.waitForTimeout(4000)
      await window.screenshot({ path: join(SHOTS, 'git-inflight-e-covered.png') })
      await expect(window.locator('.gd-overlay')).toBeHidden()
    },
  )

  // #953 (fixed) — same defect via the #402 live-refresh re-open, the path an ordinary
  // user hits with an agent/build rewriting the diffed file (no big-file click needed).
  test(
    'F: a refresh-driven diff re-open must not cover a file opened mid-flight',
    async ({ window }) => {
      const dir = await seedBigRepo(window, 'flow-git-race-f-')
      await activateProject(window, dir)
      await openGitPanel(window)
      await expectPanelText(window, 'CHANGES (1)')

      await window.locator('.gp-name', { hasText: 'big.txt' }).first().click()
      await expect(window.locator('.gd-overlay')).toBeVisible({ timeout: 20000 })

      // The file changes again → the panel refreshes and RE-OPENS the diff
      // asynchronously (#402). Mid-flight, the user opens a file.
      writeFileSync(join(dir, 'big.txt'), bigText('V3'))
      await window.waitForTimeout(700)
      await openFile(window, dir, 'beta.txt')

      const betaTab = window.locator('fl-tabs .tab', { hasText: 'beta.txt' })
      await expect(betaTab).toBeVisible({ timeout: 8000 })
      await expect(betaTab).toHaveClass(/active/)

      await window.waitForTimeout(5000)
      await window.screenshot({ path: join(SHOTS, 'git-inflight-f-covered.png') })
      await expect(window.locator('.gd-overlay')).toBeHidden()
    },
  )
})
