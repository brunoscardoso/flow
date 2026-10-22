import {
  activationOf,
  buildTerritoryView,
  decorate,
  DEFAULT_STAGE,
  footerNoteFor,
  groupInner,
  hasControlFor,
  inFlightFor,
  levelNodes,
  progressFor,
  standingProgress,
  formatCount,
  groupSummaryFor,
  secondLineFor,
  sheetRect,
  sheetUnitFor,
  territoryCaps,
  CELL_INSET,
  GROUP_LABEL_H,
  GROUP_PAD,
  SHEET_MARGIN,
  TITLE_BLOCK_H,
  TITLE_STRIP_H,
  type ProgressNode,
  type StageSize,
  type TerritoryCell, summaryParts } from './territory-view'
import {
  childrenOf,
  type FocusNode,
  type FocusNodeKind,
} from './focus-stack'
import {
  domainId,
  emptyLevelReason,
  toFocusGraph,
  type FeatureGraphInput,
  type FeatureGraphNodeInput,
} from './feature-view-model'
import { inFlightMarks } from './learn-inflight'
import { folderRowsFit, folderTierFor, LABEL_SHORT_MIN } from './territory-layout'
/* ── fixtures ───────────────────────────────────────────────────────────────*/

function node(partial: Partial<FeatureGraphNodeInput> & { id: string }): FeatureGraphNodeInput {
  return {
    slug: partial.id.replace(/^[a-z]+:/, ''),
    name: partial.name ?? partial.id.replace(/^[a-z]+:/, ''),
    kind: partial.kind ?? 'core',
    understanding: partial.understanding ?? 'none',
    active: partial.active ?? false,
    anchorCount: partial.anchorCount ?? 0,
    ...partial,
  }
}

/** Two domains, four features, three parts, three changes and one orphan. */
const graph: FeatureGraphInput = {
  nodes: [
    node({ id: 'feature:chats', name: 'Chats', domain: 'Agent', anchorCount: 12, understanding: 'learned' }),
    node({ id: 'feature:runs', name: 'Runs', domain: 'Agent', anchorCount: 8, active: true }),
    node({ id: 'feature:board', name: 'Board', domain: 'Surface', anchorCount: 6, understanding: 'stale' }),
    node({ id: 'feature:peek', name: 'Peek', domain: 'Surface', anchorCount: 2 }),
    node({ id: 'part:chats/engine', name: 'Engine', kind: 'part', parent: 'feature:chats', anchorCount: 5 }),
    node({ id: 'part:chats/store', name: 'Store', kind: 'part', parent: 'feature:chats', anchorCount: 3, active: true }),
    node({ id: 'part:chats/sse', name: 'SSE', kind: 'part', parent: 'feature:chats', anchorCount: 1 }),
    node({ id: 'change:chat-migration', name: 'Chat Session Cache Rework', kind: 'child', parent: 'feature:chats' }),
    node({ id: 'change:chat-rewrite', name: 'Chat Rewrite', kind: 'child', parent: 'feature:chats' }),
    node({ id: 'change:board-v2', name: 'Board v2', kind: 'child', parent: 'feature:board' }),
    node({ id: 'change:orphan', name: 'Nobody', kind: 'child' }),
  ],
  edges: [],
}

/** The same store with every `domain:` removed — the flat-root fallback. */
const flatGraph: FeatureGraphInput = {
  nodes: graph.nodes.map(({ domain: _domain, ...rest }) => rest as FeatureGraphNodeInput),
  edges: [],
}

/** The same store with every feature MEASURED — the sheet's `lines` unit. Parts
 *  and changes carry sizes too so a drill-down is measured as well. */
const measuredGraph: FeatureGraphInput = {
  nodes: graph.nodes.map((node) => ({
    ...node,
    size: { files: Math.max(1, node.anchorCount ?? 1), lines: (node.anchorCount ?? 1) * 100 },
  })),
  edges: [],
}

/** Walk `childrenOf` to the node named by `path` — never hand-build a FocusNode,
 *  so the stack a test pushes is exactly the one the board would. */
function focusPath(input: FeatureGraphInput, ...path: string[]): FocusNode[] {
  const focusGraph = toFocusGraph(input)
  const stack: FocusNode[] = []
  for (const id of path) {
    const found = childrenOf(focusGraph, stack.at(-1) ?? null).find((child) => child.id === id)
    if (found === undefined) throw new Error(`fixture: ${id} is not a child at depth ${stack.length}`)
    stack.push(found)
  }
  return stack
}


const byId = (cells: readonly TerritoryCell[], id: string): TerritoryCell => {
  const found = cells.find((cell) => cell.id === id)
  if (found === undefined) throw new Error(`no cell ${id}`)
  return found
}

const TINY: StageSize = { width: 210, height: 120 }

/* ── the sheet ──────────────────────────────────────────────────────────────*/

describe('the sheet (Phase 2.1)', () => {
  it('is the stage less the title strip and the title block', () => {
    expect(sheetRect(DEFAULT_STAGE)).toEqual({
      x: SHEET_MARGIN,
      y: TITLE_STRIP_H,
      w: DEFAULT_STAGE.width - SHEET_MARGIN * 2,
      h: DEFAULT_STAGE.height - TITLE_STRIP_H - TITLE_BLOCK_H,
    })
  })

  it('collapses rather than going negative on a stage smaller than its own chrome', () => {
    const rect = sheetRect({ width: 4, height: 10 })
    expect(rect.w).toBe(0)
    expect(rect.h).toBe(0)
    expect(() => buildTerritoryView(graph, [], { stage: { width: 4, height: 10 } })).not.toThrow()
  })

  it("packs a group's features below its label row, inside its padding", () => {
    const inner = groupInner({ x: 10, y: 20, w: 200, h: 100 })
    expect(inner).toEqual({
      x: 10 + GROUP_PAD,
      y: 20 + GROUP_LABEL_H,
      w: 200 - GROUP_PAD * 2,
      h: 100 - GROUP_LABEL_H - GROUP_PAD,
    })
  })
})

/* ── root: countries, or a flat map ─────────────────────────────────────────*/

describe('the root (Phase 2.1)', () => {
  it('draws a country per domain, with that domain’s features inside it', () => {
    const view = buildTerritoryView(graph)
    expect(view.level).toBe('root')
    expect(view.groups.map((group) => group.label)).toEqual(['Agent', 'Surface'])
    expect(view.groups.map((group) => group.id)).toEqual([domainId('Agent'), domainId('Surface')])
    // The cells are the FEATURES; a domain is ground, never a cell.
    expect(view.cells.map((cell) => cell.id).sort()).toEqual([
      'feature:board',
      'feature:chats',
      'feature:peek',
      'feature:runs',
    ])
    expect(view.cells.every((cell) => cell.kind === 'feature')).toBe(true)
    const agent = view.groups[0]
    expect(agent.cellIds).toEqual(['feature:chats', 'feature:runs'])
    for (const id of agent.cellIds) {
      const rect = byId(view.cells, id).rect
      expect(rect.x).toBeGreaterThanOrEqual(agent.inner.x - 1e-6)
      expect(rect.y).toBeGreaterThanOrEqual(agent.inner.y - 1e-6)
    }
  })

  it('draws a FLAT map — no groups at all — when no feature carries a domain', () => {
    const view = buildTerritoryView(flatGraph)
    expect(view.groups).toEqual([])
    expect(view.cells.map((cell) => cell.name)).toEqual(['Chats', 'Runs', 'Board', 'Peek'])
  })

  it('sizes a country by what stands in it, so Agent (20 anchors) beats Surface (8)', () => {
    const view = buildTerritoryView(graph)
    const area = (rect: { w: number; h: number }): number => rect.w * rect.h
    expect(area(view.groups[0].rect)).toBeGreaterThan(area(view.groups[1].rect))
  })

  it('falls back to the anchor count when nothing was measured: Chats (12) draws bigger than Runs (8)', () => {
    const view = buildTerritoryView(graph)
    const chats = byId(view.cells, 'feature:chats').rect
    const runs = byId(view.cells, 'feature:runs').rect
    expect(chats.w * chats.h).toBeGreaterThan(runs.w * runs.h)
  })

  it('never draws a change, at any depth', () => {
    for (const stack of [[], focusPath(graph, domainId('Agent')), focusPath(graph, domainId('Agent'), 'feature:chats')]) {
      const view = buildTerritoryView(graph, stack)
      expect(view.cells.some((cell) => cell.id.startsWith('change:'))).toBe(false)
      expect(view.cells.some((cell) => cell.kind === 'change')).toBe(false)
    }
  })
})

