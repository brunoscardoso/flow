import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import type { ElectronApplication, Locator, Page } from '@playwright/test'

import { test, expect } from '../fixtures/electron'
import { activateProject, cleanupSeeds, seedProject } from '../ux/fixtures/seed'

/**
 * Connectors (plan_connectors, Phase 8) — the REAL path, end to end.
 *
 * The seeded project's shared connector list names a tiny stdio MCP stub (two
 * tools, a `data:` icon in its server info). The app runs with an EMPTY scratch
 * Claude config folder and a scratch home, so the status query, Add and Remove
 * all land in throwaway files — never the developer's own. No message is sent:
 * the bundled runtime answers a status query without any login.
 *
 * Covers: the composer chip's count and list; turning a connector off for one
 * chat (count follows, survives reopening); a connector call reads as
 * "action · Connector"; Settings → Connectors sections, a row's tools, Add a web
 * connector, Remove only after the confirmation.
 */

const REPO_ROOT = resolve(__dirname, '../../..')
const MCP_SDK = join(REPO_ROOT, 'node_modules/@modelcontextprotocol/sdk/dist/cjs')
const SHOTS = process.env['FLOW_CONNECTORS_SHOTS'] ?? join(tmpdir(), 'flow-connectors-shots')

/**
 * The scratch Claude config folder and home, made per test (a module-level
 * temp dir would be made once per process that loads this file, and only the
 * worker's would ever be removed).
 */
const connectorsTest = test.extend<{ scratch: { configDir: string; homeDir: string } }>({
  scratch: async ({}, use) => {
    const dir = mkdtempSync(join(tmpdir(), 'flow-e2e-connectors-'))
    const configDir = join(dir, 'claude-config')
    const homeDir = join(dir, 'home')
    mkdirSync(configDir, { recursive: true })
    mkdirSync(homeDir, { recursive: true })
    await use({ configDir, homeDir })
    rmSync(dir, { recursive: true, force: true })
  },
  appEnv: async ({ scratch }, use) => {
    await use({
      CLAUDE_CONFIG_DIR: scratch.configDir,
      HOME: scratch.homeDir,
      // No account can be reached: nothing here may ever run a real turn.
      ANTHROPIC_API_KEY: undefined,
      CLAUDE_CODE_OAUTH_TOKEN: undefined,
    })
  },
})

connectorsTest.afterAll(() => cleanupSeeds())

const STUB = `
const SDK = ${JSON.stringify(MCP_SDK)}
const { Server } = require(SDK + '/server/index.js')
const { StdioServerTransport } = require(SDK + '/server/stdio.js')
const { ListToolsRequestSchema, CallToolRequestSchema } = require(SDK + '/types.js')
const ICON = 'data:image/svg+xml;base64,' + Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16" rx="3" fill="#2a7"/></svg>').toString('base64')
const server = new Server(
  { name: 'flow-stub', title: 'Stub Notes', version: '1.0.0', icons: [{ src: ICON, mimeType: 'image/svg+xml' }] },
  { capabilities: { tools: {} } },
)
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    { name: 'search_notes', description: 'Search the notes', inputSchema: { type: 'object', properties: {} } },
    { name: 'save_note', description: 'Save a note', inputSchema: { type: 'object', properties: {} } },
  ],
}))
server.setRequestHandler(CallToolRequestSchema, async () => ({ content: [{ type: 'text', text: 'ok' }] }))
server.connect(new StdioServerTransport())
`

/** Assert an element is really on screen: laid out, not hidden by style, inside the viewport. */
async function expectOnScreen(locator: Locator): Promise<void> {
  await expect(locator).toBeVisible()
  const placed = await locator.evaluate((el) => {
    const rect = el.getBoundingClientRect()
    const style = getComputedStyle(el)
    return {
      rect: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height },
      viewport: { width: window.innerWidth, height: window.innerHeight },
      visibility: style.visibility,
      opacity: Number(style.opacity),
      display: style.display,
    }
  })
  expect(placed.display).not.toBe('none')
  expect(placed.visibility).toBe('visible')
  expect(placed.opacity).toBeGreaterThan(0)
  expect(placed.rect.width).toBeGreaterThan(0)
  expect(placed.rect.height).toBeGreaterThan(0)
  expect(placed.rect.left).toBeGreaterThanOrEqual(0)
  expect(placed.rect.top).toBeGreaterThanOrEqual(0)
  expect(placed.rect.right).toBeLessThanOrEqual(placed.viewport.width + 0.5)
  expect(placed.rect.bottom).toBeLessThanOrEqual(placed.viewport.height + 0.5)
}

