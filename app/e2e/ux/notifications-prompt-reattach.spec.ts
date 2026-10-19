import { test, expect } from '../fixtures/electron'
import { sel } from '../selectors'
import { waitForFlowState } from './fixtures/seed'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from '@playwright/test'

/**
 * Notifications — a blocked prompt must stay ANSWERABLE after its project is
 * removed from the sidebar and added back (flow 13 of the progressive sweep,
 * round 14). Previously un-probed seam: every prior flow-13 round drove prompts
 * on a STABLE set of roots (reply / reply-sent / dismiss / multi-card / status
 * line / cross-root precedence). Nothing drove what happens to the prompt-dedupe
 * bookkeeping when a root LEAVES and COMES BACK.
 *
 * The sticky reply card is the ONLY in-app way to answer a blocked task — the
 * card has no generic dismiss precisely so a still-blocked task can never be
 * stranded (notification-center.ts:127-129, #423). The inbox history entry is a
 * plain text row with no reply affordance.
 *
 * How the two sides fit together (renderer `flow/index.ts`):
 *   - `shownPromptIds` dedupes a prompt id across the two channels it can arrive
 *     on (state push + notification push) so a prompt toasts exactly once (#231).
 *   - `refreshRoots()` drops a vanished root's state and calls
 *     `center.dismissPrompt(rootId)` — the card goes away with the project.
 *   - `promptIdFor()` in the main-process observer derives the id from the prompt
 *     FILE'S MTIME (`hb-<mtimeMs>`), so an untouched prompt file keeps the SAME
 *     id forever.
 *
 * Test 1 (live guard): remove drops the card + the red `blocked` indicator, and a
 * genuinely NEW prompt (fresh mtime → new id) on the re-added project still
 * raises a usable reply card. This is the half that works today.
 *
 * Test 2 (`test.fixme`, reproduces issue #970): remove + re-add with the prompt
 * file UNCHANGED. The status line goes red `blocked` again (the state channel
 * re-delivers the pendingPrompt), but `shownPromptIds` was never pruned for the
 * dropped root, so the notify is deduped away and NO reply card is rebuilt — the
 * user is told a task is blocked with no in-app way to answer it. Flip `.fixme`
 * to a live guard once #970 is fixed (prune `shownPromptIds` for a root when its
 * state is dropped in `refreshRoots`).
 */

const seededDirs: string[] = []
test.afterAll(() => {
  // Retry ENOTEMPTY: the IDE's fire-and-forget auto-provisioner can still be
  // writing its scaffold into a seeded root at teardown (same rationale as
  // fixtures/seed.ts cleanupSeeds). Never fail the run on cleanup.
  for (const d of seededDirs) {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      try {
        rmSync(d, { recursive: true, force: true })
        break
      } catch {
        execFileSync('sleep', ['0.3'])
      }
    }
  }
})

/**
 * Throwaway git repo with a PRE-EXISTING `flow/` dir (so the FlowObserver's
 * watcher starts on it), marked onboarded, added as a project root — the same
 * seed the status-line spec uses.
 */
async function seedProject(win: Page): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'flow-reattach-'))
  execFileSync('git', ['init', '-q'], { cwd: dir })
  mkdirSync(join(dir, 'flow'), { recursive: true })
  writeFileSync(
    join(dir, 'flow', 'STATE.md'),
    '# State\n\n- **Active Skill**: execute-plan\n- **Current Phase**: Phase 2\n',
    'utf-8',
  )
  writeFileSync(join(dir, 'flow', '.flowconfig'), 'autopilot: true\n', 'utf-8')
  seededDirs.push(dir)
  await addRoot(win, dir)
  // Wait for BOTH halves of the state to land (skill AND autopilot — a double
  // round-trip) so the chokidar watch on flow/ has certainly attached before we
  // write the prompt file; a raw addRoot + immediate write races the watcher.
  // The FlowObserver has attached once main reports BOTH halves of the seeded
  // state (the status-bar readouts that used to show them were retired).
  await waitForFlowState(win, dir, (state) => state.activeSkill === 'execute-plan' && state.autopilot)
  return dir
}

/**
 * Write the blocked-prompt file and wait for the sticky card. The daemon rewrites
 * this file in the real flow, and a first write can still land in the gap before
 * the watcher settles — retry the write rather than flake. Each retry also nudges
 * the observer's direct-refresh path (flow:setConfig re-reads the snapshot,
 * prompt file included): the chokidar watcher on a /var/folders temp dir is
 * unreliable on macOS (fsevents — see fixtures/seed.ts).
 */
async function raiseBlockedPrompt(win: Page, promptPath: string, body: string): Promise<void> {
  const rootDir = join(promptPath, '..', '..')
  const reply = win.locator('.fl-flow-reply')
  for (let attempt = 0; attempt < 4; attempt += 1) {
    writeFileSync(promptPath, body, 'utf-8')
    if (attempt > 0) {
      await win
        .evaluate(async (p) => {
          await (
            window as unknown as {
              flow: {
                flow: {
                  setConfig(r: { rootId: string; updates: Record<string, string> }): Promise<void>
                }
              }
            }
          ).flow.flow.setConfig({ rootId: p, updates: { autopilot: 'true' } })
        }, rootDir)
        .catch(() => undefined)
    }
    try {
      await expect(reply).toHaveCount(1, { timeout: 5_000 })
      return
    } catch {
      /* watcher not attached yet — rewrite, nudge, and wait again */
    }
  }
  await expect(reply, 'blocked prompt never surfaced a reply card').toHaveCount(1, {
    timeout: 5_000,
  })
}

