import { buildCuratedDrawer, type PartKnowledge } from './curated-drawer'
import type { CuratedLevel, CuratedNode } from './curated-view'
import {
  ANCHOR_EDGE_LABEL,
  PART_PROVENANCE,
  anchorCardId,
  buildPartLevel,
  componentNeighbours,
  findPartOwner,
  findPartRecord,
  matchCuratedComponent,
  partAnchorStatus,
  partCardId,
  partEmptyReason,
  readPartRecords,
  splitPartLearnings,
} from './part-level'
import { partNoAnchorRefusal } from './understand-action'

function node(partial: Partial<CuratedNode> & { id: string; title: string }): CuratedNode {
  return { kind: 'module', delta: 'stable', ...partial }
}

/** The shape of the live orbit-app `chats` view, trimmed to what matters. */
function ownerLevel(): CuratedLevel {
  return {
    title: 'Chats',
    nodes: [
      node({ id: 'chatUi', title: 'Chat UI', sub: 'ChatPanel / ChatPanelWrapper' }),
      node({ id: 'bffStream', title: 'Gateway BFF stream', kind: 'endpoint' }),
      node({ id: 'sseEvents', title: 'SSE events endpoint', kind: 'endpoint' }),
      node({ id: 'redis', title: 'Queue stream bus', kind: 'datastore' }),
      node({ id: 'history', title: 'History store', kind: 'datastore' }),
    ],
    edges: [
      { from: 'chatUi', to: 'bffStream', label: 'POST /api/chat/stream', delta: 'kept' },
      { from: 'sseEvents', to: 'chatUi', label: 'SSE tokens', delta: 'kept' },
      { from: 'redis', to: 'sseEvents', label: 'subscribe', delta: 'kept' },
      { from: 'bffStream', to: 'history', label: 'write USER', delta: 'kept' },
    ],
  }
}

function part(partial: Partial<PartKnowledge> = {}): PartKnowledge {
  return {
    name: 'SSE events endpoint',
    summary: 'Streams tokens to the browser',
    anchors: ['src/app/api/chat/[chatId]/events/route.ts'],
    learnings: [],
    ...partial,
  }
}

const owner = { id: 'feature:chats', name: 'Chats' }

describe('reading the brief’s parts array (Task 3.2)', () => {
  it('narrows the IPC record shape and keeps every named part', () => {
    const parts = readPartRecords([
      {
        name: 'SSE events endpoint',
        summary: 'Streams tokens',
        anchors: ['a.ts', 'b.ts'],
        learnings: [{ text: 'It fans out', provenance: 'code', date: '2026-08-01' }],
      },
      { name: 'Nameless learnings', anchors: [], learnings: [] },
    ])
    expect(parts).toHaveLength(2)
    expect(parts[0].anchors).toEqual(['a.ts', 'b.ts'])
    expect(parts[0].learnings[0].text).toBe('It fans out')
    // A part with a name and nothing else is still a part — one nobody learned.
    expect(parts[1].summary).toBe('')
  })

  it('drops entries that are not parts, and never throws on rubbish', () => {
    expect(readPartRecords(null)).toEqual([])
    expect(readPartRecords('parts')).toEqual([])
    expect(readPartRecords([1, null, [], { name: '  ' }, { summary: 'no name' }])).toEqual([])
  })

  it('keeps a learning’s superseded reason so it can be told from a current one', () => {
    const parts = readPartRecords([
      {
        name: 'p',
        learnings: [
          { text: 'old', supersededReason: 'rewritten' },
          { text: 'new' },
          { text: '   ' },
        ],
      },
    ])
    expect(parts[0].learnings.map((entry) => entry.text)).toEqual(['old', 'new'])
    expect(parts[0].learnings[0].supersededReason).toBe('rewritten')
    expect(parts[0].learnings[1].supersededReason).toBeUndefined()
  })

  it('finds a part by its trimmed name, and refuses a blank one', () => {
    const parts = [part(), part({ name: 'Queue stream bus' })]
    expect(findPartRecord(parts, ' SSE events endpoint ')?.name).toBe('SSE events endpoint')
    expect(findPartRecord(parts, 'Nothing')).toBeNull()
    expect(findPartRecord(parts, '  ')).toBeNull()
  })
})

describe('one name, one identity (Task 3.2)', () => {
  it('matches a part to its curated component on the drawer’s own key', () => {
    expect(matchCuratedComponent(ownerLevel(), 'SSE events endpoint')?.id).toBe('sseEvents')
    expect(matchCuratedComponent(ownerLevel(), 'Nothing named this')).toBeNull()
    expect(matchCuratedComponent(null, 'SSE events endpoint')).toBeNull()
  })

  it('agrees with buildCuratedDrawer — the two matchers cannot drift apart', () => {
    const parts = [part(), part({ name: 'Queue stream bus', anchors: [] })]
    for (const component of ownerLevel().nodes) {
      const drawer = buildCuratedDrawer(component, { parts })
      const matched = parts.find(
        (record) => matchCuratedComponent(ownerLevel(), record.name)?.id === component.id,
      )
      expect(drawer.learned?.name ?? null).toBe(matched?.name ?? null)
    }
  })

  it('matches on the raw title, not the split headline', () => {
    const level: CuratedLevel = {
      title: 'Chats',
      nodes: [node({ id: 'bff', title: 'Gateway BFF · streamTurn' })],
      edges: [],
    }
    expect(matchCuratedComponent(level, 'Gateway BFF · streamTurn')?.id).toBe('bff')
    expect(matchCuratedComponent(level, 'Gateway BFF')).toBeNull()
  })
})

