import { test, expect, type ElectronApplication } from '../fixtures/electron'
import { sel } from '../selectors'
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed'
import type { Page } from '@playwright/test'

/**
 * UX sweep — flow 4 (round 25): the jump-to-latest control's LIVE behaviour.
 *
 * Round 23 (#1330) filed the missing control; the fix shipped it
 * (`.fl-conv-jump`, jump-to-latest.ts) — a floating pill that appears once the
 * reader scrolls away from the live end and, per its own contract, "names the
 * count" so the reader knows the conversation moved on:
 *
 *     label = missed > 0 ? `${missed} new ↓` : 'Jump to latest ↓'
 *
 * `.fl-conv-jump` had ZERO e2e references anywhere in the suite — every
 * flow-4 round (5–24: states, lifecycle, file refs, external links, nested
 * lists, fences, streaming, tool/error/permission/question cards, md blocks,
 * background turns, reconcile reader-state, attachments, stats line,
 * interrupted turns, unpin aftermath, image viewer) drove the anchor rule that
 * *creates* the situation, never the control that resolves it. This probe
 * drives the control itself: does it appear, does its count mean anything, and
 * does clicking it actually take the reader back?
 *
 * Test 1 is the live green guard for the half that works (appear on unpin,
 * click returns to the live end and clears).
 *
 * Test 2 is a `test.fixme` tripwire: the count is not a count. Every entry the
 * pane appends runs through `#appendHistoryEntry`, which ticks
 * `#missedSinceUnpin` whenever the reader is unpinned — including the ~200
 * entries re-appended by the FULL history rebuild that `#reconcile` runs at
 * turn completion (conversation-pane.ts:1323 → :910 → :980). One reply landing
 * while the reader is scrolled up therefore reports the whole transcript.
 * Measured live on main: 1 new message, pill reads "41 new ↓".
 *
 * Test 3 is a `test.fixme` tripwire for the same counter's other end:
 * `setThread` re-pins (:725) but never clears `#missedSinceUnpin` and never
 * re-syncs the control, so the count survives a thread switch and is served to
 * the reader of a DIFFERENT thread the moment they scroll up in it. Measured
 * live on main: thread B, zero messages of its own, pill reads "41 new ↓".
 *
 * Test 4 is a `test.fixme` tripwire for the pill's CHROME. It floats over the
 * transcript, and at `bottom: 64px` it usually lands on a message bubble — but
 * its fill is `--fl-color-surface-raised`, the SAME token the bubbles use
 * (both measured rgb(42,42,43)), its border resolves to rgb(43,43,43) — one
 * unit off its own fill — and its `box-shadow: var(--fl-shadow-md)` computes
 * to `none` because `--fl-shadow-md` is defined nowhere in the app (9 call
 * sites, zero definitions). All three separations collapse at once, so the
 * control renders as bare text spliced into a sentence.
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
async function seedTallThread(
  win: Page,
  root: string,
  title: string,
  lines = 40,
): Promise<string> {
  const id = await createThread(win, root, title)
  for (let i = 0; i < lines; i++) {
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

/** What the jump control currently says (null when it isn't offered). */
async function jumpLabel(win: Page): Promise<string | null> {
  return win.evaluate(() => {
    const button = document.querySelector('.fl-conv-jump') as HTMLButtonElement | null
    if (button === null || button.hidden) return null
    return (button.textContent ?? '').trim()
  })
}

test.afterAll(() => cleanupSeeds())

