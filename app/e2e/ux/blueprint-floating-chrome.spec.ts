/**
 * THE BOARD'S FLOATING CHROME (mockup J3, user pick 2026-11-15).
 *
 * The three rows above the map are gone on a territory view. Ask sits top-left
 * with the trail under it, the Layers button bottom-left, the Knowledge pill
 * bottom-right — and the jobs that used to share two buttons are apart:
 * Layers decides what the map shows (one at a time), Knowledge opens the
 * Learning panel and never changes the colouring.
 *
 * Real everywhere it can be: three seeded git repos with features on disk,
 * the board drawing what the bundled CLI returns, a `links.jsonl` written as
 * `workspace link-knowledge` writes it. Geometry is computed against the
 * window ("visible is not on screen"). Nothing reaches a model.
 *
 * Always run hidden: FLOW_E2E=1 FLOW_E2E_BACKGROUND=1.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import type { Locator, Page } from '@playwright/test'

import { expect, test } from '../fixtures/electron'
import { chooseLayer, closeKnowledgePanel, KNOWLEDGE, LAYERS_BUTTON, offeredLayers, openKnowledgePanel, TRAIL } from './fixtures/board-chrome'
import { activateProject, cleanupSeeds, seedProject } from './fixtures/seed'

test.afterAll(() => cleanupSeeds())

const PROJECTS: Record<string, Array<[slug: string, name: string, lines: number, learned: boolean]>> = {
  core: [
    ['chat-engine', 'Chat Engine', 1800, true],
    ['auth', 'Auth', 900, false],
    ['tenants', 'Tenants', 600, false],
  ],
  app: [
    ['chats', 'Chats', 700, true],
    ['sign-in', 'Sign In', 400, false],
  ],
  mobile: [['login', 'Login', 300, false]],
}

function seedFeatures(dir: string, features: (typeof PROJECTS)[string]): void {
  const featuresDir = join(dir, 'flow', 'brain', 'features')
  mkdirSync(featuresDir, { recursive: true })
  mkdirSync(join(dir, 'src'), { recursive: true })
  for (const [slug, name, lines, learned] of features) {
    writeFileSync(join(dir, 'src', `${slug}.ts`), Array.from({ length: lines }, (_, n) => `export const v${String(n)} = ${String(n)}`).join('\n') + '\n')
    writeFileSync(
      join(featuresDir, `${slug}.md`),
      [
        '---',
        `id: feature:${slug}`,
        `name: ${name}`,
        'kind: core',
        `anchors: [file:src/${slug}.ts]`,
        'relates: []',
        `lastFullRead: ${learned ? '2026-10-01T00:00:00.000Z' : 'null'}`,
        'patchCount: 0',
        '---',
        '',
        `# ${name}`,
        '',
        `What ${name} does.`,
        '',
      ].join('\n'),
    )
  }
}

async function waitForPlacement(page: Page, roots: Record<string, string>): Promise<{ workspacePath: string; slugs: Record<string, string> }> {
  let placed: { workspacePath: string; slugs: Record<string, string> } | null = null
  await expect
    .poll(
      async () => {
        const listed = await page.evaluate(async () => (window as unknown as { flow: { workspaces: { list: () => Promise<unknown> } } }).flow.workspaces.list())
        const result = listed as { ok?: boolean; workspaces?: Array<{ path: string; projects: Array<{ slug: string; localPath: string | null }> }> }
        if (result.ok !== true) return 'not listed'
        for (const workspace of result.workspaces ?? []) {
          const slugs: Record<string, string> = {}
          for (const [key, root] of Object.entries(roots)) {
            const found = workspace.projects.find((p) => p.localPath !== null && (p.localPath === root || root.endsWith(p.localPath) || p.localPath.endsWith(root.split('/').pop() ?? '')))
            if (found !== undefined) slugs[key] = found.slug
          }
          if (Object.keys(slugs).length === Object.keys(roots).length) {
            placed = { workspacePath: workspace.path, slugs }
            return 'placed'
          }
        }
        return 'waiting'
      },
      { timeout: 120_000 },
    )
    .toBe('placed')
  return placed as unknown as { workspacePath: string; slugs: Record<string, string> }
}

/** A box inside the window: computed geometry against the window's own size. */
async function boxInside(page: Page, locator: Locator, what: string): Promise<{ x: number; y: number; width: number; height: number }> {
  const viewport = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }))
  const box = await locator.boundingBox()
  expect(box, `${what} has no box`).not.toBeNull()
  expect(box!.width, `${what} has no width`).toBeGreaterThan(0)
  expect(box!.height, `${what} has no height`).toBeGreaterThan(0)
  expect(box!.x, `${what} starts left of the window`).toBeGreaterThanOrEqual(0)
  expect(box!.y, `${what} starts above the window`).toBeGreaterThanOrEqual(0)
  expect(box!.x + box!.width, `${what} runs past the right edge`).toBeLessThanOrEqual(viewport.width + 0.5)
  expect(box!.y + box!.height, `${what} runs past the bottom edge`).toBeLessThanOrEqual(viewport.height + 0.5)
  return box!
}

