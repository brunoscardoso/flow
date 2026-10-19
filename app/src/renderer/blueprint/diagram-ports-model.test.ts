import type { FeaturePort, FeaturePorts } from '../../shared/ipc-contract'
import {
  COUNT_W,
  PORT_GAP,
  PORT_HEAD_H,
  PORT_LANE_W,
  PORT_W,
  PORTS_FULL_MIN_SCALE,
  SUGGESTED_NOTE,
  hasPorts,
  layoutPorts,
  portCaption,
  portHeight,
  portPress,
  portsModeFor,
  stackColumn,
} from './diagram-ports-model'

const NODES = [
  { id: 'client', x: 0, y: 40, w: 200, h: 70 },
  { id: 'engine', x: 380, y: 200, w: 200, h: 70 },
]

function port(over: Partial<FeaturePort> & { direction: FeaturePort['direction'] }): FeaturePort {
  return {
    crosses: 'typed engine calls',
    far: { project: 'core', projectName: 'orbit-core', feature: 'engine', featureId: 'feature:engine', featureName: 'Connectors engine', local: false },
    internalNode: null,
    trust: 'code',
    source: 'connection',
    ...over,
  }
}

function ports(over: Partial<FeaturePorts> = {}): FeaturePorts {
  return {
    action: 'features-ports',
    feature: 'feature:client',
    slug: 'client',
    name: 'Client',
    part: null,
    project: 'app',
    workspace: null,
    in: [],
    out: [],
    linked: [],
    more: { in: 0, out: 0, linked: 0 },
    unreadableLinks: 0,
    ...over,
  }
}

const overlap = (a: { y: number; h: number }, b: { y: number; h: number }): boolean => a.y < b.y + b.h && b.y < a.y + a.h

describe('layoutPorts — nothing when none (FR-10)', () => {
  it('adds no column, offset or chip without ports', () => {
    for (const mode of ['full', 'counts'] as const) {
      const out = layoutPorts({ nodes: NODES, width: 600, height: 300, ports: ports(), mode })
      expect(out).toMatchObject({ any: false, flowX: 0, width: 600, height: 300, ports: [], counts: [], heads: [] })
    }
    expect(layoutPorts({ nodes: NODES, width: 600, height: 300, ports: null, mode: 'full' }).any).toBe(false)
    expect(hasPorts(null)).toBe(false)
  })
})

describe('layoutPorts — full', () => {
  const data = ports({
    in: [port({ direction: 'in', internalNode: 'client' }), port({ direction: 'in', internalNode: 'client', crosses: 'SSE' })],
    out: [port({ direction: 'out', internalNode: 'engine' })],
  })
  const out = layoutPorts({ nodes: NODES, width: 600, height: 300, ports: data, mode: 'full' })

  it('puts entries left of the flow and exits right of it, the flow shifted whole', () => {
    expect(out.flowX).toBe(PORT_W + PORT_LANE_W)
    const ins = out.ports.filter((p) => p.side === 'in')
    const outs = out.ports.filter((p) => p.side === 'out')
    for (const p of ins) expect(p.rect.x + p.rect.w).toBeLessThanOrEqual(out.flowX)
    for (const p of outs) expect(p.rect.x).toBeGreaterThanOrEqual(out.flowX + 600)
    expect(out.width).toBe(out.flowX + 600 + PORT_W + PORT_LANE_W)
    expect(out.heads.map((h) => h.text)).toEqual(['Comes in', 'Goes out'])
  })

  it('stands a port beside the component it touches, never overlapping a neighbour', () => {
    const [a, b] = out.ports.filter((p) => p.side === 'in')
    expect(a && b && overlap(a.rect, b.rect)).toBe(false)
    const exit = out.ports.find((p) => p.side === 'out')
    // engine's centre is 235: the port's centre sits on it.
    expect(exit && exit.rect.y + exit.rect.h / 2).toBeCloseTo(235)
  })

  it('wires a port into its component, in canvas coordinates', () => {
    const exit = out.ports.find((p) => p.side === 'out')
    expect(exit?.wired).toBe(true)
    // Leaves the engine's right edge (380 + 200, shifted by flowX).
    expect(exit?.wire).toMatch(new RegExp(`^M ${(out.flowX + 580).toFixed(1)} 235\\.0`))
    const entry = out.ports.find((p) => p.side === 'in')
    expect(entry?.wire?.endsWith(`${out.flowX.toFixed(1)} 75.0`)).toBe(true)
  })

  it('draws an unmatched port to the diagram edge, never a guessed component', () => {
    const lone = layoutPorts({
      nodes: NODES,
      width: 600,
      height: 300,
      ports: ports({ in: [port({ direction: 'in', internalNode: 'ghost' })] }),
      mode: 'full',
    })
    const [p] = lone.ports
    expect(p?.wired).toBe(false)
    const cy = (p?.rect.y ?? 0) + (p?.rect.h ?? 0) / 2
    expect(p?.wire?.endsWith(`${lone.flowX.toFixed(1)} ${cy.toFixed(1)}`)).toBe(true)
    // Spread around the edge's centre.
    expect(Math.abs(cy - 150)).toBeLessThan(40)
  })

  it('marks model trust suggested, and counts what the CLI capped', () => {
    const capped = layoutPorts({
      nodes: NODES,
      width: 600,
      height: 300,
      ports: ports({ out: [port({ direction: 'out', trust: 'model' })], more: { in: 0, out: 4, linked: 0 } }),
      mode: 'full',
    })
    expect(capped.ports[0]?.suggested).toBe(true)
    expect(capped.ports[0]?.trustClass).toBe('fb-port-trust-model')
    expect(capped.mores).toEqual([expect.objectContaining({ side: 'out', text: '+4 more' })])
    expect(capped.flowX).toBe(0)
    expect(SUGGESTED_NOTE).toBe('suggested by Flow')
  })

  it('puts linked ports in a row under everything', () => {
    const linked = layoutPorts({
      nodes: NODES,
      width: 600,
      height: 300,
      ports: ports({ linked: [port({ direction: 'linked', internalNode: 'engine' }), port({ direction: 'linked' })] }),
      mode: 'full',
    })
    const row = linked.ports.filter((p) => p.side === 'linked')
    expect(row).toHaveLength(2)
    for (const p of row) expect(p.rect.y).toBeGreaterThan(300)
    expect(row[0]?.rect.y).toBe(row[1]?.rect.y)
    expect(row[1]?.wire).toBeNull()
    expect(linked.heads.map((h) => h.text)).toEqual(['Linked'])
    expect(linked.height).toBeGreaterThan(300 + PORT_HEAD_H)
  })
})

