/**
 * Import-failure presentation rules for the board's New-task modal (#1152).
 *
 * The "Configure <provider>" CTA is the only in-board route back to the connect
 * form. It used to be shown ONLY when the provider had no stored credentials —
 * which stranded the exact user who needs it most: `setToken` stores whatever
 * was typed without validating it, so one wrong password flips
 * `integrations.status` to `connected: true` FOREVER, and every later failure
 * then rendered without the CTA.
 *
 * The original suppression had a real point (a malformed URL on a working
 * provider isn't fixed by reconfiguring), so the rule keeps it and adds the
 * case it missed: when the failure smells like credentials or access, offer the
 * route back regardless of what `status` claims.
 */

/** Failures that reconfiguring could plausibly fix. */
const ACCESS_FAILURE = /token|auth|unauthor|forbidden|permission|credential|no access|401|403/i

export function shouldOfferConfigure(connected: boolean, message: string): boolean {
  if (!connected) return true
  return ACCESS_FAILURE.test(message)
}
