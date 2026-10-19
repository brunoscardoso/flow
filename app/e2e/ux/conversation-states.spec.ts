import { test, expect } from '../fixtures/electron'
import { sel } from '../selectors'
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed'
import type { Page } from '@playwright/test'

/**
 * UX sweep — flow 4: Conversation STATES (round 5).
 *
 * Complements `conversation.spec.ts` (history render / empty pane / scroll-lock /
 * chunking) and `conversation-lifecycle.spec.ts` (delete / switch race / re-chunk
 * / rich render) by locking down four more surfaces a credential-less user hits,
 * all drivable through the raw `messages:append` IPC (no Claude account / live
 * turn):
 *
 *  - expanding the "Show earlier" chunk while scrolled up keeps the reader
 *    ANCHORED (the `scrollTop += scrollHeight - previousHeight` math) — it must
 *    not yank them to the top or snap them to the bottom,
 *  - switching from a populated thread to a genuinely EMPTY one lands on a clean
 *    empty pane (no leftover bubbles, composer still visible, no error card),
 *  - consecutive user messages with no assistant reply (queued sends) render as
 *    stacked user bubbles in order, newest at the bottom,
 *  - a thread whose final entry is a SYSTEM note lands pinned at the bottom with
 *    the note visible (system messages are terminal, not a failed load).
 */

const SCREENS = 'e2e/ux/__screens'

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

async function openThread(win: Page, title: string): Promise<void> {
  await win.getByText(title, { exact: true }).first().click()
  await expect(win.locator(sel.conversation)).toBeVisible()
}

test.afterAll(() => cleanupSeeds())

test('earlier: expanding the chunk while scrolled up keeps the reader anchored', async ({
  window,
}) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  const dir = await seedProject(window)
  await activateProject(window, dir)
  const id = await createThread(window, dir, 'Anchor probe')
  // Seed past HISTORY_WINDOW (200) so the earliest chunk is hidden behind the
  // "Show earlier" control. The first visible entry is a known sentinel.
  //
  // Each answer gets its own question: in Compact a run of assistant messages
  // with no question between them is ONE request (its earlier answers fold
  // into the work row as steps), so 260 bare answers rendered as a single
  // entry and there was no transcript to scroll through.
  await appendMessage(window, id, 'user', 'HIDDEN-EARLIEST')
  for (let i = 0; i < 130; i++) {
    await appendMessage(window, id, 'user', `Anchor bulk question number ${i}`)
    await appendMessage(window, id, 'assistant', `Anchor bulk entry number ${i}`)
  }
  await openThread(window, 'Anchor probe')

  const scroller = window.locator('.fl-conv-scroller')
  const earlier = window.locator('.fl-conv-earlier')
  await expect(earlier).toBeVisible()

  // Scroll to the top so the "Show earlier" control and the first visible entry
  // are in view — this is exactly where a real user clicks it.
  // With the wheel: a programmatic `scrollTop = 0` during the first frames of
  // a fresh transcript is indistinguishable from placeholder-height churn and
  // is re-pinned by design (#823); a reader's gesture is not.
  const box = await scroller.boundingBox()
  if (!box) throw new Error('no conversation scroller on screen')
  await window.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await expect
    .poll(
      async () => {
        await window.mouse.wheel(0, -4000)
        return scroller.evaluate((el) => el.scrollTop)
      },
      { timeout: 15000 },
    )
    .toBeLessThan(4)
  await window.waitForTimeout(150)

  // The earliest answer still MOUNTED — read off the transcript rather than
  // computed, since how many entries the window keeps is the pane's business.
  const firstAnswer = window
    .locator('.fl-conv-entry-assistant .fl-md')
    .filter({ hasText: /^Anchor bulk entry number \d+$/ })
    .first()
  await expect(firstAnswer).toBeVisible()
  const anchorText = (await firstAnswer.innerText()).trim()
  expect(anchorText, 'precondition: the earliest answers are behind "Show earlier"').not.toBe(
    'Anchor bulk entry number 0',
  )
  const firstVisible = window.getByText(anchorText, { exact: true })
  await expect(firstVisible).toBeVisible()
  const beforeTop = await firstVisible.evaluate((el) => el.getBoundingClientRect().top)

  // Expand the earlier chunk.
  await earlier.locator('fl-button').click()
  await expect(window.getByText('HIDDEN-EARLIEST')).toBeVisible()
  await window.waitForTimeout(150)

  // The reader must stay put: the message they were looking at should remain in
  // roughly the same viewport position — not yanked to the top (delta ~ its old
  // offset) nor snapped to the bottom. A generous tolerance guards the intent
  // (anchoring preserved) without being brittle to content-visibility estimates.
  const afterTop = await firstVisible.evaluate((el) => el.getBoundingClientRect().top)
  expect(
    Math.abs(afterTop - beforeTop),
    `reader anchor drifted ${Math.abs(afterTop - beforeTop)}px on expand (before=${beforeTop}, after=${afterTop})`,
  ).toBeLessThan(220)

  // And it must NOT have snapped to the bottom.
  const atBottom = await scroller.evaluate(
    (el) => el.scrollHeight - el.scrollTop - el.clientHeight < 4,
  )
  expect(atBottom, 'expanding earlier must not snap the reader to the bottom').toBe(false)

  await window.screenshot({ path: `${SCREENS}/conversation-earlier-anchored.png` })
  expect(errors, errors.join(', ')).toHaveLength(0)
})

