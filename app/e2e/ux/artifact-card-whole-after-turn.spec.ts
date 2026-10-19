/**
 * A DOC CARD APPEARS ONCE, WHOLE (user, 2026-10-08: "don't show the small version").
 *
 * While the agent's turn runs, a discovery lands in pieces: its markdown first
 * (a card with a title and buttons), its story a few tool calls later (the same
 * card, grown). The reader saw a small card turn into a big one. Now the first
 * appearance waits for the turn to end; the reconcile mounts it once.
 *
 * The doc event is sent from MAIN (`flow:artifactChanged`) rather than waiting
 * on the file watcher, which is unreliable for seeded temp projects on macOS.
 *
 * Always run hidden: FLOW_E2E=1 FLOW_E2E_BACKGROUND=1.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import type { ElectronApplication, Page } from '@playwright/test'

import { expect, test } from '../fixtures/electron'
import { sel } from '../selectors'
import { activateProject, cleanupSeeds, seedProject } from './fixtures/seed'

const DISCOVERY = 'flow/discovery/discovery_widgets_v1.md'

test.afterAll(() => cleanupSeeds())

async function api<T>(win: Page, fn: string, arg: unknown): Promise<T> {
  return win.evaluate(
    async ({ fn, arg }) => {
      const flow = (window as unknown as { flow: Record<string, Record<string, (i: unknown) => Promise<unknown>>> }).flow
      const [ns, method] = fn.split('.')
      return (await flow[ns]![method]!(arg)) as unknown
    },
    { fn, arg },
  ) as Promise<T>
}

async function toRenderer(app: ElectronApplication, channel: string, payload: unknown): Promise<void> {
  await app.evaluate(
    ({ BrowserWindow }, { channel, payload }) => {
      for (const w of BrowserWindow.getAllWindows()) w.webContents.send(channel, payload)
    },
    { channel, payload },
  )
}

/**
 * Drop a sentinel into the feed, so a rebuild is observable: the rebuild wipes
 * the feed and re-appends only what it can key (stored messages are REUSED, so
 * tagging them would survive it).
 */
async function markFeedStale(page: Page): Promise<void> {
  await page.evaluate(() => {
    const sentinel = document.createElement('div')
    sentinel.setAttribute('data-e2e-stale', '')
    document.querySelector('.fl-conv-feed')?.appendChild(sentinel)
  })
  await expect(page.locator('.fl-conv-feed > [data-e2e-stale]')).toHaveCount(1)
}

test('a discovery written mid-turn shows no card until the turn ends, then one whole card', async ({ app, window: page }) => {
  test.setTimeout(300_000)
  const root = await seedProject(page, 'flow-ux-whole-card-', (dir) => {
    mkdirSync(join(dir, 'flow', 'discovery'), { recursive: true })
  })
  await activateProject(page, root)

  const thread = await api<{ id: string }>(page, 'threads.create', { projectRoot: root, title: 'Whole card thread' })
  await api(page, 'messages.append', { threadId: thread.id, role: 'user', content: 'discover widgets' })
  await page.getByText('Whole card thread', { exact: true }).first().click()
  await expect(page.getByText('discover widgets', { exact: true })).toBeVisible()
  await expect(page.locator(sel.composer)).toBeVisible()

  // The turn is running.
  await toRenderer(app, 'threads:stream', { kind: 'status', threadId: thread.id, status: 'working' })

  // The agent writes the discovery; the watcher reports it.
  writeFileSync(join(root, DISCOVERY), '# Discovery: Widgets\n\nWidgets fold.\n')
  const event = { rootId: root, kind: 'discovery', path: DISCOVERY, name: 'discovery_widgets_v1.md', mtime: Date.now() }
  await toRenderer(app, 'flow:artifactChanged', event)

  // POSITIVE FIRST (allowed-pattern #28): the pane received the doc — it reads
  // it from disk — and the turn is still live. Give the card every chance.
  await page.waitForTimeout(2_000)
  const cards = page.locator('.fl-artifact-card').filter({ hasText: 'Widgets' })
  await expect(cards).toHaveCount(0)

  // The turn ends: the reconcile mounts the card, once.
  await toRenderer(app, 'threads:stream', { kind: 'done', threadId: thread.id, messageId: 'none' })
  await expect(cards).toHaveCount(1, { timeout: 30_000 })
  await expect(cards.first()).toBeVisible()
  await page.waitForTimeout(1_000)
  await expect(cards).toHaveCount(1)
})

