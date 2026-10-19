import { test, expect, type ElectronApplication } from '../fixtures/electron'
import { sel } from '../selectors'
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed'
import type { Page } from '@playwright/test'

/**
 * UX sweep — flow 4 (round 23): what the reader gets AFTER they scroll up.
 *
 * Round 12 (#823) established the ANCHOR contract — streamed deltas must not
 * yank a reader who deliberately scrolled up mid-turn — and round 20 (#1178)
 * added its one exception (a FAILED turn is force-scrolled to the reader).
 * Both drove the *moment* of unpinning. Neither asked the question that follows
 * it, and no flow-4 round (5–22: states, lifecycle, file refs, external links,
 * nested lists, fences, streaming, tool cards, error/permission/question cards,
 * md blocks, background turns, reconcile reader-state, attachments, stats line,
 * interrupted turns) ever has:
 *
 *   once unpinned, how does the reader get BACK to the live end of the
 *   conversation, and what tells them it moved?
 *
 * Test 1 is the live green guard for the half that works: across a whole turn
 * that streams, completes and reconciles while the reader is scrolled up, their
 * position holds (#823 + #1088 through the live-turn channel), the streamed
 * text really did land below the fold, and nothing throws.
 *
 * Tests 2 and 3 are `test.fixme` tripwires for #1330 — measured live on
 * main at 2,282px from the bottom:
 *   - the conversation pane exposes NO control at all (its only <button> is the
 *     hidden empty-state "New Thread"), so there is no jump-to-latest and no
 *     new-content indicator; End/PageDown from the composer and re-clicking the
 *     open thread row (a no-op since #501) move the scroller 0px, leaving a
 *     2.2k-px manual drag as the only route back to the answer, and
 *   - `.fl-conv-activity` — the pane's only "a turn is running" indicator — is
 *     appended INSIDE the scroller (conversation-pane.ts:390), so it scrolls out
 *     of view with the content it belongs to and the pane, while a reply is
 *     actively streaming, is pixel-indistinguishable from an idle transcript.
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

/** Emit a real `threads:stream` event, exactly as the stream-bridge does. */
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

/** Distance from the bottom of the conversation scroller, in px. */
async function distanceFromBottom(win: Page): Promise<number> {
  return win
    .locator('.fl-conv-scroller')
    .evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight)
}

/** Scroll the reader well up the transcript with a REAL wheel gesture — the
 *  only signal #823 accepts as deliberate intent to stop auto-following. */
async function scrollUpByGesture(win: Page): Promise<number> {
  await win.locator('.fl-conv-scroller').hover()
  for (let i = 0; i < 12; i++) {
    await win.mouse.wheel(0, -260)
    await win.waitForTimeout(25)
  }
  await win.waitForTimeout(150)
  return distanceFromBottom(win)
}

/** Every control the conversation pane actually offers the reader right now. */
async function visiblePaneControls(win: Page): Promise<string[]> {
  return win.evaluate(() => {
    const pane = document.querySelector('.fl-conversation')
    if (!pane) return []
    return Array.from(pane.querySelectorAll('button, fl-button, [role="button"]'))
      .filter((el) => (el as HTMLElement).offsetParent !== null)
      .map((el) =>
        (
          (el as HTMLElement).innerText ||
          (el as HTMLElement).getAttribute('aria-label') ||
          '?'
        ).trim(),
      )
  })
}

/** Stream a long reply into `threadId`, a chunk per frame as production's
 *  16ms delta coalescer does. */
async function streamLongReply(
  win: Page,
  app: ElectronApplication,
  threadId: string,
  messageId: string,
): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await emitStream(app, {
      kind: 'message-delta',
      threadId,
      messageId,
      text: `Streamed paragraph ${i} — more of the answer the reader cannot see right now.\n\n`,
    })
    await win.waitForTimeout(40)
  }
  await emitStream(app, {
    kind: 'message-delta',
    threadId,
    messageId,
    text: 'TAIL-MARKER — the final line of the answer.',
  })
  await win.waitForTimeout(200)
}

test.afterAll(() => cleanupSeeds())

