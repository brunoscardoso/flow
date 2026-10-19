/**
 * ONE SIGN-IN STATE — every change to who is signed in goes through here, and
 * every change is told to every window.
 *
 * Sharing authorises its requests with the same session token Flow's sign-in
 * stores. When the share host refused that token (the server's signing secret
 * rotated, the session ran out, the account was disabled), the share client
 * used to turn the refusal into "Sign in to share" and tell nobody else — so
 * Settings went on naming a person whose sign-in no longer worked anywhere.
 * Two views of one sign-in disagreed.
 *
 * Now a rejected session is cleared HERE, through the identity store's own
 * sign-out, and an `auth:changed` broadcast makes every surface re-read the
 * state it draws. Sign-in and sign-out from Settings take the same path, so a
 * feature view open beside Settings follows them too (allowed-pattern #14: the
 * invariant lives in one code path).
 *
 * ── ONLY THE TOKEN THAT WAS REJECTED IS CLEARED ─────────────────────────────
 *
 * A request can be in flight while somebody signs in again. Its 401 is about
 * the OLD token; clearing whatever is stored when it lands would sign out the
 * fresh session the person just made. So a rejection names the token it was
 * about, and nothing is removed unless that is still the one stored.
 *
 * Every dependency is required (forbidden-pattern #15): this module removes a
 * credential, so a caller has to say which store it means.
 */
import type { AuthChangeCause } from '../../shared/ipc-contract'
import type { SignOutReport, StoredIdentity } from './identity-store'

export type { AuthChangeCause }

/** Why a presented session was refused — the share host's words, or a local expiry. */
export type SessionRejectionReason = 'unauthenticated' | 'session-expired' | 'identity-disabled'

/** A session that was really presented (or found expired) and refused. */
export interface RejectedSession {
  reason: SessionRejectionReason
  /** The token that was refused. Stays in main; compared, never logged. */
  token: string
}

export interface AuthSessionDeps {
  /** The identity store: read to compare, signed out to clear. */
  store: {
    load(): StoredIdentity | null
    signOut(): SignOutReport
  }
  /** Tell every window that the sign-in state changed. */
  broadcast: (change: { cause: AuthChangeCause }) => void
}

export interface AuthSession {
  /** A sign-in just succeeded and was saved. */
  signedIn(): void
  /** The person asked to sign out. Reports what it did. */
  signOut(): SignOutReport
  /**
   * A presented session was refused. Clears it when it is still the stored
   * one, and says whether it did.
   */
  sessionRejected(rejected: RejectedSession): boolean
}

export function createAuthSession(deps: AuthSessionDeps): AuthSession {
  const tell = (cause: AuthChangeCause): void => {
    try {
      deps.broadcast({ cause })
    } catch (error) {
      // A window that went away mid-send must not turn a sign-out into a
      // failure; the state itself has already changed.
      console.warn('[Auth] sign-in change could not be broadcast', { cause, error: String(error) })
    }
  }

  return {
    signedIn(): void {
      tell('signed-in')
    },

    signOut(): SignOutReport {
      const report = deps.store.signOut()
      tell('signed-out')
      return report
    },

    sessionRejected(rejected: RejectedSession): boolean {
      let held: StoredIdentity | null
      try {
        held = deps.store.load()
      } catch {
        held = null
      }
      // Already gone, or replaced by a newer sign-in: nothing of the rejected
      // session is left to clear, and the newer one must not be touched.
      if (held === null || held.token !== rejected.token) return false
      const report = deps.store.signOut()
      if (!report.removed) {
        console.warn('[Auth] a rejected sign-in could not be removed', { reason: rejected.reason })
      }
      console.info('[Auth] signed out: the session was refused', { reason: rejected.reason })
      tell('session-rejected')
      return report.removed
    },
  }
}