/** What the sidebar's "Add project" does once the native folder picker returns. */
async function addRoot(win: Page, dir: string): Promise<void> {
  await win.evaluate(async (p) => {
    try {
      const key = 'flow.onboarded'
      const seen: string[] = JSON.parse(localStorage.getItem(key) ?? '[]')
      if (!seen.includes(p)) seen.push(p)
      localStorage.setItem(key, JSON.stringify(seen))
    } catch {
      /* convenience only — keeps the per-project flow overlay from auto-opening */
    }
    await (
      window as unknown as {
        flow: { project: { add(r: { path: string }): Promise<unknown> } }
      }
    ).flow.project.add({ path: p })
  }, dir)
}

/**
 * Dismiss the T1 "Run a basic discovery?" learn card if it is showing — a fixed
 * bottom-right card (z 1003) that can intercept clicks meant for the prompt
 * card's Send reply. Harness-only; no assertion rides on it.
 */
async function dismissLearnCard(win: Page): Promise<void> {
  const notNow = win.locator('.fl-learn-card fl-button', { hasText: 'Not now' })
  if (await notNow.count()) {
    await notNow
      .first()
      .click({ timeout: 2_000 })
      .catch(() => undefined)
  }
}

/** What the sidebar project menu's "Remove" item does (project:remove). */
async function removeProject(win: Page, dir: string): Promise<void> {
  await win.evaluate(async (p) => {
    await (
      window as unknown as {
        flow: { project: { remove(r: { rootPath: string }): Promise<void> } }
      }
    ).flow.project.remove({ rootPath: p })
  }, dir)
}

test.describe('notifications / blocked prompt survives a project re-add', () => {
  test('removing the project drops the card, and a fresh prompt on the re-added project still replies', async ({
    window,
  }) => {
    const errors: string[] = []
    window.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
    window.on('console', (m) => {
      if (m.type() === 'error') errors.push(`console.error: ${m.text()}`)
    })

    const dir = await seedProject(window)
    const promptPath = join(dir, 'flow', '.heartbeat-prompt.md')
    const flowLine = window.locator(sel.flowLine)
    const blocked = flowLine.locator('.fl-flow-line-blocked')
    const reply = window.locator('.fl-flow-reply')

    // A task blocks → red indicator + the sticky reply card.
    await raiseBlockedPrompt(
      window,
      promptPath,
      '**Task**: deploy-check\n\nApprove the migration?\n',
    )
    await expect(blocked).toBeVisible({ timeout: 10_000 })

    // The user removes the project from the sidebar. The card and the red
    // indicator go with it — the prompt itself is untouched on disk.
    await removeProject(window, dir)
    await expect(blocked).toBeHidden({ timeout: 10_000 })
    await expect(reply).toHaveCount(0, { timeout: 10_000 })
    expect(existsSync(promptPath), 'the prompt file is not deleted by removing the project').toBe(
      true,
    )

    // Re-add the project, then let the daemon raise a genuinely NEW prompt (a
    // fresh mtime ⇒ a new prompt id). That path is unaffected by the dedupe set,
    // so the reply card must come back and must be answerable end-to-end.
    await addRoot(window, dir)
    await waitForFlowState(window, dir, (state) => state.activeSkill === 'execute-plan')
    await raiseBlockedPrompt(
      window,
      promptPath,
      '**Task**: deploy-check\n\nA NEWER question — approve?\n',
    )
    await expect(window.locator('.fl-flow-md')).toContainText('A NEWER question')

    await reply.fill('yes')
    // The learn card can pop over the prompt card's actions row and intercept
    // the click — clear it (retrying: it can arrive a beat late).
    await expect(async () => {
      await dismissLearnCard(window)
      await window.locator('.fl-flow-prompt fl-button[variant="primary"]').click({ timeout: 3_000 })
    }).toPass({ timeout: 20_000 })
    await expect(blocked).toBeHidden({ timeout: 10_000 })
    await expect(reply).toHaveCount(0, { timeout: 10_000 })
    expect(existsSync(promptPath), 'replying archives the prompt file').toBe(false)

    expect(errors, `uncaught renderer errors:\n${errors.join('\n')}`).toEqual([])
  })

  // Live guard since #970 was fixed: the shown-prompt registry prunes a dropped
  // root's ids, so the still-pending prompt re-toasts on re-add and the reply
  // card is rebuilt.
  test(
    'a still-blocked project re-added to the sidebar gets its reply card back (#970)',
    async ({ window }) => {
      const errors: string[] = []
      window.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))

      const dir = await seedProject(window)
      const promptPath = join(dir, 'flow', '.heartbeat-prompt.md')
      const flowLine = window.locator(sel.flowLine)
      const blocked = flowLine.locator('.fl-flow-line-blocked')
      const reply = window.locator('.fl-flow-reply')

      await raiseBlockedPrompt(
        window,
        promptPath,
        '**Task**: deploy-check\n\nApprove the migration?\n',
      )
      await expect(blocked).toBeVisible({ timeout: 10_000 })

      // Remove and immediately add the same folder back — the prompt file is
      // untouched, so the task is still blocked and still needs an answer.
      await removeProject(window, dir)
      await expect(reply).toHaveCount(0, { timeout: 10_000 })
      await addRoot(window, dir)

      // The status line agrees the task is blocked …
      await expect(blocked).toBeVisible({ timeout: 10_000 })
      expect(existsSync(promptPath)).toBe(true)
      await window.screenshot({
        path: 'e2e/ux/__screens/notifications-prompt-reattach-blocked-no-card.png',
      })

      // … so the only in-app way to answer it must be present.
      await expect(
        reply,
        'a still-pending blocked prompt must keep a reply card on the re-added project',
      ).toHaveCount(1, { timeout: 10_000 })

      expect(errors, `uncaught renderer errors:\n${errors.join('\n')}`).toEqual([])
    },
  )
})
