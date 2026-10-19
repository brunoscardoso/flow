import type { BrainHit } from '../../shared/ipc-contract'
import {
  anchorQueryField,
  BRAIN_QUERY_LIMIT,
  buildBrainHighlight,
  DIM_CLASS,
  failQuery,
  featureSlugOfHit,
  hitAction,
  idleQuery,
  LIT_CLASS,
  queryAvailableAtDepth,
  resolveQuery,
  ringNodeForSlug,
  statusLine,
  submitQuery,
  type BrainHighlight,
} from './brain-query-model'
import type { FeatureGraphInput, FeatureGraphNodeInput } from './feature-view-model'

function feature(
  slug: string,
  overrides: Partial<FeatureGraphNodeInput> = {},
): FeatureGraphNodeInput {
  return {
    id: `feature:${slug}`,
    slug,
    name: slug,
    kind: 'core',
    understanding: 'none',
    active: false,
    anchorCount: 1,
    ...overrides,
  }
}

function hit(path: string, overrides: Partial<BrainHit> = {}): BrainHit {
  return { path, title: path, snippet: '', kind: 'feature', ...overrides }
}

describe('queryAvailableAtDepth (Task 7.5 — root-only)', () => {
  it('offers the query at the root, where the centre IS the brain', () => {
    expect(queryAvailableAtDepth(0)).toBe(true)
  })

  it('withdraws it at every depth below, where the centre is where you are', () => {
    expect(queryAvailableAtDepth(1)).toBe(false)
    expect(queryAvailableAtDepth(2)).toBe(false)
    expect(queryAvailableAtDepth(7)).toBe(false)
  })

  it('is depth, not a mode — popping back to the root restores it', () => {
    // No state to remember: the same input always gives the same answer.
    expect(queryAvailableAtDepth(0)).toBe(queryAvailableAtDepth(0))
  })
})

describe('query state (Task 7.3 — empty / error / no-result are explicit)', () => {
  it('opens idle, with nothing asked', () => {
    expect(idleQuery()).toEqual({ phase: 'idle', query: '', hits: [], error: null })
  })

  it('refuses an all-whitespace query BEFORE the call — that is not a search', () => {
    expect(submitQuery('   ').phase).toBe('empty')
    expect(submitQuery('').phase).toBe('empty')
    expect(submitQuery('\t\n').query).toBe('')
  })

  it('trims a real query and moves to searching', () => {
    const state = submitQuery('  wave execution  ')
    expect(state.phase).toBe('searching')
    expect(state.query).toBe('wave execution')
  })

  it('treats zero hits as a RESULT, never as an error', () => {
    const state = resolveQuery('nothing', [])
    expect(state.phase).toBe('results')
    expect(state.hits).toEqual([])
    expect(state.error).toBeNull()
  })

  it('keeps the failure reason — an unavailable brain is not "no results"', () => {
    const state = failQuery('x', new Error('[Brain] Unknown root: /tmp/gone'))
    expect(state.phase).toBe('error')
    expect(state.error).toBe('[Brain] Unknown root: /tmp/gone')
    expect(state.hits).toEqual([])
  })

  it('names a non-Error rejection rather than rendering "undefined"', () => {
    expect(failQuery('x', 'boom').error).toBe('the brain did not answer')
    expect(failQuery('x', new Error('')).error).toBe('the brain did not answer')
  })

  it('copies the hits — the state never aliases the caller`s array', () => {
    const hits = [hit('flow/brain/features/chats.md')]
    const state = resolveQuery('chats', hits)
    hits.length = 0
    expect(state.hits).toHaveLength(1)
  })
})

