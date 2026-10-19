import { test, expect, type ElectronApplication } from '../fixtures/electron'
import { sel } from '../selectors'
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed'
import type { Page } from '@playwright/test'

/**
 * #939 — "Chat panel scrolls up by itself" (user-filed): *sometimes*, after
 * sending a message to an already-running chat, the transcript jumps BACKWARDS
 * the moment the agent finishes — landing close to where the user sent the
 * message instead of on the answer they were waiting for.
 *
 * Reproduced and root-caused here. Feed entries carry `content-visibility:auto`
 * with `contain-intrinsic-size: auto 96px`, so a FRESHLY built entry stands at
 * 96px until the frame that decides it is relevant to the user. Every
 * scroll-to-bottom reads `scrollHeight` in the same tick it writes `scrollTop`,
 * so it aims at a placeholder-derived bottom that is a large under-estimate —
 * and scrolling there is itself what makes the next band of entries render at
 * their real height, moving the bottom again. A single next-frame re-assert
 * (#651) covered one appended card; a whole rebuilt transcript needs the chain
 * to run until the height settles.
 *
 * Measured on this probe's own fixture, before the fix:
 *   - opening the thread    → parked 8572px above the bottom
 *   - a turn completing     → parked 92px above the bottom, permanently
 * Both are 0 after it. "Sometimes" in the report is height-dependent: a
 * one-line reply in a short thread hides the bug completely.
 *
 * The second test is the counterweight — re-asserting must never override a
 * reader who deliberately scrolled away (#823/#179).
 */

const SCREENS = 'e2e/ux/__screens'

/** A realistically long agent answer — far taller than the 96px placeholder. */
const TALL_ANSWER = [
  'Here is what I changed, step by step:',
  '',
  ...Array.from(
    { length: 40 },
    (_, i) => `${i + 1}. Adjusted the handler so the ${i}th case is covered end to end.`,
  ),
  '',
  'ANSWER-TAIL-MARKER — everything above is done.',
].join('\n')

/** History of the shape that actually triggers it: tall answers, not one-liners. */
function historyContent(index: number): string {
  if (index % 2 === 0) return `Question ${index}? Please look into it.`
  return Array.from(
    { length: 14 },
    (_, j) => `Line ${j} of answer ${index} — a realistically long paragraph of agent output.`,
  ).join('\n\n')
}

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

async function emitStream(app: ElectronApplication, ev: Record<string, unknown>): Promise<void> {
  await app.evaluate(({ BrowserWindow }, event) => {
    BrowserWindow.getAllWindows()[0]?.webContents.send('threads:stream', event)
  }, ev)
}

async function seedTallThread(win: Page, title: string, entries: number): Promise<string> {
  const dir = await seedProject(win)
  await activateProject(win, dir)
  const threadId = await createThread(win, dir, title)
  for (let i = 0; i < entries; i++) {
    await appendMessage(win, threadId, i % 2 === 0 ? 'user' : 'assistant', historyContent(i))
  }
  await win.getByText(title, { exact: true }).first().click()
  await expect(win.locator(sel.conversation)).toBeVisible()
  await win.waitForTimeout(600)
  return threadId
}

const distanceFromBottom = (win: Page): Promise<number> =>
  win.locator('.fl-conv-scroller').evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight)

test.afterAll(async () => {
  try {
    await cleanupSeeds()
  } catch {
    // The app provisions .claude/ + flow/ into seeded roots while we tear down.
  }
})

test('self-scroll: a completing turn leaves the reader at the bottom of a tall transcript (#939)', async ({
  window,
  app,
}) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  const threadId = await seedTallThread(window, 'Self Scroll 939', 30)

  // Opening the thread must already land at the bottom — measured 8572px short
  // before the fix, which is the same defect on its other trigger.
  expect(
    await distanceFromBottom(window),
    'opening a tall thread must land at the bottom, not above it',
  ).toBeLessThan(48)

  // The reported path: the user sends into a running chat, then waits.
  await appendMessage(window, threadId, 'user', 'MY-LAST-QUESTION please summarize the changes.')
  await emitStream(app, { kind: 'status', threadId, status: 'working' })
  await emitStream(app, { kind: 'message-start', threadId, messageId: 'selfscroll-1' })
  for (const chunk of TALL_ANSWER.match(/[\s\S]{1,60}/g) ?? []) {
    await emitStream(app, {
      kind: 'message-delta',
      threadId,
      messageId: 'selfscroll-1',
      text: chunk,
    })
  }
  await window.waitForTimeout(600)

  const beforeDone = await distanceFromBottom(window)
  expect(beforeDone, 'precondition: the reader is following the live output').toBeLessThan(48)

  // The turn completes — `done` → #reconcile → the full rebuild. This is the
  // trigger the user reported.
  await appendMessage(window, threadId, 'assistant', TALL_ANSWER)
  await emitStream(app, { kind: 'status', threadId, status: 'idle' })
  await emitStream(app, { kind: 'done', threadId, messageId: 'selfscroll-1' })
  await window.waitForTimeout(1500)

  const afterDone = await distanceFromBottom(window)
  await window.screenshot({ path: `${SCREENS}/conversation-selfscroll-after-done.png` })

  expect(
    afterDone,
    `the transcript scrolled itself up: ${afterDone}px from the bottom after the turn completed (was ${beforeDone}px while streaming)`,
  ).toBeLessThan(48)
  // What the user actually notices: the end of the answer is on screen, not
  // their own question at the top of the viewport.
  await expect(window.getByText('ANSWER-TAIL-MARKER — everything above is done.')).toBeInViewport()

  expect(errors, errors.join(', ')).toHaveLength(0)
})

test('self-scroll: a reader who deliberately scrolled up is still left alone (#823/#179)', async ({
  window,
  app,
}) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  const threadId = await seedTallThread(window, 'Self Scroll Unpinned 939', 30)

  const scroller = window.locator('.fl-conv-scroller')
  const box = await scroller.boundingBox()
  if (!box) throw new Error('conversation scroller has no box')
  await window.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  for (let i = 0; i < 10; i++) {
    await window.mouse.wheel(0, -400)
    await window.waitForTimeout(10)
  }
  await window.waitForTimeout(400)

  const before = await scroller.evaluate((el) => el.scrollTop)
  expect(await distanceFromBottom(window), 'precondition: scrolled away').toBeGreaterThan(48)

  await emitStream(app, { kind: 'status', threadId, status: 'working' })
  await emitStream(app, { kind: 'message-start', threadId, messageId: 'selfscroll-2' })
  await appendMessage(window, threadId, 'assistant', TALL_ANSWER)
  await emitStream(app, { kind: 'status', threadId, status: 'idle' })
  await emitStream(app, { kind: 'done', threadId, messageId: 'selfscroll-2' })
  await window.waitForTimeout(1500)

  const after = await scroller.evaluate((el) => el.scrollTop)
  expect(
    Math.abs(after - before),
    `an unpinned reader must keep their place: ${before} → ${after}`,
  ).toBeLessThan(24)

  expect(errors, errors.join(', ')).toHaveLength(0)
})
