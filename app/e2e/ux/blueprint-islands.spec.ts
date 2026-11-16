/**
 * THE ISLAND STANDARD ON EVERY SCREEN (user, 2026-11-15). Every Blueprint
 * screen wears ONE top glass island (where you are, how you look at it, its
 * actions, Ask) and at most ONE bottom island (what is known, or the screen's
 * own controls) — and never the old header row.
 *
 * Visits the Workspace sheet, a project map, a feature's blocks, its diagram
 * (with the Known problems sheet grown and folded), the code storyline and
 * the changes & discoveries browser, at 1280x640, and shoots each one. It
 * also measures the islands against the approved mockups (Frame block B and
 * Deep levels) and writes both sides beside the screenshots.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import type { ElectronApplication, Page } from '@playwright/test'

import { expect, test } from '../fixtures/electron'
import { chooseLayer } from './fixtures/board-chrome'
import { enterProject, openFeatureView, WHERE, whereName } from './fixtures/territory'
import { activateProject, cleanupSeeds, seedProject, waitForWorkspaceLink } from './fixtures/seed'

test.afterAll(() => cleanupSeeds())

const SHOTS = join(__dirname, '__screens')
// The mockups are design files outside the repo: the side-by-side measurement
// runs only when a folder holding them is named, and is skipped otherwise.
const MOCKUPS = process.env['FLOW_ISLAND_MOCKUPS'] ?? null

const ORCHESTRATOR = "import { append } from './learn-log'\n\nexport class LearnOrchestrator {\n  run(): void {\n    append('start')\n  }\n}\n"
const LOG = 'export const log: string[] = []\n\nexport function append(entry: string): void {\n  log.push(entry)\n}\n'

const VIEW = {
  feature: 'learning',
  provenance: 'code',
  generatedAt: '2026-11-15T00:00:00.000Z',
  meta: { title: 'Learning', sub: 'How a module gets read' },
  brief: {
    problem: 'The queue runs one pass at a time, so a long module holds every other pass behind it until it finishes.',
    todayHow: [
      ['code', 'A pass reads one module and records what it does.'],
      ['code', 'The activity log keeps the newest entry first.'],
    ],
    todayProblems: [
      ['code', 'The queue runs one pass at a time.'],
      ['code', 'A failed pass is retried only on the next launch.'],
      ['code', 'The log grows without a bound.'],
    ],
  },
  views: {
    root: {
      title: 'Learning',
      nodes: [
        { id: 'panel', kind: 'project', title: 'Learning panel', sub: 'board', delta: 'stable' },
        { id: 'queue', kind: 'function', title: 'Learn queue', sub: 'LearnOrchestrator', delta: 'stable' },
        { id: 'log', kind: 'module', title: 'Activity log', sub: 'learn-log', delta: 'stable' },
      ],
      edges: [
        { from: 'panel', to: 'queue', label: 'start a pass', delta: 'kept' },
        { from: 'queue', to: 'log', label: 'append entry', delta: 'kept' },
      ],
    },
  },
}

function lines(prefix: string, n: number): string {
  return Array.from({ length: n }, (_, i) => `export const ${prefix}${String(i)} = ${String(i)}`).join('\n') + '\n'
}

function featureNote(slug: string, name: string, text: string, anchors: string): string {
  return ['---', `id: feature:${slug}`, `name: ${name}`, 'kind: core', `anchors: [${anchors}]`, 'relates: []', 'lastFullRead: null', 'patchCount: 0', '---', '', `# ${name}`, '', text, ''].join('\n')
}

function seed(dir: string): void {
  mkdirSync(join(dir, 'src', 'project'), { recursive: true })
  writeFileSync(join(dir, 'src', 'project', 'learn-orchestrator.ts'), ORCHESTRATOR)
  writeFileSync(join(dir, 'src', 'project', 'learn-log.ts'), LOG)
  writeFileSync(join(dir, 'src', 'project', 'learn-constants.ts'), lines('learnStep', 70))
  mkdirSync(join(dir, 'src', 'agents'), { recursive: true })
  writeFileSync(join(dir, 'src', 'agents', 'index.ts'), lines('agents', 30))
  const features = join(dir, 'flow', 'brain', 'features')
  mkdirSync(features, { recursive: true })
  writeFileSync(join(features, 'agents.md'), featureNote('agents', 'Agents', 'Runs one agent turn at a time.', 'module:src/agents'))
  writeFileSync(
    join(features, 'learning.md'),
    [
      featureNote('learning', 'Learning', 'Reads modules and records what they do, one pass at a time.', 'module:src/project').trimEnd(),
      '',
      '## Parts',
      '',
      '### Learn queue',
      'The serial queue that runs learn passes.',
      'anchors: src/project/learn-orchestrator.ts',
      '',
      '### Activity log',
      'What the queue did, newest first.',
      'anchors: src/project/learn-log.ts',
      '',
    ].join('\n'),
  )
}

/** The drawn view goes in AFTER the checkout's knowledge moved into the Workspace. */
function writeView(dir: string): void {
  const views = join(dir, 'flow', 'brain', '.structure', 'feature-views')
  mkdirSync(views, { recursive: true })
  writeFileSync(join(views, 'learning.json'), JSON.stringify(VIEW, null, 2))
  // One saved question, so the deep view draws its "Questions asked" band —
  // the band the bottom island used to lie over.
  const qa = {
    id: 'qa-20261115T000000-aaaaaa',
    ts: '2026-11-15T00:00:00.000Z',
    author: 'Tester',
    question: 'How does a learn pass start?',
    tags: ['feature:learning'],
    conversationCount: 0,
    usedConversation: false,
    answer: 'The queue starts one pass at a time.',
    sources: [],
  }
  writeFileSync(join(dir, 'flow', 'brain', '.structure', 'qa.jsonl'), `${JSON.stringify(qa)}\n`)
}

