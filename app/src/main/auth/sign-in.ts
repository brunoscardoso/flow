/**
 * SIGNING IN TO FLOW — the whole thing, composed.
 *
 * `oauth-loopback.ts` knows how to run a desktop OAuth flow; `flow-provider.ts`
 * knows where Flow's own is; `identity-store.ts` knows where the result lives.
 * This is the twenty lines that join them, and the only place that knows a
 * sign-in involves all three.
 *
 * IT REPORTS, IT DOES NOT THROW. Every failure a person can meet here — the
 * build has no provider, the server is down, they closed the tab, the machine
 * has no keychain — comes back as a sentence they can read, because every one of
 * them leaves them signed out and the app working.
 */

import { configuredProvider, beginWithFlow, exchangeWithFlow } from './flow-provider'
import { signIn as runDesktopFlow } from './oauth-loopback'
import type { createIdentityStore } from './identity-store'

export type SignInOutcome =
  | { ok: true; subject: string; displayName: string | null }
  | { ok: false; reason: string }

export interface SignInDeps {
  store: ReturnType<typeof createIdentityStore>
  openExternal: (url: string) => Promise<void>
  /** Injected so a test needs no provider and no network. */
  provider?: { endpoint: string; clientId: string } | null
  fetchFn?: typeof fetch
  /**
   * How long a person has to finish, in ms.
   *
   * Exposed because without it this composition could not be tested at all
   * without waiting out the flow's five-minute default — which is a sign the
   * seam was missing, not merely inconvenient.
   */
  timeoutMs?: number
}

export async function signInToFlow(deps: SignInDeps): Promise<SignInOutcome> {
  const provider = deps.provider === undefined ? configuredProvider() : deps.provider
  if (provider === null) {
    // NOT AN ERROR — this is every build until a GitHub app exists. A surface
    // should not have offered sign-in at all; this is the backstop.
    return { ok: false, reason: 'Sign-in is not available in this build of Flow.' }
  }
  // ASKED BEFORE THE BROWSER OPENS. Sending somebody through a GitHub
  // authorization and only then discovering there is nowhere to keep the result
  // wastes their time and leaves a live session in memory with no home.
  if (!deps.store.available()) {
    return {
      ok: false,
      reason:
        "This computer has no secure place to keep a sign-in, so Flow won't store one. Everything else works exactly as it does now.",
    }
  }

  const result = await runDesktopFlow(
    {
      // The SERVER builds the authorization URL, so these are unused on this
      // path and are here because the flow's config shape asks for them.
      authorizationEndpoint: `${provider.endpoint}/start`,
      tokenEndpoint: `${provider.endpoint}/callback`,
      clientId: provider.clientId,
      scopes: [],
    },
    {
      openExternal: deps.openExternal,
      begin: (redirectUri) =>
        beginWithFlow({ endpoint: provider.endpoint, redirectUri, fetchFn: deps.fetchFn }),
      exchange: async ({ code, state }) =>
        exchangeWithFlow({ endpoint: provider.endpoint, code, state, fetchFn: deps.fetchFn }),
      ...(deps.timeoutMs === undefined ? {} : { timeoutMs: deps.timeoutMs }),
    },
  )

  if (!result.ok) return { ok: false, reason: result.reason }

  const saved = deps.store.save({
    subject: result.identity.subject,
    displayName: result.identity.displayName,
    token: result.identity.token,
    expiresAt: result.identity.expiresAt,
  })
  if (!saved.ok) return { ok: false, reason: saved.reason }

  return { ok: true, subject: result.identity.subject, displayName: result.identity.displayName }
}
