import {
  IN_FLIGHT_CLASS,
  IN_FLIGHT_CLASSES,
  inFlightMarks,
  inFlightSentence,
  learnDotClass,
} from './learn-inflight'
import type { FeatureGraphInput } from './feature-view-model'

/**
 * A store with a real domain layer: two domains, three features, one PART and
 * one CHANGE record — the two things that used to share the word "part" and are
 * now different kinds with different rules.
 */
const GRAPH: FeatureGraphInput = {
  nodes: [
    {
      id: 'feature:chats',
      slug: 'chats',
      name: 'Chats',
      kind: 'core',
      domain: 'Conversation',
      understanding: 'learned',
      active: false,
      anchorCount: 3,
    },
    {
      id: 'feature:threads',
      slug: 'threads',
      name: 'Threads',
      kind: 'core',
      domain: 'Conversation',
      understanding: 'none',
      active: false,
      anchorCount: 1,
    },
    {
      id: 'feature:board',
      slug: 'board',
      name: 'Board',
      kind: 'core',
      domain: 'Map',
      understanding: 'stale',
      active: false,
      anchorCount: 2,
    },
    {
      id: 'feature:chats/sse-events-endpoint',
      slug: 'sse-events-endpoint',
      name: 'SSE events endpoint',
      kind: 'part',
      parent: 'feature:chats',
      partOf: 'chats',
      understanding: 'none',
      active: false,
      anchorCount: 2,
    },
    {
      id: 'feature:chat-engine',
      slug: 'chat-engine',
      name: 'Chat Engine',
      kind: 'child',
      parent: 'feature:chats',
      understanding: 'none',
      active: false,
      anchorCount: 1,
    },
  ],
  edges: [],
}

/** The same store with NO domain on any feature — `toFocusGraph` synthesises
 *  nothing there, so a core feature has no ancestor at all. */
const FLAT: FeatureGraphInput = {
  nodes: GRAPH.nodes.map(({ domain: _domain, ...rest }) => rest),
  edges: [],
}

