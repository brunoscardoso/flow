import type { BlueprintFeatureNode, BlueprintWorkspaceGraph, BlueprintWorkspaceProject } from '../../shared/ipc-contract'
import {
  buildWorkspaceSheet,
  cellKey,
  colourSlot,
  connectionsChip,
  COULD_NOT_READ,
  countryMeta,
  NOT_ON_THIS_COMPUTER,
  understoodFigure,
  workspaceIsRoot,
  workspaceUnit,
  WORKSPACE_PALETTE_SIZE,
  WS_BAND_H,
  WS_GUTTER, connectionsControlView, pairsChecked } from './workspace-sheet'
import { understoodFraction } from './learn-progress-model'
import type { Rect } from './territory-layout'

const STAGE = { width: 1200, height: 700 }

function core(id: string, lines: number | undefined, understanding: BlueprintFeatureNode['understanding'] = 'none'): BlueprintFeatureNode {
  return {
    id,
    slug: id.split('::').pop() ?? id,
    name: id.split('::').pop() ?? id,
    kind: 'core',
    understanding,
    active: false,
    anchorCount: 2,
    ...(lines === undefined ? {} : { size: { files: 1, lines } }),
  }
}

function project(
  slug: string,
  colorIndex: number,
  nodes: BlueprintFeatureNode[] | null,
  extra: Partial<BlueprintWorkspaceProject> = {},
): BlueprintWorkspaceProject {
  const cores = (nodes ?? []).filter((node) => node.kind === 'core')
  const measured = cores.every((node) => node.size !== undefined)
  const learned = cores.filter((node) => node.understanding === 'learned').length
  return {
    id: `github.com/acme/${slug}`,
    slug,
    name: slug,
    description: null,
    colorIndex,
    current: false,
    local: `/code/${slug}`,
    state: nodes === null ? 'unreadable' : 'local',
    error: nodes === null ? 'boom' : null,
    sizeSource: 'measured',
    graph: nodes === null ? null : { nodes, edges: [] },
    totals: {
      features: cores.length,
      lines: nodes === null || !measured ? null : cores.reduce((sum, node) => sum + (node.size?.lines ?? 0), 0),
      understood: cores.length === 0 ? null : { done: learned, total: cores.length },
    },
    connections: 0,
    ...extra,
  }
}

function graphOf(projects: BlueprintWorkspaceProject[], links: BlueprintWorkspaceGraph['links'] = []): BlueprintWorkspaceGraph {
  return { available: true, reason: null, workspace: { name: 'Team', slug: 'team' }, projects, links, linksError: null }
}

const area = (rect: Rect): number => rect.w * rect.h

function overlaps(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
}

/** The clear distance between two rectangles that do not overlap. */
function gap(a: Rect, b: Rect): number {
  const dx = Math.max(b.x - (a.x + a.w), a.x - (b.x + b.w), 0)
  const dy = Math.max(b.y - (a.y + a.h), a.y - (b.y + b.h), 0)
  return Math.max(dx, dy)
}

