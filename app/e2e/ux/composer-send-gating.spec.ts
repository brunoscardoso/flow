import { test, expect } from '../fixtures/electron'
import { sel } from '../selectors'
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page, ElectronApplication } from '@playwright/test'

/**
 * UX sweep — flow 3 (composer), round 25: WHEN the composer lets you send, and
 * WHETHER the control that does it is reachable.
 *
 * Two filed bugs, both about the send affordance rather than the send itself:
 *
 *  1. #1469 — GEOMETRY. `.fl-composer-controls` is a nowrap flex row with a
 *     `flex:1` spacer before the action buttons. At the app's OWN default window
 *     size (`WINDOW_DEFAULT_WIDTH = 1440`, main/index.ts:134) the chat pane is
 *     306 px, the row's min-content is 335 px, and the trailing buttons are laid
 *     out PAST the composer's right edge (661) where the neighbouring pane paints
 *     over them: idle Send at x 661–706, and while working Interrupt at 661–741
 *     and Queue at 749–801 — `document.elementFromPoint` at all three centres
 *     returns `div.xterm-viewport`. So at the stock size there is no clickable
 *     Send and no clickable stop button; `threads:interrupt` has no keyboard
 *     equivalent, so a running turn can't be stopped by mouse at all. Fine at
 *     ≥1680 px, and ⌘B (sidebar off) fixes it at 1440; hiding the terminal does
 *     not (the pane stays 306 px).
 *
 *  2. #1470 — GATING. `#send` (composer.ts:823), `#syncEnabled` (1841) and
 *     `#drainNext` (968) all gate on `status === 'working'` alone, so a turn
 *     parked on a permission ask (`needs-decision`) counts as FREE: the button
 *     reads "Send", Interrupt is hidden, and ⏎ fires a live sendMessage. Main
 *     then flips the thread to `working` (agent-manager.ts:332), retiring the
 *     amber row #949 added so a parked ask is discoverable from outside the
 *     thread — while the agent is still parked in canUseTool and produced
 *     nothing 20 s later. Answer the ask afterwards and the refused tool runs.
 *     The composer's own queue module already ships the right predicate and says
 *     so — `isComposerFreeStatus` (prompt-queue.ts:45): "`needs-decision`/
 *     `blocked` are NOT free" — and nothing in the send path calls it. The
 *     sibling surface IS handled: a typed message cancels a parked
 *     AskUserQuestion (#692, agent-manager.ts:300); a parked permission gets
 *     no equivalent.
 *
 * MEASURED, NOT FILED (cap of 2/cycle — for the next composer round): `#sending`
 * is composer-global, not per-thread. Send on thread A, switch to thread B while
 * A's round-trip is in flight, and B's button reads "Sending…" and is disabled;
 * ⏎ on B is a silent dead key — no IPC call, no toast, text left in the box —
 * until A resolves (~4.5 s on a first-turn SDK spin-up, unbounded if it hangs).
 *
 * HARNESS TRAPS (each cost a wrong reading first):
 *  - Every committed composer spec asserts Send through DOM properties
 *    (`disabled`, `innerText`) or `toBeVisible()`. ALL of those pass on a button
 *    laid out outside its pane — it has a real box and no `visibility:hidden`,
 *    it is merely painted under a neighbour. Reachability must be hit-tested
 *    with `document.elementFromPoint`.
 *  - `window.flow` CANNOT be stubbed from the page: the contextBridge object is
 *    frozen (`Object.isFrozen(window.flow.threads) === true`) and `window.flow`
 *    itself is non-configurable, so neither assignment nor a Proxy takes. Spy at
 *    MAIN instead, by re-registering `ipcMain.handle('threads:sendMessage', …)`.
 *  - A Bash `echo` never raises a permission card — the CLI classifies it safe
 *    and it runs without a canUseTool round-trip. A `Write` to a new path does.
 *  - Set the window size explicitly: saved bounds (and the E2E secondary-display
 *    placement) otherwise decide the pane width the geometry assertions read.
 */

const SCREENS = 'e2e/ux/__screens'

/** The app's own default window size (main/index.ts:134-135). */
const DEFAULT_W = 1440
const DEFAULT_H = 900

async function createThread(win: Page, root: string, title: string): Promise<string> {
  return win.evaluate(
    async ({ root, title }) => {
      const t = await (
        window as unknown as {
          flow: {
            threads: { create(i: { projectRoot: string; title: string }): Promise<{ id: string }> }
          }
        }
      ).flow.threads.create({ projectRoot: root, title })
      return t.id
    },
    { root, title },
  )
}

async function resize(app: ElectronApplication, w: number, h: number): Promise<void> {
  await app.evaluate(({ BrowserWindow }, s) => {
    BrowserWindow.getAllWindows()[0]?.setSize(s.w, s.h)
  }, { w, h })
}

/**
 * Replace the real `threads:sendMessage` handler with a recorder, so a send can
 * be OBSERVED without a Claude account and without starting a turn. The bridge
 * is frozen in the renderer (see the header), so main is the only seam.
 */
