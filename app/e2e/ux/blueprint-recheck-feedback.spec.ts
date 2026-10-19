import { test, expect } from '../fixtures/electron'
import { statusButtonByText } from '../selectors'
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ElectronApplication, Page } from '@playwright/test'
import { LEARN_BUTTON, openLearningPanel } from './fixtures/territory'

/**
 * UX sweep — flow 10 (Blueprint), round 20: the **manual re-derive** control and
 * the feedback it owes the user.
 *
 * Background. The 2026-07-27 header cleanup took the ⟳ Refresh button OUT of the
 * board header (`blueprint-board.ts` ~795-809 builds it, then `void refresh` —
 * it is never appended) and hides the "New Blueprint" primary on a live board
 * *because* it is "redundant with ⟳ Refresh" (`#applyHeaderActions` ~5937-5939).
 * What remains as the standing manual re-derive a user can reach is the small
 * `⟳` inside the **Learning panel** (`.fb-learn-recheck`, ~4325-4332), titled
 * "Re-check all — re-derive the map, re-read docs and staleness". It calls the
 * same `BlueprintBoard#derive()` (~1245) the retired header button called.
 *
 * That method's two feedback paths both aim at DOM that is no longer on screen:
 *  - `#setRefreshBusy` (~5946-5951) spins `#refreshIcon` and disables
 *    `#refreshButton`/`#newButton` — the detached button, its child icon, and a
 *    `display:none` button. The `⟳` the user actually pressed gets nothing.
 *  - a failed derive only `console.warn`s (~1262/1265). With a graph already
 *    present `resolvePane` returns plain `'board'` (view-state.ts ~145), so no
 *    banner, no pane message, and no `flow:notify` — while sibling actions in
 *    the SAME panel/board DO toast on failure (Docs verify ~4888, Federation
 *    refresh ~5788, Must-review ~5645).
 *
 * Genuinely un-probed: 22 committed blueprint specs across 19 rounds drive the
 * board, popover, preview, trace, drift, learning and no-project surfaces —
 * none drives `derive()` itself, and no spec anywhere greps for `.fb-banner`,
 * "Refresh" or the re-check button.
 *
 * The two live guards below pin what DOES work (the ⟳ is wired to a real
 * derive; the board's toast surface renders) so the two `test.fixme` tripwires
 * cannot pass vacuously. Filed: **#1195** (no busy state for the seconds the
 * re-derive runs) and **#1196** (a failed re-derive says nothing at all).
 *
 * NOTE — seeding artifact (do not "fix" by asserting on card counts): a seeded
 * temp repo is auto-provisioned and gets a REAL background `blueprint derive`
 * that rewrites the seeded `graph.json` with a 0-node graph a few seconds in.
 * Every assertion here targets the BUTTON and the ABSENCE/PRESENCE of a
 * message, both of which survive that.
 */

const GRAPH = {
  version: 1,
  derivedAt: new Date(Date.now() - 3600_000).toISOString(),
  coverage: { filesScanned: 3, filesTotal: 4, extractorsRun: ['ts'], graphifyEnriched: false },
  nodes: [
    { id: 'module:src', kind: 'module', label: 'src', sourceFile: 'src', meta: { depth: 1 } },
    { id: 'module:lib', kind: 'module', label: 'lib', sourceFile: 'lib', meta: { depth: 1 } },
    { id: 'module:test', kind: 'module', label: 'test', sourceFile: 'test', meta: { depth: 1 } },
  ],
  edges: [],
}

function seedGraph(root: string): void {
  const dir = join(root, 'flow', 'brain', '.structure')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'graph.json'), JSON.stringify(GRAPH))
}

test.afterAll(() => cleanupSeeds())

/**
 * Replace the REAL `blueprint:derive` main handler with one that settles after
 * `delayMs` with the given verdict, counting invocations. Stubbing in MAIN (not
 * on the frozen `contextBridge` object) keeps the whole renderer path — button
 * → `derive()` → preload → IPC → back → `refresh()` — genuinely exercised.
 */
async function stubDerive(
  app: ElectronApplication,
  opts: { ok: boolean; error?: string; delayMs: number },
): Promise<void> {
  await app.evaluate(({ ipcMain }, o) => {
    const g = globalThis as unknown as { __qaDeriveCalls?: number }
    g.__qaDeriveCalls = 0
    ipcMain.removeHandler('blueprint:derive')
    ipcMain.handle('blueprint:derive', () => {
      g.__qaDeriveCalls = (g.__qaDeriveCalls ?? 0) + 1
      return new Promise((resolve) =>
        setTimeout(() => resolve({ ok: o.ok, error: o.error ?? null }), o.delayMs),
      )
    })
  }, opts)
}

/**
 * Wait out the board's OWN opening derive, then zero the counter. Measured:
 * ~300 ms after the Learning panel opens, a `refresh()` lands a snapshot with
 * no graph (the seeding artifact in the header NOTE), and the one-shot
 * `auto-derive` pane runs `derive()` itself — through the stub when it is
 * already installed. Its ⟳ is busy for those seconds, so a click waits it out
 * (one call too many) and an "idle" probe reads the busy state (no change to
 * see). Quiet = the ⟳ is enabled, and neither its `aria-busy` nor the call
 * count has moved for `QUIET_MS`.
 */
