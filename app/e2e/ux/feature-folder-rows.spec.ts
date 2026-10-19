/**
 * WHERE A FEATURE LIVES (plan feature-home-folders, option 3 "Explorer rows").
 *
 * Every feature card says, in the file explorer's own words, where most of
 * that feature lives. CALM AT REST (the user, 2026-10-08: "calm, details on
 * hover"): a roomy card prints ONE home line (or "spread over N folders") and
 * no rows; hovering grows it in place to its details — its words and its top
 * three folders as file-tree rows with each folder's share, "N more folders";
 * an opened cell prints the whole slice above its words. Pressing a row (or
 * the home line) opens that folder in the file tree — expanded and selected —
 * and never opens, closes or dives the cell; a row's right-click is its own
 * menu (never the board's "back"), whose "Make this the home" pins the folder
 * through the CLI's one writer.
 *
 * Real everywhere it can be: a seeded git repo whose features' files span
 * several folders, the bundled CLI computing the rows, main writing the home.
 *
 * Always run hidden: FLOW_E2E=1 FLOW_E2E_BACKGROUND=1.
 */
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'

import type { ElectronApplication, Locator, Page } from '@playwright/test'

import type { BlueprintFeatureGraph } from '../../src/shared/ipc-contract'
import { buildTerritoryView } from '../../src/renderer/blueprint/territory-view'
import { expect, test } from '../fixtures/electron'
import { activateProject, cleanupSeeds, seedProject } from './fixtures/seed'

const SCREENS =
  process.env['FLOW_E2E_FOLDER_SCREENS'] ??
  join(tmpdir(), 'flow-e2e-screens', 'folders')

test.afterAll(() => cleanupSeeds())

/** `n` lines of real code — a feature's size on the map is the lines its anchors stand on. */
function lines(prefix: string, n: number): string {
  return Array.from({ length: n }, (_, i) => `export const ${prefix}${String(i)} = ${String(i)}`).join('\n') + '\n'
}

function put(dir: string, rel: string, text: string): void {
  mkdirSync(join(dir, dirname(rel)), { recursive: true })
  writeFileSync(join(dir, rel), text)
}

function featureNote(slug: string, name: string, anchors: string, text: string): string {
  return ['---', `id: feature:${slug}`, `name: ${name}`, 'kind: core', `anchors: [${anchors}]`, 'relates: []', 'lastFullRead: null', 'patchCount: 0', '---', '', `# ${name}`, '', text, ''].join('\n')
}

function note(dir: string, slug: string, name: string, text: string): void {
  put(dir, `flow/brain/features/${slug}.md`, featureNote(slug, name, `module:src/${slug}`, text))
}

/** Small features spread evenly over four folders each — no home. */
const SPREAD = ['reports', 'alerts', 'invites', 'quotas', 'webhooks', 'themes', 'labels'] as const
/** Small features that live in one folder. */
const HOMED = ['search', 'settings', 'audit', 'exports', 'teams', 'usage', 'notes'] as const

const nameOf = (slug: string): string => slug.charAt(0).toUpperCase() + slug.slice(1)

/**
 * Billing: most of it in `src/billing` (its anchor), the rest in folders that
 * carry its name — five folders, so four rows and "1 more folder". The small
 * siblings make cells of every size; half of them are spread.
 *
 * EVERY TOP-LEVEL SOURCE FOLDER IS CLAIMED (`src/web` by a tiny Web Shell):
 * the basic discovery a Workspace project runs on joining adopts any folder
 * no feature claims as a feature of its own, which would re-pack the map.
 */
