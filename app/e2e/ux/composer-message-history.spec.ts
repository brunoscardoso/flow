import { test, expect } from '../fixtures/electron'
import { seedProject, activateProject, cleanupSeeds, openEmptyThread } from './fixtures/seed'
import { AGENT_AUTH_ISOLATED } from './fixtures/worktree'
import { sel } from '../selectors'
import type { Page } from '@playwright/test'

/**
 * #776 — shell-style message history in the composer. After sending messages,
 * ArrowUp on the (empty/first-line) composer recalls them newest-first;
 * ArrowDown walks forward and finally restores the in-progress draft; an edit
 * mid-walk resets the cursor. Credential-free: threads.sendMessage commits the
 * message even though no agent account is configured (the send itself is what
 * records history).
 */

function composerTextarea(win: Page) {
  return win.locator(`${sel.composer} textarea`)
}

async function send(win: Page, text: string): Promise<void> {
  const box = composerTextarea(win)
  // A send still in flight ("Sending…" — the thread's branch is being settled
  // before the message goes) ignores Enter by design; wait it out so this
  // helper sends rather than racing the previous one.
  await expect(win.locator(sel.composer)).not.toContainText('Sending…', { timeout: 15_000 })
  await box.click()
  await box.fill(text)
  await box.press('Enter')
  // The composer clears once the message is committed.
  await expect(box).toHaveValue('', { timeout: 5000 })
}

// A send must never reach the developer's own account.
test.use({ appEnv: AGENT_AUTH_ISOLATED })

test.afterAll(() => cleanupSeeds())

test('ArrowUp/ArrowDown walk sent messages and restore the draft (#776)', async ({ window }) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  const dir = await seedProject(window)
  await activateProject(window, dir)
  // "+" opens the new-thread page, whose Create sends a first message; this
  // spec is about the composer of an existing thread, so it opens an empty one.
  await openEmptyThread(window, dir)
  await expect(window.locator(sel.composer)).toBeVisible()

  await send(window, 'first message')
  await send(window, 'second message')

  const box = composerTextarea(window)
  await box.click()
  await box.type('work in progress')

  // Up: newest first.
  await box.press('ArrowUp')
  await expect(box).toHaveValue('second message')
  // Up again: older.
  await box.press('ArrowUp')
  await expect(box).toHaveValue('first message')
  // At the oldest — a further Up is a no-op.
  await box.press('ArrowUp')
  await expect(box).toHaveValue('first message')

  // Down walks forward, then restores the draft.
  await box.press('ArrowDown')
  await expect(box).toHaveValue('second message')
  await box.press('ArrowDown')
  await expect(box).toHaveValue('work in progress')

  // Editing mid-walk resets: Up→recall, type, Up starts from newest again.
  await box.press('ArrowUp')
  await expect(box).toHaveValue('second message')
  await box.type(' edited')
  await box.press('ArrowUp')
  await expect(box).toHaveValue('second message')

  expect(errors, errors.join(', ')).toHaveLength(0)
})

test('history seeds from PERSISTED messages — recall works without sending this session (#776)', async ({
  window,
}) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  const dir = await seedProject(window)
  await activateProject(window, dir)

  // Persist messages directly (what a previous session's sends look like),
  // including one with a serialized context preamble the user never typed.
  const threadId = await window.evaluate(async (root) => {
    const flow = (
      window as unknown as {
        flow: {
          threads: { create(i: { projectRoot: string; title: string }): Promise<{ id: string }> }
          messages: { append(i: { threadId: string; role: string; content: string }): Promise<unknown> }
        }
      }
    ).flow
    const t = await flow.threads.create({ projectRoot: root, title: 'Persisted history' })
    await flow.messages.append({ threadId: t.id, role: 'user', content: 'persisted question one' })
    await flow.messages.append({
      threadId: t.id,
      role: 'user',
      content: 'Context from notes.md:\n```\n# big blob\n```\n\npersisted question two',
    })
    return t.id
  }, dir)
  void threadId

  // Open the thread fresh — no sends this session.
  await window.getByText('Persisted history', { exact: true }).first().click()
  const box = composerTextarea(window)
  await expect(box).toBeVisible()
  await box.click()

  // ArrowUp recalls the persisted messages, newest first — with the context
  // preamble stripped (only the TYPED text comes back).
  await box.press('ArrowUp')
  await expect(box).toHaveValue('persisted question two')
  await box.press('ArrowUp')
  await expect(box).toHaveValue('persisted question one')

  expect(errors, errors.join(', ')).toHaveLength(0)
})
