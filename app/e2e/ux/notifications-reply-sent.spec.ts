import { test, expect } from '../fixtures/electron'
import { sel } from '../selectors'
import { waitForFlowState } from './fixtures/seed'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from '@playwright/test'

/**
 * Notifications / flow status line UX regression guard — flow 13 of the
 * progressive sweep. Covers the previously un-probed POSITIVE-FEEDBACK path:
 * after a user answers a blocked-prompt via the sticky reply card, the app must
 * confirm the reply was delivered.
 *
 * Prior flow-13 rounds drove the reply lifecycle only as far as "the prompt card
 * clears and the prompt file is deleted" — they never asserted the user gets any
 * acknowledgement that their reply went through. The notification center raises a
 * "Reply sent" confirmation (a real toast + a durable inbox history entry) inside
 * the sticky card's `respondPrompt().then(...)` handler (notification-center.ts
 * ~L221-231), and it only fires on a real successful `flow:respondPrompt` round
 * trip through the main-process FlowObserver (archive → unlink the prompt file).
 * This guard drives that whole real-IPC loop and asserts the confirmation.
 *
 * We seed a project whose `flow/` dir already exists (so the chokidar watcher
 * starts on it) and write a real `.heartbeat-prompt.md`, exactly what the
 * plan-flow daemon does — the observer reads it, pushes `flow:stateChanged`
 * with a pendingPrompt, and the sticky reply card appears. Replying then hits
 * the real handler, which deletes the file and resolves, firing the confirmation.
 *
 * A `pageerror`/`console.error` listener fails the flow on any uncaught error.
 */

const seededDirs: string[] = []
test.afterAll(() => {
  for (const d of seededDirs) rmSync(d, { recursive: true, force: true })
})

/**
 * Create a git repo with a PRE-EXISTING `flow/` dir (so the FlowObserver watcher
 * starts on it) seeded with the given files, mark it onboarded (so the per-project
 * flow-settings overlay never auto-opens), then add it as a project root.
 */
async function seedWithFlow(win: Page, files: Record<string, string>): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'flow-reply-'))
  execFileSync('git', ['init', '-q'], { cwd: dir })
  const flowDir = join(dir, 'flow')
  mkdirSync(flowDir, { recursive: true })
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(flowDir, name), content, 'utf-8')
  }
  seededDirs.push(dir)
  await win.evaluate(async (p) => {
    try {
      const key = 'flow.onboarded'
      const seen: string[] = JSON.parse(localStorage.getItem(key) ?? '[]')
      if (!seen.includes(p)) seen.push(p)
      localStorage.setItem(key, JSON.stringify(seen))
    } catch {
      /* convenience only */
    }
    await (
      window as unknown as {
        flow: { project: { add(r: { path: string }): Promise<unknown> } }
      }
    ).flow.project.add({ path: p })
  }, dir)
  return dir
}

test.describe('notifications / flow status line — reply-sent confirmation UX', () => {
  test('answering a blocked prompt confirms the reply was delivered (toast + inbox history)', async ({
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
    await expect(blocked).toBeHidden()

    // Seed a project — wait for BOTH its active skill AND autopilot flag to
    // be observed before writing the prompt file. That double round-trip proves the
    // FlowObserver's chokidar watch is fully settled on the freshly-added root,
    // so the later prompt-file write is reliably picked up (mirrors the proven
    // status-line.spec timing; a raw addRoot's watcher needs a beat to warm up).
    const dir = await seedWithFlow(window, {
      'STATE.md': '# State\n\n- **Active Skill**: execute-plan\n- **Current Phase**: Phase 2\n',
      '.flowconfig': 'autopilot: true\n',
    })
    // (Read from main: the status-bar readouts that showed it were retired.)
    await waitForFlowState(window, dir, (state) => state.activeSkill === 'execute-plan' && state.autopilot)

    // Now make it block with a real heartbeat prompt.
    const promptPath = join(dir, 'flow', '.heartbeat-prompt.md')
    writeFileSync(
      promptPath,
      '**Task**: deploy-check\n\nApprove the migration before continuing? Reply yes/no.\n',
      'utf-8',
    )

    // The blocked indicator lights and the sticky reply card appears.
    await expect(blocked).toBeVisible({ timeout: 8000 })
    const reply = window.locator('.fl-flow-reply')
    await expect(reply).toHaveCount(1, { timeout: 8000 })
    await window.screenshot({ path: 'e2e/ux/__screens/notifications-reply-blocked.png' })

    // Answer the prompt via the sticky card's Send reply button.
    await reply.fill('yes, approved')
    await window.locator('.fl-flow-prompt fl-button[variant="primary"]').click()

    // POSITIVE FEEDBACK (the un-probed part): the app must CONFIRM the reply was
    // delivered — a "Reply sent" toast, not just a silent card teardown.
    const confirmToast = window
      .locator('.fl-flow-toast')
      .filter({ has: window.locator('.fl-flow-title', { hasText: 'Reply sent' }) })
    await expect(confirmToast).toHaveCount(1, { timeout: 8000 })
    // Since #1074 the confirmation names the project that resumes ("Prompt
    // archived — <project> will resume the task.") instead of "the daemon".
    await expect(confirmToast).toContainText('will resume the task')

    // The sticky prompt card is gone and the blocked indicator clears (real
    // handler deleted the prompt file → observer re-read → not blocked).
    await expect(window.locator('.fl-flow-reply')).toHaveCount(0, { timeout: 8000 })
    await expect(blocked).toBeHidden({ timeout: 8000 })
    expect(existsSync(promptPath), 'prompt file should be deleted after reply').toBe(false)
    await window.screenshot({ path: 'e2e/ux/__screens/notifications-reply-sent.png' })

    // The confirmation is also durable in the inbox history (a "Reply sent" entry
    // survives after the transient toast) — open the inbox and assert it's there.
    const inboxBtn = flowLine.locator('.fl-flow-line-inbox')
    await inboxBtn.click()
    const inbox = window.locator('.fl-flow-inbox')
    await expect(inbox).toBeVisible()
    await expect(
      inbox.locator('.fl-flow-inbox-entry').filter({ hasText: 'Reply sent' }),
    ).toHaveCount(1)

    expect(errors, `uncaught renderer errors:\n${errors.join('\n')}`).toEqual([])
  })
})
