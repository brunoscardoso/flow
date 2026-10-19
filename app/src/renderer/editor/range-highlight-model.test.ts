import { cursorLeavesRange, normalizeHighlightRange } from './range-highlight-model'

describe('normalizeHighlightRange', () => {
  it('keeps an in-file range as given', () => {
    expect(normalizeHighlightRange(12, 30, 100)).toEqual({ start: 12, end: 30 })
  })

  it('swaps a reversed range (endLine < line)', () => {
    expect(normalizeHighlightRange(30, 12, 100)).toEqual({ start: 12, end: 30 })
  })

  it('clamps a range that runs past the end of the file', () => {
    expect(normalizeHighlightRange(90, 140, 100)).toEqual({ start: 90, end: 100 })
    expect(normalizeHighlightRange(150, 160, 100)).toEqual({ start: 100, end: 100 })
  })

  it('collapses to the start line when the end is absent or not a number', () => {
    expect(normalizeHighlightRange(7, undefined, 100)).toEqual({ start: 7, end: 7 })
    expect(normalizeHighlightRange(7, Number.NaN, 100)).toEqual({ start: 7, end: 7 })
  })

  it('clamps a zero/negative end to line 1', () => {
    expect(normalizeHighlightRange(5, 0, 100)).toEqual({ start: 1, end: 5 })
  })

  it('refuses an unusable start line or an empty model', () => {
    expect(normalizeHighlightRange(0, 10, 100)).toBeNull()
    expect(normalizeHighlightRange(Number.NaN, 10, 100)).toBeNull()
    expect(normalizeHighlightRange(3, 10, 0)).toBeNull()
  })
})

describe('cursorLeavesRange', () => {
  const range = { start: 10, end: 20 }
  it('stays inside on the range edges and between them', () => {
    expect(cursorLeavesRange(10, range)).toBe(false)
    expect(cursorLeavesRange(15, range)).toBe(false)
    expect(cursorLeavesRange(20, range)).toBe(false)
  })
  it('leaves above or below', () => {
    expect(cursorLeavesRange(9, range)).toBe(true)
    expect(cursorLeavesRange(21, range)).toBe(true)
  })
})
