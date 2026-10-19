import { test, expect, type ElectronApplication } from '../fixtures/electron'
import { sel } from '../selectors'
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed'
import type { Page } from '@playwright/test'

/**
 * UX sweep — flow 4: does the conversation hold the LIVE END when the pane's own
 * VIEWPORT shrinks? (round 23)
 *
 * The pane has an explicit "keep the reader at the live end" invariant with four
 * accepted fixes behind it — #651 (force the bottom for a permission ask), #823
 * (streamed deltas must auto-follow a pinned reader), #939 (a completing turn
 * must not strand the reader above the true bottom), #1178 (an error card is
 * FORCED into view). Every one of them defends the same direction: the CONTENT
 * grows, so re-assert the bottom.
 *
 * The opposite direction has no defence at all. `grep -rn ResizeObserver` over
 * `src/renderer/threads/` finds nothing — the pane never observes its own
 * height. So when the SCROLLER shrinks while the content stays put, `scrollTop`
 * is left where it was and the live end slides under the fold. The everyday
 * trigger is the composer: it auto-grows as you type a multi-line follow-up
 * (128px → its 312px max), taking 184px straight out of the transcript viewport.
 *
 * Chromium's scroll anchoring absorbs this on SHORT transcripts, which is why it
 * has gone unnoticed: measured live, a 12- or 20-message thread ends up at
 * `dist 0`. It stops absorbing it once the transcript is tall enough that the
 * off-screen entries are still `content-visibility: auto` placeholders — at 30
 * messages the reader is left 140px above the live end, with the answer they are
 * replying to entirely off-screen and no jump-to-latest control in the pane to
 * get back (measured: zero recovery affordances in `.fl-conversation`).
 *
 * RULED OUT while writing this, deliberately NOT asserted: a plain window
 * resize. Shrinking the window 350px on the same tall thread leaves the reader
 * at `dist 1` — Chromium re-clamps scrollTop to the new max. It only strands the
 * reader when a composer grow/clear cycle preceded it, which is too compound a
 * sequence to encode as a guard.
 *
 * Tests 1 and 2 are the LIVE controls, so the tripwire cannot pass vacuously:
 *   1. the same tall thread really does open AT the live end with the last
 *      answer in the viewport (the state the tripwire claims is destroyed);
 *   2. `#pinned` SURVIVES the composer growth — a streamed delta still
 *      auto-follows to the bottom. That pins the defect precisely: the pin
 *      bookkeeping is fine, there is simply nothing that re-asserts the bottom
 *      when the viewport (not the content) is what changed.
 *
 * Test 3 is the regression guard (now live). It was confirmed genuinely
 * RED against current main with the intended message before being fixme'd here.
 */

const SCREENS = 'e2e/ux/__screens'

/** Distance-from-bottom the pane itself treats as "at the live end"
 *  (`BOTTOM_LOCK_THRESHOLD_PX`, conversation-pane.ts). */
const BOTTOM_LOCK_THRESHOLD_PX = 48

/** The transcript shape at which scroll anchoring stops absorbing the shrink.
 *  Below ~24 entries Chromium compensates and the defect is invisible. */
const HISTORY_LINES = 30

const LAST_ANSWER = 'LAST-ANSWER-MARKER this is the last thing the agent said.'

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
  // messages.list orders by (created_at, id) with random-uuid ids, so two
  // appends inside the same millisecond come back in arbitrary order.
  await win.waitForTimeout(15)
}

/** Seed a thread tall enough that the off-screen entries stay
 *  content-visibility placeholders, open it, and settle at the live end. */
async function seedAndOpen(win: Page, root: string, title: string): Promise<string> {
  const id = await createThread(win, root, title)
  for (let i = 0; i < HISTORY_LINES; i++) {
    await appendMessage(
      win,
      id,
      i % 2 === 0 ? 'user' : 'assistant',
      `History line ${i} — text that gives the transcript real height so the scroller overflows.`,
    )
  }
  await appendMessage(win, id, 'assistant', LAST_ANSWER)
  await win.getByText(title, { exact: true }).first().click()
  await expect(win.locator(sel.conversation)).toBeVisible()
  await win.waitForTimeout(400)
  return id
}

