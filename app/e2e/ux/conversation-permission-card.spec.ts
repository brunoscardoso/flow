import { test, expect, type ElectronApplication } from '../fixtures/electron'
import { sel } from '../selectors'
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed'
import type { Page } from '@playwright/test'

/**
 * UX sweep — flow 4: Conversation PERMISSION CARD — the agent asking to run a
 * tool (round 14).
 *
 * Prior flow-4 probes drove persisted history, states, file links, nested
 * lists, external links, tool cards, code blocks, streaming scroll (#823) and
 * the failed-turn error card (#846) — NONE drove the inline PERMISSION card,
 * the surface a real user hits on the very first `Bash`/`Write` the agent
 * attempts. `PermissionBroker` emits `threads:permissionRequest` and then
 * PARKS the tool call until the renderer answers (permissions.ts:9-10), so the
 * card is the ONLY way to un-park the turn — if it disappears, the turn hangs
 * forever with no affordance.
 *
 * The question card (`AskUserQuestion`) has a `#questionQueue` that buffers a
 * request for an inactive thread and re-buffers rendered cards across a feed
 * wipe (conversation-pane.ts `#onDialogRequest` / `#clearLive` /
 * `#flushPendingQuestions`) — precisely so the agent never stays "parked on a
 * card that no longer exists". The permission path has NO equivalent:
 * `#onPermissionRequest` drops a request whose `threadId` isn't the active one
 * and `#clearLive` clears `#permissionCards` with no re-buffer.
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

/** Emit a real `threads:permissionRequest` to the window, exactly as the IPC
 *  layer does for a parked tool call (agent/ipc.ts:86). */
async function emitPermission(
  app: ElectronApplication,
  request: Record<string, unknown>,
): Promise<void> {
  await app.evaluate(({ BrowserWindow }, req) => {
    BrowserWindow.getAllWindows()[0]?.webContents.send('threads:permissionRequest', req)
  }, request)
}

/** Emit a real `threads:dialogRequest` (the AskUserQuestion sibling surface). */
async function emitDialog(
  app: ElectronApplication,
  request: Record<string, unknown>,
): Promise<void> {
  await app.evaluate(({ BrowserWindow }, req) => {
    BrowserWindow.getAllWindows()[0]?.webContents.send('threads:dialogRequest', req)
  }, request)
}

const permissionCard = (win: Page) => win.locator('.fl-permission-card')

test.afterAll(() => cleanupSeeds())

test('permission card renders the ask and records the verdict in the transcript', async ({
  window,
  app,
}) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  const dir = await seedProject(window)
  await activateProject(window, dir)
  const threadId = await createThread(window, dir, 'Permission Thread')
  await appendMessage(window, threadId, 'user', 'Run the test suite.')
  await openThread(window, 'Permission Thread')

  await emitPermission(app, {
    requestId: 'perm-render-1',
    threadId,
    toolName: 'Bash',
    summary: 'Run `npm test` in the project root',
    inputPreview: 'command: npm test',
  })

  // The ask is legible: tool name, what it wants to do, the sanitized input.
  const card = permissionCard(window)
  await expect(card).toHaveCount(1)
  await expect(card).toBeVisible()
  await expect(card).toContainText('Bash — permission required')
  await expect(card).toContainText('Run `npm test` in the project root')
  await expect(card.locator('.fl-permission-preview')).toContainText('command: npm test')

  // All three verdicts are offered and clickable.
  const actions = card.locator('.fl-permission-actions fl-button')
  await expect(actions).toHaveCount(3)
  await expect(card.getByText('Allow once', { exact: true })).toBeVisible()
  await expect(card.getByText('Always allow', { exact: true })).toBeVisible()
  await expect(card.getByText('Deny', { exact: true })).toBeVisible()

  await window.screenshot({ path: `${SCREENS}/conversation-permission-pending.png` })

  // Answering collapses the buttons into a durable record of what was decided.
  await card.getByText('Allow once', { exact: true }).click()
  await expect(card.locator('.fl-permission-resolution')).toHaveText('Allowed once')
  await expect(card.locator('.fl-permission-actions')).toBeHidden()
  await expect(card).toBeVisible() // stays in the transcript as a record

  expect(errors, errors.join(', ')).toHaveLength(0)
})

// #949 (was a tripwire) — an unanswered permission ask survives a thread
// switch: `#clearLive()` re-buffers rendered-but-unanswered asks through the
// shared never-drop queue (the question card's discipline), and the return
// load flushes them back into the feed. The broker parks the tool call until a
// verdict arrives, so the re-rendered card is the only way to un-park the turn.
test(
  'pending permission ask survives leaving and returning to the thread',
  async ({ window, app }) => {
    const errors: string[] = []
    window.on('pageerror', (e) => errors.push(e.message))

    const dir = await seedProject(window)
    await activateProject(window, dir)
    const threadA = await createThread(window, dir, 'Perm Switch A')
    await createThread(window, dir, 'Perm Switch B')
    await appendMessage(window, threadA, 'user', 'Delete the build cache.')
    await openThread(window, 'Perm Switch A')

    await emitPermission(app, {
      requestId: 'perm-switch-1',
      threadId: threadA,
      toolName: 'Bash',
      summary: 'Run `rm -rf .cache` in the project root',
      inputPreview: 'command: rm -rf .cache',
    })
    await expect(permissionCard(window)).toHaveCount(1)
    await window.screenshot({ path: `${SCREENS}/conversation-permission-before-switch.png` })

    // The user glances at another thread while the agent waits, then comes back.
    await openThread(window, 'Perm Switch B')
    await expect(permissionCard(window)).toHaveCount(0)
    await openThread(window, 'Perm Switch A')
    await window.waitForTimeout(600)
    await window.screenshot({ path: `${SCREENS}/conversation-permission-after-return.png` })

    await expect(
      permissionCard(window),
      'the unanswered ask must be re-rendered — the tool call is still parked on it',
    ).toHaveCount(1)
    expect(errors, errors.join(', ')).toHaveLength(0)
  },
)

