// Code-map rollup + territory layout model — pure logic, no DOM (node env).
// Covers rollup correctness on a synthetic multi-depth spine, wire weight
// merging, module/ghost caps + overflow, ghost mapping, mustReview badge
// rollup, drill-down (focusPath) views, fail-soft, and treemap geometry.

import type {
  BlueprintEdge,
  BlueprintEffectiveProposal,
  BlueprintGraph,
  BlueprintMustReviewItem,
  BlueprintNode,
} from '../../shared/ipc-contract'
import {
  CLI_SURFACE_ID,
  MAX_GHOST_NODES,
  MAX_MODULE_NODES,
  crumbHighlightsForAnchors,
  focusAncestry,
  isSunsetMustReviewItem,
  layoutRollupAsTerritory,
  moduleNodeIdForPath,
  pruneFocusPath,
  rollupGraph,
  selectInitialFocus,
  buildDisplayResolver,
  endpointGroupRoutes,
  ENDPOINT_OVERFLOW_ID,
  MAX_NESTED_CHILDREN,
  TERRITORY_BOTTOM_BAND_H,
  TERRITORY_LABEL_ROW_H,
  TERRITORY_LEFT_BAND_W,
  TERRITORY_MARGIN,
  TERRITORY_TOP_INSET,
  type FlowNode,
  type RolledGraph,
} from './flow-model'

// ── Fixture builders ─────────────────────────────────────────────────────
function moduleNode(dir: string, depth: number, extras: Record<string, unknown> = {}): BlueprintNode {
  const lastSlash = dir.lastIndexOf('/')
  return {
    id: `module:${dir}`,
    kind: 'module',
    label: lastSlash === -1 ? dir : dir.slice(lastSlash + 1),
    sourceFile: dir,
    meta: { depth, ...extras },
  }
}

function contains(parentDir: string, childDir: string): BlueprintEdge {
  return { source: `module:${parentDir}`, target: `module:${childDir}`, relation: 'contains' }
}

function edge(source: string, target: string, relation: string): BlueprintEdge {
  return { source, target, relation }
}

function graphWith(nodes: BlueprintNode[], edges: BlueprintEdge[], extra: Partial<BlueprintGraph> = {}): BlueprintGraph {
  return {
    version: 1,
    derivedAt: '2026-07-15T00:00:00Z',
    coverage: { filesScanned: 1, filesTotal: 1, extractorsRun: ['modules'], graphifyEnriched: false },
    nodes,
    edges,
    ...extra,
  }
}

const sqlite: BlueprintNode = { id: 'datastore:sqlite', kind: 'datastore', label: 'SQLite', sourceFile: 'db.ts' }
const stripe: BlueprintNode = { id: 'integration:stripe', kind: 'integration', label: 'stripe', sourceFile: 'pay.ts' }
const cliDerive: BlueprintNode = {
  id: 'endpoint:cli derive',
  kind: 'endpoint',
  label: 'cli derive',
  sourceFile: 'cli.ts',
  meta: { detectedVia: 'commander', route: 'derive' },
}
const cliInit: BlueprintNode = {
  id: 'endpoint:cli init',
  kind: 'endpoint',
  label: 'cli init',
  sourceFile: 'cli.ts',
  meta: { detectedVia: 'commander', route: 'init' },
}

/**
 * Multi-depth spine:
 *   src (d1) ── main (d2) ── store (d3)
 *            └─ renderer (d2) ── blueprint (d3)
 * Displayed (default) = the two depth-1 modules? No — src is the only depth-1
 * here; use two depth-1 roots for a meaningful rollup.
 */
function multiDepthGraph(): BlueprintGraph {
  const nodes: BlueprintNode[] = [
    moduleNode('app/src/main', 1, { degree: 8 }),
    moduleNode('app/src/renderer', 1, { degree: 5 }),
    moduleNode('app/src/main/store', 2, { degree: 3 }),
    moduleNode('app/src/main/agents', 2, { degree: 2 }),
    moduleNode('app/src/renderer/blueprint', 2, { degree: 4 }),
    moduleNode('app/src/main/store/sqlite', 3, { degree: 1 }),
    sqlite,
    stripe,
    cliDerive,
    cliInit,
  ]
  const edges: BlueprintEdge[] = [
    contains('app/src/main', 'app/src/main/store'),
    contains('app/src/main', 'app/src/main/agents'),
    contains('app/src/renderer', 'app/src/renderer/blueprint'),
    contains('app/src/main/store', 'app/src/main/store/sqlite'),
    // cross-module: deep module → deep module (rolls to main → renderer)
    edge('module:app/src/main/store', 'module:app/src/renderer/blueprint', 'imports'),
    // duplicate direction (should merge weight → 2, one wire)
    edge('module:app/src/main/agents', 'module:app/src/renderer/blueprint', 'imports'),
    edge('module:app/src/main/agents', 'module:app/src/renderer/blueprint', 'calls'),
    // periphery wires
    edge('module:app/src/main/store/sqlite', 'datastore:sqlite', 'uses'),
    edge('module:app/src/renderer/blueprint', 'integration:stripe', 'uses'),
    edge('module:app/src/main', 'endpoint:cli derive', 'exposes'),
    edge('module:app/src/main', 'endpoint:cli init', 'exposes'),
    // self-pair after rollup (both under main) — dropped
    edge('module:app/src/main/store', 'module:app/src/main/agents', 'imports'),
    // exposes between modules never renders
    edge('module:app/src/main', 'module:app/src/renderer', 'exposes'),
  ]
  return graphWith(nodes, edges)
}

function findNode(rolled: RolledGraph, id: string): FlowNode | undefined {
  return rolled.nodes.find((n) => n.id === id)
}

// ── rollupGraph: fail-soft ────────────────────────────────────────────────
describe('rollupGraph fail-soft', () => {
  it('returns empty for null graph', () => {
    const r = rollupGraph(null, [])
    expect(r.nodes).toEqual([])
    expect(r.wires).toEqual([])
    expect(r.overflow.modules).toEqual({ droppedCount: 0, keptCount: 0 })
  })

  it('returns empty for undefined graph and empty-node graph', () => {
    expect(rollupGraph(undefined).nodes).toEqual([])
    expect(rollupGraph(graphWith([], [])).nodes).toEqual([])
  })
})