/* ── depth ──────────────────────────────────────────────────────────────────*/

describe('depth is a zoom of the level above (Phase 2.1)', () => {
  it('a domain level draws its features, ungrouped', () => {
    const view = buildTerritoryView(graph, focusPath(graph, domainId('Agent')))
    expect(view.level).toBe('domain')
    expect(view.groups).toEqual([])
    expect(view.cells.map((cell) => cell.name)).toEqual(['Chats', 'Runs'])
  })

  it('a feature level draws its PARTS, sized by their anchors', () => {
    const view = buildTerritoryView(graph, focusPath(graph, domainId('Agent'), 'feature:chats'))
    expect(view.level).toBe('feature')
    expect(view.cells.map((cell) => cell.name)).toEqual(['Engine', 'Store', 'SSE'])
    expect(view.cells.every((cell) => cell.kind === 'part')).toBe(true)
    const engine = byId(view.cells, 'part:chats/engine').rect
    const sse = byId(view.cells, 'part:chats/sse').rect
    expect(engine.w * engine.h).toBeGreaterThan(sse.w * sse.h)
  })

  it('a cell on the bare sheet takes the full gap', () => {
    const view = buildTerritoryView(flatGraph)
    // The first strip starts at the sheet's own origin, plus the cell inset.
    const left = Math.min(...view.cells.map((cell) => cell.rect.x))
    expect(left).toBeCloseTo(SHEET_MARGIN + CELL_INSET, 6)
  })
})

/* ── the cell's grammar ─────────────────────────────────────────────────────*/

describe('a cell is a dot and a name (Phase 2.1)', () => {
  it('prints the second line only when the cell has room', () => {
    const roomy = buildTerritoryView(graph)
    expect(byId(roomy.cells, 'feature:chats').roomy).toBe(true)
    expect(byId(roomy.cells, 'feature:chats').secondLine).toBe('3 parts · 2 changes')

    const cramped = buildTerritoryView(graph, [], { stage: TINY })
    expect(cramped.cells.every((cell) => cell.roomy)).toBe(false)
    for (const cell of cramped.cells) {
      if (!cell.roomy) expect(cell.secondLine).toBeNull()
    }
  })

  it('at rest a roomy card prints its description; a small one does not; every cell carries it for the details', () => {
    const described = {
      nodes: [
        { id: 'feature:chats', slug: 'chats', name: 'Chats', kind: 'core' as const,
          understanding: 'learned' as const, active: false, anchorCount: 0,
          summary: '  A chat\n  stream.  ' },
        { id: 'feature:auth', slug: 'auth', name: 'Auth', kind: 'core' as const,
          understanding: 'none' as const, active: false, anchorCount: 0 },
      ],
      edges: [],
    }
    const big = buildTerritoryView(described, [], { stage: { width: 900, height: 400 } })
    // AT REST (2026-10-08, "by default we need show the description"): a card
    // with room prints its description; a card with nothing written prints none.
    expect(byId(big.cells, 'feature:chats').summary).toBe('A chat stream.')
    expect(byId(big.cells, 'feature:auth').summary).toBeNull()
    // Collapsed to single spaces: a markdown paragraph's own line breaks would
    // otherwise open ragged gaps mid-sentence.
    expect(byId(big.cells, 'feature:chats').description).toBe('A chat stream.')
    // Nothing written is null, not an empty string.
    expect(byId(big.cells, 'feature:auth').description).toBeNull()

    const small = buildTerritoryView(described, [], { stage: TINY })
    for (const cell of small.cells) expect(cell.summary).toBeNull()
    expect(byId(small.cells, 'feature:chats').description).toBe('A chat stream.')
  })

  it('says active, and says each noun in its own number', () => {
    expect(
      secondLineFor({ kind: 'feature', childCount: 1, changeCount: 1, anchorCount: 9, active: true }),
    ).toBe('1 part · 1 change · active')
    expect(
      secondLineFor({ kind: 'feature', childCount: 3, changeCount: 2, anchorCount: 9, active: false }),
    ).toBe('3 parts · 2 changes')
    expect(
      secondLineFor({ kind: 'part', childCount: 0, changeCount: 0, anchorCount: 1, active: false }),
    ).toBe('1 anchor')
    expect(
      secondLineFor({ kind: 'domain', childCount: 7, changeCount: 0, anchorCount: 0, active: false }),
    ).toBe('7 features')
  })

  it('says NOTHING rather than a row of zeroes', () => {
    expect(
      secondLineFor({ kind: 'feature', childCount: 0, changeCount: 0, anchorCount: 4, active: false }),
    ).toBeNull()
    const view = buildTerritoryView(graph)
    expect(byId(view.cells, 'feature:peek').secondLine).toBeNull()
    expect(byId(view.cells, 'feature:runs').secondLine).toBe('active')
  })

  it('carries the feature’s own understanding, and flags a stale one', () => {
    const view = buildTerritoryView(graph)
    expect(byId(view.cells, 'feature:chats').understanding).toBe('learned')
    expect(byId(view.cells, 'feature:peek').understanding).toBe('none')
    expect(byId(view.cells, 'feature:board').understanding).toBe('stale')
    expect(byId(view.cells, 'feature:board').stale).toBe(true)
    expect(byId(view.cells, 'feature:chats').stale).toBe(false)
  })

  it('degrades the label by the cell’s own size, never by how crowded its siblings are', () => {
    const wide = buildTerritoryView(graph)
    expect(wide.cells.every((cell) => cell.labelClass === '')).toBe(true)
    const cramped = buildTerritoryView(graph, [], { stage: TINY })
    expect(cramped.cells.every((cell) => cell.labelClass === '')).toBe(false)
  })

  it('gives every feature and part a control, and NO domain one', () => {
    const view = buildTerritoryView(graph)
    expect(view.cells.every((cell) => cell.hasControl)).toBe(true)
    expect(byId(view.cells, 'feature:chats').controlTitle).toBe("Open Chats's feature view")
    // Peek claims code; a feature that claims none says so in the sentence.
    const bare = buildTerritoryView({ nodes: [node({ id: 'feature:bare', name: 'Bare' })], edges: [] })
    expect(bare.cells[0].controlTitle).toContain('nothing is claimed yet')

    const kinds: FocusNodeKind[] = ['domain', 'feature', 'part', 'change']
    expect(kinds.map(hasControlFor)).toEqual([false, true, true, false])
  })
})

/* ── ghosts ─────────────────────────────────────────────────────────────────*/

