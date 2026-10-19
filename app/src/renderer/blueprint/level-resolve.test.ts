import type { CuratedLevel, CuratedView } from './curated-view'
import {
  DERIVED_EDGE_CAP,
  DERIVED_NODE_KINDS,
  buildDerivedLevel,
  derivedNodeKind,
  derivedTitle,
  isDerivedView,
  mergeStructuralEdges,
  pruneWires,
  type DerivedStructure,
  type StructuralRelation,
} from './derived-level'
import {
  asCuratedView,
  levelEmptyState,
  levelOpens,
  resolveLevel,
  type LevelPartSource,
  type LevelSource,
  type LevelTarget,
} from './level-resolve'
import { partNoAnchorRefusal } from './understand-action'

function level(partial: Partial<CuratedLevel> = {}): CuratedLevel {
  return {
    title: 'Chats',
    nodes: [{ id: 'bff', kind: 'service', title: 'Gateway BFF', delta: 'stable' }],
    edges: [],
    ...partial,
  }
}

function curated(partial: Partial<CuratedView> = {}): CuratedView {
  return {
    feature: 'feature:chats',
    provenance: 'plan_chats_v1',
    generatedAt: '2026-08-04',
    meta: { title: 'Chats' },
    views: { root: level() },
    ...partial,
  }
}

const feature: LevelTarget = { id: 'feature:chats', kind: 'feature', name: 'Chats', depth: 0 }

function source(partial: Partial<LevelSource> = {}): LevelSource {
  return { available: true, reason: null, structuralCount: 0, ...partial }
}

describe('resolution order (Task 5.1)', () => {
  it('takes the curated view when one exists and is usable', () => {
    const resolution = resolveLevel(feature, source({ view: curated(), structuralCount: 4 }))
    expect(resolution.verdict).toBe('curated')
    expect(resolution.view).not.toBeNull()
    expect(resolution.level?.title).toBe('Chats')
    // The seam Phase 6 fills — never pre-empted here.
    expect(resolution.derived).toBeNull()
  })

  it('falls to the derived level when no curated view was generated', () => {
    const resolution = resolveLevel(feature, source({ view: null, structuralCount: 3 }))
    expect(resolution.verdict).toBe('derived')
    expect(resolution.view).toBeNull()
    expect(resolution.level).toBeNull()
    // NO STRUCTURE HANDED IN ⇒ NO PAYLOAD. This was Phase 5's seam and is now
    // the honest answer for a caller that has no code map to build from: the
    // verdict and the count stand, the level does not appear from nowhere.
    expect(resolution.derived).toBeNull()
    expect(resolution.structuralCount).toBe(3)
  })

  it('falls to empty when there is neither a curated view nor anything to derive', () => {
    const resolution = resolveLevel(feature, source({ view: null, structuralCount: 0 }))
    expect(resolution.verdict).toBe('empty')
  })

  it('prefers curated over derived even when both have material', () => {
    const resolution = resolveLevel(feature, source({ view: curated(), structuralCount: 9 }))
    expect(resolution.verdict).toBe('curated')
  })

  it('falls PAST an unusable curated view to the derived level', () => {
    // A view whose root level exists but holds no components draws nothing —
    // `rootLevel` already refuses it, and a blank curated stage is exactly the
    // failure this phase exists to stop.
    const hollow = curated({ views: { root: level({ nodes: [] }) } })
    const resolution = resolveLevel(feature, source({ view: hollow, structuralCount: 2 }))
    expect(resolution.verdict).toBe('derived')
    expect(resolution.reason).toContain('has no usable root level')
  })

  it('treats a view with no root level at all as unusable', () => {
    const orphan = curated({ views: { detail: level() } })
    const resolution = resolveLevel(feature, source({ view: orphan, structuralCount: 0 }))
    expect(resolution.verdict).toBe('empty')
    expect(resolution.reason).toContain('has no usable root level')
  })
})

