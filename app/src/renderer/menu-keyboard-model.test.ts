import { nextMenuIndex } from './menu-keyboard-model'

// #1300: the board's lane menu had role="menu", focused its first item, and
// then supported nothing — arrows dead, Tab escaping to the controls behind the
// open popup. The sibling thread-sidebar menu got all of this in #1173; the
// board re-implemented the chrome weeks later and inherited none of it. The
// navigation math lives here so both share it.

describe('nextMenuIndex (#1173, #1300)', () => {
  it('steps forward and back', () => {
    expect(nextMenuIndex(0, 1, 3)).toBe(1)
    expect(nextMenuIndex(1, -1, 3)).toBe(0)
  })

  it('wraps at both ends, so the list has no dead end', () => {
    expect(nextMenuIndex(2, 1, 3)).toBe(0)
    expect(nextMenuIndex(0, -1, 3)).toBe(2)
  })

  it('enters from the matching end when nothing is focused yet', () => {
    // ArrowDown from "nothing focused" lands on the first item, ArrowUp on the
    // last — the same rule the sidebar's picker uses.
    expect(nextMenuIndex(-1, 1, 3)).toBe(0)
    expect(nextMenuIndex(-1, -1, 3)).toBe(2)
  })

  it('is inert for an empty menu rather than returning a bogus index', () => {
    expect(nextMenuIndex(-1, 1, 0)).toBe(-1)
    expect(nextMenuIndex(0, -1, 0)).toBe(-1)
  })

  it('stays put in a single-item menu', () => {
    expect(nextMenuIndex(0, 1, 1)).toBe(0)
    expect(nextMenuIndex(0, -1, 1)).toBe(0)
  })
})
