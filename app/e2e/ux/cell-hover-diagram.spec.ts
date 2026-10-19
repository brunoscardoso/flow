/**
 * THE CELL THAT OPENS IN PLACE (plan cell-hover-diagram, click model of
 * 2026-10-08) — a LEFT CLICK on a cell grows the SAME cell where it stands: its
 * level is laid out again with it taking most of the room (at least half the
 * level's width AND height), its neighbours shrink around it, and its diagram
 * is drawn INSIDE it, pinned for exploring at once (pan, zoom, Fit, Open, X).
 * A cell with nothing to draw grows to its words or its Learn offer, and a
 * second click goes in. A DOUBLE-CLICK goes in (zoom, or the code story at the
 * last level). A RIGHT-CLICK closes an open cell, else goes back one level. A
 * click outside, Escape or the X closes it.
 *
 * CALM AT REST, DETAILS ON HOVER (the user, 2026-10-08: "the option 3, calm
 * details on hover … we should make the same movement that we are already
 * doing, move the others around"): a resting card is its name, one home line
 * and its foot. Hovering it past the pause grows it IN PLACE by the same re-lay
 * — the others shrink and slide around it — but only to the size its details
 * need (~320 × 230): its words, its top folders, its foot. No diagram is read
 * for a hover. Leaving puts the map back; a click opens it. The map moving
 * under a still pointer grows nothing. There is no card and no overlay (user,
 * 2026-10-07: "same component, same place, only changing the size of the
 * items").
 *
 * Real everywhere it can be: a seeded project whose Learning and Agents
 * features have CURATED VIEWS (`flow/brain/.structure/feature-views/<slug>.json`,
 * the file `blueprint brief` reads) and parts, the board asking the bundled CLI
 * through main, and every claim about the map made from computed rectangles.
 *
 * WHAT THE BOARD ASKS MAIN is counted IN MAIN: `blueprint:brief` is wrapped
 * there (the renderer's `window.flow` is a contextBridge proxy, so a spy
 * assigned in the page would silently never run). The wrapper can also hold a
 * read back, which is how "Drawing…" and a stale answer are made to happen.
 *
 * Always run hidden: FLOW_E2E=1 FLOW_E2E_BACKGROUND=1.
 */
import { existsSync, lstatSync, mkdirSync, realpathSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'

import type { ElectronApplication, Locator, Page } from '@playwright/test'

import { HOVER_CLOSE_GRACE_MS, HOVER_GROW_DELAY_MS } from '../../src/renderer/blueprint/cell-hover-model'
import { expect, test } from '../fixtures/electron'
import { activateProject, cleanupSeeds, seedProject } from './fixtures/seed'

const SCREENS =
  process.env['FLOW_E2E_SCREENS'] ??
  join(tmpdir(), 'flow-e2e-screens', 'inplace')
const FEATURE = 'Learning'
const FEATURE_ID = 'feature:learning'
const FEATURE_TEXT = 'Reads modules and records what they do, one pass at a time.'
const PART = 'Learn queue'
const AGENTS = 'Agents'
const AGENTS_ID = 'feature:agents'
/** The feature with no curated view: it grows to its words. */
const PLAIN = 'Connectors'
const PLAIN_TEXT =
  'Connectors — the doors to other tools: each one knows how to sign in, what it can read, and how to say when it cannot reach the other side. ' +
  'A connector keeps its own token, refreshes it before it expires, and backs off when the other side is slow. ' +
  'It reports what it imported, what it skipped and why, so a person can see a sync that half worked. ' +
  'New connectors start read-only until somebody grants them more. ' +
  'Every call it makes is logged with the account it acted for.'
/** The small siblings that make a sweep of many cells possible. */
const SMALL = [
  ['settings', 'Settings'],
  ['search', 'Search'],
  ['sync', 'Sync'],
] as const

test.afterAll(() => cleanupSeeds())

/** The Learning view: five components, labelled wires. "Learn queue" is a part's name too. */
const VIEW = {
  feature: 'learning',
  provenance: 'code',
  generatedAt: '2026-10-07T00:00:00.000Z',
  meta: { title: FEATURE, sub: 'How a module gets read' },
  brief: {},
  views: {
    root: {
      title: FEATURE,
      nodes: [
        { id: 'panel', kind: 'project', title: 'Learning panel', sub: 'board', delta: 'stable' },
        { id: 'queue', kind: 'function', title: PART, sub: 'LearnOrchestrator', delta: 'stable' },
        { id: 'log', kind: 'module', title: 'Activity log', sub: 'learn-log', delta: 'stable' },
        { id: 'cli', kind: 'integration', title: 'Bundled CLI', sub: 'learn --json', delta: 'stable' },
        { id: 'notes', kind: 'datastore', title: 'Feature notes', sub: 'flow/brain', delta: 'stable' },
      ],
      edges: [
        { from: 'panel', to: 'queue', label: 'start a pass', delta: 'kept' },
        { from: 'queue', to: 'cli', label: 'one module', delta: 'kept' },
        { from: 'queue', to: 'log', label: 'append entry', delta: 'kept' },
        { from: 'cli', to: 'notes', label: 'write learnings', delta: 'kept' },
        { from: 'log', to: 'panel', label: 'live rows', delta: 'kept' },
      ],
    },
  },
}

/** The Agents view: three components no other view has — what a stale answer would betray. */
const AGENTS_VIEW = {
  feature: 'agents',
  provenance: 'code',
  generatedAt: '2026-10-07T00:00:00.000Z',
  meta: { title: AGENTS, sub: 'How an agent runs' },
  brief: {},
  views: {
    root: {
      title: AGENTS,
      nodes: [
        { id: 'runner', kind: 'module', title: 'Agent runner', sub: 'run-manager', delta: 'stable' },
        { id: 'store', kind: 'datastore', title: 'Agent store', sub: 'agents.db', delta: 'stable' },
        { id: 'sdk', kind: 'integration', title: 'Agent SDK', sub: 'query()', delta: 'stable' },
      ],
      edges: [
        { from: 'runner', to: 'sdk', label: 'one turn', delta: 'kept' },
        { from: 'runner', to: 'store', label: 'save run', delta: 'kept' },
      ],
    },
  },
}

/** A sibling project's view, for the Workspace map. */
const BILLING_VIEW = {
  feature: 'billing',
  provenance: 'code',
  generatedAt: '2026-10-07T00:00:00.000Z',
  meta: { title: 'Billing', sub: 'How an invoice is made' },
  brief: {},
  views: {
    root: {
      title: 'Billing',
      nodes: [
        { id: 'meter', kind: 'endpoint', title: 'Usage meter', sub: 'meter.ts', delta: 'stable' },
        { id: 'invoice', kind: 'function', title: 'Invoice writer', sub: 'invoice.ts', delta: 'stable' },
        { id: 'ledger', kind: 'datastore', title: 'Ledger table', sub: 'ledger', delta: 'stable' },
      ],
      edges: [
        { from: 'meter', to: 'invoice', label: 'monthly usage', delta: 'kept' },
        { from: 'invoice', to: 'ledger', label: 'post invoice', delta: 'kept' },
      ],
    },
  },
}

/**
 * THE CURATED VIEWS, written once the board is up. `flow/brain/.structure/` is
 * the generated sync class: joining the Workspace copies everything else in but
 * not that, so a view seeded before activation never reaches the linked
 * `flow/` the brief reads. Written through the link once it exists; the brief
 * is read at hover time, so it is there when asked for.
 */
function writeViews(dir: string, views: ReadonlyArray<{ feature: string }>): void {
  const folder = join(dir, 'flow', 'brain', '.structure', 'feature-views')
  mkdirSync(folder, { recursive: true })
  for (const view of views) writeFileSync(join(folder, `${view.feature}.json`), JSON.stringify(view, null, 2))
}

/** `n` lines of real code — a feature's size on the map is the lines it stands on. */
function lines(prefix: string, n: number): string {
  return Array.from({ length: n }, (_, i) => `export const ${prefix}${String(i)} = ${String(i)}`).join('\n') + '\n'
}

function featureNote(slug: string, name: string, text: string): string {
  return ['---', `id: feature:${slug}`, `name: ${name}`, 'kind: core', `anchors: [module:src/${slug}]`, 'relates: []', 'lastFullRead: null', 'patchCount: 0', '---', '', `# ${name}`, '', text, ''].join('\n')
}

function seed(dir: string): void {
  mkdirSync(join(dir, 'src', 'project'), { recursive: true })
  // Real functions, so each story has boxes to draw: the queue's method calls the log's.
  writeFileSync(
    join(dir, 'src', 'project', 'learn-orchestrator.ts'),
    "import { append } from './learn-log'\n\nexport class LearnOrchestrator {\n  run(): void {\n    append('start')\n  }\n}\n",
  )
  writeFileSync(
    join(dir, 'src', 'project', 'learn-log.ts'),
    'export const log: string[] = []\n\nexport function append(entry: string): void {\n  log.push(entry)\n}\n',
  )
  // Weight, so Learning is a cell large enough to read at a glance.
  writeFileSync(join(dir, 'src', 'project', 'learn-constants.ts'), lines('learnStep', 70))
  const features = join(dir, 'flow', 'brain', 'features')
  mkdirSync(features, { recursive: true })
  const siblings: Array<readonly [string, string, string, number]> = [
    ['agents', AGENTS, `${AGENTS} — runs one agent turn at a time.`, 40],
    ['connectors', PLAIN, PLAIN_TEXT, 60],
    // LONG WORDS IN SMALL CELLS: their descriptions clip, so a grown one has
    // more to say than its plain cell does.
    ...SMALL.map(([slug, name]) =>
      [
        slug,
        name,
        `${name} — a small sibling capability that still has a lot to say: what it owns, who calls it, which settings change it, and what it refuses to do when the input is wrong. ` +
          'It keeps a short history of what it changed, so a person can undo the last step, and it says plainly when another part of the app is holding the thing it needs. ' +
          'Nothing it does is silent: every refusal names the reason, and every retry says how long it will wait.',
        18,
      ] as const,
    ),
  ]
  for (const [slug, name, text, size] of siblings) {
    mkdirSync(join(dir, 'src', slug), { recursive: true })
    writeFileSync(join(dir, 'src', slug, 'index.ts'), lines(slug, size))
    writeFileSync(join(features, `${slug}.md`), featureNote(slug, name, text))
  }
  writeFileSync(
    join(features, 'learning.md'),
    [
      '---',
      `id: ${FEATURE_ID}`,
      `name: ${FEATURE}`,
      'kind: core',
      'anchors: [module:src/project]',
      'relates: []',
      'lastFullRead: null',
      'patchCount: 0',
      '---',
      '',
      `# ${FEATURE}`,
      '',
      FEATURE_TEXT,
      '',
      '## Parts',
      '',
      `### ${PART}`,
      'The serial queue that runs learn passes.',
      'anchors: src/project/learn-orchestrator.ts',
      '',
      '### Activity log',
      'What the queue did, newest first.',
      'anchors: src/project/learn-log.ts',
      '',
    ].join('\n'),
  )
  const structure = join(dir, 'flow', 'brain', '.structure')
  mkdirSync(structure, { recursive: true })
  writeFileSync(
    join(structure, 'graph.json'),
    JSON.stringify({
      version: 1,
      derivedAt: '2026-10-07T00:00:00.000Z',
      coverage: { filesScanned: 4, filesTotal: 4, extractorsRun: ['modules'], graphifyEnriched: false },
      nodes: [
        { id: 'module:src', kind: 'module', label: 'src', sourceFile: 'src', meta: { depth: 1 } },
        { id: 'module:src/project', kind: 'module', label: 'project', sourceFile: 'src/project', meta: { depth: 2, fileCount: 3 } },
      ],
      edges: [{ source: 'module:src', target: 'module:src/project', relation: 'contains' }],
      mustReview: [],
    }),
  )
}

/** Many small siblings more: a level squarified into many columns, each cell narrow. */
const MANY = Array.from({ length: 9 }, (_, i) => [`extra${String(i)}`, `Extra ${String(i)}`] as const)

function seedMany(dir: string): void {
  seed(dir)
  const features = join(dir, 'flow', 'brain', 'features')
  for (const [slug, name] of MANY) {
    mkdirSync(join(dir, 'src', slug), { recursive: true })
    writeFileSync(join(dir, 'src', slug, 'index.ts'), lines(slug, 14))
    writeFileSync(join(features, `${slug}.md`), featureNote(slug, name, `${name} — one more small capability.`))
  }
}

/** The sibling project on the Workspace map: Billing has a view, Ledger has none. */
function seedSibling(dir: string): void {
  const features = join(dir, 'flow', 'brain', 'features')
  mkdirSync(features, { recursive: true })
  for (const [slug, name, text, size] of [
    ['billing', 'Billing', 'Billing — meters usage and writes the monthly invoice.', 50],
    ['ledger', 'Ledger', 'Ledger — the append-only record every invoice is posted to. Nothing is ever edited in place: a correction is a new entry that points at the one it corrects, so the history always adds up. Month-end reads it to close the books, and audits read it to prove what was charged and when.', 30],
  ] as const) {
    mkdirSync(join(dir, 'src', slug), { recursive: true })
    writeFileSync(join(dir, 'src', slug, 'index.ts'), lines(slug, size))
    writeFileSync(join(features, `${slug}.md`), featureNote(slug, name, text))
  }
}

async function screenshot(page: Page, name: string): Promise<void> {
  mkdirSync(SCREENS, { recursive: true })
  await page.screenshot({ path: join(SCREENS, `inplace-${name}.png`) })
}

async function theme(page: Page, value: 'light' | 'dark'): Promise<void> {
  await page.evaluate((next) => document.documentElement.setAttribute('data-theme', next), value)
  await page.waitForTimeout(200)
}

/** One state, in both themes. */
async function screenshotBoth(page: Page, name: string): Promise<void> {
  await theme(page, 'dark')
  await screenshot(page, `${name}-dark`)
  await theme(page, 'light')
  await screenshot(page, `${name}-light`)
}

/** Click away every "Not now" ask (the basic-discovery card sits over the sheet's corner). */
async function dismissAsks(page: Page): Promise<void> {
  for (let i = 0; i < 4; i += 1) {
    const notNow = page.getByRole('button', { name: 'Not now' }).first()
    if (!(await notNow.isVisible().catch(() => false))) break
    await notNow.click().catch(() => undefined)
    await page.waitForTimeout(150)
  }
}

/** The seeded project's own feature board — pressed into from the Workspace map when that opens first. */
async function openProjectBoard(page: Page, root: string): Promise<void> {
  const learning = page.locator('.fb-terr-cell', { hasText: FEATURE }).first()
  const folder = basename(root)
  await expectBoardShows(page, folder, learning)
}

/** The retry behind `openProjectBoard`, with a picture of the board kept when it never arrives. */
async function expectBoardShows(page: Page, folder: string, learning: Locator): Promise<void> {
  try {
    await reachProjectBoard(page, folder, learning)
  } catch (error) {
    mkdirSync(SCREENS, { recursive: true })
    await page.screenshot({ path: join(SCREENS, `boot-failure-${folder}.png`) }).catch(() => undefined)
    throw error
  }
}

async function reachProjectBoard(page: Page, folder: string, learning: Locator): Promise<void> {
  await expect(async () => {
    if (await learning.isVisible().catch(() => false)) return
    const countries = page.locator('.fb-ws-country')
    if ((await countries.count()) > 0) {
      const ours = countries.filter({ hasText: folder })
      const country = (await ours.count()) > 0 ? ours.first() : countries.first()
      await country.locator('.fb-ws-name').click({ timeout: 2_000 })
    } else {
      // Up to the Workspace map, so the next pass presses our country and the
      // project's board is read again on the way in.
      const up = page.locator('.flow-board-root .fb-ws-title-up, .flow-board-root .fb-ws-crumb:not(.on)').first()
      if (await up.isVisible().catch(() => false)) await up.click({ timeout: 2_000 }).catch(() => undefined)
    }
    await expect(learning).toBeVisible({ timeout: 10_000 })
  }).toPass({ timeout: 150_000, intervals: [1_000, 2_000, 5_000] })
}

// ── THE MAIN-SIDE SPY on `blueprint:brief` ──────────────────────────────────

interface BriefCall {
  ref: string
  rootId: string
}

/**
 * Wrap main's `blueprint:brief` handler: record every call, and hold a read
 * back for as long as `delays[ref]` says. The real handler still answers.
 */
async function spyOnBriefs(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ ipcMain }) => {
    type Handler = (event: unknown, request: { rootId: string; plan: string; feature?: string }) => unknown
    const g = globalThis as unknown as { __briefSpy?: { calls: unknown[]; delays: Record<string, number> } }
    if (g.__briefSpy !== undefined) return
    const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, Handler> })._invokeHandlers
    const original = handlers.get('blueprint:brief')
    if (original === undefined) throw new Error('there is no blueprint:brief handler to wrap')
    const spy = { calls: [] as Array<{ ref: string; rootId: string }>, delays: {} as Record<string, number> }
    g.__briefSpy = spy
    ipcMain.removeHandler('blueprint:brief')
    ipcMain.handle('blueprint:brief', async (event, request: { rootId: string; plan: string; feature?: string }) => {
      const ref = request.feature ?? request.plan
      spy.calls.push({ ref, rootId: request.rootId })
      const delay = spy.delays[ref] ?? 0
      if (delay > 0) await new Promise((settle) => setTimeout(settle, delay))
      return original(event, request)
    })
  })
}