describe('fail-soft (Task 5.1)', () => {
  it('resolves a domain to a verdict rather than throwing', () => {
    const domain: LevelTarget = { id: 'domain:Agent', kind: 'domain', name: 'Agent', depth: 0 }
    const resolution = resolveLevel(domain, source({ structuralCount: 12 }))
    expect(resolution.verdict).toBe('empty')
    expect(resolution.reason).toContain('is a domain')
    // Domains group the ring only — never a feature-view, so VIEW_NODE_KINDS
    // stays frozen.
    expect(resolution.view).toBeNull()
  })

  it('carries the CLI’s own refusal into the reason', () => {
    const resolution = resolveLevel(
      feature,
      source({ available: false, reason: 'bundled CLI unavailable' }),
    )
    expect(resolution.verdict).toBe('empty')
    expect(resolution.reason).toContain('bundled CLI unavailable')
  })

  it('still says something specific when the CLI refused without a reason', () => {
    const resolution = resolveLevel(feature, source({ available: false, reason: null }))
    expect(resolution.reason).toContain('Chats')
    expect(resolution.reason).toContain('gave no reason')
  })

  it('does not mistake a non-object view for an artifact', () => {
    for (const junk of [42, 'root', [], true, null, undefined]) {
      const resolution = resolveLevel(feature, source({ view: junk, structuralCount: 1 }))
      expect(resolution.verdict).toBe('derived')
      expect(resolution.view).toBeNull()
    }
  })

  it('narrows only a real artifact shape', () => {
    expect(asCuratedView(curated())).not.toBeNull()
    expect(asCuratedView({ views: [] })).toBeNull()
    expect(asCuratedView({ feature: 'x' })).toBeNull()
    expect(asCuratedView(null)).toBeNull()
  })

  it('clamps a nonsense structural count instead of trusting it', () => {
    expect(resolveLevel(feature, source({ structuralCount: -4 })).verdict).toBe('empty')
    expect(resolveLevel(feature, source({ structuralCount: 2.7 })).structuralCount).toBe(2)
  })

  it('survives a node with a blank name', () => {
    const nameless: LevelTarget = { id: 'feature:x', kind: 'feature', name: '   ', depth: 0 }
    const resolution = resolveLevel(nameless, source())
    expect(resolution.reason).toContain('this node')
    expect(resolution.reason.trim().length).toBeGreaterThan(0)
  })
})

describe('the reason is never blank (Task 5.5, FR8)', () => {
  const cases: Array<[string, LevelSource, LevelTarget]> = [
    ['curated', source({ view: curated(), structuralCount: 1 }), feature],
    ['derived', source({ structuralCount: 1 }), feature],
    ['empty — nothing at all', source(), feature],
    ['empty — refused', source({ available: false, reason: 'no such feature' }), feature],
    [
      'empty — domain',
      source({ structuralCount: 5 }),
      { id: 'domain:Agent', kind: 'domain', name: 'Agent', depth: 2 },
    ],
  ]
  it.each(cases)('%s carries a specific sentence', (_label, src, target) => {
    const resolution = resolveLevel(target, src)
    expect(resolution.reason.trim().length).toBeGreaterThan(0)
    // Specific, not generic: it names the node it is talking about.
    expect(resolution.reason).toContain(target.name.trim())
  })

  it('NAMES the missing thing rather than rendering blank', () => {
    const resolution = resolveLevel(feature, source())
    expect(resolution.reason).toContain('no curated view generated')
    const state = levelEmptyState(resolution)
    expect(state).not.toBeNull()
    expect(state?.title).toBe('No level for Chats')
    expect(state?.detail).toBe(resolution.reason)
    expect(state?.hint.length).toBeGreaterThan(0)
  })

  it('gives a domain its own hint — open a feature, not this', () => {
    const domain: LevelTarget = { id: 'domain:Agent', kind: 'domain', name: 'Agent', depth: 0 }
    const state = levelEmptyState(resolveLevel(domain, source()))
    expect(state?.hint).toContain('features inside it')
  })

  it('offers no empty state for a verdict that renders something', () => {
    expect(levelEmptyState(resolveLevel(feature, source({ view: curated() })))).toBeNull()
    expect(levelEmptyState(resolveLevel(feature, source({ structuralCount: 2 })))).toBeNull()
  })

  it('does not promise a command that would not produce a view', () => {
    const state = levelEmptyState(resolveLevel(feature, source()))
    expect(state?.hint).not.toContain('planflow-ai')
  })

  it('opens for curated and derived, never for empty', () => {
    expect(levelOpens(resolveLevel(feature, source({ view: curated() })))).toBe(true)
    expect(levelOpens(resolveLevel(feature, source({ structuralCount: 1 })))).toBe(true)
    expect(levelOpens(resolveLevel(feature, source()))).toBe(false)
  })
})

