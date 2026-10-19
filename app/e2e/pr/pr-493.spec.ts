import { test, expect } from '../fixtures/electron'
import { sel } from '../selectors'
import { seedProject, activateProject, cleanupSeeds } from '../ux/fixtures/seed'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'

/**
 * Regression guard for PR #493 — "only auto-drain the prompt queue on natural
 * completion" (#490).
 *
 * The queue feature (#472/#473) auto-sends the next queued prompt when a turn
 * finishes. The bug (#490): it drained on ANY `working → non-working` transition,
 * so clicking **Interrupt** (which emits `working → idle`) or a `failed` turn
 * immediately fired the queued prompt as a brand-new turn — spending a turn the
 * user was actively trying to stop. The fix gates draining behind
 * `shouldAutoDrainOnStatus`, which returns true ONLY for `working → done` (the
 * backend's natural-success signal from `stream-bridge.ts`).
 *
 * This proves the fix against the real, built composer. We reach the `working`
 * state the same way the app does — persist `status: 'working'` via
 * `threads:update`, whose `threads:updated` broadcast re-drives
 * `composer.setStatus(...)`. Transitioning that same status to `idle` is exactly
 * the observable effect of Interrupt; the queued pill must survive it (pre-fix it
 * would vanish, drained into a live turn). Assertions are on observable UI only
 * (pill presence, input state) — never composer internals.
 */

const QUEUE_ITEM = '.fl-composer-queue-item'
const INTERRUPT_BTN = `${sel.composer} fl-button:has-text("Interrupt")`

async function createThread(win: Page, root: string, title: string): Promise<string> {
  return win.evaluate(
    async ({ root, title }) => {
      const created = await (
        window as unknown as {
          flow: {
            threads: {
              create(i: { projectRoot: string; title: string }): Promise<{ id: string }>
            }
          }
        }
      ).flow.threads.create({ projectRoot: root, title })
      return created.id
    },
    { root, title },
  )
}

async function openComposer(win: Page, title = 'Drain-gate probe'): Promise<string> {
  const dir = await seedProject(win)
  writeFileSync(join(dir, 'README.md'), '# seeded\n')
  await activateProject(win, dir)
  const threadId = await createThread(win, dir, title)
  await win.getByText(title, { exact: true }).click()
  await expect(win.locator(sel.composer)).toBeVisible()
  return threadId
}

/** Persist a status on the open thread the way the agent does — the
 *  threads:updated broadcast re-drives the composer's setStatus(). */
async function setThreadStatus(win: Page, threadId: string, status: string): Promise<void> {
  await win.evaluate(
    async ({ id, status }) => {
      await (
        window as unknown as {
          flow: { threads: { update(i: { threadId: string; patch: unknown }): Promise<unknown> } }
        }
      ).flow.threads.update({ threadId: id, patch: { status } })
    },
    { id: threadId, status },
  )
}

test.afterAll(() => cleanupSeeds())

test('interrupting (working → idle) leaves the queued prompt parked, not auto-sent', async ({
  window,
}) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  const threadId = await openComposer(window)

  // Enter the working state — Interrupt is shown, Send is hidden.
  await setThreadStatus(window, threadId, 'working')
  await expect(window.locator(INTERRUPT_BTN)).toBeVisible()

  // Queue a prompt while working — it parks as a pill and clears the input.
  const textarea = window.locator(`${sel.composer} textarea`)
  await textarea.click()
  await textarea.type('run the migration when you are done')
  await textarea.press('Enter')
  const pill = window.locator(QUEUE_ITEM)
  await expect(pill).toHaveCount(1)
  await expect(pill).toContainText('run the migration when you are done')
  await expect(textarea).toHaveValue('')

  // Interrupt: the agent-manager emits `working → idle`. This is the user's stop
  // button — the queued prompt must NOT auto-drain into a fresh turn (#490).
  // Pre-fix, `wasWorking && status !== 'working'` drained here and the pill vanished.
  await setThreadStatus(window, threadId, 'idle')

  // The pill is still parked — the user chooses when to send it.
  await expect(pill).toHaveCount(1)
  await expect(pill).toContainText('run the migration when you are done')

  // The manual escape hatch survives too: "Send now" is still offered.
  await expect(pill.getByRole('button', { name: 'Send now' })).toBeVisible()

  expect(errors, errors.join(', ')).toHaveLength(0)
})

test('a failed turn (working → failed) also leaves the queue parked', async ({ window }) => {
  const threadId = await openComposer(window, 'Failed-drain probe')

  await setThreadStatus(window, threadId, 'working')
  await expect(window.locator(INTERRUPT_BTN)).toBeVisible()

  const textarea = window.locator(`${sel.composer} textarea`)
  await textarea.click()
  await textarea.type('follow-up idea to run next')
  await textarea.press('Enter')
  await expect(window.locator(QUEUE_ITEM)).toHaveCount(1)

  // A turn that ends in error must not silently fire the queued prompt — that
  // would hide the failure behind a brand-new turn (#490).
  await setThreadStatus(window, threadId, 'failed')

  await expect(window.locator(QUEUE_ITEM)).toHaveCount(1)
  await expect(window.locator(QUEUE_ITEM)).toContainText('follow-up idea to run next')
})