/* ── the sheet's unit ───────────────────────────────────────────────────────*/

describe('a sheet is counted in ONE unit (Phase 1)', () => {
  const areaOf = (cell: { rect: { w: number; h: number } }): number => cell.rect.w * cell.rect.h

  it('resolves to lines only when every laid-out node was measured', () => {
    expect(sheetUnitFor([{ size: { files: 1, lines: 10 } }, { size: { files: 2, lines: 20 } }])).toBe(
      'lines',
    )
    expect(sheetUnitFor([{ size: { files: 1, lines: 10 } }, { size: undefined }])).toBe('anchors')
    expect(sheetUnitFor([{ size: { files: 1, lines: 10 } }, undefined])).toBe('anchors')
  })

  it('reads an empty sheet as lines — nothing can be incomparable with nothing', () => {
    expect(sheetUnitFor([])).toBe('lines')
  })

  it('sizes cells by lines when the graph is measured', () => {
    const view = buildTerritoryView(flatGraph, [])
    const measured = buildTerritoryView(
      { nodes: flatGraph.nodes.map((n) => ({ ...n, size: { files: 1, lines: (n.anchorCount ?? 1) * 100 } })), edges: [] },
      [],
    )
    // Chats (12 anchors) is the largest either way; the RATIO to Peek (2) is
    // what the unit decides, and here both scales agree because the fixture's
    // lines are proportional to its anchors.
    expect(areaOf(byId(view.cells, 'feature:chats'))).toBeGreaterThan(
      areaOf(byId(view.cells, 'feature:peek')),
    )
    expect(areaOf(byId(measured.cells, 'feature:chats'))).toBeGreaterThan(
      areaOf(byId(measured.cells, 'feature:peek')),
    )
  })

  it('is deterministic — same graph, same stage, same unit and same rects', () => {
    const once = buildTerritoryView(graph, [], { project: 'plan-flow' })
    const twice = buildTerritoryView(graph, [], { project: 'plan-flow' })
    expect(twice.cells.map((cell) => [cell.id, cell.rect])).toEqual(
      once.cells.map((cell) => [cell.id, cell.rect]),
    )
    expect(twice.title.block).toBe(once.title.block)
  })
})

describe('proposals are NOT drawn on the feature sheet', () => {
  // "we should not show proposals here, that place are only for main features."
  //
  // Ghosts were root-level cells on the Territory — dashed rectangles labelled
  // "proposal · <plan>", sized by a predicted anchor count, sitting among the
  // capabilities. This sheet answers "what does this project DO", and a
  // prediction is not an answer to it. The proposal layer is unchanged in the
  // store and on the code map, which is where a prediction belongs.
  it('draws only what the feature store holds', () => {
    // A compile-time fact as much as a runtime one: `TerritoryOptions` has no
    // `proposals` key any more, so nothing can feed one in by accident again —
    // and every cell on the sheet is a node of the graph it was given.
    const view = buildTerritoryView(flatGraph, [])
    const known = new Set(flatGraph.nodes.map((node) => node.id))
    for (const cell of view.cells) expect(known.has(cell.id)).toBe(true)
    expect(view.cells.length).toBeGreaterThan(0)
  })
})

/* ── the title strip and the title block ────────────────────────────────────*/

describe('the title strip (Phase 2.1)', () => {
  it('names the project and counts features AND domains at the root', () => {
    const view = buildTerritoryView(graph, [], { project: 'plan-flow' })
    expect(view.title.name).toBe('plan-flow')
    expect(view.title.prefix).toBe('')
    expect(view.title.kicker).toBe('4 features · 2 domains')
    expect(view.title.showBrainField).toBe(true)
    expect(view.title.showControl).toBe(false)
    expect(view.title.showCorpusControl).toBe(false)
  })

  it('drops the domain count when there are no domains', () => {
    expect(buildTerritoryView(flatGraph).title.kicker).toBe('4 features')
  })

  it('counts parts and anchors at a feature, and leads with its domain', () => {
    const view = buildTerritoryView(graph, focusPath(graph, domainId('Agent'), 'feature:chats'))
    expect(view.title.name).toBe('Chats')
    expect(view.title.prefix).toBe('Agent ›')
    expect(view.title.kicker).toBe('3 parts · 12 anchors')
    expect(view.title.showControl).toBe(true)
    expect(view.title.controlTitle).toBe("Open Chats's feature view")
    expect(view.title.showCorpusControl).toBe(true)
    expect(view.title.corpusControlTitle).toBe("Open Chats's changes & discoveries")
    expect(view.title.showBrainField).toBe(false)
  })

  it('gives a DOMAIN neither control — it has no feature view and no changes', () => {
    const view = buildTerritoryView(graph, focusPath(graph, domainId('Agent')))
    expect(view.title.kicker).toBe('2 features')
    expect(view.title.showControl).toBe(false)
    expect(view.title.showCorpusControl).toBe(false)
    expect(view.title.controlTitle).toBe('')
    expect(view.title.corpusControlTitle).toBe('')
  })

  it('reads the title block as one line naming the sheet and its RESOLVED measure', () => {
    // The fixture is unmeasured, so the sheet counts anchors and SAYS so — a
    // block that claimed lines here would be the mismatch this rule removed.
    expect(buildTerritoryView(graph, [], { project: 'plan-flow' }).title.block).toBe(
      'Features · area = anchors (not measured) · plan-flow · features graph',
    )
    expect(buildTerritoryView(measuredGraph, [], { project: 'plan-flow' }).title.block).toBe(
      'Features · area = lines of code · plan-flow · features graph',
    )
    expect(buildTerritoryView(measuredGraph).title.block).toBe(
      'Features · area = lines of code · features graph',
    )
  })
})

/* ── empty levels ───────────────────────────────────────────────────────────*/

describe('an empty level says what is missing (Phase 2.2)', () => {
  it('an empty store is `no-features`, and its words are the shared ones', () => {
    const view = buildTerritoryView({ nodes: [], edges: [] })
    expect(view.cells).toEqual([])
    expect(view.groups).toEqual([])
    expect(view.empty?.kind).toBe('no-features')
    expect(view.emptyReason).toBe(emptyLevelReason(null, 0))
  })

  it('a feature with changes but no parts is `feature`, and retracts the silence claim', () => {
    const store: FeatureGraphInput = {
      nodes: [
        node({ id: 'feature:solo', name: 'Solo' }),
        node({ id: 'change:one', name: 'A plan', kind: 'child', parent: 'feature:solo' }),
      ],
      edges: [],
    }
    const view = buildTerritoryView(store, focusPath(store, 'feature:solo'))
    expect(view.cells).toEqual([])
    expect(view.empty?.kind).toBe('feature')
    expect(view.emptyReason).toContain('No parts recorded inside Solo yet')
    expect(view.emptyReason).toContain('1 change')
  })

  it('a failed read is never reported as an empty store', () => {
    const view = buildTerritoryView({ nodes: [], edges: [] }, [], { fetchFailure: 'CLI timed out' })
    expect(view.empty?.kind).toBe('fetch-failed')
    expect(view.emptyReason).toContain('CLI timed out')
  })

  it('a level with cells has no empty state at all', () => {
    const view = buildTerritoryView(graph)
    expect(view.empty).toBeNull()
    expect(view.emptyReason).toBeNull()
  })
})

/* ── the footer note ────────────────────────────────────────────────────────*/