/**
 * THE HOLD IS FOR A RUNNING TURN, NOT FOR MOTION (2026-10-09). A background
 * agent the turn left running reports its own tools after `done`, with no
 * `done` of its own to follow. The pane's loader flag took those as "busy",
 * the hold read that flag, and a doc landing next waited for the NEXT turn's
 * end. The hold now reads the turn's liveness (`turn-liveness.ts`): the turn
 * has ended, so the doc's card mounts as soon as the doc is read — once, whole,
 * as a doc written between turns always has.
 */
test('after the turn ends, a background agent’s stray tool does not hold a new doc’s card', async ({ app, window: page }) => {
  test.setTimeout(300_000)
  const root = await seedProject(page, 'flow-ux-whole-card-stray-', (dir) => {
    mkdirSync(join(dir, 'flow', 'discovery'), { recursive: true })
  })
  await activateProject(page, root)

  const thread = await api<{ id: string }>(page, 'threads.create', { projectRoot: root, title: 'Stray tool thread' })
  await api(page, 'messages.append', { threadId: thread.id, role: 'user', content: 'discover gadgets' })
  await page.getByText('Stray tool thread', { exact: true }).first().click()
  await expect(page.getByText('discover gadgets', { exact: true })).toBeVisible()
  await expect(page.locator(sel.composer)).toBeVisible()

  // A turn runs and ends.
  await toRenderer(app, 'threads:stream', { kind: 'status', threadId: thread.id, status: 'working' })
  await markFeedStale(page)
  await toRenderer(app, 'threads:stream', { kind: 'status', threadId: thread.id, status: 'done' })
  await toRenderer(app, 'threads:stream', { kind: 'done', threadId: thread.id, messageId: 'none' })
  // `done` rebuilds the feed from stored rows, and this stray tool is never
  // stored — so it is sent only once that rebuild has painted. A tool landing
  // DURING the rebuild is the next test's case.
  await expect(page.locator('.fl-conv-feed > [data-e2e-stale]')).toHaveCount(0, { timeout: 15_000 })
  await expect(page.getByText('discover gadgets', { exact: true })).toBeVisible()

  // The background agent it left running reports a tool — no `done` will follow.
  const now = new Date().toISOString()
  const call = {
    id: 'bg-tool-1',
    threadId: thread.id,
    messageId: null,
    toolName: 'Read',
    inputJson: JSON.stringify({ file_path: '/tmp/x.ts' }),
    outputJson: null,
    status: 'running',
    startedAt: now,
    completedAt: null,
  }
  await toRenderer(app, 'threads:stream', { kind: 'tool-start', threadId: thread.id, toolCall: call })
  await toRenderer(app, 'threads:stream', {
    kind: 'tool-end',
    threadId: thread.id,
    toolCall: { ...call, status: 'success', outputJson: '"ok"', completedAt: new Date().toISOString() },
  })
  // POSITIVE FIRST (allowed-pattern #28): the stray event reached the pane —
  // its tool card is in the feed, at feed level (the turn is over, so it
  // starts no live work row) …
  await expect(page.locator('.fl-conv-feed > .fl-conv-entry-tool[data-tool-id="bg-tool-1"]')).toBeAttached({ timeout: 10_000 })
  // … and nothing pulses "Working" for a turn that has ended.
  await expect(page.locator('.fl-request-row').filter({ hasText: 'Working' })).toHaveCount(0)

  // A doc lands now: its card mounts without waiting for another turn.
  const path = 'flow/discovery/discovery_gadgets_v1.md'
  writeFileSync(join(root, path), '# Discovery: Gadgets\n\nGadgets mount.\n')
  await toRenderer(app, 'flow:artifactChanged', { rootId: root, kind: 'discovery', path, name: 'discovery_gadgets_v1.md', mtime: Date.now() })
  const cards = page.locator('.fl-artifact-card').filter({ hasText: 'Gadgets' })
  await expect(cards).toHaveCount(1, { timeout: 15_000 })
  await expect(cards.first()).toBeVisible()
  await page.waitForTimeout(1_000)
  await expect(cards).toHaveCount(1)
})

