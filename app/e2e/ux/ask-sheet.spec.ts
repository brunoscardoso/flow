/**
 * ASK THE BLUEPRINT AS A CENTERED SHEET (option B, 2026-11-16).
 *
 * One seeded git repo with two features on disk, drawn by the real board. The
 * stand-ins are the Ask channels, replaced in MAIN with `ipcMain.handle`
 * (`window.flow` is a contextBridge proxy; assigning there is dropped):
 * `ask:list` answers a fixed saved list, `ask:stale` says nothing changed, and
 * `ask:start` records the question and returns an id — the answer then
 * arrives as `ask:state` events sent from main, exactly as the real
 * orchestrator sends them. No model is reached.
 *
 * Asserted: the island field opens the sheet centred over a dim layer that
 * covers the board; Esc and a press on the dim close it and focus goes back
 * to the field; compose shows Try asking and Your recent questions; an old
 * prose answer still reads as a list; the working state is one status row
 * with Show steps; the answer renders its lead, sections, lists, code / file
 * / feature chips, citations, the Not covered callout, the folded reply and
 * the facts line; a feature chip closes the sheet and opens the feature; the
 * cell marker counts the questions and opens them.
 *
 * Screenshots: __screens/ask-sheet-{marker,compose,working,answer-dark,answer-light}.png
 *
 * Always run hidden: FLOW_E2E=1 FLOW_E2E_BACKGROUND=1.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import type { Page } from '@playwright/test'

import { expect, test } from '../fixtures/electron'
import { activateProject, cleanupSeeds, seedProject } from './fixtures/seed'
import { enterProject, whereName } from './fixtures/territory'

test.afterAll(() => cleanupSeeds())

const SHOTS = join(__dirname, '__screens')

function lines(prefix: string, n: number): string {
  return Array.from({ length: n }, (_, i) => `export const ${prefix}${String(i)} = ${String(i)}`).join('\n') + '\n'
}

function featureNote(slug: string, name: string, text: string, anchors: string): string {
  return ['---', `id: feature:${slug}`, `name: ${name}`, 'kind: core', `anchors: [${anchors}]`, 'relates: []', 'lastFullRead: null', 'patchCount: 0', '---', '', `# ${name}`, '', text, ''].join('\n')
}

function seed(dir: string): void {
  mkdirSync(join(dir, 'src', 'tenant'), { recursive: true })
  writeFileSync(join(dir, 'src', 'tenant', 'create-tenant.ts'), lines('tenantStep', 160))
  mkdirSync(join(dir, 'src', 'auth'), { recursive: true })
  writeFileSync(join(dir, 'src', 'auth', 'index.ts'), lines('auth', 90))
  const features = join(dir, 'flow', 'brain', 'features')
  mkdirSync(features, { recursive: true })
  writeFileSync(join(features, 'tenant.md'), featureNote('tenant', 'Tenant', 'Creates and stores tenants.', 'module:src/tenant'))
  writeFileSync(join(features, 'auth.md'), featureNote('auth', 'Auth', 'Signs people in.', 'module:src/auth'))
}

const OLD_PROSE = 'A tenant stores: - its alias - its display name - its logo'

function saved(id: string, ts: string, question: string, tags: string[], answer: string): Record<string, unknown> {
  return { id, ts, author: 'You', question, tags, conversationCount: 0, usedConversation: false, answer, sources: [], factsLearned: 0, partial: false, followUps: [] }
}

const SAVED = [
  saved('qa-1', new Date(Date.now() - 3_600_000).toISOString(), 'What does a tenant store?', ['feature:tenant'], OLD_PROSE),
  saved('qa-2', new Date(Date.now() - 86_400_000).toISOString(), 'Who can create a tenant?', ['feature:tenant'], 'Only an admin can.'),
  saved('qa-3', new Date(Date.now() - 2 * 86_400_000).toISOString(), 'How does sign-in work?', ['feature:auth'], 'With a session cookie.'),
]

const STRUCTURED = [
  'A tenant is created by one provisioning call in `feature:tenant`. [1]',
  '',
  '### What a tenant stores',
  '- `externalTenantId` and `alias`, both unique [2]',
  '- a display name and a logo',
  '',
  '### How a tenant is created',
  'The call runs `src/tenant/create-tenant.ts`, then signs the owner in through `feature:auth`. [2]',
  '',
  'Not covered: how the mobile app shows tenants.',
].join('\n')

const SOURCES = [
  { n: 1, label: 'Tenant', featureId: 'feature:tenant' },
  { n: 2, label: 'Creates the tenant', file: 'src/tenant/create-tenant.ts' },
]

/** Send one `ask:state` event from main, for the ask the stub started. */
async function sendState(app: import('@playwright/test').ElectronApplication, phase: unknown, answer: unknown): Promise<void> {
  await app.evaluate(({ BrowserWindow }, payload) => {
    const g = globalThis as unknown as { __askStarts: Array<{ rootId: string }> }
    const last = g.__askStarts[g.__askStarts.length - 1]
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send('ask:state', { askId: `ask-e2e-${String(g.__askStarts.length)}`, rootId: last.rootId, workspace: null, ...payload })
    }
  }, { phase, answer })
}