describe('layoutPorts — counts (FR-9)', () => {
  it('collapses each side to a chip, with the capped rest counted', () => {
    const out = layoutPorts({
      nodes: NODES,
      width: 600,
      height: 300,
      ports: ports({
        in: [port({ direction: 'in' }), port({ direction: 'in' }), port({ direction: 'in' })],
        out: [port({ direction: 'out' })],
        more: { in: 0, out: 2, linked: 0 },
      }),
      mode: 'counts',
    })
    expect(out.ports).toEqual([])
    expect(out.counts.map((c) => [c.text, c.more])).toEqual([
      ['3 in', null],
      ['3 out', '+2 more'],
    ])
    expect(out.flowX).toBeGreaterThanOrEqual(COUNT_W)
  })

  it('switches to counts below the readable scale', () => {
    expect(portsModeFor(PORTS_FULL_MIN_SCALE)).toBe('full')
    expect(portsModeFor(PORTS_FULL_MIN_SCALE - 0.01)).toBe('counts')
  })
})

describe('portCaption (FR-3)', () => {
  it('names project › feature, then file · function', () => {
    expect(
      portCaption({ project: 'app', projectName: 'orbit-app', featureName: 'Connectors admin UI', file: 'admin/page.tsx', symbol: 'AdminSectionPage', local: false }),
    ).toEqual({ place: 'orbit-app › Connectors admin UI', detail: 'admin/page.tsx · AdminSectionPage' })
  })
  it('omits the project when the far end is local, and never invents a grain', () => {
    expect(portCaption({ feature: 'chats', featureName: 'Chats', local: true })).toEqual({ place: 'Chats', detail: null })
    expect(portCaption({ anchor: 'endpoint:POST /api/x', local: true })).toEqual({ place: null, detail: 'POST /api/x' })
    expect(portCaption({ partName: 'SSE stream', featureName: 'Chats', local: true }).detail).toBe('SSE stream')
  })
})

describe('portPress (FR-8)', () => {
  it('opens a local file at its function, else a local part', () => {
    expect(portPress({ file: 'a.ts', symbol: 'run', part: 'feature:x/p', local: true })).toEqual({ kind: 'file', file: 'a.ts', symbol: 'run' })
    expect(portPress({ part: 'feature:x/p', partName: 'P', local: true })).toEqual({ kind: 'part', part: 'feature:x/p', partName: 'P' })
  })
  it('goes to another project\'s feature, never its files', () => {
    expect(portPress({ project: 'core', featureId: 'feature:e', featureName: 'E', file: 'x.ts', local: false })).toEqual({
      kind: 'feature',
      project: 'core',
      featureId: 'feature:e',
      featureName: 'E',
    })
    expect(portPress({ project: 'core', local: false })).toEqual({ kind: 'none' })
  })
})

describe('stackColumn', () => {
  it('keeps order by wanted centre, a gap apart, never above the top', () => {
    const tops = stackColumn([{ want: 100, h: 40 }, { want: 90, h: 40 }, { want: 0, h: 40 }], 20, PORT_GAP)
    expect(tops[2]).toBe(20)
    expect(tops[1]).toBeGreaterThanOrEqual((tops[2] ?? 0) + 40 + PORT_GAP)
    expect(tops[0]).toBeGreaterThanOrEqual((tops[1] ?? 0) + 40 + PORT_GAP)
  })
  it('sizes a model port taller, for its note', () => {
    expect(portHeight(port({ direction: 'in', trust: 'model' }))).toBeGreaterThan(portHeight(port({ direction: 'in' })))
  })
})
