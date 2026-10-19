import { isTurnResultTerminal } from './turn-completion'

describe('isTurnResultTerminal (#464)', () => {
  it('is terminal only when no parent tool calls are still open', () => {
    expect(isTurnResultTerminal(0)).toBe(true)
  })

  it('is NOT terminal while a parent tool call (e.g. a running Task sub-agent) is open', () => {
    // A sub-agent result arrives with the parent Task still open → must not mark done.
    expect(isTurnResultTerminal(1)).toBe(false)
    expect(isTurnResultTerminal(3)).toBe(false)
  })
})