describe('anchorQueryField (Task 7.2 — anchored to the affordance, not the viewport)', () => {
  const field = { width: 260, height: 120 }
  const stage = { width: 1200, height: 800 }

  it('centres the field on the ANCHOR, not on the stage', () => {
    // The fit moves the figure around, so the brain is rarely at the middle.
    const anchor = { x: 300, y: 240 }
    const placed = anchorQueryField(anchor, field, stage)
    expect(placed.left + field.width / 2).toBeCloseTo(anchor.x, 6)
    // Explicitly NOT the viewport centre.
    expect(placed.left + field.width / 2).not.toBeCloseTo(stage.width / 2, 0)
  })

  it('opens below the affordance by the gap', () => {
    const placed = anchorQueryField({ x: 600, y: 300 }, field, stage)
    expect(placed.top).toBe(300 + 14)
    expect(placed.flipped).toBe(false)
  })

  it('flips above when there is no room below', () => {
    const placed = anchorQueryField({ x: 600, y: 760 }, field, stage)
    expect(placed.flipped).toBe(true)
    expect(placed.top).toBe(760 - 14 - field.height)
  })

  it('clamps to the stage rather than opening half off-screen', () => {
    const left = anchorQueryField({ x: 4, y: 300 }, field, stage)
    expect(left.left).toBe(10)
    const right = anchorQueryField({ x: 1196, y: 300 }, field, stage)
    expect(right.left).toBe(stage.width - 10 - field.width)
  })

  it('centres-but-clips when the stage cannot hold the field at all', () => {
    const tiny = { width: 120, height: 90 }
    const placed = anchorQueryField({ x: 60, y: 45 }, field, tiny)
    // Inverted clamp range → the midpoint, not an arbitrary edge.
    expect(placed.left).toBeCloseTo((10 + (120 - 10 - 260)) / 2, 6)
    expect(placed.top).toBeCloseTo((10 + (90 - 10 - 120)) / 2, 6)
  })

  it('does not flip into a place that is just as bad', () => {
    const short = { width: 1200, height: 150 }
    const placed = anchorQueryField({ x: 600, y: 100 }, field, short)
    expect(placed.flipped).toBe(false)
  })

  it('is deterministic — same anchor, same placement', () => {
    const a = anchorQueryField({ x: 411, y: 233 }, field, stage)
    const b = anchorQueryField({ x: 411, y: 233 }, field, stage)
    expect(a).toEqual(b)
  })
})

describe('featureSlugOfHit', () => {
  it('reads the slug out of a feature hit`s path', () => {
    expect(featureSlugOfHit(hit('flow/brain/features/wave-execution.md'))).toBe('wave-execution')
  })

  it('tolerates windows separators', () => {
    expect(featureSlugOfHit(hit('flow\\brain\\features\\chats.md'))).toBe('chats')
  })

  it('ignores hits from the other brain tiers — they light no feature', () => {
    expect(featureSlugOfHit(hit('flow/brain/decisions/x.md', { kind: 'decision' }))).toBeNull()
    expect(featureSlugOfHit(hit('flow/brain/errors/y.md', { kind: 'error' }))).toBeNull()
  })

  it('ignores a feature-kind hit whose path is not a feature file', () => {
    expect(featureSlugOfHit(hit('flow/brain/index.md'))).toBeNull()
  })
})

describe('ringNodeForSlug', () => {
  const graph: FeatureGraphInput = {
    nodes: [
      feature('chats', { domain: 'Workbench' }),
      feature('board', { domain: 'Workbench' }),
      feature('loose'),
      feature('inner', { kind: 'part', parent: 'feature:chats' }),
    ],
    edges: [],
  }

  it('lights the feature itself when the ring shows features', () => {
    const ring = new Set(['feature:chats', 'feature:board'])
    expect(ringNodeForSlug(graph, 'chats', ring)).toBe('feature:chats')
  })

  it('lights the domain when the ring shows domains', () => {
    const ring = new Set(['domain:Workbench', 'domain:Unassigned'])
    expect(ringNodeForSlug(graph, 'chats', ring)).toBe('domain:Workbench')
  })

  it('lights the Unassigned bucket for a feature with no domain — counted, never dropped', () => {
    const ring = new Set(['domain:Workbench', 'domain:Unassigned'])
    expect(ringNodeForSlug(graph, 'loose', ring)).toBe('domain:Unassigned')
  })

  it('walks a part up to its feature when the ring shows the feature', () => {
    const ring = new Set(['feature:chats', 'feature:board'])
    expect(ringNodeForSlug(graph, 'inner', ring)).toBe('feature:chats')
  })

  it('walks a part all the way to its domain', () => {
    const ring = new Set(['domain:Workbench'])
    expect(ringNodeForSlug(graph, 'inner', ring)).toBe('domain:Workbench')
  })

  it('returns null for a slug this store does not know', () => {
    expect(ringNodeForSlug(graph, 'ghost', new Set(['feature:chats']))).toBeNull()
  })

  it('returns null when nothing on this ring represents the feature', () => {
    expect(ringNodeForSlug(graph, 'chats', new Set(['feature:board']))).toBeNull()
  })

  it('does not hang on a cyclic parent chain in a hand-edited store', () => {
    const cyclic: FeatureGraphInput = {
      nodes: [
        feature('a', { kind: 'child', parent: 'feature:b' }),
        feature('b', { kind: 'child', parent: 'feature:a' }),
      ],
      edges: [],
    }
    expect(ringNodeForSlug(cyclic, 'a', new Set(['domain:Nope']))).toBeNull()
  })
})