/**
 * TWO FLOATING ISLANDS (user pick B, 2026-11-15). The top island: the trail on
 * the left, the Ask field on the right, one row; the bottom island: Layers |
 * hint | Knowledge, one object. Both inset 12px, inside the window; the first
 * card starts at least 16px below the top island and the last card ends above
 * the bottom one.
 */
const TOP_ISLAND = '.flow-board-root .fb-float-tl.fb-island'
const BOTTOM_ISLAND = '.flow-board-root .fb-float-bottom.fb-island'

async function expectIslands(page: Page, cards: string, where: string): Promise<{ top: Box; bottom: Box }> {
  const stage = await boxInside(page, page.locator('.flow-board-root .fb-stage'), `the stage (${where})`)
  await expect(page.locator(TOP_ISLAND)).toBeVisible({ timeout: 10_000 })
  await expect(page.locator(BOTTOM_ISLAND)).toBeVisible({ timeout: 10_000 })
  const top = await boxInside(page, page.locator(TOP_ISLAND), `the top island (${where})`)
  const bottom = await boxInside(page, page.locator(BOTTOM_ISLAND), `the bottom island (${where})`)
  const near = (value: number, want: number, what: string): void => expect(Math.abs(value - want), `${what} (${where}): ${String(value)}`).toBeLessThanOrEqual(3)
  near(top.x - stage.x, 12, 'the top island is not inset 12px on the left')
  near(stage.x + stage.width - (top.x + top.width), 12, 'the top island is not inset 12px on the right')
  near(top.y - stage.y, 10, 'the top island is not 10px from the top')
  near(top.height, 48, 'the top island is not 48px tall')
  near(bottom.x - stage.x, 12, 'the bottom island is not inset 12px on the left')
  near(stage.x + stage.width - (bottom.x + bottom.width), 12, 'the bottom island is not inset 12px on the right')
  near(stage.y + stage.height - (bottom.y + bottom.height), 10, 'the bottom island is not 10px from the bottom')
  near(bottom.height, 44, 'the bottom island is not 44px tall')
  // Inside the top island: the trail left, the Ask field right, on one row.
  const ask = await boxInside(page, page.locator(`${TOP_ISLAND} [data-ask="field"]`), `the Ask field (${where})`)
  const trail = await boxInside(page, page.locator(`${TOP_ISLAND} .fb-float-trail`), `the trail (${where})`)
  expect(top.x + top.width - (ask.x + ask.width), `Ask is not at the island's right (${where})`).toBeLessThan(16)
  expect(trail.x - top.x, `the trail is not at the island's left (${where})`).toBeLessThan(20)
  near(ask.height, 32, 'the Ask field is not 32px tall')
  expect(Math.abs(ask.y + ask.height / 2 - (trail.y + trail.height / 2)), `Ask and the trail are not on one row (${where})`).toBeLessThanOrEqual(4)
  expect(ask.width, `Ask is wider than about 400px (${where})`).toBeLessThanOrEqual(402)
  const crumbs = await page.locator(`${TOP_ISLAND} .fb-terr-crumbs`).boundingBox()
  if (crumbs !== null) expect(crumbs.x + crumbs.width, `the crumbs run under the Ask field (${where})`).toBeLessThanOrEqual(ask.x)
  // Inside the bottom island: Layers left, Knowledge right, dividers between.
  await expect(page.locator(`${BOTTOM_ISLAND} .fb-layers-btn`), `Layers is not drawn (${where})`).toBeVisible({ timeout: 10_000 })
  const layers = await boxInside(page, page.locator(`${BOTTOM_ISLAND} .fb-layers-btn`), `Layers (${where})`)
  const knowledge = await boxInside(page, page.locator(`${BOTTOM_ISLAND} .fb-knowledge-pill`), `Knowledge (${where})`)
  expect(layers.x - bottom.x, `Layers is not at the island's left (${where})`).toBeLessThan(16)
  expect(bottom.x + bottom.width - (knowledge.x + knowledge.width), `Knowledge is not at the island's right (${where})`).toBeLessThan(16)
  await expect(page.locator(`${BOTTOM_ISLAND} .fb-island-divider`)).toHaveCount(2)
  // No separate pill boxes any more.
  expect(await page.locator(`${BOTTOM_ISLAND} .fb-knowledge-pill`).evaluate((el) => getComputedStyle(el).borderTopColor)).toMatch(/rgba\(0, 0, 0, 0\)|transparent/)
  // The cards: below the top island with room, above the bottom one.
  const edges = await page.locator(cards).evaluateAll((els) => ({
    top: Math.min(...els.map((el) => el.getBoundingClientRect().top)),
    bottom: Math.max(...els.map((el) => el.getBoundingClientRect().bottom)),
  }))
  expect(Math.abs(edges.top - (top.y + top.height) - 12), `the first band or card is not 12px below the top island (${where}): ${String(edges.top - (top.y + top.height))}`).toBeLessThanOrEqual(2)
  // The arrows are real targets: 26 x 26 each.
  for (const arrow of await page.locator(`${TOP_ISLAND} .fb-nav-btn`).all()) {
    const box = await arrow.boundingBox()
    expect(box?.width ?? 0, `a nav arrow is narrower than 26px (${where})`).toBeGreaterThanOrEqual(26)
    expect(box?.height ?? 0, `a nav arrow is shorter than 26px (${where})`).toBeGreaterThanOrEqual(26)
  }
  expect(bottom.y - edges.bottom, `a card sits under the bottom island (${where})`).toBeGreaterThanOrEqual(0)
  return { top, bottom }
}

