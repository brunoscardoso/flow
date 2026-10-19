// Per-project account dropdown revert logic (#226). The "This project" <select>
// updates optimistically on change, but accounts.assignProject can reject (a
// store/disk write error) — and PR #225's .catch toasted without reverting, so
// the dropdown persistently showed an account the project was NOT bound to. This
// pure helper decides how to revert after a failed assign, and crucially does
// NOT clobber a NEWER selection the user made while the failed assign was still
// in flight. DOM-free so the race is unit-testable.

export interface AssignRevert {
  /** Whether to reset the select's value. */
  revert: boolean
  /** The value to reset to (only meaningful when revert is true). */
  value: string
}

/**
 * After `assignProject(attempted)` fails, decide whether/how to revert the
 * dropdown. Revert to `previous` ONLY when the select still shows `attempted`
 * (the user hasn't since picked something else) — otherwise leave the newer
 * choice alone so a stale rejection can't stomp it.
 */
export function resolveAssignRevert(
  currentValue: string,
  attempted: string,
  previous: string,
): AssignRevert {
  if (currentValue !== attempted) return { revert: false, value: currentValue }
  return { revert: true, value: previous }
}