const QUIET_MS = 1_500

async function settleOpeningDerive(
  app: ElectronApplication,
  recheck: ReturnType<Page['locator']>,
): Promise<void> {
  await recheck.evaluate((el) => {
    const w = window as unknown as { __qaBusyAt: number }
    w.__qaBusyAt = Date.now()
    new MutationObserver(() => (w.__qaBusyAt = Date.now())).observe(el, {
      attributes: true,
      attributeFilter: ['aria-busy', 'disabled'],
    })
  })
  let calls = await deriveCalls(app)
  let callsAt = Date.now()
  await expect
    .poll(
      async () => {
        const now = await deriveCalls(app)
        if (now !== calls) [calls, callsAt] = [now, Date.now()]
        const quiet = await recheck.evaluate(
          (el, ms) =>
            !(el as HTMLButtonElement).disabled &&
            Date.now() - (window as unknown as { __qaBusyAt: number }).__qaBusyAt >= ms,
          QUIET_MS,
        )
        return quiet && Date.now() - callsAt >= QUIET_MS
      },
      { timeout: 30_000, intervals: [250] },
    )
    .toBe(true)
  await app.evaluate(() => {
    ;(globalThis as unknown as { __qaDeriveCalls?: number }).__qaDeriveCalls = 0
  })
}

function deriveCalls(app: ElectronApplication): Promise<number> {
  return app.evaluate(
    () => (globalThis as unknown as { __qaDeriveCalls?: number }).__qaDeriveCalls ?? 0,
  )
}

/** Record every `flow:notify` — an auto-dismissing toast can't slip past. */
async function captureNotifications(window: Page): Promise<void> {
  await window.evaluate(() => {
    const store = window as unknown as { __qaNotes: unknown[] }
    store.__qaNotes = []
    document.addEventListener('flow:notify', (e) => store.__qaNotes.push((e as CustomEvent).detail))
  })
}

function notifications(window: Page): Promise<Array<{ title: string; body: string }>> {
  return window.evaluate(
    () =>
      (window as unknown as { __qaNotes?: Array<{ title: string; body: string }> }).__qaNotes ?? [],
  )
}

/**
 * Every line the given scope SAYS — open shadow roots included, stylesheets
 * excluded (a `:host([tone='error'])` rule inside an fl-* shadow style is not a
 * message). Returned as leaf strings so a caller can diff against a baseline:
 * the app is full of unrelated standing text ("Working tree clean" in the
 * status bar, an agent's "Working…") that a naive whole-window regex reads as
 * progress feedback — measured, and the reason these checks are baselined.
 */
async function spokenLines(window: Page, scope = ':root'): Promise<string[]> {
  return window.evaluate((sel) => {
    const parts: string[] = []
    const root = document.querySelector(sel)
    if (root === null) return parts
    const walk = (r: Element | ShadowRoot) => {
      r.querySelectorAll('*').forEach((el) => {
        if (el.tagName === 'STYLE' || el.tagName === 'SCRIPT') return
        const sr = (el as HTMLElement & { shadowRoot?: ShadowRoot }).shadowRoot
        if (sr) walk(sr)
        else if (el.children.length === 0 && el.textContent) parts.push(el.textContent.trim())
      })
    }
    walk(root)
    return parts
  }, scope)
}

/** Lines present now that were not present before — the only ones a click can
 *  claim credit for. */
function newlySpoken(before: string[], after: string[]): string {
  const seen = new Set(before)
  return after.filter((line) => !seen.has(line)).join('\n')
}

const FAILURE_WORDS = /could not|couldn't|failed|error|unable|problem|violation|refused|retry/i
const PROGRESS_WORDS = /deriving|re-?checking|checking|refreshing|updating|in progress|please wait|working…/i

async function openBoard(window: Page, prefix: string): Promise<string> {
  const root = await seedProject(window, prefix)
  seedGraph(root)
  await activateProject(window, root)
  await window.locator(statusButtonByText('Blueprint')).click()
  await expect(window.locator('.flow-board-root')).toBeVisible()
  // The board is live once its header's permanent "Learn" door is up (this
  // used to wait for a module card of the retired code map).
  await expect(window.locator(LEARN_BUTTON)).toBeVisible({ timeout: 30_000 })
  return root
}

/** Open the Learning panel (the ⟳'s only home) via the header's "Learn"
 *  button — the learn chip is painted only by the retired module map. */
async function openLearnPanel(window: Page): Promise<ReturnType<Page['locator']>> {
  await openLearningPanel(window)
  const recheck = window.locator('.fb-learn-recheck')
  await expect(recheck).toBeVisible()
  return recheck
}

// ── Live guard 1 — the ⟳ IS the board's manual re-derive, and it really runs one