// ── rollupGraph: displayed set + rollup correctness ───────────────────────
describe('rollupGraph rollup correctness', () => {
  const rolled = rollupGraph(multiDepthGraph(), [])

  it('displays only the two depth-1 modules', () => {
    const modules = rolled.nodes.filter((n) => n.kind === 'module' && !n.ghost)
    expect(modules.map((m) => m.id).sort()).toEqual(['module:app/src/main', 'module:app/src/renderer'])
  })

  it('sets childCount from direct spine children', () => {
    expect(findNode(rolled, 'module:app/src/main')?.childCount).toBe(2)
    expect(findNode(rolled, 'module:app/src/renderer')?.childCount).toBe(1)
  })

  it('prefers meta.degree for weight', () => {
    expect(findNode(rolled, 'module:app/src/main')?.weight).toBe(8)
    expect(findNode(rolled, 'module:app/src/renderer')?.weight).toBe(5)
  })

  it('rolls deep cross-module edges up to displayed ancestors', () => {
    const wire = rolled.wires.find(
      (w) => w.from === 'module:app/src/main' && w.to === 'module:app/src/renderer',
    )
    expect(wire).toBeDefined()
  })

  it('drops self-pairs (both endpoints roll into the same ancestor)', () => {
    // The store→agents imports edge collapses (both under main): no self wire.
    expect(rolled.wires.some((w) => w.from === w.to)).toBe(false)
  })

  it('never renders exposes/contains as module↔module wires', () => {
    const moduleWire = rolled.wires.find(
      (w) => w.from === 'module:app/src/main' && w.to === 'module:app/src/renderer',
    )
    expect(moduleWire?.relations).not.toContain('exposes')
    expect(moduleWire?.relations).not.toContain('contains')
  })
})

// ── rollupGraph: wire weight merging ──────────────────────────────────────
describe('rollupGraph wire weight merging', () => {
  it('merges duplicate directed edges into one weighted wire', () => {
    const rolled = rollupGraph(multiDepthGraph(), [])
    const wire = rolled.wires.find(
      (w) => w.from === 'module:app/src/main' && w.to === 'module:app/src/renderer',
    )
    // store→blueprint (imports) + agents→blueprint (imports, calls) → weight 3
    expect(wire?.weight).toBe(3)
    expect(wire?.relations).toEqual(['calls', 'imports'])
  })
})

// ── rollupGraph: periphery ────────────────────────────────────────────────
describe('rollupGraph periphery', () => {
  const rolled = rollupGraph(multiDepthGraph(), [])

  it('always displays integrations and datastores', () => {
    expect(findNode(rolled, 'integration:stripe')).toBeDefined()
    expect(findNode(rolled, 'datastore:sqlite')).toBeDefined()
  })

  it('rolls all CLI endpoints into one cli-surface pseudo-node', () => {
    const cli = findNode(rolled, CLI_SURFACE_ID)
    expect(cli).toBeDefined()
    expect(cli?.kind).toBe('endpoint')
    expect(cli?.sublabel).toBe('2 commands')
    // No individual cli endpoint nodes remain.
    expect(findNode(rolled, 'endpoint:cli derive')).toBeUndefined()
  })

  it('wires periphery to the displayed module that uses/exposes it', () => {
    expect(rolled.wires.some((w) => w.from === 'module:app/src/main' && w.to === 'datastore:sqlite')).toBe(true)
    expect(
      rolled.wires.some((w) => w.from === 'module:app/src/renderer' && w.to === 'integration:stripe'),
    ).toBe(true)
    expect(rolled.wires.some((w) => w.from === 'module:app/src/main' && w.to === CLI_SURFACE_ID)).toBe(true)
  })

  it('displays a datastore even when no module uses it (unwired)', () => {
    const lonely: BlueprintNode = { id: 'datastore:redis', kind: 'datastore', label: 'Redis', sourceFile: 'r.ts' }
    const rolled2 = rollupGraph(graphWith([moduleNode('src', 1), lonely], []), [])
    expect(findNode(rolled2, 'datastore:redis')).toBeDefined()
  })
})

// ── rollupGraph: caps + overflow ──────────────────────────────────────────
describe('rollupGraph module cap', () => {
  it('keeps the highest-degree modules and records overflow', () => {
    const nodes: BlueprintNode[] = []
    for (let i = 0; i < 25; i++) {
      nodes.push(moduleNode(`src/mod${String(i).padStart(2, '0')}`, 1, { degree: i }))
    }
    const rolled = rollupGraph(graphWith(nodes, []), [])
    const modules = rolled.nodes.filter((n) => n.kind === 'module')
    expect(modules.length).toBe(MAX_MODULE_NODES)
    expect(rolled.overflow.modules.droppedCount).toBe(25 - MAX_MODULE_NODES)
    expect(rolled.overflow.modules.keptCount).toBe(MAX_MODULE_NODES)
    // Highest degree kept, lowest dropped.
    expect(modules.some((m) => m.id === 'src/mod24' || m.id === 'module:src/mod24')).toBe(true)
    expect(modules.some((m) => m.id === 'module:src/mod00')).toBe(false)
  })

  it('reports zero overflow below the cap', () => {
    const rolled = rollupGraph(multiDepthGraph(), [])
    expect(rolled.overflow.modules.droppedCount).toBe(0)
  })
})

// ── rollupGraph: ghosts ───────────────────────────────────────────────────
function proposal(overrides: Partial<BlueprintEffectiveProposal>): BlueprintEffectiveProposal {
  return {
    fingerprint: `${overrides.plan ?? 'p'}+${overrides.predictedNodeId ?? 'module:x'}`,
    plan: 'p',
    predictedNodeId: 'module:x',
    kind: 'module',
    label: 'x',
    anchors: [],
    state: 'proposed',
    provenance: 'test',
    proposedAt: '2026-07-15T00:00:00Z',
    ...overrides,
  }
}

describe('rollupGraph ghosts', () => {
  it('renders proposed|accepted|rejected as dashed ghosts, kind from id prefix', () => {
    const proposals = [
      proposal({ predictedNodeId: 'datastore:cache', kind: 'datastore', label: 'Cache', state: 'accepted', plan: 'a' }),
      proposal({ predictedNodeId: 'module:new-mod', label: 'new-mod', state: 'proposed', plan: 'a' }),
    ]
    const rolled = rollupGraph(multiDepthGraph(), proposals)
    const ghost = findNode(rolled, 'datastore:cache')
    expect(ghost?.ghost).toBe(true)
    expect(ghost?.kind).toBe('datastore')
    expect(ghost?.ghostState).toBe('accepted')
    expect(ghost?.sublabel).toBe('a')
  })

  it('excludes confirmed/stale/cleared proposals', () => {
    const proposals = [
      proposal({ predictedNodeId: 'module:conf', state: 'confirmed' }),
      proposal({ predictedNodeId: 'module:stale', state: 'stale' }),
    ]
    const rolled = rollupGraph(multiDepthGraph(), proposals)
    expect(rolled.nodes.some((n) => n.ghost)).toBe(false)
  })

  it('emits no wires for ghost nodes', () => {
    const proposals = [proposal({ predictedNodeId: 'module:new', label: 'new' })]
    const rolled = rollupGraph(multiDepthGraph(), proposals)
    expect(rolled.wires.some((w) => w.from === 'module:new' || w.to === 'module:new')).toBe(false)
  })

  it('caps ghosts and records dropped plans', () => {
    const proposals: BlueprintEffectiveProposal[] = []
    for (let i = 0; i < 9; i++) {
      proposals.push(
        proposal({ predictedNodeId: `module:g${i}`, label: `g${i}`, plan: `plan-${String(i).padStart(2, '0')}` }),
      )
    }
    const rolled = rollupGraph(multiDepthGraph(), proposals)
    expect(rolled.nodes.filter((n) => n.ghost).length).toBe(MAX_GHOST_NODES)
    expect(rolled.overflow.ghosts.droppedCount).toBe(9 - MAX_GHOST_NODES)
    expect(rolled.overflow.ghosts.plans.length).toBe(9 - MAX_GHOST_NODES)
  })
})

