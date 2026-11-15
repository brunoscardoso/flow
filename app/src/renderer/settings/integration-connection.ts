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

/** What a tracker card's closed row needs to know. `connected: null` = still checking. */
export interface CardState {
  /** The tracker's name as shown: "GitHub". */
  title: string
  /** One line saying what the tracker brings, for a card that is not connected. */
  blurb: string
  connected: boolean | null
  identityHint?: string | null
  /** The saved list query, if one is stored. */
  listQuery?: string | null
}

/**
 * The one line under a tracker's name — who it is connected as and whether a
 * saved list exists, so a closed card answers "is this set up?" without
 * opening it. Plain words only: never a command or a setting (forbidden #12).
 */
export function cardSummary(state: CardState): string {
  if (state.connected === null) return 'Checking the connection…'
  if (!state.connected) return state.blurb
  const hint = state.identityHint ?? ''
  const who = isCliDerivedConnection(hint)
    ? `Using the ${state.title} sign-in on this computer`
    : hint !== ''
      ? hint
      : 'Connected with a saved token'
  const list = (state.listQuery ?? '').trim() !== '' ? 'saved list set' : 'no saved list'
  return `${who} · ${list}`
}

/**
 * Whether a card starts open. A tracker that is not connected opens, because
 * connecting it is the only thing to do there; a connected one stays closed so
 * the page reads as a list. Still checking → closed (its controls are inert).
 */
export function cardStartsOpen(connected: boolean | null): boolean {
  return connected === false
}
