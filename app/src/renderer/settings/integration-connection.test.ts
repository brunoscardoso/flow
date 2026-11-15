import { cardStartsOpen, cardSummary, isCliDerivedConnection } from './integration-connection'

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

describe('cardSummary', () => {
  const base = { title: 'GitHub', blurb: 'Issues assigned to you.' }

  it('says it is checking while the status has not landed', () => {
    expect(cardSummary({ ...base, connected: null })).toBe('Checking the connection…')
  })

  it('shows what the tracker brings when it is not connected', () => {
    expect(cardSummary({ ...base, connected: false })).toBe('Issues assigned to you.')
  })

  it('names a sign-in it reuses in plain words, never the tool behind it', () => {
    const line = cardSummary({ ...base, connected: true, identityHint: 'via gh CLI', listQuery: 'is:open' })
    expect(line).toBe('Using the GitHub sign-in on this computer · saved list set')
    expect(line).not.toMatch(/gh|CLI/)
  })

  it('names the account of a saved token, and an empty list as none', () => {
    expect(cardSummary({ ...base, title: 'Jira', connected: true, identityHint: 'me@acme.example', listQuery: '  ' })).toBe(
      'me@acme.example · no saved list',
    )
    expect(cardSummary({ ...base, connected: true })).toBe('Connected with a saved token · no saved list')
  })
})

describe('cardStartsOpen', () => {
  it('opens only a tracker that is not connected', () => {
    expect(cardStartsOpen(false)).toBe(true)
    expect(cardStartsOpen(true)).toBe(false)
    expect(cardStartsOpen(null)).toBe(false)
  })
})