test('anchor: a scrolled-up reader holds position across a whole streaming turn, its completion and the reconcile', async ({
  window,
  app,
}) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  const dir = await seedProject(window, 'flow-ux-live-')
  await activateProject(window, dir)
  const threadId = await seedTallThread(window, dir, 'Return To Live Thread')
  await openThread(window, 'Return To Live Thread')

  const messageId = 'return-live-msg-1'
  await emitStream(app, { kind: 'status', threadId, status: 'working' })
  await emitStream(app, { kind: 'message-start', threadId, messageId })
  await emitStream(app, {
    kind: 'message-delta',
    threadId,
    messageId,
    text: 'HEAD-MARKER Working through this now.\n\n',
  })
  await window.waitForTimeout(120)

  const afterScrollUp = await scrollUpByGesture(window)
  expect(afterScrollUp, 'the wheel gesture must unpin auto-follow (#823)').toBeGreaterThan(200)

  await streamLongReply(window, app, threadId, messageId)
  const midStream = await distanceFromBottom(window)
  // #823: deltas must not drag the reader down to the bottom…
  expect(
    Math.abs(midStream - afterScrollUp),
    'streamed deltas must not move a scrolled-up reader',
  ).toBeLessThan(220)
  // …which is exactly why the rest of the answer is off-screen.
  await expect(window.getByText('TAIL-MARKER — the final line of the answer.')).not.toBeInViewport()

  // The turn completes and the transcript is rebuilt from persisted rows.
  await emitStream(app, {
    kind: 'usage',
    threadId,
    inputTokens: 5120,
    cachedInputTokens: 0,
    outputTokens: 980,
  })
  await emitStream(app, { kind: 'done', threadId, messageId })
  await emitStream(app, { kind: 'status', threadId, status: 'idle' })
  await window.waitForTimeout(600)

  // #1088 through the live-turn channel: the done-reconcile keeps them put.
  const afterDone = await distanceFromBottom(window)
  expect(
    Math.abs(afterDone - afterScrollUp),
    'the done-reconcile must not move a scrolled-up reader',
  ).toBeLessThan(220)

  await window.screenshot({ path: `${SCREENS}/conv-live-unpinned-after-done.png` })
  expect(errors, errors.join(', ')).toHaveLength(0)
})

// Tripwire for #1330: no jump-to-latest, and no keyboard or thread-row route
// back either. Measured on main: 2,282px from the bottom, 0 visible controls in
// the pane, and End / PageDown / re-click all move the scroller exactly 0px.
test.fixme(
  'return: a scrolled-up reader has SOME route back to the live end of the conversation',
  async ({ window, app }) => {
    const dir = await seedProject(window, 'flow-ux-live-')
    await activateProject(window, dir)
    const threadId = await seedTallThread(window, dir, 'Return Route Thread')
    await openThread(window, 'Return Route Thread')

    await emitStream(app, { kind: 'status', threadId, status: 'working' })
    await emitStream(app, { kind: 'message-start', threadId, messageId: 'route-msg' })
    await emitStream(app, {
      kind: 'message-delta',
      threadId,
      messageId: 'route-msg',
      text: 'HEAD-MARKER Working through this now.\n\n',
    })
    await window.waitForTimeout(120)

    const away = await scrollUpByGesture(window)
    expect(away).toBeGreaterThan(200)
    await streamLongReply(window, app, threadId, 'route-msg')

    // A jump-to-latest control is what every chat surface offers here. The pane
    // offers no control of any kind — its only <button> is the hidden
    // empty-state "New Thread".
    const controls = await visiblePaneControls(window)
    expect(
      controls.join(' | ').toLowerCase(),
      'the pane should offer a way back to the live end of the conversation',
    ).toMatch(/latest|bottom|newest|jump|live|new message/)
  },
)

// Tripwire for #1330, second half: `.fl-conv-activity` is appended INSIDE
// the scroller (conversation-pane.ts:390), so the pane's only turn-in-progress
// indicator scrolls away with the content and a live turn becomes invisible.
test.fixme(
  'signal: the pane still shows that a turn is running after the reader scrolls up',
  async ({ window, app }) => {
    const dir = await seedProject(window, 'flow-ux-live-')
    await activateProject(window, dir)
    const threadId = await seedTallThread(window, dir, 'Return Signal Thread')
    await openThread(window, 'Return Signal Thread')

    // Working with no visible text/tool yet — the loader is the whole signal.
    await emitStream(app, { kind: 'status', threadId, status: 'working' })
    const loader = window.locator('.fl-conv-activity')
    await expect(loader).toBeVisible()
    await expect(loader).toBeInViewport()

    const away = await scrollUpByGesture(window)
    expect(away).toBeGreaterThan(200)

    await expect(
      loader,
      'a reader who scrolled up must still see that the agent is working',
    ).toBeInViewport()
  },
)