// ── rollupGraph: mustReview badge rollup ──────────────────────────────────
describe('rollupGraph mustReview rollup', () => {
  it('badges the displayed ancestor with loudest severity + total count', () => {
    const mustReview: BlueprintMustReviewItem[] = [
      { rank: 1, severity: 'high', title: 'high issue', detail: '', nodeId: 'module:app/src/main/store', source: 's' },
      { rank: 2, severity: 'crit', title: 'crit issue', detail: '', nodeId: 'module:app/src/main/agents', source: 's' },
      { rank: 3, severity: 'info', title: 'info', detail: '', nodeId: 'module:app/src/renderer/blueprint', source: 's' },
    ]
    const rolled = rollupGraph(multiDepthGraph(), [], undefined)
    // Re-run with mustReview attached.
    const g = multiDepthGraph()
    g.mustReview = mustReview
    const rolled2 = rollupGraph(g, [])
    const main = findNode(rolled2, 'module:app/src/main')
    // main gets both high + crit (2 items); loudest is crit.
    expect(main?.mustReview?.count).toBe(2)
    expect(main?.mustReview?.severity).toBe('crit')
    expect(main?.mustReview?.title).toBe('crit issue')
    const renderer = findNode(rolled2, 'module:app/src/renderer')
    expect(renderer?.mustReview?.severity).toBe('info')
    // Sanity: base run without mustReview has no badge.
    expect(findNode(rolled, 'module:app/src/main')?.mustReview).toBeUndefined()
  })

  it('ignores items without nodeId or resolving outside the displayed set', () => {
    const g = multiDepthGraph()
    g.mustReview = [
      { rank: 1, severity: 'crit', title: 'x', detail: '', source: 's' },
      { rank: 2, severity: 'crit', title: 'y', detail: '', nodeId: 'module:does/not/exist', source: 's' },
    ]
    const rolled = rollupGraph(g, [])
    expect(rolled.nodes.every((n) => n.mustReview === undefined)).toBe(true)
  })

  it('skips sunset god-node rows persisted in a stale graph.json (no re-derive needed)', () => {
    const g = multiDepthGraph()
    g.mustReview = [
      { rank: 1, severity: 'high', title: 'God node touched: store (4360 edges)', detail: '', nodeId: 'module:app/src/main/store', source: 'graphify' },
      { rank: 2, severity: 'crit', title: 'real issue', detail: '', nodeId: 'module:app/src/main/agents', source: 's' },
    ]
    const rolled = rollupGraph(g, [])
    const main = findNode(rolled, 'module:app/src/main')
    // Only the real (non-god-node) item badges; the god-node row is filtered out.
    expect(main?.mustReview?.count).toBe(1)
    expect(main?.mustReview?.severity).toBe('crit')
    expect(main?.mustReview?.title).toBe('real issue')
  })
})

describe('isSunsetMustReviewItem', () => {
  it('matches the CLI god-node title and nothing else', () => {
    expect(isSunsetMustReviewItem({ title: 'God node touched: core (4360 edges)' })).toBe(true)
    expect(isSunsetMustReviewItem({ title: 'New external integration: Stripe' })).toBe(false)
    expect(isSunsetMustReviewItem({ title: 'Run risk assessed high' })).toBe(false)
  })
})

// ── rollupGraph: drill-down (focusPath) ───────────────────────────────────
describe('rollupGraph focusPath drill-down', () => {
  it('shows the direct child modules of the focused path', () => {
    const rolled = rollupGraph(multiDepthGraph(), [], 'app/src/main')
    const modules = rolled.nodes.filter((n) => n.kind === 'module' && !n.ghost).map((m) => m.id)
    expect(modules.sort()).toEqual(['module:app/src/main/agents', 'module:app/src/main/store'])
  })

  it('accepts the module: id form for the focus', () => {
    const rolled = rollupGraph(multiDepthGraph(), [], 'module:app/src/main')
    const modules = rolled.nodes.filter((n) => n.kind === 'module' && !n.ghost).map((m) => m.id)
    expect(modules.sort()).toEqual(['module:app/src/main/agents', 'module:app/src/main/store'])
  })

  it('rolls deeper descendants up to the direct child in focus view', () => {
    const rolled = rollupGraph(multiDepthGraph(), [], 'app/src/main')
    // sqlite (under store/sqlite) uses datastore:sqlite → wires to store child.
    expect(
      rolled.wires.some((w) => w.from === 'module:app/src/main/store' && w.to === 'datastore:sqlite'),
    ).toBe(true)
  })

  it('is fail-soft for an unknown focus path (no child modules)', () => {
    const rolled = rollupGraph(multiDepthGraph(), [], 'app/nope')
    expect(rolled.nodes.filter((n) => n.kind === 'module').length).toBe(0)
    // Periphery still present.
    expect(findNode(rolled, 'datastore:sqlite')).toBeDefined()
  })
})

