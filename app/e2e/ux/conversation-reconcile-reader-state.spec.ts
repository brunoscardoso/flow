import { test, expect, type ElectronApplication } from '../fixtures/electron'
import { sel } from '../selectors'
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed'
import type { Page } from '@playwright/test'

/**
 * UX sweep — flow 4: what a COMPLETING TURN does to the reader's own state
 * (round 18).
 *
 * Every completed turn runs `#reconcile` → `#loadHistory`, which wipes the feed
 * (`this.#feed.textContent = ''`) and rebuilds every entry from persisted rows.
 * #179 made that rebuild preserve two pieces of reader state — the scroll
 * position (`reconcileScrollTop`) and expanded tool cards — but its own summary
 * also named a third, "a re-expanded history window re-collapses to the newest
 * 200 entries", which the shipped fix never covered. #501 then fixed the same
 * loss on the *sidebar re-click* trigger, leaving the ordinary end-of-turn
 * trigger as the last one standing.
 *
 * This probe drives that seam with real gestures on a real transcript:
 *
 *  - CONTROL (live, #179 guard): an unpinned reader's `scrollTop` survives a
 *    post-turn reconcile unchanged.
 *  - CONTROL (live, #179 guard): a pinned reader still lands at the bottom.
 *  - CONTROL (live): "Show N earlier entries" really does mount the earlier
 *    chunk (so the tripwire below is not measuring a broken expand).
 *  - GUARD (live, #1088): the expanded earlier chunk survives the rebuild. It
 *    used to collapse, and the preserved `scrollTop` then landed the reader on
 *    entirely different content (measured: same scrollTop 900, top entry
 *    "Bulk entry 7" → "Bulk entry 31", the message they were reading gone from
 *    the DOM).
 *  - GUARD (live, #1088): a text selection over already-persisted history
 *    survives the rebuild. It used to be wiped, so a ⌘C right after a turn
 *    landed copied nothing.
 *
 * Both were `test.fixme` tripwires; the fix (`history-window.ts` + the
 * reconcile's selection capture/restore) made them live. They are written
 * fix-agnostically — they assert the reader's state, not the mechanism.
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

/** Seed past `HISTORY_WINDOW` (200) in ONE round trip so the "Show earlier"
 *  control appears on mount. */
async function bulkSeed(win: Page, threadId: string, first: string, count: number): Promise<void> {
  await win.evaluate(
    async ({ threadId, first, count }) => {
      const api = (
        window as unknown as {
          flow: {
            messages: {
              append(i: { threadId: string; role: string; content: string }): Promise<unknown>
            }
          }
        }
      ).flow.messages
      await api.append({ threadId, role: 'user', content: first })
      for (let i = 0; i < count; i++) {
        await api.append({
          threadId,
          role: i % 2 === 0 ? 'assistant' : 'user',
          content: `Bulk entry ${i} — filler to push the transcript past the 200-entry window.`,
        })
      }
    },
    { threadId, first, count },
  )
}

async function openThread(win: Page, title: string): Promise<void> {
  await win.getByText(title, { exact: true }).first().click()
  await expect(win.locator(sel.conversation)).toBeVisible()
}

/** Emit a real `threads:stream` event exactly as the stream-bridge does. */
async function emitStream(app: ElectronApplication, ev: Record<string, unknown>): Promise<void> {
  await app.evaluate(({ BrowserWindow }, event) => {
    BrowserWindow.getAllWindows()[0]?.webContents.send('threads:stream', event)
  }, ev)
}

/** Run a full turn to completion on `threadId` (the reconcile trigger). */
async function completeTurn(
  win: Page,
  app: ElectronApplication,
  threadId: string,
  messageId: string,
  text: string,
): Promise<void> {
  await emitStream(app, { kind: 'status', threadId, status: 'working' })
  await emitStream(app, { kind: 'message-start', threadId, messageId })
  await emitStream(app, { kind: 'message-delta', threadId, messageId, text })
  await appendMessage(win, threadId, 'assistant', text)
  await emitStream(app, { kind: 'status', threadId, status: 'idle' })
  await emitStream(app, { kind: 'done', threadId, messageId })
  await win.waitForTimeout(900)
}

/** A REAL wheel gesture over the scroller — only a genuine gesture may unpin
 *  auto-follow (#823), so `el.scrollTop = x` would not model the user. */