async function spySend(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ ipcMain }) => {
    const g = globalThis as unknown as { __qaSends?: unknown[] }
    g.__qaSends = []
    ipcMain.removeHandler('threads:sendMessage')
    ipcMain.handle('threads:sendMessage', (_event, request) => {
      g.__qaSends?.push(request)
      return { messageId: `qa-stub-${g.__qaSends?.length ?? 0}` }
    })
  })
}

async function sentContents(app: ElectronApplication): Promise<string[]> {
  return app.evaluate(() =>
    ((globalThis as unknown as { __qaSends?: { content: string }[] }).__qaSends ?? []).map(
      (r) => r.content,
    ),
  )
}

/** Every rendered control-row button with its box and whether a click there
 *  actually lands on it (an off-pane button hit-tests to another surface). */
async function controlButtons(
  win: Page,
): Promise<{ label: string; x: number; right: number; reachable: boolean; hit: string | null }[]> {
  return win.evaluate(() => {
    const composer = document.querySelector('.fl-composer') as HTMLElement
    return [...composer.querySelectorAll('.fl-composer-controls fl-button')]
      .map((el) => {
        const box = el.getBoundingClientRect()
        if (box.width === 0) return null
        const hit = document.elementFromPoint(
          Math.round(box.x + box.width / 2),
          Math.round(box.y + box.height / 2),
        )
        return {
          label: (el as HTMLElement).innerText.trim() || (el.getAttribute('aria-label') ?? '?'),
          x: Math.round(box.x),
          right: Math.round(box.right),
          reachable: hit === el || el.contains(hit as Node),
          hit: hit ? hit.tagName.toLowerCase() : null,
        }
      })
      .filter((b): b is NonNullable<typeof b> => b !== null)
  })
}

async function composerRight(win: Page): Promise<number> {
  return win.evaluate(() =>
    Math.round((document.querySelector('.fl-composer') as HTMLElement).getBoundingClientRect().right),
  )
}

async function emitStatus(
  app: ElectronApplication,
  threadId: string,
  status: string,
): Promise<void> {
  await app.evaluate(
    ({ BrowserWindow }, p) => {
      BrowserWindow.getAllWindows()[0]?.webContents.send('threads:stream', {
        kind: 'status',
        threadId: p.threadId,
        status: p.status,
      })
    },
    { threadId, status },
  )
}

/** The real `threads:permissionRequest` broadcast a parked tool call produces. */
async function emitPermission(
  app: ElectronApplication,
  request: Record<string, unknown>,
): Promise<void> {
  await app.evaluate(({ BrowserWindow }, req) => {
    BrowserWindow.getAllWindows()[0]?.webContents.send('threads:permissionRequest', req)
  }, request)
}

/** Seed a project, open a thread, and return its id with the composer mounted. */
async function openThread(win: Page, title: string): Promise<{ dir: string; threadId: string }> {
  const dir = await seedProject(win)
  writeFileSync(join(dir, 'README.md'), '# seeded\n')
  await activateProject(win, dir)
  const threadId = await createThread(win, dir, title)
  await win.getByText(title, { exact: true }).first().click()
  await expect(win.locator(sel.composer)).toBeVisible()
  return { dir, threadId }
}

const textareaOf = (win: Page) => win.locator(`${sel.composer} textarea`)
const queueItems = (win: Page) => win.locator(`${sel.composer} .fl-composer-queue-item`)
const permissionCard = (win: Page) => win.locator('.fl-permission-card')

test.afterAll(() => cleanupSeeds())

// ── Geometry ────────────────────────────────────────────────────────────────

test('the composer keeps its icon controls in the pane, and ⏎ still sends, at the default window size', async ({
  app,
  window,
}) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  await resize(app, DEFAULT_W, DEFAULT_H)
  await openThread(window, 'Geometry')
  await spySend(app)

  // The icon affordances stay inside the pane and are genuinely clickable.
  // "Capture" is darwin-only by design (#456: native region capture is
  // `screencapture -i`), so a flat count of 3 could never pass off macOS —
  // this guard was red on every Linux/Windows checkout for that reason alone.
  const icons = (await controlButtons(window)).filter((b) => b.label !== 'Send')
  const expectedIcons = process.platform === 'darwin' ? 3 : 2
  expect(icons.length, JSON.stringify(icons)).toBeGreaterThanOrEqual(expectedIcons)
  for (const button of icons) {
    expect(button.reachable, `${button.label} is not hit-testable: ${JSON.stringify(button)}`).toBe(
      true,
    )
  }

  // ⏎ remains the keyboard route (it was the ONLY working one until #1469).
  const textarea = textareaOf(window)
  await textarea.click()
  await textarea.type('a message sent with the keyboard')
  await textarea.press('Enter')
  await expect(textarea).toHaveValue('')
  // Polled: the box clears on the press, but the message goes only once the
  // thread's worktree is settled (#dispatchContent awaits prepareWorktree
  // first, on purpose — a checkout cut after the turn starts does not move it).
  await expect.poll(() => sentContents(app)).toEqual(['a message sent with the keyboard'])

  expect(errors, errors.join(', ')).toHaveLength(0)
})