/**
 * A STRAY TOOL DURING `done`'S REBUILD DOES NOT REOPEN THE ENDED TURN
 * (2026-10-17). `done` starts a reconcile that rebuilds the feed from stored
 * rows. A background agent's tool landing while it was in flight set the
 * loader's `#busy`, and the rebuild read THAT as "the last turn is still
 * running": the ended request came back as a live row pulsing "Working", with
 * no `done` left to stop it. Found as an order-dependent failure of the test
 * above — a busy suite made the rebuild slow enough to overlap the tool.
 * The rebuild is held open here so the overlap is certain, not a race.
 */
test('a background agent’s tool landing during the turn’s rebuild does not reopen the ended turn', async ({ app, window: page }) => {
  test.setTimeout(300_000)
  const root = await seedProject(page, 'flow-ux-whole-card-rebuild-')
  await activateProject(page, root)

  const thread = await api<{ id: string }>(page, 'threads.create', { projectRoot: root, title: 'Rebuild race thread' })
  await api(page, 'messages.append', { threadId: thread.id, role: 'user', content: 'discover sprockets' })
  await page.getByText('Rebuild race thread', { exact: true }).first().click()
  await expect(page.getByText('discover sprockets', { exact: true })).toBeVisible()
  await expect(page.locator(sel.composer)).toBeVisible()

  // Hold the rebuild's tool-call read in MAIN until released — the paint waits
  // on it. `window.flow` is a frozen contextBridge object, so the hold cannot
  // live in the page.
  await app.evaluate(({ ipcMain }) => {
    type Handler = (event: unknown, request: unknown) => unknown
    const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, Handler> })._invokeHandlers
    const original = handlers.get('toolCalls:list')
    if (original === undefined) throw new Error('there is no toolCalls:list handler to wrap')
    const gate = globalThis as unknown as { __e2eRebuild?: { original: Handler; held: number; release: () => void } }
    let release = (): void => undefined
    const released = new Promise<void>((resolve) => { release = resolve })
    gate.__e2eRebuild = { original, held: 0, release }
    ipcMain.removeHandler('toolCalls:list')
    ipcMain.handle('toolCalls:list', async (event, request: unknown) => {
      gate.__e2eRebuild!.held += 1
      await released
      return original(event, request)
    })
  })
  const heldReads = (): Promise<number> =>
    app.evaluate(() => (globalThis as unknown as { __e2eRebuild?: { held: number } }).__e2eRebuild?.held ?? 0)

  try {
    await toRenderer(app, 'threads:stream', { kind: 'status', threadId: thread.id, status: 'working' })
    await markFeedStale(page)
    await toRenderer(app, 'threads:stream', { kind: 'status', threadId: thread.id, status: 'done' })
    await toRenderer(app, 'threads:stream', { kind: 'done', threadId: thread.id, messageId: 'none' })
    // POSITIVE FIRST (allowed-pattern #28): the rebuild IS in flight, held.
    await expect.poll(heldReads, { timeout: 10_000 }).toBeGreaterThan(0)

    // The background agent's tool lands now, mid-rebuild.
    const now = new Date().toISOString()
    const call = {
      id: 'bg-tool-rebuild',
      threadId: thread.id,
      messageId: null,
      toolName: 'Read',
      inputJson: JSON.stringify({ file_path: '/tmp/y.ts' }),
      outputJson: null,
      status: 'running',
      startedAt: now,
      completedAt: null,
    }
    await toRenderer(app, 'threads:stream', { kind: 'tool-start', threadId: thread.id, toolCall: call })
    await toRenderer(app, 'threads:stream', {
      kind: 'tool-end',
      threadId: thread.id,
      toolCall: { ...call, status: 'success', outputJson: '"ok"', completedAt: new Date().toISOString() },
    })
  } finally {
    await app.evaluate(({ ipcMain }) => {
      const gate = globalThis as unknown as { __e2eRebuild?: { original: (e: unknown, r: unknown) => unknown; release: () => void } }
      const held = gate.__e2eRebuild
      if (held === undefined) return
      held.release()
      ipcMain.removeHandler('toolCalls:list')
      ipcMain.handle('toolCalls:list', (event, request: unknown) => held.original(event, request))
      delete gate.__e2eRebuild
    })
  }

  // The rebuild painted: its wipe took the sentinel.
  await expect(page.locator('.fl-conv-feed > [data-e2e-stale]')).toHaveCount(0, { timeout: 15_000 })
  await expect(page.getByText('discover sprockets', { exact: true })).toBeVisible()
  // …and the turn that ended stays ended.
  await page.waitForTimeout(1_000)
  await expect(page.locator('.fl-request-row').filter({ hasText: 'Working' })).toHaveCount(0)
})
