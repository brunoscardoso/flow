/**
 * WHERE FEATURE VIEWS ARE SHARED — decided at BUILD time, absent by default.
 *
 * The same shape as `telemetry-endpoint.ts` and `auth/flow-provider.ts`, for the
 * same reason: a desktop app cannot be configured after it ships, and a build
 * made from a clone must point nowhere at all.
 *
 * `__FLOW_SHARE_ENDPOINT__` is substituted by `electron.vite.config.ts` from the
 * builder's `FLOW_SHARE_ENDPOINT` (e.g. `https://planflow.sh`). Unset compiles
 * to the empty string, `configuredShareEndpoint()` reports "nowhere", and the
 * share client answers every call with `SHARING_UNAVAILABLE` — said plainly,
 * never a request that cannot work.
 *
 * Nothing secret lives here: the bearer is the desktop session token, read
 * from the identity store at the moment of each request.
 */

/** Substituted at build time; `''` when the build configured no share host. */
declare const __FLOW_SHARE_ENDPOINT__: string

/** What a person reads when this build has nowhere to share to. */
export const SHARING_UNAVAILABLE = "Sharing isn't available in this version of Flow."

/**
 * The share host's base URL (origin + path, no trailing slash), or null when
 * the build was made without one — or with one that is not a bare https URL.
 *
 * NULL IS THE ORDINARY CASE for a build from a clone.
 *
 * The value is PARSED, never prefix-matched: a string that starts with
 * `https://` can still carry credentials (`https://user:pw@host`), a query or a
 * fragment, and every request path is appended to whatever is returned here.
 * Any of those is a build mistake, and a mistake points nowhere.
 */
export function configuredShareEndpoint(read?: { endpoint?: string }): string | null {
  const endpoint = (read?.endpoint ?? safeRead(() => __FLOW_SHARE_ENDPOINT__)).trim()
  if (endpoint === '') return null
  let url: URL
  try {
    url = new URL(endpoint)
  } catch {
    return null
  }
  // HTTPS OR NOTHING — every request carries the author's session token in its
  // Authorization header, and a plaintext host would put it on the wire.
  if (url.protocol !== 'https:') return null
  if (url.username !== '' || url.password !== '') return null
  // `new URL` drops a bare trailing `?` / `#`; refuse those too, on the raw text.
  if (url.search !== '' || url.hash !== '' || endpoint.includes('?') || endpoint.includes('#')) return null
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`
}

/**
 * The origin share links must live on — the endpoint's own origin. A summary
 * whose `url` points anywhere else is not the share host's answer (review L-6).
 * (The viewer page is `https://planflow.sh/v/<id>` on the same origin as the
 * API `https://planflow.sh/api/shares`.)
 */
export function shareLinkOrigin(endpoint: string): string | null {
  try {
    return new URL(endpoint).origin
  } catch {
    return null
  }
}

/** `__DEFINE__` identifiers do not exist under jest; treat that as "unset". */
function safeRead(read: () => string): string {
  try {
    const value = read()
    return typeof value === 'string' ? value : ''
  } catch {
    return ''
  }
}