describe('the way back (Task 5.4)', () => {
  it('carries the depth the control was pressed at, on every verdict', () => {
    const deep = { ...feature, depth: 3 }
    expect(resolveLevel(deep, source({ view: curated() })).returnDepth).toBe(3)
    expect(resolveLevel(deep, source({ structuralCount: 2 })).returnDepth).toBe(3)
    expect(resolveLevel(deep, source()).returnDepth).toBe(3)
    expect(resolveLevel({ ...deep, kind: 'domain' }, source()).returnDepth).toBe(3)
  })

  it('defaults to the root only when no depth was given', () => {
    const { depth: _drop, ...noDepth } = feature
    expect(resolveLevel(noDepth, source({ view: curated() })).returnDepth).toBe(0)
  })

  it('refuses a nonsense depth rather than restoring to one', () => {
    expect(resolveLevel({ ...feature, depth: -2 }, source()).returnDepth).toBe(0)
    expect(resolveLevel({ ...feature, depth: 1.5 }, source()).returnDepth).toBe(0)
  })
})

// ── Phase 6: the derived level ───────────────────────────────────────────────
//
// The measured starting point: `feature-views/` holds one artifact and it fails
// the validator, so almost every node resolves to `derived`. These tests are
// about what that verdict now CARRIES, and about the three ways a synthesised
// level could lie — by overprinting its own labels, by dropping edges quietly,
// or by passing itself off as something a validator approved.

function rel(source: string, target: string, relation: string): StructuralRelation {
  return { source, target, relation }
}

const PARTS = [
  { id: 'module:app/src/main', label: 'main', kind: 'module' },
  { id: 'module:app/src/main/chat', label: 'Chat manager', kind: 'module' },
  { id: 'endpoint:POST /api/chat', label: 'POST /api/chat', kind: 'endpoint' },
  { id: 'datastore:chat.sqlite', label: 'chat.sqlite', kind: 'datastore' },
]

function structure(partial: Partial<DerivedStructure> = {}): DerivedStructure {
  return {
    components: PARTS,
    edges: [
      rel('module:app/src/main', 'module:app/src/main/chat', 'contains'),
      rel('module:app/src/main', 'module:app/src/main/chat', 'imports'),
      rel('module:app/src/main/chat', 'endpoint:POST /api/chat', 'exposes'),
      rel('module:app/src/main/chat', 'datastore:chat.sqlite', 'uses'),
    ],
    ...partial,
  }
}

const CHATS = { id: 'feature:chats', name: 'Chats' }

