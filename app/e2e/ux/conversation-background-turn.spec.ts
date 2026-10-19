import { test, expect, type ElectronApplication } from '../fixtures/electron'
import { sel } from '../selectors'
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed'
import type { Page } from '@playwright/test'

/**
 * UX sweep — flow 4: what the conversation pane REMEMBERS about a turn that ran
 * while the user was reading a different thread (round 17).
 *
 * Every prior flow-4 probe drove a turn the pane was MOUNTED ON: persisted
 * history + scroll (conversation.spec), streaming text (#823), tool cards,
 * markdown/code/links, the permission card (#949), the question card
 * (#983/#984), and the failed-turn error card (#846, conversation-error-card).
 * None asked the question a real multi-thread user hits constantly: *I fired a
 * turn, went to read another thread, and came back — does the transcript still
 * tell me what happened?*
 *
 * `ConversationPane.#onStream` early-returns on `event.threadId !== #threadId`
 * (conversation-pane.ts:760), so while the pane is on another thread it sees
 * NOTHING of the running turn. On return, `setThread` (conversation-pane.ts:513)
 * takes only a thread id — it calls `#resetActivity()` and rebuilds the feed from
 * PERSISTED rows only. Two things are therefore lost, and each has its own fix
 * site:
 *
 *  - the failure reason: agent errors are emitted on the ephemeral stream and
 *    never persisted (stream-bridge.ts:349-364 `Agent turn failed: <detail>`,
 *    agent-manager.ts:735 `markThreadFailed`). #846's fix re-appends the error
 *    the pane WITNESSED (`#turnError`, conversation-pane.ts:876/682) — but a
 *    background-thread failure never reaches that field at all, so the transcript
 *    comes back with no answer and no error. (Same shape as #949, where a
 *    permission ask raised for a background thread is dropped entirely.)
 *
 *  - the in-progress indication: `Composer.setThread` restores the live status
 *    from the thread row (`this.setStatus(thread?.status ?? 'idle')`,
 *    composer.ts:562) so Interrupt/Queue come back correctly — the pane has no
 *    equivalent, so the transcript reads idle while the composer says the agent
 *    is running.
 *
 * Live guards below lock in what IS correct (the persisted transcript survives
 * the round-trip; the composer restores Interrupt; a witnessed error still
 * renders). The two former `test.fixme` tripwires are the filed bugs — now
 * fixed (#1048: failures persist as system rows + background error events are
 * buffered; #1049: setThread re-seeds busy-ness from the thread's live status)
 * and kept live as regression guards.
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
  role: 'user' | 'assistant',
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

/** Emit a real `threads:stream` event, exactly as the agent manager does — the
 *  renderer cannot tell an injected event from a live one. */
async function emitStream(app: ElectronApplication, ev: Record<string, unknown>): Promise<void> {
  await app.evaluate(({ BrowserWindow }, event) => {
    BrowserWindow.getAllWindows()[0]?.webContents.send('threads:stream', event)
  }, ev)
}

/** Persist a thread's status the way agent-manager.ts:298 / markThreadFailed do,
 *  so a re-select reads the same row the real product would. */
async function patchThread(
  win: Page,
  threadId: string,
  patch: Record<string, unknown>,
): Promise<void> {
  await win.evaluate(
    async ({ threadId, patch }) => {
      await (
        window as unknown as {
          flow: {
            threads: {
              update(i: { threadId: string; patch: Record<string, unknown> }): Promise<unknown>
            }
          }
        }
      ).flow.threads.update({ threadId, patch })
    },
    { threadId, patch },
  )
}

async function openThread(win: Page, title: string): Promise<void> {
  await win.getByText(title, { exact: true }).first().click()
  await expect(win.locator(sel.conversation)).toBeVisible()
}

/** The per-project "Run a basic discovery?" learning nudge can float over the
 *  bottom-right corner; dismiss it so screenshots show only the flow under test. */
async function dismissLearningNudge(win: Page): Promise<void> {
  const notNow = win.getByText('Not now', { exact: true })
  if (await notNow.count()) await notNow.first().click({ timeout: 2000 }).catch(() => undefined)
}

/** A running turn started while the pane is on this thread. */
async function startTurn(win: Page, app: ElectronApplication, threadId: string): Promise<void> {
  await patchThread(win, threadId, { status: 'working' })
  await emitStream(app, { kind: 'status', threadId, status: 'working' })
}

test.afterAll(() => cleanupSeeds())

// ── Live guard 1 ────────────────────────────────────────────────────────────
// The pieces that DO survive a round-trip away from a running turn: the
// persisted transcript, and the composer's Interrupt/Queue affordances (which
// it restores from the thread row). This is also the non-vacuous setup for the
// #1049 tripwire — the app demonstrably still knows the turn is running.
test('round-trip away from a running turn keeps the persisted transcript and the composer Interrupt', async ({
  window,
  app,
}) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  const dir = await seedProject(window)
  await activateProject(window, dir)
  const alpha = await createThread(window, dir, 'Alpha Running')
  await createThread(window, dir, 'Bravo Reading')
  await appendMessage(window, alpha, 'user', 'please refactor the parser')

  await openThread(window, 'Alpha Running')
  await dismissLearningNudge(window)
  await startTurn(window, app, alpha)

  // Baseline: the loader IS up while the pane witnesses the turn.
  const loader = window.locator('.fl-conv-activity')
  await expect(loader).toBeVisible()
  const interrupt = window.locator(sel.composer).getByText('Interrupt', { exact: true })
  await expect(interrupt).toBeVisible()

  // Go read another thread, then come back.
  await openThread(window, 'Bravo Reading')
  await openThread(window, 'Alpha Running')

  // The persisted history is intact...
  await expect(window.locator('.fl-conv-feed')).toContainText('please refactor the parser')
  // ...and the composer still offers Interrupt, because it re-reads the live
  // status from the thread row on switch (composer.ts:562).
  await expect(interrupt).toBeVisible()

  expect(errors, errors.join(', ')).toHaveLength(0)
})

