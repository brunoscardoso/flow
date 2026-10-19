import { test, expect } from '../fixtures/electron'
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed'

/**
 * The chat-learn ask, end to end through the REAL channel.
 *
 * Main decides whether to ask (once per thread, unlearned areas only — see
 * `chat-learn-trigger.ts`, unit-tested); this proves the other half: that the
 * decision reaches a user as a card they can answer, and that the answer goes
 * back over `learn:answerChatLearn`.
 *
 * The event is pushed from MAIN via webContents.send — the same call
 * `maybeAskChatLearn` makes — rather than by driving a real agent turn, which
 * would cost model time to exercise a renderer subscription.
 */

test.afterAll(() => cleanupSeeds())

test('a chat-learn ask renders a card and its answer reaches main', async ({ app, window }) => {
  const root = await seedProject(window, 'flow-ux-chat-learn-')
  await activateProject(window, root)

  // Record what the renderer sends back, so "the user clicked Learn it" is
  // proven by the IPC that results, not by the card disappearing.
  await app.evaluate(({ ipcMain }) => {
    const g = globalThis as unknown as { __qaChatLearn?: unknown[] }
    g.__qaChatLearn = []
    ipcMain.removeHandler('learn:answerChatLearn')
    ipcMain.handle('learn:answerChatLearn', (_event, request) => {
      ;(globalThis as unknown as { __qaChatLearn: unknown[] }).__qaChatLearn.push(request)
    })
  })

  await app.evaluate(({ BrowserWindow }, payload) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send('learn:chatLearnAsk', payload)
    }
  }, { rootId: root, threadId: 'thread-1', modulePath: 'src/app/api/billing', fileCount: 3, parentName: 'Billing' })

  const card = window.locator('.fl-learn-card')
  await expect(card).toBeVisible({ timeout: 15_000 })
  // The copy has to say WHAT it noticed and WHERE it will land, or the user has
  // no basis to answer.
  await expect(card).toContainText('Learn what you just worked on?')
  await expect(card).toContainText('3 file(s) in src/app/api/billing')
  await expect(card).toContainText('under Billing')

  await card.locator('fl-button', { hasText: 'Learn it' }).click()
  await expect(card).toHaveCount(0)

  const answers = await app.evaluate(
    () => (globalThis as unknown as { __qaChatLearn?: unknown[] }).__qaChatLearn ?? [],
  )
  expect(answers).toEqual([
    { rootId: root, modulePath: 'src/app/api/billing', answer: 'yes' },
  ])
})
