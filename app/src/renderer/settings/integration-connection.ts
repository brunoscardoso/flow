// Pure classification of an integration connection's origin (#419). A provider
// can read as Connected two ways: a token STORED in the app, or a CLI login the
// app merely reuses (gh/az). The app can delete a stored token but CANNOT log
// you out of the CLI, so a "Disconnect" button is a dead no-op for the CLI case.
// The status signals it via identityHint ("via gh CLI" / "via az CLI"); a
// stored-token hint is the account email. DOM-free → unit-testable.

/**
 * Whether a Connected status comes from a CLI login (not a stored token) — i.e.
 * its identity hint reads "via <tool> CLI". Matches any such tool (future-proof)
 * and never an email (which has no spaces).
 */
export function isCliDerivedConnection(identityHint?: string): boolean {
  return /^via .+ CLI$/.test(identityHint ?? '')
}
