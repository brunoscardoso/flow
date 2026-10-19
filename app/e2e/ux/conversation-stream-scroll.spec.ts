import { test, expect, type ElectronApplication } from '../fixtures/electron'
import { sel } from '../selectors'
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed'
import type { Page } from '@playwright/test'

/**
 * UX sweep — flow 4: Conversation STREAMING TEXT + scroll-follow (round 12).
 *
 * Every prior flow-4 probe drove *persisted* history (`messages:append`) or the
 * tool-call / status / error stream surfaces — NONE drove the live streaming
 * TEXT path (`message-start` → `message-delta` → `done`), the single most-seen
 * assistant surface: watching a reply type itself out. It's fully drivable
 * credential-lessly by emitting the real `threads:stream` text events the
 * stream-bridge sends (same lever the tool-card probe uses), so no Claude
 * account is needed.
 *
 * Locks down the streaming surfaces a real user hits (conversation-pane.ts
 * #onStream + #scrollToBottom):
 *
 *  - RENDER (live): `message-start` shows the "Working…" loader (an empty bubble
 *    is not yet feedback); the first `message-delta` renders the streamed text
 *    into an assistant bubble and drops the loader (the flowing text is now the
 *    feedback).
 *  - FOLLOW (regression guard for #823): while the reader is pinned at the
 *    bottom, streamed deltas must auto-follow so the newest text stays in view.
 *    Currently BROKEN — entries use `content-visibility: auto` (est. 96px); the
 *    non-`force` #scrollToBottom scrolls to the then-current scrollHeight, the
 *    text renders taller than its estimate, the resulting scroll event measures
 *    distance > the 48px lock threshold and flips `#pinned` false, and every
 *    later delta early-returns. The reply streams out entirely below the fold
 *    and only snaps into view at `done` (reconcile's force-scroll). Flip this to
 *    a live test once streaming auto-follow re-asserts like the #651 force path.
 *  - ANCHOR (live): if the reader deliberately scrolls UP mid-stream, further
 *    deltas must NOT yank them to the bottom — the `#pinned` guard. Being ripped
 *    away from the line you're reading on every token is the classic streaming
 *    annoyance; this asserts the app doesn't do it.
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

/**
 * Every test here streams prose into the feed and watches the scroller follow
 * it. That is BALANCED since plan_chat-cleanup: in Compact a running request is
 * one live work row whose second line is the newest step, so no streamed text
 * grows the feed (chat-request-fold.spec.ts guards that row). Picked through
 * the control a person uses.
 */
async function openThread(win: Page, title: string): Promise<void> {
  await win.locator('.fl-titlebar-icon[aria-label="Settings"]').click()
  await win.locator('.fl-settings-tab', { hasText: 'App' }).click()
  await win.locator('select[aria-label="Conversation density"]').selectOption('balanced')
  await win.keyboard.press('Escape')
  await win.getByText(title, { exact: true }).first().click()
  await expect(win.locator(sel.conversation)).toBeVisible()
}

/** Emit a real `threads:stream` event to the active window, exactly as the
 *  stream-bridge does — the renderer can't tell an injected event from a live one. */
async function emitStream(app: ElectronApplication, ev: Record<string, unknown>): Promise<void> {
  await app.evaluate(({ BrowserWindow }, event) => {
    BrowserWindow.getAllWindows()[0]?.webContents.send('threads:stream', event)
  }, ev)
}

/** Seed enough persisted history that the scroller overflows the viewport. */
async function seedTallThread(win: Page, root: string, title: string): Promise<string> {
  const id = await createThread(win, root, title)
  for (let i = 0; i < 40; i++) {
    await appendMessage(
      win,
      id,
      i % 2 === 0 ? 'user' : 'assistant',
      `History line ${i} — some text to give the transcript real height.`,
    )
  }
  return id
}

test.afterAll(() => cleanupSeeds())

test('render: message-start shows the loader; the first delta renders text and drops it', async ({
  window,
  app,
}) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  const dir = await seedProject(window)
  await activateProject(window, dir)
  const threadId = await seedTallThread(window, dir, 'Stream Render Thread')
  await openThread(window, 'Stream Render Thread')

  const loader = window.locator('.fl-conv-activity')
  const messageId = 'stream-render-msg-1'

  // message-start: an assistant bubble is created but empty — the loader must
  // show "Working…" because an empty bubble is not yet feedback.
  await emitStream(app, { kind: 'message-start', threadId, messageId })
  await expect(loader).toBeVisible()
  await expect(loader.locator('.fl-conv-activity-label')).toHaveText('Working…')

  // First delta: real text flows in → it renders in the assistant bubble AND the
  // loader is dropped (the flowing text is now the feedback).
  await emitStream(app, {
    kind: 'message-delta',
    threadId,
    messageId,
    text: 'STREAM-RENDER-MARKER Let me walk through the plan.',
  })
  const assistantMd = window.locator('.fl-conv-entry-assistant .fl-md').last()
  await expect(assistantMd).toContainText('STREAM-RENDER-MARKER')
  await expect(loader).toBeHidden()

  await window.screenshot({ path: `${SCREENS}/conversation-stream-render.png` })
  expect(errors, errors.join(', ')).toHaveLength(0)
})