function seedSibling(dir: string): void {
  mkdirSync(join(dir, 'src', 'billing'), { recursive: true })
  writeFileSync(join(dir, 'src', 'billing', 'index.ts'), lines('billing', 40))
  const features = join(dir, 'flow', 'brain', 'features')
  mkdirSync(features, { recursive: true })
  writeFileSync(join(features, 'billing.md'), featureNote('billing', 'Billing', 'Meters usage and writes the monthly invoice.', 'module:src/billing'))
}

type Box = { x: number; y: number; width: number; height: number }

/** Exactly one top island, at most one bottom island, both inside the window; no header row. */
async function expectIslands(page: Page, screen: string): Promise<void> {
  const size = await page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }))
  const tops = page.locator('.flow-board-root .fb-island.fb-float-tl:visible')
  await expect(tops, `${screen}: not exactly one top island`).toHaveCount(1, { timeout: 15_000 })
  const bottoms = await page.locator('.flow-board-root .fb-island.fb-float-bottom:visible').count()
  expect(bottoms, `${screen}: more than one bottom island`).toBeLessThanOrEqual(1)
  await expect(page.locator('.flow-board-root .fb-header:visible'), `${screen}: the header row is drawn`).toHaveCount(0)
  const boxes: Box[] = []
  const top = await tops.boundingBox()
  if (top !== null) boxes.push(top)
  if (bottoms === 1) {
    const bottom = await page.locator('.flow-board-root .fb-island.fb-float-bottom:visible').boundingBox()
    if (bottom !== null) boxes.push(bottom)
  }
  for (const arrow of await tops.locator('.fb-nav-btn').all()) {
    const box = await arrow.boundingBox()
    expect(Math.min(box?.width ?? 0, box?.height ?? 0), `${screen}: a nav arrow is smaller than 26 x 26`).toBeGreaterThanOrEqual(26)
  }
  for (const box of boxes) {
    expect(box.x, `${screen}: an island leaves the window on the left`).toBeGreaterThanOrEqual(0)
    expect(box.y, `${screen}: an island leaves the window at the top`).toBeGreaterThanOrEqual(0)
    expect(box.x + box.width, `${screen}: an island leaves the window on the right`).toBeLessThanOrEqual(size.w + 1)
    expect(box.y + box.height, `${screen}: an island leaves the window at the bottom`).toBeLessThanOrEqual(size.h + 1)
  }
}

