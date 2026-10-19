import {
  relationCounts,
  relationHighlight,
  relationsOf,
  type RelationEdge,
} from './feature-relations'

const e = (from: string, to: string, stale = false): RelationEdge =>
  stale ? { from, to, stale } : { from, to }

describe('relationsOf', () => {
  const edges = [e('auth', 'tenant'), e('chats', 'spaces'), e('connectors', 'chats')]

  it('answers from BOTH ends — the store writes one edge per pair', () => {
    // `chats` never names `connectors`; `connectors` names `chats`. Reading one
    // direction only loses half the answers depending on who wrote whom down.
    expect(relationsOf('chats', edges).map((r) => r.id)).toEqual(['connectors', 'spaces'])
    expect(relationsOf('connectors', edges).map((r) => r.id)).toEqual(['chats'])
  })

  it('is empty for a feature nothing touches', () => {
    expect(relationsOf('lonely', edges)).toEqual([])
  })

  it('drops a self-edge rather than reporting it', () => {
    // A feature relating to itself is a store to fix, not a connection anyone
    // can act on.
    expect(relationsOf('auth', [e('auth', 'auth')])).toEqual([])
  })

  it('keeps the WORSE verdict when a pair is recorded twice', () => {
    // If either end says the mechanism moved, the reader needs to hear that
    // rather than the reassuring half.
    expect(relationsOf('auth', [e('auth', 'tenant'), e('tenant', 'auth', true)])).toEqual([
      { id: 'tenant', stale: true },
    ])
  })

  it('is deterministic — id order, whatever the edge order', () => {
    const shuffled = [e('a', 'z'), e('a', 'b'), e('a', 'm')]
    expect(relationsOf('a', shuffled).map((r) => r.id)).toEqual(['b', 'm', 'z'])
  })
})

describe('relationCounts', () => {
  it('counts what the hover would light, not edge endpoints', () => {
    const edges = [e('auth', 'tenant'), e('tenant', 'auth'), e('auth', 'chats')]
    // The duplicate pair is ONE relationship. Counting endpoints would say 3.
    expect(relationCounts(['auth', 'tenant', 'chats'], edges).get('auth')).toBe(2)
    expect(relationCounts(['auth'], edges).get('auth')).toBe(relationsOf('auth', edges).length)
  })
})

describe('relationHighlight', () => {
  const edges = [e('auth', 'tenant'), e('auth', 'chats')]

  it('includes the feature being pointed at', () => {
    // Lighting only the neighbours dims the cell the reader is asking about.
    expect(relationHighlight('auth', edges).sort()).toEqual(['auth', 'chats', 'tenant'])
  })

  it('lights NOTHING for an unconnected feature', () => {
    // A sheet that dimmed every other cell to announce that this one is
    // unconnected has spent the whole picture on a non-answer.
    expect(relationHighlight('lonely', edges)).toEqual([])
  })
})
