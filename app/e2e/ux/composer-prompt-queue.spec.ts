import { test, expect } from '../fixtures/electron'
import { sel } from '../selectors'
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'

/**
 * UX sweep — flow 3 (composer): the prompt QUEUE (#472 / #524).
 *
 * A user who fires off another message while the agent is still working should
 * NOT be refused — the composer queues the message (auto-sent FIFO when the turn
 * finishes) and shows a removable queue pill with a "Send now" affordance. This
 * guards the reachable, deterministic half of that flow:
 *   - while working, Send is relabelled "Queue" and an Interrupt affordance appears
 *   - Enter enqueues the draft (textarea clears; a pill shows the preview + buttons)
 *   - a whitespace-only draft is NOT enqueued (nothing to send)
 *   - the pill's remove button drops the queued prompt
 *
 * The agent is unreachable without credentials, so "working" is driven by
 * injecting the real `threads:stream` status event the agent-manager would emit
 * (main → renderer, same channel `ConversationPane` subscribes to). This is a
 * pure UX guard — no product bug was found; the queue is robust.
 */

const SCREENS = 'e2e/ux/__screens'

/** Create a thread via the same IPC the "+" button calls; return its id. */
async function createThread(win: Page, root: string, title: string): Promise<string> {
  return win.evaluate(
    async ({ root, title }) => {
      const t = await (
        window as unknown as {
          flow: {
            threads: { create(i: { projectRoot: string; title: string }): Promise<{ id: string }> }
          }
        }
      ).flow.threads.create({ projectRoot: root, title })
      return t.id
    },
    { root, title },
  )
}

test.afterAll(() => cleanupSeeds())

test('prompts queue while the agent is working, and are removable', async ({ app, window }) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  // Seed a project + thread and open the composer (no Claude account needed —
  // threads:create only needs a project root).
  const dir = await seedProject(window)
  writeFileSync(join(dir, 'README.md'), '# seeded\n')
  await activateProject(window, dir)
  const threadId = await createThread(window, dir, 'Queue')
  await window.getByText('Queue', { exact: true }).click()
  await expect(window.locator(sel.composer)).toBeVisible()
  const textarea = window.locator(`${sel.composer} textarea`)

  // Drive the thread into `working` by emitting the real status stream event.
  await app.evaluate(
    ({ BrowserWindow }, { threadId }) => {
      const w = BrowserWindow.getAllWindows()[0]
      w?.webContents.send('threads:stream', { kind: 'status', threadId, status: 'working' })
    },
    { threadId },
  )

  // While working, an Interrupt affordance is offered (Send relabels to "Queue").
  const interrupt = window.locator(`${sel.composer} fl-button`, { hasText: 'Interrupt' })
  await expect(interrupt).toBeVisible()

  // Typing a prompt + Enter QUEUES it (does not refuse): textarea clears, one pill.
  const queueItems = window.locator(`${sel.composer} .fl-composer-queue-item`)
  await textarea.click()
  await textarea.type('first queued prompt')
  await textarea.press('Enter')
  await expect(textarea).toHaveValue('')
  await expect(queueItems).toHaveCount(1)
  await expect(window.locator(`${sel.composer} .fl-composer-queue-preview`).first()).toHaveText(
    'first queued prompt',
  )
  // The pill offers a "Send now" affordance (jump-the-queue, #524).
  await expect(
    window.locator(`${sel.composer} .fl-composer-queue-item`, { hasText: 'Send now' }),
  ).toHaveCount(1)

  // A second prompt queues behind the first (FIFO).
  await textarea.type('second queued prompt')
  await textarea.press('Enter')
  await expect(queueItems).toHaveCount(2)

  // A whitespace-only draft is NOT queued — nothing to send.
  await textarea.type('     ')
  await textarea.press('Enter')
  await expect(queueItems).toHaveCount(2)

  await window.screenshot({ path: `${SCREENS}/composer-prompt-queue.png` })

  // Removing a queued prompt via its ✕ drops exactly that pill.
  await queueItems.first().locator('button').last().click()
  await expect(queueItems).toHaveCount(1)

  expect(errors, errors.join(', ')).toHaveLength(0)
})
