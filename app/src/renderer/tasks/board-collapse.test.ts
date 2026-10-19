import type { TaskLane } from '../../shared/ipc-contract'
import {
  laneCollapseStorageKey,
  parseCollapsedLanes,
  reconcileCollapsedLanes,
  serializeCollapsedLanes,
} from './board-collapse'

describe('laneCollapseStorageKey — a per-project view preference (#1902)', () => {
  it('keys by project root, so two projects never share a fold', () => {
    expect(laneCollapseStorageKey('/a')).not.toBe(laneCollapseStorageKey('/b'))
    expect(laneCollapseStorageKey('/repo')).toBe('flow.board.collapsed:/repo')
  })
})

describe('parseCollapsedLanes — validated, never trusted', () => {
  it('keeps only real lane keys and drops the rest', () => {
    const set = parseCollapsedLanes('doing,not-a-lane,review')
    expect([...set].sort()).toEqual(['doing', 'review'])
  })

  it('reads null (nothing stored) as an empty set', () => {
    expect(parseCollapsedLanes(null).size).toBe(0)
  })

  it('trims whitespace and dedupes repeats', () => {
    const set = parseCollapsedLanes(' done , done ,  blocked ')
    expect([...set].sort()).toEqual(['blocked', 'done'])
  })

  it('an all-garbage string is no fold at all, not a thrown error', () => {
    expect(parseCollapsedLanes('x,y,z').size).toBe(0)
  })
})

describe('serializeCollapsedLanes — deterministic, board order', () => {
  it('emits board order whatever order the set was built in', () => {
    const set = new Set<TaskLane>(['done', 'todo', 'review'])
    // BOARD_LANES order is todo · doing · blocked · review · done.
    expect(serializeCollapsedLanes(set)).toBe('todo,review,done')
  })

  it('round-trips through parse', () => {
    const set = new Set<TaskLane>(['blocked', 'doing'])
    expect(serializeCollapsedLanes(parseCollapsedLanes(serializeCollapsedLanes(set)))).toBe(
      'doing,blocked',
    )
  })

  it('an empty set serialises to the empty string (nothing stored)', () => {
    expect(serializeCollapsedLanes(new Set())).toBe('')
  })
})

describe('reconcileCollapsedLanes — reveal a folded lane when work lands (#1902)', () => {
  const counts = (entries: Array<[TaskLane, number]>) => new Map<TaskLane, number>(entries)

  it('reveals a collapsed lane whose count rose against a known baseline', () => {
    const result = reconcileCollapsedLanes({
      collapsed: new Set<TaskLane>(['review']),
      prevCounts: counts([['review', 0]]),
      counts: counts([['review', 1]]),
    })
    expect(result.expanded).toEqual(['review'])
    expect(result.collapsed.has('review')).toBe(false)
  })

  it('does NOT reveal on the first render — no baseline is not growth (NFR-4)', () => {
    const result = reconcileCollapsedLanes({
      collapsed: new Set<TaskLane>(['review']),
      prevCounts: counts([]), // never rendered before
      counts: counts([['review', 3]]),
    })
    expect(result.expanded).toEqual([])
    expect(result.collapsed.has('review')).toBe(true)
  })

  it('does NOT reveal when a card LEAVES a folded lane (count fell)', () => {
    const result = reconcileCollapsedLanes({
      collapsed: new Set<TaskLane>(['done']),
      prevCounts: counts([['done', 4]]),
      counts: counts([['done', 3]]),
    })
    expect(result.expanded).toEqual([])
    expect(result.collapsed.has('done')).toBe(true)
  })

  it('does NOT reveal when the count is unchanged (e.g. just after a manual fold)', () => {
    const result = reconcileCollapsedLanes({
      collapsed: new Set<TaskLane>(['blocked']),
      prevCounts: counts([['blocked', 2]]),
      counts: counts([['blocked', 2]]),
    })
    expect(result.expanded).toEqual([])
    expect(result.collapsed.has('blocked')).toBe(true)
  })

  it('reveals only the lanes that grew, leaving other folds intact', () => {
    const result = reconcileCollapsedLanes({
      collapsed: new Set<TaskLane>(['doing', 'review', 'done']),
      prevCounts: counts([
        ['doing', 1],
        ['review', 0],
        ['done', 5],
      ]),
      counts: counts([
        ['doing', 1], // unchanged
        ['review', 2], // grew → reveal
        ['done', 5], // unchanged
      ]),
    })
    expect(result.expanded).toEqual(['review'])
    expect([...result.collapsed].sort()).toEqual(['doing', 'done'])
  })

  it('never mutates the input set', () => {
    const input = new Set<TaskLane>(['review'])
    reconcileCollapsedLanes({
      collapsed: input,
      prevCounts: counts([['review', 0]]),
      counts: counts([['review', 9]]),
    })
    expect(input.has('review')).toBe(true) // caller's set untouched
  })
})
