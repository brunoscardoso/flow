import type { BlueprintWorkspaceLink } from '../../shared/ipc-contract'
import {
  BRIDGE_BASE,
  BRIDGE_STEP,
  bridgeBetween,
  connectedCellKeys,
  connectionSentences,
  curvePath,
  EDGE_LABEL_SPACING,
  facingPoint,
  offEdgeLines,
  pairKey,
  projectRibbons,
  RIBBON_MAX,
  ribbonWidth,
  allLinkLines,
  ALL_LINES_LIMIT,
  drawsEveryLink,
  linkedCellKeys,
  type PlacedCell,
} from './workspace-links'
import type { Rect } from './territory-layout'

const keyOf = (project: string, id: string): string => `${project}|${id}`

function link(
  kind: BlueprintWorkspaceLink['kind'],
  from: [string, string[] , string?],
  to: [string, string[], string?],
  note?: string,
): BlueprintWorkspaceLink {
  const end = ([project, features, ref]: [string, string[], string?]) => ({
    address: `${project}/${ref ?? 'x'}`,
    project,
    ref: ref ?? (features[0]?.split('::').pop() ?? 'x'),
    type: ref?.includes(':') === true ? ('anchor' as const) : ('feature' as const),
    features,
  })
  return { kind, from: end(from), to: end(to), ...(note === undefined ? {} : { note }) }
}

/** Is a point on the border of a rect? */
function onBorder(p: { x: number; y: number }, r: Rect): boolean {
  const eps = 0.01
  const inX = p.x >= r.x - eps && p.x <= r.x + r.w + eps
  const inY = p.y >= r.y - eps && p.y <= r.y + r.h + eps
  const onV = Math.abs(p.x - r.x) < eps || Math.abs(p.x - (r.x + r.w)) < eps
  const onH = Math.abs(p.y - r.y) < eps || Math.abs(p.y - (r.y + r.h)) < eps
  return inX && inY && (onV || onH)
}

describe('facingPoint — where a line leaves a rectangle', () => {
  const left: Rect = { x: 0, y: 0, w: 100, h: 200 }
  const right: Rect = { x: 120, y: 50, w: 100, h: 200 }
  const below: Rect = { x: 10, y: 230, w: 80, h: 60 }

  it('side by side: the facing sides, in the middle of the span they share', () => {
    const p = facingPoint(left, right)
    expect(p).toEqual({ x: 100, y: 125, nx: 1, ny: 0 })
    const q = facingPoint(right, left)
    expect(q).toEqual({ x: 120, y: 125, nx: -1, ny: 0 })
  })

  it('stacked: top and bottom, straight across the gutter', () => {
    const p = facingPoint(left, below)
    expect(p.ny).toBe(1)
    expect(p.y).toBe(200)
    expect(p.x).toBe(50)
    expect(facingPoint(below, left)).toMatchObject({ y: 230, ny: -1, x: 50 })
  })

  it('always lands on the border, even for rectangles that share no span', () => {
    const far: Rect = { x: 400, y: 600, w: 50, h: 50 }
    for (const [a, b] of [[left, far], [far, left], [right, far], [below, right]] as [Rect, Rect][]) {
      expect(onBorder(facingPoint(a, b), a)).toBe(true)
    }
  })

  it('a curve leaves along both normals', () => {
    expect(curvePath({ x: 0, y: 0, nx: 1, ny: 0 }, { x: 100, y: 0, nx: -1, ny: 0 }, 10)).toBe('M0,0 C10,0 90,0 100,0')
  })
})

describe('projectRibbons — one per pair, thickness by count', () => {
  const countries = new Map<string, Rect>([
    ['core', { x: 0, y: 0, w: 400, h: 300 }],
    ['app', { x: 420, y: 0, w: 300, h: 300 }],
    ['mobile', { x: 0, y: 320, w: 400, h: 200 }],
  ])
  const links = [
    link('consumes', ['app', ['feature:app::chats']], ['core', ['feature:core::engine']]),
    link('calls', ['core', ['feature:core::auth']], ['app', ['feature:app::auth']]),
    link('calls', ['mobile', ['feature:mobile::login']], ['core', ['feature:core::auth']]),
    link('relates', ['app', []], ['gone', []]),
  ]
  const ribbons = projectRibbons(links, countries)

  it('pairs links by the two projects, whichever way round they were recorded', () => {
    expect(ribbons.map((ribbon) => [ribbon.key, ribbon.count])).toEqual([
      [pairKey('app', 'core'), 2],
      [pairKey('core', 'mobile'), 1],
    ])
  })

  it('is thicker for more links, and capped', () => {
    expect(ribbons[0].width).toBeGreaterThan(ribbons[1].width)
    expect(ribbonWidth(100)).toBe(RIBBON_MAX)
  })

  it('runs between the facing edges, so it crosses the gutter and never a cell', () => {
    const appCore = ribbons[0]
    expect(onBorder(appCore.from, countries.get('app') as Rect)).toBe(true)
    expect(onBorder(appCore.to, countries.get('core') as Rect)).toBe(true)
    // app is right of core: they meet across the vertical gutter at x 400…420.
    expect([appCore.from.x, appCore.to.x].sort()).toEqual([400, 420])
    // the count pill sits between the two.
    expect(appCore.pill.x).toBeGreaterThanOrEqual(400)
    expect(appCore.pill.x).toBeLessThanOrEqual(420)
  })

  it('a link to a project that is not drawn is not a ribbon', () => {
    expect(ribbons.some((ribbon) => ribbon.key.includes('gone'))).toBe(false)
  })
})