/** The app's own offers (a basic discovery) float over the board corner; set them aside. */
async function dismissOffers(page: Page): Promise<void> {
  for (let i = 0; i < 4; i += 1) {
    const notNow = page.getByRole('button', { name: 'Not now' }).first()
    if (!(await notNow.isVisible().catch(() => false))) break
    await notNow.click().catch(() => undefined)
    await page.waitForTimeout(150)
  }
}

async function shot(page: Page, name: string): Promise<void> {
  await dismissOffers(page)
  mkdirSync(SHOTS, { recursive: true })
  await page.mouse.move(0, 0)
  await page.waitForTimeout(250)
  await page.screenshot({ path: join(SHOTS, `islands-${name}.png`) })
}

/** What the build draws: sizes and colours, read off the live DOM. */
async function measureBuild(page: Page): Promise<Record<string, string | number>> {
  return page.evaluate(() => {
    const q = (sel: string): HTMLElement | null =>
      [...document.querySelectorAll<HTMLElement>(sel)].find((el) => el.getClientRects().length > 0) ?? null
    const cs = (el: Element | null, prop: string): string => (el === null ? '' : getComputedStyle(el).getPropertyValue(prop))
    const r = (el: Element | null): DOMRect | null => (el === null ? null : el.getBoundingClientRect())
    const island = q('.flow-board-root .fb-island.fb-float-tl')
    const field = q('.flow-board-root .fb-float-tl .fb-askf')
    const crumb = q('.flow-board-root .fb-float-tl .fb-terr-crumb:not(.on), .flow-board-root .fb-float-tl .fb-ws-crumb:not(.on)')
    const current = q('.flow-board-root .fb-float-tl .fb-terr-crumb.on, .flow-board-root .fb-float-tl .fb-ws-crumb.on')
    const sep = q('.flow-board-root .fb-float-tl .fb-terr-crumb-sep')
    const back = q('.flow-board-root .fb-float-tl .fb-nav-btn')
    const fwd = [...document.querySelectorAll<HTMLElement>('.flow-board-root .fb-float-tl .fb-nav-btn')][1] ?? null
    const input = q('.flow-board-root .fb-float-tl .fb-askf-input')
    const spark = q('.flow-board-root .fb-float-tl .fb-askf-spark')
    const key = q('.flow-board-root .fb-float-tl .fb-askf-key')
    const track = q('.flow-board-root .fb-float-tl .fb-view-switch')
    const on = q('.flow-board-root .fb-float-tl .fb-view-switch-btn[aria-pressed="true"]')
    const act = q('.flow-board-root .fb-float-tl .fb-float-act:not(.fb-view-switch)')
    const bottom = q('.flow-board-root .fb-island.fb-float-bottom')
    const divider = q('.flow-board-root .fb-island-divider')
    const line1 = q('.flow-board-root .fb-knowledge-line1')
    const tab = q('.flow-board-root .fb-deep-tab')
    const stage = q('.flow-board-root .fb-stage')
    const ir = r(island)
    const fr = r(field)
    return {
      islandHeight: ir?.height ?? 0,
      islandTop: ir === null || stage === null ? 0 : ir.top - stage.getBoundingClientRect().top,
      islandInsetLeft: ir === null || stage === null ? 0 : ir.left - stage.getBoundingClientRect().left,
      islandBg: cs(island, 'background-color'),
      islandBorder: cs(island, 'border-top-color'),
      islandPadLeft: cs(island, 'padding-left'),
      crumbsFromLeft: ir === null || back === null ? 0 : r(back)!.left - ir.left,
      navGap: back === null || fwd === null ? 0 : r(fwd)!.left - r(back)!.right,
      navColor: cs(back, 'color'),
      navSize: cs(back, 'font-size'),
      crumbSize: cs(crumb, 'font-size'),
      crumbColor: cs(crumb, 'color'),
      sepColor: cs(sep, 'color'),
      currentSize: cs(current, 'font-size'),
      currentColor: cs(current, 'color'),
      currentWeight: cs(current, 'font-weight'),
      fieldHeight: fr?.height ?? 0,
      fieldWidth: fr?.width ?? 0,
      fieldRightGap: ir === null || fr === null ? 0 : ir.right - fr.right,
      fieldBg: cs(field, 'background-color'),
      fieldBorder: cs(field, 'border-top-color'),
      fieldPad: `${cs(field, 'padding-left')} ${cs(field, 'padding-right')}`,
      fieldGap: cs(field, 'column-gap'),
      placeholderSize: cs(input, 'font-size'),
      sparkColor: cs(spark, 'color'),
      keyBorder: cs(key, 'border-top-color'),
      keyColor: cs(key, 'color'),
      trackBg: cs(track, 'background-color'),
      trackBorder: cs(track, 'border-top-color'),
      segOnBg: cs(on, 'background-color'),
      segOnInk: cs(on, 'color'),
      segHeight: r(on)?.height ?? 0,
      actionColor: cs(act, 'color'),
      actionSize: cs(act, 'font-size'),
      bottomHeight: r(bottom)?.height ?? 0,
      dividerColor: cs(divider, 'background-color'),
      knowledgeColor: cs(line1, 'color'),
      tabHeight: r(tab)?.height ?? 0,
      paper: cs(stage, 'background-color'),
    }
  })
}

