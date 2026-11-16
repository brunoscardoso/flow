/**
 * ASK THE BLUEPRINT AT WORKSPACE LEVEL (plan ask_the_blueprint_workspace,
 * Phase 4) — the header field on the Workspace sheet.
 *
 * Real everywhere it can be: three seeded git repos with features on disk,
 * added through the real project path, the board drawing what the bundled CLI's
 * `blueprint workspace graph` returns. The only stand-ins are the two READ
 * channels of the saved-answers list (`ask:list`, `ask:stale`), replaced in
 * MAIN with `ipcMain.handle` — `window.flow` is a contextBridge proxy and an
 * assignment there is silently dropped. Nothing here asks a question, so no
 * model is ever reached.
 *
 * What is asserted is rendered geometry, never mere visibility: a popover can
 * be "visible" and entirely off screen ("visible is not on screen"). The @ list
 * is measured against the window it is in.
 *
 * Always run hidden: FLOW_E2E=1 FLOW_E2E_BACKGROUND=1.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import type { Locator, Page } from '@playwright/test'

import { expect, test } from '../fixtures/electron'
import { activateProject, cleanupSeeds, seedProject } from './fixtures/seed'

test.afterAll(() => cleanupSeeds())

const PROJECTS: Record<string, Array<[slug: string, name: string]>> = {
  core: [
    ['chat-engine', 'Chat Engine'],
    ['auth', 'Auth'],
    ['tenants', 'Tenants'],
    ['billing', 'Billing'],
    ['search', 'Search'],
  ],
  app: [
    ['chats', 'Chats'],
    ['sign-in', 'Sign In'],
    ['settings', 'Settings'],
  ],
  mobile: [
    ['login', 'Login'],
    ['chats', 'Chats'], // the SAME slug as the app's — the collision the plan calls out
  ],
}

function seedFeatures(dir: string, features: Array<[string, string]>): void {
  const featuresDir = join(dir, 'flow', 'brain', 'features')
  mkdirSync(featuresDir, { recursive: true })
  mkdirSync(join(dir, 'src'), { recursive: true })
  for (const [slug, name] of features) {
    writeFileSync(join(dir, 'src', `${slug}.ts`), Array.from({ length: 200 }, (_, n) => `export const v${String(n)} = ${String(n)}`).join('\n') + '\n')
    writeFileSync(
      join(featuresDir, `${slug}.md`),
      ['---', `id: feature:${slug}`, `name: ${name}`, 'kind: core', `anchors: [file:src/${slug}.ts]`, 'relates: []', 'lastFullRead: null', 'patchCount: 0', '---', '', `# ${name}`, '', `What ${name} does.`, ''].join('\n'),
    )
  }
}

async function waitForSlugs(page: Page, roots: Record<string, string>): Promise<Record<string, string>> {
  let slugs: Record<string, string> = {}
  await expect
    .poll(
      async () => {
        const listed = await page.evaluate(async () => (window as unknown as { flow: { workspaces: { list: () => Promise<unknown> } } }).flow.workspaces.list())
        const result = listed as { ok?: boolean; workspaces?: Array<{ projects: Array<{ slug: string; localPath: string | null }> }> }
        if (result.ok !== true) return 'not listed'
        for (const workspace of result.workspaces ?? []) {
          const found: Record<string, string> = {}
          for (const [key, root] of Object.entries(roots)) {
            const project = workspace.projects.find((p) => p.localPath !== null && (p.localPath === root || root.endsWith(p.localPath) || p.localPath.endsWith(root.split('/').pop() ?? '')))
            if (project !== undefined) found[key] = project.slug
          }
          if (Object.keys(found).length === Object.keys(roots).length) {
            slugs = found
            return 'placed'
          }
        }
        return 'waiting'
      },
      { timeout: 120_000 },
    )
    .toBe('placed')
  return slugs
}

/** A box inside the window: computed geometry against the window's own size. */
async function expectInsideWindow(page: Page, locator: Locator, what: string): Promise<void> {
  const viewport = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }))
  const box = await locator.boundingBox()
  expect(box, `${what} has no box`).not.toBeNull()
  expect(box!.width, `${what} has no width`).toBeGreaterThan(0)
  expect(box!.height, `${what} has no height`).toBeGreaterThan(0)
  expect(box!.x, `${what} starts left of the window`).toBeGreaterThanOrEqual(0)
  expect(box!.y, `${what} starts above the window`).toBeGreaterThanOrEqual(0)
  expect(box!.x + box!.width, `${what} runs past the right edge (${String(viewport.width)} wide)`).toBeLessThanOrEqual(viewport.width + 0.5)
  expect(box!.y + box!.height, `${what} runs past the bottom edge (${String(viewport.height)} high)`).toBeLessThanOrEqual(viewport.height + 0.5)
}

