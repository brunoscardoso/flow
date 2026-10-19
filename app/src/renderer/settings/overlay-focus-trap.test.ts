// Unit tests for the overlay focus trap's pure wrap rule (#1006). The DOM
// installer is exercised end-to-end by e2e/ux/onboarding-focus-containment.spec;
// this covers the wrap arithmetic that decides where every Tab press lands.

import { nextFocusIndex } from './overlay-focus-model'

describe('nextFocusIndex (#1006)', () => {
  it('cycles forward through the trap and wraps last → first', () => {
    expect(nextFocusIndex(0, 3, false)).toBe(1)
    expect(nextFocusIndex(1, 3, false)).toBe(2)
    expect(nextFocusIndex(2, 3, false)).toBe(0) // wrap
  })

  it('cycles backward and wraps first → last', () => {
    expect(nextFocusIndex(2, 3, true)).toBe(1)
    expect(nextFocusIndex(1, 3, true)).toBe(0)
    expect(nextFocusIndex(0, 3, true)).toBe(2) // wrap
  })

  it('enters the trap at the first (forward) or last (backward) control when focus is not on any control', () => {
    // -1 = focus on the panel itself, or escaped outside the overlay entirely.
    expect(nextFocusIndex(-1, 3, false)).toBe(0)
    expect(nextFocusIndex(-1, 3, true)).toBe(2)
  })

  it('treats a stale out-of-range index like an entry, not a crash', () => {
    expect(nextFocusIndex(7, 3, false)).toBe(0)
    expect(nextFocusIndex(7, 3, true)).toBe(2)
  })

  it('single-control trap always stays on that control', () => {
    expect(nextFocusIndex(0, 1, false)).toBe(0)
    expect(nextFocusIndex(0, 1, true)).toBe(0)
  })

  it('returns -1 only for an empty trap', () => {
    expect(nextFocusIndex(0, 0, false)).toBe(-1)
    expect(nextFocusIndex(-1, 0, true)).toBe(-1)
  })
})