/** The mockup, drawn in a hidden window of the same app at 1280 wide: its block's numbers and a picture. */
async function measureMockup(
  app: ElectronApplication,
  file: string,
  marker: string,
  index: number,
  out: string,
): Promise<Record<string, string | number> | null> {
  if (!existsSync(file)) return null
  return app.evaluate(
    async ({ BrowserWindow }, args) => {
      const win = new BrowserWindow({ show: false, width: 1280, height: 900, webPreferences: { offscreen: true } })
      try {
        await win.loadFile(args.file)
        const found = (await win.webContents.executeJavaScript(`(() => {
          const hits = [...document.querySelectorAll('span')].filter((el) => el.textContent === ${JSON.stringify(args.marker)})
          const islands = hits.filter((el) => el.parentElement && el.parentElement.parentElement && getComputedStyle(el.parentElement.parentElement).borderTopLeftRadius === '12px')
          const text = islands[${String(args.index)}]
          if (!text) return null
          const field = text.parentElement, island = field.parentElement, frame = island.parentElement
          frame.scrollIntoView({ block: 'start' })
          const cs = (el, p) => el ? getComputedStyle(el).getPropertyValue(p) : ''
          const spans = [...island.children]
          const nav = spans[0], crumb = spans.find((el, i) => i > 0 && el.tagName === 'SPAN' && getComputedStyle(el).fontWeight !== '600' && el.textContent !== '/')
          const sep = spans.find((el) => el.textContent === '/'), current = spans.find((el) => el.tagName === 'SPAN' && getComputedStyle(el).fontWeight === '600')
          const ir = island.getBoundingClientRect(), fr = field.getBoundingClientRect(), fm = frame.getBoundingClientRect()
          const key = field.querySelector('kbd'), spark = field.firstElementChild
          const track = [...island.querySelectorAll('span,div')].find((el) => el.textContent === 'BlocksDiagram')
          const onSeg = track ? [...track.children].find((el) => getComputedStyle(el).fontWeight === '600' || getComputedStyle(el).backgroundColor !== 'rgba(0, 0, 0, 0)') : null
          const bottom = frame.children[[...frame.children].indexOf(island) + 1]
          return {
            rect: { x: fm.left, y: fm.top, width: fm.width, height: Math.min(fm.height, 900) },
            m: {
              islandHeight: ir.height, islandTop: ir.top - fm.top, islandInsetLeft: ir.left - fm.left,
              islandBg: cs(island, 'background-color'), islandBorder: cs(island, 'border-top-color'), islandPadLeft: cs(island, 'padding-left'),
              crumbsFromLeft: nav.getBoundingClientRect().left - ir.left,
              navColor: cs(nav, 'color'), navSize: cs(nav, 'font-size'),
              crumbSize: cs(crumb, 'font-size'), crumbColor: cs(crumb, 'color'), sepColor: cs(sep, 'color'),
              currentSize: cs(current, 'font-size'), currentColor: cs(current, 'color'), currentWeight: cs(current, 'font-weight'),
              fieldHeight: fr.height, fieldWidth: fr.width, fieldRightGap: ir.right - fr.right,
              fieldBg: cs(field, 'background-color'), fieldBorder: cs(field, 'border-top-color'),
              fieldPad: cs(field, 'padding-left') + ' ' + cs(field, 'padding-right'), fieldGap: cs(field, 'column-gap'),
              placeholderSize: cs(text, 'font-size'), placeholderColor: cs(field, 'color'), sparkColor: cs(spark, 'color'),
              keyBorder: cs(key, 'border-top-color'), keyColor: cs(key, 'color'),
              trackBg: cs(track, 'background-color'), trackBorder: cs(track, 'border-top-color'),
              segOnBg: cs(onSeg, 'background-color'), segOnInk: cs(onSeg, 'color'), segHeight: onSeg ? onSeg.getBoundingClientRect().height : 0,
              bottomHeight: bottom ? bottom.getBoundingClientRect().height : 0,
              paper: cs(frame, 'background-color'),
            },
          }
        })()`)) as { rect: { x: number; y: number; width: number; height: number }; m: Record<string, string | number> } | null
        if (found === null) return null
        const image = await win.webContents.capturePage({
          x: Math.max(0, Math.round(found.rect.x)),
          y: Math.max(0, Math.round(found.rect.y)),
          width: Math.round(found.rect.width),
          height: Math.round(found.rect.height),
        })
        const fs = process.mainModule?.require('node:fs') as typeof import('node:fs')
        fs.writeFileSync(args.out, image.toPNG())
        return found.m
      } finally {
        win.destroy()
      }
    },
    { file, marker, index, out },
  )
}