async function openChat(window: Page, root: string, title: string): Promise<string> {
  const threadId = await window.evaluate(
    async ({ p, t }) => {
      const flow = (window as unknown as {
        flow: { threads: { create(r: { projectRoot: string; title: string }): Promise<{ id: string }> } }
      }).flow
      return (await flow.threads.create({ projectRoot: p, title: t })).id
    },
    { p: root, t: title },
  )
  await window.evaluate((id: string) => {
    document.dispatchEvent(new CustomEvent('flow:open-thread', { detail: { threadId: id } }))
  }, threadId)
  return threadId
}

async function emitStream(app: ElectronApplication, event: Record<string, unknown>): Promise<void> {
  await app.evaluate(({ BrowserWindow }, ev) => {
    BrowserWindow.getAllWindows()[0]?.webContents.send('threads:stream', ev)
  }, event)
}

function accountFile(configDir: string): Record<string, unknown> {
  const path = join(configDir, '.claude.json')
  return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>) : {}
}

function accountServers(configDir: string): string[] {
  return Object.keys((accountFile(configDir)['mcpServers'] ?? {}) as Record<string, unknown>)
}

connectorsTest('connectors: the chip, a chat switch, a labelled call, and Settings add and remove', async ({ window, app, scratch }) => {
  connectorsTest.setTimeout(240_000)
  mkdirSync(SHOTS, { recursive: true })
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  const root = await seedProject(
    window,
    'flow-e2e-connectors-proj-',
    (dir) => {
      writeFileSync(join(dir, 'stub-server.cjs'), STUB)
      writeFileSync(
        join(dir, '.mcp.json'),
        JSON.stringify({ mcpServers: { stubnotes: { command: 'node', args: [join(dir, 'stub-server.cjs')] } } }, null, 2) + '\n',
      )
    },
    { onboarded: true },
  )
  await activateProject(window, root)
  const threadId = await openChat(window, root, 'Connector Chat')

  // ── The composer chip: a count, and the list it opens ────────────────────
  const chip = window.locator('.fl-composer .fl-connector-chip')
  await expect(chip).toBeVisible({ timeout: 60_000 })
  await expect(chip.locator('.fl-connector-chip-label')).toHaveText('1 connector')
  await expectOnScreen(chip)

  await chip.click()
  const menu = window.locator('.fl-connector-menu')
  await expectOnScreen(menu)
  const row = menu.locator('.fl-connector-row', { hasText: 'Stub Notes' })
  await expect(row).toHaveCount(1)
  const toggle = row.locator('.fl-connector-switch')
  // The positive first (#28): it is on, and switchable, because the real
  // runtime reported it connected.
  await expect(toggle).toHaveAttribute('aria-checked', 'true', { timeout: 30_000 })
  await expect(toggle).toBeEnabled()
  await window.screenshot({ path: join(SHOTS, 'connectors-composer-popover.png') })

  // ── Off for this chat: the count follows and survives a reopen ───────────
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-checked', 'false')
  await expect(chip.locator('.fl-connector-chip-label')).toHaveText('Connectors')
  await window.keyboard.press('Escape')
  await expect(menu).toHaveCount(0)
  await chip.click()
  await expect(window.locator('.fl-connector-menu .fl-connector-row', { hasText: 'Stub Notes' }).locator('.fl-connector-switch')).toHaveAttribute(
    'aria-checked',
    'false',
  )
  await window.keyboard.press('Escape')
  // The chat's own answer, from main — the store, not the painted switch.
  const stored = await window.evaluate(
    async ({ p, t }) => {
      const flow = (window as unknown as {
        flow: { connectors: { list(r: { projectRoot: string; threadId?: string }): Promise<{ entries: Array<{ name: string; offInThread?: boolean; status: string }> }> } }
      }).flow
      const inChat = (await flow.connectors.list({ projectRoot: p, threadId: t })).entries.find((e) => e.name === 'stubnotes')
      const inProject = (await flow.connectors.list({ projectRoot: p })).entries.find((e) => e.name === 'stubnotes')
      return { inChat, inProject }
    },
    { p: root, t: threadId },
  )
  expect(stored.inChat).toMatchObject({ offInThread: true, status: 'off' })
  // Off here stays on elsewhere: the project's own answer still reports it connected.
  expect(stored.inProject?.status).toBe('connected')
  // The switch wrote only Flow's own per-chat record: Claude's files are unchanged.
  expect(JSON.parse(readFileSync(join(root, '.mcp.json'), 'utf8'))).toEqual({
    mcpServers: { stubnotes: { command: 'node', args: [join(root, 'stub-server.cjs')] } },
  })
  // …and turned back on, the count returns (other chats were never affected).
  await chip.click()
  await window.locator('.fl-connector-menu .fl-connector-row', { hasText: 'Stub Notes' }).locator('.fl-connector-switch').click()
  await expect(chip.locator('.fl-connector-chip-label')).toHaveText('1 connector')
  await window.keyboard.press('Escape')

  // ── A connector call reads as "action · Connector" ───────────────────────
  const startedAt = new Date(Date.now() - 1200).toISOString()
  const call = {
    id: 'conn-call-1',
    threadId,
    messageId: null,
    toolName: 'mcp__stubnotes__search_notes',
    inputJson: JSON.stringify({ query: 'release notes' }),
    outputJson: null,
    status: 'running',
    startedAt,
    completedAt: null,
  }
  await emitStream(app, { kind: 'tool-start', threadId, toolCall: call })
  await emitStream(app, {
    kind: 'tool-end',
    threadId,
    toolCall: { ...call, status: 'success', outputJson: JSON.stringify({ ok: true }), completedAt: new Date().toISOString() },
  })
  const card = window.locator('.fl-tool-card.fl-tool-connector').first()
  await expect(card).toBeVisible({ timeout: 15_000 })
  await expect(card.locator('.fl-tool-name')).toHaveText('Search notes')
  await expect(card.locator('.fl-tool-connector-name')).toHaveText('Stub Notes')
  await expect(card.locator('.fl-tool-line')).not.toContainText('mcp__')
  await expectOnScreen(card.locator('.fl-tool-line'))
  await card.screenshot({ path: join(SHOTS, 'connectors-tool-card.png') })

  // ── Settings → Connectors ────────────────────────────────────────────────
  await window.evaluate(() => {
    document.dispatchEvent(new CustomEvent('flow:open-settings', { detail: { group: 'connectors' } }))
  })
  const page = window.locator('.fl-cns')
  await expectOnScreen(page.locator('.fl-cns-title'))
  await expect(page.locator('.fl-cns-group-heading').first()).toBeVisible({ timeout: 60_000 })
  const stubRow = page.locator('[data-connector="stubnotes"]')
  await expect(stubRow).toHaveCount(1)
  await expect(stubRow.locator('.fl-cns-pill')).toHaveAttribute('data-tone', 'ok', { timeout: 30_000 })
  await stubRow.locator('.fl-cns-row').click()
  await expect(stubRow.locator('.fl-cns-tool-name')).toHaveText(['search_notes', 'save_note'])
  await expectOnScreen(stubRow.locator('.fl-cns-details'))
  await window.screenshot({ path: join(SHOTS, 'connectors-settings.png') })

  // Add a web connector to the account — the scratch config folder only.
  expect(accountServers(scratch.configDir)).not.toContain('webby')
  await page.locator('.fl-cns-head button', { hasText: 'Add connector' }).click()
  const form = page.locator('.fl-cns-form')
  await expectOnScreen(form)
  await form.locator('[data-field="name"]').fill('webby')
  await form.locator('[data-field="address"]').fill('https://mcp.example.com/mcp')
  await form.locator('[data-role="submit"]').click()
  const webRow = page.locator('[data-connector="webby"]')
  await expect(webRow).toHaveCount(1, { timeout: 60_000 })
  expect(accountServers(scratch.configDir)).toContain('webby')
  expect((accountFile(scratch.configDir)['mcpServers'] as Record<string, unknown>)['webby']).toEqual({
    type: 'http',
    url: 'https://mcp.example.com/mcp',
  })

  // Remove asks first; nothing is written until the confirmation.
  if ((await webRow.locator('.fl-cns-details').count()) === 0) await webRow.locator('.fl-cns-row').click()
  await webRow.locator('.fl-cns-details button', { hasText: 'Remove' }).click()
  const confirm = webRow.locator('.fl-cns-confirm')
  await expectOnScreen(confirm)
  await expect(confirm).toContainText('Remove')
  // The positive first: the entry is still in the file while the question is open.
  expect(accountServers(scratch.configDir)).toContain('webby')
  await confirm.locator('.fl-cns-btn--danger').click()
  await expect(webRow).toHaveCount(0, { timeout: 60_000 })
  expect(accountServers(scratch.configDir)).not.toContain('webby')
  // The project's own list was never touched by any of it.
  await expect(page.locator('[data-connector="stubnotes"]')).toHaveCount(1)

  expect(errors, 'page errors: ' + errors.join('; ')).toEqual([])
})
