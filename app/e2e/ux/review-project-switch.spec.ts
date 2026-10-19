import { basename, join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import type { Page } from '@playwright/test'
import { test, expect } from '../fixtures/electron'
import { sel } from '../selectors'
import { seedProject, activateProject, dismissFlowOverlay, cleanupSeeds, activeProjectName } from './fixtures/seed'

/**
 * Flow 5 (Review) — what the Review "Phases" panel does across a PROJECT SWITCH.
 *
 * The panel keeps per-project state that must not leak between projects:
 *   - typed commit-message drafts + approvals (`ReviewPanel.reset()` on a genuine
 *     switch, #281),
 *   - the open working-tree diff overlay (closed when its owning root is no longer
 *     active — the review-surface port of the #191 class),
 * while the #182 refresh gate DEFERS re-renders whenever a transient interaction
 * (reject prompt / "Discard all" confirm) is open.
 *
 * Guard 1 covers the clean switch (live). Guard 2 drives the switch with the
 * discard confirm open, where the gate and the switch used to collide — #951:
 * the panel kept listing the PREVIOUS project's files and the still-armed
 * "Discard N" reverted the NEWLY-ACTIVE project's uncommitted work instead.
 * Fixed by reset() tearing the confirm down on a switch + the fire-time
 * armed-root guard; guard 2 is the live tripwire for that class.
 */

/** Run a git command, retrying briefly when the app's concurrent status refresh
 *  holds `.git/index.lock` (the repo is a live project root while we seed). */
async function gitRetry(dir: string, args: string[], attempts = 5): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      execFileSync('git', args, { cwd: dir })
      return
    } catch (error) {
      if (attempt >= attempts || !String(error).includes('index.lock')) throw error
      await new Promise((resolve) => setTimeout(resolve, 300 * attempt))
    }
  }
}

async function seedRepo(
  win: Page,
  prefix: string,
  content: string,
  extraChanges: Record<string, string> = {},
): Promise<string> {
  const dir = await seedProject(win, prefix)
  execFileSync('git', ['config', 'user.email', 'qa@flow.test'], { cwd: dir })
  execFileSync('git', ['config', 'user.name', 'Flow QA'], { cwd: dir })
  writeFileSync(join(dir, 'app.ts'), 'export const version = 1\n')
  for (const name of Object.keys(extraChanges)) {
    writeFileSync(join(dir, name), 'export const onlyA = 1\n')
  }
  // The root is already added (seedProject), so the app's own git refreshes can
  // transiently hold .git/index.lock — retry instead of flaking on the race.
  await gitRetry(dir, ['add', '-A'])
  await gitRetry(dir, ['commit', '-q', '-m', 'baseline'])
  // The working-tree changes this project's review list shows.
  writeFileSync(join(dir, 'app.ts'), content)
  for (const [name, text] of Object.entries(extraChanges)) {
    writeFileSync(join(dir, name), text)
  }
  return dir
}

async function openPhases(win: Page): Promise<void> {
  await win.locator('[data-rail-item="source-control"]').click()
  await win.locator(sel.scViewBtn).filter({ hasText: 'Phases' }).click()
  await expect(win.locator('.fl-review')).toBeAttached()
}

/** Switch the active project. The titlebar PROJECT switcher this pressed was
 *  deleted with the Workspaces hard migration (its rows now open a project's
 *  settings), so the switch goes through `project:setActive` — what that row
 *  called. What this file guards is the review panel's response to it. */
async function switchProject(win: Page, name: string): Promise<void> {
  const root = await win.evaluate(async (wanted) => {
    const roots = await (
      window as unknown as { flow: { project: { list(): Promise<Array<{ rootPath: string }>> } } }
    ).flow.project.list()
    return roots.find((r) => r.rootPath.split('/').pop() === wanted)?.rootPath ?? ''
  }, name)
  await activateProject(win, root)
  await dismissFlowOverlay(win)
  await expect(async () => {
    await expect.poll(() => activeProjectName(win)).toBe(name)
  }).toPass({ timeout: 5_000 })
}