type Box = { x: number; y: number; width: number; height: number }

test('Two islands: the trail and Ask in the top bar, Layers | hint | Knowledge in the bottom bar; one layer at a time; the panel never changes the colouring', async ({ app, window: page }) => {
  test.setTimeout(360_000)

  const roots: Record<string, string> = {}
  for (const key of Object.keys(PROJECTS)) roots[key] = await seedProject(page, `flow-ux-j3-${key}-`, (dir) => seedFeatures(dir, PROJECTS[key]))
  const { workspacePath, slugs } = await waitForPlacement(page, roots)
  const ts = '2026-10-06T12:00:00.000Z'
  writeFileSync(
    join(workspacePath, 'links.jsonl'),
    [
      { ts, author: null, kind: 'consumes', from: `${slugs.app}/chats`, to: `${slugs.core}/chat-engine`, note: 'chat stream' },
      { ts, author: null, kind: 'calls', from: `${slugs.app}/sign-in`, to: `${slugs.core}/auth` },
      { ts, author: null, kind: 'calls', from: `${slugs.mobile}/login`, to: `${slugs.core}/auth` },
    ]
      .map((line) => JSON.stringify(line))
      .join('\n') + '\n',
  )
  for (const key of ['app', 'mobile', 'core']) await activateProject(page, roots[key])
  const terminal = page.locator('[data-view-action="terminal"]')
  if ((await terminal.getAttribute('aria-pressed')) === 'true') await terminal.click()
  for (let i = 0; i < 6; i += 1) {
    const notNow = page.getByRole('button', { name: 'Not now' }).first()
    if (!(await notNow.isVisible().catch(() => false))) break
    await notNow.click()
  }
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1280, 640))
  await expect.poll(async () => page.evaluate(() => window.innerHeight), { timeout: 10_000 }).toBeLessThanOrEqual(660)

  await page.locator('[data-view-action="blueprint"]').click()
  await expect(page.locator('.flow-board-root')).toBeVisible()
  await expect(page.locator('.fb-ws-country')).toHaveCount(3, { timeout: 120_000 })
  await page.waitForTimeout(600)

  // ── THE OLD ROWS ARE NOT RENDERED on a territory view. ──
  await expect(page.locator('.flow-board-root .fb-header')).toBeHidden()
  await expect(page.locator('.flow-board-root .fb-terr-title, .flow-board-root .fb-ws-title')).toHaveCount(0)
  await expect(page.locator('.flow-board-root .fb-terr-foot .fb-terr-crumbs')).toHaveCount(0)

  // ── TWO ISLANDS, BOTH ON SCREEN. ──
  const field = page.locator('.flow-board-root [data-ask="field"]')
  await expectIslands(page, '.flow-board-root .fb-ws-country', 'Workspace')
  // The trail names Workspace / its name.
  const trail = page.locator(TRAIL)
  await expect(trail).toContainText('Workspace')
  await expect(trail.locator('.fb-nav-btn')).toHaveCount(2)
  await expect(page.locator(KNOWLEDGE)).toContainText('understood')

  // ── LAYERS: the menu offers each layer once, and stays on screen. ──
  expect(await offeredLayers(page)).toEqual(['map', 'connections', 'learning'])
  await page.locator(LAYERS_BUTTON).click()
  await boxInside(page, page.locator('.flow-board-root .fb-layers-menu'), 'the Layers menu')
  await expect(page.locator('.fb-layers-item[data-layer="connections"] .fb-layers-figure')).toHaveText('3')
  await page.keyboard.press('Escape')

  // ── CONNECTIONS: the lines are drawn (outlines at rest, a line on hover). ──
  await expect(page.locator('.fb-ws-cell.fb-ws-linked')).toHaveCount(0)
  await chooseLayer(page, 'connections')
  // The menu closed over the map, so the pointer rests on a cell — which shows
  // that cell's own lines. Off the cells, every linked feature is outlined.
  await page.locator(KNOWLEDGE).hover()
  await page.waitForTimeout(300)
  await page.locator(KNOWLEDGE).hover()
  await expect(page.locator('.fb-ws-cell.fb-ws-linked')).toHaveCount(5)
  await page.locator('.fb-ws-cell', { hasText: 'Chats' }).hover()
  await expect(page.locator('.fb-ws-feature-link[marker-end]')).toHaveCount(1)
  await page.locator(KNOWLEDGE).hover()

  // ── LEARNING: the lens, with the panel CLOSED. One layer at a time: the lines go. ──
  await expect(page.locator('.flow-board-root .fb-learn-panel')).toHaveCount(0)
  await chooseLayer(page, 'learning')
  await expect(page.locator('.flow-board-root .fb-stage')).toHaveClass(/fb-terr-lens-on/)
  await expect(page.locator('.fb-ws-cell.fb-ws-linked')).toHaveCount(0)
  await expect(page.locator('.flow-board-root .fb-layers-key .fb-terr-key')).toBeVisible()
  const learnedCell = page.locator('.fb-ws-cell.fb-terr-edge-learned').first()
  const tinted = await learnedCell.evaluate((el) => getComputedStyle(el).backgroundColor)

  // ── KNOWLEDGE: the panel opens, on screen, and the colouring does not change. ──
  await openKnowledgePanel(page)
  await boxInside(page, page.locator('.flow-board-root .fb-learn-panel'), 'the Learning panel')
  await expect(page.locator('.flow-board-root .fb-stage')).toHaveClass(/fb-terr-lens-on/)
  expect(await learnedCell.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(tinted)
  await expect(page.locator(LAYERS_BUTTON)).toHaveAttribute('data-layer', 'learning')
  // Its Connections section sits at its foot: pairs never checked → Update connections.
  await expect(page.locator('.fb-lp-connections [data-learn-connections]')).toHaveText(/^(Update|Learn) connections$/)
  await closeKnowledgePanel(page)
  await expect(page.locator('.flow-board-root .fb-stage')).toHaveClass(/fb-terr-lens-on/)

  // ── THE CHOICE IS REMEMBERED across a repaint, and Just the map takes it off. ──
  await chooseLayer(page, 'map')
  await expect(page.locator('.flow-board-root .fb-stage')).not.toHaveClass(/fb-terr-lens-on/)

  // ── INSIDE A PROJECT: the same corners; Learning draws the ground lines with the panel closed. ──
  await page.locator(`.fb-ws-country[data-ws-project="${slugs.core}"] .fb-ws-name`).click()
  await expect(page.locator('.fb-terr-cell', { hasText: 'Chat Engine' })).toBeVisible({ timeout: 120_000 })
  await expect(page.locator('.flow-board-root .fb-header')).toBeHidden()
  await expect(page.locator(`${TRAIL} .fb-ws-crumb`)).toBeVisible()
  await boxInside(page, field, 'the Ask field in the project')
  const islands = await expectIslands(page, '.flow-board-root .fb-terr-cell, .flow-board-root .fb-role-offer', 'project map')
  // THE ASK SHEET (option B) opens centred over the board, below the island's top, on screen.
  await page.locator('.flow-board-root [data-ask="field"] textarea').focus()
  const panel = page.locator('.flow-board-root .fb-ask-dim:not([hidden]) .fb-ask')
  await expect(panel).toBeVisible({ timeout: 10_000 })
  const panelBox = await boxInside(page, panel, 'the Ask sheet')
  const boardBox = (await page.locator('.flow-board-root').boundingBox())!
  expect(Math.abs(panelBox.x + panelBox.width / 2 - (boardBox.x + boardBox.width / 2)), 'the Ask sheet is not centred on the board').toBeLessThanOrEqual(2)
  expect(panelBox.y, 'the Ask sheet starts above the island').toBeGreaterThanOrEqual(islands.top.y)
  await page.keyboard.press('Escape')
  await expect(panel).toBeHidden()
  await page.mouse.move(2, 2)
  await boxInside(page, page.locator(LAYERS_BUTTON), 'the Layers button in the project')
  await boxInside(page, page.locator(KNOWLEDGE), 'the Knowledge pill in the project')
  expect(await offeredLayers(page)).toEqual(['map', 'connections', 'learning'])
  await chooseLayer(page, 'learning')
  await expect(page.locator('.flow-board-root .fb-stage')).toHaveClass(/fb-terr-lens-on/)
  await expect(page.locator('.fb-terr-cell .fb-terr-cov').first()).toBeVisible({ timeout: 60_000 })
  const lines = await page.locator('.fb-terr-cell .fb-terr-cov').count()
  await openKnowledgePanel(page)
  await expect(page.locator('.fb-terr-cell .fb-terr-cov')).toHaveCount(lines)
  await expect(page.locator('.flow-board-root .fb-stage')).toHaveClass(/fb-terr-lens-on/)
  await closeKnowledgePanel(page)
  await expect(page.locator('.fb-terr-cell .fb-terr-cov')).toHaveCount(lines)
  await chooseLayer(page, 'map')

  // ── BACK FROM THE TRAIL goes to the Workspace; the header stays away. ──
  await page.locator(`${TRAIL} .fb-nav-btn[aria-label^="Back"]`).click()
  await expect(page.locator('.fb-ws-country')).toHaveCount(3, { timeout: 30_000 })
  await expect(page.locator('.flow-board-root .fb-header')).toBeHidden()

  // ── SCREENSHOTS at 1280x720, hidden. ──
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1280, 720))
  await expect.poll(async () => page.evaluate(() => window.innerHeight), { timeout: 10_000 }).toBeGreaterThan(660)
  await page.waitForTimeout(800)
  const screens = join(__dirname, '__screens')
  mkdirSync(screens, { recursive: true })
  await page.screenshot({ path: join(screens, 'j3-workspace-sheet.png') })
  await page.locator(`.fb-ws-country[data-ws-project="${slugs.core}"] .fb-ws-name`).click()
  await expect(page.locator('.fb-terr-cell', { hasText: 'Chat Engine' })).toBeVisible({ timeout: 120_000 })
  await page.mouse.move(2, 2)
  await page.waitForTimeout(800)
  await page.screenshot({ path: join(screens, 'j3-project-map.png') })
})
