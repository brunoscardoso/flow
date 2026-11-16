import { cellPressOpens, planSwap, readFeatureViewPref, viewSwitchOffered } from './view-switch-model'

const D = { id: 'domain:core', kind: 'domain' }
const X = { id: 'auth', kind: 'feature' }

describe('readFeatureViewPref', () => {
  it('defaults to blocks and remembers diagram', () => {
    expect(readFeatureViewPref(null)).toBe('blocks')
    expect(readFeatureViewPref('junk')).toBe('blocks')
    expect(readFeatureViewPref('diagram')).toBe('diagram')
  })
})

describe('viewSwitchOffered', () => {
  it('offers both views only for a feature', () => {
    expect(viewSwitchOffered(X)).toBe(true)
    expect(viewSwitchOffered(D)).toBe(false)
    expect(viewSwitchOffered({ kind: 'part' })).toBe(false)
    expect(viewSwitchOffered(null)).toBe(false)
    expect(viewSwitchOffered(undefined)).toBe(false)
  })
})

describe('cellPressOpens', () => {
  it('opens a feature in the remembered diagram view', () => {
    expect(cellPressOpens({ pref: 'diagram', cellKind: 'feature', hasNode: true })).toBe('diagram')
  })
  it('keeps the press for blocks, domains, parts and ghosts', () => {
    expect(cellPressOpens({ pref: 'blocks', cellKind: 'feature', hasNode: true })).toBe('press')
    expect(cellPressOpens({ pref: 'diagram', cellKind: 'domain', hasNode: true })).toBe('press')
    expect(cellPressOpens({ pref: 'diagram', cellKind: 'part', hasNode: true })).toBe('press')
    expect(cellPressOpens({ pref: 'diagram', cellKind: 'feature', hasNode: false })).toBe('press')
  })
})

describe('planSwap', () => {
  it('blocks → diagram returns to the parent, so Back leaves the feature', () => {
    expect(planSwap({ from: 'blocks', stack: [D, X], focus: X })).toEqual({
      to: 'diagram',
      returnStack: [D],
      blocksStack: [D, X],
      history: 'push',
    })
  })
  it('diagram → blocks stands the feature on its parent', () => {
    expect(planSwap({ from: 'diagram', stack: [D], focus: X })).toEqual({
      to: 'blocks',
      returnStack: [D],
      blocksStack: [D, X],
      history: 'push',
    })
  })
  it('a diagram opened from the root swaps to blocks one level in', () => {
    const plan = planSwap({ from: 'diagram', stack: [], focus: X })
    expect(plan.blocksStack).toEqual([X])
    expect(plan.returnStack).toEqual([])
  })
  it('swapping twice comes back to the same place', () => {
    const there = planSwap({ from: 'blocks', stack: [D, X], focus: X })
    const back = planSwap({ from: 'diagram', stack: there.returnStack, focus: X })
    expect(back.blocksStack).toEqual([D, X])
  })
})
