import { test, expect } from '../fixtures/electron'
import { sel } from '../selectors'
import { waitForFlowState } from './fixtures/seed'
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  readdirSync,
  rmSync,
} from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from '@playwright/test'

/**
 * Notifications — answering a blocked prompt that was SWAPPED underneath the
 * user (flow 13 of the progressive sweep, round 15). Previously un-probed seam.
 *
 * The heartbeat daemon writes ONE prompt file per project
 * (`flow/.heartbeat-prompt.md`) and keeps running its other scheduled tasks
 * while a prompt is pending — `executeTask` has no "a prompt is already
 * pending" gate, and `writePrompt` (prompt-manager.ts) overwrites the file
 * atomically (temp + rename). So a second task blocking while the user is
 * reading/answering the first prompt REPLACES the pending question in place.
 *
 * The app derives the prompt id from the file's mtime (flow-observer.ts
 * `promptIdFor`), so a swap yields a NEW id, and the renderer replaces the
 * sticky reply card (notification-center.ts ~L149, one live card per root).
 *
 * Two invariants matter to the user here:
 *   1. the LATEST question always reaches the screen — a swapped-in prompt must
 *      never leave the user staring at a stale question (live guard below);
 *   2. a reply typed for question A must never be DELIVERED as the answer to
 *      question B. `flow:respondPrompt` carries the promptId the card was built
 *      from precisely so main can check it — but flow-observer.ts (L491-496)
 *      only `console.warn`s on a mismatch and then answers "the latest prompt"
 *      anyway, archiving B's text with A's answer, unlinking the prompt file
 *      (which is what unblocks the daemon), and reporting "Reply sent" to the
 *      user. See test 2.
 *
 * Driven through the real seed path (a project whose `flow/` dir exists so the
 * FlowObserver watcher starts on it, real `.heartbeat-prompt.md` writes, real
 * `flow:respondPrompt` IPC). No Claude account needed.
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
 * Throwaway git repo with a PRE-EXISTING `flow/` dir (so the watcher starts on
 * it), added as a project root. Waits for BOTH halves of the state (skill AND
 * autopilot) so the chokidar watch has certainly attached before prompt writes.
 */
async function seedProject(win: Page): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'flow-swap-'))
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
  // The FlowObserver has attached once main reports BOTH halves of the seeded
  // state (the status-bar readouts that used to show them were retired).
  await waitForFlowState(win, dir, (state) => state.activeSkill === 'execute-plan' && state.autopilot)
  return dir
}

/** Write the prompt file and wait for the sticky card; retry — a first write can
 *  land in the gap before the watcher settles (the daemon rewrites too). Each
 *  retry also nudges the observer's direct-refresh path (flow:setConfig re-reads
 *  the snapshot, prompt file included): the chokidar watcher on a /var/folders
 *  temp dir is unreliable on macOS (fsevents — see fixtures/seed.ts). */
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

/** Question the user actually reads and answers. */
const PROMPT_A =
  '**Task**: deploy-check\n\n## Action Required\n\nApprove the staging migration before continuing? Reply yes/no.\n'
/** Question a second blocked task swaps in underneath them. */
const PROMPT_B =
  '**Task**: db-drop\n\n## Action Required\n\nDROP the production database and recreate it from scratch? Reply yes/no.\n'

