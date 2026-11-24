import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import type { ElectronApplication, Page } from '@playwright/test'

import { test, expect } from '../fixtures/electron'
import { activateProject, cleanupSeeds, seedProject } from '../ux/fixtures/seed'

/**
 * The chat's canvas card, in the real app. A request whose tools wrote a UI
 * drafts canvas (asked for in a person's own words, not from a discovery card)
 * shows a card under its work row with the canvas's name, its screens and an
 * Open canvas button; the turn that ends on screen opens the canvas in the
 * browser by itself, once; an old request does not.
 *
 * The conversation is seeded into the store with the sqlite3 CLI, as
 * chat-request-fold does; the canvas is real files in a temp project.
 */

test.afterAll(() => cleanupSeeds())

const CANVAS = 'desks-naming'
const NAME = 'Desks in the sidebar: naming options'

function seedCanvas(root: string): void {
  const dir = join(root, 'flow', 'drafts', CANVAS)
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'layout.json'),
    JSON.stringify({
      name: NAME,
      tokenSources: [],
      screens: [
        { id: 'a', title: 'Option A', order: 1, frame: { x: 0, y: 0, w: 390, h: 500 } },
        { id: 'b', title: 'Option B', order: 2, frame: { x: 470, y: 0, w: 390, h: 500 } },
      ],
    }),
  )
  writeFileSync(join(dir, 'tokens.css'), 'body { margin: 0; }\n')
  writeFileSync(join(dir, 'a.html'), '<!doctype html><h1>Option A</h1>')
  writeFileSync(join(dir, 'b.html'), '<!doctype html><h1>Option B</h1>')
}

async function toRenderer(app: ElectronApplication, channel: string, payload: unknown): Promise<void> {
  await app.evaluate(
    ({ BrowserWindow }, { channel, payload }) => {
      for (const w of BrowserWindow.getAllWindows()) w.webContents.send(channel, payload)
    },
    { channel, payload },
  )
}

const pageTabs = (window: Page) => window.locator('button.tab[data-id^="flow://browser/"]')
const address = (window: Page) => window.locator('.fl-browser-chrome input[aria-label="Address"]')

test('a canvas the agent wrote gets a card, opens by itself when its turn ends, and opens again from the card', async ({
  app,
  window,
  userDataDir,
}) => {
  test.setTimeout(150_000)
  const root = await seedProject(window, 'flow-e2e-canvas-card-', seedCanvas)
  await activateProject(window, root)
  const threadId: string = await window.evaluate(async (r) => {
    const t = await (window as unknown as { flow: { threads: { create: (o: unknown) => Promise<{ id: string }> } } }).flow.threads.create({
      projectRoot: r,
      title: 'Canvas card',
    })
    return t.id
  }, root)
  await window.waitForTimeout(1200)

  const layout = join(root, 'flow', 'drafts', CANVAS, 'layout.json')
  const t0 = Date.parse('2026-11-20T12:00:00.000Z')
  const iso = (seconds: number): string => new Date(t0 + seconds * 1000).toISOString()
  const q = (v: string): string => `'${v.replace(/'/g, "''")}'`
  const message = (id: string, role: string, content: string, at: number, endsTurn = 0): string =>
    `INSERT INTO messages (id,thread_id,role,content,created_at,model,ends_turn) VALUES (${q(id)},${q(threadId)},${q(role)},${q(content)},${q(iso(at))},${role === 'assistant' ? q('claude-opus-5-5') : 'NULL'},${endsTurn});`
  const write = (id: string, messageId: string, path: string, at: number): string =>
    `INSERT INTO tool_calls (id,thread_id,message_id,tool_name,input_json,output_json,status,started_at,completed_at) VALUES (${q(id)},${q(threadId)},${q(messageId)},'Write',${q(JSON.stringify({ file_path: path, content: '{}' }))},${q(JSON.stringify(`File created successfully at: ${path}`))},'success',${q(iso(at))},${q(iso(at + 1))});`
  execFileSync('sqlite3', [join(userDataDir, 'flow.db')], {
    input: [
      message('u1', 'user', 'lets create some mocks UI for the desks heading', 0),
      message('s1', 'assistant', 'Writing the canvas.', 10),
      write('w1', 's1', layout, 11),
      message('a1', 'assistant', `The canvas "${NAME}" is ready.`, 60, 1),
    ].join('\n'),
  })

  const thread = window.getByText('Canvas card', { exact: true }).first()
  await thread.waitFor({ timeout: 20_000 })
  await thread.click()

  // ── The card: the canvas's name, its screens, and the button ─────────────
  const card = window.locator('.fl-canvas-card')
  await expect(card).toHaveCount(1, { timeout: 20_000 })
  await expect(card.locator('.fl-canvas-card-title')).toHaveText(NAME, { timeout: 15_000 })
  await expect(card.locator('.fl-canvas-card-detail')).toHaveText('Canvas · 2 screens')
  // Under the work row, inside the request.
  await expect(window.locator('.fl-conv-entry-request .fl-canvas-card')).toHaveCount(1)
  // The card stands for its files: none of them is listed again.
  await expect(window.locator('.fl-conv-entry-request .fl-file-change-list')).toHaveCount(0)

  // ── An old request does not open anything by itself ──────────────────────
  // (the positive first: the card IS drawn, so no page is evidence)
  await window.waitForTimeout(1000)
  await expect(pageTabs(window)).toHaveCount(0)

  // ── The turn that ends on screen opens its canvas, once ──────────────────
  await toRenderer(app, 'threads:stream', { kind: 'done', threadId, messageId: 'a1' })
  await expect(pageTabs(window)).toHaveCount(1, { timeout: 20_000 })
  await expect(address(window)).toHaveValue(new RegExp(`${CANVAS}`), { timeout: 15_000 })

  // Close the page; another rebuild of the same request does not reopen it.
  await pageTabs(window).first().locator('.close').click()
  await expect(pageTabs(window)).toHaveCount(0)
  await toRenderer(app, 'threads:stream', { kind: 'done', threadId, messageId: 'a1' })
  await window.waitForTimeout(2500)
  await expect(card).toHaveCount(1)
  await expect(pageTabs(window)).toHaveCount(0)

  // ── The button brings it back ────────────────────────────────────────────
  await card.locator('fl-button[data-action="open-canvas"]').click()
  await expect(pageTabs(window)).toHaveCount(1, { timeout: 20_000 })
  await expect(address(window)).toHaveValue(new RegExp(`${CANVAS}`), { timeout: 15_000 })
  if (process.env['FLOW_E2E_SHOTS']) await card.screenshot({ path: `${process.env['FLOW_E2E_SHOTS']}/canvas-card.png` })
})