describe('workspace sheet — countries', () => {
  const big = project('core', 0, [core('feature:core::engine', 9000, 'learned'), core('feature:core::auth', 3000)])
  const mid = project('app', 1, [core('feature:app::chats', 3000, 'learned'), core('feature:app::spaces', 1000, 'learned')], { current: true })
  const small = project('mobile', 2, [core('feature:mobile::login', 1000)])
  const view = buildWorkspaceSheet(graphOf([big, mid, small]), { stage: STAGE, showConnections: false })

  it('draws the selected thread’s project as the big ground, the others sized by lines beside it', () => {
    expect(view.countries.map((country) => country.slug)).toEqual(['app', 'core', 'mobile'])
    const [lead, b, c] = view.countries.map((country) => area(country.rect))
    // app is the SMALLER codebase, and still leads: the map is read from where the reader works
    expect(lead).toBeGreaterThan(b + c)
    expect(b).toBeGreaterThan(c)
    expect(view.unit).toBe('lines')
  })

  it('moves the big ground with the thread — the smallest project leads when it is the current one', () => {
    const others = [{ ...big, current: false }, { ...mid, current: false }, { ...small, current: true }]
    const moved = buildWorkspaceSheet(graphOf(others), { stage: STAGE, showConnections: false })
    expect(moved.countries[0].slug).toBe('mobile')
    const [lead, ...rest] = moved.countries.map((country) => area(country.rect))
    expect(lead).toBeGreaterThan(rest.reduce((sum, value) => sum + value, 0))
  })

  it('with no current project, every project is sized by its code, largest first', () => {
    const none = buildWorkspaceSheet(graphOf([big, { ...mid, current: false }, small]), { stage: STAGE, showConnections: false })
    expect(none.countries.map((country) => country.slug)).toEqual(['core', 'app', 'mobile'])
    const [a, b, c] = none.countries.map((country) => area(country.rect))
    expect(a).toBeGreaterThan(b)
    expect(b).toBeGreaterThan(c)
  })

  it('keeps a clear gutter between every two projects, and none overlap', () => {
    for (let i = 0; i < view.countries.length; i += 1) {
      for (let j = i + 1; j < view.countries.length; j += 1) {
        const a = view.countries[i].rect
        const b = view.countries[j].rect
        expect(overlaps(a, b)).toBe(false)
        expect(gap(a, b)).toBeGreaterThanOrEqual(WS_GUTTER - 0.01)
      }
    }
  })

  it('packs each project’s features inside its own country, below its band', () => {
    for (const country of view.countries) {
      for (const key of country.cellKeys) {
        const cell = view.cells.find((entry) => entry.key === key)
        expect(cell?.project).toBe(country.slug)
        const rect = cell?.rect as Rect
        expect(rect.y).toBeGreaterThanOrEqual(country.rect.y + WS_BAND_H - 0.01)
        expect(rect.x).toBeGreaterThanOrEqual(country.rect.x)
        expect(rect.x + rect.w).toBeLessThanOrEqual(country.rect.x + country.rect.w + 0.01)
      }
    }
    expect(view.cells.map((cell) => cell.key)).toContain(cellKey('core', 'feature:core::engine'))
  })

  it('says what each project holds; its connection count is a number for the hover, not a chip', () => {
    const app = view.countries.find((country) => country.slug === 'app')
    expect(app?.meta).toBe('2 features · 4k lines · 100% understood')
    expect(app?.current).toBe(true)
    const linked = buildWorkspaceSheet(graphOf([{ ...big, connections: 3 }, mid]), { stage: STAGE, showConnections: false })
    expect(linked.countries.find((country) => country.slug === 'core')?.connections).toBe(3)
    expect(connectionsChip(1)).toBe('1 connection')
    expect(connectionsChip(0)).toBeNull()
  })

  it('rolls understood up by summing counts — the same function the strip uses inside a project', () => {
    expect(view.title.understood).toEqual({ done: 3, total: 5 })
    expect(view.title.figure).toBe('60% understood')
    expect(view.title.kicker).toBe('3 projects · 5 features')
    // The project's own figure on its title strip comes from the same arithmetic.
    expect(understoodFraction(mid.graph?.nodes, 'features')).toEqual(mid.totals.understood)
    expect(understoodFigure(null)).toBe('')
  })
})

describe('workspace sheet — colours', () => {
  it('assigns a stable slot from the project’s index, wrapping the palette', () => {
    expect(colourSlot(0)).toBe(0)
    expect(colourSlot(3)).toBe(3)
    expect(colourSlot(WORKSPACE_PALETTE_SIZE + 2)).toBe(2)
    expect(colourSlot(-1)).toBe(WORKSPACE_PALETTE_SIZE - 1)
  })

  it('a project keeps its colour when the sheet re-packs', () => {
    const a = project('a', 4, [core('feature:a::x', 100)])
    const b = project('b', 1, [core('feature:b::y', 9000)])
    const view = buildWorkspaceSheet(graphOf([a, b]), { stage: STAGE, showConnections: false })
    expect(view.countries.find((country) => country.slug === 'a')?.slot).toBe(4)
    expect(view.countries.find((country) => country.slug === 'b')?.slot).toBe(1)
  })
})