test('Ask from the header on the Workspace sheet: the centered sheet opens over a dim, tags a project and a feature with @, leaves the map alone, Esc closes, and the @ list stays on screen in a short window', async ({ app, window: page }) => {
  test.setTimeout(360_000)

  const roots: Record<string, string> = {}
  for (const key of Object.keys(PROJECTS)) {
    roots[key] = await seedProject(page, `flow-ux-askws-${key}-`, (dir) => seedFeatures(dir, PROJECTS[key]))
  }
  const slugs = await waitForSlugs(page, roots)
  for (const key of ['app', 'mobile', 'core']) await activateProject(page, roots[key])
  const terminal = page.locator('[data-view-action="terminal"]')
  if ((await terminal.getAttribute('aria-pressed')) === 'true') await terminal.click()
  for (let i = 0; i < 6; i += 1) {
    const notNow = page.getByRole('button', { name: 'Not now' }).first()
    if (!(await notNow.isVisible().catch(() => false))) break
    await notNow.click()
  }

  // The saved-answers reads, answered in MAIN: an empty history, nothing stale.
  await app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('ask:list')
    ipcMain.handle('ask:list', () => ({ ok: true, threads: [] }))
    ipcMain.removeHandler('ask:stale')
    ipcMain.handle('ask:stale', () => ({ ok: true, results: [] }))
  })

  // A SHORT window — the @ list was clipped by the panel's scroll box at this size.
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.setSize(1280, 640)
  })
  await expect.poll(async () => page.evaluate(() => window.innerHeight), { timeout: 10_000 }).toBeLessThanOrEqual(660)

  await page.locator('[data-view-action="blueprint"]').click()
  await expect(page.locator('.flow-board-root')).toBeVisible()
  await expect(page.locator('.fb-ws-country')).toHaveCount(3, { timeout: 120_000 })
  await page.waitForTimeout(600) // the sheet re-packs on a ResizeObserver tick

  const field = page.locator('.flow-board-root [data-ask="field"]')
  const input = field.locator('textarea')
  // The centered sheet (option B) and its own question box; the island field is only the entry.
  const panel = page.locator('.flow-board-root .fb-ask')
  const dim = page.locator('.flow-board-root .fb-ask-dim')
  const sheetInput = panel.locator('.fb-ask-input')
  const sheet = page.locator('.fb-ws-sheet, .fb-ws-root').first()
  // The positive first: the field is in the header, on screen, and the sheet is the Workspace's.
  await expect(field).toBeVisible()
  await expectInsideWindow(page, field, 'the Ask field')
  await expect(panel).toBeHidden()

  // The sheet's state BEFORE Ask: nothing dimmed, nothing outlined.
  const dimmedBefore = await page.locator('.fb-ws-ask-dim').count()
  expect(dimmedBefore).toBe(0)
  const cellsBefore = await page.locator('.fb-ws-cell').count()
  expect(cellsBefore).toBe(10)

  // ── OPEN: a press on the field opens a Workspace question. ──
  await input.click()
  await expect(panel).toBeVisible()
  await expect(dim).toBeVisible()
  await expect(sheetInput).toBeFocused()
  await expect(panel).toHaveAttribute('aria-label', 'Ask about this Workspace')
  await expect(panel.locator('.fb-ask-scope')).toContainText('All 3 projects')
  await expectInsideWindow(page, panel, 'the Ask panel')

  // ── @ IN A SHORT WINDOW: the list's rows are inside the window, not clipped by the panel. ──
  await sheetInput.pressSequentially('@')
  const pick = panel.locator('.fb-ask-pick')
  await expect(pick).toBeVisible()
  const rows = panel.locator('.fb-ask-picker-row')
  await expect.poll(async () => rows.count(), { timeout: 10_000 }).toBeGreaterThan(3)
  // The first row is the first KIND a reader narrows by: projects lead.
  await expect(rows.first().locator('.fb-ask-picker-kind')).toHaveText('project')
  const viewport = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }))
  expect(viewport.height, 'the window is not short').toBeLessThanOrEqual(660)
  const rowCount = await rows.count()
  const panelBox = await panel.boundingBox()
  expect(panelBox).not.toBeNull()
  let visibleInPanel = 0
  for (let i = 0; i < rowCount; i += 1) {
    const box = await rows.nth(i).boundingBox()
    if (box === null) continue
    // A row the panel's own list scrolls past is allowed to be outside the PANEL, never outside the WINDOW
    // when it is the active one; every row that is inside the panel must be inside the window too.
    const insidePanel = box.y >= panelBox!.y - 0.5 && box.y + box.height <= panelBox!.y + panelBox!.height + 0.5
    if (!insidePanel) continue
    visibleInPanel += 1
    await expectInsideWindow(page, rows.nth(i), `picker row ${String(i)}`)
  }
  expect(visibleInPanel, 'fewer than three picker rows fit in the panel').toBeGreaterThanOrEqual(3)
  await expectInsideWindow(page, rows.first(), 'the first picker row')
  await expectInsideWindow(page, pick.locator('.fb-ask-pick-head'), 'the picker heading')
  await expectInsideWindow(page, panel, 'the Ask panel with the list open')
  // The panel's body did not need the PAGE to scroll to show the list.
  const pageScroll = await page.evaluate(() => ({
    top: document.scrollingElement?.scrollTop ?? 0,
    overflow: (document.scrollingElement?.scrollHeight ?? 0) - window.innerHeight,
  }))
  expect(pageScroll.top, 'the page scrolled').toBe(0)
  expect(pageScroll.overflow, 'the page grew taller than the window').toBeLessThanOrEqual(1)
  mkdirSync(join(__dirname, '__screens'), { recursive: true })
  await page.screenshot({ path: join(__dirname, '__screens', 'ask-workspace-header-picker.png') })
  // Arrowing down to the last row keeps it in the window (the active row scrolls into view).
  for (let i = 0; i < rowCount; i += 1) await sheetInput.press('ArrowDown')
  const active = panel.locator('.fb-ask-picker-row.on')
  await expect(active).toHaveCount(1)
  await expectInsideWindow(page, active, 'the active picker row after arrowing to the end')
  expect(await page.evaluate(() => document.scrollingElement?.scrollTop ?? 0), 'arrowing scrolled the page').toBe(0)

  // ── TAG A PROJECT: the first row. ──
  await rows.first().click()
  const chips = panel.locator('.fb-ask-scope .fb-ask-chip')
  await expect(chips).toHaveCount(1)
  await expect(pick).toBeHidden()

  // ── TAG A FEATURE of ANOTHER project, qualified: type @chat, pick the app's. ──
  await sheetInput.pressSequentially('@Chat')
  await expect(pick).toBeVisible()
  const featureRows = panel.locator('.fb-ask-picker-row', { has: page.locator('.fb-ask-picker-kind', { hasText: /^feature$/ }) })
  // The same slug in two projects is two rows (the collision), each carrying its project.
  await expect.poll(async () => featureRows.filter({ hasText: /^.*Chats/ }).count()).toBeGreaterThanOrEqual(2)
  await featureRows.filter({ hasText: /Chat Engine/ }).first().click()
  await expect(chips).toHaveCount(2)
  // The typed "@…" is cut out of the question when its row is picked.
  await expect(sheetInput).toHaveValue('')

  // ── THE MAP DOES NOT REACT while the sheet is open (option B): the dim layer
  // covers it, and nothing on it is outlined or dimmed by the question.
  await expect(page.locator('.fb-ws-country.fb-ws-ask-tagged')).toHaveCount(0)
  await expect(page.locator('.fb-ws-cell.fb-terr-ask-tagged')).toHaveCount(0)
  await expect(page.locator('.fb-ws-ask-dim')).toHaveCount(0)
  const dimBox = (await dim.boundingBox())!
  const boardBox = (await page.locator('.flow-board-root').boundingBox())!
  expect(Math.abs(dimBox.width - boardBox.width), 'the dim layer does not cover the board').toBeLessThanOrEqual(1)
  expect(Math.abs(dimBox.height - boardBox.height), 'the dim layer does not cover the board').toBeLessThanOrEqual(1)
  // The panel says what the question is about now.
  await expect(panel.locator('.fb-ask-scope')).not.toContainText('All 3 projects')
  expect(slugs.core).toBeTruthy()

  mkdirSync(join(__dirname, '__screens'), { recursive: true })
  await page.screenshot({ path: join(__dirname, '__screens', 'ask-workspace-header-tagged.png') })

  // ── CLOSE RESTORES THE SHEET: nothing outlined, nothing dimmed, no open marker, same cells. ──
  await sheetInput.press('Escape')
  await expect(panel).toBeHidden()
  await expect(dim).toBeHidden()
  // Focus goes back to the island field — and that does not open the sheet again.
  await expect(input).toBeFocused()
  await page.waitForTimeout(200)
  await expect(panel).toBeHidden()
  await expect(page.locator('.fb-ws-country.fb-ws-ask-tagged')).toHaveCount(0)
  await expect(page.locator('.fb-ws-cell.fb-terr-ask-tagged')).toHaveCount(0)
  await expect(page.locator('.fb-ws-ask-dim')).toHaveCount(0)
  await expect(page.locator('.fb-ws-ask-open')).toHaveCount(0)
  await expect(page.locator('.fb-ws-country')).toHaveCount(3)
  await expect(page.locator('.fb-ws-cell')).toHaveCount(cellsBefore)
  await expect(page.locator('.fb-terr-ask-marks')).toHaveCount(0)
  void sheet
  mkdirSync(join(__dirname, '__screens'), { recursive: true })
  await page.screenshot({ path: join(__dirname, '__screens', 'ask-workspace-header-closed.png') })
})