describe('the derived level is built from what exists (Task 6.1)', () => {
  it('builds an artifact-shaped level the curated pipeline can draw', () => {
    const derived = buildDerivedLevel(CHATS, structure())
    expect(derived).not.toBeNull()
    // `views.root` is what `rootLevel` opens — the same door a curated view uses.
    expect(derived?.view.views['root']).toBe(derived?.level)
    expect(derived?.level.title).toBe('Chats')
    expect(derived?.level.nodes.map((node) => node.id)).toEqual(PARTS.map((part) => part.id))
    expect(derived?.componentCount).toBe(4)
  })

  it('describes ONE world — every component stable, every connection kept', () => {
    // A derived level has no Today ⇄ After: there is no plan behind it. Saying
    // so in the deltas is what stops the stage offering a switch between two
    // identical pictures.
    const derived = buildDerivedLevel(CHATS, structure())
    expect(derived?.level.nodes.every((node) => node.delta === 'stable')).toBe(true)
    expect(derived?.level.edges.every((edge) => edge.delta === 'kept')).toBe(true)
  })

  it('carries a component delta the CALLER supplies — a predicted component is not stable', () => {
    // The code map cannot know this; the brief can. A live proposal predicts a
    // component nothing has built, the CLI folds it into the brief's nodes as
    // `new`, and the level must carry that word or After badges nothing.
    const base = structure()
    const derived = buildDerivedLevel(CHATS, {
      ...base,
      components: [
        ...base.components.map((component) => ({ ...component })),
        { id: 'module:src/chats/ledger', kind: 'module', delta: 'new' as const },
      ],
    })
    const predicted = derived?.level.nodes.find((node) => node.id === 'module:src/chats/ledger')
    expect(predicted?.delta).toBe('new')
    // …and nothing else moved: every OTHER component keeps the code map's own
    // answer, so one prediction cannot make the whole level look like a plan.
    expect(
      derived?.level.nodes.filter((node) => node.id !== 'module:src/chats/ledger').every(
        (node) => node.delta === 'stable',
      ),
    ).toBe(true)
  })

  it('takes every component kind from the frozen six', () => {
    const derived = buildDerivedLevel(CHATS, {
      components: [
        { id: 'module:a', kind: 'module' },
        { id: 'endpoint:GET /x', kind: 'endpoint' },
        { id: 'integration:stripe', kind: 'integration' },
        { id: 'datastore:db', kind: 'datastore' },
        { id: 'project:root', kind: 'project' },
      ],
      edges: [],
    })
    for (const node of derived?.level.nodes ?? []) {
      expect(DERIVED_NODE_KINDS as readonly string[]).toContain(node.kind)
    }
  })

  it('never invents a seventh kind — an unknown one lands on `module`', () => {
    expect(derivedNodeKind('feature:chats', 'feature')).toBe('module')
    expect(derivedNodeKind('weird', 'component')).toBe('module')
    // The id's own prefix answers when the map says nothing.
    expect(derivedNodeKind('endpoint:POST /api/chat')).toBe('endpoint')
    expect(derivedNodeKind('datastore:chat.sqlite', '   ')).toBe('datastore')
    expect(derivedNodeKind('nocolon')).toBe('module')
  })

  it('always gives a card a readable title', () => {
    expect(derivedTitle('module:app/src/main/chat')).toBe('chat')
    expect(derivedTitle('module:app/src/main/chat', 'Chat manager')).toBe('Chat manager')
    expect(derivedTitle('module:app/src/main/chat', '   ')).toBe('chat')
    expect(derivedTitle('bare')).toBe('bare')
  })

  it('collapses a repeated component id rather than drawing it twice', () => {
    const derived = buildDerivedLevel(CHATS, {
      components: [{ id: 'module:a', label: 'first' }, { id: 'module:a', label: 'second' }],
      edges: [],
    })
    expect(derived?.level.nodes).toHaveLength(1)
    expect(derived?.level.nodes[0].title).toBe('first')
  })

  it('refuses to build a level out of nothing', () => {
    expect(buildDerivedLevel(CHATS, { components: [], edges: [] })).toBeNull()
    expect(buildDerivedLevel(CHATS, { components: [{ id: '  ' }], edges: [] })).toBeNull()
  })

  it('names itself after the node, falling back to the id', () => {
    const nameless = buildDerivedLevel({ id: 'feature:x', name: '  ' }, structure())
    expect(nameless?.level.title).toBe('feature:x')
    expect(nameless?.view.meta.title).toBe('feature:x')
  })

  it('hands the level to the resolution when structure comes with the source', () => {
    const resolution = resolveLevel(feature, source({ view: null, structuralCount: 4, structure: structure() }))
    expect(resolution.verdict).toBe('derived')
    expect(resolution.derived).not.toBeNull()
    expect(resolution.derived?.level.nodes).toHaveLength(4)
    // The curated slots stay empty — this is not a curated view, and the board
    // must not mistake it for one.
    expect(resolution.view).toBeNull()
    expect(resolution.level).toBeNull()
  })

  it('builds a derived level PAST an unusable curated artifact', () => {
    const hollow = curated({ views: { root: level({ nodes: [] }) } })
    const resolution = resolveLevel(feature, source({ view: hollow, structuralCount: 4, structure: structure() }))
    expect(resolution.verdict).toBe('derived')
    expect(resolution.derived?.componentCount).toBe(4)
  })

  it('never builds one for a verdict that is not derived', () => {
    const withCurated = resolveLevel(feature, source({ view: curated(), structuralCount: 4, structure: structure() }))
    expect(withCurated.verdict).toBe('curated')
    expect(withCurated.derived).toBeNull()
    const empty = resolveLevel(feature, source({ structuralCount: 0, structure: structure() }))
    expect(empty.verdict).toBe('empty')
    expect(empty.derived).toBeNull()
  })
})