describe('workspace sheet — projects not on this computer, and failures', () => {
  it('draws a teammate’s project from the shared knowledge, muted, with a plain note and its last known size', () => {
    const local = project('core', 0, [core('feature:core::engine', 4000)])
    const remote = project('mobile', 1, [core('feature:mobile::login', 2000)], { state: 'remote', local: null, sizeSource: 'last-known', connections: 2 })
    const view = buildWorkspaceSheet(graphOf([local, remote]), { stage: STAGE, showConnections: false })
    const country = view.countries.find((entry) => entry.slug === 'mobile')
    expect(country?.note).toBe(NOT_ON_THIS_COMPUTER)
    expect(country?.state).toBe('remote')
    expect(country?.zoomable).toBe(true)
    expect(country?.connections).toBe(2)
    expect(country?.cellKeys).toEqual([cellKey('mobile', 'feature:mobile::login')])
    expect(view.unit).toBe('lines')
  })

  it('a project that could not be read says so and the others still draw', () => {
    const ok = project('core', 0, [core('feature:core::engine', 4000)])
    const broken = project('broken', 1, null)
    const view = buildWorkspaceSheet(graphOf([ok, broken]), { stage: STAGE, showConnections: false })
    const country = view.countries.find((entry) => entry.slug === 'broken')
    expect(country?.note).toBe(COULD_NOT_READ)
    expect(country?.zoomable).toBe(false)
    expect(country?.cellKeys).toEqual([])
    expect(country?.meta).toBe('')
    expect(area(country?.rect as Rect)).toBeGreaterThan(0)
    expect(view.cells.map((cell) => cell.project)).toEqual(['core'])
  })

  it('a project with no known size switches the whole sheet to counting features, never a mix', () => {
    const measured = project('core', 0, [core('feature:core::engine', 4000)])
    const unknown = project('mobile', 1, [core('feature:mobile::login', undefined), core('feature:mobile::push', undefined)], {
      state: 'remote',
      local: null,
      sizeSource: 'none',
    })
    expect(workspaceUnit([measured, unknown])).toBe('features')
    const view = buildWorkspaceSheet(graphOf([measured, unknown]), { stage: STAGE, showConnections: false })
    expect(view.block).toContain('area = features')
    const [first] = view.countries
    expect(first.slug).toBe('mobile') // two features outweigh one
  })

  it('opens at the Workspace only when there are two or more projects', () => {
    const one = graphOf([project('core', 0, [core('feature:core::engine', 1)])])
    expect(workspaceIsRoot(one)).toBe(false)
    expect(workspaceIsRoot(graphOf([...one.projects, project('app', 1, [])]))).toBe(true)
    expect(workspaceIsRoot({ ...one, available: false })).toBe(false)
    expect(workspaceIsRoot(null)).toBe(false)
  })

  it('a country with nothing measured still says what it holds', () => {
    const p = project('x', 0, [core('feature:x::a', undefined, 'learned')])
    expect(countryMeta(p)).toBe('1 feature · 100% understood')
  })
})