test.describe('notifications — blocked prompt swapped underneath the reply', () => {
  test('a prompt swapped in by a second blocked task reaches the screen (latest question wins)', async ({
    window,
  }) => {
    const errors: string[] = []
    window.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
    window.on('console', (m) => {
      if (m.type() === 'error') errors.push(`console.error: ${m.text()}`)
    })

    const flowLine = window.locator(sel.flowLine)
    await expect(flowLine).toBeVisible()
    const blocked = flowLine.locator('.fl-flow-line-blocked')

    const dir = await seedProject(window)
    const promptPath = join(dir, 'flow', '.heartbeat-prompt.md')
    await raiseBlockedPrompt(window, promptPath, PROMPT_A)
    await expect(blocked).toBeVisible()

    const card = window.locator('.fl-flow-toast').filter({ hasText: 'Task blocked' })
    await expect(card).toContainText('staging migration')

    // The user starts typing an answer to the question on screen.
    await window.locator('.fl-flow-reply').fill('yes, approved')

    // A SECOND task blocks → the daemon overwrites the pending prompt file.
    // The chokidar watcher on a /var/folders temp dir is unreliable (fsevents —
    // see fixtures/seed.ts), so nudge the observer's direct-refresh path
    // (flow:setConfig re-reads the snapshot, prompt file included) rather than
    // depending on an fs event that may never fire in this environment. The
    // assertion under guard is unchanged: the newest question must reach the
    // user — a stale card would leave them answering a question that is no
    // longer the one gating the daemon.
    writeFileSync(promptPath, PROMPT_B, 'utf-8')
    await expect(async () => {
      await window.evaluate(async (p) => {
        await (
          window as unknown as {
            flow: {
              flow: {
                setConfig(r: { rootId: string; updates: Record<string, string> }): Promise<void>
              }
            }
          }
        ).flow.flow.setConfig({ rootId: p, updates: { autopilot: 'true' } })
      }, dir)
      await expect(card).toContainText('DROP the production database', { timeout: 3_000 })
    }).toPass({ timeout: 30_000 })
    await expect(card).toContainText('Task blocked: db-drop')
    await expect(blocked).toBeVisible()
    await expect(window.locator('.fl-flow-reply')).toHaveCount(1)

    expect(errors, `uncaught renderer errors:\n${errors.join('\n')}`).toEqual([])
  })

  // Live guard since #1004 was fixed: respondPrompt refuses a stale promptId
  // (the reply is only ever delivered to the prompt the user actually saw),
  // the prompt file survives so the daemon stays blocked on the new question,
  // no stray archive is written, and the replacement card carries the user's
  // draft forward instead of destroying it.
  test(
    'a reply typed for question A is never delivered as the answer to question B (#1004)',
    async ({ window }) => {
      const errors: string[] = []
      window.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))

      const flowLine = window.locator(sel.flowLine)
      await expect(flowLine).toBeVisible()

      const dir = await seedProject(window)
      const promptPath = join(dir, 'flow', '.heartbeat-prompt.md')
      await raiseBlockedPrompt(window, promptPath, PROMPT_A)

      const card = window.locator('.fl-flow-toast').filter({ hasText: 'Task blocked' })
      await expect(card).toContainText('staging migration')
      await window.locator('.fl-flow-reply').fill('yes, approved')

      // The swap lands, and the user — still looking at question A — hits Send
      // before the app has noticed (chokidar awaitWriteFinish + 200ms debounce).
      writeFileSync(promptPath, PROMPT_B, 'utf-8')
      await window.evaluate(() => {
        const btn = document.querySelector(
          '.fl-flow-prompt fl-button[variant="primary"]',
        ) as HTMLElement | null
        btn?.click()
      })
      await window.waitForTimeout(4_000)

      const archiveDir = join(dir, 'flow', 'archive', 'heartbeat-prompts')
      const archived = existsSync(archiveDir) ? readdirSync(archiveDir) : []

      // The answer must never be recorded against the task the user never saw…
      expect(
        archived.filter((name) => name.startsWith('prompt_db-drop_')),
        'a reply typed for deploy-check must not be archived as the answer to db-drop',
      ).toEqual([])
      // …and the unanswered question must still be pending (the daemon resumes
      // on the prompt file's REMOVAL, so unlinking it approves db-drop).
      expect(
        existsSync(promptPath),
        'the swapped-in question is still unanswered — its prompt file must survive',
      ).toBe(true)

      expect(errors, `uncaught renderer errors:\n${errors.join('\n')}`).toEqual([])
    },
  )
})
