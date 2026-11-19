import { DRAFT_HISTORY_LIMIT } from '../../shared/ui-drafts'
import {
  fileOfHistoryFolder,
  isSnapshotName,
  planCanvasUndo,
  snapshotName,
  snapshotStamp,
  snapshotsToPrune,
  sortedSnapshots,
} from './draft-history'

describe('snapshot names', () => {
  it('sort by time as plain strings, a tie by its counter', () => {
    const names = [snapshotName(20, 0, '.html'), snapshotName(3, 0, '.html'), snapshotName(20, 1, '.html')]
    expect(sortedSnapshots(names)).toEqual([snapshotName(3, 0, '.html'), snapshotName(20, 0, '.html'), snapshotName(20, 1, '.html')])
    expect(snapshotName(7, 2, '.css')).toBe('000000000000007-002.css')
    expect(snapshotStamp('000000000000007-002.css')).toBe('000000000000007')
  })

  it('ignores anything that is not a snapshot', () => {
    expect(isSnapshotName('.DS_Store')).toBe(false)
    expect(isSnapshotName('7-2.html')).toBe(false)
    expect(sortedSnapshots(['notes.txt', snapshotName(1, 0, '.html')])).toEqual([snapshotName(1, 0, '.html')])
  })
})

describe('pruning', () => {
  it(`drops the oldest beyond ${DRAFT_HISTORY_LIMIT} and nothing below it`, () => {
    const names = Array.from({ length: DRAFT_HISTORY_LIMIT + 3 }, (_, index) => snapshotName(index + 1, 0, '.html'))
    expect(snapshotsToPrune(names, DRAFT_HISTORY_LIMIT)).toEqual(names.slice(0, 3))
    expect(snapshotsToPrune(names.slice(0, DRAFT_HISTORY_LIMIT), DRAFT_HISTORY_LIMIT)).toEqual([])
    expect(snapshotsToPrune(names, 0)).toHaveLength(names.length)
  })
})

describe('history folders', () => {
  it('map to the canvas file they belong to', () => {
    expect(fileOfHistoryFolder('cart')).toBe('cart.html')
    expect(fileOfHistoryFolder('.layout')).toBe('layout.json')
    expect(fileOfHistoryFolder('.tokens')).toBe('tokens.css')
    expect(fileOfHistoryFolder('.other')).toBeNull()
    expect(fileOfHistoryFolder('Cart')).toBeNull()
  })
})

describe('planCanvasUndo', () => {
  const at = (stamp: number, extension = '.html'): string => snapshotName(stamp, 0, extension)

  it('has nothing to undo without snapshots', () => {
    expect(planCanvasUndo([])).toEqual({ steps: 0, restore: [] })
    expect(planCanvasUndo([{ folder: 'cart', names: [] }])).toEqual({ steps: 0, restore: [] })
  })

  it('restores the newest snapshot across every folder', () => {
    const plan = planCanvasUndo([
      { folder: 'cart', names: [at(10), at(30)] },
      { folder: 'home', names: [at(20)] },
      { folder: '.tokens', names: [at(5, '.css')] },
    ])
    expect(plan).toEqual({ steps: 4, restore: [{ folder: 'cart', name: at(30) }] })
  })

  it('restores every file that has a snapshot at the newest stamp together', () => {
    const plan = planCanvasUndo([
      { folder: 'cart', names: [at(10), at(40)] },
      { folder: 'home', names: [at(40)] },
      { folder: '.layout', names: [at(40, '.json')] },
    ])
    expect(plan.restore.map((entry) => entry.folder).sort()).toEqual(['.layout', 'cart', 'home'])
    expect(plan.steps).toBe(2)
  })

  it('counts steps by distinct stamp and skips folders that are not history', () => {
    const plan = planCanvasUndo([
      { folder: 'cart', names: [at(1), at(2), at(3)] },
      { folder: 'home', names: [at(2), at(4)] },
      { folder: '.junk', names: [at(99)] },
    ])
    expect(plan.steps).toBe(4)
    expect(plan.restore).toEqual([{ folder: 'home', name: at(4) }])
  })
})