async function wheelOverScroller(win: Page, deltas: number[]): Promise<void> {
  const box = await win.locator('.fl-conv-scroller').boundingBox()
  if (!box) throw new Error('conversation scroller has no box')
  await win.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  for (const d of deltas) {
    await win.mouse.wheel(0, d)
    await win.waitForTimeout(10)
  }
  await win.waitForTimeout(250)
}

/** The entry sitting at the top of the viewport — what the reader is looking at. */
async function topVisibleEntry(win: Page): Promise<string> {
  return win.locator('.fl-conv-scroller').evaluate((el) => {
    const kids = Array.from(el.querySelectorAll('.fl-conv-feed > *')) as HTMLElement[]
    const bounds = el.getBoundingClientRect()
    for (const kid of kids) {
      const rect = kid.getBoundingClientRect()
      if (rect.bottom > bounds.top + 4) return (kid.innerText || '').replace(/\s+/g, ' ').slice(0, 90)
    }
    return '<none>'
  })
}

test.afterAll(async () => {
  try {
    await cleanupSeeds()
  } catch {
    // The app provisions .claude/ + flow/ into seeded roots while we tear down —
    // an ENOTEMPTY here is harness noise, never a product signal (#1051/#1061).
  }
})

test('control: an unpinned reader keeps their scrollTop across a post-turn reconcile (#179)', async ({
  window,
  app,
}) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  const dir = await seedProject(window)
  await activateProject(window, dir)
  const threadId = await createThread(window, dir, 'Reconcile Scroll Control')
  for (let i = 0; i < 60; i++) {
    await appendMessage(
      window,
      threadId,
      i % 2 === 0 ? 'user' : 'assistant',
      `Control line ${i} — filler text that gives the transcript real height.`,
    )
  }
  await openThread(window, 'Reconcile Scroll Control')

  const scroller = window.locator('.fl-conv-scroller')
  await wheelOverScroller(window, Array.from({ length: 8 }, () => -400))
  const before = await scroller.evaluate((el) => el.scrollTop)
  const wasAway = await scroller.evaluate(
    (el) => el.scrollHeight - el.scrollTop - el.clientHeight >= 48,
  )
  expect(wasAway, 'precondition: the reader scrolled away from the bottom').toBe(true)

  await completeTurn(window, app, threadId, 'control-msg-1', 'A completed reply.')

  const after = await scroller.evaluate((el) => el.scrollTop)
  expect(
    Math.abs(after - before),
    `#179 regression: scrollTop moved ${before} → ${after} on the post-turn rebuild`,
  ).toBeLessThan(24)
  expect(errors, errors.join(', ')).toHaveLength(0)
})

test('control: a pinned reader still lands at the bottom when the turn completes', async ({
  window,
  app,
}) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  const dir = await seedProject(window)
  await activateProject(window, dir)
  const threadId = await createThread(window, dir, 'Reconcile Pinned Control')
  for (let i = 0; i < 60; i++) {
    await appendMessage(
      window,
      threadId,
      i % 2 === 0 ? 'user' : 'assistant',
      `Pinned line ${i} — filler text that gives the transcript real height.`,
    )
  }
  await openThread(window, 'Reconcile Pinned Control')

  const scroller = window.locator('.fl-conv-scroller')
  await completeTurn(window, app, threadId, 'pinned-msg-1', 'PINNED-TAIL-MARKER final reply.')

  const dist = await scroller.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight)
  expect(dist, 'a pinned reader should be at the bottom after the turn completes').toBeLessThan(48)
  await expect(window.getByText('PINNED-TAIL-MARKER final reply.')).toBeInViewport()
  expect(errors, errors.join(', ')).toHaveLength(0)
})

test('control: "Show earlier" mounts the earlier chunk and keeps the reader anchored', async ({
  window,
}) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  const dir = await seedProject(window)
  await activateProject(window, dir)
  const threadId = await createThread(window, dir, 'Earlier Expand Control')
  await bulkSeed(window, threadId, 'ORIGINAL-QUESTION-expand-control', 220)
  await openThread(window, 'Earlier Expand Control')

  const earlier = window.locator('.fl-conv-earlier')
  await expect(earlier).toBeVisible()
  await expect(window.getByText('ORIGINAL-QUESTION-expand-control')).toHaveCount(0)

  await earlier.locator('fl-button').click()
  await expect(window.getByText('ORIGINAL-QUESTION-expand-control')).toBeVisible()
  await expect(earlier).toHaveCount(0)

  expect(errors, errors.join(', ')).toHaveLength(0)
})