interface Metrics {
  scrollTop: number
  scrollHeight: number
  clientHeight: number
  /** px of transcript below the visible bottom — 0 means "at the live end". */
  dist: number
  composerH: number
}

async function metrics(win: Page): Promise<Metrics> {
  return win.evaluate(() => {
    const scroller = document.querySelector('.fl-conv-scroller') as HTMLElement
    const composer = document.querySelector('.fl-composer') as HTMLElement
    return {
      scrollTop: Math.round(scroller.scrollTop),
      scrollHeight: scroller.scrollHeight,
      clientHeight: scroller.clientHeight,
      dist: Math.round(scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight),
      composerH: Math.round(composer.getBoundingClientRect().height),
    }
  })
}

/** Type a multi-line follow-up, exactly as a user does (⇧⏎ for newline — the
 *  composer's own placeholder documents it). Grows the textarea to its max. */
async function typeMultilineFollowUp(win: Page, lines: number): Promise<void> {
  const input = win.locator(sel.composerInput)
  await input.click()
  for (let i = 0; i < lines; i++) {
    await input.type(`follow-up line ${i} of the question I am composing`)
    await win.keyboard.down('Shift')
    await win.keyboard.press('Enter')
    await win.keyboard.up('Shift')
  }
  await win.waitForTimeout(300)
}

async function emitStream(app: ElectronApplication, ev: Record<string, unknown>): Promise<void> {
  await app.evaluate(({ BrowserWindow }, event) => {
    BrowserWindow.getAllWindows()[0]?.webContents.send('threads:stream', event)
  }, ev)
}

test.afterAll(() => cleanupSeeds())

test('control: a tall thread opens AT the live end, last answer in the viewport', async ({
  window,
}) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  const dir = await seedProject(window)
  await activateProject(window, dir)
  await seedAndOpen(window, dir, 'Live End Control')

  const before = await metrics(window)
  expect(
    before.dist,
    `precondition: the pane must land at the live end (dist ${before.dist})`,
  ).toBeLessThan(BOTTOM_LOCK_THRESHOLD_PX)
  // The transcript really does overflow — otherwise "at the bottom" is trivial.
  expect(before.scrollHeight).toBeGreaterThan(before.clientHeight * 2)
  await expect(window.getByText(LAST_ANSWER)).toBeInViewport()

  expect(errors, errors.join(', ')).toHaveLength(0)
})

/** Pick a density through the control a person uses. */
async function setDensity(win: Page, density: 'compact' | 'balanced' | 'detailed'): Promise<void> {
  await win.locator('.fl-titlebar-icon[aria-label="Settings"]').click()
  await win.locator('.fl-settings-tab', { hasText: 'App' }).click()
  await win.locator('select[aria-label="Conversation density"]').selectOption(density)
  await win.keyboard.press('Escape')
  await win.waitForTimeout(300)
}

/** Grow the composer, then stream a reply into the thread. */
async function growThenStream(win: Page, app: ElectronApplication, threadId: string): Promise<void> {
  await typeMultilineFollowUp(win, 10)
  const grown = await metrics(win)
  // The viewport really did shrink (the trigger fired).
  expect(
    grown.clientHeight,
    `precondition: the composer must have taken height from the transcript (${grown.composerH}px composer)`,
  ).toBeLessThan(600)

  // A new turn streams in. `#pinned` is untouched by the growth (the scroll
  // handler only unpins on a real gesture or an upward move), so auto-follow
  // must still bring the newest text to the bottom.
  // The turn starts first, as a real one does: in Compact the live work row
  // exists only while a turn runs (85a19380), not for a block alone.
  const messageId = 'live-end-pin-msg-1'
  await emitStream(app, { kind: 'status', threadId, status: 'working' })
  await emitStream(app, { kind: 'message-start', threadId, messageId })
  for (let i = 0; i < 4; i++) {
    await emitStream(app, {
      kind: 'message-delta',
      threadId,
      messageId,
      text: `Streamed paragraph ${i} of the reply.\n\n`,
    })
    await win.waitForTimeout(30)
  }
  await emitStream(app, {
    kind: 'message-delta',
    threadId,
    messageId,
    text: 'PIN-TAIL-MARKER final streamed line.',
  })
  await win.waitForTimeout(250)
}