describe('bridges — neighbours across a narrow gutter (live, 2026-10-06)', () => {
  it('two side-by-side blocks get a visible band filling the gutter, longer with more links', () => {
    const left = { x: 0, y: 0, w: 300, h: 400 }
    const right = { x: 314, y: 0, w: 200, h: 400 }
    const one = bridgeBetween(facingPoint(left, right), facingPoint(right, left), 1, 400)
    const four = bridgeBetween(facingPoint(left, right), facingPoint(right, left), 4, 400)
    expect(one).toEqual({ x: 300, y: 200 - (BRIDGE_BASE + BRIDGE_STEP) / 2, w: 14, h: BRIDGE_BASE + BRIDGE_STEP })
    expect(four!.h).toBeGreaterThan(one!.h)
    expect(four!.w).toBe(14)
  })

  it('a bridge never runs past the edge the two blocks share', () => {
    const top = { x: 0, y: 0, w: 60, h: 100 }
    const bottom = { x: 0, y: 114, w: 60, h: 100 }
    const band = bridgeBetween(facingPoint(top, bottom), facingPoint(bottom, top), 9, 60)
    expect(band).not.toBeNull()
    expect(band!.w).toBeLessThanOrEqual(60 - 8)
  })

  it('blocks far apart keep a curve (no bridge)', () => {
    const a = { x: 0, y: 0, w: 100, h: 100 }
    const b = { x: 400, y: 0, w: 100, h: 100 }
    expect(bridgeBetween(facingPoint(a, b), facingPoint(b, a), 2, 100)).toBeNull()
  })
})

describe('offEdgeLines — zoomed into one project', () => {
  const sheet: Rect = { x: 6, y: 32, w: 1000, h: 500 }
  const cells = new Map<string, Rect>([
    ['feature:app::chats', { x: 10, y: 40, w: 200, h: 100 }],
    ['feature:app::auth', { x: 10, y: 50, w: 200, h: 10 }],
  ])
  const links = [
    link('consumes', ['app', ['feature:app::chats']], ['core', ['feature:core::engine']]),
    link('calls', ['app', ['feature:app::chats']], ['mobile', []]),
    link('consumes', ['mobile', []], ['app', ['feature:app::auth']]),
    link('calls', ['core', ['feature:core::x']], ['mobile', []]),
    link('consumes', ['app', ['feature:app::deep']], ['core', []]),
  ]
  const lines = offEdgeLines({ links, project: 'app', cells, sheet, projectName: (slug) => slug.toUpperCase() })

  it('runs each of the project’s links to the right edge, labelled with the other project', () => {
    expect(lines.map((line) => `${line.key}→${String(line.label)}`).sort()).toEqual([
      'feature:app::auth|mobile→MOBILE',
      'feature:app::chats|core→CORE',
      'feature:app::chats|mobile→MOBILE',
    ])
    for (const line of lines) {
      expect(line.offEdge).toBe(true)
      expect(line.to.x).toBeGreaterThan(sheet.x + sheet.w)
    }
  })

  it('spaces the labels so none sits on another', () => {
    const ys = lines.map((line) => line.to.y)
    for (let i = 1; i < ys.length; i += 1) expect(ys[i] - ys[i - 1]).toBeGreaterThanOrEqual(EDGE_LABEL_SPACING)
  })

  it('ignores links between two other projects, and features not drawn on this level', () => {
    expect(lines.some((line) => line.key.includes('deep'))).toBe(false)
    expect(lines.some((line) => line.key.includes('core::x'))).toBe(false)
  })
})

describe('connectionSentences — the foot, in plain words', () => {
  const names: Record<string, string> = {
    'feature:app::chats': 'Chats',
    'feature:core::engine': 'Chat Engine',
    'feature:core::auth': 'Auth & OIDC',
  }
  const projects: Record<string, string> = { app: 'orbit-app', core: 'orbit-core', mobile: 'storefront-mobile' }
  const say = (links: BlueprintWorkspaceLink[], project: string, id: string): string[] =>
    connectionSentences({ links, project, id, featureName: (_p, fid) => names[fid], projectName: (slug) => projects[slug] ?? slug })

  it('reads from the selected side, either way round', () => {
    const links = [
      link('consumes', ['app', ['feature:app::chats']], ['core', ['feature:core::engine']]),
      link('calls', ['mobile', [], 'endpoint:POST /login'], ['core', ['feature:core::auth']], 'OIDC login'),
    ]
    expect(say(links, 'app', 'feature:app::chats')).toEqual(['Chats consumes Chat Engine in orbit-core'])
    expect(say(links, 'core', 'feature:core::engine')).toEqual(['Chat Engine is consumed by Chats in orbit-app'])
    expect(say(links, 'core', 'feature:core::auth')).toEqual(['Auth & OIDC is called by POST /login in storefront-mobile (OIDC login)'])
  })

  it('says nothing for a feature with no connections', () => {
    expect(say([], 'app', 'feature:app::chats')).toEqual([])
  })
})