function seed(dir: string): void {
  put(dir, 'src/billing/invoice.ts', lines('invoice', 300))
  put(dir, 'src/web/components/billing/BillingPanel.tsx', lines('panel', 120))
  put(dir, 'src/web/api/billing/routes.ts', lines('route', 60))
  put(dir, 'src/web/hooks/billing/useBilling.ts', lines('hook', 30))
  put(dir, 'src/web/stores/billing/store.ts', lines('store', 20))
  note(dir, 'billing', 'Billing', 'Billing — meters usage and writes the monthly invoice.')
  put(dir, 'src/web/shell.ts', lines('shell', 10))
  put(dir, 'flow/brain/features/web.md', featureNote('web', 'Web Shell', 'file:src/web/shell.ts', 'The frame every screen sits in.'))
  let size = 36
  for (const slug of SPREAD) {
    for (const folder of [slug, `web/components/${slug}`, `web/api/${slug}`, `web/hooks/${slug}`]) {
      put(dir, `src/${folder}/index.ts`, lines(folder.replace(/\W/g, ''), size))
    }
    note(dir, slug, nameOf(slug), `${nameOf(slug)} — built from every corner of the app.`)
    size -= 2
  }
  size = 35
  for (const slug of HOMED) {
    put(dir, `src/${slug}/index.ts`, lines(slug, size))
    note(dir, slug, nameOf(slug), `${nameOf(slug)} — a small capability.`)
    size -= 2
  }
}

async function theme(page: Page, value: 'light' | 'dark'): Promise<void> {
  await page.evaluate((next) => document.documentElement.setAttribute('data-theme', next), value)
  await page.waitForTimeout(200)
}

async function screenshotBoth(page: Page, name: string): Promise<void> {
  mkdirSync(SCREENS, { recursive: true })
  await theme(page, 'dark')
  await page.screenshot({ path: join(SCREENS, `folders-${name}-dark.png`) })
  await theme(page, 'light')
  await page.screenshot({ path: join(SCREENS, `folders-${name}-light.png`) })
}

async function dismissAsks(page: Page): Promise<void> {
  for (let i = 0; i < 4; i += 1) {
    const notNow = page.getByRole('button', { name: 'Not now' }).first()
    if (!(await notNow.isVisible().catch(() => false))) break
    await notNow.click().catch(() => undefined)
    await page.waitForTimeout(150)
  }
}