// #949 (was a tripwire) — a permission ask that arrives while the user is
// reading ANOTHER thread is buffered (never dropped) and flushed when its
// thread is opened, exactly like the sibling question card.
test(
  'permission ask raised for a background thread is shown when the user opens it',
  async ({ window, app }) => {
    const errors: string[] = []
    window.on('pageerror', (e) => errors.push(e.message))

    const dir = await seedProject(window)
    await activateProject(window, dir)
    const threadA = await createThread(window, dir, 'Perm BG A')
    await createThread(window, dir, 'Perm BG B')
    await appendMessage(window, threadA, 'user', 'Publish the package.')
    await openThread(window, 'Perm BG B') // user is reading a different thread

    await emitPermission(app, {
      requestId: 'perm-bg-1',
      threadId: threadA,
      toolName: 'Bash',
      summary: 'Run `npm publish` in the project root',
      inputPreview: 'command: npm publish',
    })

    await openThread(window, 'Perm BG A')
    await expect(
      permissionCard(window),
      'the ask raised while this thread was in the background must appear on return',
    ).toHaveCount(1)
    expect(errors, errors.join(', ')).toHaveLength(0)
  },
)

// Sibling contrast (live guard): the AskUserQuestion card raised for a
// BACKGROUND thread IS buffered and flushed when the user opens that thread —
// the behavior the permission path lacks. Keeps the asymmetry honest: if this
// ever regresses too, the fix is a shared queue, not a permission-only patch.
test('question card raised for a background thread is shown when the user opens it', async ({
  window,
  app,
}) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  const dir = await seedProject(window)
  await activateProject(window, dir)
  const threadA = await createThread(window, dir, 'Ask BG A')
  await createThread(window, dir, 'Ask BG B')
  await appendMessage(window, threadA, 'user', 'Pick a rollout strategy.')
  await openThread(window, 'Ask BG B')

  await emitDialog(app, {
    requestId: 'ask-bg-1',
    threadId: threadA,
    questions: [
      {
        question: 'Which rollout strategy should I use?',
        header: 'Rollout',
        multiSelect: false,
        options: [
          { label: 'Canary', description: 'Ship to 5% first' },
          { label: 'Full', description: 'Ship to everyone' },
        ],
      },
    ],
  })

  await openThread(window, 'Ask BG A')
  await expect(window.locator('.fl-qcard')).toHaveCount(1)
  await expect(window.locator('.fl-qcard')).toContainText(
    'Which rollout strategy should I use?',
  )
  expect(errors, errors.join(', ')).toHaveLength(0)
})

// A verdict still in flight when the feed is rebuilt. `#clearLive` re-buffers
// every rendered ask, so a thread switch during the `respondPermission` round
// trip re-renders the ask as a SECOND card with live buttons. When the verdict
// landed, only the first card (no longer in the feed) showed it: the one on
// screen kept offering Allow / Deny for an ask that was already answered.
test('an ask answered while the thread is switched reads as answered on return', async ({
  window,
  app,
}) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  const dir = await seedProject(window)
  await activateProject(window, dir)
  const threadA = await createThread(window, dir, 'Perm Flight A')
  await createThread(window, dir, 'Perm Flight B')
  await appendMessage(window, threadA, 'user', 'Format the sources.')
  await openThread(window, 'Perm Flight A')

  // The verdict's delivery is slow enough to switch threads inside it.
  await app.evaluate(({ ipcMain }) => {
    const g = globalThis as unknown as { __permVerdicts: string[] }
    g.__permVerdicts = []
    ipcMain.removeHandler('threads:respondPermission')
    ipcMain.handle('threads:respondPermission', async (_event, payload: { verdict: string }) => {
      g.__permVerdicts.push(payload.verdict)
      await new Promise((resolve) => setTimeout(resolve, 2500))
    })
  })

  await emitPermission(app, {
    requestId: 'perm-flight-1',
    threadId: threadA,
    toolName: 'Bash',
    summary: 'Run `npm run format` in the project root',
    inputPreview: 'command: npm run format',
  })
  await expect(permissionCard(window)).toHaveCount(1)
  await permissionCard(window).getByText('Allow once', { exact: true }).click()

  // The verdict was sent, and it is still in flight while the user switches.
  const verdicts = () =>
    app.evaluate(() => (globalThis as unknown as { __permVerdicts: string[] }).__permVerdicts)
  await expect.poll(verdicts).toEqual(['allow-once'])
  await openThread(window, 'Perm Flight B')
  await openThread(window, 'Perm Flight A')
  await expect(permissionCard(window), 'the ask is rebuilt while its verdict is in flight').toHaveCount(1)

  // Once the verdict lands, the card on screen says so and offers nothing.
  const card = permissionCard(window)
  await expect(card.locator('.fl-permission-resolution')).toHaveText('Allowed once', { timeout: 6000 })
  await expect(card.locator('.fl-permission-actions')).toBeHidden()
  expect(await verdicts()).toEqual(['allow-once'])
  expect(errors, errors.join(', ')).toHaveLength(0)
})