describe('workspace sheet — connections learning', () => {
  const learning = { pairs: 10, learned: 6, pending: 3, blocked: 1, lastCheckedAt: null }

  it('the title strip says how many pairs are checked', () => {
    expect(pairsChecked(learning)).toBe('6 of 10 pairs checked')
    expect(pairsChecked({ ...learning, pairs: 1, learned: 0 })).toBe('0 of 1 pair checked')
    expect(pairsChecked(null)).toBeNull()
    expect(pairsChecked({ ...learning, pairs: 0 })).toBeNull()
  })

  it('ONE control: learn, the run, then the toggle with an Update while pairs changed', () => {
    const view = (over: Partial<Parameters<typeof connectionsControlView>[0]>) =>
      connectionsControlView({ run: null, learning, links: 0, showing: false, ...over })
    // Nothing to draw yet, pairs to check.
    expect(view({})).toMatchObject({ mode: 'learn', label: 'Learn connections', disabled: false, update: null })
    expect(view({}).title).toBe('6 of 10 pairs checked · Find how these projects talk to each other.')
    // A run going.
    expect(view({ run: { workspace: 'w', running: true, done: 3, total: 10, found: 1, error: null, current: ['app', 'core'] }, projectName: (slug) => `orbit-${slug}` })).toMatchObject({
      mode: 'learning',
      label: '30%',
      title: 'Learning connections — checking orbit-app ↔ orbit-core, 3 of 10 pairs done',
      disabled: true,
    })
    // Before the plan is read, it says what it is doing rather than a number.
    expect(view({ run: { workspace: 'w', running: true, done: 0, total: 0, found: 0, error: null } }).label).toBe('…')
    // Connections there, some pairs changed: the toggle with Update attached.
    expect(view({ links: 4, showing: true })).toMatchObject({
      mode: 'toggle',
      label: 'Connections · 4',
      pressed: true,
      update: { label: 'Update', title: '3 pairs changed since they were checked — check them again' },
    })
    // Everything checked: just the toggle.
    expect(view({ links: 4, learning: { ...learning, learned: 10, pending: 0, blocked: 0 } }).update).toBeNull()
    // Everything checked and nothing found.
    expect(view({ learning: { ...learning, learned: 9, pending: 0, blocked: 1 } })).toMatchObject({ mode: 'none', label: 'No connections found', disabled: true })
    // Unreadable links win over everything.
    expect(view({ links: null, run: { workspace: 'w', running: true, done: 0, total: 1, found: 0, error: null } })).toMatchObject({ mode: 'unreadable', disabled: true })
    // A run that ended badly says so on the control.
    expect(view({ run: { workspace: 'w', running: false, done: 2, total: 2, found: 0, error: 'Flow will try them again.' } }).title).toMatch(/Flow will try them again\.$/)
  })

})

describe('workspace sheet — a cell says what the project board says (2026-10-06)', () => {
  it('carries the description (for its details), the files · parts · changes line, the path and the parts fraction', () => {
    const web: BlueprintFeatureNode = { ...core('feature:core::web', 4000, 'learning'), summary: 'FastAPI routes and handlers.', size: { files: 428, lines: 4000 } }
    const db: BlueprintFeatureNode = { ...core('feature:core::db', 3000), summary: 'Confirmed from code:module/orbit_core/db.', size: { files: 31, lines: 3000 } }
    const part = (slug: string, understanding: BlueprintFeatureNode['understanding']): BlueprintFeatureNode => ({
      id: `feature:core::${slug}`, slug, name: slug, kind: 'part', partOf: 'web', understanding, active: false, anchorCount: 1,
    })
    const change: BlueprintFeatureNode = { id: 'feature:core::chg', slug: 'chg', name: 'A change', kind: 'child', parent: web.id, understanding: 'none', active: false, anchorCount: 0 }
    const view = buildWorkspaceSheet(
      graphOf([project('core', 0, [web, db, part('routes', 'learned'), part('handlers', 'none'), change]), project('app', 1, [core('feature:app::chats', 500)])]),
      { stage: STAGE, showConnections: false },
    )
    const webCell = view.cells.find((cell) => cell.id === web.id)
    const dbCell = view.cells.find((cell) => cell.id === db.id)
    // Calm at rest: the description rides the cell for its details, never printed on it.
    expect(webCell).toMatchObject({ summary: 'FastAPI routes and handlers.', description: 'FastAPI routes and handlers.', secondLine: '428 files · 2 parts · 1 change', path: null })
    expect(webCell?.progress).toEqual({ done: 1, total: 2, of: 'parts' })
    // Provenance is a path, never a description.
    expect(dbCell).toMatchObject({ summary: null, path: 'orbit_core/db', secondLine: '31 files' })
  })
})