function exactly(name: string): RegExp {
  return new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`)
}

/** A cell by its name, exactly. */
const cell = (page: Page, name: string): Locator =>
  page.locator('.fb-terr-cell', { has: page.locator(':scope > .fb-terr-cell-name', { hasText: exactly(name) }) }).first()

async function waitForWorkspaceLink(dir: string, feature: string): Promise<void> {
  await expect
    .poll(
      () => {
        try {
          return lstatSync(join(dir, 'flow')).isSymbolicLink() && existsSync(join(dir, 'flow', 'brain', 'features', `${feature}.md`))
        } catch {
          return false
        }
      },
      { timeout: 300_000 },
    )
    .toBe(true)
}

/** The project's own feature board — pressed into from the Workspace map when that opens first. */
async function openProjectBoard(page: Page, root: string): Promise<void> {
  const billing = cell(page, 'Billing')
  const folder = basename(root)
  await expect(async () => {
    if (await billing.isVisible().catch(() => false)) return
    const countries = page.locator('.fb-ws-country')
    if ((await countries.count()) > 0) {
      const ours = countries.filter({ hasText: folder })
      const country = (await ours.count()) > 0 ? ours.first() : countries.first()
      await country.locator('.fb-ws-name').click({ timeout: 2_000 })
    }
    await expect(billing).toBeVisible({ timeout: 10_000 })
  }).toPass({ timeout: 150_000, intervals: [1_000, 2_000, 5_000] })
}

/** Every `blueprint:changed` the page sees, so the board is measured once it is quiet. */
async function waitForQuietBoard(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as {
      __folderChanges?: { last: number }
      flow: { blueprint: { onChanged(listener: () => void): unknown } }
    }
    if (w.__folderChanges !== undefined) return
    const changes = { last: Date.now() }
    w.__folderChanges = changes
    w.flow.blueprint.onChanged(() => {
      changes.last = Date.now()
    })
  })
  await expect
    .poll(() => page.evaluate(() => Date.now() - (window as unknown as { __folderChanges: { last: number } }).__folderChanges.last), {
      timeout: 60_000,
      intervals: [500],
    })
    .toBeGreaterThan(2_500)
  await page.waitForTimeout(500)
}

/**
 * HOVER a cell until its details are grown in place: the pointer comes in from
 * outside (a real move), rests past the pause, and the board re-lays.
 */
async function hoverDetails(page: Page, name: string): Promise<Locator> {
  const target = cell(page, name)
  await expect(async () => {
    if ((await target.getAttribute('class'))?.includes('fb-terr-grown') === true) return
    await page.mouse.move(2, 2)
    await page.waitForTimeout(300)
    const box = await target.boundingBox()
    expect(box).not.toBeNull()
    await page.mouse.move((box?.x ?? 0) + (box?.width ?? 0) / 2, (box?.y ?? 0) + 12, { steps: 4 })
    await expect(target).toHaveClass(/fb-terr-grown/, { timeout: 3_000 })
  }).toPass({ timeout: 30_000 })
  await expect(target.locator('.fb-terr-grow-details')).toHaveCount(1)
  await page.waitForTimeout(400)
  return target
}

/** The file tree's selected row, by its folder. */
const selectedInTree = (page: Page, relPath: string): Locator =>
  page.locator(`.fl-files-tree .row.selected [data-rel-path="${relPath}"]`)

type LineKind = 'home' | 'spread'
type Size = { width: number; height: number }

/** What every cell on the sheet printed about where it lives. */
async function readTiers(page: Page): Promise<Array<{ name: string; w: number; h: number; rows: number; line: string | null }>> {
  return page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('.fb-terr-cell')].map((el) => {
      const r = el.getBoundingClientRect()
      return {
        name: el.querySelector(':scope > .fb-terr-cell-name')?.textContent ?? '',
        w: Math.round(r.width),
        h: Math.round(r.height),
        rows: el.querySelectorAll(':scope > .fb-terr-folders .fb-terr-folder-row').length,
        line: el.querySelector('.fb-terr-folder-line')?.textContent ?? null,
      }
    }),
  )
}

async function stageSize(page: Page): Promise<Size> {
  return page.evaluate(() => {
    const el = document.querySelector<HTMLElement>('.flow-board-root .fb-stage')
    return { width: el?.clientWidth ?? 0, height: el?.clientHeight ?? 0 }
  })
}

async function contentSize(app: ElectronApplication): Promise<Size> {
  return app.evaluate(({ BrowserWindow }) => {
    const [width, height] = BrowserWindow.getAllWindows()[0]?.getContentSize() ?? [0, 0]
    return { width: width ?? 0, height: height ?? 0 }
  })
}

async function setContentSize(app: ElectronApplication, size: Size): Promise<void> {
  await app.evaluate(({ BrowserWindow }, next) => {
    BrowserWindow.getAllWindows()[0]?.setContentSize(Math.round(next.width), Math.round(next.height))
  }, size)
}

/**
 * A CELL WHOSE ONE LINE IS OF `kind` — the at-rest form of every roomy cell
 * now, so usually the stage as it is; the model the board draws with
 * (`buildTerritoryView`, over the graph main actually sent) names the stage
 * sizes where one is drawn, and the window is sized to the nearest.
 */
async function reachLineTier(page: Page, app: ElectronApplication, graph: BlueprintFeatureGraph, kind: LineKind): Promise<string> {
  const input = { nodes: graph.nodes, edges: graph.edges }
  const now = await stageSize(page)
  const window0 = await contentSize(app)
  // Within what the window can shrink to (960 x 600) and a little larger.
  const minW = Math.max(400, now.width - (window0.width - 960))
  const minH = Math.max(240, now.height - (window0.height - 600))
  const candidates: Array<Size & { distance: number }> = []
  for (let width = minW; width <= now.width + 200; width += 10) {
    for (let height = minH; height <= now.height + 120; height += 6) {
      const view = buildTerritoryView(input, [], { stage: { width, height } })
      const hit = view.cells.some((entry) => entry.folders?.tier === 'line' && entry.folders.line.kind === kind && (kind === 'spread' || entry.name !== 'Billing'))
      if (hit) candidates.push({ width, height, distance: Math.abs(width - now.width) + Math.abs(height - now.height) })
    }
  }
  candidates.sort((a, b) => a.distance - b.distance)
  expect(candidates.length, `no stage size puts a ${kind} cell in the one-line tier`).toBeGreaterThan(0)
  for (const target of candidates.slice(0, 6)) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const stage = await stageSize(page)
      const window1 = await contentSize(app)
      await setContentSize(app, { width: window1.width + target.width - stage.width, height: window1.height + target.height - stage.height })
      await page.waitForTimeout(900)
      const reached = await stageSize(page)
      if (reached.width === target.width && reached.height === target.height) break
    }
    const lines = (await readTiers(page)).filter((entry) => entry.line !== null)
    // Billing's own home line is checked at rest above; a home here is one of the single-folder features.
    const found = lines.find((entry) => (kind === 'spread') === entry.line?.startsWith('spread over') && (kind === 'spread' || entry.name !== 'Billing'))
    if (found !== undefined) return found.name
  }
  throw new Error(`the board drew no ${kind} line at any of the stage sizes the model named`)
}

test('a feature card says where it lives: rows, a home line, spread; a row opens its folder in the tree and can become the home', async ({ window: page, app }) => {
  test.setTimeout(600_000)
  const root = await seedProject(page, 'flow-ux-folders-', seed)
  await activateProject(page, root)
  await waitForWorkspaceLink(root, 'billing')
  const terminal = page.locator('[data-view-action="terminal"]')
  if ((await terminal.getAttribute('aria-pressed')) === 'true') await terminal.click()
  await dismissAsks(page)
  await page.locator('[data-view-action="blueprint"]').click()
  await expect(page.locator('.flow-board-root')).toBeVisible()
  await openProjectBoard(page, root)
  await waitForQuietBoard(page)
  await dismissAsks(page)
  console.log(`[folders] cells: ${JSON.stringify(await readTiers(page))}`)

  // ── CALM AT REST: one home line under the name, no rows, no description. ──
  const billing = cell(page, 'Billing')
  const restLine = billing.locator('.fb-terr-folder-line')
  await expect(restLine).toHaveCount(1)
  await expect(restLine).toHaveText('billing 57%')
  await expect(restLine).toHaveAttribute('data-folder-path', 'src/billing')
  await expect(billing.locator(':scope > .fb-terr-folders')).toHaveCount(0)
  await expect(billing.locator('.fb-terr-folder-row')).toHaveCount(0)
  // The description shows at rest where there is room; the rows do not.
  // The name is never displaced: it stays above the line.
  const nameBox = await billing.locator(':scope > .fb-terr-cell-name').boundingBox()
  const lineBox = await restLine.boundingBox()
  expect((nameBox?.y ?? 0) + (nameBox?.height ?? 0)).toBeLessThanOrEqual((lineBox?.y ?? 0) + 1)
  // No provenance path where the line speaks.
  await expect(billing.locator('.fb-terr-cell-path:not(.fb-terr-folder-line)')).toHaveCount(0)
  // NO CARD AT REST prints rows, and none more than one line.
  const resting = await readTiers(page)
  expect(resting.some((entry) => entry.line !== null)).toBe(true)
  for (const entry of resting) expect(entry.rows, entry.name).toBe(0)
  expect(await page.evaluate(() => [...document.querySelectorAll('.fb-terr-cell')].every((el) => el.querySelectorAll('.fb-terr-folder-line').length <= 1))).toBe(true)
  await screenshotBoth(page, 'resting')

  // ── HOVER: the details — the top three folders, "N more", words above them. ──
  const details = await hoverDetails(page, 'Billing')
  const rows = details.locator('.fb-terr-grow-folders .fb-terr-folder-row')
  await expect(rows).toHaveCount(3)
  await expect(rows.locator('.fb-terr-folder-path')).toHaveText(['billing', 'web/components/billing', 'web/api/billing'])
  await expect(rows.nth(0)).toHaveAttribute('data-folder-path', 'src/billing')
  await expect(rows.nth(0).locator('.fb-terr-folder-share')).toHaveText('57%')
  await expect(rows.nth(0)).toHaveClass(/fb-terr-folder-home/)
  await expect(rows.nth(1).locator('.fb-terr-folder-share')).toHaveText('23%')
  await expect(rows.nth(1)).not.toHaveClass(/fb-terr-folder-home/)
  // The full path rides the tooltip and the accessible name.
  await expect(rows.nth(1)).toHaveAttribute('aria-label', /src\/web\/components\/billing — 23% of Billing's code, 1 file/)
  await expect(details.locator('.fb-terr-grow-folders .fb-terr-folders-more')).toHaveText('2 more folders')
  // Its words above its folders; the resting line gives way; no diagram, no pin.
  await expect(details.locator('.fb-terr-grow-desc')).toHaveText('Billing — meters usage and writes the monthly invoice.')
  const wordsAbove = await details.locator('.fb-terr-grow-desc').boundingBox()
  const rowsBelow = await details.locator('.fb-terr-grow-folders').boundingBox()
  expect((wordsAbove?.y ?? 0) + (wordsAbove?.height ?? 0)).toBeLessThanOrEqual((rowsBelow?.y ?? 0) + 1)
  const detailsBox = await details.boundingBox()
  expect((rowsBelow?.y ?? 0) + (rowsBelow?.height ?? 0)).toBeLessThanOrEqual((detailsBox?.y ?? 0) + (detailsBox?.height ?? 0))
  await expect(details.locator('.fb-terr-folder-line')).toBeHidden()
  await expect(details.locator('.fb-terr-grow-diagram')).toHaveCount(0)
  await expect(details).not.toHaveClass(/fb-terr-pinned/)
  await screenshotBoth(page, 'details')

  // ── PRESSING A ROW in the details opens its folder; the cell does not open or dive. ──
  await rows.nth(1).click()
  await expect(selectedInTree(page, 'src/web/components/billing')).toBeVisible({ timeout: 15_000 })
  await expect(page.locator('.fb-terr-cell.fb-terr-pinned')).toHaveCount(0)
  await expect(page.locator('.fb-terr-cell[data-grown-diagram]')).toHaveCount(0)
  await expect(cell(page, 'Reports')).toBeVisible()
  // A double-click on a row does not dive either.
  const again = await hoverDetails(page, 'Billing')
  await again.locator('.fb-terr-grow-folders .fb-terr-folder-row').first().dblclick()
  await expect(selectedInTree(page, 'src/billing')).toBeVisible({ timeout: 15_000 })
  await expect(cell(page, 'Reports')).toBeVisible()
  await expect(page.locator('.fb-terr-cell.fb-terr-pinned')).toHaveCount(0)
  // A right-click on a details row is its menu; the map does not go back, and
  // the details it came from stay while the menu is open.
  const held = await hoverDetails(page, 'Billing')
  await held.locator('.fb-terr-grow-folders .fb-terr-folder-row').first().click({ button: 'right' })
  await expect(page.locator('.fb-folder-menu')).toBeVisible()
  await page.locator('.fb-folder-menu .fb-folder-menu-item').first().hover()
  await page.waitForTimeout(800)
  await expect(held).toHaveClass(/fb-terr-grown/)
  await expect(cell(page, 'Reports')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.locator('.fb-folder-menu')).toHaveCount(0)

  // ── THE RESTING HOME LINE is pressable too: it opens its folder. ──
  await page.mouse.move(2, 2)
  await expect(page.locator('.fb-terr-cell.fb-terr-grown')).toHaveCount(0, { timeout: 5_000 })
  await page.waitForTimeout(400)
  await cell(page, 'Billing').locator('.fb-terr-folder-line').click()
  await expect(selectedInTree(page, 'src/billing')).toBeVisible({ timeout: 15_000 })
  await expect(page.locator('.fb-terr-cell.fb-terr-pinned')).toHaveCount(0)
  await page.mouse.move(2, 2)
  await expect(page.locator('.fb-terr-cell.fb-terr-grown')).toHaveCount(0, { timeout: 5_000 })

  // ── THE ONE-LINE TIER: the home line on a smaller cell, and SPREAD said plainly. ──
  const rootId = await page.evaluate(async (folder) => {
    const roots = await (window as unknown as { flow: { project: { list(): Promise<Array<{ rootPath: string }>> } } }).flow.project.list()
    return roots.find((entry) => entry.rootPath.endsWith(folder))?.rootPath ?? ''
  }, basename(root))
  const graph = await page.evaluate(
    async (id) =>
      (window as unknown as { flow: { blueprint: { featureGraph(r: { rootId: string }): Promise<BlueprintFeatureGraph> } } }).flow.blueprint.featureGraph({ rootId: id }),
    rootId,
  )
  expect(graph.available).toBe(true)
  const window0 = await contentSize(app)
  const spreadName = await reachLineTier(page, app, graph, 'spread')
  const spreadLine = cell(page, spreadName).locator('.fb-terr-folder-line')
  // Whichever spread feature reached this tier, its line says its own folder count.
  const spreadNode = graph.nodes.find((node) => node.name === spreadName)
  expect(spreadNode?.folders?.spread).toBe(true)
  await expect(spreadLine).toHaveText(`spread over ${String(spreadNode?.folders?.folderCount)} folders`)
  await expect(spreadLine).toHaveAttribute('title', new RegExp(`No one folder holds most of ${spreadName}'?s? code`))
  await screenshotBoth(page, 'line-spread')
  const homeName = await reachLineTier(page, app, graph, 'home')
  const homeLine = cell(page, homeName).locator('.fb-terr-folder-line')
  const homeSlug = ((await cell(page, homeName).getAttribute('data-feature-id')) ?? '').replace(/^feature:/, '')
  await expect(homeLine).toHaveText(`${homeSlug} 100%`)
  await expect(homeLine).toHaveAttribute('data-folder-path', `src/${homeSlug}`)
  await screenshotBoth(page, 'line-home')
  await setContentSize(app, window0)
  await page.waitForTimeout(900)
  await expect(cell(page, 'Billing').locator('.fb-terr-folder-line')).toBeVisible()

  // ── OPENED: the whole slice above the words. ──
  await cell(page, 'Billing').locator(':scope > .fb-terr-cell-name').click()
  const grown = page.locator('.fb-terr-cell.fb-terr-grown')
  await expect(grown).toHaveCount(1)
  const slice = grown.locator('.fb-terr-grow-folders .fb-terr-folder-row')
  await expect(slice).toHaveCount(4)
  await expect(slice.locator('.fb-terr-folder-path')).toHaveText(['billing', 'web/components/billing', 'web/api/billing', 'web/hooks/billing'])
  await expect(grown.locator('.fb-terr-grow-folders .fb-terr-folders-more')).toHaveText('1 more folder')
  // The cell's own home line gives way to the slice.
  await expect(grown.locator('.fb-terr-folder-line')).toBeHidden()
  const sliceBox = await grown.locator('.fb-terr-grow-folders').boundingBox()
  const wordsBox = await grown.locator('.fb-terr-grow-desc').boundingBox()
  expect(sliceBox).not.toBeNull()
  expect(wordsBox).not.toBeNull()
  expect((sliceBox?.y ?? 0) + (sliceBox?.height ?? 0)).toBeLessThanOrEqual((wordsBox?.y ?? 0) + 1)
  await screenshotBoth(page, 'opened')

  // A row in the opened cell opens its folder; the cell stays open.
  await slice.nth(2).click()
  await expect(selectedInTree(page, 'src/web/api/billing')).toBeVisible({ timeout: 15_000 })
  await expect(grown).toHaveCount(1)

  // ── A ROW'S RIGHT-CLICK is its own menu — never the board's "back". ──
  await slice.nth(1).click({ button: 'right' })
  const menu = page.locator('.fb-folder-menu')
  await expect(menu).toBeVisible()
  await expect(grown).toHaveCount(1)
  await expect(menu.locator('.fb-folder-menu-item')).toHaveText(['Open in file tree', 'Make this the home'])
  await screenshotBoth(page, 'row-menu')
  await menu.getByText('Make this the home').click()
  await expect(menu).toHaveCount(0)

  // The writer pinned it: the note gains `home:`, and the row comes back first, pinned.
  const notePath = join(root, 'flow', 'brain', 'features', 'billing.md')
  await expect.poll(() => readFileSync(notePath, 'utf8'), { timeout: 30_000 }).toMatch(/^home: src\/web\/components\/billing$/m)
  const firstRow = page.locator('.fb-terr-cell[data-feature-id="feature:billing"] .fb-terr-folder-row:visible').first()
  await expect(firstRow).toHaveAttribute('data-folder-path', 'src/web/components/billing', { timeout: 60_000 })
  await expect(firstRow).toHaveClass(/fb-terr-folder-pinned/)
  await expect(firstRow.locator('.fb-terr-folder-pin')).toHaveCount(1)
  await screenshotBoth(page, 'pinned')

  // The pinned row offers to stop using it.
  await firstRow.click({ button: 'right' })
  await expect(page.locator('.fb-folder-menu .fb-folder-menu-item')).toHaveText(['Open in file tree', 'Stop using this as the home'])
  await page.keyboard.press('Escape')
  await expect(page.locator('.fb-folder-menu')).toHaveCount(0)
})
