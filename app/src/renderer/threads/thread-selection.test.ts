import { resolveThreadSelection } from './thread-selection'

describe('resolveThreadSelection (#405)', () => {
  it('selects the new project thread when it differs from the current one', () => {
    expect(resolveThreadSelection('T_B', 'T_A')).toBe('select')
    expect(resolveThreadSelection('T_B', null)).toBe('select')
  })

  it('clears when switching to a thread-less project while a thread is still selected', () => {
    // The exact #405 data-loss case: project B has no thread, but T_A stays armed.
    expect(resolveThreadSelection(null, 'T_A')).toBe('clear')
  })

  it('does nothing when the target thread is already selected', () => {
    expect(resolveThreadSelection('T_A', 'T_A')).toBe('none')
  })

  it('does nothing when there is no target and nothing is selected', () => {
    expect(resolveThreadSelection(null, null)).toBe('none')
  })
})