test.describe('review panel across a project switch', () => {
  test.afterAll(() => cleanupSeeds())

  test('a switch drops the typed draft and closes the other project\'s diff (#281/#191)', async ({
    window,
  }) => {
    const errors: string[] = []
    window.on('pageerror', (e) => errors.push(String(e)))

    const a = await seedRepo(window, 'flow-ux-rev-sw-a-', 'export const version = 2\n')
    await activateProject(window, a)
    const b = await seedRepo(window, 'flow-ux-rev-sw-b-', 'export const version = 99\n')
    await dismissFlowOverlay(window)
    await openPhases(window)

    // Project A: type a distinctive commit message and open the file's diff.
    const messageA = window.locator('.fl-review-message').first()
    await expect(messageA).toBeVisible({ timeout: 10_000 })
    await messageA.fill('SECRET-DRAFT-FOR-PROJECT-A')
    await window.locator('.fl-review-file-name', { hasText: 'app.ts' }).first().click()
    await expect(window.locator('.gd-overlay')).toBeVisible({ timeout: 10_000 })

    // Switch to B. The activity rail is per-project
    // (v5 per-root layout store), so a never-visited project opens on Threads —
    // walk back to the Review surface the way a user would.
    await switchProject(window, basename(b))
    await openPhases(window)

    // The panel must rebind: B's own change, B's own suggested message, and A's
    // diff overlay must not linger over the new project.
    await expect(window.locator('.fl-review-file', { hasText: 'app.ts' })).toBeVisible({
      timeout: 10_000,
    })
    const messageB = window.locator('.fl-review-message').first()
    await expect(messageB).toBeVisible({ timeout: 10_000 })
    await expect
      .poll(async () => await messageB.inputValue(), { timeout: 5_000 })
      .not.toBe('SECRET-DRAFT-FOR-PROJECT-A')
    await expect(window.locator('.gd-overlay')).toBeHidden({ timeout: 10_000 })

    await window.screenshot({ path: join(__dirname, "__screens/review-switch-clean.png") })
    expect(errors).toEqual([])
  })

  // #951 — FIXED: ReviewPanel.reset() now tears down the open confirm on a
  // genuine switch (forced render lowers the #182 gate), and the fire-time
  // armed-root guard (armed-root.ts) refuses any destructive action whose
  // owning root is no longer active — defence in depth beneath the teardown.
  test('a switch with the "Discard all" confirm open must not leave the previous project\'s files actionable (#951)', async ({
    window,
  }) => {
    const errors: string[] = []
    window.on('pageerror', (e) => errors.push(String(e)))

    // Project A carries a file that exists ONLY here, so a stale listing is
    // unmistakable; project B carries uncommitted work under the shared path.
    const a = await seedRepo(window, 'flow-ux-rev-sw2-a-', 'export const version = 2\n', {
      'only-in-a.ts': 'export const onlyA = 2\n',
    })
    await activateProject(window, a)
    const b = await seedRepo(window, 'flow-ux-rev-sw2-b-', 'export const PRECIOUS = "b work"\n')
    await dismissFlowOverlay(window)
    await openPhases(window)

    // Arm the destructive two-step confirm in project A…
    await expect(window.locator('.fl-review-file', { hasText: 'only-in-a.ts' })).toBeVisible({
      timeout: 10_000,
    })
    await window.locator('.fl-review-discard-btn').first().click()
    await expect(window.locator('.fl-review-discard-confirm')).toBeVisible()

    // …then switch projects without resolving it, and come back to the Review
    // surface (the rail is per-project, so B opens on Threads).
    await switchProject(window, basename(b))
    await openPhases(window)
    await window.waitForTimeout(1_500)
    await window.screenshot({ path: join(__dirname, "__screens/review-switch-stale-confirm.png") })

    // The #182 refresh gate defers the switch's rebuild while the confirm is open,
    // so the panel must not keep listing the PREVIOUS project's files…
    await expect(window.locator('.fl-review-file', { hasText: 'only-in-a.ts' })).toBeHidden()

    // …nor keep the confirm live against the newly-active project.
    const confirmBtn = window.locator('.fl-review-discard-btn.confirm')
    const stillArmed = await confirmBtn.isVisible()
    if (stillArmed) {
      await confirmBtn.click()
      await window.waitForTimeout(2_000)
    }

    // Project B's uncommitted work must survive: the user armed the discard in A.
    expect(readFileSync(join(b, 'app.ts'), 'utf8')).toBe('export const PRECIOUS = "b work"\n')
    // And project A's changes are still there — the discard the user asked for
    // never ran against the project it was armed in.
    expect(readFileSync(join(a, 'app.ts'), 'utf8')).toBe('export const version = 2\n')
    expect(errors).toEqual([])
    expect(stillArmed).toBe(false)
  })
})
