/**
 * A DOC WRITTEN INTO AN ATTACHED PROJECT STILL GETS ITS CARD (user, 2026-10-09:
 * "the file was generated but the component is not there anymore").
 *
 * A thread started in one project attached a sibling and wrote its discovery
 * THERE. Main attributed docs only to threads whose OWN project held them, and
 * the pane dropped every doc event outside the active project — so the card
 * never appeared, live or after a reload. Now main attributes the doc to the
 * writer thread (any of its projects), stamps the marker with the doc's root
 * (`[artifact] discovery <path> @<root>`) and names the thread on the event.
 *
 * The doc event is sent from MAIN (`flow:artifactChanged`) and the marker row
 * is appended in the shape the real sink writes (that sink, over a real store,
 * is covered in thread-store.test.ts) — the file watcher is unreliable for
 * seeded temp projects on macOS.
 *
 * Always run hidden: FLOW_E2E=1 FLOW_E2E_BACKGROUND=1.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import type { ElectronApplication, Page } from '@playwright/test'

import { expect, test } from '../fixtures/electron'
import { sel } from '../selectors'
import { activateProject, cleanupSeeds, seedProject } from './fixtures/seed'

const DISCOVERY = 'flow/discovery/discovery_sibling_widgets_v1.md'

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

test('a discovery the agent wrote into a project attached to the thread shows its card, and keeps it across a thread switch', async ({
  app,
  window: page,
}) => {
  test.setTimeout(300_000)
  const home = await seedProject(page, 'flow-ux-attached-home-', (dir) => {
    mkdirSync(join(dir, 'flow', 'discovery'), { recursive: true })
  })
  const sibling = await seedProject(page, 'flow-ux-attached-sibling-', (dir) => {
    mkdirSync(join(dir, 'flow', 'discovery'), { recursive: true })
  })
  await activateProject(page, home)

  const thread = await api<{ id: string }>(page, 'threads.create', { projectRoot: home, title: 'Attached doc thread' })
  await api(page, 'threads.setRoots', { threadId: thread.id, roots: [sibling] })
  const other = await api<{ id: string }>(page, 'threads.create', { projectRoot: home, title: 'Some other thread' })
  await api(page, 'messages.append', { threadId: other.id, role: 'user', content: 'unrelated question' })
  await api(page, 'messages.append', { threadId: thread.id, role: 'user', content: 'discover sibling widgets' })
  await page.getByText('Attached doc thread', { exact: true }).first().click()
  await expect(page.getByText('discover sibling widgets', { exact: true })).toBeVisible()
  await expect(page.locator(sel.composer)).toBeVisible()

  await toRenderer(app, 'threads:stream', { kind: 'status', threadId: thread.id, status: 'working' })

  // The agent writes the discovery into the ATTACHED project. Only there: the
  // home project has no such file, so a card titled from its heading proves
  // the pane read the doc from the sibling.
  writeFileSync(join(sibling, DISCOVERY), '# Discovery: Sibling Widgets\n\nWidgets live next door.\n')
  // What main does on the watcher's event: the marker row (with the doc's
  // root, as the sink writes it), then the broadcast naming the thread.
  await api(page, 'messages.append', {
    threadId: thread.id,
    role: 'system',
    content: `[artifact] discovery ${DISCOVERY} @${sibling}`,
  })
  await toRenderer(app, 'flow:artifactChanged', {
    rootId: sibling,
    kind: 'discovery',
    path: DISCOVERY,
    name: 'discovery_sibling_widgets_v1.md',
    mtime: Date.now(),
    threadId: thread.id,
  })

  // The turn ends: the reconcile mounts the card, once, read from the sibling.
  await toRenderer(app, 'threads:stream', { kind: 'done', threadId: thread.id, messageId: 'none' })
  const cards = page.locator('.fl-artifact-card').filter({ hasText: 'Sibling Widgets' })
  await expect(cards).toHaveCount(1, { timeout: 30_000 })
  await expect(cards.first()).toBeVisible()

  // A thread switch and back rebuilds the feed from history: the marker row
  // alone brings the card back, still read from the attached project.
  await page.getByText('Some other thread', { exact: true }).first().click()
  await expect(page.getByText('unrelated question', { exact: true })).toBeVisible()
  await expect(cards).toHaveCount(0)
  await page.getByText('Attached doc thread', { exact: true }).first().click()
  await expect(page.getByText('discover sibling widgets', { exact: true })).toBeVisible()
  await expect(cards).toHaveCount(1, { timeout: 30_000 })
  await expect(cards.first()).toBeVisible()
})

test("the live event alone mounts the card in the doc's own thread — and never in another thread", async ({ app, window: page }) => {
  test.setTimeout(300_000)
  const home = await seedProject(page, 'flow-ux-attached-live-home-')
  const sibling = await seedProject(page, 'flow-ux-attached-live-sibling-', (dir) => {
    mkdirSync(join(dir, 'flow', 'discovery'), { recursive: true })
  })
  await activateProject(page, home)

  const thread = await api<{ id: string }>(page, 'threads.create', { projectRoot: home, title: 'Live attached thread' })
  await api(page, 'threads.setRoots', { threadId: thread.id, roots: [sibling] })
  await api(page, 'messages.append', { threadId: thread.id, role: 'user', content: 'discover live widgets' })
  await page.getByText('Live attached thread', { exact: true }).first().click()
  await expect(page.getByText('discover live widgets', { exact: true })).toBeVisible()

  const path = 'flow/discovery/discovery_live_widgets_v1.md'
  writeFileSync(join(sibling, path), '# Discovery: Live Widgets\n\nNext door, live.\n')
  const event = { rootId: sibling, kind: 'discovery', path, name: 'discovery_live_widgets_v1.md', mtime: Date.now() }
  const cards = page.locator('.fl-artifact-card').filter({ hasText: 'Live Widgets' })

  // Another thread's doc in a project that is not the active one: not ours.
  await toRenderer(app, 'threads:stream', { kind: 'status', threadId: thread.id, status: 'working' })
  await toRenderer(app, 'flow:artifactChanged', { ...event, threadId: 'some-other-thread' })
  await toRenderer(app, 'threads:stream', { kind: 'done', threadId: thread.id, messageId: 'none' })
  await expect(page.getByText('discover live widgets', { exact: true })).toBeVisible()
  await page.waitForTimeout(2_000)
  await expect(cards).toHaveCount(0)

  // The same doc, attributed to THIS thread: the card mounts once the turn ends.
  await toRenderer(app, 'threads:stream', { kind: 'status', threadId: thread.id, status: 'working' })
  await toRenderer(app, 'flow:artifactChanged', { ...event, mtime: event.mtime + 1, threadId: thread.id })
  await toRenderer(app, 'threads:stream', { kind: 'done', threadId: thread.id, messageId: 'none' })
  await expect(cards).toHaveCount(1, { timeout: 30_000 })
  await expect(cards.first()).toBeVisible()
})