// ── Live guard 2 ────────────────────────────────────────────────────────────
// A failure the pane WITNESSES is still readable in the transcript (#846's fix).
// This is the control that makes the #1048 tripwire meaningful: the same error
// text, delivered while the pane is on the thread, renders.
test('a failure witnessed on the open thread renders a readable error card', async ({
  window,
  app,
}) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  const dir = await seedProject(window)
  await activateProject(window, dir)
  const alpha = await createThread(window, dir, 'Alpha Witnessed')
  await appendMessage(window, alpha, 'user', 'please refactor the parser')
  await openThread(window, 'Alpha Witnessed')
  await dismissLearningNudge(window)
  await startTurn(window, app, alpha)

  await patchThread(window, alpha, { status: 'failed' })
  await emitStream(app, { kind: 'status', threadId: alpha, status: 'failed' })
  await emitStream(app, {
    kind: 'error',
    threadId: alpha,
    message: 'Agent turn failed: ECONNRESET while streaming',
  })

  const errorCard = window.locator('.fl-conv-entry-error')
  await expect(errorCard).toHaveCount(1)
  await expect(errorCard).toContainText('ECONNRESET while streaming')
  await window.screenshot({ path: `${SCREENS}/conv-bg-failure-witnessed.png` })

  expect(errors, errors.join(', ')).toHaveLength(0)
})

// ── #1049 (fixed) ───────────────────────────────────────────────────────────
// Returning to a thread whose turn is STILL running: setThread now receives the
// thread row's live status (the same source the composer reads) and re-seeds
// the busy state after the history rebuild, so the transcript agrees with the
// composer instead of reading idle.
test(
  'returning to a still-working thread shows the in-progress indication',
  async ({ window, app }) => {
    const errors: string[] = []
    window.on('pageerror', (e) => errors.push(e.message))

    const dir = await seedProject(window)
    await activateProject(window, dir)
    const alpha = await createThread(window, dir, 'Alpha Running')
    await createThread(window, dir, 'Bravo Reading')
    await appendMessage(window, alpha, 'user', 'please refactor the parser')

    await openThread(window, 'Alpha Running')
    await dismissLearningNudge(window)
    await startTurn(window, app, alpha)
    const loader = window.locator('.fl-conv-activity')
    await expect(loader).toBeVisible()
    await window.screenshot({ path: `${SCREENS}/conv-bg-working-before.png` })

    await openThread(window, 'Bravo Reading')
    await openThread(window, 'Alpha Running')
    await window.screenshot({ path: `${SCREENS}/conv-bg-working-after.png` })

    // On return the history rebuild restores the turn as a LIVE work row
    // (`Working · N min`), and the separate "Working…" line is suppressed
    // under it on purpose (conversation-pane #refreshActivity: it would say the
    // same thing twice). Either one is the in-progress indication; what must
    // never happen is neither.
    const working = window
      .locator('.fl-conv-activity:visible, .fl-request-row.live:visible')
      .filter({ hasText: /Working/ })
    await expect(working.first(), 'transcript must still show the turn is running').toBeVisible()
    expect(errors, errors.join(', ')).toHaveLength(0)
  },
)

// ── #1048 (fixed) ───────────────────────────────────────────────────────────
// A turn that FAILS while the user is on another thread: main now persists the
// failure note as a system row at failure time, and the renderer buffers a
// background error event it can't display — either way the return's history
// load renders the same error card the live path shows (deduped, never both).
test(
  'a turn that fails while you are on another thread still explains itself on return',
  async ({ window, app }) => {
    const errors: string[] = []
    window.on('pageerror', (e) => errors.push(e.message))

    const dir = await seedProject(window)
    await activateProject(window, dir)
    const alpha = await createThread(window, dir, 'Alpha Fails')
    await createThread(window, dir, 'Bravo Reading')
    await appendMessage(window, alpha, 'user', 'please refactor the parser')

    await openThread(window, 'Alpha Fails')
    await dismissLearningNudge(window)
    await startTurn(window, app, alpha)

    // The user leaves to read another thread...
    await openThread(window, 'Bravo Reading')
    // ...and the turn dies while they are away (markThreadFailed's exact pair).
    await patchThread(window, alpha, { status: 'failed' })
    await emitStream(app, { kind: 'status', threadId: alpha, status: 'failed' })
    await emitStream(app, {
      kind: 'error',
      threadId: alpha,
      message: 'Agent turn failed: ECONNRESET while streaming',
    })

    await openThread(window, 'Alpha Fails')
    await window.screenshot({ path: `${SCREENS}/conv-bg-failure-return.png` })

    await expect(
      window.locator('.fl-conv-entry-error'),
      'a background failure must leave a readable trace in the transcript',
    ).toHaveCount(1)
    expect(errors, errors.join(', ')).toHaveLength(0)
  },
)