describe('workspace sheet — a hovered feature grows in place (plan cell-hover-diagram)', () => {
  const big = project('core', 0, [core('feature:core::engine', 9000), core('feature:core::auth', 3000), core('feature:core::jobs', 2000)])
  const mid = project('app', 1, [core('feature:app::chats', 3000), core('feature:app::spaces', 1000)], { current: true })
  const small = project('mobile', 2, [core('feature:mobile::login', 1000), core('feature:mobile::push', 600)])
  const graph = graphOf([big, mid, small])
  const plain = buildWorkspaceSheet(graph, { stage: STAGE, showConnections: false })
  const centre = (r: Rect): { x: number; y: number } => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 })
  const holds = (r: Rect, p: { x: number; y: number }): boolean => p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h

  it.each(['app|feature:app::spaces', 'core|feature:core::auth', 'mobile|feature:mobile::push'])('%s: its project and the feature both grow, keeping their centres', (key) => {
    const grown = buildWorkspaceSheet(graph, { stage: STAGE, showConnections: false, focus: key })
    const slug = key.split('|')[0] as string
    const before = plain.countries.find((country) => country.slug === slug) as (typeof plain.countries)[number]
    const after = grown.countries.find((country) => country.slug === slug) as (typeof plain.countries)[number]
    expect(area(after.rect)).toBeGreaterThanOrEqual(area(before.rect) - 1e-6)
    expect(area(after.rect) / area(grown.sheet)).toBeGreaterThan(0.6)
    expect(holds(after.rect, centre(before.rect))).toBe(true)
    // Same countries, same order.
    expect(grown.countries.map((country) => country.slug)).toEqual(plain.countries.map((country) => country.slug))
    const cellBefore = plain.cells.find((cell) => cell.key === key) as (typeof plain.cells)[number]
    const cellAfter = grown.cells.find((cell) => cell.key === key) as (typeof plain.cells)[number]
    expect(area(cellAfter.rect)).toBeGreaterThan(area(cellBefore.rect))
    expect(holds(cellAfter.rect, centre(cellBefore.rect))).toBe(true)
    expect(grown.cells.map((cell) => cell.key)).toEqual(plain.cells.map((cell) => cell.key))
    // Every cell still stands in its own country, and no two overlap.
    for (const cell of grown.cells) {
      const country = grown.countries.find((entry) => entry.slug === cell.project) as (typeof plain.countries)[number]
      expect(cell.rect.x).toBeGreaterThanOrEqual(country.inner.x - 1e-6)
      expect(cell.rect.x + cell.rect.w).toBeLessThanOrEqual(country.inner.x + country.inner.w + 1e-6)
    }
    for (const a of grown.countries) for (const b of grown.countries) if (a !== b) expect(overlaps(a.rect, b.rect)).toBe(false)
    // The projects that made room keep their features' names.
    for (const cell of grown.cells) if (cell.key !== key) expect(['', 'tiny']).toContain(cell.labelClass)
  })

  it.each(['app|feature:app::spaces', 'core|feature:core::auth', 'mobile|feature:mobile::push'])(
    '%s details (a hover): reaches its details size, no bigger than opened, nothing on top of it',
    (key) => {
      const details = buildWorkspaceSheet(graph, { stage: STAGE, showConnections: false, focus: key, focusMode: 'details' })
      const opened = buildWorkspaceSheet(graph, { stage: STAGE, showConnections: false, focus: key })
      const cell = details.cells.find((entry) => entry.key === key) as (typeof details.cells)[number]
      const before = plain.cells.find((entry) => entry.key === key) as (typeof plain.cells)[number]
      expect(cell.rect.w).toBeGreaterThanOrEqual(Math.max(before.rect.w, 320) - 1)
      expect(cell.rect.h).toBeGreaterThanOrEqual(Math.max(before.rect.h, 230) - 1)
      expect(area(cell.rect)).toBeLessThanOrEqual(area((opened.cells.find((entry) => entry.key === key) as typeof cell).rect) + 1e-6)
      expect(holds(cell.rect, centre(before.rect))).toBe(true)
      for (const other of details.cells) if (other.key !== key) expect(overlaps(other.rect, cell.rect)).toBe(false)
      for (const a of details.countries) for (const b of details.countries) if (a !== b) expect(overlaps(a.rect, b.rect)).toBe(false)
    },
  )

  it('moving the grow to a feature in another project: it contains where it was drawn shrunk', () => {
    const around = buildWorkspaceSheet(graph, { stage: STAGE, showConnections: false, focus: 'app|feature:app::spaces' })
    const shrunk = (around.cells.find((cell) => cell.key === 'mobile|feature:mobile::push') as (typeof around.cells)[number]).rect
    const moved = buildWorkspaceSheet(graph, { stage: STAGE, showConnections: false, focus: 'mobile|feature:mobile::push', previous: 'app|feature:app::spaces' })
    const cell = moved.cells.find((entry) => entry.key === 'mobile|feature:mobile::push') as (typeof moved.cells)[number]
    expect(holds(cell.rect, centre(shrunk))).toBe(true)
    expect(area(cell.rect)).toBeGreaterThan(area(shrunk))
  })

  it('no focus is the plain map', () => {
    expect(buildWorkspaceSheet(graph, { stage: STAGE, showConnections: false, focus: null })).toEqual(plain)
  })
})

