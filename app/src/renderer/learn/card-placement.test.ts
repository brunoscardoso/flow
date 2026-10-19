import { CORNER_BOTTOM_PX, learnCardBottom } from './card-placement'

describe('learnCardBottom', () => {
  it('sits in the corner when no toast is showing', () => {
    expect(learnCardBottom(0)).toBe(`${CORNER_BOTTOM_PX}px`)
    expect(learnCardBottom(Number.NaN)).toBe(`${CORNER_BOTTOM_PX}px`)
  })

  it('stands on top of the toast stack, one gap above it', () => {
    expect(learnCardBottom(120)).toBe('calc(152px + var(--fl-space-sm))')
    expect(learnCardBottom(80.2)).toBe('calc(113px + var(--fl-space-sm))')
  })
})
