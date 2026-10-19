import {
  buildFeatureFocusView,
  emptyLevelReason,
  LEVEL_CONTROL_GLYPH,
  toFocusGraph,
  UNASSIGNED_DOMAIN,
  type FeatureGraphInput,
  type FeatureGraphNodeInput,
} from './feature-view-model'
import { childrenOf, type FocusNode } from './focus-stack'

function node(partial: Partial<FeatureGraphNodeInput> & { id: string }): FeatureGraphNodeInput {
  return {
    slug: partial.id.replace('feature:', ''),
    name: partial.name ?? partial.id.replace('feature:', ''),
    kind: partial.kind ?? 'core',
    understanding: partial.understanding ?? 'none',
    active: partial.active ?? false,
    anchorCount: partial.anchorCount ?? 0,
    ...partial,
  }
}

const graph: FeatureGraphInput = {
  nodes: [
    node({ id: 'feature:auth', name: 'Auth', understanding: 'learned', anchorCount: 4 }),
    node({ id: 'feature:billing', name: 'Billing', understanding: 'stale', anchorCount: 2 }),
    node({ id: 'feature:live', name: 'Live Work', understanding: 'none', active: true }),
    node({ id: 'feature:auth/tokens', name: 'Tokens', kind: 'part', parent: 'feature:auth', anchorCount: 1 }),
  ],
  edges: [{ from: 'feature:auth', to: 'feature:billing' }],
}