// Balanced renders the streamed text in the feed as it arrives — the content
// growth auto-follow exists for. (Compact folds a running request into one
// live row instead; see the next test.)
test('control: the composer growth does NOT unpin auto-follow — a streamed delta still lands at the bottom', async ({
  window,
  app,
}) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  const dir = await seedProject(window)
  await activateProject(window, dir)
  await setDensity(window, 'balanced')
  const threadId = await seedAndOpen(window, dir, 'Pin Survives Growth')

  await growThenStream(window, app, threadId)
  await expect(window.getByText('PIN-TAIL-MARKER final streamed line.')).toBeInViewport()
  const after = await metrics(window)
  expect(
    after.dist,
    `auto-follow must still reach the live end after the composer grew (dist ${after.dist})`,
  ).toBeLessThan(BOTTOM_LOCK_THRESHOLD_PX)

  expect(errors, errors.join(', ')).toHaveLength(0)
})

// Compact (plan_chat-cleanup): the streamed text is a step inside the live
// work row, so what must stay at the live end is that row.
test('control (Compact): the composer growth does NOT unpin auto-follow — the live row lands at the bottom', async ({
  window,
  app,
}) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  const dir = await seedProject(window)
  await activateProject(window, dir)
  const threadId = await seedAndOpen(window, dir, 'Pin Survives Growth Compact')

  await growThenStream(window, app, threadId)
  const row = window.locator('.fl-request-row.live')
  await expect(row).toHaveCount(1)
  await expect(row).toBeInViewport()
  const after = await metrics(window)
  expect(
    after.dist,
    `auto-follow must still reach the live end after the composer grew (dist ${after.dist})`,
  ).toBeLessThan(BOTTOM_LOCK_THRESHOLD_PX)

  expect(errors, errors.join(', ')).toHaveLength(0)
})

// FIXED (#1374) — the pane never observed its OWN height, so it defended the
// live end only when content grew (#651/#823/#939/#1178) and never when its
// viewport shrank. Measured on main before the fix: clientHeight 714 → 530,
// scrollTop 2290 → 2335, dist 1 → 140 — the last answer left the viewport
// entirely, byte-identical across 3 runs. A ResizeObserver on the scroller now
// re-asserts the bottom while pinned.
test(
  'typing a multi-line follow-up must not push the answer you are replying to out of view',
  async ({ window }) => {
    const errors: string[] = []
    window.on('pageerror', (e) => errors.push(e.message))

    const dir = await seedProject(window)
    await activateProject(window, dir)
    await seedAndOpen(window, dir, 'Grow Tripwire')

    const before = await metrics(window)
    expect(before.dist).toBeLessThan(BOTTOM_LOCK_THRESHOLD_PX)
    await expect(window.getByText(LAST_ANSWER)).toBeInViewport()

    await typeMultilineFollowUp(window, 10)
    const after = await metrics(window)
    await window.screenshot({ path: `${SCREENS}/conversation-live-end-composer-grow.png` })

    expect(
      after.dist,
      `the composer grew ${before.composerH}px → ${after.composerH}px and took ${before.clientHeight - after.clientHeight}px out of the transcript, stranding the reader ${after.dist}px above the live end`,
    ).toBeLessThan(BOTTOM_LOCK_THRESHOLD_PX)
    await expect(window.getByText(LAST_ANSWER)).toBeInViewport()

    expect(errors, errors.join(', ')).toHaveLength(0)
  },
)