describe('nothing is hidden silently (Phase 2.2)', () => {
  it('counts the change records whose feature could not be identified — at the root only', () => {
    expect(buildTerritoryView(graph).footerNote).toBe(
      '1 change record whose feature could not be identified',
    )
    expect(buildTerritoryView(graph, focusPath(graph, domainId('Agent'))).footerNote).toBeNull()
  })

  it('counts a change whose parent is a feature the store no longer holds', () => {
    const store: FeatureGraphInput = {
      nodes: [
        node({ id: 'feature:a', name: 'A' }),
        node({ id: 'change:x', name: 'X', kind: 'child', parent: 'feature:gone' }),
        node({ id: 'change:y', name: 'Y', kind: 'child' }),
      ],
      edges: [],
    }
    expect(footerNoteFor(store, 0)).toBe('2 change records whose feature could not be identified')
  })

  it('says nothing when every change is placed', () => {
    const store: FeatureGraphInput = {
      nodes: [
        node({ id: 'feature:a', name: 'A' }),
        node({ id: 'change:x', name: 'X', kind: 'child', parent: 'feature:a' }),
      ],
      edges: [],
    }
    expect(footerNoteFor(store, 0)).toBeNull()
  })

  it('reports the NAMES the sheet could not print, and nothing when it printed them all', () => {
    expect(territoryCaps(buildTerritoryView(graph))).toEqual([])
    const cramped = buildTerritoryView(graph, [], { stage: TINY })
    const [cap] = territoryCaps(cramped)
    expect(cap).toBeDefined()
    expect(cap.noun).toEqual({ one: 'name', many: 'names' })
    expect(cap.of).toBe(cramped.cells.length)
    expect(cap.hidden).toBe(
      cramped.cells.filter((cell) => cell.labelClass === 'dot' || cell.labelClass === 'blank').length,
    )
    expect(cap.cap).toBe(LABEL_SHORT_MIN.w)
  })
})

/* ── determinism ────────────────────────────────────────────────────────────*/

describe('determinism (NFR-1)', () => {
  it('renders identically for identical inputs', () => {
    const once = buildTerritoryView(graph, [], { project: 'plan-flow' })
    const twice = buildTerritoryView(graph, [], { project: 'plan-flow' })
    expect(JSON.stringify(once)).toBe(JSON.stringify(twice))
  })

  it('keeps the store’s own order, so a cell moves only when the store does', () => {
    const view = buildTerritoryView(flatGraph)
    expect(view.cells.map((cell) => cell.id)).toEqual([
      'feature:chats',
      'feature:runs',
      'feature:board',
      'feature:peek',
    ])
  })
})

/* ── decorate ───────────────────────────────────────────────────────────────*/

describe('decorate — one lit/dim rule for every overlay (Phase 2.3)', () => {
  const base = buildTerritoryView(graph, [], {
  })

  it('lights what it was given and dims nothing else by default', () => {
    const view = decorate(base, { lit: ['feature:chats'] })
    expect(byId(view.cells, 'feature:chats').lit).toBe(true)
    expect(view.cells.every((cell) => !cell.dim)).toBe(true)
  })

  it('lit beats dim — a cell is never both', () => {
    const view = decorate(base, { lit: ['feature:chats'], dimOthers: true })
    const chats = byId(view.cells, 'feature:chats')
    expect(chats.lit).toBe(true)
    expect(chats.dim).toBe(false)
    expect(byId(view.cells, 'feature:runs').dim).toBe(true)
    expect(view.cells.every((cell) => !(cell.lit && cell.dim))).toBe(true)
  })

  it('dims a country only when nothing inside it is lit', () => {
    const view = decorate(base, { lit: ['feature:chats'], dimOthers: true })
    const agent = view.groups.find((group) => group.label === 'Agent')
    const surface = view.groups.find((group) => group.label === 'Surface')
    expect(agent?.lit).toBe(true)
    expect(agent?.dim).toBe(false)
    expect(surface?.dim).toBe(true)
  })

  it('lights a country named directly, even with no lit cell inside it', () => {
    const view = decorate(base, { lit: [domainId('Surface')], dimOthers: true })
    expect(view.groups.find((group) => group.label === 'Surface')?.dim).toBe(false)
  })

  it('ignores ids this level does not draw, and never mutates its argument', () => {
    const view = decorate(base, { lit: ['part:chats/engine'], dimOthers: true })
    expect(view.cells.every((cell) => !cell.lit)).toBe(true)
    expect(base.cells.every((cell) => !cell.lit && !cell.dim)).toBe(true)
    expect(base.groups.every((group) => !group.lit && !group.dim)).toBe(true)
  })

  it('clears an overlay when called with nothing', () => {
    const lit = decorate(base, { lit: ['feature:chats'], dimOthers: true })
    const cleared = decorate(lit)
    expect(cleared.cells.every((cell) => !cell.lit && !cell.dim)).toBe(true)
    expect(cleared.groups.every((group) => !group.lit && !group.dim)).toBe(true)
  })
})

/* ── in-flight marks ────────────────────────────────────────────────────────*/

describe('inFlightFor — a running pass, on the cells that are drawn (Phase 2.3)', () => {
  const marks = inFlightMarks(graph, 'feature:chats')

  it('marks the running feature self and its domain within, at the root', () => {
    const view = buildTerritoryView(graph)
    const landed = inFlightFor(view, marks)
    expect(landed.get('feature:chats')).toBe('self')
    expect(landed.get(domainId('Agent'))).toBe('within')
    // Nothing that is not on this sheet is reported.
    expect(landed.has('part:chats/engine')).toBe(false)
    expect(landed.has('feature:runs')).toBe(false)
  })

  it('marks the running feature’s PARTS self, on the feature level', () => {
    const view = buildTerritoryView(graph, focusPath(graph, domainId('Agent'), 'feature:chats'))
    const landed = inFlightFor(view, marks)
    expect([...landed.values()]).toEqual(['self', 'self', 'self'])
    expect([...landed.keys()]).toEqual([
      'part:chats/engine',
      'part:chats/store',
      'part:chats/sse',
    ])
  })

  it('is empty when nothing is running', () => {
    const view = buildTerritoryView(graph)
    expect(inFlightFor(view, inFlightMarks(graph, null)).size).toBe(0)
  })
})

/* ── the two rules that survived the ring ───────────────────────────────────*/

describe('activation — a level below dives, the last level reads as a story (cell-hover-diagram FR-6)', () => {
  it('dives on a domain and on a feature with parts, reads a part as a story', () => {
    expect(activationOf({ kind: 'domain' }, 0)).toBe('dive')
    expect(activationOf({ kind: 'domain' }, 3)).toBe('dive')
    expect(activationOf({ kind: 'feature' }, 2)).toBe('dive')
    expect(activationOf({ kind: 'part' }, 0)).toBe('story')
  })

  it('reads a feature with no parts as a story', () => {
    const store: FeatureGraphInput = { nodes: [node({ id: 'feature:solo', name: 'Solo' })], edges: [] }
    const view = buildTerritoryView(store)
    expect(view.cells[0].secondLine).toBeNull()
    expect(activationOf(view.cells[0], 0)).toBe('story')
  })
})

/* ── levelNodes (the dive's other half) ─────────────────────────────────────*/