/**
 * While a request runs, its work row is the "still working" signal, so it sits
 * under the canvas and the files written so far (user, 2026-11-24: "the loading
 * status should be always the last message"). When the turn rests, the row
 * moves back above them: "Worked …" heads what the request produced.
 */
test('the live work row stays under the canvas and files, and returns on top when the turn rests', async ({
  app,
  window,
}) => {
  test.setTimeout(120_000)
  const root = await seedProject(window, 'flow-e2e-canvas-live-', seedCanvas)
  await activateProject(window, root)
  const threadId: string = await window.evaluate(async (r) => {
    const t = await (window as unknown as { flow: { threads: { create: (o: unknown) => Promise<{ id: string }> } } }).flow.threads.create({
      projectRoot: r,
      title: 'Canvas live',
    })
    return t.id
  }, root)
  const thread = window.getByText('Canvas live', { exact: true }).first()
  await thread.waitFor({ timeout: 20_000 })
  await thread.click()
  await window.waitForTimeout(1500)

  // Two canvas files and one ordinary source file: only the last is listed.
  const files = [...['layout.json', 'a.html'].map((name) => join(root, 'flow', 'drafts', CANVAS, name)), join(root, 'src', 'index.ts')]
  await toRenderer(app, 'threads:stream', { kind: 'status', threadId, status: 'working' })
  await toRenderer(app, 'threads:stream', { kind: 'message-start', threadId, messageId: 'm1' })
  for (const [i, path] of files.entries()) {
    const toolCall = {
      id: `w${String(i)}`,
      threadId,
      messageId: 'm1',
      toolName: 'Write',
      inputJson: JSON.stringify({ file_path: path, content: '{}' }),
      outputJson: null,
      status: 'running',
      startedAt: new Date().toISOString(),
      completedAt: null,
    }
    await toRenderer(app, 'threads:stream', { kind: 'tool-start', threadId, toolCall })
    await toRenderer(app, 'threads:stream', {
      kind: 'tool-end',
      threadId,
      toolCall: { ...toolCall, status: 'success', outputJson: JSON.stringify('ok'), completedAt: new Date().toISOString() },
    })
  }

  const request = window.locator('.fl-conv-entry-request').last()
  // The positive first: the canvas card and the live row are both drawn.
  await expect(request.locator('.fl-canvas-card')).toHaveCount(1, { timeout: 15_000 })
  const order = (): Promise<string[]> =>
    request.evaluate((el) => [...el.children].map((child) => (child.classList.contains('fl-canvas-card') ? 'canvas' : child.classList.contains('fl-request-row') ? 'row' : 'other')))
  await expect.poll(async () => (await order()).at(-1), { timeout: 10_000 }).toBe('row')
  const live = await order()
  expect(live.indexOf('canvas')).toBeLessThan(live.length - 1)
  // The canvas card stands for its files: only the source file gets a card.
  const liveCards = request.locator('.fl-file-change-live > .fl-file-change-card')
  await expect(liveCards).toHaveCount(1)
  await expect(liveCards.first()).toContainText('index.ts')

  await toRenderer(app, 'threads:stream', { kind: 'done', threadId, messageId: 'm1' })
  await expect.poll(async () => (await order())[0], { timeout: 10_000 }).toBe('row')
})