/** The app's own offers (a basic discovery) float over the board; set them aside. */
async function dismissOffers(page: Page): Promise<void> {
  for (let i = 0; i < 6; i += 1) {
    const card = page.locator('fl-card.fl-learn-card fl-button', { hasText: 'Not now' }).first()
    const notNow = page.getByRole('button', { name: 'Not now' }).first()
    if (await card.isVisible().catch(() => false)) await card.click().catch(() => undefined)
    else if (await notNow.isVisible().catch(() => false)) await notNow.click().catch(() => undefined)
    else break
    await page.waitForTimeout(150)
  }
}

async function shot(page: Page, name: string): Promise<void> {
  mkdirSync(SHOTS, { recursive: true })
  await page.waitForTimeout(250)
  await page.screenshot({ path: join(SHOTS, `ask-sheet-${name}.png`) })
}

test('Ask the Blueprint opens as a centered sheet: compose, working, a structured answer with chips and citations, and question markers on the map', async ({ app, window: page }) => {
  test.setTimeout(420_000)
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1280, 800))
  const root = await seedProject(page, 'flow-ux-asksheet-', seed, { onboarded: true })
  await activateProject(page, root)
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'))
  const terminal = page.locator('[data-view-action="terminal"]')
  if ((await terminal.getAttribute('aria-pressed')) === 'true') await terminal.click()

  // The Ask channels, answered in MAIN.
  await app.evaluate(({ ipcMain }, threads) => {
    const g = globalThis as unknown as { __askStarts: unknown[]; __askLists: unknown[] }
    g.__askStarts = []
    g.__askLists = []
    ipcMain.removeHandler('ask:list')
    ipcMain.handle('ask:list', (_event, request) => {
      g.__askLists.push(request)
      return { ok: true, threads }
    })
    ipcMain.removeHandler('ask:stale')
    ipcMain.handle('ask:stale', () => ({ ok: true, results: [] }))
    ipcMain.removeHandler('ask:start')
    ipcMain.handle('ask:start', (_event, request) => {
      g.__askStarts.push(request)
      return { ok: true, askId: `ask-e2e-${String(g.__askStarts.length)}` }
    })
    ipcMain.removeHandler('ask:stop')
    ipcMain.handle('ask:stop', () => ({ stopped: true }))
  }, SAVED)

  await page.locator('[data-view-action="blueprint"]').click()
  await expect(page.locator('.flow-board-root')).toBeVisible()
  for (let i = 0; i < 4; i += 1) {
    const notNow = page.getByRole('button', { name: 'Not now' }).first()
    if (!(await notNow.isVisible().catch(() => false))) break
    await notNow.click().catch(() => undefined)
  }
  const project = root.split('/').pop() ?? ''
  await enterProject(page, project)
  await page.waitForTimeout(1_500)
  await dismissOffers(page)

  // ── THE CELL MARKER: two questions about Tenant, one about Auth. ──
  const tenantCell = page.locator('.fb-terr-cell', { hasText: 'Tenant' }).first()
  const marker = tenantCell.locator('[data-ask="cell-questions"]')
  await expect(marker).toBeVisible({ timeout: 60_000 })
  await expect(marker).toHaveText('2')
  await expect(marker).toHaveAttribute('aria-label', '2 questions you asked about Tenant')
  await expect(marker.locator('fl-icon[name="message"]')).toHaveCount(1)
  await expect(page.locator('.fb-terr-cell', { hasText: 'Auth' }).first().locator('[data-ask="cell-questions"]')).toHaveText('1')
  // The saved list is read ONCE for the load, in one call.
  const allReads = await app.evaluate(() => (globalThis as unknown as { __askLists: Array<{ all?: boolean }> }).__askLists.filter((r) => r.all === true).length)
  expect(allReads).toBe(1)
  await dismissOffers(page)
  await tenantCell.hover()
  await shot(page, 'marker')

  const field = page.locator('.flow-board-root [data-ask="field"]')
  const fieldInput = field.locator('textarea')
  const dim = page.locator('.flow-board-root .fb-ask-dim')
  const sheet = dim.locator('.fb-ask')
  const sheetInput = sheet.locator('.fb-ask-input')

  // Pressing the marker opens the sheet on Tenant's questions.
  await dismissOffers(page)
  await marker.click()
  await expect(sheet).toBeVisible()
  await expect(sheet.locator('.fb-ask-history-title')).toHaveText('Your questions about Tenant')
  await expect(sheet.locator('.fb-ask-history .fb-ask-row')).toHaveCount(3) // the stub answers every read alike
  await page.keyboard.press('Escape')
  await expect(dim).toBeHidden()

  // ── COMPOSE: the field opens the sheet, centred over a dim covering the board. ──
  const fieldWidth = (await field.boundingBox())!.width
  await fieldInput.click()
  await expect(sheet).toBeVisible()
  await expect(sheetInput).toBeFocused()
  // The island field stays a small entry.
  expect(Math.abs((await field.boundingBox())!.width - fieldWidth)).toBeLessThanOrEqual(1)
  const board = (await page.locator('.flow-board-root').boundingBox())!
  const dimBox = (await dim.boundingBox())!
  expect(Math.abs(dimBox.width - board.width)).toBeLessThanOrEqual(1)
  expect(Math.abs(dimBox.height - board.height)).toBeLessThanOrEqual(1)
  const sheetBox = (await sheet.boundingBox())!
  expect(Math.abs(sheetBox.x + sheetBox.width / 2 - (board.x + board.width / 2))).toBeLessThanOrEqual(2)
  expect(sheetBox.width).toBeLessThanOrEqual(760.5)
  expect(sheetBox.width).toBeGreaterThan(Math.min(700, board.width - 60))
  expect(await dim.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe('rgba(6, 10, 14, 0.55)')
  await expect(sheet.locator('.fb-ask-big')).toHaveCSS('height', '44px')
  await expect(sheetInput).toHaveAttribute('placeholder', 'What do you want to know?')
  await expect(sheet.locator('.fb-ask-scope-label')).toHaveText('Asking about')
  await expect(sheet.locator('[data-ask="try"] .fb-ask-row')).toHaveCount(3)
  await expect(sheet.locator('[data-ask="recent"] .fb-ask-row')).toHaveCount(3)
  await expect(sheet.locator('[data-ask="recent"] .fb-ask-row').first()).toContainText('What does a tenant store?')
  await expect(sheet.locator('.fb-ask-hints').first()).toContainText('Only you see your questions')
  await shot(page, 'compose')

  // Esc closes; focus goes back to the island field without reopening.
  await page.keyboard.press('Escape')
  await expect(dim).toBeHidden()
  await expect(fieldInput).toBeFocused()
  await page.waitForTimeout(200)
  await expect(dim).toBeHidden()
  // A press on the dim (not the sheet) closes too.
  await fieldInput.click()
  await expect(sheet).toBeVisible()
  await dim.click({ position: { x: 8, y: dimBox.height - 8 } })
  await expect(dim).toBeHidden()
  await expect(fieldInput).toBeFocused()

  // ── AN OLD PROSE ANSWER still reads: its " - a - b - c" run is a list. ──
  await fieldInput.click()
  await sheet.locator('[data-ask="recent"] .fb-ask-row').first().click()
  await expect(sheet.locator('.fb-ask-qtitle')).toHaveText('What does a tenant store?')
  await expect(sheet.locator('.fb-ask-doc .fb-ask-ul li')).toHaveText(['its alias', 'its display name', 'its logo'])
  await sheet.getByRole('button', { name: 'New question' }).click()

  // ── WORKING: one status row, Show steps, and the draft in the final layout. ──
  await sheetInput.fill('How is a tenant created?')
  await sheetInput.press('Enter')
  await expect.poll(async () => app.evaluate(() => (globalThis as unknown as { __askStarts: unknown[] }).__askStarts.length)).toBe(1)
  await expect(sheet.locator('.fb-ask-qtitle')).toHaveText('How is a tenant created?')
  await sendState(
    app,
    { kind: 'digging', steps: [{ label: 'Read what Flow knows about Tenant', state: 'done' }, { label: 'Reading the tenant code', state: 'current' }], reads: 3, elapsedMs: 17_000 },
    { explanation: 'A tenant is created by a provisioning call. [1]', confidence: 'first', thin: false, sources: SOURCES.slice(0, 1), factsLearned: 0, factsSaved: true, partial: false },
  )
  const status = sheet.locator('[data-ask="status"]')
  await expect(status).toContainText(/Reading the code · 3 files · \d+ s/)
  await expect(status.locator('.fb-ask-spin')).toHaveCount(1)
  await expect(sheet.getByRole('button', { name: 'Stop' })).toBeVisible()
  await expect(sheet.locator('.fb-ask-doc')).toContainText('A tenant is created by a provisioning call.')
  await expect(sheet.locator('[data-ask="steps"]')).toHaveCount(0)
  await sheet.getByRole('button', { name: 'Show steps' }).click()
  await expect(sheet.locator('[data-ask="steps"] .fb-ask-step')).toHaveCount(2)
  await shot(page, 'working')

  // ── THE ANSWER: structured markdown rendered as DOM. ──
  await sendState(app, { kind: 'done' }, {
    explanation: STRUCTURED,
    confidence: 'checked',
    thin: false,
    sources: SOURCES,
    reply: 'A tenant is made by one provisioning call; it stores a unique alias and id.',
    factsLearned: 2,
    factsSaved: true,
    savedId: 'qa-new',
    partial: false,
  })
  await expect(status).toContainText('Checked against the code')
  await expect(sheet.locator('[data-ask="steps"]')).toHaveCount(1) // still open — the reader opened it
  await sheet.getByRole('button', { name: 'Hide steps' }).click()
  const doc = sheet.locator('.fb-ask-turn').last().locator('.fb-ask-doc')
  await expect(doc.locator('.fb-ask-lead')).toContainText('A tenant is created by one provisioning call in')
  await expect(doc.locator('h4.fb-ask-h')).toHaveText(['What a tenant stores', 'How a tenant is created'])
  await expect(doc.locator('.fb-ask-ul li')).toHaveCount(2)
  await expect(doc.locator('code.fb-ask-code')).toHaveText(['externalTenantId', 'alias'])
  await expect(doc.locator('[data-ask="feature"]')).toHaveText(['Tenant', 'Auth'])
  await expect(doc.locator('[data-ask="file"]')).toHaveText(['src/tenant/create-tenant.ts'])
  await expect(doc.locator('[data-ask="cite"]')).toHaveText(['1', '2', '2'])
  // Model text never became markup: no element the parser did not build.
  expect(await doc.locator('script, img, a').count()).toBe(0)
  await expect(sheet.locator('.fb-ask-gap')).toContainText('Not covered: how the mobile app shows tenants.')
  await expect(sheet.locator('[data-ask="sources"] [data-source-n]')).toHaveCount(2)
  const reply = sheet.locator('[data-ask="reply"]')
  await expect(reply.locator('.fb-ask-reply-text')).toHaveCount(0)
  await reply.getByRole('button', { name: 'Show' }).click()
  await expect(reply.locator('.fb-ask-reply-text')).toContainText('one provisioning call')
  await reply.getByRole('button', { name: 'Hide' }).click()
  await expect(sheet.locator('[data-ask="learned"]')).toHaveText('2 facts added to Tenant’s knowledge, shared with the team')
  await expect(sheet.locator('.fb-ask-follow')).toBeEnabled()
  await expect(sheet.getByRole('button', { name: 'Continue in a conversation' })).toBeEnabled()
  // A citation scrolls to its source.
  await doc.locator('[data-ask="cite"]').nth(1).click()
  await expect(sheet.locator('[data-ask="sources"] [data-source-n="2"]')).toBeFocused()
  // The saved answer makes the board read its list again (once).
  await expect
    .poll(async () => app.evaluate(() => (globalThis as unknown as { __askLists: Array<{ all?: boolean }> }).__askLists.filter((r) => r.all === true).length))
    .toBe(2)
  await sheet.locator('.fb-ask-body').evaluate((el) => el.scrollTo(0, 0))
  await shot(page, 'answer-dark')
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'))
  await expect.poll(async () => sheet.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe('rgb(255, 255, 255)')
  await shot(page, 'answer-light')
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'))

  // A file chip opens the file in the editor (the app's own open-file door).
  await page.evaluate(() => {
    const w = window as unknown as { __opened: unknown[] }
    w.__opened = []
    document.addEventListener('flow:open-file', (event) => w.__opened.push((event as CustomEvent).detail))
  })
  await doc.locator('[data-ask="file"]').click()
  await expect(dim).toBeHidden()
  const opened = await page.evaluate(() => (window as unknown as { __opened: Array<{ rootPath: string; relPath: string }> }).__opened)
  expect(opened).toHaveLength(1)
  expect(opened[0].relPath).toBe('src/tenant/create-tenant.ts')
  expect(opened[0].rootPath).toBe(root)

  // ── A FEATURE CHIP closes the sheet and opens that feature on the board. ──
  await page.locator('[data-view-action="blueprint"]').click().catch(() => undefined)
  await expect(page.locator('.flow-board-root')).toBeVisible()
  await expect(field).toBeVisible({ timeout: 30_000 })
  await field.locator('textarea').click()
  await expect(sheet.locator('.fb-ask-qtitle')).toHaveText('How is a tenant created?') // reopened where it was left
  await sheet.locator('.fb-ask-doc [data-ask="feature"]', { hasText: 'Tenant' }).first().click()
  await expect(dim).toBeHidden()
  await expect.poll(async () => whereName(page), { timeout: 30_000 }).toBe('Tenant')
})
