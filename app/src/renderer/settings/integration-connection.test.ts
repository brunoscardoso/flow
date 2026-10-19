import { isCliDerivedConnection } from './integration-connection'

describe('isCliDerivedConnection (#419)', () => {
  it('is true for CLI-derived identity hints', () => {
    expect(isCliDerivedConnection('via gh CLI')).toBe(true)
    expect(isCliDerivedConnection('via az CLI')).toBe(true)
  })

  it('is false for a stored-token (email) hint or no hint', () => {
    expect(isCliDerivedConnection('you@company.com')).toBe(false)
    expect(isCliDerivedConnection(undefined)).toBe(false)
    expect(isCliDerivedConnection('')).toBe(false)
    expect(isCliDerivedConnection('via CLI')).toBe(false) // needs a tool name
  })
})