test('the header offers no Refresh — the Learning panel ⟳ is the manual re-derive, and it really derives', async ({
  app,
  window,
}) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  await openBoard(window, 'flow-ux-recheck-wired-')

  // The retired header controls: nothing on a live board says "Refresh", and
  // "New Blueprint" is GONE outright — it ran plain derive(), the same call the
  // board already makes itself, under a label promising something else.
  await expect(window.getByText('Refresh', { exact: false })).toHaveCount(0)
  await expect(window.locator('.fb-header fl-button', { hasText: 'New Blueprint' })).toHaveCount(0)

  // Its slot is now the permanent way into the Learning panel — reachable even
  // when the learn chip has nothing to report and hides itself.
  await expect(
    window.locator('.fb-header fl-button', { hasText: 'Learn' }).first(),
  ).toBeVisible()

  const recheck = await openLearnPanel(window)
  await expect(recheck).toHaveAttribute(
    'title',
    'Re-check all — re-derive the map, re-read docs and staleness',
  )

  // Wired end-to-end: the click reaches the real `blueprint:derive` channel.
  await stubDerive(app, { ok: true, delayMs: 300 })
  await settleOpeningDerive(app, recheck)
  expect(await deriveCalls(app)).toBe(0)
  await recheck.click()
  await expect.poll(() => deriveCalls(app), { timeout: 10_000 }).toBe(1)

  expect(errors, `pageerrors: ${errors.join(' | ')}`).toEqual([])
})

// ── Live guard 2 — the board's own toast surface renders (control for tripwire B)

test("a board-shaped flow:notify renders a toast — the failure path's missing voice exists", async ({
  window,
}) => {
  await openBoard(window, 'flow-ux-recheck-toast-')

  // Exactly the detail shape BlueprintBoard#notify (~1011-1024) dispatches.
  await window.evaluate(() => {
    document.dispatchEvent(
      new CustomEvent('flow:notify', {
        detail: {
          kind: 'state-change',
          rootId: '',
          title: 'Map change',
          body: 'A board-dispatched notification reaches the toast surface.',
          timestamp: new Date().toISOString(),
          level: 'error',
        },
      }),
    )
  })

  await expect(
    window.locator('.fl-flow-toast', { hasText: 'A board-dispatched notification' }),
  ).toBeVisible({ timeout: 5_000 })
})

// ── Tripwire A (#1195) — a multi-second re-derive shows no progress anywhere ──

test(
  'the ⟳ shows a busy state while its re-derive runs',
  async ({ app, window }) => {
    await openBoard(window, 'flow-ux-recheck-busy-')
    const recheck = await openLearnPanel(window)

    // A realistic derive is seconds long (the board's own must-review toast says
    // "map refresh confirms in a few seconds"). Five seconds of silence is the bug.
    await stubDerive(app, { ok: true, delayMs: 5_000 })
    await settleOpeningDerive(app, recheck)

    const probe = () =>
      recheck.evaluate((el) => ({
        cls: el.className,
        disabled: (el as HTMLButtonElement).disabled,
        busy: el.getAttribute('aria-busy'),
        anim: getComputedStyle(el).animationName,
      }))
    const idle = await probe()
    const quiet = await spokenLines(window, '.flow-board-root')

    await recheck.click()
    await expect.poll(() => deriveCalls(app), { timeout: 10_000 }).toBe(1) // derive is running

    // Fix-agnostic: ANY of these would tell the user something is happening.
    const busy = await probe()
    const spinners = await window.locator('fl-icon[name="spinner"]:visible, [spin]:visible').count()
    const said = newlySpoken(quiet, await spokenLines(window, '.flow-board-root'))

    const changed =
      busy.cls !== idle.cls ||
      busy.disabled !== idle.disabled ||
      busy.busy !== idle.busy ||
      busy.anim !== idle.anim
    expect(
      changed || spinners > 0 || PROGRESS_WORDS.test(said),
      `the ⟳ the user pressed shows nothing while a 5s re-derive runs — ` +
        `button unchanged (${JSON.stringify(busy)}), ${spinners} visible spinners, ` +
        `board said nothing new (${JSON.stringify(said.slice(0, 200))})`,
    ).toBe(true)
  },
)

// ── Tripwire B (#1196) — a failed re-derive is completely silent ──────────────

test('a re-derive that FAILS tells the user it failed', async ({ app, window }) => {
  await openBoard(window, 'flow-ux-recheck-silent-')
  await captureNotifications(window)
  const recheck = await openLearnPanel(window)

  await stubDerive(app, {
    ok: false,
    error: 'canonical contract violation: node module:src has no sourceFile',
    delayMs: 600,
  })
  await settleOpeningDerive(app, recheck)
  const before = await spokenLines(window)

  await recheck.click()
  await expect.poll(() => deriveCalls(app), { timeout: 10_000 }).toBe(1)
  await window.waitForTimeout(3_000) // the derive settled long ago

  const notes = await notifications(window)
  const said = newlySpoken(before, await spokenLines(window))

  expect(
    notes.length > 0 || FAILURE_WORDS.test(said),
    `the re-derive failed ("canonical contract violation: …") and the window says nothing: ` +
      `${notes.length} notifications, nothing new on screen names a failure ` +
      `(${JSON.stringify(said.slice(0, 200))})`,
  ).toBe(true)
})
