import type { Page } from '@playwright/test'
import { test, expect } from '../fixtures/electron'
import { activateProject } from './fixtures/seed'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Long git operations must SAY they are running. Pull, Merge branch…, the ✨
 * commit-message wand and Commit all fire and then sit there looking idle —
 * against a real remote a pull takes seconds, and a button with no feedback
 * reads as a dead click (and invites a second one).
 *
 * Also covers the Pull split control: its chevron offers the repo's remote
 * branches, so a feature branch can take `origin/main` without a terminal.
 */

const seeded: string[] = []

function git(dir: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: dir }).toString()
}

/** A clone with a real `origin`, on a feature branch that main has moved past. */
function seedCloneWithRemote(): { clone: string; origin: string } {
  const origin = mkdtempSync(join(tmpdir(), 'flow-ux-origin-'))
  seeded.push(origin)
  git(origin, 'init', '-q')
  git(origin, 'config', 'user.email', 'qa@flow.test')
  git(origin, 'config', 'user.name', 'QA Bot')
  git(origin, 'checkout', '-q', '-b', 'main')
  writeFileSync(join(origin, 'app.ts'), 'export const v = 1\n')
  git(origin, 'add', '-A')
  git(origin, 'commit', '-q', '-m', 'base')

  const clone = mkdtempSync(join(tmpdir(), 'flow-ux-clone-'))
  rmSync(clone, { recursive: true, force: true })
  execFileSync('git', ['clone', '-q', origin, clone])
  seeded.push(clone)
  git(clone, 'config', 'user.email', 'qa@flow.test')
  git(clone, 'config', 'user.name', 'QA Bot')
  git(clone, 'checkout', '-q', '-b', 'feature')

  writeFileSync(join(origin, 'app.ts'), 'export const v = 2\n')
  git(origin, 'add', '-A')
  git(origin, 'commit', '-q', '-m', 'main moves on')
  return { clone, origin }
}

async function openGitPanel(window: Page, dir: string): Promise<void> {
  await window.evaluate(async (p) => {
    await (
      window as unknown as {
        flow: { project: { add(r: { path: string }): Promise<unknown> } }
      }
    ).flow.project.add({ path: p })
  }, dir)
  await activateProject(window, dir)
  await window.locator('.fl-activity-bar .fl-rail-item[aria-label="Source Control"]').click()
  await expect(window.locator('.gp-root')).toBeVisible()
}

test.afterAll(() => {
  // The auto-provisioner may still be writing `.claude/` into a seeded repo as
  // the run ends — a failed cleanup of a temp dir is not a test failure.
  for (const dir of seeded) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })
    } catch {
      // Left for the OS to reap.
    }
  }
})

// RETIRED 2026-10-09: the Pull split control, its remote-branch menu and the
// Merge branch… picker left Source Control on the user's call (2026-09-04,
// git-panel.ts: "NO Merge branch… / Pull row"); nothing in the app opens them.
// Their three tests went with them. The commit-progress test below is live.

test('the Commit button reports progress instead of sitting idle', async ({ window, app }) => {
  const { clone } = seedCloneWithRemote()
  await openGitPanel(window, clone)

  writeFileSync(join(clone, 'app.ts'), 'export const v = 99\n')
  // Stage the one file this test changed. The project is open by now, so the
  // app's background learn is writing (and deleting) lock files under `flow/`
  // in this same tree — `add -A` raced one: "unable to stat
  // 'flow/brain/.structure/learning-state.jsonl.lock'".
  git(clone, 'add', 'app.ts')

  // Wait for the staged file to reach the panel, then write a message — Commit
  // is gated on both.
  const commit = window.locator('.gp-commit-btn')
  await expect(window.locator('.gp-section-head', { hasText: 'STAGED CHANGES' })).toBeVisible({
    timeout: 10_000,
  })
  await window.locator('.gp-commit-msg').fill('feat: progress indicators')
  await expect(commit).toBeEnabled({ timeout: 10_000 })

  // Hold the commit open so the busy state is observable rather than a race.
  // In MAIN: `window.flow` is a frozen contextBridge object, so reassigning
  // `flow.git.commit` from the page silently did nothing and the commit raced
  // past the assertion. The real handler still does the commit.
  await app.evaluate(({ ipcMain }) => {
    type Handler = (event: unknown, request: unknown) => unknown
    const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, Handler> })._invokeHandlers
    const original = handlers.get('git:commit')
    if (original === undefined) throw new Error('there is no git:commit handler to wrap')
    ipcMain.removeHandler('git:commit')
    ipcMain.handle('git:commit', async (event, request: unknown) => {
      await new Promise((resolve) => setTimeout(resolve, 1200))
      return original(event, request)
    })
  })

  await commit.click()

  await expect(window.locator('.gp-commit-btn.gp-busy')).toBeVisible()
  await expect(window.locator('.gp-commit-btn.gp-busy')).toContainText('Committing…')
  await window.screenshot({ path: '/tmp/git-commit-busy.png' })

  await expect(async () => {
    expect(git(clone, 'log', '-1', '--format=%s').trim()).toBe('feat: progress indicators')
  }).toPass({ timeout: 15_000 })
  await expect(window.locator('.gp-commit-btn.gp-busy')).toHaveCount(0)
})