describe('buildBrainHighlight (Task 7.4 — lit, dimmed, counted)', () => {
  const graph: FeatureGraphInput = {
    nodes: [feature('chats'), feature('board'), feature('learn')],
    edges: [],
  }
  const nodes = [{ id: 'feature:chats' }, { id: 'feature:board' }, { id: 'feature:learn' }]

  it('lights the hits and dims everything else — never hides a node', () => {
    const highlight = buildBrainHighlight(graph, nodes, [hit('flow/brain/features/chats.md')])
    expect(highlight.lit).toEqual(['feature:chats'])
    expect(highlight.dimmed).toEqual(['feature:board', 'feature:learn'])
    // Every ring node is accounted for: nothing is removed from the map.
    expect(highlight.lit.length + highlight.dimmed.length).toBe(nodes.length)
  })

  it('keeps the ring`s own order, so the same hits give the same lists', () => {
    const hits = [hit('flow/brain/features/learn.md'), hit('flow/brain/features/chats.md')]
    expect(buildBrainHighlight(graph, nodes, hits).lit).toEqual(['feature:chats', 'feature:learn'])
    expect(buildBrainHighlight(graph, nodes, [...hits].reverse()).lit).toEqual([
      'feature:chats',
      'feature:learn',
    ])
  })

  it('dedupes two hits on one feature — one node, still two matches', () => {
    const hits = [hit('flow/brain/features/chats.md'), hit('flow/brain/features/chats.md')]
    const highlight = buildBrainHighlight(graph, nodes, hits)
    expect(highlight.lit).toEqual(['feature:chats'])
    expect(highlight.hitCount).toBe(2)
    expect(highlight.onMap).toBe(2)
  })

  it('counts hits that light nothing here instead of dropping them', () => {
    const hits = [
      hit('flow/brain/features/chats.md'),
      hit('flow/brain/decisions/why.md', { kind: 'decision' }),
      hit('flow/brain/features/ghost.md'),
    ]
    const highlight = buildBrainHighlight(graph, nodes, hits)
    expect(highlight.hitCount).toBe(3)
    expect(highlight.onMap).toBe(1)
    expect(highlight.offMap).toBe(2)
  })

  it('dims everything on a zero-hit query — the map still reads', () => {
    const highlight = buildBrainHighlight(graph, nodes, [])
    expect(highlight.lit).toEqual([])
    expect(highlight.dimmed).toHaveLength(3)
    expect(highlight.hitCount).toBe(0)
  })

  it('survives an empty ring', () => {
    const highlight = buildBrainHighlight(graph, [], [hit('flow/brain/features/chats.md')])
    expect(highlight.lit).toEqual([])
    expect(highlight.offMap).toBe(1)
  })

  it('names its own classes, so the board never spells them itself', () => {
    expect(LIT_CLASS).toBe('fb-terr-lit')
    expect(DIM_CLASS).toBe('fb-terr-dim')
  })
})

describe('statusLine (Task 7.4 — the live count, including zero)', () => {
  const empty: BrainHighlight = { lit: [], dimmed: [], hitCount: 0, onMap: 0, offMap: 0 }

  it('says what the field is for before anything is asked', () => {
    expect(statusLine(idleQuery(), null)).toContain('Ask the brain')
  })

  it('names the empty query rather than reporting "no results"', () => {
    expect(statusLine(submitQuery('  '), null)).toBe('Type something to ask the brain.')
  })

  it('says it is asking', () => {
    expect(statusLine(submitQuery('waves'), null)).toContain('waves')
  })

  it('reports the ZERO case explicitly', () => {
    expect(statusLine(resolveQuery('unicorn', []), empty)).toBe('No matches for “unicorn”.')
  })

  it('counts matches and lit nodes', () => {
    const state = resolveQuery('chats', [hit('flow/brain/features/chats.md')])
    const highlight: BrainHighlight = {
      lit: ['feature:chats'],
      dimmed: ['feature:board'],
      hitCount: 1,
      onMap: 1,
      offMap: 0,
    }
    expect(statusLine(state, highlight)).toBe('1 match · 1 node lit.')
  })

  it('discloses hits that lit nothing on this ring — no silent truncation', () => {
    const state = resolveQuery('x', [
      hit('flow/brain/features/chats.md'),
      hit('flow/brain/decisions/a.md', { kind: 'decision' }),
      hit('flow/brain/decisions/b.md', { kind: 'decision' }),
    ])
    const highlight: BrainHighlight = {
      lit: ['feature:chats'],
      dimmed: [],
      hitCount: 3,
      onMap: 1,
      offMap: 2,
    }
    expect(statusLine(state, highlight)).toBe('3 matches · 1 node lit · 2 not on this ring.')
  })

  // Task 8.4 — the ASK is a cap. An answer that comes back full is the only
  // evidence there may be more, and printing "12 matches" hid it.
  it('discloses that a FULL answer may not be all of them', () => {
    const hits = Array.from({ length: BRAIN_QUERY_LIMIT }, (_unused, i) =>
      hit(`flow/brain/decisions/${i}.md`, { kind: 'decision' }),
    )
    const line = statusLine(resolveQuery('x', hits), null)
    expect(line).toContain('there may be more')
  })

  it('claims nothing extra when the answer came back short of the cap', () => {
    const hits = Array.from({ length: BRAIN_QUERY_LIMIT - 1 }, (_unused, i) =>
      hit(`flow/brain/decisions/${i}.md`, { kind: 'decision' }),
    )
    expect(statusLine(resolveQuery('x', hits), null)).not.toContain('there may be more')
  })

  it('reports a failed call as a failure, with its reason', () => {
    const line = statusLine(failQuery('x', new Error('index missing')), null)
    expect(line).toContain('could not answer')
    expect(line).toContain('index missing')
  })
})