describe('levelNodes', () => {
  it('answers for every DRAWN cell at the grouped root — countries AND their features', () => {
    const view = buildTerritoryView(graph, [])
    const nodes = levelNodes(graph, [])
    for (const cell of view.cells) {
      expect(nodes.has(cell.id)).toBe(true)
    }
    // The countries themselves are in there too — a domain dive is a press on
    // the group label, and it pushes exactly this node.
    for (const group of view.groups) expect(nodes.get(group.id)?.kind).toBe('domain')
  })

  it('answers for every drawn cell on a flat root and one level down', () => {
    for (const stack of [[], [childrenOf(toFocusGraph(graph), null)[0]]] as FocusNode[][]) {
      const view = buildTerritoryView(flatGraph, stack.length === 0 ? [] : [])
      const nodes = levelNodes(flatGraph, [])
      for (const cell of view.cells) expect(nodes.has(cell.id)).toBe(true)
    }
    const chats = childrenOf(toFocusGraph(graph), null)
      .flatMap((domain) => childrenOf(toFocusGraph(graph), domain))
      .find((feature) => feature.id === 'feature:chats')!
    const parts = levelNodes(graph, [chats])
    expect([...parts.keys()].sort()).toEqual([
      'part:chats/engine',
      'part:chats/sse',
      'part:chats/store',
    ])
  })

  it('never answers for a CHANGE — a change is not a cell at any depth', () => {
    const all = new Map([...levelNodes(graph, []), ...levelNodes(flatGraph, [])])
    for (const id of all.keys()) expect(id.startsWith('change:')).toBe(false)
  })
})

/* ── fail-soft ──────────────────────────────────────────────────────────────*/

describe('fail-soft (plan constraint)', () => {
  it('renders a readable, cell-less view for a stack pointing at a node that is gone', () => {
    const ghostStack: FocusNode[] = [
      { kind: 'feature', id: 'feature:vanished', name: 'Vanished', kicker: '', drillable: false, canDrill: true, childCount: 0 },
    ]
    const view = buildTerritoryView(graph, ghostStack)
    expect(view.cells).toEqual([])
    expect(view.empty?.kind).toBe('feature')
    expect(view.crumbs.at(-1)?.name).toBe('Vanished')
  })

  it('never throws on an empty graph, an empty level or a zero stage', () => {
    expect(() => buildTerritoryView({ nodes: [], edges: [] })).not.toThrow()
    expect(() =>
      buildTerritoryView(graph, [], { stage: { width: 0, height: 0 } }),
    ).not.toThrow()
  })
})

/* ── the ONE chooser of a node's progress (Phase 8) ─────────────────────────*/

describe('progressFor', () => {
  const nodes: ProgressNode[] = [
    { id: 'feature:chats', slug: 'chats', kind: 'core', understanding: 'learned' },
    { id: 'part:chats/sse', slug: 'chats/sse', kind: 'part', understanding: 'learned', partOf: 'chats' },
    { id: 'part:chats/store', slug: 'chats/store', kind: 'part', understanding: 'none', partOf: 'chats' },
    { id: 'part:chats/wire', slug: 'chats/wire', kind: 'part', understanding: 'stale', partOf: 'chats' },
    { id: 'feature:quiet', slug: 'quiet', kind: 'core', understanding: 'none' },
  ]

  it("takes the pass's own parts first", () => {
    const answer = progressFor('feature:chats', {
      featureParts: new Map([['feature:chats', { parts: 8, learned: 3 }]]),
      featureRead: new Map([['feature:chats', { read: 12, total: 43 }]]),
      nodes,
    })
    expect(answer).toEqual({ done: 3, total: 8, of: 'parts' })
  })

  it('falls back to files read, which is true from the first second', () => {
    const answer = progressFor('feature:chats', {
      featureRead: new Map([['feature:chats', { read: 12, total: 43 }]]),
      nodes,
    })
    expect(answer).toEqual({ done: 12, total: 43, of: 'files' })
  })

  it('stops being a fraction when the reading ends', () => {
    // Composing the drawing has no ratio of its own; holding at 100% through it
    // is the "stuck at 99%" lie told the other way round. Nothing named parts,
    // so the store's own understanding answers instead — and when there is no
    // store either, the caller marches.
    const withStore = progressFor('feature:chats', {
      featureRead: new Map([['feature:chats', { read: 43, total: 43 }]]),
      nodes,
    })
    expect(withStore).toEqual({ done: 1, total: 3, of: 'parts' })
    expect(
      progressFor('feature:chats', {
        featureRead: new Map([['feature:chats', { read: 43, total: 43 }]]),
      }),
    ).toBeNull()
  })

  it("answers a finished feature from the store's parts, with stale not done", () => {
    // The live maps are empty on a fresh window; without this a feature that
    // was learned yesterday had no figure at all until it was learned again.
    expect(progressFor('feature:chats', { nodes })).toEqual({ done: 1, total: 3, of: 'parts' })
  })

  it('says nothing rather than guessing', () => {
    expect(progressFor(null, { nodes })).toBeNull()
    expect(progressFor('feature:quiet', { nodes })).toBeNull() // no parts at all
    expect(progressFor('feature:unknown', { nodes })).toBeNull()
    expect(progressFor('feature:chats')).toBeNull()
    // A pass that has not named its parts yet is not 0 of 0.
    expect(
      progressFor('feature:quiet', {
        featureParts: new Map([['feature:quiet', { parts: 0, learned: 0 }]]),
      }),
    ).toBeNull()
  })

  /* THE SHAPE THE CLI ACTUALLY WRITES.
   *
   * Every fixture above gives a part a slug of its own ('chats/sse'). The
   * generator does not: `buildPartNodes` stamps `slug: feature.slug` on every
   * part, so a part and its owner share one slug. Testing the documented shape
   * rather than the generated one is how a feature ships green and unusable,
   * and it is exactly what hid the defect below. */
  const realNodes: ProgressNode[] = [
    { id: 'feature:obs', slug: 'obs', kind: 'core', understanding: 'learned' },
    { id: 'part:obs/otel', slug: 'obs', kind: 'part', understanding: 'learned', partOf: 'obs' },
    { id: 'part:obs/langfuse', slug: 'obs', kind: 'part', understanding: 'learned', partOf: 'obs' },
  ]

  it('gives a part no percentage of its own', () => {
    // A part carries its OWNER's slug, so looking that slug up in the parts
    // index hands back the owner's figure — which is how the old ring printed
    // the same 100% under all ten parts of a feature that was 100%. Each of
    // those numbers was about the ring, not the disc it sat under. A part is
    // one artifact: learned or not, and its dot says which.
    expect(progressFor('feature:obs', { nodes: realNodes })).toEqual({
      done: 2,
      total: 2,
      of: 'parts',
    })
    expect(progressFor('part:obs/otel', { nodes: realNodes })).toBeNull()
    expect(progressFor('part:obs/langfuse', { nodes: realNodes })).toBeNull()
  })

  it('answers the same with a prebuilt index as without one', () => {
    // The sheet paints a percentage on every cell now, so it builds the index
    // once per graph instead of walking the nodes once per rectangle. The two
    // readings must not be able to disagree — they are one function.
    const standing = standingProgress(nodes)
    for (const id of ['feature:chats', 'feature:quiet', 'feature:unknown']) {
      expect(progressFor(id, { nodes, standing })).toEqual(progressFor(id, { nodes }))
    }
    // …and the live maps still outrank it.
    expect(
      progressFor('feature:chats', {
        featureParts: new Map([['feature:chats', { parts: 8, learned: 3 }]]),
        nodes,
        standing,
      }),
    ).toEqual({ done: 3, total: 8, of: 'parts' })
  })
})