// ── focusAncestry: breadcrumb rail chain ───────────────────────────────────
describe('focusAncestry', () => {
  it('returns [] for a null focus', () => {
    expect(focusAncestry(multiDepthGraph(), null)).toEqual([])
    expect(focusAncestry(multiDepthGraph(), undefined)).toEqual([])
  })

  it('walks the contains spine outermost → focused (inclusive)', () => {
    const chain = focusAncestry(multiDepthGraph(), 'module:app/src/main/store/sqlite')
    expect(chain.map((c) => c.id)).toEqual([
      'module:app/src/main',
      'module:app/src/main/store',
      'module:app/src/main/store/sqlite',
    ])
    // labels are the node basenames
    expect(chain.map((c) => c.label)).toEqual(['main', 'store', 'sqlite'])
  })

  it('accepts a bare (un-prefixed) focus path', () => {
    const chain = focusAncestry(multiDepthGraph(), 'app/src/main/store')
    expect(chain.map((c) => c.id)).toEqual(['module:app/src/main', 'module:app/src/main/store'])
  })

  it('is single-crumb for a depth-1 spine root', () => {
    const chain = focusAncestry(multiDepthGraph(), 'module:app/src/main')
    expect(chain.map((c) => c.id)).toEqual(['module:app/src/main'])
  })

  it('returns [] when the focused id is absent or not a module', () => {
    expect(focusAncestry(multiDepthGraph(), 'module:does/not/exist')).toEqual([])
    expect(focusAncestry(multiDepthGraph(), 'datastore:sqlite')).toEqual([])
  })

  it('is fail-soft for a null graph', () => {
    expect(focusAncestry(null, 'module:app/src/main')).toEqual([])
  })
})

// ── pruneFocusPath: live-reload collapse ───────────────────────────────────
describe('pruneFocusPath', () => {
  it('keeps a focus that still exists (normalized id)', () => {
    expect(pruneFocusPath(multiDepthGraph(), 'app/src/main/store')).toBe('module:app/src/main/store')
    expect(pruneFocusPath(multiDepthGraph(), 'module:app/src/main/store')).toBe('module:app/src/main/store')
  })

  it('pops to the deepest surviving ancestor when the focus is gone', () => {
    // graph lacks app/src/main/store/deep/leaf — pops to the deepest present prefix
    expect(pruneFocusPath(multiDepthGraph(), 'module:app/src/main/store/deep/leaf')).toBe(
      'module:app/src/main/store',
    )
  })

  it('returns null when neither the focus nor any ancestor survives', () => {
    expect(pruneFocusPath(multiDepthGraph(), 'module:unrelated/tree/leaf')).toBeNull()
  })

  it('returns null for a null focus or null graph', () => {
    expect(pruneFocusPath(multiDepthGraph(), null)).toBeNull()
    expect(pruneFocusPath(null, 'module:app/src/main')).toBeNull()
  })
})

describe('selectInitialFocus (#537 — auto-descend degenerate top level)', () => {
  it('descends into the single dominant root when the top level is one card', () => {
    const graph = graphWith(
      [
        moduleNode('src', 1),
        moduleNode('src/api', 2),
        moduleNode('src/db', 2),
        moduleNode('src/ui', 2),
      ],
      [contains('src', 'src/api'), contains('src', 'src/db'), contains('src', 'src/ui')],
    )
    expect(selectInitialFocus(graph)).toBe('module:src')
  })

  it('keeps the depth-1 view for a multi-root repo (>2 top-level modules)', () => {
    const graph = graphWith(
      [moduleNode('src', 1), moduleNode('lib', 1), moduleNode('cli', 1)],
      [],
    )
    expect(selectInitialFocus(graph)).toBeNull()
  })

  it('with two roots, descends into the one that actually has children', () => {
    const graph = graphWith(
      [moduleNode('src', 1), moduleNode('scripts', 1), moduleNode('src/api', 2)],
      [contains('src', 'src/api')],
    )
    expect(selectInitialFocus(graph)).toBe('module:src')
  })

  it('returns null when the single root has no children to descend into', () => {
    const graph = graphWith([moduleNode('src', 1)], [])
    expect(selectInitialFocus(graph)).toBeNull()
  })
})

describe('moduleNodeIdForPath (#UX — Reveal in Blueprint)', () => {
  const graph = graphWith(
    [moduleNode('src', 1), moduleNode('src/api', 2), moduleNode('src/api/routes', 3), moduleNode('lib', 1)],
    [],
  )

  it('maps a file to its DEEPEST owning module', () => {
    expect(moduleNodeIdForPath(graph, 'src/api/routes/users.ts')).toBe('module:src/api/routes')
    expect(moduleNodeIdForPath(graph, 'src/api/client.ts')).toBe('module:src/api')
    expect(moduleNodeIdForPath(graph, 'src/main.ts')).toBe('module:src')
  })

  it('maps a directory path to its own module node', () => {
    expect(moduleNodeIdForPath(graph, 'src/api')).toBe('module:src/api')
    expect(moduleNodeIdForPath(graph, 'src/api/')).toBe('module:src/api') // trailing slash tolerated
  })

  it('picks the right root among siblings', () => {
    expect(moduleNodeIdForPath(graph, 'lib/util.ts')).toBe('module:lib')
  })

  it('returns null for a path under no module, and for a null graph', () => {
    expect(moduleNodeIdForPath(graph, 'docs/readme.md')).toBeNull()
    expect(moduleNodeIdForPath(null, 'src/api/x.ts')).toBeNull()
  })

  it('falls back to a root ("") module when one owns everything', () => {
    const rootGraph = graphWith([moduleNode('', 1), moduleNode('src', 1)], [])
    expect(moduleNodeIdForPath(rootGraph, 'docs/readme.md')).toBe('module:')
    expect(moduleNodeIdForPath(rootGraph, 'src/x.ts')).toBe('module:src') // deeper wins
  })
})

describe('crumbHighlightsForAnchors (#612)', () => {
  // A resolver that returns null for the (non-carded) focus root but a card for
  // a displayed descendant — mirroring buildDisplayResolver on an auto-descend.
  const resolve = (id: string): string | null =>
    id === 'module:src/inner' ? 'module:src/inner' : null

  it('lights a crumb for an anchor that resolves to no card but IS a focus ancestor', () => {
    const ancestry = new Set(['module:src'])
    const lit = crumbHighlightsForAnchors(['module:src'], resolve, ancestry)
    expect([...lit]).toEqual(['module:src'])
  })

  it('does NOT light a crumb for an anchor that resolves to a displayed card', () => {
    const ancestry = new Set(['module:src'])
    const lit = crumbHighlightsForAnchors(['module:src/inner'], resolve, ancestry)
    expect(lit.size).toBe(0)
  })

  it('does NOT light a crumb for an unresolved anchor that is not in the ancestry', () => {
    const ancestry = new Set(['module:src'])
    // module:other resolves to null but is off-board (not an ancestor crumb).
    const lit = crumbHighlightsForAnchors(['module:other'], resolve, ancestry)
    expect(lit.size).toBe(0)
  })

  it('handles a mix — cards resolve, ancestor crumbs light, off-board drops', () => {
    const ancestry = new Set(['module:src'])
    const lit = crumbHighlightsForAnchors(
      ['module:src/inner', 'module:src', 'module:other'],
      resolve,
      ancestry,
    )
    expect([...lit]).toEqual(['module:src'])
  })
})