async function briefCalls(app: ElectronApplication): Promise<BriefCall[]> {
  return app.evaluate(() => {
    const g = globalThis as unknown as { __briefSpy?: { calls: BriefCall[] } }
    return [...(g.__briefSpy?.calls ?? [])]
  })
}

async function holdBrief(app: ElectronApplication, ref: string, ms: number): Promise<void> {
  await app.evaluate((_electron, input) => {
    const g = globalThis as unknown as { __briefSpy?: { delays: Record<string, number> } }
    if (g.__briefSpy !== undefined) g.__briefSpy.delays[input.ref] = input.ms
  }, { ref, ms })
}

/**
 * Wait until `<dir>/flow` is the link into the Workspace AND the project's
 * features read through it — the import copies them in after the link
 * exists, and a brief asked in between is refused ("no feature …"), which the
 * board then keeps for that cell until the next change.
 */
async function waitForWorkspaceLink(dir: string, feature: string, timeout = 120_000): Promise<void> {
  await expect
    .poll(
      () => {
        try {
          return (
            lstatSync(join(dir, 'flow')).isSymbolicLink() &&
            existsSync(join(dir, 'flow', 'brain', 'features', `${feature}.md`))
          )
        } catch {
          return false
        }
      },
      { timeout },
    )
    .toBe(true)
}

/** Seed, open the Blueprint on the project's own board, write the views, start the spy. */
async function boot(page: Page, app: ElectronApplication, prefix: string, seedWith: (dir: string) => void = seed): Promise<string> {
  page.on('console', (message) => {
    if (message.text().includes('no diagram')) console.log(`[board] ${message.text()}`)
  })
  const root = await seedProject(page, prefix, seedWith, { onboarded: true })
  await activateProject(page, root)
  // THE PROJECT IS IN ITS WORKSPACE before anything is measured. Joining moves
  // flow/ behind a link and re-reads the board; on a loaded machine that lands
  // minutes late, and a board measured before it is re-drawn under the test
  // (cells vanish, a brief asked mid-move is refused and kept for that cell).
  const joining = Date.now()
  await waitForWorkspaceLink(root, 'learning', 300_000)
  console.log(`[spec] ${basename(root)} joined its Workspace in ${String(Date.now() - joining)} ms`)
  const terminal = page.locator('[data-view-action="terminal"]')
  if ((await terminal.getAttribute('aria-pressed')) === 'true') await terminal.click()
  await dismissAsks(page)
  await page.locator('[data-view-action="blueprint"]').click()
  await expect(page.locator('.flow-board-root')).toBeVisible()
  await openProjectBoard(page, root)
  // Only once flow/ IS the Workspace link: a view written into the plain
  // folder it replaces is left behind in the renamed backup.
  writeViews(root, [VIEW, AGENTS_VIEW])
  await spyOnBriefs(app)
  // The sheet re-packs as late reads land, and every `blueprint:changed`
  // re-draws it (shrinking any grown cell, dropping the diagram cache — by design).
  // Measure on a quiet board.
  await waitForQuietBoard(page)
  await dismissAsks(page)
  return root
}

/** How long the board must go without a `blueprint:changed` to count as settled. */
const QUIET_MS = 2_500

/**
 * Count `blueprint:changed` broadcasts in the page (a listener added through
 * the preload's own subscribe — calling it is fine; it is assignment to the
 * bridge that silently does nothing), then wait for a quiet spell.
 */
async function waitForQuietBoard(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as {
      __boardChanges?: { count: number; last: number }
      flow: { blueprint: { onChanged(listener: () => void): unknown } }
    }
    if (w.__boardChanges !== undefined) return
    const changes = { count: 0, last: Date.now() }
    w.__boardChanges = changes
    w.flow.blueprint.onChanged(() => {
      changes.count += 1
      changes.last = Date.now()
    })
  })
  await expect
    .poll(() => page.evaluate(() => Date.now() - ((window as unknown as { __boardChanges: { last: number } }).__boardChanges.last)), {
      timeout: 60_000,
      intervals: [500],
    })
    .toBeGreaterThan(QUIET_MS)
  await page.waitForTimeout(500)
}

/** How many `blueprint:changed` broadcasts the page has seen since `waitForQuietBoard`. */
async function boardChanges(page: Page): Promise<number> {
  return page.evaluate(() => (window as unknown as { __boardChanges?: { count: number } }).__boardChanges?.count ?? 0)
}

// ── MEASURING ───────────────────────────────────────────────────────────────

type Box = { x: number; y: number; w: number; h: number }