describe('standingProgress', () => {
  it('is empty for a graph that has not loaded', () => {
    expect(standingProgress(null).size).toBe(0)
    expect(standingProgress(undefined).size).toBe(0)
    expect(standingProgress([]).size).toBe(0)
  })

  it('keys an owner by its node id and counts stale as not done', () => {
    const map = standingProgress([
      { id: 'feature:chats', slug: 'chats', kind: 'core', understanding: 'learned' },
      { id: 'p1', slug: 'chats', kind: 'part', understanding: 'learned', partOf: 'chats' },
      { id: 'p2', slug: 'chats', kind: 'part', understanding: 'stale', partOf: 'chats' },
      { id: 'p3', slug: 'chats', kind: 'part', understanding: 'none', partOf: 'chats' },
    ])
    expect(map.get('feature:chats')).toEqual({ done: 1, total: 3, of: 'parts' })
    // A part is never its own entry, whatever slug it carries.
    expect(map.has('p1')).toBe(false)
  })

  it('leaves a feature with no parts out rather than reporting 0 of 0', () => {
    const map = standingProgress([
      { id: 'feature:quiet', slug: 'quiet', kind: 'core', understanding: 'none' },
    ])
    expect(map.has('feature:quiet')).toBe(false)
  })

  it('carries a change, because the sheet counts one as a node like any other', () => {
    // A change is never DRAWN (that rule is `childrenOf`'s), but it is a node
    // with parts in the graph and this must not be the second place that rule
    // is decided.
    const map = standingProgress([
      { id: 'change:migrate', slug: 'migrate', kind: 'child', understanding: 'none' },
      { id: 'p1', slug: 'migrate', kind: 'part', understanding: 'learned', partOf: 'migrate' },
    ])
    expect(map.get('change:migrate')).toEqual({ done: 1, total: 1, of: 'parts' })
  })
})

/* ── AREA IS SIZE (2026-08-28) ───────────────────────────────────────────────
 *
 * The first cut drew area from `anchorCount` — how many anchor LINES were
 * written in the feature file — and the user could not read size off the
 * sheet: "the size of each box is weird, there is no rule related to size".
 * The CLI now measures what the anchors stand on (`size`: files and lines),
 * and the sheet is packed squarified, largest first.
 */
describe('area is the lines a feature stands on (2026-08-28)', () => {
  const sized: FeatureGraphInput = {
    nodes: [
      // ONE anchor line, a whole directory behind it.
      node({ id: 'feature:engine', name: 'Engine', domain: 'Core', anchorCount: 1, size: { files: 40, lines: 6000 }, understanding: 'learned' }),
      // TWELVE anchor lines, three small files.
      node({ id: 'feature:peek', name: 'Peek', domain: 'Core', anchorCount: 12, size: { files: 3, lines: 200 } }),
      // Nothing resolved — still a cell.
      node({ id: 'feature:ghostly', name: 'Ghostly', domain: 'Core', anchorCount: 0, size: { files: 0, lines: 0 } }),
      node({ id: 'feature:other', name: 'Other', domain: 'Edge', anchorCount: 2, size: { files: 5, lines: 800 } }),
    ],
    edges: [],
  }
  const area = (rect: { w: number; h: number }): number => rect.w * rect.h

  it('draws the 6000-line feature bigger than the 200-line one, whatever their anchor counts', () => {
    const view = buildTerritoryView(sized)
    expect(area(byId(view.cells, 'feature:engine').rect)).toBeGreaterThan(
      area(byId(view.cells, 'feature:peek').rect) * 10,
    )
  })

  it('still draws a feature that stands on no code', () => {
    const view = buildTerritoryView(sized)
    expect(area(byId(view.cells, 'feature:ghostly').rect)).toBeGreaterThan(0)
  })

  it('sizes a country by the lines its features stand on', () => {
    const view = buildTerritoryView(sized)
    const core = view.groups.find((group) => group.label === 'Core')
    const edge = view.groups.find((group) => group.label === 'Edge')
    expect(core).toBeDefined()
    expect(edge).toBeDefined()
    expect(area(core!.rect)).toBeGreaterThan(area(edge!.rect) * 4)
  })

  it('packs the largest first — the biggest cell is the top-left one', () => {
    const view = buildTerritoryView(sized)
    const core = view.groups.find((group) => group.label === 'Core')!
    const cells = core.cellIds.map((id) => byId(view.cells, id))
    const biggest = cells.reduce((best, cell) => (area(cell.rect) > area(best.rect) ? cell : best))
    expect(biggest.id).toBe('feature:engine')
    for (const cell of cells) {
      expect(cell.rect.x).toBeGreaterThanOrEqual(biggest.rect.x - 1e-6)
      expect(cell.rect.y).toBeGreaterThanOrEqual(biggest.rect.y - 1e-6)
    }
  })

  it("says what a country holds on its label row: features, files, understood share", () => {
    const view = buildTerritoryView(sized)
    const core = view.groups.find((group) => group.label === 'Core')!
    expect(core.summary).toBe('3 features · 43 files · 33% understood')
    const edge = view.groups.find((group) => group.label === 'Edge')!
    expect(edge.summary).toBe('1 feature · 5 files · 0% understood')
  })

  it('puts the file count first on a roomy cell\'s second line', () => {
    const view = buildTerritoryView(sized, [], { stage: { width: 1400, height: 800 } })
    expect(byId(view.cells, 'feature:engine').secondLine).toBe('40 files')
  })

  it('counts lines on the root kicker and files on a domain\'s', () => {
    expect(buildTerritoryView(sized).title.kicker).toBe('4 features · 2 domains · 7k lines')
    expect(buildTerritoryView(sized, focusPath(sized, domainId('Core'))).title.kicker).toBe(
      '3 features · 43 files',
    )
  })

  it('names the measure on the title block', () => {
    expect(buildTerritoryView(sized).title.block).toBe('Features · area = lines of code · features graph')
  })
})

describe('groupSummaryFor / formatCount', () => {
  it('reads every piece from its own kind and drops an empty one', () => {
    expect(groupSummaryFor({ features: 4, files: 120, learned: 2 })).toBe('4 features · 120 files · 50% understood')
    expect(groupSummaryFor({ features: 2, files: 0, learned: 0 })).toBe('2 features · 0% understood')
    expect(groupSummaryFor({ features: 0, files: 0, learned: 0 })).toBe('')
  })
  it('formats a count the way a kicker reads it', () => {
    expect(formatCount(0)).toBe('0')
    expect(formatCount(999)).toBe('999')
    expect(formatCount(1000)).toBe('1k')
    expect(formatCount(6200)).toBe('6.2k')
    expect(formatCount(41_200)).toBe('41k')
    expect(formatCount(1_300_000)).toBe('1.3M')
  })
})

describe('summaryParts — a description is prose; provenance is a path (2026-10-06)', () => {
  it('turns a module provenance line into a path and no description', () => {
    expect(summaryParts('Confirmed from code:module/orbit_core/web.')).toEqual({ about: null, path: 'orbit_core/web' })
  })
  it('drops any other provenance', () => {
    expect(summaryParts('Confirmed from surface:api-route+e2e-suite+ui-route.')).toEqual({ about: null, path: null })
  })
  it('keeps prose as the description, whitespace collapsed', () => {
    expect(summaryParts('  FastAPI routes\n and handlers. ')).toEqual({ about: 'FastAPI routes and handlers.', path: null })
    expect(summaryParts(undefined)).toEqual({ about: null, path: null })
  })
})