describe('connectedCellKeys — the cells lit by one feature’s connections', () => {
  it('lights the feature and every feature on the other end of its links, and nothing else', () => {
    const links = [
      link('consumes', ['app', ['feature:app::chats']], ['core', ['feature:core::engine']]),
      link('calls', ['core', ['feature:core::auth']], ['app', ['feature:app::chats']]),
      link('calls', ['mobile', ['feature:mobile::login']], ['core', ['feature:core::auth']]),
    ]
    expect([...connectedCellKeys(links, 'app', 'feature:app::chats', keyOf)].sort()).toEqual([
      'app|feature:app::chats',
      'core|feature:core::auth',
      'core|feature:core::engine',
    ])
  })
})

describe('suggested connections — the fast model’s, drawn lighter and said so (connections learning)', () => {
  const learned = (base: BlueprintWorkspaceLink, by: 'code' | 'model'): BlueprintWorkspaceLink => ({ ...base, learned: by })


  it('zoomed in, an edge line is suggested the same way', () => {
    const drawn = offEdgeLines({
      links: [learned(link('calls', ['app', ['feature:app::chats']], ['core', ['feature:core::engine']]), 'model')],
      project: 'app',
      cells: new Map([['feature:app::chats', { x: 10, y: 10, w: 100, h: 60 }]]),
      sheet: { x: 0, y: 0, w: 600, h: 400 },
      projectName: String,
    })
    expect(drawn.map((line) => line.suggested)).toEqual([true])
  })

  it('the foot says who suggested it', () => {
    const sentences = connectionSentences({
      links: [learned(link('calls', ['app', ['feature:app::chats']], ['core', ['feature:core::engine']], 'streams over SSE'), 'model')],
      project: 'app',
      id: 'feature:app::chats',
      featureName: (_p, id) => ({ 'feature:app::chats': 'Chats', 'feature:core::engine': 'Chat Engine' })[id],
      projectName: (slug) => `orbit-${slug}`,
    })
    expect(sentences).toEqual(['Chats calls Chat Engine in orbit-core (streams over SSE) · suggested by Flow'])
  })
})

describe('every connection, feature to feature (2026-10-06: "connected to where?")', () => {
  const cells = new Map<string, PlacedCell>([
    [keyOf('app', 'feature:app::tenant'), { project: 'app', id: 'feature:app::tenant', rect: { x: 430, y: 40, w: 120, h: 80 } }],
    [keyOf('core', 'feature:core::core'), { project: 'core', id: 'feature:core::core', rect: { x: 10, y: 40, w: 200, h: 120 } }],
  ])
  const countries = new Map<string, Rect>([
    ['core', { x: 0, y: 0, w: 400, h: 300 }],
    ['app', { x: 420, y: 0, w: 300, h: 300 }],
    ['argo', { x: 0, y: 320, w: 400, h: 200 }],
  ])
  const names: Record<string, string> = { 'feature:app::tenant': 'Tenant', 'feature:core::core': 'Core' }
  const lines = (links: BlueprintWorkspaceLink[]) =>
    allLinkLines({ links, cells, countries, keyOf, featureName: (_p, id) => names[id], projectName: (slug) => `orbit-${slug}` })

  it('draws each connection between the cells it joins, and names it', () => {
    const [line] = lines([link('calls', ['app', ['feature:app::tenant']], ['core', ['feature:core::core']], 'tenant activation')])
    expect(line).toMatchObject({
      fromCell: 'app|feature:app::tenant',
      toCell: 'core|feature:core::core',
      sentence: 'Tenant in orbit-app calls Core in orbit-core (tenant activation)',
      suggested: false,
    })
    expect(onBorder(line?.from ?? { x: 0, y: 0 }, cells.get('app|feature:app::tenant')?.rect as Rect)).toBe(true)
  })

  it('an end no feature claims lands on its project; one off the sheet draws nothing', () => {
    const [toProject] = lines([link('relates', ['app', ['feature:app::tenant']], ['argo', [], 'file:apps/x.yaml'])])
    expect(toProject).toMatchObject({ toCell: null, sentence: 'Tenant in orbit-app relates to apps/x.yaml in orbit-argo' })
    expect(lines([link('calls', ['app', ['feature:app::tenant']], ['elsewhere', ['feature:elsewhere::x']])])).toEqual([])
  })

  it('draws every line only while there are few, and lights the cells they join', () => {
    const one = link('calls', ['app', ['feature:app::tenant']], ['core', ['feature:core::core']])
    expect(drawsEveryLink([])).toBe(false)
    expect(drawsEveryLink([one])).toBe(true)
    expect(drawsEveryLink(Array(ALL_LINES_LIMIT + 1).fill(one))).toBe(false)
    expect([...linkedCellKeys([one], keyOf)].sort()).toEqual(['app|feature:app::tenant', 'core|feature:core::core'])
  })
})
