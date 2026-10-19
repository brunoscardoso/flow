import {
  DEFAULT_DRAWER_HEIGHT,
  MAX_DRAWER_HEIGHT,
  MIN_DRAWER_HEIGHT,
  clampDrawerHeight,
} from './drawer-height'

describe('clampDrawerHeight', () => {
  it('keeps a sensible height exactly as dragged', () => {
    expect(clampDrawerHeight(344)).toBe(344)
  })

  it('refuses to collapse the drawer to nothing', () => {
    // A drawer at zero height looks identical to one that failed to open.
    expect(clampDrawerHeight(0)).toBe(MIN_DRAWER_HEIGHT)
    expect(clampDrawerHeight(-500)).toBe(MIN_DRAWER_HEIGHT)
  })

  it('refuses to let the drawer become the window', () => {
    expect(clampDrawerHeight(5000)).toBe(MAX_DRAWER_HEIGHT)
  })

  it('falls back on a stored value that is not a number', () => {
    // localStorage survives upgrades and can be edited by hand; Number(null)
    // is 0 and Number('x') is NaN, and neither should open a broken drawer.
    expect(clampDrawerHeight(Number.NaN)).toBe(DEFAULT_DRAWER_HEIGHT)
    expect(clampDrawerHeight(Number('not a height'))).toBe(DEFAULT_DRAWER_HEIGHT)
    expect(clampDrawerHeight(Number.POSITIVE_INFINITY)).toBe(DEFAULT_DRAWER_HEIGHT)
  })

  it('rounds, because a fractional pixel height is a blurry border', () => {
    expect(clampDrawerHeight(240.6)).toBe(241)
  })
})