describe('learnings and anchors (Task 3.2)', () => {
  it('splits current learnings from the ones a later pass replaced', () => {
    const record = part({
      learnings: [
        { text: 'standing', provenance: 'code', date: '2026-08-01' },
        { text: 'replaced', provenance: 'code', date: '2026-07-01', supersededReason: 'redrawn' },
      ],
    })
    const split = splitPartLearnings(record)
    expect(split.current.map((entry) => entry.text)).toEqual(['standing'])
    expect(split.superseded.map((entry) => entry.text)).toEqual(['replaced'])
  })

  it('resolves a part’s file anchor by containment in the owner’s resolved directory', () => {
    const status = partAnchorStatus(
      ['src/app/api/chat/[chatId]/events/route.ts', 'src/nowhere/thing.ts'],
      [
        { ref: 'module:src/app/api/chat', resolved: true },
        { ref: 'module:src/nowhere', resolved: false },
      ],
    )
    expect(status).toEqual([
      { ref: 'src/app/api/chat/[chatId]/events/route.ts', resolved: true },
      { ref: 'src/nowhere/thing.ts', resolved: false },
    ])
  })

  it('never claims resolution on a prefix that is not a directory boundary', () => {
    const status = partAnchorStatus(
      ['src/app/api/chatty/route.ts'],
      [{ ref: 'module:src/app/api/chat', resolved: true }],
    )
    expect(status[0].resolved).toBe(false)
  })

  it('says nothing resolved when the owner supplied no anchors', () => {
    expect(partAnchorStatus(['a.ts'])).toEqual([{ ref: 'a.ts', resolved: false }])
  })
})

describe('the curated slice (Task 3.2)', () => {
  it('draws the part’s component and everything it is wired to, in both directions', () => {
    const built = buildPartLevel({ part: part(), owner, ownerLevel: ownerLevel() })
    expect(built).not.toBeNull()
    expect(built?.source).toBe('curated')
    expect(built?.component?.id).toBe('sseEvents')
    // `sseEvents → chatUi` and `redis → sseEvents` — one out, one in.
    expect(built?.neighbours.map((n) => n.id)).toEqual(['chatUi', 'redis'])
    expect(built?.level.nodes.map((n) => n.id)).toEqual(['sseEvents', 'chatUi', 'redis'])
    expect(built?.level.edges.map((e) => e.label)).toEqual(['SSE tokens', 'subscribe'])
  })

  it('leaves out wires whose other end is not on the slice', () => {
    const built = buildPartLevel({ part: part(), owner, ownerLevel: ownerLevel() })
    const drawn = built?.level.edges.map((edge) => `${edge.from}->${edge.to}`) ?? []
    expect(drawn).not.toContain('chatUi->bffStream')
    expect(drawn).not.toContain('bffStream->history')
  })

  it('names the owner in the kicker so a slice cannot read as a whole view', () => {
    const built = buildPartLevel({ part: part(), owner, ownerLevel: ownerLevel() })
    expect(built?.level.kicker).toBe('Part of Chats · its slice of the curated view')
    expect(built?.level.title).toBe('SSE events endpoint')
  })

  it('finds the component even when the part anchors nothing', () => {
    const built = buildPartLevel({
      part: part({ anchors: [] }),
      owner,
      ownerLevel: ownerLevel(),
    })
    expect(built?.source).toBe('curated')
    expect(built?.anchors).toEqual([])
  })

  it('reports isolated components honestly rather than inventing a neighbour', () => {
    const built = buildPartLevel({
      part: part({ name: 'History store', anchors: [] }),
      owner,
      ownerLevel: {
        ...ownerLevel(),
        edges: [],
      },
    })
    expect(built?.neighbours).toEqual([])
    expect(built?.notice).toContain('0 components it connects to')
  })
})