describe('parallel relations are merged, not overprinted (Task 6.2)', () => {
  it('merges every relation between one directed pair into one connection', () => {
    // MEASURED: 120 of this repo's 206 directed pairs carry more than one
    // relation. Drawn separately they land at the same midpoint and print
    // through one another — the prototype rendered the literal string
    // `icallss` for an `imports` + `calls` pair.
    const wires = mergeStructuralEdges(
      [{ id: 'a' }, { id: 'b' }],
      [rel('a', 'b', 'imports'), rel('a', 'b', 'calls')],
    )
    expect(wires).toHaveLength(1)
    expect(wires[0].label).toBe('imports · calls')
    expect(wires[0].relations).toEqual(['imports', 'calls'])
    expect(wires[0].weight).toBe(2)
  })

  it('keeps the opposite direction as its own connection', () => {
    // A reverse edge routes under the row in the curated layout, so it has its
    // own geometry and its own meaning. Collapsing it would throw away the
    // direction to fix a collision that is not there.
    const wires = mergeStructuralEdges(
      [{ id: 'a' }, { id: 'b' }],
      [rel('a', 'b', 'imports'), rel('b', 'a', 'calls')],
    )
    expect(wires).toHaveLength(2)
  })

  it('counts a repeated relation as weight without repeating the word', () => {
    const wires = mergeStructuralEdges(
      [{ id: 'a' }, { id: 'b' }],
      [rel('a', 'b', 'imports'), rel('a', 'b', 'imports'), rel('a', 'b', 'calls')],
    )
    expect(wires[0].label).toBe('imports · calls')
    expect(wires[0].weight).toBe(3)
  })

  it('drops a connection with an end that is not on the level', () => {
    // Same rule the brief scope already applies: a wire to something off
    // screen asserts a relationship the reader cannot check.
    const wires = mergeStructuralEdges([{ id: 'a' }], [rel('a', 'ghost', 'imports')])
    expect(wires).toEqual([])
  })

  it('drops a self-edge and a blank relation', () => {
    const wires = mergeStructuralEdges(
      [{ id: 'a' }, { id: 'b' }],
      [rel('a', 'a', 'imports'), rel('a', 'b', '   ')],
    )
    expect(wires).toEqual([])
  })

  it('merges the real vocabulary the code map uses', () => {
    const derived = buildDerivedLevel(CHATS, structure())
    const merged = derived?.level.edges.find(
      (edge) => edge.from === 'module:app/src/main' && edge.to === 'module:app/src/main/chat',
    )
    expect(merged?.label).toBe('contains · imports')
    expect(derived?.level.edges).toHaveLength(3)
  })
})