// ── Endpoint path-group rollup (#901) ────────────────────────────────────
describe('rollupGraph endpoint path groups', () => {
  const endpoint = (id: string, label: string, meta: Record<string, unknown>, sourceFile = 'x.ts'): BlueprintNode =>
    ({ id, kind: 'endpoint', label, sourceFile, meta }) as BlueprintNode

  function groupedGraph(): BlueprintGraph {
    return {
      version: 1,
      derivedAt: 't',
      coverage: { filesScanned: 0, filesTotal: 0, extractorsRun: [], graphifyEnriched: false },
      nodes: [
        moduleNode('api', 1),
        endpoint('endpoint:GET /api/coworkers', 'GET /api/coworkers', { pathGroup: '/api/coworkers' }, 'app/api/coworkers/route.ts'),
        endpoint('endpoint:POST /api/coworkers', 'POST /api/coworkers', { pathGroup: '/api/coworkers' }),
        endpoint('endpoint:query getChats', 'query getChats', { pathGroup: 'graphql', operation: 'query' }),
        endpoint('endpoint:mutation createChat', 'mutation createChat', { pathGroup: 'graphql', operation: 'mutation' }),
        endpoint('endpoint:POST /legacy', 'POST /legacy', {}), // no group — renders as itself
      ],
      edges: [
        { source: 'module:api', target: 'endpoint:GET /api/coworkers', relation: 'exposes' },
        { source: 'module:api', target: 'endpoint:POST /api/coworkers', relation: 'exposes' },
      ],
    } as BlueprintGraph
  }

  it('rolls grouped endpoints into one card per pathGroup with counts', () => {
    const rolled = rollupGraph(groupedGraph(), [])
    const ids = rolled.nodes.map((n) => n.id)
    expect(ids).toContain('endpoint-group:/api/coworkers')
    expect(ids).toContain('endpoint-group:graphql')
    expect(ids).toContain('endpoint:POST /legacy') // ungrouped stays concrete
    expect(ids).not.toContain('endpoint:GET /api/coworkers')
    const group = rolled.nodes.find((n) => n.id === 'endpoint-group:/api/coworkers')
    expect(group).toMatchObject({ label: '/api/coworkers/*', sublabel: '2 routes' })
    const gql = rolled.nodes.find((n) => n.id === 'endpoint-group:graphql')
    expect(gql).toMatchObject({ label: 'graphql', sublabel: '1 query · 1 mutation' })
  })

  it('re-points exposes wires at the group card', () => {
    const rolled = rollupGraph(groupedGraph(), [])
    const wire = rolled.wires.find((w) => w.to === 'endpoint-group:/api/coworkers')
    expect(wire).toMatchObject({ from: 'module:api', weight: 2 })
  })

  it('buildDisplayResolver resolves concrete endpoint ids to their group card', () => {
    const graph = groupedGraph()
    const rolled = rollupGraph(graph, [])
    const resolve = buildDisplayResolver(graph, rolled)
    expect(resolve('endpoint:GET /api/coworkers')).toBe('endpoint-group:/api/coworkers')
    expect(resolve('endpoint:query getChats')).toBe('endpoint-group:graphql')
    expect(resolve('endpoint:POST /legacy')).toBe('endpoint:POST /legacy')
  })

  it('endpointGroupRoutes lists the concrete rolled-up routes sorted', () => {
    const routes = endpointGroupRoutes(groupedGraph(), 'endpoint-group:/api/coworkers')
    expect(routes.map((r) => r.label)).toEqual(['GET /api/coworkers', 'POST /api/coworkers'])
    expect(routes[0].sourceFile).toBe('app/api/coworkers/route.ts')
  })

  it('aggregates into per-top-segment SURFACE cards when groups overflow (#904)', () => {
    // 30 groups under /api plus graphql → 2 cards, not 30.
    const nodes: BlueprintNode[] = [moduleNode('api', 1)]
    for (let i = 0; i < 30; i += 1) {
      nodes.push(endpoint(`endpoint:GET /api/g${i}`, `GET /api/g${i}`, { pathGroup: `/api/g${String(i).padStart(2, '0')}` }))
    }
    nodes.push(endpoint('endpoint:query q1', 'query q1', { pathGroup: 'graphql', operation: 'query' }))
    const graph = { ...groupedGraph(), nodes, edges: [] }
    const rolled = rollupGraph(graph, [])
    const groups = rolled.nodes.filter((n) => n.id.startsWith('endpoint-group:'))
    expect(groups.map((n) => n.id).sort()).toEqual(['endpoint-group:/api', 'endpoint-group:graphql'])
    const surface = groups.find((n) => n.id === 'endpoint-group:/api')
    expect(surface).toMatchObject({ label: '/api/*', sublabel: '30 routes · 30 groups' })
    // Resolver: concrete → surface; routes list serves the whole surface.
    const resolve = buildDisplayResolver(graph, rolled)
    expect(resolve('endpoint:GET /api/g3')).toBe('endpoint-group:/api')
    expect(endpointGroupRoutes(graph, 'endpoint-group:/api')).toHaveLength(30)
  })

  it('renders EVERY displayed wire — density is the signal (#911)', () => {
    // 20 displayed modules, all-pairs wires (190) — over the 160 cap without
    // tripping the module display cap.
    const nodes: BlueprintNode[] = []
    const edges: BlueprintEdge[] = []
    for (let i = 0; i < 20; i += 1) {
      nodes.push(moduleNode(`m${String(i).padStart(2, '0')}`, 1))
    }
    for (let i = 0; i < 5; i += 1) edges.push({ source: 'module:m00', target: 'module:m01', relation: i % 2 ? 'calls' : 'imports' })
    for (let i = 0; i < 20; i += 1) {
      for (let j = i + 1; j < 20; j += 1) {
        edges.push({ source: `module:m${String(i).padStart(2, '0')}`, target: `module:m${String(j).padStart(2, '0')}`, relation: 'imports' })
      }
    }
    // Push past the cap with module→datastore wires (module display cap is 18).
    for (let d = 0; d < 6; d += 1) {
      nodes.push({ id: `datastore:d${d}`, kind: 'datastore', label: `d${d}`, sourceFile: `db${d}.ts`, meta: {} } as BlueprintNode)
      for (let i = 0; i < 20; i += 1) {
        edges.push({ source: `module:m${String(i).padStart(2, '0')}`, target: `datastore:d${d}`, relation: 'uses' })
      }
    }
    const graph = {
      version: 1,
      derivedAt: 't',
      coverage: { filesScanned: 0, filesTotal: 0, extractorsRun: [], graphifyEnriched: false },
      nodes,
      edges,
    } as BlueprintGraph
    const rolled = rollupGraph(graph, [])
    // 18 displayed modules all-pairs (153) + 6 datastores × 18 (108) — all kept.
    expect(rolled.wires.length).toBeGreaterThan(200)
    const heavy = rolled.wires.find((w) => w.from === 'module:m00' && w.to === 'module:m01')
    expect(heavy?.weight).toBeGreaterThan(1) // merged weight carries the volume
  })
})