describe('workspace sheet — where a feature lives (plan feature-home-folders)', () => {
  it("carries the same folder rows as the project board, the root read as the project's name", () => {
    const folders = {
      rows: [
        { path: '.', lines: 3000, files: 4, share: 0.75 },
        { path: 'src/db', lines: 1000, files: 2, share: 0.25 },
      ],
      folderCount: 2,
      spread: false,
      pinned: false,
      pinMissing: null,
      files: 6,
      lines: 4000,
    }
    const web: BlueprintFeatureNode = { ...core('feature:core::web', 4000), summary: 'Confirmed from code:module/orbit_core/web.', folders }
    const view = buildWorkspaceSheet(graphOf([project('core', 0, [web]), project('app', 1, [core('feature:app::chats', 500)])]), {
      stage: STAGE,
      showConnections: false,
    })
    const cell = view.cells.find((c) => c.id === web.id)
    expect(cell?.folders?.rows.map((row) => row.display)).toEqual(['core', 'db'])
    expect(cell?.folders?.line.text).toBe('core 75%')
    // The home line replaces the provenance path.
    expect(cell?.path).toBeNull()
    expect(view.cells.find((c) => c.id === 'feature:app::chats')?.folders).toBeNull()
  })
})

describe('a Workspace cell carries its type (plan feature-type-icons)', () => {
  it('copies role and source from the node and shows the icon only on the full-name tier', () => {
    const typed: BlueprintFeatureNode = { ...core('alpha::chats', 4000, 'learned'), role: 'api', roleSource: 'learn' }
    const plain = core('alpha::old', 2000)
    const sheet = buildWorkspaceSheet(graphOf([project('alpha', 0, [typed, plain])]), { stage: STAGE, showConnections: false })
    const chats = sheet.cells.find((cell) => cell.id === 'alpha::chats')
    const old = sheet.cells.find((cell) => cell.id === 'alpha::old')
    expect(chats).toMatchObject({ role: 'api', roleSource: 'learn' })
    expect(chats?.showRoleIcon).toBe(chats?.labelClass === '')
    expect(chats?.labelClass).toBe('')
    expect(old).toMatchObject({ role: null, roleSource: null, showRoleIcon: false })
  })
})
