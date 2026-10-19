/**
 * WORK AFTER AN ANSWER GOES UNDER THE QUESTION (user, 2026-10-09: "if the user
 * replied already and then the agent starts working again, that component
 * should be on the bottom of the user question, because it is the most
 * recent").
 *
 * A question card lands at the feed's end, under the live "Working" row. While
 * it waits for an answer it keeps the bottom. Once it is answered and the agent
 * works again, the live row moves below it.
 *
 * The answer is delivered through a stubbed `threads:respondDialog` in MAIN —
 * no agent session runs here.
 *
 * Always run hidden: FLOW_E2E=1 FLOW_E2E_BACKGROUND=1.
 */
import type { ElectronApplication, Page } from '@playwright/test'

import { expect, test } from '../fixtures/electron'
import { sel } from '../selectors'
import { activateProject, cleanupSeeds, seedProject } from './fixtures/seed'

test.afterAll(() => cleanupSeeds())

async function toRenderer(app: ElectronApplication, channel: string, payload: unknown): Promise<void> {
  await app.evaluate(
    ({ BrowserWindow }, { channel, payload }) => {
      for (const w of BrowserWindow.getAllWindows()) w.webContents.send(channel, payload)
    },
    { channel, payload },
  )
}

function tool(threadId: string, id: string): Record<string, unknown> {
  return {
    id,
    threadId,
    messageId: null,
    toolName: 'Read',
    inputJson: JSON.stringify({ file_path: `/tmp/${id}.ts` }),
    outputJson: null,
    status: 'running',
    startedAt: new Date().toISOString(),
    completedAt: null,
  }
}

/** Feed order of the live work row and the question card: which comes last. */
function lastOf(page: Page): Promise<'row' | 'card' | null> {
  return page.evaluate(() => {
    const feed = document.querySelector('.fl-conv-feed')
    if (feed === null) return null
    const kids = [...feed.children]
    const row = kids.findIndex((el) => el.querySelector('.fl-request-row') !== null)
    const card = kids.findIndex((el) => el.querySelector('.fl-qcard') !== null)
    if (row < 0 || card < 0) return null
    return row > card ? 'row' : 'card'
  })
}

test('the live row moves under a question once it is answered and work resumes', async ({ app, window: page }) => {
  test.setTimeout(240_000)
  const root = await seedProject(page, 'flow-ux-live-below-answer-')
  await activateProject(page, root)
  const thread = await page.evaluate(
    async (projectRoot) =>
      (await (window as unknown as { flow: { threads: { create(r: unknown): Promise<{ id: string }> } } }).flow.threads.create({
        projectRoot,
        title: 'Answer order thread',
      })),
    root,
  )
  await page.evaluate(
    async (threadId) =>
      (window as unknown as { flow: { messages: { append(r: unknown): Promise<unknown> } } }).flow.messages.append({
        threadId,
        role: 'user',
        content: 'review the plan',
      }),
    thread.id,
  )
  await page.getByText('Answer order thread', { exact: true }).first().click()
  await expect(page.locator(sel.composer)).toBeVisible()

  // An answer reaches a parked dialog: stub the delivery in main.
  await app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('threads:respondDialog')
    ipcMain.handle('threads:respondDialog', () => undefined)
  })

  // The turn works: a tool starts the live row.
  await toRenderer(app, 'threads:stream', { kind: 'status', threadId: thread.id, status: 'working' })
  await toRenderer(app, 'threads:stream', { kind: 'tool-start', threadId: thread.id, toolCall: tool(thread.id, 'before-ask') })
  await expect(page.locator('.fl-request-row').filter({ hasText: 'Working' })).toHaveCount(1)

  // The agent asks.
  await toRenderer(app, 'threads:dialogRequest', {
    requestId: 'ask-order-1',
    threadId: thread.id,
    questions: [
      {
        question: 'How should the plan handle note 1?',
        header: 'Note 1',
        multiSelect: false,
        options: [
          { label: 'Reopen note 1', description: 'Put it back to proposed' },
          { label: 'Keep as is', description: 'Leave the plan unchanged' },
        ],
      },
    ],
  })
  const card = page.locator('.fl-qcard')
  await expect(card).toHaveCount(1)
  // POSITIVE FIRST (allowed-pattern #28): the waiting card is at the bottom …
  await expect.poll(() => lastOf(page)).toBe('card')

  // … and a stray tool while it waits does not move the row past it.
  await toRenderer(app, 'threads:stream', { kind: 'tool-start', threadId: thread.id, toolCall: tool(thread.id, 'while-waiting') })
  await page.waitForTimeout(300)
  expect(await lastOf(page)).toBe('card')

  // The person answers.
  await card.locator('.fl-qcard-option').nth(1).click()
  const submit = card.locator('.fl-qcard-submit').first()
  if (await submit.isEnabled()) await submit.click()
  await expect(card.locator('.fl-qcard-submit').first()).toHaveText(/Answered/)

  // The agent works again: the live row is now the newest thing, under the card.
  await toRenderer(app, 'threads:stream', { kind: 'tool-start', threadId: thread.id, toolCall: tool(thread.id, 'after-answer') })
  await expect.poll(() => lastOf(page)).toBe('row')
  await expect(page.locator('.fl-request-row')).toHaveCount(1)
})