describe('the level the feature map draws', () => {
  // These replace the deleted grid tests (`buildFeatureBoardView`): the
  // behaviours that SURVIVED the grid — which nodes a level shows, which wires
  // are drawable, and what an empty level says — asserted against the
  // stack-shaped surface that now carries them.

  it('shows core features at the root when no domain layer exists', () => {
    const view = buildFeatureFocusView(graph)
    expect(view.cards.map((c) => c.id)).not.toContain('feature:auth/tokens')
    expect(view.cards).toHaveLength(3)
  })

  it('drilling a feature shows its children, and the trail says where you are', () => {
    const auth = buildFeatureFocusView(graph).cards.find((c) => c.id === 'feature:auth')!
    const view = buildFeatureFocusView(graph, [auth])
    expect(view.cards.map((c) => c.id)).toEqual(['feature:auth/tokens'])
    expect(view.crumbs.map((c) => c.name)).toEqual(['Features', 'Auth'])
  })

  it('reports a childless feature as drillable:false but still enterable', () => {
    const cards = buildFeatureFocusView(graph).cards
    expect(cards.find((c) => c.id === 'feature:auth')!.drillable).toBe(true)
    expect(cards.find((c) => c.id === 'feature:billing')!.drillable).toBe(false)
    // `canDrill` is what navigation obeys, and it says yes for both.
    expect(cards.every((c) => c.canDrill)).toBe(true)
  })

  it('drilling a feature with NO children lands on a real, empty level', () => {
    const billing = buildFeatureFocusView(graph).cards.find((c) => c.id === 'feature:billing')!
    const view = buildFeatureFocusView(graph, [billing])
    expect(view.cards).toEqual([])
    // The stack MOVED — the click did not silently become a different gesture.
    expect(view.crumbs.map((c) => c.name)).toEqual(['Features', 'Billing'])
    expect(view.emptyReason).not.toBeNull()
  })

  it('draws relates edges only between nodes on screen', () => {
    expect(buildFeatureFocusView(graph).wires).toEqual([
      { from: 'feature:auth', to: 'feature:billing' },
    ])
    const auth = buildFeatureFocusView(graph).cards.find((c) => c.id === 'feature:auth')!
    expect(buildFeatureFocusView(graph, [auth]).wires).toEqual([])
  })

  it('names a gesture that can actually populate an empty store', () => {
    const reason = buildFeatureFocusView({ nodes: [], edges: [] }).emptyReason
    expect(reason).toContain('basic discovery')
    // NOT "from Settings". The board offers the gesture itself now — sending
    // the reader to another window for the one act that repairs the screen
    // they are looking at is a detour, not an instruction.
    expect(reason).not.toContain('Settings')
    // `features seed` only adopts markdown that is already there, so naming it
    // on a store with nothing in it sends the user to a guaranteed no-op.
    expect(reason).not.toContain('features seed')
  })

  it('names the node, what is absent, and the way to the other surface', () => {
    const billing = buildFeatureFocusView(graph).cards.find((c) => c.id === 'feature:billing')!
    // Not "Billing has no children" — that named neither what is missing nor
    // what to do, which is why an empty drill used to be avoided entirely.
    expect(buildFeatureFocusView(graph, [billing]).emptyReason).toBe(
      `Nothing recorded inside Billing yet · no parts have been learned. Open the level (the ${LEVEL_CONTROL_GLYPH} mark) to see what the code map resolves.`,
    )
  })

  it('a feature with CHANGES but no parts is not described as untouched', () => {
    // The reported confusion, as a sentence: changes are off every ring, so
    // this level is blank — but "nothing recorded inside Chats yet" about a
    // capability two plans have rewritten is simply false.
    const touched: FeatureGraphInput = {
      nodes: [
        node({ id: 'feature:chats', name: 'Chats' }),
        node({ id: 'feature:migration', name: 'Chat Session Cache Rework', kind: 'child', parent: 'feature:chats' }),
        node({ id: 'feature:sse-fix', name: 'SSE Fix', kind: 'child', parent: 'feature:chats' }),
      ],
      edges: [],
    }
    const chats = buildFeatureFocusView(touched).cards.find((c) => c.id === 'feature:chats')!
    const reason = buildFeatureFocusView(touched, [chats]).emptyReason
    expect(reason).toContain('No parts recorded inside Chats yet')
    expect(reason).toContain('2 changes')
    expect(reason).not.toContain('Nothing recorded inside')
    // And the noun is never spent twice: two changes are not "2 parts".
    expect(reason).not.toContain('2 parts')
  })

  it('a change record never reads as a feature that is missing its parts', () => {
    const change = { kind: 'change', id: 'feature:migration', name: 'Chat Session Cache Rework', kicker: '', drillable: false, canDrill: false, childCount: 0 } as const
    expect(emptyLevelReason(change, 4)).toContain('is a change')
    expect(emptyLevelReason(change, 4)).not.toContain('no parts have been learned')
  })

  it('a part says it is a single artifact, never that it is missing parts', () => {
    const part = { kind: 'part', id: 'part:x', name: 'Invoice PDF', kicker: '', drillable: false, canDrill: false, childCount: 0 } as const
    expect(emptyLevelReason(part, 4)).toContain('is a single artifact')
    expect(emptyLevelReason(part, 4)).not.toContain('no parts have been learned')
  })

  it('has no empty reason when there is something to show', () => {
    expect(buildFeatureFocusView(graph).emptyReason).toBeNull()
  })
})

