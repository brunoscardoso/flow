/**
 * WHERE FLOW SIGNS PEOPLE IN — decided at BUILD time, absent by default.
 *
 * The same shape as `telemetry-endpoint.ts`, for the same reason: a desktop app
 * cannot be configured after it ships, and a build made from a clone must point
 * nowhere at all.
 *
 * `__FLOW_AUTH_ENDPOINT__` and `__FLOW_GITHUB_CLIENT_ID__` are substituted by
 * `electron.vite.config.ts` from the builder's environment. Unset compiles to
 * the empty string, `configuredProvider()` reports "nowhere", and no sign-in is
 * offered — not a sign-in that cannot work.
 *
 * ── THE CLIENT ID IS PUBLIC, AND THAT IS THE DESIGN ─────────────────────────
 *
 * Unlike the ingest key, a GitHub OAuth client id is MEANT to be public — it
 * appears in every authorization URL a browser ever sees. What must not ship is
 * the client SECRET, and it does not: the exchange happens on the function.
 * `assertNotASecret` is the tripwire for somebody pasting the wrong half of the
 * pair, which is the one mistake that would matter here.
 */

/** Substituted at build time; `''` when the build configured no sign-in. */
declare const __FLOW_AUTH_ENDPOINT__: string
/** Substituted at build time; `''` when the build configured no sign-in. */
declare const __FLOW_GITHUB_CLIENT_ID__: string

export interface FlowAuthProvider {
  /** Base URL of the auth routes, e.g. https://…/api/auth */
  endpoint: string
  /** GitHub's public client id for this app. */
  clientId: string
}

/**
 * Shapes a client id must never have.
 *
 * A GitHub client SECRET is a 40-char hex string; a client ID looks like
 * `Iv1.xxxxxxxx` or `Ov23li…`. Anything that looks like the secret half, or like
 * any other credential, is refused — the same tripwire the telemetry key has,
 * for the same reason: the mistake is made at 2am by a person copying two
 * similar-looking values out of one page.
 */
export function assertNotASecret(clientId: string): string | null {
  if (/^[0-9a-f]{40}$/i.test(clientId)) {
    return 'that looks like a GitHub client SECRET, which must never ship in the app — use the client ID'
  }
  if (/^(gh[pousr]_|sk-|postgres)/i.test(clientId)) {
    return 'that is a credential, not a GitHub client ID'
  }
  return null
}

/**
 * The provider this build was made with, or null when it was made without one.
 *
 * NULL IS THE ORDINARY CASE: no GitHub app is configured yet, and a developer
 * building from a clone should offer no sign-in at all.
 */
export function configuredProvider(read?: {
  endpoint?: string
  clientId?: string
}): FlowAuthProvider | null {
  const endpoint = (read?.endpoint ?? safeRead(() => __FLOW_AUTH_ENDPOINT__)).trim()
  const clientId = (read?.clientId ?? safeRead(() => __FLOW_GITHUB_CLIENT_ID__)).trim()
  if (endpoint === '' || clientId === '') return null
  // HTTPS OR NOTHING — a sign-in over plaintext would put an authorization code
  // on the wire in the clear on every café network the app is opened on.
  if (!endpoint.startsWith('https://')) return null
  if (assertNotASecret(clientId) !== null) return null
  return { endpoint: endpoint.replace(/\/+$/, ''), clientId }
}

function safeRead(read: () => string): string {
  try {
    const value = read()
    return typeof value === 'string' ? value : ''
  } catch {
    return ''
  }
}

/**
 * Exchange an authorization code for a Flow session, via the function.
 *
 * This is the seam `signIn()` has always taken and never had an implementation
 * for. It posts to the callback route and returns exactly what the identity
 * store expects.
 *
 * NOTHING GITHUB-SHAPED CROSSES BACK. The function answers with Flow's own
 * session; the GitHub token was used once, on the server, to read an identity.
 */
export async function exchangeWithFlow(input: {
  endpoint: string
  code: string
  state: string
  fetchFn?: typeof fetch
}): Promise<{ subject: string; displayName: string | null; token: string; expiresAt: number | null }> {
  const doFetch = input.fetchFn ?? fetch
  // THE CLAIM, not an exchange. The server did the exchange when GitHub
  // redirected to it; this collects the session over the app's own connection so
  // the token never travels through a browser URL.
  const response = await doFetch(`${input.endpoint}/claim`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ state: input.state }),
  })
  if (!response.ok) throw new Error(`sign-in claim returned ${response.status}`)
  const body = (await response.json()) as {
    token?: unknown
    subject?: unknown
    displayName?: unknown
    expiresAt?: unknown
  }
  if (typeof body.token !== 'string' || body.token === '') throw new Error('no session returned')
  if (typeof body.subject !== 'string' || body.subject === '') throw new Error('no subject returned')
  return {
    subject: body.subject,
    displayName: typeof body.displayName === 'string' ? body.displayName : null,
    token: body.token,
    expiresAt: typeof body.expiresAt === 'number' ? body.expiresAt : null,
  }
}

/**
 * Ask the function to begin a sign-in.
 *
 * The SERVER decides the authorization URL and the state, so the state the
 * callback is judged against is one the server issued — see the route's header.
 */
export async function beginWithFlow(input: {
  endpoint: string
  redirectUri: string
  fetchFn?: typeof fetch
}): Promise<{ url: string; state: string }> {
  const doFetch = input.fetchFn ?? fetch
  const response = await doFetch(`${input.endpoint}/start`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ redirectUri: input.redirectUri }),
  })
  if (!response.ok) throw new Error(`sign-in start returned ${response.status}`)
  const body = (await response.json()) as { url?: unknown; state?: unknown }
  if (typeof body.url !== 'string' || !body.url.startsWith('https://github.com/')) {
    throw new Error('sign-in start did not return a GitHub URL')
  }
  if (typeof body.state !== 'string' || body.state === '') throw new Error('no state returned')
  return { url: body.url, state: body.state }
}