describe('inFlightMarks', () => {
  it('marks nothing when no pass is running', () => {
    expect(inFlightMarks(GRAPH, null).size).toBe(0)
    expect(inFlightMarks(GRAPH, '   ').size).toBe(0)
  })

  it('marks the running feature itself', () => {
    expect(inFlightMarks(GRAPH, 'feature:chats').get('feature:chats')).toBe('self')
  })

  it('rolls the pass up to the running feature’s domain', () => {
    // THE HEART OF THE REQUEST: start a pass inside a domain, pop to the root,
    // and the domain hub still says something in there is working.
    const marks = inFlightMarks(GRAPH, 'feature:chats')
    expect(marks.get('domain:Conversation')).toBe('within')
    // …and says nothing about the domain the pass is NOT in.
    expect(marks.has('domain:Map')).toBe(false)
  })

  it('rolls a PART all the way up: its feature and that feature’s domain', () => {
    const marks = inFlightMarks(GRAPH, 'feature:chats/sse-events-endpoint')
    expect(marks.get('feature:chats/sse-events-endpoint')).toBe('self')
    expect(marks.get('feature:chats')).toBe('within')
    expect(marks.get('domain:Conversation')).toBe('within')
  })

  // A CHANGE RECORD IS OFF EVERY RING and is still in the graph for exactly
  // this: it has a parent, so anything walking upwards keeps working.
  it('rolls a change record up the same way', () => {
    const marks = inFlightMarks(GRAPH, 'feature:chat-engine')
    expect(marks.get('feature:chat-engine')).toBe('self')
    expect(marks.get('feature:chats')).toBe('within')
    expect(marks.get('domain:Conversation')).toBe('within')
  })

  it('never marks a sibling', () => {
    const marks = inFlightMarks(GRAPH, 'feature:chats')
    expect(marks.has('feature:threads')).toBe(false)
    expect(marks.has('feature:board')).toBe(false)
  })

  it('an ancestor is NEVER marked `self` — that would be a different claim', () => {
    const marks = inFlightMarks(GRAPH, 'feature:chat-engine')
    const selves = [...marks.entries()].filter(([, mark]) => mark === 'self')
    expect(selves).toEqual([['feature:chat-engine', 'self']])
  })

  it('follows toFocusGraph’s rule: no domains synthesised ⇒ no domain rollup', () => {
    const marks = inFlightMarks(FLAT, 'feature:chats')
    expect(marks.get('feature:chats')).toBe('self')
    // Its own part is marked (see below); no ANCESTOR is, because none exists.
    expect([...marks.keys()].filter((id) => id.startsWith('domain:'))).toEqual([])
    expect(marks.get('feature:threads')).toBeUndefined()
    // A part still rolls up to its feature — that parent is on the record.
    expect(inFlightMarks(FLAT, 'feature:chats/sse-events-endpoint').get('feature:chats')).toBe(
      'within',
    )
  })

  /**
   * THE PASS WRITES THE PARTS TOO. `understandFeature` draws the feature's view
   * and then walks every part through `writeParts`, so a part being learned is
   * not a claim about its parent — it is a fact about the part.
   *
   * Without this, drilling into a part DURING the pass that is learning it
   * showed a level insisting nothing was happening.
   */
  it('marks the running feature’s PARTS as being learned in their own right', () => {
    const marks = inFlightMarks(GRAPH, 'feature:chats')
    expect(marks.get('feature:chats/sse-events-endpoint')).toBe('self')
    // …and the dot follows, exactly as a module's does.
    expect(learnDotClass('none', marks.get('feature:chats/sse-events-endpoint'))).toBe(
      'fb-learn-learning',
    )
  })

  // A CHANGE RECORD IS NOT LEARNED BY ANYTHING. It is a plan or an issue that
  // once touched the feature; `learnFeatureParts` never writes to it, so a mark
  // saying it is being learned would be a claim about work nobody is doing.
  it('does NOT mark the running feature’s change records', () => {
    expect(inFlightMarks(GRAPH, 'feature:chats').has('feature:chat-engine')).toBe(false)
  })

  it('never marks another feature’s parts', () => {
    const marks = inFlightMarks(GRAPH, 'feature:threads')
    expect(marks.has('feature:chats/sse-events-endpoint')).toBe(false)
  })

  it('descends exactly ONE hop — a part is a leaf, so there is nowhere further', () => {
    const deep: FeatureGraphInput = {
      nodes: [
        ...GRAPH.nodes,
        {
          id: 'feature:chats/sse-events-endpoint/deeper',
          slug: 'deeper',
          name: 'Deeper',
          kind: 'part',
          parent: 'feature:chats/sse-events-endpoint',
          understanding: 'none',
          active: false,
          anchorCount: 0,
        },
      ],
      edges: [],
    }
    const marks = inFlightMarks(deep, 'feature:chats')
    expect(marks.get('feature:chats/sse-events-endpoint')).toBe('self')
    expect(marks.has('feature:chats/sse-events-endpoint/deeper')).toBe(false)
  })

  it('a part’s mark never overwrites an ancestor’s weaker claim', () => {
    // A malformed store naming a node both parent and child of the running one:
    // `within` is the safer sentence, so it survives.
    const tangled: FeatureGraphInput = {
      nodes: [
        { id: 'a', slug: 'a', name: 'A', kind: 'part', parent: 'b', understanding: 'none', active: false, anchorCount: 0 },
        { id: 'b', slug: 'b', name: 'B', kind: 'part', parent: 'a', understanding: 'none', active: false, anchorCount: 0 },
      ],
      edges: [],
    }
    expect(inFlightMarks(tangled, 'a').get('b')).toBe('within')
  })

  it('marks an unknown ref as `self` and claims nothing else', () => {
    // The graph is fetched asynchronously and can be older than the press.
    expect([...inFlightMarks(GRAPH, 'feature:ghost')]).toEqual([['feature:ghost', 'self']])
    expect([...inFlightMarks(null, 'feature:ghost')]).toEqual([['feature:ghost', 'self']])
  })

  it('terminates on a cyclic parent chain', () => {
    const cyclic: FeatureGraphInput = {
      nodes: [
        { id: 'a', slug: 'a', name: 'A', kind: 'child', parent: 'b', understanding: 'none', active: false, anchorCount: 0 },
        { id: 'b', slug: 'b', name: 'B', kind: 'child', parent: 'a', understanding: 'none', active: false, anchorCount: 0 },
      ],
      edges: [],
    }
    const marks = inFlightMarks(cyclic, 'a')
    expect(marks.get('a')).toBe('self')
    expect(marks.get('b')).toBe('within')
    expect(marks.size).toBe(2)
  })
})