describe('toFocusGraph synthesises the domain layer (Phase 4 — closes the 2/3 seam)', () => {
  const domained: FeatureGraphInput = {
    nodes: [
      node({ id: 'feature:chats', name: 'Chats', domain: 'Agent' }),
      node({ id: 'feature:board', name: 'Board', domain: 'Renderer' }),
      node({ id: 'feature:runs', name: 'Runs', domain: 'Agent' }),
      node({ id: 'feature:loose', name: 'Loose' }), // no domain
      node({ id: 'feature:chats/sse', name: 'SSE stream', kind: 'part', parent: 'feature:chats', partOf: 'chats' }),
      // A CHANGE RECORD, not a part — a plan that once touched Chats.
      node({ id: 'feature:migration', name: 'Chat Session Cache Rework', kind: 'child', parent: 'feature:chats' }),
    ],
    edges: [],
  }

  it('emits one domain node per distinct domain, features parented to it', () => {
    const focus = toFocusGraph(domained)
    const domains = focus.nodes.filter((n) => n.kind === 'domain')
    expect(domains.map((d) => d.name)).toEqual(['Agent', 'Renderer', UNASSIGNED_DOMAIN])
    const chats = focus.nodes.find((n) => n.id === 'feature:chats')
    expect(chats).toEqual({ kind: 'feature', id: 'feature:chats', name: 'Chats', parent: 'domain:Agent' })
  })

  it('never drops a domain-less feature — it lands in the explicit Unassigned bucket', () => {
    const focus = toFocusGraph(domained)
    const loose = focus.nodes.find((n) => n.id === 'feature:loose')
    expect(loose?.parent).toBe(`domain:${UNASSIGNED_DOMAIN}`)
    const unassigned = childrenOf(focus, null).find((n) => n.name === UNASSIGNED_DOMAIN)
    expect(unassigned?.childCount).toBe(1)
  })

  it('makes the ROOT the domains — the whole point of the seam', () => {
    const root = childrenOf(toFocusGraph(domained), null)
    expect(root.map((n) => n.name)).toEqual(['Agent', 'Renderer', UNASSIGNED_DOMAIN])
    expect(root.every((n) => n.kind === 'domain')).toBe(true)
    expect(root[0].kicker).toBe('2 features')
  })

  it('synthesises NOTHING when no feature carries a domain — the documented fallback survives', () => {
    // A never-seeded project must not open on a single ring of one node called
    // "Unassigned"; `childrenOf(null)` shows feature roots directly instead.
    const focus = toFocusGraph(graph)
    expect(focus.nodes.some((n) => n.kind === 'domain')).toBe(false)
    expect(childrenOf(focus, null).map((n) => n.id)).toEqual([
      'feature:auth',
      'feature:billing',
      'feature:live',
    ])
  })

  it('keeps a part parented to its FEATURE, never to a domain', () => {
    const focus = toFocusGraph(domained)
    expect(focus.nodes.find((n) => n.id === 'feature:chats/sse')).toEqual({
      kind: 'part',
      id: 'feature:chats/sse',
      name: 'SSE stream',
      parent: 'feature:chats',
    })
  })

  it('maps each CLI kind by name — a change record is never a part', () => {
    // THE REGRESSION THIS MAP EXISTS FOR. `kind === 'core' ? 'feature' : 'part'`
    // had two branches for three kinds, so `child` — a plan or an issue — came
    // out labelled `part` and took a seat on the ring that belonged to a real
    // part of the feature.
    const focus = toFocusGraph(domained)
    expect(focus.nodes.find((n) => n.id === 'feature:migration')).toEqual({
      kind: 'change',
      id: 'feature:migration',
      name: 'Chat Session Cache Rework',
      // The parent link is why a change record stays in this graph at all:
      // the upward walks need it. It is not a ring member.
      parent: 'feature:chats',
    })
    expect(focus.nodes.find((n) => n.id === 'feature:chats')?.kind).toBe('feature')
    expect(focus.nodes.find((n) => n.id === 'feature:chats/sse')?.kind).toBe('part')
  })

  it('EXCLUDES a kind it has never heard of rather than guessing `part`', () => {
    const future: FeatureGraphInput = {
      nodes: [
        node({ id: 'feature:chats', name: 'Chats' }),
        // A kind from a newer CLI than this board. Cast because the contract
        // does not admit it — which is exactly the situation being guarded.
        node({ id: 'feature:mystery', name: 'Mystery', kind: 'saga' as never, parent: 'feature:chats' }),
      ],
      edges: [],
    }
    const focus = toFocusGraph(future)
    expect(focus.nodes.map((n) => n.id)).toEqual(['feature:chats'])
    const chats = childrenOf(focus, null)[0]
    expect(childrenOf(focus, chats)).toEqual([])
  })

  it('drilling a domain shows its features, and drilling one shows its parts', () => {
    const focus = toFocusGraph(domained)
    const agent = childrenOf(focus, null).find((n) => n.name === 'Agent')!
    const features = childrenOf(focus, agent)
    expect(features.map((f) => f.name)).toEqual(['Chats', 'Runs'])
    expect(childrenOf(focus, features[0]).map((p) => p.name)).toEqual(['SSE stream'])
  })

  it('is deterministic — Unassigned always last, real domains alphabetical', () => {
    const shuffled: FeatureGraphInput = {
      nodes: [
        node({ id: 'feature:z', name: 'Z' }),
        node({ id: 'feature:b', name: 'B', domain: 'Zeta' }),
        node({ id: 'feature:a', name: 'A', domain: 'Alpha' }),
      ],
      edges: [],
    }
    expect(toFocusGraph(shuffled).nodes.filter((n) => n.kind === 'domain').map((n) => n.name)).toEqual([
      'Alpha',
      'Zeta',
      UNASSIGNED_DOMAIN,
    ])
    expect(toFocusGraph(shuffled)).toEqual(toFocusGraph(shuffled))
  })

  it('treats a blank domain as unassigned rather than a domain named ""', () => {
    const blank: FeatureGraphInput = {
      nodes: [node({ id: 'feature:a', name: 'A', domain: '   ' }), node({ id: 'feature:b', name: 'B', domain: 'Real' })],
      edges: [],
    }
    const names = toFocusGraph(blank).nodes.filter((n) => n.kind === 'domain').map((n) => n.name)
    expect(names).toEqual(['Real', UNASSIGNED_DOMAIN])
  })

  it('buildFeatureFocusView opens on the domains once they exist', () => {
    const view = buildFeatureFocusView(domained)
    expect(view.cards.map((c) => c.kind)).toEqual(['domain', 'domain', 'domain'])
    expect(view.emptyReason).toBeNull()
  })

  describe('a change record is RELOCATED, never deleted (Task 2.4)', () => {
    /** Every level this graph can reach, root first — the exhaustive ring. */
    function everyLevel(input: FeatureGraphInput): FocusNode[] {
      const focus = toFocusGraph(input)
      const seen = new Set<string>()
      const all: FocusNode[] = []
      const walk = (parent: FocusNode | null): void => {
        for (const child of childrenOf(focus, parent)) {
          if (seen.has(child.id)) continue
          seen.add(child.id)
          all.push(child)
          walk(child)
        }
      }
      walk(null)
      return all
    }

    it('never appears as a ring node — at ANY depth, not merely at the root', () => {
      const ids = everyLevel(domained).map((n) => n.id)
      expect(ids).not.toContain('feature:migration')
      // …while the real part of the same feature IS there.
      expect(ids).toContain('feature:chats/sse')
      expect(everyLevel(domained).some((n) => n.kind === 'change')).toBe(false)
    })

    it('does not count toward the parts its feature claims', () => {
      const focus = toFocusGraph(domained)
      const agent = childrenOf(focus, null).find((n) => n.name === 'Agent')!
      const chats = childrenOf(focus, agent).find((n) => n.name === 'Chats')!
      // One part and one change under Chats; the count is of PARTS.
      expect(chats.childCount).toBe(1)
      expect(chats.kicker).toBe('1 part')
    })

    it('SURVIVES in the payload the brief reads — relocated, not dropped', () => {
      // The board's `Changes:` line is now the only route to a change record
      // (blueprint-board.ts, `view.intro.children`). Removing these nodes from
      // the graph instead of from the ring would delete the feature rather than
      // move it, so the payload is asserted here alongside the exclusion above.
      const change = domained.nodes.find((n) => n.id === 'feature:migration')
      expect(change).toBeDefined()
      expect(change?.kind).toBe('child')
      expect(change?.parent).toBe('feature:chats')
      // And it keeps its place in the focus graph too, so anything walking
      // UPWARDS from it (the in-flight learning rollup) still finds its feature.
      const inFocus = toFocusGraph(domained).nodes.find((n) => n.id === 'feature:migration')
      expect(inFocus?.parent).toBe('feature:chats')
    })
  })
})