test('jump-to-latest: appears once the reader leaves the live end, and clicking it takes them back', async ({
  window,
}) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  const dir = await seedProject(window, 'flow-ux-jump-')
  await activateProject(window, dir)
  await seedTallThread(window, dir, 'Jump Control Thread')
  await openThread(window, 'Jump Control Thread')

  // Landing at the live end, there is nothing to jump to.
  expect(await jumpLabel(window), 'no control while the reader is at the live end').toBeNull()

  const away = await scrollUpByGesture(window)
  expect(away, 'the wheel gesture must unpin auto-follow (#823)').toBeGreaterThan(200)

  // Unpinned and well clear of the bottom — the control is the way back.
  const offered = await jumpLabel(window)
  expect(offered, 'a scrolled-up reader must be offered the way back (#1330)').not.toBeNull()
  expect(offered ?? '').toMatch(/latest|new/i)
  await expect(
    window.locator('.fl-conv-jump'),
    'the pill must be announced — its label alone reads as a bare arrow',
  ).toHaveAttribute('aria-label', /jump|latest|new message/i)
  await window.screenshot({ path: `${SCREENS}/conv-jump-offered.png` })

  // The whole point of the control: one click returns the reader to the live end…
  await window.locator('.fl-conv-jump').click()
  await window.waitForTimeout(300)
  expect(await distanceFromBottom(window), 'clicking must land at the live end').toBeLessThan(120)
  // …and it stands down once it has nothing left to offer.
  expect(await jumpLabel(window), 'the control must retire at the live end').toBeNull()

  expect(errors, errors.join(', ')).toHaveLength(0)
})

// Tripwire: the count on the pill is a count of RENDERED ENTRIES, not of new
// messages. Measured live on main: one assistant reply lands while the reader
// is scrolled up, the turn reconciles, and the pill reads "42 new ↓".
test(
  'jump-to-latest: the "N new" count reports messages that actually arrived, not the whole transcript',
  async ({ window, app }) => {
    const dir = await seedProject(window, 'flow-ux-jump-')
    await activateProject(window, dir)
    const threadId = await seedTallThread(window, dir, 'Jump Count Thread')
    await openThread(window, 'Jump Count Thread')

    const messageId = 'jump-count-msg'
    await emitStream(app, { kind: 'status', threadId, status: 'working' })
    await emitStream(app, { kind: 'message-start', threadId, messageId })
    await emitStream(app, {
      kind: 'message-delta',
      threadId,
      messageId,
      text: 'HEAD-MARKER Working through this now.\n\n',
    })
    await window.waitForTimeout(120)

    const away = await scrollUpByGesture(window)
    expect(away).toBeGreaterThan(200)
    expect(await jumpLabel(window)).not.toBeNull()

    // ONE reply arrives and the turn completes while the reader stays put.
    await appendMessage(window, threadId, 'assistant', 'The single new answer of this turn.')
    await emitStream(app, { kind: 'done', threadId, messageId })
    await emitStream(app, { kind: 'status', threadId, status: 'idle' })
    await window.waitForTimeout(700)

    const label = await jumpLabel(window)
    await window.screenshot({ path: `${SCREENS}/conv-jump-inflated-count.png` })
    const counted = Number(/(\d+)\s*new/i.exec(label ?? '')?.[1] ?? '0')
    expect(
      counted,
      `the pill must not overstate what arrived — one reply landed, it says "${label}"`,
    ).toBeLessThanOrEqual(3)
  },
)

// Tripwire, same counter's other end: `setThread` re-pins but never clears
// `#missedSinceUnpin`, so the number follows the reader into another thread.
test(
  'jump-to-latest: the missed count does not follow the reader into a different thread',
  async ({ window, app }) => {
    const dir = await seedProject(window, 'flow-ux-jump-')
    await activateProject(window, dir)
    const threadA = await seedTallThread(window, dir, 'Jump Leak Thread A')
    await seedTallThread(window, dir, 'Jump Leak Thread B')

    // Thread A earns a count the ordinary way: a turn lands while its reader
    // is scrolled up.
    await openThread(window, 'Jump Leak Thread A')
    await emitStream(app, { kind: 'status', threadId: threadA, status: 'working' })
    await emitStream(app, { kind: 'message-start', threadId: threadA, messageId: 'leak-msg' })
    await emitStream(app, {
      kind: 'message-delta',
      threadId: threadA,
      messageId: 'leak-msg',
      text: 'HEAD-MARKER Working through this now.\n\n',
    })
    await window.waitForTimeout(120)
    expect(await scrollUpByGesture(window)).toBeGreaterThan(200)
    await appendMessage(window, threadA, 'assistant', 'The answer that landed while you read up.')
    await emitStream(app, { kind: 'done', threadId: threadA, messageId: 'leak-msg' })
    await emitStream(app, { kind: 'status', threadId: threadA, status: 'idle' })
    await window.waitForTimeout(700)
    expect(await jumpLabel(window), 'thread A now carries a count').toMatch(/\d+\s*new/i)

    // Switch away — a different transcript, at its own live end.
    await openThread(window, 'Jump Leak Thread B')
    await window.waitForTimeout(400)
    expect(
      await jumpLabel(window),
      'a freshly opened thread lands at its live end — nothing to jump to',
    ).toBeNull()

    // Nothing has arrived in B. The control must not claim otherwise.
    expect(await scrollUpByGesture(window)).toBeGreaterThan(200)
    const label = await jumpLabel(window)
    await window.screenshot({ path: `${SCREENS}/conv-jump-count-leak.png` })
    expect(
      label ?? '',
      'no message arrived in this thread, so the pill must not report any',
    ).not.toMatch(/\d+\s*new/i)
  },
)

