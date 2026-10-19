import { shouldOfferConfigure } from './import-error-model'

describe('shouldOfferConfigure (#1152)', () => {
  it('always offers the route when the provider has no credentials', () => {
    expect(shouldOfferConfigure(false, 'PRJ-123 is not a recognized reference')).toBe(true)
  })

  it('offers it on an access failure even when status says connected', () => {
    // The trap: setToken stores unvalidated input, so garbage credentials make
    // status report connected: true and used to remove the CTA forever.
    expect(
      shouldOfferConfigure(true, 'IssueFetchError: jira request failed — issue not found or no access'),
    ).toBe(true)
    expect(shouldOfferConfigure(true, 'Request failed with 401 Unauthorized')).toBe(true)
    expect(shouldOfferConfigure(true, 'check your token')).toBe(true)
    expect(shouldOfferConfigure(true, 'insufficient permission for this repository')).toBe(true)
  })

  it('stays quiet for a failure reconfiguring would not fix', () => {
    // The original rule's point, preserved: a malformed reference on a working
    // provider is not a credentials problem.
    expect(shouldOfferConfigure(true, 'That URL points at a board, not an issue')).toBe(false)
    expect(shouldOfferConfigure(true, 'Could not parse "not-a-key" as an issue reference')).toBe(
      false,
    )
  })
})