describe('IN_FLIGHT_CLASS', () => {
  it('gives the two marks different classes', () => {
    expect(IN_FLIGHT_CLASS.self).not.toBe(IN_FLIGHT_CLASS.within)
    expect(new Set(IN_FLIGHT_CLASSES).size).toBe(2)
  })

  // THE MARKS LAND ON THE TERRITORY SHEET, so they are spelled in the sheet's
  // vocabulary. Pinned by name because the OTHER half of the pair lives in
  // `BOARD_STYLES` — two files that must be renamed together, and a test that
  // only compared them to each other would have let them drift apart silently.
  it('is spelled in the territory vocabulary the stylesheet matches', () => {
    expect(IN_FLIGHT_CLASS.self).toBe('fb-terr-inflight')
    expect(IN_FLIGHT_CLASS.within).toBe('fb-terr-inflight-within')
  })
})

describe('inFlightSentence', () => {
  it('says the node itself is being understood', () => {
    const said = inFlightSentence('self', 'Chats', 'Chats')
    expect(said).toContain('Understanding Chats')
    expect(said).toMatch(/several minutes/)
  })

  it('says CONTAINMENT for an ancestor, and names what is actually running', () => {
    const said = inFlightSentence('within', 'Chats', 'Conversation')
    expect(said).toContain('inside Conversation')
    expect(said).toContain('Chats')
    // The distinction the reader must not lose: the ancestor is not the subject.
    expect(said).not.toMatch(/^Understanding Conversation/)
  })

  it('a PART says it is being understood, and whose pass is doing it', () => {
    const said = inFlightSentence('self', 'Chats', 'SSE events endpoint')
    // The part is the subject — it IS being learned, not merely contained.
    expect(said).toMatch(/^Understanding SSE events endpoint/)
    // …but the pass has the feature's name, and that is the name a reader will
    // look for while waiting on it.
    expect(said).toContain('Chats')
    expect(said).toMatch(/several minutes/)
    // Never the containment sentence — a part is a leaf, nothing is inside it.
    expect(said).not.toContain('Something inside')
  })

  it('the two sentences are never the same text', () => {
    expect(inFlightSentence('self', 'Chats', 'Chats')).not.toBe(
      inFlightSentence('within', 'Chats', 'Chats'),
    )
  })
})

describe('learnDotClass', () => {
  it('reports `learning` for the running feature, whatever it used to be', () => {
    // A RE-RUN MUST NOT KEEP READING `learned`. The new read has not landed.
    expect(learnDotClass('learned', 'self')).toBe('fb-learn-learning')
    expect(learnDotClass('stale', 'self')).toBe('fb-learn-learning')
    expect(learnDotClass('none', 'self')).toBe('fb-learn-learning')
  })

  it('leaves an ancestor’s own understanding completely alone', () => {
    expect(learnDotClass('learned', 'within')).toBe('fb-learn-learned')
    expect(learnDotClass('stale', 'within')).toBe('fb-learn-stale')
  })

  it('is the stored value when nothing is running', () => {
    expect(learnDotClass('learned', undefined)).toBe('fb-learn-learned')
    expect(learnDotClass(null, undefined)).toBe('fb-learn-none')
  })

  it('never yields `learned` for a running feature', () => {
    for (const stored of ['none', 'learning', 'learned', 'stale', null]) {
      expect(learnDotClass(stored, 'self')).not.toBe('fb-learn-learned')
    }
  })
})