describe('edges are weighted, pruned, and the remainder REPORTED (Task 6.3)', () => {
  const heavy = [
    { from: 'a', to: 'b', relations: ['imports', 'calls'], label: 'imports · calls', weight: 2 },
    { from: 'a', to: 'c', relations: ['imports'], label: 'imports', weight: 1 },
    { from: 'a', to: 'd', relations: ['imports', 'calls', 'uses'], label: 'x', weight: 3 },
    { from: 'a', to: 'e', relations: ['imports'], label: 'imports', weight: 1 },
  ]

  it('keeps the connections most backed by real code', () => {
    const { kept } = pruneWires(heavy, 2)
    expect(kept.map((wire) => wire.to)).toEqual(['d', 'b'])
  })

  it('reports what it hid, in pairs AND in the code edges behind them', () => {
    const { hidden } = pruneWires(heavy, 2)
    expect(hidden.pairs).toBe(2)
    expect(hidden.relations).toBe(2)
  })

  it('breaks ties deterministically so the picture does not reshuffle', () => {
    const once = pruneWires(heavy, 3).kept.map((wire) => wire.to)
    const twice = pruneWires([...heavy].reverse(), 3).kept.map((wire) => wire.to)
    expect(once).toEqual(twice)
    expect(once).toEqual(['d', 'b', 'c'])
  })

  it('hides nothing when everything fits', () => {
    expect(pruneWires(heavy, 10).hidden).toEqual({ pairs: 0, relations: 0 })
    expect(pruneWires([], 10).kept).toEqual([])
  })

  it('refuses a cap that would erase the diagram', () => {
    // A level with every wire removed and a note saying so is worse than one
    // that obeys its documented default.
    for (const nonsense of [0, -3, 1.5, Number.NaN]) {
      expect(pruneWires(heavy, nonsense).kept).toHaveLength(4)
    }
  })

  it('applies the documented cap by default', () => {
    const many = Array.from({ length: DERIVED_EDGE_CAP + 7 }, (_unused, index) => ({
      from: 'hub',
      to: `n${String(index).padStart(2, '0')}`,
      relations: ['imports'],
      label: 'imports',
      weight: 1,
    }))
    const { kept, hidden } = pruneWires(many)
    expect(kept).toHaveLength(DERIVED_EDGE_CAP)
    expect(hidden.pairs).toBe(7)
  })

  it('writes the hidden count into the level the reader actually sees', () => {
    // NO SILENT TRUNCATION. The cap's cut has to reach the surface, not just
    // the return value.
    const components = Array.from({ length: 30 }, (_unused, index) => ({ id: `module:n${String(index)}` }))
    const edges = components
      .slice(1)
      .map((component) => rel('module:n0', component.id, 'imports'))
    const derived = buildDerivedLevel(CHATS, { components, edges })
    expect(derived?.totalPairs).toBe(29)
    expect(derived?.level.edges).toHaveLength(DERIVED_EDGE_CAP)
    expect(derived?.hidden.pairs).toBe(29 - DERIVED_EDGE_CAP)
    expect(derived?.notice).toContain(`${String(29 - DERIVED_EDGE_CAP)} weaker connections hidden`)
    expect(derived?.level.summary).toBe(derived?.notice)
  })

  it('says nothing about hiding when nothing was hidden', () => {
    const derived = buildDerivedLevel(CHATS, structure())
    expect(derived?.hidden).toEqual({ pairs: 0, relations: 0 })
    expect(derived?.notice).not.toContain('hidden')
  })

  it('honours an explicit cap and reports against it', () => {
    const derived = buildDerivedLevel(CHATS, structure({ cap: 1 }))
    expect(derived?.cap).toBe(1)
    expect(derived?.level.edges).toHaveLength(1)
    expect(derived?.hidden.pairs).toBe(2)
    expect(derived?.backingEdges).toBe(2) // the surviving pair carries two code edges
  })

  it('carries the hidden count into the resolution reason as well', () => {
    const resolution = resolveLevel(
      feature,
      source({ structuralCount: 4, structure: structure({ cap: 1 }) }),
    )
    expect(resolution.reason).toContain('2 weaker connections hidden')
  })

  it('leaves the reason clean when the cap hid nothing', () => {
    const resolution = resolveLevel(feature, source({ structuralCount: 4, structure: structure() }))
    expect(resolution.reason).not.toContain('hidden')
  })
})

describe('a derived level never claims validator status (Task 6.5)', () => {
  it('says outright that nothing validated it', () => {
    // THE PROTOTYPE'S BUG, in reverse: it rendered "fails the real validator"
    // on a synthesised level no validator had ever seen. A level cannot pass
    // or fail a check that was never run on it.
    const derived = buildDerivedLevel(CHATS, structure())
    expect(derived?.validated).toBe(false)
    expect(derived?.provenance).toBe('derived')
  })

  it('never wears a plan name or a generation date', () => {
    const derived = buildDerivedLevel(CHATS, structure())
    expect(derived?.view.provenance).toBe('derived')
    expect(derived?.view.provenance.startsWith('plan')).toBe(false)
    // Nothing generated it, so there is no date to print.
    expect(derived?.view.generatedAt).toBe('')
  })

  it('supplies no authored claim for the chrome to band', () => {
    // `buildCuratedChrome` renders a band only from `problem` / `unchanged`.
    // Supplying neither is what keeps the derived level out of a box headed
    // KNOWN ISSUE (Task 6.4).
    const derived = buildDerivedLevel(CHATS, structure())
    expect(derived?.view.brief).toEqual({})
  })

  it('says in the reader’s own words what it is and is not', () => {
    const derived = buildDerivedLevel(CHATS, structure())
    expect(derived?.level.kicker).toContain('Derived')
    expect(derived?.notice).toContain('not what the feature does')
    expect(derived?.notice).toContain('nothing here was validated')
  })

  it('tells a derived view apart from a curated one', () => {
    const derived = buildDerivedLevel(CHATS, structure())
    expect(isDerivedView(derived?.view ?? null)).toBe(true)
    expect(isDerivedView(curated())).toBe(false)
    expect(isDerivedView(null)).toBe(false)
  })

  it('keeps the resolution’s curated slots empty for a derived verdict', () => {
    // A derived level travelling in `view`/`level` would be indistinguishable
    // from a curated one at every later read.
    const resolution = resolveLevel(feature, source({ structuralCount: 4, structure: structure() }))
    expect(resolution.view).toBeNull()
    expect(resolution.level).toBeNull()
    expect(resolution.derived?.validated).toBe(false)
  })
})