describe('a hovered cell grows in place (plan cell-hover-diagram, in-place grow)', () => {
  const STAGE: StageSize = { width: 1030, height: 520 }
  const centre = (r: { x: number; y: number; w: number; h: number }): { x: number; y: number } => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 })
  const holds = (r: { x: number; y: number; w: number; h: number }, p: { x: number; y: number }): boolean =>
    p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h
  const area = (r: { w: number; h: number }): number => r.w * r.h

  it('flat: the same cells in the same order; the focused one takes the share and keeps its centre', () => {
    const plain = buildTerritoryView(measuredGraph, focusPath(measuredGraph, domainId('Agent'), 'feature:chats'), { stage: STAGE })
    for (const target of plain.cells) {
      const grown = buildTerritoryView(measuredGraph, focusPath(measuredGraph, domainId('Agent'), 'feature:chats'), { stage: STAGE, focus: target.id })
      expect(grown.cells.map((cell) => cell.id)).toEqual(plain.cells.map((cell) => cell.id))
      const cell = byId(grown.cells, target.id)
      expect(area(cell.rect) / area(grown.sheet)).toBeGreaterThan(0.5)
      expect(holds(cell.rect, centre(target.rect))).toBe(true)
      // Room for its words now: the grown cell carries its description gate and the roomy line.
      expect(cell.roomy).toBe(true)
    }
  })

  it('the others shrink and their label tier follows their new rectangle', () => {
    const many: FeatureGraphInput = {
      nodes: Array.from({ length: 9 }, (_, i) => node({ id: `feature:f${String(i)}`, name: `F${String(i)}`, anchorCount: 10 - i, size: { files: 1, lines: (10 - i) * 100 } })),
      edges: [],
    }
    const plain = buildTerritoryView(many, [], { stage: STAGE })
    const grown = buildTerritoryView(many, [], { stage: STAGE, focus: 'feature:f4' })
    for (const cell of grown.cells) {
      if (cell.id === 'feature:f4') continue
      expect(area(cell.rect)).toBeLessThan(area(byId(plain.cells, cell.id).rect) + 1e-6)
      // Never to nothing: every shrunk cell still prints at least its short name.
      expect(['', 'tiny']).toContain(cell.labelClass)
    }
  })

  it('grouped root: the focused feature’s domain grows, and the feature inside it, both in place', () => {
    const plain = buildTerritoryView(measuredGraph, [], { stage: STAGE })
    const grown = buildTerritoryView(measuredGraph, [], { stage: STAGE, focus: 'feature:board' })
    const surface = grown.groups.find((group) => group.label === 'Surface')
    const before = plain.groups.find((group) => group.label === 'Surface')
    expect(surface).toBeDefined()
    expect(area(surface!.rect)).toBeGreaterThan(area(before!.rect))
    const board = byId(grown.cells, 'feature:board')
    expect(holds(board.rect, centre(byId(plain.cells, 'feature:board').rect))).toBe(true)
    expect(area(board.rect)).toBeGreaterThan(area(byId(plain.cells, 'feature:board').rect))
    // The cells still stand inside their own countries.
    for (const group of grown.groups) {
      for (const id of group.cellIds) {
        const rect = byId(grown.cells, id).rect
        expect(rect.x).toBeGreaterThanOrEqual(group.inner.x - 1e-6)
        expect(rect.y).toBeGreaterThanOrEqual(group.inner.y - 1e-6)
        expect(rect.x + rect.w).toBeLessThanOrEqual(group.inner.x + group.inner.w + 1e-6)
        expect(rect.y + rect.h).toBeLessThanOrEqual(group.inner.y + group.inner.h + 1e-6)
      }
    }
  })

  it('moving the grow from one cell to another: the new one contains where it was drawn SHRUNK', () => {
    const many: FeatureGraphInput = {
      nodes: Array.from({ length: 7 }, (_, i) => node({ id: `feature:f${String(i)}`, name: `F${String(i)}`, anchorCount: 10 - i, size: { files: 1, lines: (10 - i) * 100 } })),
      edges: [],
    }
    for (const from of ['feature:f0', 'feature:f3', 'feature:f6']) {
      const aroundFrom = buildTerritoryView(many, [], { stage: STAGE, focus: from })
      for (const to of ['feature:f1', 'feature:f5']) {
        if (to === from) continue
        const shrunk = byId(aroundFrom.cells, to).rect
        const moved = buildTerritoryView(many, [], { stage: STAGE, focus: to, previous: from })
        expect(holds(byId(moved.cells, to).rect, centre(shrunk))).toBe(true)
        expect(area(byId(moved.cells, to).rect) / area(moved.sheet)).toBeGreaterThan(0.5)
      }
    }
  })

  it('an unknown focus is the plain level', () => {
    expect(buildTerritoryView(graph, [], { stage: STAGE, focus: 'feature:nope' })).toEqual(buildTerritoryView(graph, [], { stage: STAGE }))
  })

  const inside = (r: { x: number; y: number; w: number; h: number }, outer: { x: number; y: number; w: number; h: number }): boolean =>
    r.x >= outer.x - 1e-6 && r.y >= outer.y - 1e-6 && r.x + r.w <= outer.x + outer.w + 1e-6 && r.y + r.h <= outer.y + outer.h + 1e-6
  const apart = (a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }): boolean =>
    a.x + a.w <= b.x + 1e-6 || b.x + b.w <= a.x + 1e-6 || a.y + a.h <= b.y + 1e-6 || b.y + b.h <= a.y + 1e-6

  it('details (a hover): flat — the cell reaches its details size, smaller than opened, the others around it', () => {
    const many: FeatureGraphInput = {
      nodes: Array.from({ length: 9 }, (_, i) => node({ id: `feature:f${String(i)}`, name: `F${String(i)}`, anchorCount: 10 - i, size: { files: 1, lines: (10 - i) * 100 } })),
      edges: [],
    }
    const plain = buildTerritoryView(many, [], { stage: STAGE })
    for (const target of plain.cells) {
      const details = buildTerritoryView(many, [], { stage: STAGE, focus: target.id, focusMode: 'details' })
      const opened = buildTerritoryView(many, [], { stage: STAGE, focus: target.id })
      const cell = byId(details.cells, target.id)
      expect(cell.rect.w).toBeGreaterThanOrEqual(Math.max(target.rect.w, 320) - 1)
      expect(cell.rect.h).toBeGreaterThanOrEqual(Math.max(target.rect.h, 230) - 1)
      expect(area(cell.rect)).toBeLessThanOrEqual(area(byId(opened.cells, target.id).rect) + 1e-6)
      expect(holds(cell.rect, centre(target.rect))).toBe(true)
      expect(details.cells.map((entry) => entry.id)).toEqual(plain.cells.map((entry) => entry.id))
      for (const other of details.cells) {
        expect(inside(other.rect, details.sheet)).toBe(true)
        if (other.id !== target.id) expect(apart(other.rect, cell.rect)).toBe(true)
      }
    }
  })

  it('details (a hover): grouped — the country grows only as far as its cell needs', () => {
    const plain = buildTerritoryView(measuredGraph, [], { stage: STAGE })
    for (const target of plain.cells) {
      const details = buildTerritoryView(measuredGraph, [], { stage: STAGE, focus: target.id, focusMode: 'details' })
      const opened = buildTerritoryView(measuredGraph, [], { stage: STAGE, focus: target.id })
      const cell = byId(details.cells, target.id)
      expect(cell.rect.w).toBeGreaterThanOrEqual(Math.min(320, details.sheet.w) - 1)
      expect(cell.rect.h).toBeGreaterThanOrEqual(230 - 1)
      expect(area(cell.rect)).toBeLessThanOrEqual(area(byId(opened.cells, target.id).rect) + 1e-6)
      for (const group of details.groups) {
        for (const id of group.cellIds) expect(inside(byId(details.cells, id).rect, group.inner)).toBe(true)
      }
      for (const other of details.cells) if (other.id !== target.id) expect(apart(other.rect, cell.rect)).toBe(true)
    }
  })
})

