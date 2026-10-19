import { test, expect } from '../fixtures/electron'
import { sel } from '../selectors'
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed'
import type { Page } from '@playwright/test'

/**
 * UX sweep — flow 4: Conversation (empty / history render / scroll / follow-up).
 * Drives the real conversation pane against a seeded project + thread whose
 * history is pre-populated through the `messages:append` IPC (raw persistence —
 * no Claude account, no live turn). Streaming / error / done-reconcile paths
 * need a live agent session and are covered by the QA heartbeat's static checks;
 * this probe locks down the deterministic surface a credential-less user hits:
 * selecting a thread renders its transcript, lands at the bottom, keeps a
 * scrolled-up reader put, shows a clean empty pane for a message-less thread,
 * and chunks very long histories behind a "Show earlier" control.
 */

const SCREENS = 'e2e/ux/__screens'

/** Create a thread in `root` with an explicit title via the real IPC bridge. */
async function createThread(win: Page, root: string, title: string): Promise<string> {
  return win.evaluate(
    async ({ root, title }) => {
      const created = (await (
        window as unknown as {
          flow: {
            threads: { create(i: { projectRoot: string; title: string }): Promise<{ id: string }> }
          }
        }
      ).flow.threads.create({ projectRoot: root, title })) as { id: string }
      return created.id
    },
    { root, title },
  )
}

/** Append one raw message (user/assistant/system) to a thread via IPC. */
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
          flow: {
            messages: {
              append(i: { threadId: string; role: string; content: string }): Promise<unknown>
            }
          }
        }
      ).flow.messages.append({ threadId, role, content })
    },
    { threadId, role, content },
  )
}

/** Open a thread in the sidebar so the conversation pane binds + loads it. */
async function openThread(win: Page, title: string): Promise<void> {
  await win.getByText(title, { exact: true }).first().click()
  await expect(win.locator(sel.conversation)).toBeVisible()
}

test.afterAll(() => cleanupSeeds())

test('history: selecting a thread renders its transcript and lands at the bottom', async ({
  window,
}) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  const dir = await seedProject(window)
  await activateProject(window, dir)
  const id = await createThread(window, dir, 'History probe')

  // A realistic short exchange: user question, assistant reply (markdown), then
  // a long tail so the transcript overflows and must scroll.
  await appendMessage(window, id, 'user', 'How do I list files?')
  await appendMessage(
    window,
    id,
    'assistant',
    'Use the `ls` command. For a **detailed** listing:\n\n```bash\nls -la\n```',
  )
  for (let i = 0; i < 30; i++) {
    await appendMessage(window, id, 'user', `Filler question number ${i} to force overflow`)
    await appendMessage(window, id, 'assistant', `Filler answer number ${i}.`)
  }
  await appendMessage(window, id, 'user', 'LAST-MESSAGE-SENTINEL at the very bottom')

  await openThread(window, 'History probe')

  const scroller = window.locator('.fl-conv-scroller')
  await expect(scroller).toBeVisible()

  // The first user turn renders as a user bubble; the assistant reply renders as
  // markdown (a real <code> block, not the literal backtick text).
  await expect(window.locator('.fl-conv-user').first()).toBeVisible()
  await expect(window.locator('.fl-conv-feed code').first()).toBeVisible()

  // A freshly selected thread must land pinned at the bottom — the newest
  // message is visible without the user scrolling.
  await expect(window.getByText('LAST-MESSAGE-SENTINEL at the very bottom')).toBeInViewport()
  const atBottom = await scroller.evaluate(
    (el) => el.scrollHeight - el.scrollTop - el.clientHeight < 4,
  )
  expect(atBottom, 'transcript should land scrolled to the bottom').toBe(true)

  await window.screenshot({ path: `${SCREENS}/conversation-history-bottom.png` })
  expect(errors, errors.join(', ')).toHaveLength(0)
})

test('empty: a thread with no messages shows a clean pane + composer (no error card)', async ({
  window,
}) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  const dir = await seedProject(window)
  await activateProject(window, dir)
  await createThread(window, dir, 'Empty thread probe')
  await openThread(window, 'Empty thread probe')

  // No history → an empty feed, a visible composer, and crucially NO error card
  // (a message-less thread is normal, not a failed load).
  await expect(window.locator(sel.composer)).toBeVisible()
  await expect(window.locator('.fl-conv-entry-error')).toHaveCount(0)
  await expect(window.locator('.fl-conv-user')).toHaveCount(0)

  expect(errors, errors.join(', ')).toHaveLength(0)
})

test('scroll: scrolling up to re-read keeps the reader put (does not yank to bottom)', async ({
  window,
}) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  const dir = await seedProject(window)
  await activateProject(window, dir)
  const id = await createThread(window, dir, 'Scroll probe')
  for (let i = 0; i < 40; i++) {
    await appendMessage(window, id, 'user', `Scroll filler user ${i}`)
    await appendMessage(window, id, 'assistant', `Scroll filler assistant ${i}`)
  }
  await openThread(window, 'Scroll probe')

  const scroller = window.locator('.fl-conv-scroller')
  // Scroll to the top WITH THE WHEEL and confirm the viewport holds there
  // (scroll-lock keeps a reader who scrolled up from being auto-yanked back
  // down). A real gesture, not `scrollTop = 0`: while a freshly opened
  // transcript's entries are still trading their placeholder heights for real
  // ones, an upward move that is not a gesture is layout churn by design
  // (#823) and may only re-pin — writing scrollTop there measured the
  // placeholder settling, not the reader.
  const box = await scroller.boundingBox()
  if (!box) throw new Error('no conversation scroller on screen')
  await window.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  for (let i = 0; i < 20; i++) await window.mouse.wheel(0, -800)
  await expect.poll(() => scroller.evaluate((el) => el.scrollTop)).toBeLessThan(40)
  await window.waitForTimeout(300)
  const stayedUp = await scroller.evaluate((el) => el.scrollTop < 40)
  expect(stayedUp, 'a scrolled-up reader must not be yanked back to the bottom').toBe(true)

  expect(errors, errors.join(', ')).toHaveLength(0)
})

test('chunking: a very long history is chunked behind a "Show earlier" control', async ({
  window,
}) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  const dir = await seedProject(window)
  await activateProject(window, dir)
  const id = await createThread(window, dir, 'Long history probe')
  // HISTORY_WINDOW is 200 — seed comfortably past it so the earlier chunk is
  // hidden behind the control on first render.
  const FIRST = 'FIRST-EVER-MESSAGE-should-be-hidden-initially'
  await appendMessage(window, id, 'user', FIRST)
  for (let i = 0; i < 220; i++) {
    await appendMessage(window, id, 'assistant', `Bulk entry ${i}`)
  }
  await openThread(window, 'Long history probe')

  // The earliest message is chunked out of the initial mount…
  const earlier = window.locator('.fl-conv-earlier')
  await expect(earlier).toBeVisible()
  await expect(window.getByText(FIRST)).toHaveCount(0)

  // …and revealing it mounts the earlier entries.
  await earlier.locator('fl-button').click()
  await expect(window.getByText(FIRST)).toBeVisible()
  await expect(earlier).toHaveCount(0)

  expect(errors, errors.join(', ')).toHaveLength(0)
})