// ── A PART'S LEVEL (plan_feature-parts-as-nodes_v1, Phase 3) ─────────────────

describe('a part resolves against its owner (Task 3.1)', () => {
  const part: LevelTarget = {
    id: 'feature:chats/sse-events-endpoint',
    kind: 'part',
    name: 'SSE events endpoint',
    depth: 2,
  }

  const ownerLevel = (): CuratedLevel => ({
    title: 'Chats',
    nodes: [
      { id: 'sseEvents', kind: 'endpoint', title: 'SSE events endpoint', delta: 'stable' },
      { id: 'chatUi', kind: 'module', title: 'Chat UI', delta: 'stable' },
      { id: 'bffStream', kind: 'endpoint', title: 'Gateway BFF stream', delta: 'stable' },
    ],
    edges: [
      { from: 'sseEvents', to: 'chatUi', label: 'SSE tokens', delta: 'kept' },
      { from: 'chatUi', to: 'bffStream', label: 'POST', delta: 'kept' },
    ],
  })

  const ownerView = (): CuratedView => curated({ views: { root: ownerLevel() } })

  const record = (partial: Record<string, unknown> = {}): Record<string, unknown> => ({
    name: 'SSE events endpoint',
    summary: 'Streams tokens to the browser',
    anchors: ['src/app/api/chat/[chatId]/events/route.ts'],
    learnings: [],
    ...partial,
  })

  const owner = (partial: Partial<LevelPartSource> = {}): LevelPartSource => ({
    ownerId: 'feature:chats',
    ownerName: 'Chats',
    parts: [record()],
    ...partial,
  })

  it('takes the curated SLICE when the owner’s view names the part', () => {
    const resolution = resolveLevel(part, source({ view: ownerView(), part: owner() }))
    expect(resolution.verdict).toBe('curated')
    expect(resolution.part?.source).toBe('curated')
    expect(resolution.part?.component?.id).toBe('sseEvents')
    expect(resolution.part?.level.nodes.map((node) => node.id)).toEqual(['sseEvents', 'chatUi'])
    expect(levelOpens(resolution)).toBe(true)
  })

  it('never lets a slice travel in the feature’s curated slots', () => {
    // `view`/`level` mean "this node's curated artifact". A part's slice is a
    // cut of somebody else's, so it rides on `part` and nowhere else.
    const resolution = resolveLevel(part, source({ view: ownerView(), part: owner() }))
    expect(resolution.view).toBeNull()
    expect(resolution.level).toBeNull()
    expect(resolution.derived).toBeNull()
  })

  it('falls to the part’s OWN anchors when no component carries its name', () => {
    const resolution = resolveLevel(
      part,
      source({
        view: ownerView(),
        part: owner({ parts: [record({ name: 'SSE events endpoint', anchors: ['a/b.ts'] })] }),
      }),
    )
    expect(resolution.verdict).toBe('curated')
    const unnamed = resolveLevel(
      { ...part, name: 'Chat control API' },
      source({
        view: ownerView(),
        part: owner({ parts: [record({ name: 'Chat control API', anchors: ['a/b.ts'] })] }),
      }),
    )
    expect(unnamed.verdict).toBe('derived')
    expect(unnamed.part?.source).toBe('anchors')
    expect(unnamed.reason).toContain('no component named ‘Chat control API’'.replace(/[‘’]/g, "'"))
    expect(unnamed.reason).toContain('showing the 1 file')
  })

  it('says the owner has no view at all, rather than blaming the part', () => {
    const resolution = resolveLevel(part, source({ view: null, part: owner() }))
    expect(resolution.verdict).toBe('derived')
    expect(resolution.reason).toContain('Chats has no curated view to slice')
    expect(resolution.reason).toContain("showing the 1 file 'SSE events endpoint' anchors")
  })

  it('repeats the CLI’s refusal, verbatim, for a part that anchors nothing', () => {
    const resolution = resolveLevel(
      part,
      source({ view: null, part: owner({ parts: [record({ anchors: [] })] }) }),
    )
    expect(resolution.verdict).toBe('empty')
    expect(resolution.reason).toContain(partNoAnchorRefusal('SSE events endpoint'))
    expect(resolution.reason).not.toBe('')
    expect(levelOpens(resolution)).toBe(false)
  })

  it('tells a stale ring node apart from a feature whose parts were never written', () => {
    const gone = resolveLevel(
      part,
      source({ view: ownerView(), part: owner({ parts: [record({ name: 'Queue stream bus' })] }) }),
    )
    expect(gone.verdict).toBe('empty')
    expect(gone.reason).toContain('lists no part called')
    expect(gone.reason).toContain('1 other part')

    const never = resolveLevel(part, source({ view: ownerView(), part: owner({ parts: [] }) }))
    expect(never.reason).toContain('Chats has no parts recorded')
  })

  it('refuses to answer for a part whose owner was never read', () => {
    const resolution = resolveLevel(part, source({ view: ownerView(), structuralCount: 9 }))
    expect(resolution.verdict).toBe('empty')
    expect(resolution.reason).toContain('the feature that owns it was not read')
    // The owner's OWN curated view must never be handed to a part as its level.
    expect(resolution.view).toBeNull()
    expect(resolution.part).toBeNull()
  })

  it('keeps the unavailable-brief sentence ahead of every part branch', () => {
    const resolution = resolveLevel(
      part,
      source({ available: false, reason: 'bundled CLI unavailable', part: owner() }),
    )
    expect(resolution.verdict).toBe('empty')
    expect(resolution.reason).toContain('bundled CLI unavailable')
  })

  it('carries the depth the control was pressed at, like every other target', () => {
    const resolution = resolveLevel(part, source({ view: ownerView(), part: owner() }))
    expect(resolution.returnDepth).toBe(2)
  })

  it('never produces a blank reason on any part branch', () => {
    const branches = [
      resolveLevel(part, source({ view: ownerView(), part: owner() })),
      resolveLevel(part, source({ view: null, part: owner() })),
      resolveLevel(part, source({ view: null, part: owner({ parts: [record({ anchors: [] })] }) })),
      resolveLevel(part, source({ view: ownerView(), part: owner({ parts: [] }) })),
      resolveLevel(part, source({ view: ownerView() })),
      resolveLevel(part, source({ available: false, reason: null, part: owner() })),
    ]
    for (const resolution of branches) expect(resolution.reason.trim().length).toBeGreaterThan(0)
  })

  it('points an empty part level at the gesture that would actually fill it', () => {
    const resolution = resolveLevel(
      part,
      source({ view: null, part: owner({ parts: [record({ anchors: [] })] }) }),
    )
    const state = levelEmptyState(resolution)
    expect(state?.title).toBe('No level for SSE events endpoint')
    expect(state?.detail).toBe(resolution.reason)
    expect(state?.hint).toContain('understanding the feature writes both')
    // NOT the feature's hint — archiving a plan writes no part.
    expect(state?.hint).not.toContain('archived')
  })
})