test('every Blueprint screen wears one top island, at most one bottom island, and no header row', async ({ app, window: page }) => {
  test.setTimeout(900_000)
  await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0]
    win?.setSize(1280, 640)
  })
  const root = await seedProject(page, 'flow-ux-islands-', seed)
  const sibling = await seedProject(page, 'flow-ux-islands-sib-', seedSibling)
  await activateProject(page, sibling)
  await activateProject(page, root)
  await waitForWorkspaceLink(root)
  writeView(root)
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'))
  const terminal = page.locator('[data-view-action="terminal"]')
  if ((await terminal.getAttribute('aria-pressed')) === 'true') await terminal.click()
  // While the board loads, sample it: a top island with nothing named and no
  // labelled action (an empty bar) must never show (user, 2026-11-15).
  await page.evaluate(() => {
    const w = window as unknown as { __emptyIslands: number; __islandSamples: number }
    w.__emptyIslands = 0
    w.__islandSamples = 0
    const until = Date.now() + 6000
    const tick = (): void => {
      for (const island of document.querySelectorAll<HTMLElement>('.flow-board-root .fb-head-island')) {
        if (island.getClientRects().length === 0) continue
        w.__islandSamples += 1
        const labelled = [...island.querySelectorAll<HTMLElement>('button, .fb-head-strip, .fb-brief-trail, .fb-terr-crumbs')]
          .filter((el) => el.closest('.fb-nav') === null && el.getClientRects().length > 0)
          .some((el) => (el.textContent ?? '').trim().length > 0)
        if (!labelled) w.__emptyIslands += 1
      }
      if (Date.now() < until) requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })
  await page.locator('[data-view-action="blueprint"]').click()
  await expect(page.locator('.flow-board-root')).toBeVisible()
  for (let i = 0; i < 4; i += 1) {
    const notNow = page.getByRole('button', { name: 'Not now' }).first()
    if (!(await notNow.isVisible().catch(() => false))) break
    await notNow.click().catch(() => undefined)
  }
  const measured: Record<string, unknown> = {}

  await page.waitForTimeout(6000)
  expect(await page.evaluate(() => (window as unknown as { __emptyIslands: number }).__emptyIslands)).toBe(0)
  // ── THE WORKSPACE SHEET (or the project map, when the sibling is not in yet). ──
  await expect(page.locator(WHERE)).toBeVisible({ timeout: 120_000 })
  await expect(page.locator('.flow-board-root .fb-ws-country')).toHaveCount(2, { timeout: 120_000 })
  await expectIslands(page, 'Workspace sheet')
  // A MAP NEVER BUILDS THE HEADER'S ISLAND, not even for a frame mid-swap:
  // that churn resized the stage and re-rendered the map in a loop. (The
  // sheet itself still repaints while a fresh project settles — git status,
  // the feature graph — which is data arriving, not the chrome.)
  const headIslands = await page.evaluate(
    () =>
      new Promise<number>((resolve) => {
        let added = 0
        const root = document.querySelector('.flow-board-root') as HTMLElement
        const watch = new MutationObserver((records) => {
          for (const record of records)
            for (const node of record.addedNodes) if (node instanceof HTMLElement && node.classList.contains('fb-head-island')) added += 1
        })
        watch.observe(root, { childList: true, subtree: true })
        setTimeout(() => {
          watch.disconnect()
          resolve(added)
        }, 3_000)
      }),
  )
  expect(headIslands, 'a map built the header island').toBe(0)
  await shot(page, 'workspace-sheet')
  await shot(page, 'compare-workspace-build')
  measured['workspaceBuild'] = await measureBuild(page)
  if (MOCKUPS !== null) measured['workspaceMockup'] = await measureMockup(app, join(MOCKUPS, 'Frame.dc.html'), 'Ask how something works…', 0, join(SHOTS, 'islands-compare-workspace-mockup.png'))

  // ── THE PROJECT MAP. ──
  const project = root.split('/').pop() ?? ''
  await enterProject(page, project)
  await expectIslands(page, 'project map')
  await shot(page, 'project-map')
  // The map's island carries no actions, so even this narrow pane keeps the
  // whole Ask field and its placeholder — only a crowded island folds it.
  await expect
    .poll(async () => (await page.locator('.flow-board-root .fb-float-tl:not(.fb-deep-chrome *) .fb-askf').first().boundingBox())?.width ?? 0)
    .toBeGreaterThan(200)

  // ── THE FEATURE'S DIAGRAM, its Known problems sheet grown and folded. ──
  // ── THE FEATURE'S BLOCKS: Understand rides the Learning layer only. ──
  await expect
    .poll(
      async () => {
        if ((await whereName(page)) === 'Learning') return true
        await page.mouse.move(0, 0)
        await page.locator('.fb-terr-cell', { hasText: 'Learning' }).first().dblclick({ position: { x: 8, y: 26 }, timeout: 5_000 }).catch(() => undefined)
        await page.waitForTimeout(1_200)
        return (await whereName(page)) === 'Learning'
      },
      { timeout: 45_000, intervals: [100], message: 'the dive into Learning never happened' },
    )
    .toBe(true)
  await expectIslands(page, 'feature blocks')
  const understandInBottom = page.locator('.flow-board-root .fb-float-bottom .fb-layer-understand')
  await expect(page.locator('.flow-board-root .fb-float-tl').getByText(/^Understand/)).toHaveCount(0)
  await expect(understandInBottom).toHaveCount(0)
  await chooseLayer(page, 'learning')
  await expect(understandInBottom).toBeVisible()
  await expect(understandInBottom).toContainText(/Understand/)
  await shot(page, 'feature-blocks-learning')
  await chooseLayer(page, 'map')
  await expect(understandInBottom).toHaveCount(0)
  await shot(page, 'feature-blocks')
  await openFeatureView(page, 'Learning')
  const deep = page.locator('.flow-board-root .fb-deep-chrome')
  await expect(deep).toBeVisible({ timeout: 30_000 })
  await expectIslands(page, 'feature diagram')
  const top = deep.locator('.fb-float-tl')
  await expect(top.locator('.fb-terr-crumbs')).toContainText('Learning')
  await expect(top.locator('.fb-view-switch [data-view="diagram"][aria-pressed="true"]')).toBeVisible()
  await expect(top.locator('[data-ask="field"]')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Ask about this' })).toHaveCount(0)
  await expect(top.getByText(/^Understand/)).toHaveCount(0)
  await expect(top.locator('.fb-askf-input')).toHaveAttribute('placeholder', 'Ask about Learning…')
  for (const action of ['Follow the code', 'Changes & discoveries']) await expect(top.getByText(action, { exact: true })).toBeVisible()
  const bottom = deep.locator('.fb-float-bottom')
  await expect(bottom.locator('.fb-deep-tab')).toHaveText([/How it works today\s*2/, /Known problems\s*3/, /Verification/])
  await expect(bottom.locator('.fb-deep-issue-tag')).toHaveText(/known issue/i)
  await expect(bottom.locator('.fb-deep-issue')).toHaveAttribute('title', /holds every other pass/)
  await expect(page.locator('.flow-board-root .fb-curated-band:visible, .flow-board-root .fb-brief-foot:visible')).toHaveCount(0)
  await shot(page, 'feature-diagram')
  // The saved question's band sits wholly ABOVE the bottom island.
  const asked = page.locator('.flow-board-root .fb-brief-asked')
  await expect(asked).toContainText('How does a learn pass start?')
  const gap = await page.evaluate(() => {
    const vis = (sel: string): HTMLElement | null =>
      [...document.querySelectorAll<HTMLElement>(sel)].find((el) => el.getClientRects().length > 0) ?? null
    const row = vis('.flow-board-root .fb-brief-asked .fb-asked-row, .flow-board-root .fb-brief-asked button, .flow-board-root .fb-brief-asked li')
    const island = vis('.flow-board-root .fb-deep-chrome .fb-float-bottom')
    return row === null || island === null ? null : island.getBoundingClientRect().top - row.getBoundingClientRect().bottom
  })
  expect(gap).not.toBeNull()
  expect(gap!).toBeGreaterThanOrEqual(0)
  // A NARROW PANE (the board here is ~716px): where you are stays readable,
  // nothing in either island is cut, and the folded Ask field opens on focus.
  const fit = await page.evaluate(() => {
    const vis = (sel: string): HTMLElement | null =>
      [...document.querySelectorAll<HTMLElement>(sel)].find((el) => el.getClientRects().length > 0) ?? null
    const island = vis('.flow-board-root .fb-deep-chrome .fb-float-tl')!.getBoundingClientRect()
    const crumbs = vis('.flow-board-root .fb-deep-chrome .fb-terr-crumbs')!
    const last = crumbs.lastElementChild as HTMLElement
    const sw = vis('.flow-board-root .fb-deep-chrome .fb-view-switch')!.getBoundingClientRect()
    const field = vis('.flow-board-root .fb-deep-chrome .fb-askf')!.getBoundingClientRect()
    const tag = vis('.flow-board-root .fb-deep-issue-tag')!
    const hint = tag.closest('.fb-island-hint')!.getBoundingClientRect()
    const t = tag.getBoundingClientRect()
    return {
      islandW: island.width,
      lastText: last.textContent,
      lastW: last.getBoundingClientRect().width,
      lastClipped: last.scrollWidth > last.clientWidth + 1,
      switchInside: sw.left >= island.left && sw.right <= island.right,
      fieldInside: field.right <= island.right + 0.5,
      fieldW: field.width,
      tagClipped: tag.scrollWidth > tag.clientWidth + 1 || t.right > hint.right + 0.5 || t.left < hint.left - 0.5,
    }
  })
  expect(fit.islandW).toBeLessThan(760)
  expect(fit.lastText).toBe('Learning')
  expect(fit.lastClipped).toBe(false)
  expect(fit.lastW).toBeGreaterThan(30)
  expect(fit.switchInside).toBe(true)
  expect(fit.fieldInside).toBe(true)
  expect(fit.fieldW).toBeLessThan(100)
  expect(fit.tagClipped).toBe(false)
  // Focusing the folded field opens the centered Ask sheet (option B), scoped
  // to this feature: its chip whole in the "Asking about" row.
  await top.locator('.fb-askf-input').focus()
  const askSheet = page.locator('.flow-board-root .fb-ask-dim:not([hidden]) .fb-ask')
  await expect(askSheet).toBeVisible()
  const open = await askSheet.evaluate((sheet) => {
    const chip = sheet.querySelector<HTMLElement>('.fb-ask-scope .fb-ask-chip')
    const input = sheet.querySelector<HTMLTextAreaElement>('.fb-ask-input')!
    return {
      chipText: chip?.textContent ?? '',
      chipClipped: chip === null ? true : chip.scrollWidth > chip.clientWidth + 1,
      placeholder: getComputedStyle(input, '::placeholder').color,
    }
  })
  expect(open.chipText).toContain('Learning')
  expect(open.chipClipped).toBe(false)
  expect(open.placeholder).not.toBe('rgba(0, 0, 0, 0)')
  await shot(page, 'feature-diagram-ask-open')
  await page.keyboard.press('Escape')
  await page.locator('.flow-board-root .fb-stage').click({ position: { x: 5, y: 200 } }).catch(() => undefined)
  await expect.poll(async () => (await top.locator('.fb-askf').boundingBox())?.width ?? 999).toBeLessThan(100)
  await shot(page, 'compare-diagram-build')
  measured['diagramBuild'] = await measureBuild(page)
  if (MOCKUPS !== null) measured['diagramMockup'] = await measureMockup(app, join(MOCKUPS, 'Deep.dc.html'), 'Ask about Auth…', 0, join(SHOTS, 'islands-compare-diagram-mockup.png'))

  await bottom.locator('.fb-deep-tab', { hasText: 'Known problems' }).click()
  const sheet = bottom.locator('.fb-deep-sheet')
  await expect(sheet).toBeVisible()
  await expect(sheet).toContainText('The log grows without a bound.')
  const size = await page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }))
  const sheetBox = await sheet.boundingBox()
  const bottomBox = await bottom.boundingBox()
  expect(sheetBox).not.toBeNull()
  expect(bottomBox).not.toBeNull()
  if (sheetBox !== null && bottomBox !== null) {
    expect(sheetBox.y, 'the Known problems sheet leaves the window').toBeGreaterThanOrEqual(0)
    expect(bottomBox.y + bottomBox.height).toBeLessThanOrEqual(size.h + 1)
    expect(sheetBox.height, 'the sheet is taller than 45% of the window').toBeLessThanOrEqual(size.h * 0.45 + 1)
    // The tabs stay at the island's foot.
    const tabs = await bottom.locator('.fb-deep-tabs').boundingBox()
    expect(tabs?.y ?? 0).toBeGreaterThan(sheetBox.y + sheetBox.height - 1)
  }
  await shot(page, 'feature-diagram-sheet')
  await page.keyboard.press('Escape')
  await expect(sheet).toBeHidden()
  await expect(deep, 'Escape left the feature instead of folding the sheet').toBeVisible()

  // ── KNOWLEDGE opens the Learning panel, with Understand beside Re-check. ──
  await dismissOffers(page)
  await bottom.locator('.fb-deep-knowledge').click()
  await expect(page.locator('.flow-board-root .fb-learn-understand')).toBeVisible({ timeout: 15_000 })
  await expect(page.locator('.flow-board-root .fb-learn-understand')).toContainText(/Understand/)
  await shot(page, 'feature-diagram-knowledge')
  await bottom.locator('.fb-deep-knowledge').click()

  // ── THE CODE STORYLINE. ──
  await top.getByText('Follow the code', { exact: true }).click()
  await expect(page.locator('.flow-board-root .fb-story, .flow-board-root .fb-storyline').first()).toBeVisible({ timeout: 60_000 })
  await expectIslands(page, 'code storyline')
  await shot(page, 'storyline')
  await page.keyboard.press('Escape')
  await expect(deep).toBeVisible({ timeout: 30_000 })

  // ── CHANGES & DISCOVERIES. ──
  await deep.locator('.fb-float-tl').getByText('Changes & discoveries', { exact: true }).click()
  await expect(page.locator('.flow-board-root [class*="fb-corpus"]').first()).toBeVisible({ timeout: 30_000 })
  await expectIslands(page, 'changes & discoveries')
  await shot(page, 'corpus')

  mkdirSync(SHOTS, { recursive: true })
  writeFileSync(join(SHOTS, 'islands-measure.json'), JSON.stringify(measured, null, 2))
  expect(await whereName(page)).not.toBeUndefined()
})
