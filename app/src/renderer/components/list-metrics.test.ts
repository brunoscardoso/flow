import {
  rowAt,
  rowOffsets,
  scrollToReveal,
  totalHeight,
  visibleRange,
} from './list-metrics'

const uniform = (count: number, height = 28): number[] => rowOffsets(count, () => height)

describe('rowOffsets', () => {
  it('is index * rowHeight when every row is the same', () => {
    expect(uniform(4)).toEqual([0, 28, 56, 84, 112])
  })

  it('accumulates mixed heights in order', () => {
    const offsets = rowOffsets(4, (i) => (i % 2 === 0 ? 28 : 44))
    expect(offsets).toEqual([0, 28, 72, 100, 144])
  })

  it('gives an empty list one entry, so the total is still a lookup', () => {
    expect(rowOffsets(0, () => 28)).toEqual([0])
    expect(totalHeight(rowOffsets(0, () => 28))).toBe(0)
  })

  it('never lets a row be zero-height — two rows would share a top', () => {
    // Ordering is what both binary searches rest on; equal tops break it.
    const offsets = rowOffsets(3, () => 0)
    expect(offsets).toEqual([0, 1, 2, 3])
  })

  it('survives a height callback that returns nonsense', () => {
    expect(rowOffsets(2, () => Number.NaN)).toEqual([0, 1, 2])
    expect(rowOffsets(2, () => Number.POSITIVE_INFINITY)).toEqual([0, 1, 2])
  })
})

describe('rowAt', () => {
  it('finds the row a pixel falls in', () => {
    const offsets = uniform(5)
    expect(rowAt(offsets, 0)).toBe(0)
    expect(rowAt(offsets, 27)).toBe(0)
    expect(rowAt(offsets, 28)).toBe(1)
    expect(rowAt(offsets, 139)).toBe(4)
  })

  it('finds it across mixed heights', () => {
    const offsets = rowOffsets(3, (i) => (i === 1 ? 44 : 28)) // [0, 28, 72, 100]
    expect(rowAt(offsets, 27)).toBe(0)
    expect(rowAt(offsets, 28)).toBe(1)
    expect(rowAt(offsets, 71)).toBe(1)
    expect(rowAt(offsets, 72)).toBe(2)
  })

  it('clamps rather than reporting a row that is not there', () => {
    expect(rowAt(uniform(3), -50)).toBe(0)
    expect(rowAt(uniform(3), 9999)).toBe(2)
    expect(rowAt(rowOffsets(0, () => 28), 10)).toBe(0)
  })
})

describe('visibleRange', () => {
  it('matches the old uniform arithmetic', () => {
    // What `Math.floor(scrollTop / 28) - 6` and `Math.ceil((scrollTop +
    // height) / 28) + 6` produced, so surfaces that never ask for variable
    // heights keep the window they had.
    const offsets = uniform(100)
    expect(visibleRange(offsets, 280, 280, 6)).toEqual({ first: 4, last: 25 })
  })

  it('mounts nothing for an empty list', () => {
    // last = -1 so `for (i = first; i <= last)` runs zero times.
    expect(visibleRange(rowOffsets(0, () => 28), 0, 500, 6)).toEqual({ first: 0, last: -1 })
  })

  it('does not mount the row that starts exactly at the fold', () => {
    // A viewport ending on a row boundary shows nothing of the next row.
    const offsets = uniform(10)
    expect(visibleRange(offsets, 0, 56, 0)).toEqual({ first: 0, last: 1 })
  })

  it('widens by the overscan without running off either end', () => {
    const offsets = uniform(10)
    expect(visibleRange(offsets, 0, 28, 6)).toEqual({ first: 0, last: 6 })
    expect(visibleRange(offsets, 252, 28, 6)).toEqual({ first: 3, last: 9 })
  })

  it('accounts for tall rows when deciding what fits', () => {
    // Three 44px rows then 28s: 100px of viewport reaches into the third.
    const offsets = rowOffsets(6, (i) => (i < 3 ? 44 : 28))
    expect(visibleRange(offsets, 0, 100, 0)).toEqual({ first: 0, last: 2 })
  })

  it('treats a zero-height viewport as showing its top row', () => {
    expect(visibleRange(uniform(10), 84, 0, 0)).toEqual({ first: 3, last: 3 })
  })
})

describe('scrollToReveal', () => {
  it('leaves an already-visible row alone', () => {
    expect(scrollToReveal(uniform(10), 2, 0, 200)).toBeNull()
  })

  it('scrolls up to a row above the fold', () => {
    expect(scrollToReveal(uniform(10), 1, 100, 200)).toBe(28)
  })

  it('scrolls down by the ROW’s height, not by an assumed one', () => {
    // The defect this exists for: with a fixed 28 the second line of a 44px
    // row lands under the fold and the row reads as clipped.
    const offsets = rowOffsets(10, () => 44) // row 5 spans 220..264
    expect(scrollToReveal(offsets, 5, 0, 200)).toBe(64)
  })

  it('answers nothing for an index that is not a row', () => {
    expect(scrollToReveal(uniform(3), -1, 0, 100)).toBeNull()
    expect(scrollToReveal(uniform(3), 3, 0, 100)).toBeNull()
    expect(scrollToReveal(rowOffsets(0, () => 28), 0, 0, 100)).toBeNull()
  })
})
