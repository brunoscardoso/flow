import { test, expect } from '../fixtures/electron'
import { sel } from '../selectors'
import { seedProject, activateProject, cleanupSeeds } from '../ux/fixtures/seed'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'

/**
 * Regression guard for PR #473 — "queue prompts while the agent is working" (#472).
 *
 * The delivered contract: while a thread's status is `working`, the composer no
 * longer refuses a send. Instead the primary button becomes **Queue**, hitting
 * Enter / clicking it stashes the message as a pill above the composer (clearing
 * the input), and each pill carries a "Send now" + a ✕ remove. This wiring lives
 * entirely in the renderer (`composer.ts`) and is otherwise proven only by the
 * DOM-free `prompt-queue` unit tests — never against the real, built composer.
 *
 * The queue only manifests in the `working` state, which normally requires a live
 * Claude turn (unavailable headlessly). We reach it the same way the app itself
 * does: persist `status: 'working'` via `threads:update`, whose `threads:updated`
 * broadcast re-drives `composer.setThread(detail)` → `setStatus('working')`. That
 * makes the queue observable end-to-end with no Claude account.
 *
 * Assertions are on observable UI only (button label, pill text/controls, input
 * clearing) — never composer internals.
 */

const QUEUE_ITEM = '.fl-composer-queue-item'
const PRIMARY_BTN = `${sel.composer} fl-button[variant="primary"]`
const INTERRUPT_BTN = `${sel.composer} fl-button:has-text("Interrupt")`

/** Create a thread via the same IPC the "+" button calls; returns its id. */
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

/** Seed a project, activate it, create + open a thread → composer visible. */
async function openComposer(win: Page, title = 'Queue probe'): Promise<string> {
  const dir = await seedProject(win)
  writeFileSync(join(dir, 'README.md'), '# seeded\n')
  await activateProject(win, dir)
  const threadId = await createThread(win, dir, title)
  await win.getByText(title, { exact: true }).click()
  await expect(win.locator(sel.composer)).toBeVisible()
  return threadId
}

/** Persist `status: 'working'` on the open thread the way the agent does — the
 *  threads:updated broadcast re-drives the composer into its working state. */
async function forceWorking(win: Page, threadId: string): Promise<void> {
  await win.evaluate(
    async (id) => {
      await (
        window as unknown as {
          flow: { threads: { update(i: { threadId: string; patch: unknown }): Promise<unknown> } }
        }
      ).flow.threads.update({ threadId: id, patch: { status: 'working' } })
    },
    threadId,
  )
  // The composer reflects `working` by showing Interrupt (Send is hidden until
  // there's something to queue).
  await expect(win.locator(INTERRUPT_BTN)).toBeVisible()
}

test.afterAll(() => cleanupSeeds())

test('while working, the primary action becomes "Queue" and stashes the prompt as a pill', async ({
  window,
}) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  const threadId = await openComposer(window)
  await forceWorking(window, threadId)

  const textarea = window.locator(`${sel.composer} textarea`)
  await textarea.click()
  await textarea.type('investigate the flaky test later')

  // Send has flipped to Queue (not the resting "Send") — the working-state contract.
  await expect(window.locator(PRIMARY_BTN)).toContainText('Queue')

  // Enter queues the message instead of refusing it: a pill appears with the
  // prompt preview, and the input clears (the message is committed to the queue).
  await textarea.press('Enter')
  const pill = window.locator(QUEUE_ITEM)
  await expect(pill).toHaveCount(1)
  await expect(pill).toContainText('investigate the flaky test later')
  await expect(textarea).toHaveValue('')

  // No live turn was launched — status is still working, so the queued prompt
  // must NOT have auto-drained; it stays parked as a pill.
  await expect(pill).toHaveCount(1)

  // Each pill exposes "Send now" + a remove control.
  await expect(pill.getByRole('button', { name: 'Send now' })).toBeVisible()
  await expect(pill.getByRole('button', { name: 'Remove from queue' })).toBeVisible()

  expect(errors, errors.join(', ')).toHaveLength(0)
})

test('a queued prompt can be removed, emptying the queue bar', async ({ window }) => {
  const threadId = await openComposer(window, 'Queue remove probe')
  await forceWorking(window, threadId)

  const textarea = window.locator(`${sel.composer} textarea`)
  await textarea.click()
  await textarea.type('first queued idea')
  await textarea.press('Enter')
  await textarea.type('second queued idea')
  await textarea.press('Enter')

  const pills = window.locator(QUEUE_ITEM)
  await expect(pills).toHaveCount(2)

  // Removing the first pill leaves exactly the other queued prompt.
  await pills.first().getByRole('button', { name: 'Remove from queue' }).click()
  await expect(window.locator(QUEUE_ITEM)).toHaveCount(1)
  await expect(window.locator(QUEUE_ITEM)).toContainText('second queued idea')
})