// Regression guard for #823 (fixed): only user gestures or a stable-height
// upward move may unpin auto-follow; streaming layout churn (growth past the
// content-visibility estimate, shrink-clamp anchoring) can only re-pin.
test(
  'follow: a pinned reader auto-follows streamed deltas so the newest text stays in view',
  async ({ window, app }) => {
    const errors: string[] = []
    window.on('pageerror', (e) => errors.push(e.message))

    const dir = await seedProject(window)
    await activateProject(window, dir)
    const threadId = await seedTallThread(window, dir, 'Stream Follow Thread')
    await openThread(window, 'Stream Follow Thread')

    const scroller = window.locator('.fl-conv-scroller')
    const messageId = 'stream-follow-msg-1'

    await emitStream(app, { kind: 'message-start', threadId, messageId })
    await emitStream(app, {
      kind: 'message-delta',
      threadId,
      messageId,
      text: 'STREAM-START-MARKER Let me walk through the plan.\n\n',
    })

    // Build a long reply at a realistic per-chunk cadence (a frame between chunks,
    // as production's 16ms delta coalescer produces).
    for (let i = 0; i < 8; i++) {
      await emitStream(app, {
        kind: 'message-delta',
        threadId,
        messageId,
        text: `This is streamed paragraph number ${i}, adding height to the reply so the transcript keeps growing past the viewport.\n\n`,
      })
      await window.waitForTimeout(30)
    }
    await emitStream(app, {
      kind: 'message-delta',
      threadId,
      messageId,
      text: 'STREAM-TAIL-MARKER — final streamed line.',
    })
    await window.waitForTimeout(120)

    // Auto-follow: the last streamed line is in the viewport and the scroller is
    // pinned within the lock threshold of the bottom.
    await expect(window.getByText('STREAM-TAIL-MARKER — final streamed line.')).toBeInViewport()
    const dist = await scroller.evaluate(
      (el) => el.scrollHeight - el.scrollTop - el.clientHeight,
    )
    expect(dist, 'a pinned reader should auto-follow streamed deltas to the bottom').toBeLessThan(48)
    expect(errors, errors.join(', ')).toHaveLength(0)
  },
)

test('anchor: scrolling up mid-stream keeps the reader put — deltas do NOT yank to the bottom', async ({
  window,
  app,
}) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  const dir = await seedProject(window)
  await activateProject(window, dir)
  const threadId = await seedTallThread(window, dir, 'Stream Anchor Thread')
  await openThread(window, 'Stream Anchor Thread')

  const scroller = window.locator('.fl-conv-scroller')
  const messageId = 'stream-anchor-msg-1'

  // Start a stream and let a few deltas land (an active in-flight turn, exactly
  // as when a real user reads back mid-reply).
  await emitStream(app, { kind: 'message-start', threadId, messageId })
  for (let i = 0; i < 4; i++) {
    await emitStream(app, {
      kind: 'message-delta',
      threadId,
      messageId,
      text: `Early streamed paragraph ${i} with enough words to build vertical space in the reply bubble.\n\n`,
    })
  }

  // The reader scrolls UP to re-read something — this fires the scroller's
  // 'scroll' listener, which flips #pinned to false (distance from bottom > 48px).
  await scroller.evaluate((el) => {
    el.scrollTop = 0
  })
  await window.waitForTimeout(120)
  const anchoredTop = await scroller.evaluate((el) => el.scrollTop)
  const wasAway = await scroller.evaluate(
    (el) => el.scrollHeight - el.scrollTop - el.clientHeight >= 48,
  )
  expect(wasAway, 'precondition: reader scrolled away from the bottom').toBe(true)

  // More deltas arrive while the reader is scrolled up. They must NOT drag the
  // viewport back down.
  for (let i = 0; i < 10; i++) {
    await emitStream(app, {
      kind: 'message-delta',
      threadId,
      messageId,
      text: `Late streamed paragraph ${i} that arrives while the reader is scrolled up reading earlier content.\n\n`,
    })
  }
  await window.waitForTimeout(150)

  const afterTop = await scroller.evaluate((el) => el.scrollTop)
  const stillAway = await scroller.evaluate(
    (el) => el.scrollHeight - el.scrollTop - el.clientHeight >= 48,
  )
  expect(
    stillAway,
    `streamed deltas yanked the scrolled-up reader toward the bottom (top ${anchoredTop} → ${afterTop})`,
  ).toBe(true)
  expect(
    Math.abs(afterTop - anchoredTop),
    `reader's scroll position drifted ${Math.abs(afterTop - anchoredTop)}px during streaming`,
  ).toBeLessThan(120)

  await window.screenshot({ path: `${SCREENS}/conversation-stream-anchor.png` })
  expect(errors, errors.join(', ')).toHaveLength(0)
})