// ── Dominant-root promotion (#901) ───────────────────────────────────────
describe('selectInitialFocus dominant root', () => {
  function rootedGraph(rootFiles: Array<[string, number, number]>): BlueprintGraph {
    // [dir, fileCount, childCount] per depth-1 root; children get the files.
    const nodes: BlueprintNode[] = []
    const edges: BlueprintEdge[] = []
    for (const [dir, files, children] of rootFiles) {
      nodes.push(moduleNode(dir, 1, { fileCount: 0 }))
      for (let i = 0; i < children; i += 1) {
        const child = `${dir}/c${i}`
        nodes.push(moduleNode(child, 2, { fileCount: Math.floor(files / Math.max(children, 1)) }))
        edges.push({ source: `module:${dir}`, target: `module:${child}`, relation: 'contains' })
      }
      if (children === 0) {
        nodes[nodes.length - 1] = moduleNode(dir, 1, { fileCount: files })
      }
    }
    return {
      version: 1,
      derivedAt: 't',
      coverage: { filesScanned: 0, filesTotal: 0, extractorsRun: [], graphifyEnriched: false },
      nodes,
      edges,
    } as BlueprintGraph
  }

  it('descends into a root owning ≥80% of files even with >2 roots (orbit shape)', () => {
    const graph = rootedGraph([
      ['src', 3400, 17],
      ['prisma', 4, 0],
      ['office-addin', 2, 0],
    ])
    expect(selectInitialFocus(graph)).toBe('module:src')
  })

  it('keeps depth-1 for a balanced multi-root repo', () => {
    const graph = rootedGraph([
      ['src', 500, 5],
      ['app/src', 450, 6],
      ['packages/core', 400, 4],
    ])
    expect(selectInitialFocus(graph)).toBeNull()
  })

  it('never descends into a dominant root without children', () => {
    const graph = rootedGraph([
      ['src', 900, 0],
      ['prisma', 4, 0],
      ['e2e', 3, 0],
    ])
    expect(selectInitialFocus(graph)).toBeNull()
  })
})

// ── Cross-project peer cards (federation) ────────────────────────────────
describe('rollupGraph federation peer cards', () => {
  function fedGraph(): BlueprintGraph {
    return {
      version: 1,
      derivedAt: 't',
      coverage: { filesScanned: 0, filesTotal: 0, extractorsRun: [], graphifyEnriched: false },
      nodes: [moduleNode('src', 1), moduleNode('src/datasources', 2, { fileCount: 3 })],
      edges: [{ source: 'module:src', target: 'module:src/datasources', relation: 'contains' }],
    } as BlueprintGraph
  }
  const federation = {
    crossLinks: [
      { provider: 'orbit-core', endpoint: 'GET /api/v1/x', status: 'confirmed' as const, files: ['src/datasources/EngineAPI.ts'] },
      { provider: 'orbit-core', endpoint: 'query GetTenants', status: 'proposed' as const, files: ['src/datasources/EngineAPI.ts'] },
      { provider: 'other-svc', endpoint: 'GET /y', status: 'proposed' as const, files: ['src/datasources/EngineAPI.ts'] },
      { provider: 'rejected-svc', endpoint: 'GET /z', status: 'rejected' as const, files: [] },
    ],
    siblings: [{ name: 'orbit-core', surfaceDerivedAt: '2026-07-22T12:00:00.000Z', endpointCount: 10 }],
  }

  it('renders one peer card per linked sibling; proposed-only is a ghost; rejected absent', () => {
    const rolled = rollupGraph(fedGraph(), [], undefined, federation, new Date('2026-07-24T12:00:00.000Z'))
    const core = rolled.nodes.find((n) => n.id === 'project:orbit-core')
    expect(core).toMatchObject({ kind: 'project', label: 'orbit-core', sublabel: '2 consumed · surface 2d ago' })
    expect(core?.ghost).toBeUndefined()
    const other = rolled.nodes.find((n) => n.id === 'project:other-svc')
    expect(other?.ghost).toBe(true)
    expect(rolled.nodes.find((n) => n.id === 'project:rejected-svc')).toBeUndefined()
  })

  it('wires the consuming module (rolled to the displayed ancestor) with call-count weight', () => {
    const rolled = rollupGraph(fedGraph(), [], undefined, federation, new Date('2026-07-24T12:00:00.000Z'))
    const wire = rolled.wires.find((w) => w.to === 'project:orbit-core')
    expect(wire).toMatchObject({ from: 'module:src', weight: 2, relations: ['uses'] })
    // Drilled into src: the wire re-points at the concrete consuming module.
    const drilled = rollupGraph(fedGraph(), [], 'module:src', federation, new Date('2026-07-24T12:00:00.000Z'))
    const drilledWire = drilled.wires.find((w) => w.to === 'project:orbit-core')
    expect(drilledWire?.from).toBe('module:src/datasources')
  })

  it('no federation input → identical output (backward compatible)', () => {
    const withOut = rollupGraph(fedGraph(), [])
    expect(withOut.nodes.some((n) => n.kind === 'project')).toBe(false)
  })
})

