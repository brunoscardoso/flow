import { test, expect } from '../fixtures/electron'
import { sel } from '../selectors'
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed'
import type { Page } from '@playwright/test'

/**
 * UX sweep — flow 4: Conversation LIFECYCLE (delete / switch / rich render).
 *
 * Complements `conversation.spec.ts` (which locks down history render, the
 * empty pane, scroll-lock, and history chunking) by guarding the transcript's
 * reaction to *thread-level* events a real user triggers constantly:
 *
 *  - deleting the currently-open thread must clear the transcript + hide the
 *    composer (a lingering transcript over a dead thread sends to nothing),
 *  - rapid A→B→A switching must land on the final thread's content with no
 *    leftovers from the intermediate one (the #loadHistory `loadToken` race),
 *  - re-selecting a chunked thread after switching away must re-chunk and land
 *    at the bottom (no stale expanded/scrolled state carried across),
 *  - common assistant output (tables, task lists, blockquotes, links) and a
 *    system note must render without throwing.
 *
 * All history is pre-populated through the `messages:append` IPC (raw
 * persistence — no Claude account, no live turn), the same deterministic
 * surface a credential-less user hits.
 */

const SCREENS = 'e2e/ux/__screens'

async function createThread(win: Page, root: string, title: string): Promise<string> {
  return win.evaluate(
    async ({ root, title }) => {
      const created = (await (
        window as unknown as {
          flow: { threads: { create(i: { projectRoot: string; title: string }): Promise<{ id: string }> } }
        }
      ).flow.threads.create({ projectRoot: root, title })) as { id: string }
      return created.id
    },
    { root, title },
  )
}

async function appendMessage(
  win: Page,
  threadId: string,
  role: 'user' | 'assistant' | 'system',
  content: string,
): Promise<void> {
  await win.evaluate(
    async ({ threadId, role, content }) => {
      await (
        window as unknown as {
          flow: { messages: { append(i: { threadId: string; role: string; content: string }): Promise<unknown> } }
        }
      ).flow.messages.append({ threadId, role, content })
    },
    { threadId, role, content },
  )
}

async function deleteThread(win: Page, threadId: string): Promise<void> {
  await win.evaluate(
    async (id) => {
      await (
        window as unknown as { flow: { threads: { delete(i: { threadId: string }): Promise<unknown> } } }
      ).flow.threads.delete({ threadId: id })
    },
    threadId,
  )
}

async function openThread(win: Page, title: string): Promise<void> {
  await win.getByText(title, { exact: true }).first().click()
  await expect(win.locator(sel.conversation)).toBeVisible()
}

test.afterAll(() => cleanupSeeds())

test('delete: deleting the open thread clears the transcript and hides the composer', async ({
  window,
}) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  const dir = await seedProject(window)
  await activateProject(window, dir)
  const id = await createThread(window, dir, 'Doomed thread')
  await appendMessage(window, id, 'user', 'This thread is about to be deleted')
  await appendMessage(window, id, 'assistant', 'Understood.')
  await openThread(window, 'Doomed thread')
  await expect(window.locator('.fl-conv-user').first()).toBeVisible()
  await expect(window.locator(sel.composer)).toBeVisible()

  // Delete the currently-open thread via the real IPC (mirrors the sidebar
  // context-menu delete → threads:delete → threads:updated broadcast). The
  // renderer must react and clear the conversation surfaces so the user isn't
  // left with a transcript + composer bound to a thread that no longer exists.
  await deleteThread(window, id)

  await expect(window.locator('.fl-conv-user')).toHaveCount(0)
  await expect(window.locator(sel.composer)).toBeHidden()
  expect(errors, errors.join(', ')).toHaveLength(0)
})

