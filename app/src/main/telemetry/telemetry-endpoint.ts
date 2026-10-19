/**
 * WHERE TELEMETRY GOES — decided at BUILD time, absent by default.
 *
 * `__FLOW_TELEMETRY_ENDPOINT__` and `__FLOW_TELEMETRY_KEY__` are substituted by
 * `electron.vite.config.ts` from the environment of whoever ran the build. A
 * build with neither set — which is every build until a host exists, and every
 * build anyone makes from a clone — compiles the string `''` in, and this
 * module reports "nowhere". The sender then accepts events and drops them,
 * which is exactly what it does today.
 *
 * ── THE KEY IS PUBLIC, AND THAT IS NOT A BUG ────────────────────────────────
 *
 * Whatever is embedded here is readable by anyone who unzips the app. There is
 * no way around that for a desktop binary, so the only safe key to ship is a
 * WRITE-ONLY INGEST key — one that can post an event and cannot read a single
 * row back. `assertWriteOnlyShape` below is a tripwire for the day somebody
 * pastes the wrong one in: it refuses anything that looks like a database URL
 * or a privileged token, at startup, loudly, in the build that did it.
 *
 * It cannot validate a key it has never seen. What it can do is stop the three
 * mistakes that are actually made — a Postgres connection string, a service-role
 * key, and a personal access token — none of which should ever reach a client.
 */

/** Substituted at build time; `''` when the build had no endpoint configured. */
declare const __FLOW_TELEMETRY_ENDPOINT__: string
/** Substituted at build time; `''` when the build had no key configured. */
declare const __FLOW_TELEMETRY_KEY__: string

export interface TelemetryEndpoint {
  url: string
  key: string
}

/**
 * Shapes that must never be shipped in a client.
 *
 * Each of these is a credential that can READ, and the whole bargain of an
 * embedded key is that it cannot.
 */
const FORBIDDEN_KEY_SHAPES: { pattern: RegExp; what: string }[] = [
  { pattern: /^postgres(?:ql)?:\/\//i, what: 'a database connection string' },
  { pattern: /^mysql:\/\//i, what: 'a database connection string' },
  { pattern: /service_role/i, what: 'a service-role key' },
  { pattern: /^gh[pousr]_/, what: 'a GitHub token' },
  { pattern: /^sk-/i, what: 'a secret API key' },
  { pattern: /^-----BEGIN/, what: 'a private key' },
]

/**
 * Refuse a key that can obviously read.
 *
 * Returns the reason, or null when nothing is wrong. A CALLER MUST FAIL ON A
 * REASON: shipping is the irreversible act here, and a warning nobody reads is
 * how the wrong key gets into a release.
 */
export function assertWriteOnlyShape(key: string): string | null {
  for (const { pattern, what } of FORBIDDEN_KEY_SHAPES) {
    if (pattern.test(key)) {
      return `the configured telemetry key looks like ${what}, which can read data — only a write-only ingest key may be shipped in a client`
    }
  }
  return null
}

/**
 * The endpoint this build was made with, or null when it was made without one.
 *
 * NULL IS THE ORDINARY CASE, not an error: no host exists yet, and a developer
 * building from a clone should never be posting anywhere.
 */
export function configuredEndpoint(read?: { url?: string; key?: string }): TelemetryEndpoint | null {
  const url = (read?.url ?? safeRead(() => __FLOW_TELEMETRY_ENDPOINT__)).trim()
  const key = (read?.key ?? safeRead(() => __FLOW_TELEMETRY_KEY__)).trim()
  if (url === '' || key === '') return null
  // HTTPS OR NOTHING. A plaintext endpoint would put install facts on the wire
  // in the clear on every café network the app is ever opened on.
  if (!url.startsWith('https://')) return null
  return { url, key }
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