describe('where it lives — folder rows by tier (plan feature-home-folders)', () => {
  const folders = {
    rows: [
      { path: 'src/components/automations', lines: 900, files: 60, share: 0.72 },
      { path: 'src/app/app/(protected)/automations', lines: 200, files: 8, share: 0.16 },
      { path: 'src/lib/automation', lines: 80, files: 3, share: 0.06 },
    ],
    folderCount: 5,
    spread: false,
    pinned: false,
    pinMissing: null,
    files: 71,
    lines: 1250,
  }
  const one = (stage: StageSize, extra: Partial<FeatureGraphNodeInput> = {}): TerritoryCell => {
    const input: FeatureGraphInput = {
      nodes: [
        node({ id: 'feature:automations', name: 'Automations', anchorCount: 4, size: { files: 60, lines: 1250 }, folders, ...extra }),
      ],
      edges: [],
    }
    return byId(buildTerritoryView(input, [], { stage, project: 'orbit-app' }).cells, 'feature:automations')
  }

  it('tiers by rectangle: rows at 150x92 (three at 112), the line when roomy, nothing below', () => {
    expect(folderTierFor(150, 92)).toBe('rows')
    expect(folderTierFor(149, 200)).toBeNull()
    expect(folderTierFor(150, 91)).toBe('line')
    expect(folderTierFor(150, 64)).toBe('line')
    expect(folderTierFor(150, 63)).toBeNull()
    expect(folderRowsFit(150, 92)).toBe(2)
    expect(folderRowsFit(150, 112)).toBe(3)
    expect(folderRowsFit(150, 91)).toBe(0)
  })

  it('calm at rest: a big cell prints ONE home line, never rows — the rows are the details', () => {
    const cell = one({ width: 1030, height: 520 })
    expect(cell.labelClass).toBe('')
    expect(cell.folders?.tier).toBe('line')
    expect(cell.folders?.shown).toEqual([])
    expect(cell.folders?.more).toBeNull()
    expect(cell.folders?.line.text).toBe('components/automations 72%')
    // The whole slice still rides the cell, for the hover's details.
    expect(cell.folders?.rows.map((row) => row.display)).toEqual([
      'components/automations',
      'app/app/…/automations',
      'lib/automation',
    ])
    expect(cell.folders?.rows[0]?.title).toBe("src/components/automations — 72% of Automations' code, 60 files")
    expect(cell.folders?.moreAll).toBe('2 more folders')
  })

  it('keeps the whole slice on a cell too small to print it — the grown cell reads it', () => {
    const cell = one({ width: 150, height: 90 })
    expect(cell.folders?.tier).toBeNull()
    expect(cell.folders?.rows).toHaveLength(3)
    expect(cell.folders?.line.text).toBe('components/automations 72%')
  })

  it('the home line replaces the provenance path; the path stays only without rows', () => {
    const provenance = 'Confirmed from code:module/web/automations.'
    expect(one({ width: 1030, height: 520 }, { summary: provenance }).path).toBeNull()
    const without = one({ width: 1030, height: 520 }, { summary: provenance, folders: undefined })
    expect(without.folders).toBeNull()
    expect(without.path).toBe('web/automations')
  })

  it('a part carries its own rows; a domain carries none', () => {
    const input: FeatureGraphInput = {
      nodes: [
        node({ id: 'feature:chats', name: 'Chats', domain: 'Agent', anchorCount: 4 }),
        node({ id: 'part:chats/engine', name: 'Engine', kind: 'part', parent: 'feature:chats', anchorCount: 2, folders }),
      ],
      edges: [],
    }
    const root = buildTerritoryView(input, [], { stage: { width: 1030, height: 520 } })
    for (const cell of root.cells.filter((c) => c.kind === 'domain')) expect(cell.folders).toBeNull()
    const parts = buildTerritoryView(input, focusPath(input, domainId('Agent'), 'feature:chats'), { stage: { width: 1030, height: 520 } })
    expect(byId(parts.cells, 'part:chats/engine').folders?.rows[0]?.display).toBe('components/automations')
  })
})

describe("a cell carries its type (plan feature-type-icons, change note 8)", () => {
  const typed: FeatureGraphInput = {
    nodes: [
      node({ id: 'feature:chats', name: 'Chats', anchorCount: 12, role: 'ui', roleSource: 'learn' }),
      node({ id: 'feature:store', name: 'Store', anchorCount: 9, role: 'data', roleSource: 'guess' }),
      node({ id: 'feature:old', name: 'Old', anchorCount: 4 }),
      node({ id: 'part:chats/engine', name: 'Engine', kind: 'part', parent: 'feature:chats', anchorCount: 5, role: 'logic', roleSource: 'person' }),
    ],
    edges: [],
  }

  it('copies the role and its source as the CLI resolved them, never guessing one', () => {
    const view = buildTerritoryView(typed, [], { stage: { width: 1200, height: 700 } })
    expect(byId(view.cells, 'feature:chats')).toMatchObject({ role: 'ui', roleSource: 'learn' })
    expect(byId(view.cells, 'feature:store')).toMatchObject({ role: 'data', roleSource: 'guess' })
    // An older bundle sends no role: nothing to draw, and no guess made here.
    expect(byId(view.cells, 'feature:old')).toMatchObject({ role: null, roleSource: null, showRoleIcon: false })
    const parts = buildTerritoryView(typed, focusPath(typed, 'feature:chats'), { stage: { width: 1200, height: 700 } })
    expect(byId(parts.cells, 'part:chats/engine')).toMatchObject({ role: 'logic', roleSource: 'person' })
  })

  it('shows the icon on the full-name tier only — positive first, then the small tiers', () => {
    const big = buildTerritoryView(typed, [], { stage: { width: 1200, height: 700 } })
    const named = byId(big.cells, 'feature:chats')
    expect(named.labelClass).toBe('')
    expect(named.showRoleIcon).toBe(true)

    const cramped = buildTerritoryView(typed, [], { stage: TINY })
    const small = cramped.cells.filter((cell) => cell.labelClass !== '' && cell.role !== null)
    expect(small.length).toBeGreaterThan(0)
    for (const cell of small) expect(cell.showRoleIcon).toBe(false)
    for (const cell of cramped.cells) {
      expect(cell.showRoleIcon).toBe(cell.role !== null && cell.labelClass === '')
    }
  })

  it('an off-list role reads as none', () => {
    const odd: FeatureGraphInput = {
      nodes: [node({ id: 'feature:x', name: 'X', anchorCount: 3, role: 'wizard' as never, roleSource: 'person' })],
      edges: [],
    }
    expect(byId(buildTerritoryView(odd).cells, 'feature:x')).toMatchObject({ role: null, showRoleIcon: false })
  })

  it('a top band takes its room from the sheet, so a bar above never covers a cell', () => {
    const stage = { width: 1200, height: 700 }
    const plain = sheetRect(stage)
    const banded = sheetRect(stage, 46)
    expect(banded.y).toBe(plain.y + 46)
    expect(banded.h).toBe(plain.h - 46)
    const view = buildTerritoryView(typed, [], { stage, topBand: 46 })
    expect(view.cells.length).toBeGreaterThan(0)
    for (const cell of view.cells) expect(cell.rect.y).toBeGreaterThanOrEqual(plain.y + 46)
  })
})
