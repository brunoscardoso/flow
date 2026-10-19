// The pure core of the shared tab bar — where Arrow/Home/End moves focus.
// The DOM glue (roles, aria-selected, roving tabindex) is four attribute
// writes driven by this; the movement rule is what can silently regress.

import { roveTab } from './tab-bar-model'

describe('roveTab', () => {
  it('arrows move one step and wrap at both ends', () => {
    expect(roveTab(3, 0, 'ArrowRight')).toBe(1)
    expect(roveTab(3, 2, 'ArrowRight')).toBe(0)
    expect(roveTab(3, 1, 'ArrowLeft')).toBe(0)
    expect(roveTab(3, 0, 'ArrowLeft')).toBe(2)
  })

  it('Home and End jump to the rims', () => {
    expect(roveTab(5, 3, 'Home')).toBe(0)
    expect(roveTab(5, 1, 'End')).toBe(4)
  })

  it('ignores every other key — the bar must not eat typing', () => {
    expect(roveTab(3, 1, 'Enter')).toBeNull()
    expect(roveTab(3, 1, ' ')).toBeNull()
    expect(roveTab(3, 1, 'a')).toBeNull()
    expect(roveTab(3, 1, 'ArrowDown')).toBeNull()
  })

  it('is inert when focus is not on a tab or the bar is empty', () => {
    // current === -1 is the querySelector miss — focus is elsewhere.
    expect(roveTab(3, -1, 'ArrowRight')).toBeNull()
    expect(roveTab(0, 0, 'ArrowRight')).toBeNull()
    expect(roveTab(3, 3, 'ArrowRight')).toBeNull()
  })

  it('a single tab stays put rather than cycling to itself as a "move"', () => {
    expect(roveTab(1, 0, 'ArrowRight')).toBe(0)
    expect(roveTab(1, 0, 'ArrowLeft')).toBe(0)
  })
})