describe('the files it names (Task 3.2)', () => {
  const noView = { part: part({ anchors: ['a/b/route.ts', 'a/c/bus.ts'] }), owner, ownerLevel: null }

  it('falls back to the part’s own anchors when no component carries its name', () => {
    const built = buildPartLevel(noView)
    expect(built?.source).toBe('anchors')
    expect(built?.component).toBeNull()
    expect(built?.level.nodes.map((n) => n.id)).toEqual([
      partCardId('SSE events endpoint'),
      anchorCardId('a/b/route.ts'),
      anchorCardId('a/c/bus.ts'),
    ])
    expect(built?.level.nodes.map((n) => n.title)).toEqual([
      'SSE events endpoint',
      'route.ts',
      'bus.ts',
    ])
  })

  it('hangs each file off the part with a relation that is literally true', () => {
    const built = buildPartLevel(noView)
    expect(built?.level.edges).toHaveLength(2)
    expect(built?.level.edges.every((edge) => edge.label === ANCHOR_EDGE_LABEL)).toBe(true)
    expect(built?.level.edges[0].from).toBe(partCardId('SSE events endpoint'))
  })

  it('falls back to anchors when the owner HAS a view but nothing in it is this part', () => {
    const built = buildPartLevel({
      part: part({ name: 'Chat control API', anchors: ['src/app/api/chat/stop/route.ts'] }),
      owner,
      ownerLevel: ownerLevel(),
    })
    expect(built?.source).toBe('anchors')
    expect(built?.level.kicker).toBe('Part of Chats · the files it names, not a curated view')
  })

  it('keeps the full path as the card’s second line so a basename is never ambiguous', () => {
    const built = buildPartLevel({
      part: part({ anchors: ['src/a/route.ts', 'src/b/route.ts'] }),
      owner,
      ownerLevel: null,
    })
    expect(built?.level.nodes.slice(1).map((n) => n.sub)).toEqual([
      'src/a/route.ts',
      'src/b/route.ts',
    ])
  })
})

describe('nothing to draw (Task 3.2)', () => {
  it('returns null when the part has neither a component nor an anchor', () => {
    expect(buildPartLevel({ part: part({ anchors: [] }), owner, ownerLevel: null })).toBeNull()
    expect(
      buildPartLevel({
        part: part({ name: 'Unknown piece', anchors: [] }),
        owner,
        ownerLevel: ownerLevel(),
      }),
    ).toBeNull()
  })

  it('explains it with the CLI’s own refusal, verbatim', () => {
    const record = part({ anchors: [] })
    expect(partEmptyReason(record, owner, true)).toContain(partNoAnchorRefusal(record.name))
    expect(partEmptyReason(record, owner, true)).toContain('no component in Chats’ curated view')
    expect(partEmptyReason(record, owner, false)).toContain('has no curated view')
  })
})

describe('the level is artifact-shaped and says it is not an artifact', () => {
  it('never claims a plan wrote it, and never claims validation', () => {
    const built = buildPartLevel({ part: part(), owner, ownerLevel: ownerLevel() })
    expect(built?.view.provenance).toBe(PART_PROVENANCE)
    expect(built?.view.generatedAt).toBe('')
    expect(built?.validated).toBe(false)
    // No band is synthesised out of the part's prose.
    expect(built?.view.brief).toEqual({})
  })

  it('puts the notice where the chrome reads it, and counts superseded learnings', () => {
    const built = buildPartLevel({
      part: part({
        learnings: [
          { text: 'standing', provenance: 'code', date: '2026-08-01' },
          { text: 'gone', provenance: 'code', date: '2026-07-01', supersededReason: 'redrawn' },
        ],
      }),
      owner,
      ownerLevel: ownerLevel(),
    })
    expect(built?.level.summary).toBe(built?.notice)
    expect(built?.notice).toContain('1 learning recorded')
    expect(built?.notice).toContain('1 earlier learning superseded')
    expect(built?.supersededCount).toBe(1)
  })

  it('says so plainly when nothing has been learned about the part', () => {
    const built = buildPartLevel({ part: part(), owner, ownerLevel: ownerLevel() })
    expect(built?.notice).toContain('Nothing has been learned about this part yet')
  })
})

describe('finding a part’s owner (Task 3.4 wiring input)', () => {
  const nodes = [
    { id: 'feature:chats', slug: 'chats', name: 'Chats', kind: 'core' },
    {
      id: 'feature:chats/sse-events-endpoint',
      name: 'SSE events endpoint',
      kind: 'part',
      parent: 'feature:chats',
      partOf: 'chats',
    },
  ]

  it('reads the owner off the part’s parent link', () => {
    expect(findPartOwner(nodes, 'feature:chats/sse-events-endpoint')).toEqual({
      id: 'feature:chats',
      name: 'Chats',
    })
  })

  it('falls back to the partOf slug when the parent link is absent', () => {
    const orphanParent = [
      nodes[0],
      { id: 'p', name: 'SSE events endpoint', kind: 'part', partOf: 'chats' },
    ]
    expect(findPartOwner(orphanParent, 'p')?.id).toBe('feature:chats')
  })

  it('returns null rather than guessing a name for a link that points nowhere', () => {
    expect(findPartOwner(nodes, 'feature:nope')).toBeNull()
    expect(
      findPartOwner([{ id: 'p', name: 'X', kind: 'part', parent: 'feature:gone' }], 'p'),
    ).toBeNull()
  })
})

describe('componentNeighbours', () => {
  it('ignores direction and never includes the component itself', () => {
    const level: CuratedLevel = {
      title: 't',
      nodes: [node({ id: 'a', title: 'A' }), node({ id: 'b', title: 'B' })],
      edges: [
        { from: 'a', to: 'a', label: 'self', delta: 'kept' },
        { from: 'b', to: 'a', label: 'in', delta: 'kept' },
      ],
    }
    expect(componentNeighbours(level, 'a').map((n) => n.id)).toEqual(['b'])
  })
})