describe('endpoint band overflow (hard cap)', () => {
  /** A graph whose 30 endpoints all have DISTINCT first segments (the
   *  orbit-core partial-path shape that flooded the band). */
  const floodGraph = () => ({
    version: 1,
    derivedAt: 'd',
    coverage: { filesScanned: 1, filesTotal: 1, extractorsRun: ['modules'], graphifyEnriched: false },
    nodes: [
      { id: 'module:src', kind: 'module', label: 'src', sourceFile: 'src', meta: { depth: 1 } },
      ...Array.from({ length: 30 }, (_, i) => ({
        id: `endpoint:GET /seg${i}/x`,
        kind: 'endpoint',
        label: `GET /seg${String(i).padStart(2, '0')}/x`,
        sourceFile: `src/r${i}.py`,
        meta: { method: 'GET', route: `/seg${String(i).padStart(2, '0')}/x`, pathGroup: `/seg${String(i).padStart(2, '0')}` },
      })),
    ],
    edges: [],
  }) as never

  it('renders at most the cap: top surfaces + ONE "(other)" card carrying the rest', () => {
    const rolled = rollupGraph(floodGraph(), [])
    const endpointCards = rolled.nodes.filter((n) => n.kind === 'endpoint')
    expect(endpointCards.length).toBeLessThanOrEqual(12)
    const overflow = endpointCards.find((n) => n.id === ENDPOINT_OVERFLOW_ID)
    expect(overflow).toBeDefined()
    expect(overflow?.label).toMatch(/\+\d+ more surfaces/)
    expect(overflow?.sublabel).toContain('route')
  })

  it('the overflow card resolves its folded routes for the Routes popover — nothing silently dropped', () => {
    const rolled = rollupGraph(floodGraph(), [])
    const renderedIds = new Set(rolled.nodes.filter((n) => n.kind === 'endpoint').map((n) => n.id))
    const overflowRoutes = endpointGroupRoutes(floodGraph(), ENDPOINT_OVERFLOW_ID)
    // every route is reachable: on a rendered surface card OR in the overflow
    const renderedRouteCount = [...renderedIds]
      .filter((id) => id !== ENDPOINT_OVERFLOW_ID)
      .reduce((sum, id) => sum + endpointGroupRoutes(floodGraph(), id).length, 0)
    expect(renderedRouteCount + overflowRoutes.length).toBe(30)
    expect(overflowRoutes.length).toBeGreaterThan(0)
  })

  it('(partial) groups render one umbrella card with an honest label', () => {
    const graph = {
      version: 1,
      derivedAt: 'd',
      coverage: { filesScanned: 1, filesTotal: 1, extractorsRun: ['modules'], graphifyEnriched: false },
      nodes: [
        { id: 'module:src', kind: 'module', label: 'src', sourceFile: 'src', meta: { depth: 1 } },
        { id: 'endpoint:GET /activate', kind: 'endpoint', label: 'GET /activate', sourceFile: 'a.py', meta: { pathGroup: '(partial)' } },
        { id: 'endpoint:GET /kinds', kind: 'endpoint', label: 'GET /kinds', sourceFile: 'b.py', meta: { pathGroup: '(partial)' } },
      ],
      edges: [],
    } as never
    const rolled = rollupGraph(graph, [])
    const card = rolled.nodes.find((n) => n.id === 'endpoint-group:(partial)')
    expect(card?.label).toBe('partial paths')
    expect(card?.sublabel).toContain('2 routes')
  })
})
// ── layoutRollupAsTerritory: the code map as territory (Phase 7) ───────────
//
// THE MAP'S CLAIM IS THAT AREA IS A COUNT. The retired grid gave every module
// the same 150 × 82 card, so a 210-file root and a 14-file one drew identically —
// these tests pin the four things that make the new answer readable: nesting
// stays inside its parent, the bands stay fixed strips, a ghost never takes
// ground from a real module, and a nested parent's wire leaves over its own
// name rather than through its districts.

const STAGE = { w: 1200, h: 700 }

/** A territory-shaped rollup: two roots (one with children), a band each, a ghost. */
function territoryRollup(): RolledGraph {
  return {
    nodes: [
      {
        id: 'module:app/src/main',
        kind: 'module',
        label: 'main',
        fileCount: 210,
        childCount: 3,
        children: [
          { id: 'module:app/src/main/agent', label: 'agent', fileCount: 48, childCount: 2 },
          { id: 'module:app/src/main/ipc', label: 'ipc', fileCount: 40, childCount: 0 },
          { id: 'module:app/src/main/blueprint', label: 'blueprint', fileCount: 30, childCount: 0 },
        ],
      },
      { id: 'module:scripts', kind: 'module', label: 'scripts', fileCount: 14, childCount: 0 },
      { id: 'integration:github', kind: 'integration', label: 'GitHub' },
      { id: 'datastore:sqlite', kind: 'datastore', label: 'SQLite' },
      { id: CLI_SURFACE_ID, kind: 'endpoint', label: 'CLI surface', sublabel: '41 commands' },
      { id: 'module:app/src/journal', kind: 'module', label: 'journal', ghost: true, ghostState: 'proposed' },
    ],
    wires: [{ from: 'module:app/src/main', to: 'module:scripts', weight: 3, relations: ['imports'] }],
    overflow: { modules: { droppedCount: 0, keptCount: 2 }, ghosts: { droppedCount: 0, plans: [] } },
  }
}

interface Box {
  x: number
  y: number
  w: number
  h: number
}

function at(
  layout: { positions: { id: string; x: number; y: number; w: number; h: number }[] },
  id: string,
): Box {
  const found = layout.positions.find((p) => p.id === id)
  if (found === undefined) throw new Error(`no position for ${id}`)
  return found
}

function encloses(outer: Box, inner: Box): boolean {
  return (
    inner.x >= outer.x - 0.001 &&
    inner.y >= outer.y - 0.001 &&
    inner.x + inner.w <= outer.x + outer.w + 0.001 &&
    inner.y + inner.h <= outer.y + outer.h + 0.001
  )
}