describe('hitAction — every result row DOES something (was: dead clicks)', () => {
  const graph: FeatureGraphInput = {
    nodes: [
      feature('chats', { domain: 'Workbench' }),
      feature('board', { domain: 'Workbench' }),
      feature('inner', { kind: 'part', parent: 'feature:chats', name: 'Inner' }),
    ],
    edges: [],
  }

  it('focuses a feature the CURRENT ring already shows — no depth change', () => {
    const ring = new Set(['feature:chats', 'feature:board'])
    const action = hitAction(hit('flow/brain/features/chats.md', { title: 'Chats' }), graph, ring)
    expect(action.kind).toBe('focus')
    expect(action.nodeId).toBe('feature:chats')
    expect(action.stack).toBeNull()
    expect(action.label).toBe('Show Chats on the map')
  })

  it('NAVIGATES to a feature this ring does not show — the majority case', () => {
    // The root ring is domains, so `chats` is a level down. This is the hit the
    // counter calls "not on this ring", and it used to be unreachable.
    const ring = new Set(['domain:Workbench'])
    const action = hitAction(hit('flow/brain/features/chats.md', { title: 'Chats' }), graph, ring)
    // NOT a focus on the domain. The hit is Chats, so the reader ends up at
    // Chats — lighting a hub of seven and calling it "Show Chats on the map"
    // is half an answer, and it is what made this branch unreachable.
    expect(action.kind).toBe('navigate')
    expect(action.nodeId).toBe('feature:chats')
    expect(action.stack?.map((n) => n.id)).toEqual(['domain:Workbench'])
    expect(action.label).toBe('Go to Chats — inside Workbench')
  })

  it('hands back the full focus path for a node two levels down', () => {
    const ring = new Set(['domain:Elsewhere'])
    const action = hitAction(hit('flow/brain/features/inner.md', { title: 'Inner' }), graph, ring)
    expect(action.kind).toBe('navigate')
    expect(action.nodeId).toBe('feature:inner')
    // The stack stops at the PARENT — the target belongs on the ring, not in
    // the centre. Domain → feature → (ring shows the part).
    expect(action.stack?.map((n) => n.id)).toEqual(['domain:Workbench', 'feature:chats'])
    expect(action.label).toBe('Go to Inner — inside chats')
  })

  it('still FOCUSES when the hit is on the ring in its own right', () => {
    const ring = new Set(['feature:chats', 'feature:board'])
    expect(hitAction(hit('flow/brain/features/chats.md', { title: 'Chats' }), graph, ring).kind).toBe('focus')
  })

  it('OPENS THE DOCUMENT for a non-feature hit — the chip is a promise', () => {
    const action = hitAction(
      hit('flow/brain/decisions/why-sqlite.md', { title: 'Why SQLite', kind: 'decision' }),
      graph,
      new Set(['feature:chats']),
    )
    expect(action.kind).toBe('peek')
    expect(action.path).toBe('flow/brain/decisions/why-sqlite.md')
    expect(action.nodeId).toBeNull()
    // A decision must NEVER quietly focus a feature that mentions it.
    expect(action.label).toContain('Open flow/brain/decisions/why-sqlite.md')
  })

  it('peeks a feature markdown the graph does not carry, rather than dying', () => {
    const action = hitAction(
      hit('flow/brain/features/ghost.md', { title: 'Ghost' }),
      graph,
      new Set(['feature:chats']),
    )
    expect(action.kind).toBe('peek')
    expect(action.label).toContain('the map does not show this feature')
  })

  it('says WHY when there is nothing to open — never a silent no-op', () => {
    const action = hitAction(hit('', { title: 'Orphan', kind: 'decision' }), graph, new Set())
    expect(action.kind).toBe('none')
    expect(action.path).toBeNull()
    expect(action.label).toBe(
      'Orphan has no file to open — this match came from the index only',
    )
  })

  it('is total — a null graph still yields an action for every hit', () => {
    const action = hitAction(hit('flow/brain/features/chats.md'), null, new Set())
    expect(action.kind).toBe('peek')
  })
})