test(
  '#1469 — Send and Interrupt are laid out inside the composer at the default window size',
  async ({ app, window }) => {
    await resize(app, DEFAULT_W, DEFAULT_H)
    const { threadId } = await openThread(window, 'Geometry Tripwire')
    await spySend(app)

    const textarea = textareaOf(window)
    await textarea.click()
    await textarea.type('hello')

    const right = await composerRight(window)
    const idle = await controlButtons(window)
    const send = idle.find((b) => b.label === 'Send')
    expect(send, JSON.stringify(idle)).toBeDefined()
    expect(send!.right, `Send overflows the composer (right ${right}): ${JSON.stringify(send)}`)
      .toBeLessThanOrEqual(right)
    expect(send!.reachable, `Send is not hit-testable: ${JSON.stringify(send)}`).toBe(true)

    // While a turn runs, the stop affordance must be reachable too — it is the
    // only way to stop a turn (threads:interrupt has no keyboard equivalent).
    await emitStatus(app, threadId, 'working')
    await expect(
      window.locator(`${sel.composer} fl-button`, { hasText: 'Interrupt' }),
    ).toBeVisible()
    const working = await controlButtons(window)
    for (const button of working) {
      expect(button.right, `${button.label} overflows: ${JSON.stringify(button)}`).toBeLessThanOrEqual(
        await composerRight(window),
      )
      expect(button.reachable, `${button.label} is not hit-testable: ${JSON.stringify(button)}`).toBe(
        true,
      )
    }
  },
)

// ── Gating: a turn parked on a decision ─────────────────────────────────────

test('a parked permission ask keeps its verdicts actionable while the user types', async ({
  app,
  window,
}) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  await resize(app, DEFAULT_W, DEFAULT_H)
  const { threadId } = await openThread(window, 'Parked')
  await spySend(app)

  await emitStatus(app, threadId, 'working')
  await emitPermission(app, {
    requestId: 'qa-perm-1',
    threadId,
    toolName: 'Write',
    summary: 'Create qa-probe.txt',
    inputPreview: 'file_path: qa-probe.txt',
  })
  await emitStatus(app, threadId, 'needs-decision')

  const card = permissionCard(window)
  await expect(card).toHaveCount(1)
  await expect(card.getByText('Allow once', { exact: true })).toBeVisible()
  await expect(card.getByText('Deny', { exact: true })).toBeVisible()

  // Typing (and sending) a message must never wedge the ask — the verdicts stay
  // on screen and answerable, which is the invariant #96/#949 protect.
  const textarea = textareaOf(window)
  await textarea.click()
  await textarea.type('no, do not run that')
  await textarea.press('Enter')
  await expect(card.locator('.fl-permission-actions')).toBeVisible()
  await window.screenshot({ path: `${SCREENS}/composer-parked-permission-typed-reply.png` })

  await card.getByText('Deny', { exact: true }).click()
  await expect(card.locator('.fl-permission-resolution')).toHaveText('Denied')

  expect(errors, errors.join(', ')).toHaveLength(0)
})

test('while the agent is working, the same keystroke queues instead of sending', async ({
  app,
  window,
}) => {
  await resize(app, DEFAULT_W, DEFAULT_H)
  const { threadId } = await openThread(window, 'Working Contrast')
  await spySend(app)

  await emitStatus(app, threadId, 'working')
  const textarea = textareaOf(window)
  await textarea.click()
  await textarea.type('a follow-up while it works')
  await textarea.press('Enter')

  // Queued, not sent: a removable pill, and no IPC send at all.
  await expect(queueItems(window)).toHaveCount(1)
  await expect(textarea).toHaveValue('')
  expect(await sentContents(app)).toEqual([])
})

test(
  '#1470 — a message typed against a parked permission ask is queued, not sent live',
  async ({ app, window }) => {
    await resize(app, DEFAULT_W, DEFAULT_H)
    const { threadId } = await openThread(window, 'Parked Tripwire')
    await spySend(app)

    await emitStatus(app, threadId, 'working')
    await emitPermission(app, {
      requestId: 'qa-perm-2',
      threadId,
      toolName: 'Write',
      summary: 'Create qa-probe.txt',
      inputPreview: 'file_path: qa-probe.txt',
    })
    await emitStatus(app, threadId, 'needs-decision')
    await expect(permissionCard(window)).toHaveCount(1)

    const textarea = textareaOf(window)
    await textarea.click()
    await textarea.type('no, do not run that — just tell me what 2+2 is')

    // A turn parked mid-flight is not free (prompt-queue.ts:45), so the composer
    // must offer the SAME queueing contract it offers while `working` — including
    // the label. Asserted with content in the box on purpose: #472 hides the
    // primary button entirely while a turn is in flight and there is nothing to
    // queue, so checking before typing would be testing #472's rule, not #1470's.
    await expect(
      window.locator(`${sel.composer} fl-button`, { hasText: 'Queue' }),
    ).toBeVisible()

    await textarea.press('Enter')

    await expect(queueItems(window)).toHaveCount(1)
    expect(
      await sentContents(app),
      'the message was dispatched live behind a parked decision',
    ).toEqual([])
  },
)
