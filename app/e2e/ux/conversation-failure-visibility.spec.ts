import { test, expect } from '../fixtures/electron'
import { sel } from '../selectors'
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed'
import type { Page } from '@playwright/test'
import type { ElectronApplication } from '@playwright/test'

/**
 * UX sweep — flow 4: is a FAILED TURN actually visible to the reader? (round 20)
 *
 * #846 and #1048 fixed the *persistence* of a failed turn (the card is no longer
 * wiped by the reconcile; a background failure is written as a system row). This
 * probe drives the remaining channel — the reader who has scrolled up in the SAME
 * thread — plus the readability of the card's own text:
 *
 *  - live guard: pinned at the bottom, a failing turn renders its error card with
 *    the reason and drops the loader (the #846 path, end to end),
 *  - live guard: an actionable PERMISSION card arriving while the reader is
 *    scrolled up IS force-scrolled into view (`#scrollToBottom(true)`) — the
 *    precedent the error card is missing,
 *  - #1178 tripwire (fixme): the same failure while scrolled up leaves the error
 *    card ~2,500px below the fold with nothing in the pane to point at it,
 *  - #1179 tripwire (fixme): a URL/path in the failure reason is clipped at the
 *    card edge instead of wrapping.
 *
 * Credential-free: the real `threads:stream` events the agent-manager emits on
 * failure (`status:'failed'` then `error`, agent-manager.ts:904-905) are injected
 * directly — the renderer can't tell them from a live turn.
 */

const SCREENS = 'e2e/ux/__screens'

/** A realistic agent failure reason: node-fetch style, URL included. */
const FAILURE =
  'Agent turn failed: FetchError: request to https://api.anthropic.com/v1/messages failed, reason: connect ECONNREFUSED 127.0.0.1:443'

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

async function append(win: Page, threadId: string, role: string, content: string): Promise<void> {
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

/** Seed a thread whose transcript is taller than the pane, and open it. */
async function seedTallThread(win: Page, root: string, title: string): Promise<string> {
  const threadId = await createThread(win, root, title)
  for (let i = 0; i < 20; i++) {
    await append(win, threadId, 'user', `earlier question ${i}`)
    await append(
      win,
      threadId,
      'assistant',
      `Earlier answer ${i}.\n\nSecond paragraph of answer ${i} so the transcript is tall.\n\nThird paragraph of ${i}.`,
    )
  }
  await win.getByText(title, { exact: true }).first().click()
  await expect(win.locator(sel.conversation)).toBeVisible()
  await win.waitForTimeout(1200)
  return threadId
}

/** Scroll the transcript up with a REAL wheel gesture — only a gesture unpins
 *  auto-follow (#823), so a programmatic scrollTop write would not reproduce
 *  the reader's state. */
async function scrollUp(win: Page): Promise<void> {
  const box = await win.locator('.fl-conv-scroller').boundingBox()
  await win.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2)
  for (let i = 0; i < 6; i++) {
    await win.mouse.wheel(0, -400)
    await win.waitForTimeout(60)
  }
  await win.waitForTimeout(300)
}

/** Is `selector` inside the scroller's visible band? */
async function inView(win: Page, selector: string): Promise<boolean> {
  return win.evaluate((s) => {
    const scroller = document.querySelector('.fl-conv-scroller') as HTMLElement
    const node = document.querySelector(s) as HTMLElement | null
    if (!node) return false
    const sr = scroller.getBoundingClientRect()
    const nr = node.getBoundingClientRect()
    return nr.top < sr.bottom && nr.bottom > sr.top
  }, selector)
}

test.afterAll(() => cleanupSeeds())