function exactly(name: string): RegExp {
  return new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`)
}

/** A cell by its NAME, exactly — a grown neighbour's diagram may say the same words. */
const terrCell = (page: Page, name: string): Locator =>
  page.locator('.fb-terr-cell', { has: page.locator(':scope > .fb-terr-cell-name', { hasText: exactly(name) }) }).first()
const wsCell = (page: Page, name: string): Locator =>
  page.locator('.fb-ws-cell', { has: page.locator(':scope > .fb-terr-cell-name', { hasText: exactly(name) }) }).first()
const grown = (page: Page): Locator => page.locator('.fb-terr-cell.fb-terr-grown')
const grownWithDiagram = (page: Page): Locator => page.locator('.fb-terr-cell.fb-terr-grown[data-grown-diagram]')

const area = (box: Box): number => box.w * box.h
const centreOf = (box: Box): { x: number; y: number } => ({ x: box.x + box.w / 2, y: box.y + box.h / 2 })
const holds = (box: Box, point: { x: number; y: number }): boolean =>
  point.x >= box.x && point.x <= box.x + box.w && point.y >= box.y && point.y <= box.y + box.h
function unionOf(boxes: readonly Box[]): Box {
  const left = Math.min(...boxes.map((box) => box.x))
  const top = Math.min(...boxes.map((box) => box.y))
  const right = Math.max(...boxes.map((box) => box.x + box.w))
  const bottom = Math.max(...boxes.map((box) => box.y + box.h))
  return { x: left, y: top, w: right - left, h: bottom - top }
}
function expectNear(actual: Box | undefined, expected: Box, slack = 1): void {
  expect(actual).toBeDefined()
  const box = actual as Box
  expect(Math.abs(box.x - expected.x)).toBeLessThanOrEqual(slack)
  expect(Math.abs(box.y - expected.y)).toBeLessThanOrEqual(slack)
  expect(Math.abs(box.w - expected.w)).toBeLessThanOrEqual(slack)
  expect(Math.abs(box.h - expected.h)).toBeLessThanOrEqual(slack)
}

/** Every cell's rectangle on the sheet, keyed by its Workspace key or feature id. */
async function cellRects(page: Page): Promise<Record<string, Box>> {
  return page.evaluate(() => {
    const out: Record<string, { x: number; y: number; w: number; h: number }> = {}
    for (const el of document.querySelectorAll<HTMLElement>('.fb-terr-cell')) {
      const r = el.getBoundingClientRect()
      out[el.dataset['wsCell'] ?? el.dataset['featureId'] ?? el.textContent ?? ''] = { x: r.x, y: r.y, w: r.width, h: r.height }
    }
    return out
  })
}

/** Every Workspace country's rectangle, by project slug. */
async function countryRects(page: Page): Promise<Record<string, Box>> {
  return page.evaluate(() => {
    const out: Record<string, { x: number; y: number; w: number; h: number }> = {}
    for (const el of document.querySelectorAll<HTMLElement>('.fb-ws-country')) {
      const r = el.getBoundingClientRect()
      out[el.dataset['wsProject'] ?? ''] = { x: r.x, y: r.y, w: r.width, h: r.height }
    }
    return out
  })
}

async function boxOf(locator: Locator): Promise<Box> {
  return locator.evaluate((el) => {
    const r = el.getBoundingClientRect()
    return { x: r.x, y: r.y, w: r.width, h: r.height }
  })
}

/** Until no cell, country or group is still sliding to its new rectangle. */
async function waitSettled(page: Page): Promise<void> {
  await page.waitForFunction(
    () =>
      document
        .getAnimations()
        .every(
          (animation) =>
            !(animation instanceof CSSTransition) ||
            !['left', 'top', 'width', 'height'].includes(animation.transitionProperty) ||
            animation.playState !== 'running',
        ),
    undefined,
    { timeout: 10_000 },
  )
  await page.waitForTimeout(60)
}

/** The grown cell, measured: its rect, the level's, and what it drew INSIDE itself. */
async function measureGrown(page: Page): Promise<{
  cell: Box
  cards: number
  wires: number
  labels: number
  titles: string[]
  cardsInside: boolean
  xs: number
  /** The smallest a diagram card is drawn, against its natural size. */
  scale: number
}> {
  return page.evaluate(() => {
    const el = document.querySelector<HTMLElement>('.fb-terr-cell.fb-terr-grown') as HTMLElement
    const r = el.getBoundingClientRect()
    const cards = [...el.querySelectorAll<HTMLElement>('.fb-curated-card')]
    const inside = cards.every((card) => {
      const c = card.getBoundingClientRect()
      const x = c.x + c.width / 2
      const y = c.y + c.height / 2
      return x >= r.x && x <= r.x + r.width && y >= r.y && y <= r.y + r.height
    })
    return {
      cell: { x: r.x, y: r.y, w: r.width, h: r.height },
      cards: cards.length,
      wires: el.querySelectorAll('.fb-curated-wire').length,
      labels: el.querySelectorAll('.fb-curated-wire-label').length,
      titles: cards.map((card) => card.textContent ?? ''),
      cardsInside: cards.length > 0 && inside,
      xs: new Set(cards.map((card) => Math.round(card.getBoundingClientRect().x))).size,
      scale: Math.min(...cards.map((card) => card.getBoundingClientRect().width / Math.max(1, card.offsetWidth))),
    }
  })
}

/**
 * Every shrunk cell still prints its name, inside its own rectangle, and the
 * cell is inside the viewport — tidy, not vanished.
 */
async function expectShrunkNamesReadable(page: Page): Promise<number> {
  const report = await page.evaluate(() => {
    const out: Array<{ name: string; ok: boolean; why: string }> = []
    for (const el of document.querySelectorAll<HTMLElement>('.fb-terr-cell.fb-terr-shrunk')) {
      const name = el.querySelector<HTMLElement>(':scope > .fb-terr-cell-name')
      const r = el.getBoundingClientRect()
      const n = name?.getBoundingClientRect()
      const shown = name !== null && getComputedStyle(name).display !== 'none' && n !== undefined && n.width > 8 && n.height > 6
      const within = n !== undefined && n.x >= r.x - 1 && n.y >= r.y - 1 && n.y + n.height <= r.y + r.height + 1
      const onScreen = r.x >= 0 && r.y >= 0 && r.x + r.width <= window.innerWidth + 1 && r.y + r.height <= window.innerHeight + 1
      out.push({ name: name?.textContent ?? '', ok: shown && within && onScreen, why: `${String(shown)}/${String(within)}/${String(onScreen)} ${String(Math.round(r.width))}x${String(Math.round(r.height))}` })
    }
    return out
  })
  for (const entry of report) expect(entry.ok, `${entry.name}: ${entry.why}`).toBe(true)
  return report.length
}


/** Close whatever cell is open — Escape from inside it — until nothing is grown. */
async function closeAll(page: Page): Promise<void> {
  for (let i = 0; i < 3 && (await grown(page).count()) > 0; i += 1) {
    await grown(page).first().focus().catch(() => undefined)
    await page.keyboard.press('Escape')
    await expect(grown(page)).toHaveCount(0, { timeout: 3_000 }).catch(() => undefined)
  }
  await expect(grown(page)).toHaveCount(0, { timeout: 3_000 })
}

/**
 * CLICK `cell` OPEN — grown in place and pinned with its diagram, or grown to
 * its words only. Always from a closed map: a click on an open cell with no
 * diagram goes IN, which is not what this helper is for.
 */
async function openCell(page: Page, cell: Locator, diagram: boolean, position = { x: 20, y: 20 }): Promise<void> {
  await expect(async () => {
    await closeAll(page)
    await waitSettled(page)
    await cell.click({ position, timeout: 2_000 })
    if (diagram) {
      await expect(cell).toHaveAttribute('data-grown-diagram', /.+/, { timeout: 30_000 })
      await expect(cell).toHaveClass(/fb-terr-pinned/, { timeout: 5_000 })
    } else {
      // Its words — and, when it can be learned here, the offer to learn it.
      await expect(cell.locator('.fb-terr-grow:is(.fb-terr-grow-describe, .fb-terr-grow-empty)')).toHaveCount(1, { timeout: 30_000 })
    }
    await expect(cell).toHaveClass(/fb-terr-grown/)
  }).toPass({ timeout: 120_000 })
  await waitSettled(page)
  // The opening camera glides (200 ms); measure once it is there.
  if (diagram) await page.waitForTimeout(350)
}

/** Double-click into Learning; its parts are the level on screen. */
async function diveIntoLearning(page: Page): Promise<void> {
  await expect(async () => {
    await closeAll(page)
    await terrCell(page, FEATURE).dblclick({ position: { x: 20, y: 20 }, timeout: 2_000 })
    await expect(terrCell(page, PART)).toBeVisible({ timeout: 5_000 })
  }).toPass({ timeout: 90_000 })
  await page.mouse.move(2, 2)
  await page.waitForTimeout(1_000)
  await waitSettled(page)
}

/** Record, in the page, the key of every cell that is ever grown. */
async function watchGrows(page: Page): Promise<void> {
  await page.evaluate(() => {
    const keys: string[] = []
    ;(window as unknown as { __grown: string[] }).__grown = keys
    new MutationObserver((records) => {
      for (const record of records) {
        const el = record.target
        if (!(el instanceof HTMLElement) || !el.classList.contains('fb-terr-grown')) continue
        if (record.oldValue !== null && record.oldValue.split(' ').includes('fb-terr-grown')) continue
        keys.push(el.dataset['hoverKey'] ?? el.dataset['featureId'] ?? '')
      }
    }).observe(document.querySelector('.fb-stage') as HTMLElement, {
      subtree: true,
      attributes: true,
      attributeFilter: ['class'],
      attributeOldValue: true,
    })
  })
}

async function grownKeys(page: Page): Promise<string[]> {
  return page.evaluate(() => [...(window as unknown as { __grown: string[] }).__grown])
}

/**
 * Stand in for main's `learn:generateFeatureView` — record the request, start
 * no pass. A real pass spends minutes of model time; what this spec claims is
 * only that the Learn door's press REACHED main.
 */
async function stubFeatureViewPass(app: ElectronApplication, holdMs = 0): Promise<void> {
  await app.evaluate(({ ipcMain }, hold) => {
    const g = globalThis as unknown as { __learnCalls?: unknown[] }
    if (g.__learnCalls !== undefined) return
    const calls: unknown[] = []
    g.__learnCalls = calls
    ipcMain.removeHandler('learn:generateFeatureView')
    // HELD, a pass is still running while the spec looks at the board.
    ipcMain.handle('learn:generateFeatureView', async (_event, request: unknown) => {
      calls.push(request)
      if (hold > 0) await new Promise((settle) => setTimeout(settle, hold))
    })
  }, holdMs)
}

async function learnCalls(app: ElectronApplication): Promise<Array<{ featureRef?: string }>> {
  return app.evaluate(() => [...((globalThis as unknown as { __learnCalls?: Array<{ featureRef?: string }> }).__learnCalls ?? [])])
}

/** A point inside `cell` that is the cell itself — no button, no diagram card. */
async function plainPointOf(cell: Locator): Promise<{ x: number; y: number }> {
  const point = await cell.evaluate((el) => {
    const r = el.getBoundingClientRect()
    for (let fy = 0.2; fy < 0.9; fy += 0.1) {
      for (let fx = 0.2; fx < 0.9; fx += 0.1) {
        const x = r.x + r.width * fx
        const y = r.y + r.height * fy
        const hit = document.elementFromPoint(x, y)
        if (hit !== null && el.contains(hit) && hit.closest('button') === null) return { x, y }
      }
    }
    return null
  })
  expect(point).not.toBeNull()
  return point as { x: number; y: number }
}

const pinned = (page: Page): Locator => page.locator('.fb-terr-cell.fb-terr-pinned')

/** Every cell's opacity, by key — the dimmed map around a pinned cell. */
async function cellOpacities(page: Page): Promise<Record<string, number>> {
  return page.evaluate(() => {
    const out: Record<string, number> = {}
    for (const el of document.querySelectorAll<HTMLElement>('.fb-terr-cell')) {
      out[el.dataset['wsCell'] ?? el.dataset['featureId'] ?? ''] = Number(getComputedStyle(el).opacity)
    }
    return out
  })
}

// ─────────────────────────────────────────────────────────────────────────────

test('a click opens a feature in place: the SAME cell grown and pinned, its diagram inside; the X puts the map back', async ({ window: page, app }) => {
  test.setTimeout(600_000)
  await boot(page, app, 'flow-ux-inplace-')
  const cell = terrCell(page, FEATURE)

  // ── THE DOORS: Learn stays (positive first), the diagram door is gone. ──
  await expect(cell.locator('.fb-terr-learn-btn')).toHaveCount(1)
  await expect(page.locator('.fb-terr-cell [data-open-level]')).toHaveCount(0)

  await waitSettled(page)
  const before = await cellRects(page)
  const level = unionOf(Object.values(before))
  const handle = await cell.elementHandle()
  expect(handle).not.toBeNull()

  await openCell(page, cell, true)
  // THE SAME ELEMENT grew — not a copy of it drawn somewhere else.
  expect(await (handle as NonNullable<typeof handle>).evaluate((el) => el.isConnected && el.classList.contains('fb-terr-grown'))).toBe(true)
  expect(await (handle as NonNullable<typeof handle>).getAttribute('data-grown-diagram')).toBe(FEATURE)
  const during = await cellRects(page)
  expect(Object.keys(during).sort()).toEqual(Object.keys(before).sort())
  const mine = during[FEATURE_ID] as Box
  const was = before[FEATURE_ID] as Box
  // Most of the level — at least half its width AND height — and still where it was.
  expect(area(mine) / area(level)).toBeGreaterThanOrEqual(0.45)
  expect(mine.w).toBeGreaterThanOrEqual(level.w * 0.5 - 1)
  expect(mine.h).toBeGreaterThanOrEqual(level.h * 0.5 - 1)
  expect(holds(mine, centreOf(was))).toBe(true)
  // Every other cell is smaller than it was, and still readable.
  for (const [id, box] of Object.entries(before)) {
    if (id === FEATURE_ID) continue
    expect(area(during[id] as Box), id).toBeLessThan(area(box))
  }
  expect(await expectShrunkNamesReadable(page)).toBe(Object.keys(before).length - 1)
  // OPENED STRAIGHT INTO EXPLORING: the ring, the toolbar, the map dimmed.
  await expect(cell).toHaveClass(/fb-terr-pinned/)
  const bar = cell.locator('.fb-terr-pin-bar')
  await expect(bar).toBeVisible()
  await expect(bar.getByRole('button', { name: 'Zoom in' })).toBeVisible()
  await expect(bar.getByRole('button', { name: 'Show the whole diagram' })).toBeVisible()
  await expect(bar.getByRole('button', { name: `Open ${FEATURE}` })).toBeVisible()
  const close = bar.locator('.fb-terr-pin-close')
  await expect(close).toBeVisible()
  await expect(close).toHaveAttribute('aria-label', 'Close')
  await expect(close.locator('svg')).toHaveCount(1)
  // No Unpin any more (positive above: the toolbar is there).
  await expect(bar.getByRole('button', { name: /^Unpin/ })).toHaveCount(0)
  expect(await cell.evaluate((el) => getComputedStyle(el).outlineStyle)).toBe('solid')
  const opacity = await cellOpacities(page)
  expect(opacity[FEATURE_ID]).toBe(1)
  for (const [id, value] of Object.entries(opacity)) if (id !== FEATURE_ID) expect(value, id).toBeLessThan(1)
  // THE DIAGRAM IS INSIDE THE CELL, readable.
  const measured = await measureGrown(page)
  expect(measured.cards).toBe(VIEW.views.root.nodes.length)
  expect(measured.wires).toBeGreaterThan(0)
  expect(measured.labels).toBeGreaterThan(0)
  expect(measured.scale).toBeGreaterThanOrEqual(0.6)
  await expect(cell.locator('.fb-terr-grow-desc')).toHaveText(FEATURE_TEXT)
  // Positive above; and NO card, no overlay, no floating tip anywhere.
  await expect(page.locator('.fb-hover-card')).toHaveCount(0)
  await expect(page.locator('.fb-hover-tip')).toHaveCount(0)
  await screenshotBoth(page, 'feature')

  // ── THE POINTER LEAVING CHANGES NOTHING: it is open until it is closed. ──
  await page.mouse.move(2, 2, { steps: 4 })
  await page.waitForTimeout(HOVER_CLOSE_GRACE_MS * 4)
  await expect(cell).toHaveClass(/fb-terr-pinned/)

  // ── THE X PUTS THE MAP BACK, every rectangle where it was. ──
  await close.click()
  await expect(grown(page)).toHaveCount(0, { timeout: 3_000 })
  await expect(pinned(page)).toHaveCount(0)
  await waitSettled(page)
  const after = await cellRects(page)
  for (const [id, box] of Object.entries(before)) expectNear(after[id], box)
  await expect(cell.locator('.fb-terr-grow')).toHaveCount(0)
  for (const value of Object.values(await cellOpacities(page))) expect(value).toBe(1)
  // Closing went nowhere: the same level.
  await expect(terrCell(page, PART)).toHaveCount(0)

  // ── A PART: its slice — its component and the components it connects to. ──
  await diveIntoLearning(page)
  const partBefore = await cellRects(page)
  const partLevel = unionOf(Object.values(partBefore))
  const part = terrCell(page, PART)
  const partId = await part.getAttribute('data-feature-id')
  await openCell(page, part, true)
  await screenshotBoth(page, 'part')
  const slice = await measureGrown(page)
  // Learn queue + panel, CLI and log — the three it is wired to.
  expect(slice.cards).toBe(4)
  expect(slice.wires).toBeGreaterThan(0)
  expect(slice.scale).toBeGreaterThanOrEqual(0.6)
  const partNow = (await cellRects(page))[partId ?? ''] as Box
  expect(area(partNow) / area(partLevel)).toBeGreaterThanOrEqual(0.45)
  expect(holds(partNow, centreOf(partBefore[partId ?? ''] as Box))).toBe(true)

  // ── ESCAPE PUTS IT BACK — and only it: the level stays. ──
  await part.focus()
  await page.keyboard.press('Escape')
  await expect(grown(page)).toHaveCount(0, { timeout: 3_000 })
  await expect(part).toBeVisible()
  await expect(page.locator('.fb-story')).toHaveCount(0)
  await waitSettled(page)
  const back = await cellRects(page)
  for (const [id, box] of Object.entries(partBefore)) expectNear(back[id], box)
})

test('an opened cell is at least half the level wide AND tall, on a level of many narrow columns', async ({ window: page, app }) => {
  test.setTimeout(600_000)
  await boot(page, app, 'flow-ux-half-', seedMany)
  await waitSettled(page)
  const before = await cellRects(page)
  const level = unionOf(Object.values(before))
  // Positive first: this level really is many cells, and the ones tried are
  // narrow or short before they open — the claim below is not free.
  expect(Object.keys(before).length).toBeGreaterThanOrEqual(12)
  for (const [name, diagram] of [
    [SMALL[0][1], false],
    [MANY[4][1], false],
    [AGENTS, true],
  ] as const) {
    const cell = terrCell(page, name)
    const id = (await cell.getAttribute('data-feature-id')) ?? ''
    const was = before[id] as Box
    expect(was, name).toBeDefined()
    expect(was.w < level.w * 0.5 || was.h < level.h * 0.5, `${name} was already half the level`).toBe(true)
    await openCell(page, cell, diagram, { x: 6, y: 6 })
    const now = (await cellRects(page))[id] as Box
    expect(now.w, `${name} width`).toBeGreaterThanOrEqual(level.w * 0.5 - 1)
    expect(now.h, `${name} height`).toBeGreaterThanOrEqual(level.h * 0.5 - 1)
    expect(holds(now, centreOf(was)), `${name} still where it was`).toBe(true)
    // The neighbours are still on the sheet — small tiles, not gone.
    const during = await cellRects(page)
    for (const key of Object.keys(before)) {
      const box = during[key] as Box
      expect(box.w, key).toBeGreaterThan(0)
      expect(box.h, key).toBeGreaterThan(0)
    }
    if (name === AGENTS) await screenshotBoth(page, 'opened-half')
    await closeAll(page)
  }
})

test('a cell with no diagram opens to its words and its Learn offer; a second click goes in', async ({ window: page, app }) => {
  test.setTimeout(600_000)
  await boot(page, app, 'flow-ux-plain-')
  // Held long enough to look at the cell while its pass is running.
  await stubFeatureViewPass(app, 60_000)
  const cell = terrCell(page, PLAIN)
  const door = cell.locator(':scope > .fb-terr-learn-btn')
  // The corner door is there at rest (positive first).
  await expect(door).toHaveCount(1)
  const doorShown = (): Promise<boolean> => door.evaluate((el) => getComputedStyle(el).display !== 'none')
  expect(await doorShown()).toBe(true)
  await waitSettled(page)
  const before = await boxOf(cell)
  await openCell(page, cell, false)
  // The brief WAS asked (positive), and answered with no curated view.
  expect((await briefCalls(app)).filter((call) => call.ref === 'feature:connectors').length).toBe(1)
  const after = await boxOf(cell)
  expect(area(after)).toBeGreaterThan(area(before) * 1.5)
  expect(holds(after, centreOf(before))).toBe(true)
  // Its words (the graph's summary of them — well past four lines)…
  const words = cell.locator('.fb-terr-grow-desc')
  await expect(words).toBeVisible()
  await expect(words).toContainText(PLAIN_TEXT.slice(0, 180))
  // …and the offer: a plain sentence and a clear button, in the middle of the cell.
  const offer = cell.locator('.fb-terr-grow-learn-btn')
  await expect(offer).toBeVisible()
  await expect(offer).toHaveText('Learn this feature')
  // The corner door's own brain mark, inside the button, in the label's colour.
  const mark = offer.locator('svg.fb-terr-control-mark')
  await expect(mark).toHaveCount(1)
  const markLook = await offer.evaluate((el) => {
    const svg = el.querySelector('svg.fb-terr-control-mark') as SVGSVGElement
    const path = svg.querySelector('path') as SVGPathElement
    const r = svg.getBoundingClientRect()
    return { w: r.width, h: r.height, stroke: getComputedStyle(path).stroke, color: getComputedStyle(el).color, first: el.firstElementChild === svg }
  })
  expect(markLook.first).toBe(true)
  expect(markLook.w).toBeGreaterThanOrEqual(12)
  expect(markLook.w).toBeLessThanOrEqual(16)
  expect(markLook.stroke).toBe(markLook.color)
  await expect(cell.locator('.fb-terr-grow-learn-note')).toContainText("hasn't learned this feature yet")
  const button = await boxOf(offer)
  const middle = centreOf(after)
  expect(Math.abs(centreOf(button).x - middle.x)).toBeLessThan(after.w * 0.1)
  expect(centreOf(button).y).toBeGreaterThan(after.y + after.h * 0.25)
  expect(centreOf(button).y).toBeLessThan(after.y + after.h * 0.85)
  // Positive first (above); THEN: the corner door has given way, nothing
  // pretends to be a diagram, and nothing is pinned — there is nothing to explore.
  expect(await doorShown()).toBe(false)
  await expect(cell.locator('.fb-curated')).toHaveCount(0)
  await expect(cell.locator('.fb-terr-grow-drawing')).toHaveCount(0)
  expect(await cell.getAttribute('data-grown-diagram')).toBeNull()
  await expect(pinned(page)).toHaveCount(0)
  await expect(cell.locator('.fb-terr-pin-bar')).toHaveCount(0)
  await expect(page.locator('.fb-hover-card')).toHaveCount(0)
  await screenshotBoth(page, 'learn-offer')

  // ── THE POINTER LEAVING CHANGES NOTHING; A CLICK OUTSIDE CLOSES IT. ──
  await page.mouse.move(2, 2, { steps: 4 })
  await page.waitForTimeout(HOVER_CLOSE_GRACE_MS * 4)
  await expect(cell).toHaveClass(/fb-terr-grown/)
  const agentsAt = await plainPointOf(terrCell(page, AGENTS))
  await page.mouse.click(agentsAt.x, agentsAt.y)
  await expect(grown(page)).toHaveCount(0, { timeout: 3_000 })
  await page.waitForTimeout(800)
  // Swallowed: Agents has no parts, so a press would have opened its story.
  await expect(page.locator('.fb-story')).toHaveCount(0)
  await waitSettled(page)
  expect(await doorShown()).toBe(true)
  await expect(cell.locator('.fb-terr-grow')).toHaveCount(0)

  // ── THE SECOND CLICK GOES IN: Connectors has no parts, so its code story. ──
  await openCell(page, cell, false)
  await cell.locator(':scope > .fb-terr-cell-name').click()
  await expect(page.locator('.fb-story')).toHaveCount(1, { timeout: 10_000 })
  await expect(page.locator('.fb-story-head .fb-story-crumb.on')).toHaveText(PLAIN, { timeout: 60_000 })
  await page.keyboard.press('Escape')
  await expect(page.locator('.fb-story')).toHaveCount(0)
  await expect(cell).toBeVisible()

  // ── PRESSING THE OFFER IS THE LEARN DOOR'S PRESS — Learn, not a dive. ──
  await openCell(page, cell, false)
  const centre = centreOf(await boxOf(offer))
  await page.mouse.click(centre.x, centre.y)
  await expect.poll(async () => (await learnCalls(app)).map((call) => call.featureRef), { timeout: 15_000 }).toContain('feature:connectors')
  await expect(cell.locator('.fb-terr-grow-learn-running')).toBeVisible()
  await expect(cell.locator('.fb-terr-grow-learn-running')).toHaveText('Learning this feature…')
  await expect(offer).toBeHidden()
  await expect(page.locator('.fb-story')).toHaveCount(0)
  await screenshotBoth(page, 'learn-offer-pressed')

  // CLOSING PUTS THE CORNER DOOR BACK.
  await closeAll(page)
  await waitSettled(page)
  expect(await doorShown()).toBe(true)
  await expect(cell.locator('.fb-terr-grow')).toHaveCount(0)
})

test('"Drawing…" shows inside the opened cell while the diagram is read, then the diagram replaces it, pinned', async ({ window: page, app }) => {
  test.setTimeout(600_000)
  await boot(page, app, 'flow-ux-drawing-')
  await holdBrief(app, FEATURE_ID, 2_500)
  const cell = terrCell(page, FEATURE)
  await waitSettled(page)
  await cell.click({ position: { x: 20, y: 20 } })
  // Held in main: the cell has grown, says so, and has drawn nothing yet.
  await expect(cell.locator('.fb-terr-grow-drawing')).toHaveText('Drawing…', { timeout: 5_000 })
  await expect(cell).toHaveClass(/fb-terr-grown/)
  await expect(cell.locator('.fb-curated-card')).toHaveCount(0)
  await waitSettled(page)
  await screenshotBoth(page, 'drawing')
  // The read lands: the diagram, "Drawing…" gone — and pinned, as the click asked.
  await expect(cell).toHaveAttribute('data-grown-diagram', FEATURE, { timeout: 15_000 })
  await expect(cell.locator('.fb-terr-grow-drawing')).toHaveCount(0)
  await expect(cell.locator('.fb-curated-card')).toHaveCount(VIEW.views.root.nodes.length)
  await expect(cell).toHaveClass(/fb-terr-pinned/, { timeout: 5_000 })
  await expect(cell.locator('.fb-terr-pin-bar')).toBeVisible()
  expect((await briefCalls(app)).filter((call) => call.ref === FEATURE_ID).length).toBe(1)
})

test('a stale answer never paints: B opened never shows A\'s diagram', async ({ window: page, app }) => {
  test.setTimeout(600_000)
  await boot(page, app, 'flow-ux-stale-')
  const HELD_MS = 4_000
  await holdBrief(app, FEATURE_ID, HELD_MS)
  const learning = terrCell(page, FEATURE)
  await waitSettled(page)
  await learning.click({ position: { x: 20, y: 20 } })
  await expect(learning.locator('.fb-terr-grow-drawing')).toBeVisible({ timeout: 5_000 })
  await waitSettled(page)

  // A click on B — shrunk beside the open A — only closes A (swallowed on the map)…
  const agents = terrCell(page, AGENTS)
  const first = await plainPointOf(agents)
  await page.mouse.click(first.x, first.y)
  await expect(grown(page)).toHaveCount(0, { timeout: 3_000 })
  await expect(page.locator('.fb-story')).toHaveCount(0)
  await waitSettled(page)
  // …and the next opens B.
  const point = await plainPointOf(agents)
  await page.mouse.click(point.x, point.y)
  await expect(agents).toHaveAttribute('data-grown-diagram', AGENTS, { timeout: 15_000 })
  await expect(agents.locator('.fb-curated-card')).toHaveCount(AGENTS_VIEW.views.root.nodes.length)
  // It grew from where it was drawn: the point clicked is still inside it.
  await waitSettled(page)
  expect(holds(await boxOf(agents), point)).toBe(true)

  // A's read lands while B is open — and is dropped.
  await page.waitForTimeout(HELD_MS + 1_000)
  expect((await briefCalls(app)).filter((call) => call.ref === FEATURE_ID).length).toBe(1) // positive: it was in flight
  await expect(grown(page)).toHaveCount(1)
  await expect(agents).toHaveAttribute('data-grown-diagram', AGENTS)
  const titles = (await measureGrown(page)).titles.join(' | ')
  expect(titles).toContain('Agent runner')
  for (const node of VIEW.views.root.nodes) expect(titles).not.toContain(node.title)
  await expect(learning.locator('.fb-curated')).toHaveCount(0)
  await screenshotBoth(page, 'stale-dropped')
})

/** The details size a hover grows a cell to (`DETAILS_TARGET`), as drawn. */
const DETAILS_W = 320
const DETAILS_H = 230

/** Hover `cell` from outside, at `at` (or its centre), until its details are grown. */
async function hoverDetails(page: Page, cell: Locator, at?: { x: number; y: number }): Promise<void> {
  await expect(async () => {
    if ((await cell.getAttribute('class'))?.includes('fb-terr-grown') === true) return
    await page.mouse.move(2, 2)
    await page.waitForTimeout(HOVER_CLOSE_GRACE_MS * 2)
    const point = at ?? centreOf(await boxOf(cell))
    await page.mouse.move(point.x, point.y, { steps: 4 })
    await expect(cell).toHaveClass(/fb-terr-grown/, { timeout: HOVER_GROW_DELAY_MS * 6 })
  }).toPass({ timeout: 60_000 })
  await expect(cell.locator('.fb-terr-grow-details')).toHaveCount(1)
  await waitSettled(page)
}

test('at rest: a card is its name, one home line, its description and its foot — no rows', async ({ window: page, app }) => {
  test.setTimeout(600_000)
  await boot(page, app, 'flow-ux-calm-')
  await waitSettled(page)
  const learning = terrCell(page, FEATURE)
  // Positive first: the card is roomy, has a description to tell and folders to list.
  await expect(learning).toHaveClass(/fb-terr-roomy/)
  await expect(learning.locator(':scope > .fb-terr-cell-name')).toHaveText(FEATURE)
  await expect(learning.locator('.fb-terr-folder-line')).toHaveCount(1)
  await expect(learning.locator('.fb-terr-folder-line')).toHaveText(/^project \d+%$/)
  await expect(learning.locator(':scope > .fb-terr-cell-kicker')).toBeVisible()
  // …at rest it prints its description (2026-10-08: "by default we need show
  // the description") and no folder rows — on ANY card.
  await expect(learning.locator('.fb-terr-cell-summary')).toHaveText(FEATURE_TEXT)
  await expect(page.locator('.fb-terr-cell :is(.fb-terr-folders, .fb-terr-folder-row)')).toHaveCount(0)
  expect(
    await page.evaluate(() => [...document.querySelectorAll('.fb-terr-cell')].every((el) => el.querySelectorAll('.fb-terr-folder-line').length <= 1)),
  ).toBe(true)
  await page.mouse.move(2, 2)
  await screenshotBoth(page, 'calm-rest')
})

test('hovering grows a details cell IN PLACE — the others move, nothing is read — and leaving restores every rect', async ({ window: page, app }) => {
  test.setTimeout(600_000)
  await boot(page, app, 'flow-ux-details-')
  await watchGrows(page)
  await page.mouse.move(2, 2)
  await waitSettled(page)
  const before = await cellRects(page)
  const level = unionOf(Object.values(before))
  const small = terrCell(page, SMALL[0][1])
  const id = (await small.getAttribute('data-feature-id')) ?? ''
  const was = before[id] as Box
  // Positive first: the cell really is smaller than its details at rest.
  expect(was.w < DETAILS_W || was.h < DETAILS_H, `${SMALL[0][1]} is already as big as its details`).toBe(true)
  const readsBefore = (await briefCalls(app)).length

  await hoverDetails(page, small)
  // THE SAME ELEMENT grew, in place: big enough for its details, and no further than an opened cell.
  const during = await cellRects(page)
  expect(Object.keys(during).sort()).toEqual(Object.keys(before).sort())
  const mine = during[id] as Box
  expect(mine.w).toBeGreaterThanOrEqual(Math.min(DETAILS_W, level.w) - 2)
  expect(mine.h).toBeGreaterThanOrEqual(Math.min(DETAILS_H, level.h) - 2)
  expect(area(mine) / area(level)).toBeLessThan(0.45)
  expect(holds(mine, centreOf(was))).toBe(true)
  // THE OTHERS MOVED AROUND IT: some cell's rectangle changed, every one still
  // inside the level and none on top of the grown one.
  let moved = 0
  for (const [key, box] of Object.entries(before)) {
    if (key === id) continue
    const now = during[key] as Box
    if (Math.abs(now.x - box.x) + Math.abs(now.y - box.y) + Math.abs(now.w - box.w) + Math.abs(now.h - box.h) > 2) moved += 1
    expect(now.x, key).toBeGreaterThanOrEqual(level.x - 1)
    expect(now.y, key).toBeGreaterThanOrEqual(level.y - 1)
    expect(now.x + now.w, key).toBeLessThanOrEqual(level.x + level.w + 1)
    expect(now.y + now.h, key).toBeLessThanOrEqual(level.y + level.h + 1)
    const apart = now.x + now.w <= mine.x + 1 || mine.x + mine.w <= now.x + 1 || now.y + now.h <= mine.y + 1 || mine.y + mine.h <= now.y + 1
    expect(apart, `${key} overlaps the details cell`).toBe(true)
  }
  expect(moved).toBeGreaterThan(0)
  // ITS DETAILS: its words, no diagram frame, no pin; and main was asked nothing.
  await expect(small.locator('.fb-terr-grow-details .fb-terr-grow-desc')).toContainText(`${SMALL[0][1]} — a small sibling capability`)
  await expect(small.locator('.fb-terr-grow-diagram')).toHaveCount(0)
  await expect(small).not.toHaveAttribute('data-grown-diagram', /.*/)
  await expect(pinned(page)).toHaveCount(0)
  expect((await briefCalls(app)).length - readsBefore).toBe(0)
  // Only this cell ever grew (a re-render may grow it again — still only it).
  expect([...new Set(await grownKeys(page))]).toEqual([id])
  await screenshotBoth(page, 'details')

  // ── LEAVING PUTS THE MAP BACK, every rectangle where it was. ──
  await page.mouse.move(2, 2, { steps: 4 })
  await expect(grown(page)).toHaveCount(0, { timeout: HOVER_CLOSE_GRACE_MS * 10 })
  await waitSettled(page)
  const after = await cellRects(page)
  for (const [key, box] of Object.entries(before)) expectNear(after[key], box)
  await expect(small.locator('.fb-terr-grow')).toHaveCount(0)

  // ── A CLICK ON A DETAILS CELL OPENS IT: the open size, its diagram, pinned. ──
  const learning = terrCell(page, FEATURE)
  await hoverDetails(page, learning)
  expect((await briefCalls(app)).length - readsBefore).toBe(0)
  const detailsArea = area((await cellRects(page))[FEATURE_ID] as Box)
  await learning.click({ position: { x: 20, y: 8 } })
  await expect(learning).toHaveAttribute('data-grown-diagram', FEATURE, { timeout: 30_000 })
  await expect(learning).toHaveClass(/fb-terr-pinned/, { timeout: 5_000 })
  await waitSettled(page)
  const opened = (await cellRects(page))[FEATURE_ID] as Box
  expect(area(opened)).toBeGreaterThan(detailsArea)
  expect(area(opened) / area(level)).toBeGreaterThanOrEqual(0.45)
  await screenshotBoth(page, 'opened-from-details')
  // WHILE IT IS OPEN, hovering another cell grows nothing.
  const other = await boxOf(terrCell(page, AGENTS))
  await page.mouse.move(other.x + other.w / 2, other.y + other.h / 2, { steps: 4 })
  await page.waitForTimeout(HOVER_GROW_DELAY_MS * 3)
  await expect(grown(page)).toHaveCount(1)
  await expect(learning).toHaveClass(/fb-terr-pinned/)
  await expect(terrCell(page, AGENTS)).not.toHaveClass(/fb-terr-grown/)
})

test('the map moving under a still pointer grows nothing — only the reader moving does', async ({ window: page, app }) => {
  test.setTimeout(600_000)
  await boot(page, app, 'flow-ux-echo-')
  await watchGrows(page)
  await page.mouse.move(2, 2)
  await waitSettled(page)
  const plain = await cellRects(page)
  const small = terrCell(page, SMALL[0][1])
  const id = (await small.getAttribute('data-feature-id')) ?? ''
  await hoverDetails(page, small)
  const grownBox = (await cellRects(page))[id] as Box
  // A spot INSIDE the details cell that, on the plain map, is ANOTHER cell:
  // when the map goes back, that cell slides under the pointer.
  let spot: { x: number; y: number; key: string } | null = null
  for (let fy = 0.1; fy < 0.95 && spot === null; fy += 0.05) {
    for (let fx = 0.1; fx < 0.95 && spot === null; fx += 0.05) {
      const x = grownBox.x + grownBox.w * fx
      const y = grownBox.y + grownBox.h * fy
      const under = Object.entries(plain).find(([key, box]) => key !== id && holds({ x: box.x + 3, y: box.y + 3, w: box.w - 6, h: box.h - 6 }, { x, y }))
      if (under !== undefined) spot = { x, y, key: under[0] }
    }
  }
  expect(spot, 'the details cell covers no other cell\'s plain place').not.toBeNull()
  const target = spot as { x: number; y: number; key: string }
  // A REAL move, within the details cell: still its hover.
  await page.mouse.move(target.x, target.y, { steps: 3 })
  await page.waitForTimeout(HOVER_GROW_DELAY_MS)
  await expect(small).toHaveClass(/fb-terr-grown/)
  await page.evaluate(() => {
    ;(window as unknown as { __grown: string[] }).__grown.length = 0
  })

  // THE MAP GOES BACK under the still pointer (a wheel closes the details).
  await page.mouse.wheel(0, 40)
  await expect(grown(page)).toHaveCount(0, { timeout: 3_000 })
  await waitSettled(page)
  // Positive first: the other cell IS under the pointer now…
  const now = await cellRects(page)
  expect(holds(now[target.key] as Box, target)).toBe(true)
  // …and still nothing grows: the map moved, not the reader.
  await page.waitForTimeout(HOVER_GROW_DELAY_MS * 4)
  await expect(grown(page)).toHaveCount(0)
  expect(await grownKeys(page)).toEqual([])

  // THE READER MOVES — a few pixels — and the cell under the pointer is hovered.
  await page.mouse.move(target.x + 4, target.y + 3, { steps: 2 })
  await expect(page.locator(`.fb-terr-cell.fb-terr-grown[data-feature-id="${target.key}"]`)).toHaveCount(1, { timeout: HOVER_GROW_DELAY_MS * 8 })
  expect([...new Set(await grownKeys(page))]).toEqual([target.key])
})

test('focus shows the details too, and Escape quiets them while focus stays; focus never reads a diagram', async ({ window: page, app }) => {
  test.setTimeout(600_000)
  await boot(page, app, 'flow-ux-focus-')
  await watchGrows(page)
  await page.mouse.move(2, 2)
  await waitSettled(page)
  const plainCell = terrCell(page, PLAIN)
  const readsBefore = (await briefCalls(app)).length
  await plainCell.focus()
  await expect(plainCell).toBeFocused()
  await expect(plainCell).toHaveClass(/fb-terr-grown/, { timeout: HOVER_GROW_DELAY_MS * 6 })
  await expect(plainCell.locator('.fb-terr-grow-details')).toHaveCount(1)
  await expect(pinned(page)).toHaveCount(0)
  expect((await briefCalls(app)).length - readsBefore).toBe(0)
  await page.keyboard.press('Escape')
  await expect(grown(page)).toHaveCount(0, { timeout: 3_000 })
  await expect(plainCell).toBeFocused()
  await page.waitForTimeout(HOVER_GROW_DELAY_MS * 3)
  await expect(grown(page)).toHaveCount(0)
})

test('a click outside closes an open cell without pressing what it landed on', async ({ window: page, app }) => {
  test.setTimeout(600_000)
  await boot(page, app, 'flow-ux-outside-')
  const cell = terrCell(page, FEATURE)
  await openCell(page, cell, true)
  // Positive first: open and pinned.
  await expect(pinned(page)).toHaveCount(1)
  const at = await plainPointOf(terrCell(page, AGENTS))
  await page.mouse.click(at.x, at.y)
  await expect(pinned(page)).toHaveCount(0)
  await expect(grown(page)).toHaveCount(0, { timeout: 3_000 })
  await page.waitForTimeout(800)
  // Agents has no parts: a press would have opened its story — or opened it. Neither.
  await expect(page.locator('.fb-story')).toHaveCount(0)
  await expect(terrCell(page, AGENTS)).not.toHaveClass(/fb-terr-grown/)
  // A click inside the open cell's diagram keeps it open.
  await openCell(page, cell, true)
  const slot = await boxOf(cell.locator('.fb-terr-grow-diagram'))
  await page.mouse.click(slot.x + 8, slot.y + slot.h - 8)
  await page.waitForTimeout(500)
  await expect(cell).toHaveClass(/fb-terr-pinned/)
  await expect(terrCell(page, PART)).toHaveCount(0)
})

test('right-click closes an open cell, then goes back one level', async ({ window: page, app }) => {
  test.setTimeout(600_000)
  await boot(page, app, 'flow-ux-rightclick-')
  await diveIntoLearning(page)
  const part = terrCell(page, PART)
  await openCell(page, part, true)
  // Positive first: open, on the parts level.
  await expect(grown(page)).toHaveCount(1)
  await expect(pinned(page)).toHaveCount(1)

  // ── THE FIRST RIGHT-CLICK CLOSES IT — the level stays. ──
  const inside = await boxOf(part)
  await page.mouse.click(inside.x + inside.w / 2, inside.y + inside.h / 2, { button: 'right' })
  await expect(grown(page)).toHaveCount(0, { timeout: 3_000 })
  await expect(pinned(page)).toHaveCount(0)
  await expect(part).toBeVisible()
  await expect(terrCell(page, FEATURE)).toHaveCount(0)
  await waitSettled(page)
  await screenshotBoth(page, 'right-click-closed')

  // ── THE NEXT GOES BACK: the project's level, Learning on it, the parts gone. ──
  const at = await plainPointOf(part)
  await page.mouse.click(at.x, at.y, { button: 'right' })
  await expect(terrCell(page, FEATURE)).toBeVisible({ timeout: 10_000 })
  await expect(terrCell(page, PART)).toHaveCount(0)
  await expect(grown(page)).toHaveCount(0)
  await expect(page.locator('.fb-story')).toHaveCount(0)

  // ── A WORDS-ONLY CELL closes on a right-click too. ──
  await openCell(page, terrCell(page, PLAIN), false)
  const plainBox = await boxOf(terrCell(page, PLAIN))
  await page.mouse.click(plainBox.x + plainBox.w / 2, plainBox.y + 12, { button: 'right' })
  await expect(grown(page)).toHaveCount(0, { timeout: 3_000 })
  await expect(terrCell(page, FEATURE)).toBeVisible()
})

test('the same cell opened twice is read once', async ({ window: page, app }) => {
  test.setTimeout(600_000)
  await boot(page, app, 'flow-ux-cache-')
  const cell = terrCell(page, FEATURE)
  const reads = async (): Promise<number> => (await briefCalls(app)).filter((call) => call.ref === FEATURE_ID).length
  await openCell(page, cell, true)
  expect(await reads()).toBe(1)
  // A `blueprint:changed` between the two opens drops the cache BY DESIGN, so
  // the claim is only made over a pair with none in between — retried until one is.
  let proven = false
  for (let attempt = 0; attempt < 5 && !proven; attempt += 1) {
    const before = await reads()
    const changes = await boardChanges(page)
    await closeAll(page)
    await openCell(page, cell, true)
    if ((await boardChanges(page)) !== changes) continue
    // The second open drew from the cache: no read at all.
    expect((await measureGrown(page)).cards).toBe(VIEW.views.root.nodes.length)
    expect(await reads()).toBe(before)
    proven = true
  }
  expect(proven, 'the board never went quiet long enough to open one cell twice').toBe(true)
})

test('keyboard: Enter on a focused cell opens it, Escape closes it, focus shows details only, Open goes in', async ({ window: page, app }) => {
  test.setTimeout(600_000)
  await boot(page, app, 'flow-ux-keys-')
  await diveIntoLearning(page)
  const part = terrCell(page, PART)
  await expect(part).toHaveAttribute('tabindex', '0')
  const before = await cellRects(page)

  // ENTER on the focused cell is its click: open, pinned, its diagram.
  await part.focus()
  await page.keyboard.press('Enter')
  await expect(part).toHaveAttribute('data-grown-diagram', PART, { timeout: 30_000 })
  await expect(part).toHaveClass(/fb-terr-pinned/, { timeout: 5_000 })
  await waitSettled(page)
  await screenshotBoth(page, 'keyboard-open')

  // ESCAPE closes — and only that: the level stays.
  await page.keyboard.press('Escape')
  await expect(grown(page)).toHaveCount(0, { timeout: 3_000 })
  await expect(part).toBeVisible()
  await expect(page.locator('.fb-story')).toHaveCount(0)
  await waitSettled(page)
  const back = await cellRects(page)
  for (const [id, box] of Object.entries(before)) expectNear(back[id], box)

  // TAB onto it from its neighbour: focused — its DETAILS grow, nothing opens (it could — above).
  const neighbour = await page.evaluate((name) => {
    const cells = [...document.querySelectorAll<HTMLElement>('.fb-terr-cell')]
    const at = cells.findIndex((cell) => cell.querySelector(':scope > .fb-terr-cell-name')?.textContent === name)
    const from = at > 0 ? at - 1 : at + 1
    cells[from]?.setAttribute('data-test-neighbour', '1')
    return { found: at >= 0 && cells[from] !== undefined, forward: at > 0 }
  }, PART)
  expect(neighbour.found).toBe(true)
  await page.locator('[data-test-neighbour="1"]').focus()
  await page.keyboard.press(neighbour.forward ? 'Tab' : 'Shift+Tab')
  await expect(part).toBeFocused()
  await expect(part).toHaveClass(/fb-terr-grown/, { timeout: HOVER_GROW_DELAY_MS * 6 })
  await expect(part.locator('.fb-terr-grow-details')).toHaveCount(1)
  await expect(pinned(page)).toHaveCount(0)

  // SPACE opens it; then the toolbar's Open, by keyboard, tells its story.
  await page.keyboard.press('Space')
  await expect(part).toHaveClass(/fb-terr-pinned/, { timeout: 30_000 })
  const open = part.locator('.fb-terr-pin-bar').getByRole('button', { name: `Open ${PART}` })
  await open.focus()
  await page.keyboard.press('Enter')
  await expect(page.locator('.fb-story')).toHaveCount(1, { timeout: 10_000 })
  await expect(page.locator('.fb-story-head .fb-story-crumb.on')).toHaveText(PART, { timeout: 60_000 })
  await expect(grown(page)).toHaveCount(0)
})

/** In-page: the moment a cell is marked grown, its rect against the rect it is going to. */
async function rectWhenGrown(page: Page): Promise<{ rect: Box; target: Box; duration: string }> {
  return page.evaluate(
    () =>
      new Promise<{ rect: Box; target: Box; duration: string }>((settle) => {
        const observer = new MutationObserver((records) => {
          for (const record of records) {
            const el = record.target
            if (!(el instanceof HTMLElement) || !el.classList.contains('fb-terr-grown')) continue
            if (record.oldValue !== null && record.oldValue.split(' ').includes('fb-terr-grown')) continue
            observer.disconnect()
            const parent = (el.offsetParent as HTMLElement).getBoundingClientRect()
            const r = el.getBoundingClientRect()
            settle({
              rect: { x: r.x - parent.x, y: r.y - parent.y, w: r.width, h: r.height },
              target: {
                x: parseFloat(el.style.left),
                y: parseFloat(el.style.top),
                w: parseFloat(el.style.width),
                h: parseFloat(el.style.height),
              },
              duration: getComputedStyle(el).transitionDuration,
            })
            return
          }
        })
        observer.observe(document.querySelector('.fb-stage') as HTMLElement, {
          subtree: true,
          attributes: true,
          attributeFilter: ['class'],
          attributeOldValue: true,
        })
      }),
  )
}

test('reduced motion: the opened cell is at its new rect the moment it grows', async ({ window: page, app }) => {
  test.setTimeout(600_000)
  await boot(page, app, 'flow-ux-motion-')
  const cell = terrCell(page, FEATURE)
  const near = (a: Box, b: Box): boolean =>
    Math.abs(a.x - b.x) < 1.5 && Math.abs(a.y - b.y) < 1.5 && Math.abs(a.w - b.w) < 1.5 && Math.abs(a.h - b.h) < 1.5

  // Positive first: with motion, the cell SLIDES — a transition runs, and the
  // first frame is not yet the new rectangle.
  await waitSettled(page)
  const moving = rectWhenGrown(page)
  await cell.click({ position: { x: 20, y: 20 } })
  const sliding = await moving
  expect(sliding.duration).not.toMatch(/^0s(, 0s)*$/)
  expect(near(sliding.rect, sliding.target)).toBe(false)
  await closeAll(page)
  await waitSettled(page)

  // Reduced: no transition, and the first frame IS the new rectangle.
  await page.emulateMedia({ reducedMotion: 'reduce' })
  const still = rectWhenGrown(page)
  await cell.click({ position: { x: 24, y: 24 } })
  const instant = await still
  expect(instant.duration).toMatch(/^0s(, 0s)*$/)
  expect(near(instant.rect, instant.target)).toBe(true)
  await expect(cell).toHaveAttribute('data-grown-diagram', FEATURE, { timeout: 30_000 })
  await screenshotBoth(page, 'reduced-motion')
})

test('the Learn door is pressable on a closed cell — Learn, not an open, not a dive; an opened cell hands its corner to the toolbar', async ({ window: page, app }) => {
  test.setTimeout(600_000)
  await boot(page, app, 'flow-ux-learndoor-')
  await stubFeatureViewPass(app)
  const cell = terrCell(page, FEATURE)
  const door = cell.locator(':scope > .fb-terr-learn-btn')
  await expect(door).toHaveCount(1)

  // ── OPENED, the corner is the toolbar's: positive first, the toolbar is there. ──
  await openCell(page, cell, true)
  await expect(cell.locator('.fb-terr-pin-bar')).toBeVisible()
  expect(await door.evaluate((el) => getComputedStyle(el).display)).toBe('none')
  await closeAll(page)

  // ── CLOSED, the door shows where the pointer is, on top at its own spot. ──
  await cell.hover({ position: { x: 20, y: 20 } })
  const centre = await door.evaluate((el) => {
    const r = el.getBoundingClientRect()
    const x = r.x + r.width / 2
    const y = r.y + r.height / 2
    const hit = document.elementFromPoint(x, y)
    const cellEl = el.closest('.fb-terr-cell') as HTMLElement
    const c = cellEl.getBoundingClientRect()
    return { x, y, own: hit !== null && el.contains(hit), hit: hit?.className ?? null, inCell: x >= c.x && x <= c.x + c.width && y >= c.y && y <= c.y + c.height }
  })
  expect(centre.own, `the door is covered by ${String(centre.hit)}`).toBe(true)
  expect(centre.inCell).toBe(true)
  await page.mouse.click(centre.x, centre.y)

  // Learn happened…
  await expect.poll(async () => (await learnCalls(app)).map((call) => call.featureRef), { timeout: 15_000 }).toContain(FEATURE_ID)
  // …and the press was not the cell's: not opened, no dive into the parts, no story.
  // (The pointer resting on it may show its DETAILS — a hover, not an open.)
  await page.waitForTimeout(800)
  await expect(cell).toBeVisible()
  await expect(pinned(page)).toHaveCount(0)
  await expect(page.locator('.fb-terr-cell[data-grown-diagram]')).toHaveCount(0)
  await expect(page.locator('.fb-terr-cell.fb-terr-grown:not(:has(.fb-terr-grow-details))')).toHaveCount(0)
  await expect(terrCell(page, PART)).toHaveCount(0)
  await expect(page.locator('.fb-story')).toHaveCount(0)
})

test('the Workspace map: the clicked feature and its project both grow in place, its diagram inside', async ({ window: page, app }) => {
  test.setTimeout(700_000)
  const root = await boot(page, app, 'flow-ux-ws-')
  const sibling = await seedProject(page, 'flow-ux-ws-sib-', seedSibling, { onboarded: true })
  // The sibling joins the Workspace: its flow/ becomes a link into it.
  await waitForWorkspaceLink(sibling, 'billing')
  writeViews(sibling, [BILLING_VIEW])

  // Up to the Workspace map, and wait for both projects' countries.
  const billing = wsCell(page, 'Billing')
  await expect(async () => {
    const up = page.locator('.flow-board-root .fb-ws-crumb:not(.on)').first()
    if ((await page.locator('.fb-ws-country').count()) === 0 && (await up.isVisible().catch(() => false))) {
      await up.click({ timeout: 2_000 })
    }
    await expect(billing).toBeVisible({ timeout: 5_000 })
  }).toPass({ timeout: 180_000, intervals: [1_000, 2_000, 5_000] })
  await expect(wsCell(page, FEATURE)).toBeVisible()
  await page.waitForTimeout(1_000)
  await dismissAsks(page)

  // Learn stays on a local sibling's cell (positive first); no diagram door anywhere.
  await expect(billing.locator('.fb-terr-learn-btn')).toHaveCount(1)
  await expect(page.locator('.fb-ws-cell [data-open-level]')).toHaveCount(0)

  await waitSettled(page)
  const cellsBefore = await cellRects(page)
  const countriesBefore = await countryRects(page)
  const billingKey = (await billing.getAttribute('data-ws-cell')) ?? ''
  const billingProject = billingKey.split('|')[0] ?? ''
  const handle = await billing.elementHandle()

  // THE SIBLING'S FEATURE: grown in place, its diagram read from ITS checkout.
  await openCell(page, billing, true)
  expect(await (handle as NonNullable<typeof handle>).evaluate((el) => el.classList.contains('fb-terr-grown'))).toBe(true)
  const measured = await measureGrown(page)
  expect(measured.cards).toBe(BILLING_VIEW.views.root.nodes.length)
  expect(measured.titles.join(' | ')).toContain('Invoice writer')
  const cellsDuring = await cellRects(page)
  const countriesDuring = await countryRects(page)
  // ITS PROJECT GREW, where it was…
  const countryWas = countriesBefore[billingProject] as Box
  const countryNow = countriesDuring[billingProject] as Box
  expect(area(countryNow)).toBeGreaterThan(area(countryWas))
  expect(holds(countryNow, centreOf(countryWas))).toBe(true)
  // …and the other project made room.
  for (const [slug, box] of Object.entries(countriesBefore)) {
    if (slug !== billingProject) expect(area(countriesDuring[slug] as Box)).toBeLessThan(area(box))
  }
  // THE FEATURE GREW inside it, where it was.
  expect(area(cellsDuring[billingKey] as Box)).toBeGreaterThan(area(cellsBefore[billingKey] as Box))
  expect(holds(cellsDuring[billingKey] as Box, centreOf(cellsBefore[billingKey] as Box))).toBe(true)
  expect(holds(countryNow, centreOf(cellsDuring[billingKey] as Box))).toBe(true)
  const billingReads = (await briefCalls(app)).filter((call) => call.ref === 'feature:billing')
  expect(billingReads.length).toBe(1)
  expect(billingReads[0]?.rootId).toBe(sibling)
  await expect(billing.locator('.fb-terr-pin-bar')).toBeVisible()
  await expect(page.locator('.fb-hover-card')).toHaveCount(0)
  await screenshotBoth(page, 'workspace-sibling')

  // The X puts the whole map back.
  await billing.locator('.fb-terr-pin-close').click()
  await expect(grown(page)).toHaveCount(0, { timeout: 3_000 })
  await waitSettled(page)
  const countriesAfter = await countryRects(page)
  for (const [slug, box] of Object.entries(countriesBefore)) expectNear(countriesAfter[slug], box)
  const cellsAfter = await cellRects(page)
  for (const [key, box] of Object.entries(cellsBefore)) expectNear(cellsAfter[key], box)

  // THE ACTIVE PROJECT'S FEATURE, on the same map: its own diagram.
  await openCell(page, wsCell(page, FEATURE), true)
  const own = await measureGrown(page)
  expect(own.cards).toBe(VIEW.views.root.nodes.length)
  expect((await briefCalls(app)).filter((call) => call.ref === FEATURE_ID).every((call) => call.rootId === root)).toBe(true)
  await screenshotBoth(page, 'workspace')

  // A SIBLING FEATURE WITH NO VIEW: its words only.
  const ledger = wsCell(page, 'Ledger')
  await openCell(page, ledger, false)
  await expect(ledger.locator('.fb-terr-grow-desc')).toContainText('Ledger — the append-only record every invoice is posted to. Nothing is ever edited in place')
  expect((await briefCalls(app)).some((call) => call.ref === 'feature:ledger')).toBe(true)
  await expect(ledger.locator('.fb-curated')).toHaveCount(0)
  await screenshotBoth(page, 'workspace-description-only')
})

/**
 * WHAT A DOUBLE-CLICK DOES (plan cell-hover-diagram, FR-6/7/8, click model): a
 * cell with a level below it zooms in; the last level reads as the code story
 * — never the part page. Above the last level the header reads the whole
 * feature as a story.
 */
test('a double-click zooms while there is a level below, and opens the code story at the last level', async ({ window: page, app }) => {
  test.setTimeout(600_000)
  await boot(page, app, 'flow-ux-press-')

  const header = page.locator('.flow-board-root .fb-header')
  const storyButton = header.locator('[data-feature-story]')
  const crumbOn = page.locator('.fb-story-head .fb-story-crumb.on')

  // ── THE PROJECT LEVEL: the header is up (Learn in it), and carries no story. ──
  await expect(header).toBeVisible()
  await expect(header.locator('fl-button[title="Show learning progress"]')).toBeVisible()
  await expect(terrCell(page, FEATURE)).toBeVisible()
  await expect(storyButton).toHaveCount(0)
  // No diagram door anywhere — Learn door first (positive).
  await expect(page.locator('.fb-terr-cell .fb-terr-learn-btn')).not.toHaveCount(0)
  await expect(page.locator('[data-open-level]')).toHaveCount(0)

  // ── A SINGLE CLICK DOES NOT GO IN: it opens the cell where it is. ──
  await openCell(page, terrCell(page, FEATURE), true)
  await expect(terrCell(page, PART)).toHaveCount(0)
  await closeAll(page)

  // ── A FEATURE WITH PARTS ZOOMS IN ON A DOUBLE-CLICK: its parts are the level on screen. ──
  await diveIntoLearning(page)
  await expect(page.locator('.fb-terr-cell', { hasText: 'Activity log' }).first()).toBeVisible()
  await expect(page.locator('.fb-story')).toHaveCount(0)
  await expect(page.locator('[data-open-level]')).toHaveCount(0)

  // ── THE FEATURE LEVEL'S HEADER: Read as a story, for the whole feature. ──
  await expect(storyButton).toHaveCount(1)
  await expect(storyButton).toBeVisible()
  await expect(storyButton).toHaveAttribute('data-feature-story', FEATURE_ID)
  await expect(storyButton).toContainText('Read as a story')
  await page.mouse.move(2, 2)
  await page.waitForTimeout(300)
  mkdirSync(SCREENS, { recursive: true })
  await theme(page, 'dark')
  await header.screenshot({ path: join(SCREENS, 'inplace-feature-header-dark.png') })
  await theme(page, 'light')
  await header.screenshot({ path: join(SCREENS, 'inplace-feature-header-light.png') })
  await storyButton.click()
  await expect(page.locator('.fb-story')).toHaveCount(1, { timeout: 10_000 })
  await expect(crumbOn).toHaveText(FEATURE, { timeout: 60_000 })
  await expect(page.locator('.fb-story-box').first()).toBeVisible({ timeout: 60_000 })
  await screenshotBoth(page, 'feature-story')
  await page.keyboard.press('Escape')
  await expect(page.locator('.fb-story')).toHaveCount(0)
  await expect(terrCell(page, PART)).toBeVisible()

  // ── A PART OPENS ITS STORY ON A DOUBLE-CLICK, never the part page. ──
  await expect(async () => {
    await closeAll(page)
    await terrCell(page, PART).dblclick({ position: { x: 20, y: 20 }, timeout: 2_000 })
    await expect(page.locator('.fb-story')).toHaveCount(1, { timeout: 3_000 })
  }).toPass({ timeout: 60_000 })
  await expect(crumbOn).toHaveText(PART, { timeout: 60_000 })
  // The crumbs name the way back: the feature above the part.
  await expect(page.locator('.fb-story-head .fb-story-crumb', { hasText: FEATURE }).first()).toBeVisible()
  await expect(page.locator('.fb-story-box').first()).toBeVisible({ timeout: 60_000 })
  // Positive first: the story IS on screen, so no file boxes is evidence.
  await expect(page.locator('.fb-terr-file')).toHaveCount(0)
  await screenshotBoth(page, 'part-story')

  // ── BACK RETURNS TO THE FEATURE LEVEL, with nothing left grown. ──
  await expect(async () => {
    if ((await page.locator('.fb-story').count()) > 0) {
      await page.locator('.fb-nav-btn[aria-label^="Back"]').click({ timeout: 2_000 })
    }
    await expect(page.locator('.fb-story')).toHaveCount(0, { timeout: 2_000 })
  }).toPass({ timeout: 30_000 })
  await expect(terrCell(page, PART)).toBeVisible()
  await expect(page.locator('.fb-terr-cell', { hasText: 'Activity log' }).first()).toBeVisible()
  await expect(grown(page)).toHaveCount(0)

  // ── A FEATURE WITH NO PARTS, on the project's own level: its story — also
  //    double-clicked in its MIDDLE once its diagram is cached, where the
  //    diagram is drawn by the first of the two clicks. ──
  await expect(async () => {
    if (!(await terrCell(page, AGENTS).isVisible().catch(() => false))) {
      await page.locator('.fb-nav-btn[aria-label^="Back"]').click({ timeout: 2_000 })
    }
    await expect(terrCell(page, AGENTS)).toBeVisible({ timeout: 3_000 })
  }).toPass({ timeout: 30_000 })
  await openCell(page, terrCell(page, AGENTS), true)
  await closeAll(page)
  await waitSettled(page)
  const agentsMiddle = centreOf(await boxOf(terrCell(page, AGENTS)))
  await page.mouse.dblclick(agentsMiddle.x, agentsMiddle.y)
  await expect(page.locator('.fb-story')).toHaveCount(1, { timeout: 10_000 })
  await expect(crumbOn).toHaveText(AGENTS, { timeout: 60_000 })
  await page.keyboard.press('Escape')
  await expect(page.locator('.fb-story')).toHaveCount(0)

  // ── THE WORKSPACE MAP: a feature with parts zooms in; one without reads as a story. ──
  await expect(async () => {
    await closeAll(page)
    await page.locator('.flow-board-root .fb-ws-crumb:not(.on)').first().click({ timeout: 2_000 })
    await expect(wsCell(page, FEATURE)).toBeVisible({ timeout: 5_000 })
  }).toPass({ timeout: 60_000 })
  await page.waitForTimeout(1_000)
  await expect(async () => {
    await closeAll(page)
    await wsCell(page, AGENTS).dblclick({ position: { x: 10, y: 10 }, timeout: 2_000 })
    await expect(page.locator('.fb-story')).toHaveCount(1, { timeout: 3_000 })
  }).toPass({ timeout: 60_000 })
  await expect(crumbOn).toHaveText(AGENTS, { timeout: 60_000 })
  await page.keyboard.press('Escape')
  await expect(page.locator('.fb-story')).toHaveCount(0)
  await expect(async () => {
    await closeAll(page)
    if (!(await wsCell(page, FEATURE).isVisible().catch(() => false))) {
      await page.locator('.flow-board-root .fb-ws-crumb:not(.on)').first().click({ timeout: 2_000 })
    }
    await wsCell(page, FEATURE).dblclick({ position: { x: 20, y: 20 }, timeout: 2_000 })
    await expect(terrCell(page, PART)).toBeVisible({ timeout: 5_000 })
  }).toPass({ timeout: 60_000 })
  await expect(page.locator('.fb-story')).toHaveCount(0)
})

// ── PIN & EXPLORE (cell-pin-model.ts) ───────────────────────────────────────
//
// A click opens a cell already pinned: it stays open when the pointer leaves,
// wears a ring, the map around it dims, and the diagram is a viewport — drag
// pans, the wheel zooms, `0` / Fit shows all, a hovered component lights its
// neighbours, and a corner toolbar zooms, fits, opens and closes (X). Every
// claim from computed rectangles and transforms.

const PIN_SCREENS =
  process.env['FLOW_E2E_PIN_SCREENS'] ??
  join(tmpdir(), 'flow-e2e-screens', 'pin')

/** A watched structure file touched — main pushes `blueprint:changed` and the board re-renders. */
function touchStructure(dir: string): void {
  const structure = join(dir, 'flow', 'brain', '.structure')
  mkdirSync(structure, { recursive: true })
  const graph = join(structure, 'graph.json')
  const now = new Date()
  if (existsSync(graph)) utimesSync(graph, now, now)
  else writeFileSync(join(structure, 'investigations.jsonl'), '')
}

async function pinShot(page: Page, name: string): Promise<void> {
  mkdirSync(PIN_SCREENS, { recursive: true })
  for (const value of ['dark', 'light'] as const) {
    await theme(page, value)
    await page.screenshot({ path: join(PIN_SCREENS, `pin-${name}-${value}.png`) })
  }
}

/** The grown diagram's camera, read off the canvas's computed transform, and its viewport. */
async function diagramState(cell: Locator): Promise<{
  k: number
  x: number
  y: number
  slot: Box
  cardScale: number
  cardsInSlot: boolean
  pct: string | null
}> {
  return cell.evaluate((el) => {
    const slot = el.querySelector<HTMLElement>('.fb-terr-grow-diagram') as HTMLElement
    const canvas = slot.querySelector<HTMLElement>('.fb-curated') as HTMLElement
    const m = new DOMMatrixReadOnly(getComputedStyle(canvas).transform)
    const s = slot.getBoundingClientRect()
    const cards = [...canvas.querySelectorAll<HTMLElement>('.fb-curated-card')]
    const inSlot = cards.every((card) => {
      const c = card.getBoundingClientRect()
      return c.x >= s.x - 1 && c.y >= s.y - 1 && c.x + c.width <= s.x + s.width + 1 && c.y + c.height <= s.y + s.height + 1
    })
    return {
      k: m.a,
      x: m.e,
      y: m.f,
      slot: { x: s.x, y: s.y, w: s.width, h: s.height },
      cardScale: Math.min(...cards.map((card) => card.getBoundingClientRect().width / Math.max(1, card.offsetWidth))),
      cardsInSlot: cards.length > 0 && inSlot,
      pct: el.querySelector('.fb-terr-pin-pct')?.textContent ?? null,
    }
  })
}

test('pin & explore: a click opens it pinned; drag pans, wheel zooms, 0 and Fit show all, hover lights neighbours', async ({ window: page, app }) => {
  test.setTimeout(700_000)
  const root = await boot(page, app, 'flow-ux-pin-')
  const cell = terrCell(page, FEATURE)
  await waitSettled(page)
  const plain = await cellRects(page)

  await openCell(page, cell, true)
  // Positive: pinned, the ring, the toolbar, the map dimmed around it.
  const bar = cell.locator('.fb-terr-pin-bar')
  await expect(bar).toBeVisible()
  await expect(bar.getByRole('button', { name: 'Zoom in' })).toBeVisible()
  await expect(bar.getByRole('button', { name: 'Show the whole diagram' })).toBeVisible()
  await expect(bar.getByRole('button', { name: `Open ${FEATURE}` })).toBeVisible()
  await expect(bar.getByRole('button', { name: 'Close' })).toBeVisible()
  expect(await cell.evaluate((el) => getComputedStyle(el).outlineStyle)).toBe('solid')
  const opacity = await cellOpacities(page)
  expect(opacity[FEATURE_ID]).toBe(1)
  for (const [id, value] of Object.entries(opacity)) if (id !== FEATURE_ID) expect(value, id).toBeLessThan(1)
  // The toolbar sits inside the cell's top-right corner.
  const cellBox = await boxOf(cell)
  const barBox = await boxOf(bar)
  expect(barBox.x + barBox.w).toBeLessThanOrEqual(cellBox.x + cellBox.w)
  expect(barBox.y).toBeGreaterThanOrEqual(cellBox.y)
  expect(barBox.x).toBeGreaterThan(cellBox.x + cellBox.w / 2)
  // READABLE: opened at ~0.85 of natural size, not fitted.
  const opened = await diagramState(cell)
  expect(opened.cardScale).toBeGreaterThanOrEqual(0.8)
  expect(opened.pct).toBe(`${String(Math.round(opened.k * 100))}%`)
  await pinShot(page, 'opened')

  // ── THE POINTER LEAVES: still open, still pinned. ──
  await page.mouse.move(2, 2, { steps: 4 })
  await page.waitForTimeout(HOVER_CLOSE_GRACE_MS * 4)
  await expect(cell).toHaveClass(/fb-terr-grown/)
  await expect(pinned(page)).toHaveCount(1)
  // ANOTHER CELL'S HOVER DOES NOTHING.
  await terrCell(page, AGENTS).hover({ position: { x: 8, y: 8 } })
  await page.waitForTimeout(HOVER_GROW_DELAY_MS + 600)
  await expect(terrCell(page, AGENTS)).not.toHaveClass(/fb-terr-grown/)
  await expect(cell).toHaveClass(/fb-terr-grown/)

  // ── DRAG PANS: the diagram moves, the cell does not, nothing navigates. ──
  const rectBefore = await boxOf(cell)
  const slot = (await diagramState(cell)).slot
  const camBefore = await diagramState(cell)
  const from = { x: slot.x + slot.w / 2, y: slot.y + slot.h / 2 }
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move(from.x - 40, from.y - 30, { steps: 4 })
  await page.mouse.move(from.x - 80, from.y - 60, { steps: 4 })
  await page.mouse.up()
  const panned = await diagramState(cell)
  expect(panned.x - camBefore.x).toBeCloseTo(-80, 0)
  expect(panned.y - camBefore.y).toBeCloseTo(-60, 0)
  expect(panned.k).toBeCloseTo(camBefore.k, 5)
  expectNear(await boxOf(cell), rectBefore)
  await expect(pinned(page)).toHaveCount(1)
  await expect(terrCell(page, PART)).toHaveCount(0)
  await expect(page.locator('.fb-story')).toHaveCount(0)

  // ── WHEEL ZOOMS, no modifier; the % follows. ──
  await page.mouse.move(from.x, from.y)
  await page.mouse.wheel(0, -240)
  await page.waitForTimeout(150)
  const zoomed = await diagramState(cell)
  expect(zoomed.k).toBeGreaterThan(panned.k * 1.2)
  expect(zoomed.pct).toBe(`${String(Math.round(zoomed.k * 100))}%`)
  expect(zoomed.pct).not.toBe(panned.pct)
  expectNear(await boxOf(cell), rectBefore)
  await expect(pinned(page)).toHaveCount(1)

  // ── `0` FITS: every card inside the viewport. ──
  expect(zoomed.cardsInSlot).toBe(false)
  await page.keyboard.press('0')
  await page.waitForTimeout(350)
  const fitted = await diagramState(cell)
  expect(fitted.cardsInSlot).toBe(true)
  await pinShot(page, 'fit')
  // …and the toolbar's + then Fit do the same.
  await bar.getByRole('button', { name: 'Zoom in' }).click()
  await bar.getByRole('button', { name: 'Zoom in' }).click()
  await page.waitForTimeout(350)
  expect((await diagramState(cell)).k).toBeGreaterThan(fitted.k * 1.3)
  await bar.getByRole('button', { name: 'Show the whole diagram' }).click()
  await page.waitForTimeout(350)
  expect((await diagramState(cell)).cardsInSlot).toBe(true)
  await expect(pinned(page)).toHaveCount(1)

  // ── HOVER A COMPONENT: it and its neighbours lit, the rest dimmed. ──
  const queue = cell.locator('.fb-curated-card[data-node-id="queue"]')
  await queue.hover()
  await expect(queue).toHaveClass(/fb-pin-on/)
  for (const id of ['panel', 'cli', 'log']) await expect(cell.locator(`.fb-curated-card[data-node-id="${id}"]`)).toHaveClass(/fb-pin-near/)
  const notes = cell.locator('.fb-curated-card[data-node-id="notes"]')
  await expect(notes).not.toHaveClass(/fb-pin-(on|near)/)
  await expect.poll(() => notes.evaluate((el) => Number(getComputedStyle(el).opacity))).toBeLessThan(0.5)
  expect(await queue.evaluate((el) => Number(getComputedStyle(el).opacity))).toBe(1)
  expect(await cell.locator('.fb-curated-wire.fb-pin-on').count()).toBe(3)
  await pinShot(page, 'focus')
  // A press on a component still never navigates.
  await queue.click()
  await expect(pinned(page)).toHaveCount(1)
  await expect(terrCell(page, PART)).toHaveCount(0)

  // ── A RE-RENDER of the same level keeps the pin and the camera. ──
  await page.mouse.move(from.x, from.y)
  await page.mouse.wheel(0, -120)
  await page.waitForTimeout(150)
  const kept = await diagramState(cell)
  const changes = await boardChanges(page)
  // THE SAME PUSH main sends when the structure changes on disk — sent from
  // main itself, because the file watcher on a macOS temp folder is not
  // dependable in a test (it was this spec's first failure).
  touchStructure(root)
  await app.evaluate(({ BrowserWindow }, rootIds) => {
    for (const win of BrowserWindow.getAllWindows()) for (const rootId of rootIds) win.webContents.send('blueprint:changed', { rootId })
  }, [...new Set([root, realpathSync(root)])])
  await expect.poll(() => boardChanges(page), { timeout: 60_000 }).toBeGreaterThan(changes)
  await page.waitForTimeout(1_500)
  await expect(pinned(page)).toHaveCount(1, { timeout: 30_000 })
  await expect(terrCell(page, FEATURE)).toHaveAttribute('data-grown-diagram', FEATURE, { timeout: 30_000 })
  const after = await diagramState(terrCell(page, FEATURE))
  expect(after.k).toBeCloseTo(kept.k, 3)
  expect(after.x).toBeCloseTo(kept.x, 0)
  expect(after.y).toBeCloseTo(kept.y, 0)

  // ── ESCAPE CLOSES, and the map goes back. ──
  await terrCell(page, FEATURE).focus()
  await page.keyboard.press('Escape')
  await expect(pinned(page)).toHaveCount(0)
  await expect(grown(page)).toHaveCount(0, { timeout: 3_000 })
  await waitSettled(page)
  const back = await cellRects(page)
  for (const [id, box] of Object.entries(plain)) expectNear(back[id], box)
  for (const value of Object.values(await cellOpacities(page))) expect(value).toBe(1)
})

test('pin & explore: Space opens a focused cell, the X closes, the title of an open cell stays put, a double-click or Open goes in', async ({ window: page, app }) => {
  test.setTimeout(700_000)
  await boot(page, app, 'flow-ux-pinkeys-')
  const cell = terrCell(page, FEATURE)

  // ── SPACE on a keyboard-focused cell opens it pinned; the X closes it. ──
  await terrCell(page, AGENTS).focus()
  await page.keyboard.press('Space')
  await expect(terrCell(page, AGENTS)).toHaveClass(/fb-terr-pinned/, { timeout: 30_000 })
  await expect(page.locator('.fb-story')).toHaveCount(0)
  await terrCell(page, AGENTS).locator('.fb-terr-pin-close').click()
  await expect(pinned(page)).toHaveCount(0)
  await expect(grown(page)).toHaveCount(0, { timeout: 3_000 })
  await expect(page.locator('.fb-story')).toHaveCount(0)

  // ── THE EMPTY CELL (the Learn offer) opens unpinned; Space again goes in. ──
  const plainCell = terrCell(page, PLAIN)
  await plainCell.focus()
  await page.keyboard.press('Space')
  await expect(plainCell.locator('.fb-terr-grow-learn')).toBeVisible({ timeout: 30_000 })
  await expect(plainCell).toHaveClass(/fb-terr-grown/)
  await expect(pinned(page)).toHaveCount(0)
  await expect(plainCell.locator('.fb-terr-pin-bar')).toHaveCount(0)
  await page.keyboard.press('Space')
  await expect(page.locator('.fb-story')).toHaveCount(1, { timeout: 10_000 })
  await expect(page.locator('.fb-story-head .fb-story-crumb.on')).toHaveText(PLAIN, { timeout: 60_000 })
  await page.keyboard.press('Escape')
  await expect(page.locator('.fb-story')).toHaveCount(0)
  await expect(cell).toBeVisible()

  // ── THE TITLE OF AN OPEN CELL STAYS PUT; A DOUBLE-CLICK ON IT DIVES. ──
  await openCell(page, cell, true)
  await cell.locator(':scope > .fb-terr-cell-name').click()
  await page.waitForTimeout(800)
  await expect(cell).toHaveClass(/fb-terr-pinned/)
  await expect(terrCell(page, PART)).toHaveCount(0)
  await cell.locator(':scope > .fb-terr-cell-name').dblclick()
  await expect(terrCell(page, PART)).toBeVisible({ timeout: 10_000 })
  await expect(pinned(page)).toHaveCount(0)
  await page.mouse.move(2, 2)
  await page.waitForTimeout(1_000)
  await waitSettled(page)

  // ── OPEN on the last level tells the part's code story. ──
  const part = terrCell(page, PART)
  await openCell(page, part, true)
  await pinShot(page, 'part')
  await part.locator('.fb-terr-pin-bar').getByRole('button', { name: `Open ${PART}` }).click()
  await expect(page.locator('.fb-story')).toHaveCount(1, { timeout: 10_000 })
  await expect(page.locator('.fb-story-head .fb-story-crumb.on')).toHaveText(PART, { timeout: 60_000 })
  await page.keyboard.press('Escape')
  await expect(page.locator('.fb-story')).toHaveCount(0)
  await expect(terrCell(page, PART)).toBeVisible()

  // ── OPEN above the last level dives. ──
  await expect(async () => {
    if (!(await cell.isVisible().catch(() => false))) await page.locator('.fb-nav-btn[aria-label^="Back"]').click({ timeout: 2_000 })
    await expect(cell).toBeVisible({ timeout: 3_000 })
  }).toPass({ timeout: 30_000 })
  await page.waitForTimeout(800)
  await openCell(page, cell, true)
  await cell.locator('.fb-terr-pin-bar').getByRole('button', { name: `Open ${FEATURE}` }).click()
  await expect(terrCell(page, PART)).toBeVisible({ timeout: 10_000 })
  await expect(page.locator('.fb-story')).toHaveCount(0)
})

test('pin & explore: the Workspace map opens its clicked feature pinned; reduced motion moves the camera without gliding', async ({ window: page, app }) => {
  test.setTimeout(700_000)
  await boot(page, app, 'flow-ux-pinws-')

  // ── MOTION FIRST (positive): opening glides the camera. ──
  const cell = terrCell(page, FEATURE)
  await waitSettled(page)
  await cell.click({ position: { x: 20, y: 20 } })
  await expect(cell).toHaveClass(/fb-terr-pinned/, { timeout: 30_000 })
  expect(await cell.locator('.fb-curated').evaluate((el) => getComputedStyle(el).transitionDuration)).not.toMatch(/^0s(, 0s)*$/)
  await closeAll(page)

  // ── REDUCED: no glide — the camera is where it is going at once. ──
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await cell.click({ position: { x: 20, y: 20 } })
  await expect(cell).toHaveClass(/fb-terr-pinned/, { timeout: 30_000 })
  expect(await cell.locator('.fb-curated').evaluate((el) => getComputedStyle(el).transitionDuration)).toMatch(/^0s(, 0s)*$/)
  const instant = await diagramState(cell)
  expect(instant.cardScale).toBeGreaterThanOrEqual(0.8)
  await closeAll(page)
  await page.emulateMedia({ reducedMotion: 'no-preference' })

  // ── THE WORKSPACE MAP: the clicked feature opens pinned the same way. ──
  const ws = wsCell(page, FEATURE)
  await expect(async () => {
    await closeAll(page)
    if (!(await ws.isVisible().catch(() => false))) {
      await page.locator('.flow-board-root .fb-ws-crumb:not(.on)').first().click({ timeout: 2_000 })
    }
    await expect(ws).toBeVisible({ timeout: 5_000 })
  }).toPass({ timeout: 90_000 })
  await page.waitForTimeout(1_000)
  await dismissAsks(page)
  await openCell(page, ws, true)
  await expect(ws.locator('.fb-terr-pin-bar')).toBeVisible()
  const opened = await diagramState(ws)
  expect(opened.cardScale).toBeGreaterThanOrEqual(0.8)
  await page.mouse.move(2, 2, { steps: 4 })
  await page.waitForTimeout(HOVER_CLOSE_GRACE_MS * 4)
  await expect(ws).toHaveClass(/fb-terr-grown/)
  await expect(ws).toHaveClass(/fb-terr-pinned/)
  const s = opened.slot
  await page.mouse.move(s.x + s.w / 2, s.y + s.h / 2)
  await page.mouse.wheel(0, -240)
  await page.waitForTimeout(150)
  expect((await diagramState(ws)).k).toBeGreaterThan(opened.k * 1.2)
  await page.keyboard.press('0')
  await page.waitForTimeout(350)
  expect((await diagramState(ws)).cardsInSlot).toBe(true)
  await pinShot(page, 'workspace')
  // Escape closes and the map goes back; nothing was pressed.
  await ws.focus()
  await page.keyboard.press('Escape')
  await expect(pinned(page)).toHaveCount(0)
  await expect(grown(page)).toHaveCount(0, { timeout: 3_000 })
  await expect(ws).toBeVisible()
  await expect(page.locator('.fb-story')).toHaveCount(0)
})
