import type { PaletteCandidate } from './palette-types'
import { DEFAULT_RANK_WEIGHTS, emptyStateResults, rankCandidates } from './palette-rank'

function cand(over: Partial<PaletteCandidate> & Pick<PaletteCandidate, 'kind' | 'id'>): PaletteCandidate {
  return { label: over.id, run: () => undefined, ...over }
}

const ids = (list: PaletteCandidate[]): string[] => list.map((c) => c.id)

describe('rankCandidates', () => {
  it('orders by per-kind base tier when fuzzy scores tie', () => {
    // base: file 10 > command 9 > thread 8 (no recency, score 0 each).
    const ranked = rankCandidates([
      cand({ kind: 'thread', id: 't', score: 0 }),
      cand({ kind: 'command', id: 'c', score: 0 }),
      cand({ kind: 'file', id: 'f', score: 0 }),
    ])
    expect(ids(ranked)).toEqual(['f', 'c', 't'])
  })

  it('lets a recent thread out-rank a weak file path but not a strong filename hit', () => {
    const ranked = rankCandidates([
      cand({ kind: 'file', id: 'weak-path', score: 0 }), // 10
      cand({ kind: 'thread', id: 'recent', score: 0, recencyAt: '2026-07-18T00:00:00Z' }), // 8 + 9
      cand({ kind: 'file', id: 'strong-name', score: 20 }), // 30
    ])
    expect(ids(ranked)).toEqual(['strong-name', 'recent', 'weak-path'])
  })

  it('orders threads by recency (newer first)', () => {
    const ranked = rankCandidates([
      cand({ kind: 'thread', id: 'old', score: 0, recencyAt: '2026-07-01T00:00:00Z' }),
      cand({ kind: 'thread', id: 'new', score: 0, recencyAt: '2026-07-18T00:00:00Z' }),
    ])
    expect(ids(ranked)).toEqual(['new', 'old'])
  })

  it('caps results per kind', () => {
    const ranked = rankCandidates(
      [
        cand({ kind: 'file', id: 'a', score: 3 }),
        cand({ kind: 'file', id: 'b', score: 2 }),
        cand({ kind: 'file', id: 'c', score: 1 }),
      ],
      DEFAULT_RANK_WEIGHTS,
      2,
    )
    expect(ids(ranked)).toEqual(['a', 'b'])
  })

  it('is deterministic for identical inputs', () => {
    const input = [
      cand({ kind: 'file', id: 'f', score: 5 }),
      cand({ kind: 'thread', id: 't', score: 5, recencyAt: '2026-07-10T00:00:00Z' }),
      cand({ kind: 'command', id: 'c', score: 5 }),
    ]
    expect(ids(rankCandidates(input))).toEqual(ids(rankCandidates(input)))
  })

  it('preserves original (source) order on an exact tie — not alphabetical', () => {
    const ranked = rankCandidates([
      cand({ kind: 'command', id: 'z', label: 'zeta', score: 0 }),
      cand({ kind: 'command', id: 'a', label: 'alpha', score: 0 }),
    ])
    // Registry/source order wins so a curated command order is honored.
    expect(ids(ranked)).toEqual(['z', 'a'])
  })

  it('never mutates the input candidates', () => {
    const input = [cand({ kind: 'file', id: 'f', score: 1 })]
    const snapshot = { ...input[0] }
    rankCandidates(input)
    expect(input[0]).toEqual(snapshot)
  })
})

describe('emptyStateResults', () => {
  const recents = [cand({ kind: 'file', id: 'r1' }), cand({ kind: 'thread', id: 'r2' })]
  const actions = [cand({ kind: 'command', id: 'a1' }), cand({ kind: 'command', id: 'a2' })]

  it('concatenates recents then actions', () => {
    expect(ids(emptyStateResults(recents, actions))).toEqual(['r1', 'r2', 'a1', 'a2'])
  })

  it('caps each side independently', () => {
    expect(ids(emptyStateResults(recents, actions, 1, 1))).toEqual(['r1', 'a1'])
  })
})
