import { join } from 'node:path'

import { test, expect } from '../fixtures/electron'
import { seedProject, activateProject, cleanupSeeds, openThreadByTitle } from './fixtures/seed'

/**
 * Learning from chat is automatic, and the conversation says so
 * (user decision 2026-11-17 — the "Learn what you just worked on?" corner card
 * is gone).
 *
 * Main writes a `[chat-learn]` system row when the learn starts and another
 * when it ends (`maybeLearnFromChat` / `onChatLearnSettled`). Driving a real
 * agent turn and a real learn pass would cost model time to exercise the
 * transcript, so the rows are written through the real `messages:append`
 * channel — the same table main writes — and the store's change broadcast is
 * what brings them on screen. Try again is answered in MAIN (`window.flow` is
 * a contextBridge proxy) and records what the renderer sent.
 *
 * Always run hidden: FLOW_E2E=1 FLOW_E2E_BACKGROUND=1.
 */

test.afterAll(() => cleanupSeeds())

const row = (root: string, phase: string): string =>
  `[chat-learn] ${JSON.stringify({ root, module: 'src/components/modules/CoworkerPanel', files: 26, phase })}`

test('a learn started from chat shows one row in that conversation, through learned, failed and Try again', async ({
  app,
  window,
}) => {
  const errors: string[] = []
  window.on('pageerror', (error) => errors.push(error.message))

  const root = await seedProject(window, 'flow-ux-chat-learn-')
  await activateProject(window, root)
  const threadId = await window.evaluate(
    async ({ root }) =>
      (
        await (
          window as unknown as {
            flow: { threads: { create(i: { projectRoot: string; title: string }): Promise<{ id: string }> } }
          }
        ).flow.threads.create({ projectRoot: root, title: 'Coworker panel work' })
      ).id,
    { root },
  )
  await openThreadByTitle(window, 'Coworker panel work')

  await app.evaluate(({ ipcMain }) => {
    const g = globalThis as unknown as { __qaRetry?: unknown[] }
    g.__qaRetry = []
    ipcMain.removeHandler('learn:retryChatLearn')
    ipcMain.handle('learn:retryChatLearn', (_event, request) => {
      ;(globalThis as unknown as { __qaRetry: unknown[] }).__qaRetry.push(request)
    })
  })
  const append = (content: string) =>
    window.evaluate(
      async ({ threadId, content }) => {
        await (
          window as unknown as {
            flow: { messages: { append(i: { threadId: string; role: string; content: string }): Promise<unknown> } }
          }
        ).flow.messages.append({ threadId, role: 'system', content })
      },
      { threadId, content },
    )

  // ── Learning: the row appears in the open conversation, live ─────────────
  await append(row(root, 'learning'))
  const card = window.locator('.fl-chat-learn')
  await expect(card).toHaveCount(1, { timeout: 15_000 })
  await expect(card).toHaveAttribute('data-phase', 'learning')
  await expect(card).toContainText('Learning CoworkerPanel for the blueprint')
  await expect(card).toContainText('From the 26 files this conversation touched')
  // No path, no raw marker text in the transcript (forbidden-pattern #12).
  await expect(window.locator('.fl-conv-system', { hasText: '[chat-learn]' })).toHaveCount(0)
  await expect(card).not.toContainText('src/components')
  // …and no chat ask in the corner (the basic-discovery ask for a project
  // outside every Workspace shares the card shape and stays).
  await expect(window.locator('.fl-learn-card', { hasText: 'Learn what you just worked on?' })).toHaveCount(0)

  // ── Learned: the SAME single row now says so, with a way to the board ────
  await append(row(root, 'learned'))
  await expect(card).toHaveAttribute('data-phase', 'learned', { timeout: 15_000 })
  await expect(card).toHaveCount(1)
  await expect(card).toContainText('Learned CoworkerPanel')
  await expect(card.getByRole('button', { name: 'Show on the board' })).toBeVisible()
  await window.screenshot({ path: join(__dirname, '__screens', 'learn-chat-row-learned.png') })

  // ── A second learn of the same area that fails offers Try again ──────────
  await append(row(root, 'failed'))
  await expect(card).toHaveAttribute('data-phase', 'failed', { timeout: 15_000 })
  await expect(card).toHaveCount(1)
  await expect(card).toContainText('Could not learn CoworkerPanel')
  await card.getByRole('button', { name: 'Try again' }).click()
  await expect
    .poll(() => app.evaluate(() => (globalThis as unknown as { __qaRetry?: unknown[] }).__qaRetry ?? []))
    .toEqual([{ threadId, rootId: root, modulePath: 'src/components/modules/CoworkerPanel' }])

  // The rows are the record: a reload shows the same single row.
  await window.reload()
  await openThreadByTitle(window, 'Coworker panel work')
  await expect(window.locator('.fl-chat-learn')).toHaveCount(1, { timeout: 20_000 })
  await expect(window.locator('.fl-chat-learn')).toHaveAttribute('data-phase', 'failed')

  expect(errors, errors.join('\n')).toEqual([])
})
