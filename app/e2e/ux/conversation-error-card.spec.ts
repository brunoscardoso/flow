import { test, expect, type ElectronApplication } from '../fixtures/electron'
import { sel } from '../selectors'
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed'
import type { Page } from '@playwright/test'

/**
 * UX sweep — flow 4: Conversation ERROR STATE — the agent-turn-failure card
 * (round 13).
 *
 * Prior flow-4 probes drove persisted history, streaming TEXT (#823), tool
 * cards, and status — NONE drove the `error` stream surface, the one a real
 * user hits when a turn fails (API error, rate limit, aborted run). The
 * stream-bridge emits `{ kind: 'error', message }` and the pane renders a red
 * `.fl-conv-entry-error` card via `#appendErrorCard` — the conversation's ONLY
 * in-transcript explanation of why a reply stopped.
 *
 * There are TWO real bridge paths that emit `error`, and they behave very
 * differently for the user:
 *
 *  - GUARD (live): a bare `error` with no following `done` (stream-bridge
 *    `handleMessage` catch, stream-bridge.ts:84-88 — a bridge-level failure).
 *    The pane appends a visible error card carrying the message. This is the
 *    happy-enough path: the user sees why it broke. Locked in as a live guard.
 *
 *  - Regression guard (#846, fixed): the DOMINANT failed-turn path.
 *    stream-bridge `handleResult` (stream-bridge.ts:349-370) emits `error`
 *    IMMEDIATELY FOLLOWED BY `done` on every failed turn. The renderer's `done`
 *    handler runs `#reconcile` → `#loadHistory`, which wipes the whole feed
 *    (`this.#feed.textContent = ''`, conversation-pane.ts:568) and rebuilds it
 *    from PERSISTED rows only. Error cards are never persisted, so the card the
 *    user was just shown is wiped a moment later. Net effect: on a real failed
 *    turn the transcript ends up with NO indication the turn failed — the "why
 *    did it stop?" is silently erased. Flip to a live `test(...)` once the
 *    error card survives the turn-completing `done` (e.g. reconcile re-appends
 *    a failure marker, or the error is persisted/kept across the rebuild).
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

/** Emit a real `threads:stream` event to the active window, exactly as the
 *  stream-bridge does — the renderer can't tell an injected event from a live one. */
async function emitStream(app: ElectronApplication, ev: Record<string, unknown>): Promise<void> {
  await app.evaluate(({ BrowserWindow }, event) => {
    BrowserWindow.getAllWindows()[0]?.webContents.send('threads:stream', event)
  }, ev)
}

test.afterAll(() => cleanupSeeds())

test('bridge-error: a bare `error` event renders a visible error card carrying its message', async ({
  window,
  app,
}) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  const dir = await seedProject(window)
  await activateProject(window, dir)
  const threadId = await createThread(window, dir, 'Bridge Error Thread')
  await appendMessage(window, threadId, 'user', 'Please refactor the auth module.')
  await openThread(window, 'Bridge Error Thread')

  const messageId = 'err-bridge-msg-1'
  const errorCard = window.locator('.fl-conv-entry-error')

  // A turn starts and streams a little text, then the bridge itself fails (the
  // stream-bridge `handleMessage` catch path) — emits `error` with NO `done`.
  await emitStream(app, { kind: 'message-start', threadId, messageId })
  await emitStream(app, {
    kind: 'message-delta',
    threadId,
    messageId,
    text: 'Sure — starting on the auth refactor',
  })
  await emitStream(app, {
    kind: 'error',
    threadId,
    message: 'Stream bridge error: connection reset',
  })

  // The user gets an in-transcript explanation of why the reply stopped.
  await expect(errorCard).toHaveCount(1)
  await expect(errorCard).toBeVisible()
  await expect(errorCard).toContainText('connection reset')

  await window.screenshot({ path: `${SCREENS}/conversation-error-bridge.png` })
  expect(errors, errors.join(', ')).toHaveLength(0)
})

// TRIPWIRE for #846 — the dominant failed-turn path (bridge `handleResult`)
// emits `error` then always `done`; `done`'s reconcile wipes the feed and
// rebuilds from persisted rows only, erasing the error card the user was just
// shown. Flip to a live `test(...)` once a failed turn leaves a durable
// in-transcript failure indication.
test(
  'failed-turn: the error card survives the `done` that always follows a failed turn',
  async ({ window, app }) => {
    const errors: string[] = []
    window.on('pageerror', (e) => errors.push(e.message))

    const dir = await seedProject(window)
    await activateProject(window, dir)
    const threadId = await createThread(window, dir, 'Failed Turn Thread')
    await appendMessage(window, threadId, 'user', 'Summarize the release notes.')
    await openThread(window, 'Failed Turn Thread')

    const messageId = 'err-failed-msg-1'
    const errorCard = window.locator('.fl-conv-entry-error')

    // Exactly what stream-bridge `handleResult` emits on a failed turn:
    // usage → status:failed → error → done (error and done back-to-back).
    await emitStream(app, { kind: 'message-start', threadId, messageId })
    await emitStream(app, {
      kind: 'message-delta',
      threadId,
      messageId,
      text: 'Here are the release notes',
    })
    await emitStream(app, { kind: 'usage', threadId, inputTokens: 12, outputTokens: 8 })
    await emitStream(app, { kind: 'status', threadId, status: 'failed' })
    await emitStream(app, {
      kind: 'error',
      threadId,
      message: 'Agent turn failed: rate limit exceeded',
    })
    await emitStream(app, { kind: 'done', threadId, messageId })

    // The user must still be able to read why the turn failed after it settles.
    // Currently RED: the `done` reconcile wipes the feed and the error card is
    // gone (not persisted), so the transcript shows no sign the turn failed.
    await expect(errorCard, 'error card must survive the turn-ending reconcile').toHaveCount(1)
    await expect(errorCard).toContainText('rate limit exceeded')
    expect(errors, errors.join(', ')).toHaveLength(0)
  },
)