test('switch: rapid A→B→A switching lands on A content with no B leftovers', async ({ window }) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  const dir = await seedProject(window)
  await activateProject(window, dir)
  const a = await createThread(window, dir, 'Alpha thread')
  const b = await createThread(window, dir, 'Bravo thread')
  await appendMessage(window, a, 'user', 'ALPHA-UNIQUE-MARKER')
  await appendMessage(window, b, 'user', 'BRAVO-UNIQUE-MARKER')

  // Three clicks with no awaits between — the intermediate history load must be
  // discarded by the loadToken guard so the final selection (Alpha) wins.
  await window.getByText('Alpha thread', { exact: true }).first().click()
  await window.getByText('Bravo thread', { exact: true }).first().click()
  await window.getByText('Alpha thread', { exact: true }).first().click()

  await expect(window.getByText('ALPHA-UNIQUE-MARKER')).toBeVisible()
  await expect(window.getByText('BRAVO-UNIQUE-MARKER')).toHaveCount(0)
  expect(errors, errors.join(', ')).toHaveLength(0)
})

test('re-chunk: re-selecting a chunked thread lands at the bottom, earlier re-hidden', async ({
  window,
}) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  const dir = await seedProject(window)
  await activateProject(window, dir)
  const big = await createThread(window, dir, 'Big thread')
  const small = await createThread(window, dir, 'Small thread')
  // HISTORY_WINDOW is 200 — seed past it so the earliest entry is chunked out.
  await appendMessage(window, big, 'user', 'BIG-FIRST-hidden')
  for (let i = 0; i < 230; i++) await appendMessage(window, big, 'assistant', `Big ${i}`)
  await appendMessage(window, big, 'user', 'BIG-LAST-SENTINEL')
  await appendMessage(window, small, 'user', 'just one')

  await openThread(window, 'Big thread')
  // Reveal the earlier chunk, then switch away.
  await window.locator('.fl-conv-earlier fl-button').click()
  await expect(window.getByText('BIG-FIRST-hidden')).toBeVisible()
  await openThread(window, 'Small thread')

  // Re-select Big — it must re-chunk (earliest hidden behind the control again)
  // and land pinned at the bottom, not preserve the prior expanded/scrolled view.
  await openThread(window, 'Big thread')
  await expect(window.locator('.fl-conv-earlier')).toBeVisible()
  await expect(window.getByText('BIG-FIRST-hidden')).toHaveCount(0)
  await expect(window.getByText('BIG-LAST-SENTINEL')).toBeInViewport()
  const atBottom = await window
    .locator('.fl-conv-scroller')
    .evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight < 6)
  expect(atBottom, 're-selected thread should land scrolled to the bottom').toBe(true)
  expect(errors, errors.join(', ')).toHaveLength(0)
})

test('render: common assistant output (table / task list / blockquote / link) + system note', async ({
  window,
}) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  const dir = await seedProject(window)
  await activateProject(window, dir)
  const id = await createThread(window, dir, 'Rich thread')
  await appendMessage(window, id, 'system', 'Session started with model opus.')
  await appendMessage(window, id, 'user', 'Show me a summary table and a task list.')
  await appendMessage(
    window,
    id,
    'assistant',
    [
      '## Summary',
      '',
      'Here is a **table**:',
      '',
      '| Feature | Status |',
      '| --- | --- |',
      '| Login | done |',
      '| Signup | pending |',
      '',
      'And a task list:',
      '',
      '- [x] Wire the API',
      '- [ ] Write tests',
      '',
      '> A blockquote with a [link](https://example.com).',
    ].join('\n'),
  )
  await openThread(window, 'Rich thread')

  // The markdown renders to real DOM (a <table>, a disabled checkbox, an
  // external link), and the system message renders as a system note.
  await expect(window.locator('.fl-conv-feed table').first()).toBeVisible()
  await expect(window.locator('.fl-conv-feed input[type="checkbox"]').first()).toBeVisible()
  await expect(window.locator('.fl-conv-feed a[href="https://example.com"]').first()).toBeVisible()
  await expect(window.locator('.fl-conv-system').first()).toBeVisible()
  await window.screenshot({ path: `${SCREENS}/conversation-rich-render.png` })
  expect(errors, errors.join(', ')).toHaveLength(0)
})
