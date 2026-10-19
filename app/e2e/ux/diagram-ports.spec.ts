/**
 * ENTRIES AND EXITS ON A DIAGRAM (plan diagram-entry-exit, phase 4) — a probe.
 *
 * A Workspace of two projects: this one (Learning, with a curated view whose
 * components cite their files) and a sibling (Billing, Ledger). The
 * Workspace's `links.jsonl` records how they talk — a code-evidenced call INTO
 * a Learning file, a model-only call OUT of another, a `consumes` from the
 * feature itself, and a `relates`. The board asks the bundled CLI's
 * `blueprint features ports` through main, and draws them.
 *
 * Claims: a clicked-open (pinned) cell shows ports on both sides with what crosses and the far
 * end; the model-only port is dashed and says "suggested by Flow"; a port's
 * wire ends on the component it touches; a
 * far-feature port, pressed, goes to that feature (switching project).
 *
 * Always run hidden: FLOW_E2E=1 FLOW_E2E_BACKGROUND=1.
 */
import { existsSync, lstatSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'

import type { Locator, Page } from '@playwright/test'

import { expect, test } from '../fixtures/electron'
import { activateProject, cleanupSeeds, dismissFlowOverlay, seedProject } from './fixtures/seed'

const SCREENS =
  process.env['FLOW_E2E_SCREENS'] ??
  join(tmpdir(), 'flow-e2e-screens', 'ports')

test.afterAll(() => cleanupSeeds())

const ORCHESTRATOR = "import { append } from './learn-log'\n\nexport class LearnOrchestrator {\n  run(): void {\n    append('start')\n  }\n}\n"
const LOG = 'export const log: string[] = []\n\nexport function append(entry: string): void {\n  log.push(entry)\n}\n'

const VIEW = {
  feature: 'learning',
  provenance: 'code',
  generatedAt: '2026-10-07T00:00:00.000Z',
  meta: { title: 'Learning', sub: 'How a module gets read' },
  brief: {},
  views: {
    root: {
      title: 'Learning',
      nodes: [
        { id: 'panel', kind: 'project', title: 'Learning panel', sub: 'board', delta: 'stable' },
        {
          id: 'queue',
          kind: 'function',
          title: 'Learn queue',
          sub: 'LearnOrchestrator',
          delta: 'stable',
          code: { file: 'src/project/learn-orchestrator.ts', from: 3, to: 7, note: 'The queue runs one pass at a time.', text: ORCHESTRATOR.split('\n').slice(2, 7).join('\n') },
        },
        {
          id: 'log',
          kind: 'module',
          title: 'Activity log',
          sub: 'learn-log',
          delta: 'stable',
          code: { file: 'src/project/learn-log.ts', from: 1, to: 5, note: 'Every entry lands here.', text: LOG.split('\n').slice(0, 5).join('\n') },
        },
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
      ],
      edges: [{ from: 'meter', to: 'invoice', label: 'monthly usage', delta: 'kept' }],
    },
  },
}

function lines(prefix: string, n: number): string {
  return Array.from({ length: n }, (_, i) => `export const ${prefix}${String(i)} = ${String(i)}`).join('\n') + '\n'
}

function featureNote(slug: string, name: string, text: string): string {
  return ['---', `id: feature:${slug}`, `name: ${name}`, 'kind: core', `anchors: [module:src/${slug}]`, 'relates: []', 'lastFullRead: null', 'patchCount: 0', '---', '', `# ${name}`, '', text, ''].join('\n')
}

function seed(dir: string): void {
  mkdirSync(join(dir, 'src', 'project'), { recursive: true })
  writeFileSync(join(dir, 'src', 'project', 'learn-orchestrator.ts'), ORCHESTRATOR)
  writeFileSync(join(dir, 'src', 'project', 'learn-log.ts'), LOG)
  writeFileSync(join(dir, 'src', 'project', 'learn-constants.ts'), lines('learnStep', 70))
  const features = join(dir, 'flow', 'brain', 'features')
  mkdirSync(features, { recursive: true })
  mkdirSync(join(dir, 'src', 'agents'), { recursive: true })
  writeFileSync(join(dir, 'src', 'agents', 'index.ts'), lines('agents', 30))
  writeFileSync(join(features, 'agents.md'), featureNote('agents', 'Agents', 'Agents — runs one agent turn at a time.'))
  writeFileSync(
    join(features, 'learning.md'),
    [
      '---',
      'id: feature:learning',
      'name: Learning',
      'kind: core',
      'anchors: [module:src/project]',
      'relates: []',
      'lastFullRead: null',
      'patchCount: 0',
      '---',
      '',
      '# Learning',
      '',
      'Reads modules and records what they do, one pass at a time.',
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

function seedSibling(dir: string): void {
  const features = join(dir, 'flow', 'brain', 'features')
  mkdirSync(features, { recursive: true })
  for (const [slug, name, text, size] of [
    ['billing', 'Billing', 'Billing — meters usage and writes the monthly invoice.', 50],
    ['ledger', 'Ledger', 'Ledger — the append-only record every invoice is posted to.', 30],
  ] as const) {
    mkdirSync(join(dir, 'src', slug), { recursive: true })
    writeFileSync(join(dir, 'src', slug, 'index.ts'), lines(slug, size))
    writeFileSync(join(features, `${slug}.md`), featureNote(slug, name, text))
  }
}

function writeViews(dir: string, views: ReadonlyArray<{ feature: string }>): void {
  const folder = join(dir, 'flow', 'brain', '.structure', 'feature-views')
  mkdirSync(folder, { recursive: true })
  for (const view of views) writeFileSync(join(folder, `${view.feature}.json`), JSON.stringify(view, null, 2))
}

/** The Workspace folder and this checkout's project slug, read off the `flow` link. */
function workspaceOf(dir: string): { workspace: string; project: string } {
  const linked = realpathSync(join(dir, 'flow'))
  return { workspace: dirname(dirname(linked)), project: basename(linked) }
}

async function waitForWorkspaceLink(dir: string, feature: string, timeout = 300_000): Promise<void> {
  await expect
    .poll(
      () => {
        try {
          return lstatSync(join(dir, 'flow')).isSymbolicLink() && existsSync(join(dir, 'flow', 'brain', 'features', `${feature}.md`))
        } catch {
          return false
        }
      },
      { timeout },
    )
    .toBe(true)
}

async function theme(page: Page, value: 'light' | 'dark'): Promise<void> {
  await page.evaluate((next) => document.documentElement.setAttribute('data-theme', next), value)
  await page.waitForTimeout(200)
}

async function shotBoth(page: Page, name: string): Promise<void> {
  mkdirSync(SCREENS, { recursive: true })
  for (const value of ['dark', 'light'] as const) {
    await theme(page, value)
    await page.screenshot({ path: join(SCREENS, `ports-${name}-${value}.png`) })
  }
}

/**
 * THE DIAGRAM AT 100 %, for a person to look at: a copy of the pinned canvas,
 * untransformed, on an overlay inside the board (so the board's scoped styles
 * apply), shot as an element, then removed. Nothing is asserted on it.
 */
async function closeUp(page: Page, cell: Locator, name: string): Promise<void> {
  mkdirSync(SCREENS, { recursive: true })
  for (const value of ['dark', 'light'] as const) {
    await theme(page, value)
    await cell.locator('.fb-curated').evaluate((canvas) => {
      const root = canvas.closest('.flow-board-root') as HTMLElement
      const overlay = document.createElement('div')
      overlay.id = 'ports-closeup'
      overlay.style.cssText = 'position:fixed;left:0;top:0;z-index:99999;padding:16px;background:var(--fb-paper);'
      const copy = canvas.cloneNode(true) as HTMLElement
      copy.style.transform = 'none'
      copy.style.position = 'relative'
      overlay.appendChild(copy)
      root.appendChild(overlay)
    })
    await page.locator('#ports-closeup').screenshot({ path: join(SCREENS, `ports-${name}-${value}.png`) })
    await page.evaluate(() => document.getElementById('ports-closeup')?.remove())
  }
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
const terrCell = (page: Page, name: string): Locator =>
  page.locator('.fb-terr-cell:not(.fb-ws-cell)', { has: page.locator(':scope > .fb-terr-cell-name', { hasText: exactly(name) }) }).first()
const wsCell = (page: Page, name: string): Locator =>
  page.locator('.fb-ws-cell', { has: page.locator(':scope > .fb-terr-cell-name', { hasText: exactly(name) }) }).first()
const grown = (page: Page): Locator => page.locator('.fb-terr-cell.fb-terr-grown')

async function waitSettled(page: Page): Promise<void> {
  await page.waitForFunction(
    () => document.getAnimations().every((animation) => !(animation instanceof CSSTransition) || animation.playState !== 'running'),
    undefined,
    { timeout: 10_000 },
  )
  await page.waitForTimeout(60)
}

/** Click the cell open: grown in place, its diagram pinned at once (the click model, 2026-10-08). */
async function openCell(page: Page, cell: Locator): Promise<void> {
  await expect(async () => {
    if ((await grown(page).count()) > 0) {
      await grown(page).first().focus()
      await page.keyboard.press('Escape')
      await expect(grown(page)).toHaveCount(0, { timeout: 3_000 })
    }
    await waitSettled(page)
    await cell.click({ position: { x: 20, y: 20 }, timeout: 2_000 })
    await expect(cell).toHaveAttribute('data-grown-diagram', /.+/, { timeout: 30_000 })
    await expect(cell).toHaveClass(/fb-terr-pinned/, { timeout: 5_000 })
  }).toPass({ timeout: 120_000 })
  await waitSettled(page)
  await page.waitForTimeout(400)
  // Fit: the whole diagram, ports included, in view.
  await cell.locator('.fb-terr-pin-fit').click()
  await page.waitForTimeout(400)
}

/** Where every wire into a component ends, against that component's rectangle (canvas coordinates). */
async function wireEnds(cell: Locator): Promise<Array<{ node: string; side: string; onNode: boolean; detail: string }>> {
  return cell.evaluate((el) => {
    const canvas = el.querySelector<HTMLElement>('.fb-curated') as HTMLElement
    const host = canvas.querySelector<HTMLElement>('.fb-curated-flow') as HTMLElement
    const out: Array<{ node: string; side: string; onNode: boolean; detail: string }> = []
    for (const path of canvas.querySelectorAll<SVGPathElement>('.fb-port-wire')) {
      const node = path.dataset['node'] ?? ''
      if (node === '') continue
      const side = path.dataset['side'] ?? ''
      const nums = (path.getAttribute('d') ?? '').match(/-?\d+(\.\d+)?/g)?.map(Number) ?? []
      const card = host.querySelector<HTMLElement>(`.fb-curated-card[data-node-id="${node}"]`) as HTMLElement
      const left = host.offsetLeft + card.offsetLeft
      const right = left + card.offsetWidth
      const top = host.offsetTop + card.offsetTop
      const bottom = top + card.offsetHeight
      // In: the wire ENDS on the card's left edge. Out: it STARTS on its right edge.
      const [x, y] = side === 'in' ? nums.slice(-2) : nums.slice(0, 2)
      const edge = side === 'in' ? left : right
      out.push({
        node,
        side,
        onNode: Math.abs((x ?? 0) - edge) < 1.5 && (y ?? 0) >= top && (y ?? 0) <= bottom,
        detail: `${String(x)},${String(y)} vs x=${String(edge)} y=${String(top)}..${String(bottom)}`,
      })
    }
    return out
  })
}

test('a clicked-open diagram shows what comes in and goes out; a port follows its far end', async ({ window: page }) => {
  test.setTimeout(900_000)
  page.on('console', (message) => {
    if (message.text().includes('no ports') || message.text().includes('no diagram')) console.log(`[board] ${message.text()}`)
  })
  const root = await seedProject(page, 'flow-ux-ports-', seed)
  await activateProject(page, root)
  await waitForWorkspaceLink(root, 'learning')
  const sibling = await seedProject(page, 'flow-ux-ports-sib-', seedSibling)
  await waitForWorkspaceLink(sibling, 'billing')
  const here = workspaceOf(root)
  const there = workspaceOf(sibling)
  expect(there.workspace).toBe(here.workspace)
  writeViews(root, [VIEW])
  writeViews(sibling, [BILLING_VIEW])
  const ts = '2026-10-07T10:00:00.000Z'
  const links = [
    { ts, author: null, kind: 'calls', from: `${there.project}/billing`, to: `${here.project}/file:src/project/learn-orchestrator.ts`, note: 'monthly usage report', source: 'learned', evidence: 'code' },
    { ts, author: null, kind: 'calls', from: `${here.project}/file:src/project/learn-log.ts`, to: `${there.project}/billing`, note: 'usage events', source: 'learned', evidence: 'model' },
    { ts, author: null, kind: 'consumes', from: `${here.project}/learning`, to: `${there.project}/ledger`, note: 'posted invoices', source: 'learned', evidence: 'code' },
    { ts, author: null, kind: 'relates', from: `${here.project}/learning`, to: `${there.project}/billing`, note: 'shares the meter' },
  ]
  writeFileSync(join(here.workspace, 'links.jsonl'), links.map((link) => JSON.stringify(link)).join('\n') + '\n')

  const terminal = page.locator('[data-view-action="terminal"]')
  if ((await terminal.getAttribute('aria-pressed')) === 'true') await terminal.click()
  await dismissAsks(page)
  await page.locator('[data-view-action="blueprint"]').click()
  await expect(page.locator('.flow-board-root')).toBeVisible()

  // ── THE WORKSPACE MAP. ──
  const ws = wsCell(page, 'Learning')
  await expect(async () => {
    await page.mouse.move(2, 2)
    const up = page.locator('.flow-board-root .fb-ws-crumb:not(.on), .flow-board-root .fb-ws-title-up').first()
    if ((await page.locator('.fb-ws-country').count()) === 0 && (await up.isVisible().catch(() => false))) await up.click({ timeout: 2_000 })
    await expect(ws).toBeVisible({ timeout: 5_000 })
    await expect(wsCell(page, 'Billing')).toBeVisible({ timeout: 5_000 })
  }).toPass({ timeout: 300_000, intervals: [1_000, 2_000, 5_000] })
  await page.waitForTimeout(2_000)
  await dismissAsks(page)
  // ── OPENED BY A CLICK, PINNED AT ONCE: the ports whole. (The unpinned
  // preview that only counted them was the hover's; a click opens straight
  // into exploring, so there is no preview on the way.) ──
  await openCell(page, ws)
  await expect(ws.locator('.fb-curated.fb-has-ports')).toHaveCount(1, { timeout: 20_000 })
  const canvas = ws.locator('.fb-curated')
  await expect(canvas).toHaveClass(/fb-ports-full/)
  const ins = canvas.locator('.fb-port.fb-port-in')
  const outs = canvas.locator('.fb-port.fb-port-out')
  await expect(ins).toHaveCount(1)
  await expect(outs).toHaveCount(2)
  await expect(canvas.locator('.fb-port.fb-port-linked')).toHaveCount(1)
  await expect(canvas.locator('.fb-port-head')).toHaveText(['Comes in', 'Goes out', 'Linked'])
  const entry = ins.first()
  await expect(entry.locator('.fb-port-crosses')).toHaveText('monthly usage report')
  await expect(entry.locator('.fb-port-place')).toContainText('Billing')
  await expect(entry).toHaveAttribute('data-node', 'queue')
  // THE MODEL-ONLY PORT: dashed and saying so.
  const suggested = canvas.locator('.fb-port.fb-port-suggested')
  await expect(suggested).toHaveCount(1)
  await expect(suggested.locator('.fb-port-note')).toHaveText('suggested by Flow')
  expect(await suggested.evaluate((el) => getComputedStyle(el).borderTopStyle)).toBe('dashed')
  expect(await entry.evaluate((el) => getComputedStyle(el).borderTopStyle)).toBe('solid')
  await expect(canvas.locator('.fb-port-wire.fb-port-suggested')).toHaveCount(1)
  // THE FEATURE-LEVEL EXIT touches no component: it is wired to the diagram's edge.
  await expect(canvas.locator('.fb-port.fb-port-out[data-node=""]')).toHaveCount(1)
  // EVERY COMPONENT WIRE ENDS ON ITS COMPONENT.
  const ends = await wireEnds(ws)
  console.log(`[spec] wire ends: ${JSON.stringify(ends)}`)
  expect(ends.map((end) => end.node).sort()).toEqual(['log', 'queue'])
  for (const end of ends) expect(end.onNode, `${end.node}: ${end.detail}`).toBe(true)
  // NOTHING COLLIDES: no port over a card, no two ports over each other.
  const overlaps = await canvas.evaluate((el) => {
    const rects = (selector: string) => [...el.querySelectorAll<HTMLElement>(selector)].map((node) => node.getBoundingClientRect())
    const ports = rects('.fb-port')
    const cards = rects('.fb-curated-card')
    const hit = (a: DOMRect, b: DOMRect) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
    let count = 0
    ports.forEach((a, i) => {
      for (const card of cards) if (hit(a, card)) count += 1
      ports.slice(i + 1).forEach((b) => {
        if (hit(a, b)) count += 1
      })
    })
    return count
  })
  expect(overlaps).toBe(0)
  await shotBoth(page, 'pinned-workspace')
  await closeUp(page, ws, 'pinned-closeup')

  // ── PRESS THE FAR FEATURE: the board goes to Billing, in its own project. ──
  await expect(entry).toHaveAttribute('title', /Go to Billing$/)
  await entry.click()
  await expect(page.locator('.fb-terr-cell.fb-terr-pinned')).toHaveCount(0)
  await expect
    .poll(() => page.evaluate(async () => (await (window as unknown as { flow: { project: { active(): Promise<{ rootPath: string } | null> } } }).flow.project.active())?.rootPath ?? null), { timeout: 60_000 })
    .toBe(sibling)
  // The board stands IN Billing: its own level, named.
  await expect(page.getByRole('button', { name: "Open Billing's feature view" })).toBeVisible({ timeout: 60_000 })
  // The sibling's first activation opens its own settings once (per-project onboarding).
  await dismissFlowOverlay(page)
  await page.waitForTimeout(1_000)
  await shotBoth(page, 'followed-billing')
  // The project board under its own feature: no stale pin, no story.
  await expect(page.locator('.fb-story')).toHaveCount(0)
  void terrCell
})