test('switch: a populated thread → an empty thread lands on a clean empty pane', async ({
  window,
}) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  const dir = await seedProject(window)
  await activateProject(window, dir)
  const full = await createThread(window, dir, 'Full thread')
  await createThread(window, dir, 'Blank thread')
  await appendMessage(window, full, 'user', 'FULL-THREAD-CONTENT-MARKER')
  await appendMessage(window, full, 'assistant', 'A reply that must not leak into the blank thread.')

  await openThread(window, 'Full thread')
  await expect(window.getByText('FULL-THREAD-CONTENT-MARKER')).toBeVisible()

  // Switch to the empty thread — its pane must be clean: no leftover bubbles from
  // the populated thread, a still-visible composer (you can type), and crucially
  // no error card (an empty thread is normal, not a failed load).
  await openThread(window, 'Blank thread')
  await expect(window.getByText('FULL-THREAD-CONTENT-MARKER')).toHaveCount(0)
  await expect(window.locator('.fl-conv-user')).toHaveCount(0)
  await expect(window.locator('.fl-conv-entry-error')).toHaveCount(0)
  await expect(window.locator(sel.composer)).toBeVisible()

  await window.screenshot({ path: `${SCREENS}/conversation-switch-to-empty.png` })
  expect(errors, errors.join(', ')).toHaveLength(0)
})

test('queued: consecutive user messages render as stacked bubbles in order', async ({ window }) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  const dir = await seedProject(window)
  await activateProject(window, dir)
  const id = await createThread(window, dir, 'Queue thread')
  // A real user can queue several messages before the agent replies — each must
  // render as its own user bubble, in send order.
  await appendMessage(window, id, 'user', 'Queued message ONE')
  await appendMessage(window, id, 'user', 'Queued message TWO')
  await appendMessage(window, id, 'user', 'Queued message THREE-LAST')
  await openThread(window, 'Queue thread')

  const bubbles = window.locator('.fl-conv-user')
  await expect(bubbles).toHaveCount(3)
  // Order preserved: the last-sent message is the last bubble and is at the bottom.
  await expect(bubbles.nth(0)).toContainText('Queued message ONE')
  await expect(bubbles.nth(2)).toContainText('Queued message THREE-LAST')
  await expect(window.getByText('Queued message THREE-LAST')).toBeInViewport()
  expect(errors, errors.join(', ')).toHaveLength(0)
})

test('system-tail: a thread ending in a system note lands at the bottom showing it', async ({
  window,
}) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  const dir = await seedProject(window)
  await activateProject(window, dir)
  const id = await createThread(window, dir, 'System tail thread')
  await appendMessage(window, id, 'user', 'Run the migration.')
  await appendMessage(window, id, 'assistant', 'Done — see the note below.')
  // A terminal system note (session ended / interrupted / model switch) is a
  // common last entry — it must render as a system note and be the bottom-pinned
  // final entry, not treated as an error or hidden below the fold.
  await appendMessage(window, id, 'system', 'SESSION-ENDED-SYSTEM-NOTE at the very end.')
  await openThread(window, 'System tail thread')

  await expect(window.locator('.fl-conv-system').last()).toContainText(
    'SESSION-ENDED-SYSTEM-NOTE',
  )
  await expect(window.getByText('SESSION-ENDED-SYSTEM-NOTE at the very end.')).toBeInViewport()
  await expect(window.locator('.fl-conv-entry-error')).toHaveCount(0)
  const atBottom = await window
    .locator('.fl-conv-scroller')
    .evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight < 4)
  expect(atBottom, 'a system-tail thread should land scrolled to the bottom').toBe(true)
  expect(errors, errors.join(', ')).toHaveLength(0)
})