// GUARD (#1088) — was the residual of #179 the shipped fix never covered; the
// rebuild now carries the reader's expansion (history-window.ts).
test(
  'earlier: history the reader expanded survives the post-turn rebuild',
  async ({ window, app }) => {
    const errors: string[] = []
    window.on('pageerror', (e) => errors.push(e.message))

    const dir = await seedProject(window)
    await activateProject(window, dir)
    const threadId = await createThread(window, dir, 'Earlier Collapse Tripwire')
    await bulkSeed(window, threadId, 'ORIGINAL-QUESTION-I-am-re-reading', 220)
    await openThread(window, 'Earlier Collapse Tripwire')

    const earlier = window.locator('.fl-conv-earlier')
    const scroller = window.locator('.fl-conv-scroller')
    await expect(earlier).toBeVisible()
    await earlier.locator('fl-button').click()
    await expect(window.getByText('ORIGINAL-QUESTION-I-am-re-reading')).toBeVisible()

    // Park the reader inside the expanded chunk with real gestures.
    await wheelOverScroller(window, [
      ...Array.from({ length: 22 }, () => -600),
      ...Array.from({ length: 3 }, () => 300),
    ])
    const beforeTop = await scroller.evaluate((el) => el.scrollTop)
    const beforeEntry = await topVisibleEntry(window)
    await window.screenshot({ path: `${SCREENS}/conversation-earlier-before-turn.png` })

    await completeTurn(window, app, threadId, 'earlier-msg-1', 'Here is the answer.')

    const afterTop = await scroller.evaluate((el) => el.scrollTop)
    const afterEntry = await topVisibleEntry(window)
    await window.screenshot({ path: `${SCREENS}/conversation-earlier-after-turn.png` })

    expect(
      await earlier.count(),
      'the "Show earlier" control came back — the expanded chunk was discarded by the rebuild',
    ).toBe(0)
    await expect(
      window.getByText('ORIGINAL-QUESTION-I-am-re-reading'),
      'the earliest message the reader had expanded is gone from the transcript',
    ).toBeVisible()
    expect(
      afterEntry,
      `the reader was teleported: scrollTop ${beforeTop} → ${afterTop} but the entry under it changed from "${beforeEntry}" to "${afterEntry}"`,
    ).toBe(beforeEntry)

    expect(errors, errors.join(', ')).toHaveLength(0)
  },
)

// GUARD (#1088) — same rebuild, second casualty: the reader's selection. The
// reconcile now captures the boundary (node, offset) pairs and re-selects them
// after the reuse-aware rebuild re-appends those very nodes.
test('selection: text selected in persisted history survives a completing turn', async ({
  window,
  app,
}) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  const dir = await seedProject(window)
  await activateProject(window, dir)
  const threadId = await createThread(window, dir, 'Selection Tripwire')
  await appendMessage(window, threadId, 'user', 'What is the deploy command?')
  await appendMessage(
    window,
    threadId,
    'assistant',
    'SELECT-ME-PLEASE run the deploy with npm run deploy:prod and wait for the health check.',
  )
  await openThread(window, 'Selection Tripwire')
  await window.waitForTimeout(300)

  await window.evaluate(() => {
    const node = Array.from(document.querySelectorAll('.fl-conv-entry-assistant .fl-md')).pop()
    if (!node) throw new Error('no assistant message to select')
    const range = document.createRange()
    range.selectNodeContents(node)
    const selection = window.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
  })
  const before = await window.evaluate(() => window.getSelection()?.toString() ?? '')
  expect(before, 'precondition: the reader selected the answer').toContain('SELECT-ME-PLEASE')

  // The person asks a follow-up, and that turn completes. (A turn with NO
  // message from the person is a wake-up of the same request: in Compact its
  // reply replaces the shown answer, which moves into the work row by design —
  // plan_chat-cleanup FR-10 — so that is not the case this guard is about.)
  await appendMessage(window, threadId, 'user', 'And the rollback command?')
  await completeTurn(window, app, threadId, 'selection-msg-1', 'A follow-up reply.')

  const after = await window.evaluate(() => window.getSelection()?.toString() ?? '')
  expect(
    after,
    'the completing turn wiped the reader\'s selection — a ⌘C right after copies nothing',
  ).toContain('SELECT-ME-PLEASE')

  expect(errors, errors.join(', ')).toHaveLength(0)
})
