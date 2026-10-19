import { neighborOf } from './tab-neighbor'

describe('neighborOf (#408)', () => {
  const tabs = ['a', 'b', 'c']

  it('prefers the right neighbor when closing a middle tab', () => {
    // The #408 repro: close the middle tab → focus the RIGHT neighbor, not the first.
    expect(neighborOf(tabs, 'b')).toBe('c')
  })

  it('falls to the left neighbor when closing the last tab', () => {
    expect(neighborOf(tabs, 'c')).toBe('b')
  })

  it('prefers the right neighbor when closing the first tab', () => {
    expect(neighborOf(tabs, 'a')).toBe('b')
  })

  it('is null when closing the only tab', () => {
    expect(neighborOf(['solo'], 'solo')).toBeNull()
  })

  it('is null when the id is not in the list', () => {
    expect(neighborOf(tabs, 'zz')).toBeNull()
    expect(neighborOf([], 'a')).toBeNull()
  })
})