describe('the derived level draws the connections a document DECLARED (2026-09-30)', () => {
  // A discovery predicting parts that do not exist: the code map has no edges
  // for them, so the view was a grid of islands. Its Story's flow_after is the
  // only account of how they connect.
  const lone = structure({ edges: [] })

  it('adds a declared wire between two components as `added`, labelled as declared', () => {
    const derived = buildDerivedLevel(CHATS, {
      ...lone,
      declared: [{ from: 'module:app/src/main/chat', to: 'datastore:chat.sqlite', label: 'writes' }],
    })
    expect(derived?.level.edges).toEqual([
      { from: 'module:app/src/main/chat', to: 'datastore:chat.sqlite', label: 'writes', delta: 'added' },
    ])
    // The count says which kind of connection this is, never "0 connections" over an arrow.
    expect(derived?.level.summary).toContain('wired by 0 connections, plus 1 predicted connection the document declares')
  })

  it('keeps the code edge when the code map already connects the pair, in either direction', () => {
    const derived = buildDerivedLevel(CHATS, {
      ...structure(),
      declared: [{ from: 'datastore:chat.sqlite', to: 'module:app/src/main/chat', label: 'reads' }],
    })
    expect(derived?.level.edges.every((edge) => edge.delta === 'kept')).toBe(true)
  })

  it('ignores a declared wire whose end is not on the level', () => {
    const derived = buildDerivedLevel(CHATS, {
      ...lone,
      declared: [{ from: 'module:app/src/main/chat', to: 'integration:elsewhere', label: 'x' }],
    })
    expect(derived?.level.edges).toEqual([])
  })
})
