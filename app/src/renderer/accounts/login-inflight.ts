/**
 * Who owns the one in-flight interactive sign-in (#1167).
 *
 * `claude auth login` is interactive (#972): it prints a URL and then blocks on
 * a paste-the-code prompt. `LoginOrchestrator` holds a SINGLE in-flight slot,
 * so an abandoned child strands it for the full 5-minute timeout, and every
 * later Add account / Connect dies with "another sign-in is already in
 * progress" — app-wide, with no Cancel anywhere and no sign that anything is
 * running. For a brand-new user with no account that is a total lockout whose
 * only cures are restarting or waiting it out.
 *
 * #1107 diagnosed exactly this and its suggested fix named BOTH surfaces —
 * "`SettingsView.close()` (and the wizard's Connect step) calls
 * `accounts.cancelLogin()`" — but only Settings got the hook. The wizard is the
 * surface a first-run user is actually standing on.
 *
 * This registry is the shared version of that hook: a surface marks the login
 * it starts, settles it when it finishes, and any surface that goes away while
 * still owning one cancels it. Ownership is per-surface so dismissing Settings
 * can't cancel a sign-in the wizard started, or vice versa.
 */

/** Cancels the orchestrator's in-flight login. Injected so this is testable. */
export type CancelLogin = () => Promise<unknown>

/** The onboarding wizard's Connect step — the surface #1107 left unfixed. */
export const WIZARD_LOGIN_SURFACE = 'onboarding-wizard'

let owner: string | null = null

/** Mark a login started by `surface` as in flight. */
export function markLoginInFlight(surface: string): void {
  owner = surface
}

/** The login finished (connected, failed, or was cancelled by the user). */
export function settleLogin(surface: string): void {
  if (owner === surface) owner = null
}

/** True while `surface` owns an unsettled login. */
export function ownsLoginInFlight(surface: string): boolean {
  return owner === surface
}

/**
 * A surface is going away: cancel the login it started, if any. Fail-soft and
 * idempotent — nothing in flight, or a login another surface owns, is a no-op,
 * and a rejected cancel is swallowed (the surface is closing either way).
 */
export function cancelLoginOwnedBy(surface: string, cancel: CancelLogin | undefined): void {
  if (owner !== surface) return
  owner = null
  void cancel?.()?.catch?.(() => undefined)
}

/** Test seam — drop any recorded ownership. */
export function resetLoginInFlight(): void {
  owner = null
}