// Tripwire: the pill has no visible chrome. Fill identical to the bubble it
// lands on, a border one RGB unit off that fill, and an undefined shadow token
// — so the only "control" the pane offers a stranded reader reads as text
// spliced into someone else's message.
test(
  'jump-to-latest: the control is visually separable from the transcript it floats over',
  async ({ window }) => {
    const dir = await seedProject(window, 'flow-ux-jump-')
    await activateProject(window, dir)
    await seedTallThread(window, dir, 'Jump Chrome Thread')
    await openThread(window, 'Jump Chrome Thread')

    expect(await scrollUpByGesture(window)).toBeGreaterThan(200)
    expect(await jumpLabel(window)).not.toBeNull()

    const chrome = await window.evaluate(() => {
      const button = document.querySelector('.fl-conv-jump') as HTMLElement | null
      if (button === null) return null
      const style = getComputedStyle(button)
      const rect = button.getBoundingClientRect()
      // What the pill is actually covering right now.
      button.style.pointerEvents = 'none'
      const behind = document.elementFromPoint(
        rect.left + rect.width / 2,
        rect.top + rect.height / 2,
      )
      button.style.pointerEvents = ''
      // The element directly under the pill is usually a transparent inner
      // wrapper — walk up to whatever actually paints, which is what the
      // reader's eye compares the pill against.
      const paintedBg = (start: Element | null): string => {
        let node: Element | null = start
        while (node !== null) {
          const bg = getComputedStyle(node).backgroundColor
          if (bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') return bg
          node = node.parentElement
        }
        return 'rgba(0, 0, 0, 0)'
      }
      const behindBg = paintedBg(behind)
      return {
        fill: style.backgroundColor,
        border: style.borderTopColor,
        shadow: style.boxShadow,
        behindBg,
        behindText: (behind as HTMLElement | null)?.innerText?.slice(0, 40) ?? '',
      }
    })
    await window.screenshot({ path: `${SCREENS}/conv-jump-chrome.png` })
    expect(chrome).not.toBeNull()
    const { fill, border, shadow, behindBg } = chrome!
    // Largest per-channel gap between two computed colours. Anything under ~8
    // is a difference no reader perceives — rgb(42,42,43) vs rgb(43,43,43) is 1.
    const gap = (a: string, b: string): number => {
      const parse = (c: string) => (c.match(/\d+(\.\d+)?/g) ?? []).slice(0, 3).map(Number)
      const [x, y] = [parse(a), parse(b)]
      if (x.length < 3 || y.length < 3) return 255
      return Math.max(...x.map((v, i) => Math.abs(v - y[i]!)))
    }
    const VISIBLE_GAP = 8
    // At least ONE separation must survive, or the pill is indistinguishable
    // from the message text it floats over.
    const separated =
      shadow !== 'none' || gap(fill, behindBg) >= VISIBLE_GAP || gap(border, fill) >= VISIBLE_GAP
    expect(
      separated,
      `the pill must read as a control: fill ${fill} over ${behindBg} (gap ${gap(fill, behindBg)}), border ${border} (gap ${gap(border, fill)}), shadow ${shadow}`,
    ).toBe(true)
  },
)
