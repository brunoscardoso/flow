import { pinOpenAction } from './pin-open-model'

describe('pinOpenAction', () => {
  it('opens a feature card as its own diagram level, never its blocks', () => {
    expect(pinOpenAction({ id: 'auth', kind: 'feature', name: 'Auth' }, null)).toEqual({
      kind: 'level',
      id: 'auth',
      name: 'Auth',
      via: 'self',
    })
  })

  it("keeps a part's press (its code story at the last level), owner known or not", () => {
    expect(pinOpenAction({ id: 'auth/login', kind: 'part', name: 'Login' }, { id: 'auth', name: 'Auth' })).toEqual({ kind: 'press' })
    expect(pinOpenAction({ id: 'x', kind: 'part', name: 'X' }, null)).toEqual({ kind: 'press' })
  })

  it('keeps the press for a cell with no diagram view (a domain)', () => {
    expect(pinOpenAction({ id: 'domain:core', kind: 'domain', name: 'Core' }, { id: 'a', name: 'A' })).toEqual({
      kind: 'press',
    })
  })
})