describe('layoutRollupAsTerritory', () => {
  it('sizes module cells by file count — area is the measure, not a constant card', () => {
    const layout = layoutRollupAsTerritory(territoryRollup(), STAGE)
    const main = at(layout, 'module:app/src/main')
    const scripts = at(layout, 'module:scripts')
    // 210 files against 14 — the ring's answer and the grid's was "the same".
    expect(main.w * main.h).toBeGreaterThan(scripts.w * scripts.h * 5)
  })

  it('nests children inside their parent rect, below its label row', () => {
    const layout = layoutRollupAsTerritory(territoryRollup(), STAGE)
    const parent = at(layout, 'module:app/src/main')
    expect(layout.children.map((child) => child.id).sort()).toEqual([
      'module:app/src/main/agent',
      'module:app/src/main/blueprint',
      'module:app/src/main/ipc',
    ])
    for (const child of layout.children) {
      expect(child.parentId).toBe('module:app/src/main')
      expect(encloses(parent, child)).toBe(true)
      // The label row is RESERVED: a district never covers its parent's name.
      expect(child.y).toBeGreaterThanOrEqual(parent.y + TERRITORY_LABEL_ROW_H - 0.001)
      // …and it is placed like any other cell, so the board can draw it.
      expect(at(layout, child.id)).toBeDefined()
    }
  })

  it('never nests into a cell too small to hold a district', () => {
    // A sliver of a cell beside a giant sibling: the parent still draws, its
    // districts do not — nesting into a rect narrower than a name is how a
    // treemap turns into a hatch pattern.
    const rolled = territoryRollup()
    rolled.nodes[1].fileCount = 20_000
    const layout = layoutRollupAsTerritory(rolled, { w: 320, h: 240 })
    expect(layout.children).toEqual([])
    // …and the parent is still drawn: a cell with no room for districts is not
    // a cell with no room for itself.
    expect(at(layout, 'module:app/src/main')).toBeDefined()
  })

  it('lays out at most MAX_NESTED_CHILDREN districts', () => {
    const rolled = territoryRollup()
    rolled.nodes[0].children = Array.from({ length: MAX_NESTED_CHILDREN }, (_, i) => ({
      id: `module:child${String(i)}`,
      label: `child${String(i)}`,
      fileCount: 10,
      childCount: 0,
    }))
    expect(layoutRollupAsTerritory(rolled, STAGE).children).toHaveLength(MAX_NESTED_CHILDREN)
  })

  it('puts integrations and peers in the fixed left band, and the ground beside it', () => {
    const layout = layoutRollupAsTerritory(territoryRollup(), STAGE)
    expect(layout.leftBand.w).toBe(TERRITORY_LEFT_BAND_W - TERRITORY_MARGIN)
    expect(layout.leftBand.y).toBe(TERRITORY_TOP_INSET)
    expect(encloses(layout.leftBand, at(layout, 'integration:github'))).toBe(true)
    // The module ground starts to the RIGHT of the band — never over it.
    expect(layout.main.x).toBeGreaterThanOrEqual(layout.leftBand.x + layout.leftBand.w)
    expect(encloses(layout.main, at(layout, 'module:app/src/main'))).toBe(true)
  })

  it('puts datastores, the rolled CLI surface AND the ghosts in the fixed bottom band', () => {
    const layout = layoutRollupAsTerritory(territoryRollup(), STAGE)
    expect(layout.bottomBand.h).toBeLessThan(TERRITORY_BOTTOM_BAND_H)
    expect(layout.bottomBand.h).toBeGreaterThan(0)
    for (const id of ['datastore:sqlite', CLI_SURFACE_ID, 'module:app/src/journal']) {
      expect(encloses(layout.bottomBand, at(layout, id))).toBe(true)
    }
    // A PREDICTION TAKES NO GROUND FROM A REAL MODULE — the ghost predicts a
    // `module:` id and still lands in the band, never in the treemap.
    expect(encloses(layout.main, at(layout, 'module:app/src/journal'))).toBe(false)
  })

  it('gives an empty band no room at all', () => {
    const rolled = territoryRollup()
    rolled.nodes = rolled.nodes.filter((node) => node.kind === 'module' && node.ghost !== true)
    const layout = layoutRollupAsTerritory(rolled, STAGE)
    expect(layout.leftBand.w).toBe(0)
    expect(layout.bottomBand.h).toBe(0)
    expect(layout.main.x).toBe(TERRITORY_MARGIN)
  })

  it('anchors a wire at cell centres — and on the LABEL ROW of a nested parent', () => {
    const layout = layoutRollupAsTerritory(territoryRollup(), STAGE)
    const wire = layout.wireEndpoints[0]
    const parent = at(layout, 'module:app/src/main')
    const scripts = at(layout, 'module:scripts')
    expect(wire).toMatchObject({ from: 'module:app/src/main', to: 'module:scripts' })
    expect(wire.x1).toBeCloseTo(parent.x + parent.w / 2)
    // Over its own name, not through its districts.
    expect(wire.y1).toBeCloseTo(parent.y + TERRITORY_LABEL_ROW_H / 2)
    expect(wire.y1).toBeLessThan(parent.y + parent.h / 2)
    // A leaf keeps the plain centre.
    expect(wire.x2).toBeCloseTo(scripts.x + scripts.w / 2)
    expect(wire.y2).toBeCloseTo(scripts.y + scripts.h / 2)
  })

  it('drops a wire whose endpoint is not on the map', () => {
    const rolled = territoryRollup()
    rolled.wires = [{ from: 'module:app/src/main', to: 'module:gone', weight: 1, relations: ['imports'] }]
    expect(layoutRollupAsTerritory(rolled, STAGE).wireEndpoints).toEqual([])
  })

  it('is deterministic — same rollup and stage, identical rectangles', () => {
    expect(layoutRollupAsTerritory(territoryRollup(), STAGE)).toEqual(
      layoutRollupAsTerritory(territoryRollup(), STAGE),
    )
  })

  it('places every node, and lays an empty rollup out without throwing', () => {
    const layout = layoutRollupAsTerritory(territoryRollup(), STAGE)
    expect(layout.positions.map((p) => p.id).sort()).toEqual(
      [...territoryRollup().nodes.map((n) => n.id), ...layout.children.map((c) => c.id)].sort(),
    )
    const empty = layoutRollupAsTerritory(
      {
        nodes: [],
        wires: [],
        overflow: { modules: { droppedCount: 0, keptCount: 0 }, ghosts: { droppedCount: 0, plans: [] } },
      },
      STAGE,
    )
    expect(empty.positions).toEqual([])
    expect(empty.children).toEqual([])
  })
})

// ── rollupGraph: the territory measure it now emits ────────────────────────
describe('rollupGraph territory fields', () => {
  it('reports a module’s SUBTREE file count, so a parent is never smaller than its children', () => {
    const graph = graphWith(
      [
        moduleNode('src', 1, { fileCount: 4 }),
        moduleNode('src/a', 2, { fileCount: 10 }),
        moduleNode('src/a/deep', 3, { fileCount: 6, rolledUpFiles: 2 }),
      ],
      [contains('src', 'src/a'), contains('src/a', 'src/a/deep')],
    )
    expect(findNode(rollupGraph(graph), 'module:src')?.fileCount).toBe(22)
  })

  it('carries the direct child modules, biggest first, capped — childCount stays honest', () => {
    const nodes: BlueprintNode[] = [moduleNode('src', 1, { fileCount: 1 })]
    const edges: BlueprintEdge[] = []
    for (let i = 0; i < MAX_NESTED_CHILDREN + 3; i += 1) {
      nodes.push(moduleNode(`src/c${String(i)}`, 2, { fileCount: i }))
      edges.push(contains('src', `src/c${String(i)}`))
    }
    const root = findNode(rollupGraph(graphWith(nodes, edges)), 'module:src')
    expect(root?.children).toHaveLength(MAX_NESTED_CHILDREN)
    expect(root?.children?.[0].label).toBe(`c${String(MAX_NESTED_CHILDREN + 2)}`)
    // A district carries its OWN direct-child count, which is what makes it
    // drillable in turn — never its parent's.
    expect(root?.children?.[0].childCount).toBe(0)
    expect(root?.childCount).toBe(MAX_NESTED_CHILDREN + 3)
  })

  it('leaves `children` absent for a module that has none', () => {
    const rolled = rollupGraph(graphWith([moduleNode('src', 1, { fileCount: 2 })], []))
    expect(findNode(rolled, 'module:src')?.children).toBeUndefined()
  })
})
