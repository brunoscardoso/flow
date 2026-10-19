/**
 * WHAT THE SIGN-IN SECTION SAYS, for each state it can be in.
 *
 * DOM-free, like `privacy-model.ts` beside it and for the same reason: the
 * sentences are the part worth pinning, and this app's jest cannot import a
 * module that touches `document`.
 *
 * ── SIGNING IN BUYS NOTHING TODAY, AND THE COPY MUST NOT PRETEND ────────────
 *
 * The reason to sign in is sync across machines, and sync does not exist. The
 * discovery recorded that tension rather than resolving it, and this is where
 * it lands: the section says what signing in DOES (ties this installation to
 * you) and does not promise what it WILL do. A promise with no date is noticed
 * by exactly the people who acted on it.
 */

export type SignInState =
  | { kind: 'unavailable' }
  | { kind: 'signed-out' }
  | { kind: 'signed-in'; displayName: string | null; subject: string }

export interface SignInCopy {
  /** What this section is about, in one line. */
  hint: string
  /** Who you are, or null when nobody is. */
  who: string | null
  /** The action's label, or null when there is no action to offer. */
  action: string | null
}

export function signInCopy(state: SignInState): SignInCopy {
  switch (state.kind) {
    case 'unavailable':
      // NO BUTTON AT ALL. A control that cannot work is worse than its absence,
      // and this is the state of every build until a provider is configured.
      return {
        hint: "Signing in isn't available in this build of Flow.",
        who: null,
        action: null,
      }
    case 'signed-out':
      return {
        hint: 'Sign in to tie this installation to you. Nothing about how Flow works changes either way, and you can sign out whenever you like.',
        who: null,
        action: 'Sign in with GitHub',
      }
    case 'signed-in':
      return {
        hint: 'This installation is tied to you. Signing out removes it from this computer and changes nothing else.',
        // THE NAME IF THERE IS ONE. A subject is an id, and showing somebody
        // `github|1234567` as "who you are" is the app talking to itself.
        who: state.displayName ?? 'Signed in',
        action: 'Sign out',
      }
  }
}

/** The state, from what the channels answered. Keeps the branching in one place. */
export function signInStateFrom(
  available: boolean,
  identity: { subject: string; displayName: string | null } | null,
): SignInState {
  if (!available && identity === null) return { kind: 'unavailable' }
  // SIGNED IN BEATS UNAVAILABLE. A build whose provider was removed should
  // still show somebody who they are and let them sign out — stranding a stored
  // identity with no way to clear it is worse than showing a control.
  if (identity !== null) {
    return { kind: 'signed-in', displayName: identity.displayName, subject: identity.subject }
  }
  return { kind: 'signed-out' }
}