test('a failed turn renders its error card with the reason and drops the loader (reader at the bottom)', async ({
  window,
  app,
}) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  const root = await seedProject(window, 'flow-ux-fail-a-')
  await activateProject(window, root)
  const threadId = await createThread(window, root, 'Failure At Bottom')
  await window.getByText('Failure At Bottom', { exact: true }).first().click()
  await expect(window.locator(sel.conversation)).toBeVisible()

  await emitStream(app, { kind: 'status', threadId, status: 'working' })
  await emitStream(app, { kind: 'message-start', threadId, messageId: 'm1' })
  await expect(window.locator('.fl-conv-activity')).toBeVisible()

  // Real agent-manager failure order (agent-manager.ts:904-905).
  await emitStream(app, { kind: 'status', threadId, status: 'failed' })
  await emitStream(app, { kind: 'error', threadId, message: FAILURE })

  const card = window.locator('.fl-conv-entry-error')
  await expect(card).toBeVisible()
  await expect(card).toContainText('Agent turn failed')
  await expect(card).toContainText('ECONNREFUSED')
  // The failure is the end of the turn — no lingering "Working…".
  await expect(window.locator('.fl-conv-activity')).toBeHidden()

  expect(errors, `pageerrors: ${errors.join(' | ')}`).toEqual([])
})

test('an actionable permission card IS force-scrolled into view when the reader is scrolled up', async ({
  window,
  app,
}) => {
  const root = await seedProject(window, 'flow-ux-fail-b-')
  await activateProject(window, root)
  const threadId = await seedTallThread(window, root, 'Permission While Scrolled Up')

  await scrollUp(window)
  expect(await inView(window, '.fl-conv-entry-permission')).toBe(false) // none yet

  await app.evaluate(({ BrowserWindow }, tid) => {
    BrowserWindow.getAllWindows()[0]?.webContents.send('threads:permissionRequest', {
      requestId: 'req-force-scroll',
      threadId: tid,
      toolName: 'Bash',
      inputJson: JSON.stringify({ command: 'rm -rf build' }),
      createdAt: new Date().toISOString(),
    })
  }, threadId)

  await expect(window.locator('.fl-conv-entry-permission')).toBeVisible()
  // The pane's own rule: "a pending permission is actionable and must never sit
  // off-screen looking like a stalled turn" (conversation-pane.ts:603).
  await expect
    .poll(() => inView(window, '.fl-conv-entry-permission'), { timeout: 4000 })
    .toBe(true)
})

// #1178 — currently RED: the error card lands ~2,500px below the fold and the
// loader vanishes, so a failure while scrolled up looks exactly like a success.
// Flip this off when the error case adopts `#scrollToBottom(true)`.
test(
  '#1178: a turn that fails while the reader is scrolled up brings the failure into view',
  async ({ window, app }) => {
    const root = await seedProject(window, 'flow-ux-fail-c-')
    await activateProject(window, root)
    const threadId = await seedTallThread(window, root, 'Failure While Scrolled Up')

    await scrollUp(window)
    await emitStream(app, { kind: 'status', threadId, status: 'working' })
    await emitStream(app, { kind: 'message-start', threadId, messageId: 'mX' })
    await emitStream(app, { kind: 'message-delta', threadId, messageId: 'mX', text: 'Let me check' })
    await emitStream(app, { kind: 'status', threadId, status: 'failed' })
    await emitStream(app, { kind: 'error', threadId, message: FAILURE })

    await expect(window.locator('.fl-conv-entry-error')).toBeVisible()
    await window.screenshot({ path: `${SCREENS}/conversation-failure-scrolled-up.png` })
    // The reader must be able to SEE that the turn failed without scrolling.
    await expect
      .poll(() => inView(window, '.fl-conv-entry-error'), { timeout: 4000 })
      .toBe(true)
  },
)

// #1179 (fixed): `.fl-conv-error-head` was a flex row with no min-width:0 and
// no overflow-wrap, so a URL/path in the reason was clipped at the card edge.
test('#1179: the failure reason wraps inside the error card instead of being clipped', async ({
  window,
  app,
}) => {
  const root = await seedProject(window, 'flow-ux-fail-d-')
  await activateProject(window, root)
  const threadId = await createThread(window, root, 'Failure Text Wrap')
  await window.getByText('Failure Text Wrap', { exact: true }).first().click()
  await expect(window.locator(sel.conversation)).toBeVisible()

  await emitStream(app, { kind: 'error', threadId, message: FAILURE })
  await expect(window.locator('.fl-conv-entry-error')).toBeVisible()

  const clipped = await window.evaluate(() => {
    const head = document.querySelector('.fl-conv-error-head') as HTMLElement
    return { scrollWidth: head.scrollWidth, clientWidth: head.clientWidth }
  })
  expect(clipped.scrollWidth).toBeLessThanOrEqual(clipped.clientWidth)
})
