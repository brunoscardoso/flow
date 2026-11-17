import { graphWidthPx, laneColorIndex, layoutGraph, segmentPath } from './graph-layout'

describe('layoutGraph', () => {
  it('keeps a straight history in one lane', () => {
    const { rows, width } = layoutGraph([
      { hash: 'c', parents: ['b'] },
      { hash: 'b', parents: ['a'] },
      { hash: 'a', parents: [] },
    ])
    expect(width).toBe(1)
    expect(rows.map((row) => row.lane)).toEqual([0, 0, 0])
    expect(rows[0]?.tip).toBe(true)
    // The tip has no line above it; the root has none below.
    expect(rows[0]?.segments).toEqual([{ fromLane: 0, fromY: 'mid', toLane: 0, toY: 'bottom', colorLane: 0 }])
    expect(rows[2]?.segments).toEqual([{ fromLane: 0, fromY: 'top', toLane: 0, toY: 'mid', colorLane: 0 }])
  })

  it('opens a second lane at a merge and closes it where the branch began', () => {
    // m merges f2 into main; f2 -> f1 -> base; main side: m -> x -> base
    const { rows, width } = layoutGraph([
      { hash: 'm', parents: ['x', 'f2'] },
      { hash: 'f2', parents: ['f1'] },
      { hash: 'x', parents: ['base'] },
      { hash: 'f1', parents: ['base'] },
      { hash: 'base', parents: [] },
    ])
    expect(width).toBe(2)
    const [m, f2, x, f1, base] = rows
    expect(m?.merge).toBe(true)
    // The merge's second line curves out of the node into lane 1.
    expect(m?.segments).toContainEqual({ fromLane: 0, fromY: 'mid', toLane: 1, toY: 'bottom', colorLane: 1 })
    expect(f2?.lane).toBe(1)
    expect(x?.lane).toBe(0)
    expect(f1?.lane).toBe(1)
    // While f1 sits in lane 1, lane 0 passes straight through its row.
    expect(f1?.segments).toContainEqual({ fromLane: 0, fromY: 'top', toLane: 0, toY: 'bottom', colorLane: 0 })
    // Lane 1 converges into base, in its own colour.
    expect(base?.lane).toBe(0)
    expect(base?.segments).toContainEqual({ fromLane: 1, fromY: 'top', toLane: 0, toY: 'mid', colorLane: 1 })
    expect(base?.continuing).toEqual([])
    expect(f2?.continuing).toEqual([0, 1])
  })

  it('gives an unrelated tip its own lane and tolerates a missing parent', () => {
    const { rows } = layoutGraph([
      { hash: 'a', parents: ['gone'] },
      { hash: 'b' },
    ])
    expect(rows[0]?.lane).toBe(0)
    // 'gone' never arrives: lane 0 stays reserved, so b takes lane 1.
    expect(rows[1]?.lane).toBe(1)
    expect(rows[1]?.tip).toBe(true)
  })

  it('reuses a freed lane instead of growing forever', () => {
    const { rows, width } = layoutGraph([
      { hash: 'm1', parents: ['a', 'b'] },
      { hash: 'b', parents: ['a'] },
      { hash: 'a', parents: ['r'] },
      { hash: 'm2', parents: ['r', 'c'] },
      { hash: 'c', parents: ['r'] },
      { hash: 'r', parents: [] },
    ])
    expect(width).toBeLessThanOrEqual(3)
    expect(rows.find((row) => row.hash === 'c')?.lane).toBeLessThanOrEqual(2)
  })
})

describe('geometry', () => {
  it('draws straight lines straight and lane changes as curves', () => {
    expect(segmentPath({ fromLane: 0, fromY: 'top', toLane: 0, toY: 'bottom', colorLane: 0 })).toBe('M9 0 L9 22')
    expect(segmentPath({ fromLane: 0, fromY: 'mid', toLane: 1, toY: 'bottom', colorLane: 1 })).toMatch(/^M9 11 C /)
  })

  it('cycles colours and caps the reserved width', () => {
    expect([0, 1, 4, 5].map(laneColorIndex)).toEqual([0, 1, 0, 1])
    expect(graphWidthPx(1)).toBe(18)
    expect(graphWidthPx(40)).toBe(graphWidthPx(8))
  })
})
