/**
 * THE DESKTOP SIGN-IN FLOW, BEFORE THE VENDOR.
 *
 * The plan is explicit that this comes first: Electron is not a browser, and
 * the desktop half is where every hosted auth SDK is least comfortable. Proving
 * the flow against a real provider is what tells you whether a vendor is usable
 * — so none of this names one. It takes an authorization URL, a client id and
 * scopes, and works with anything that speaks OAuth 2.0 + PKCE.
 *
 * ── THE SHAPE, AND WHY THIS SHAPE ───────────────────────────────────────────
 *
 * SYSTEM BROWSER, NOT AN IN-APP WINDOW. A `BrowserWindow` pointed at a login
 * page is the pattern providers explicitly forbid (RFC 8252 §8.12) and the one
 * that trains people to type their password into whatever chrome-less window
 * appears. It also cannot see the session the person already has, so it asks
 * them to log in again when they are already logged in.
 *
 * LOOPBACK REDIRECT, NOT A CUSTOM SCHEME. `http://127.0.0.1:<random>` is
 * RFC 8252's recommendation for desktop apps: any local process can register a
 * custom scheme and silently intercept the callback, whereas a loopback port is
 * held by whoever bound it. The port is chosen by the OS at request time and
 * the server closes the moment it has an answer.
 *
 * PKCE, ALWAYS, WITH S256. The client secret cannot be kept secret in a binary
 * anyone can unzip — the same fact that makes the telemetry key write-only — so
 * the flow must be safe without one. PKCE is what makes an intercepted
 * authorization code useless.
 *
 * Pure and IO-free: every function here is a value in, a value out. The server,
 * the browser and the token exchange are `oauth-loopback.ts`'s, which is thin
 * enough to read and impossible to unit-test meaningfully. What is testable is
 * exactly what is dangerous — the verification.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

/** One sign-in attempt's secrets. Held in memory, never written anywhere. */
export interface PkcePair {
  /** Kept by the app; sent only with the code exchange. */
  verifier: string
  /** Sent in the authorization URL; a hash, safe to put in a browser. */
  challenge: string
  /** Always S256 — `plain` exists in the RFC and is worth nothing. */
  method: 'S256'
}

/**
 * A fresh verifier and its challenge.
 *
 * 32 random bytes, base64url — inside the RFC's 43..128 character window with
 * no padding to strip and nothing to normalise.
 */
export function createPkcePair(random: (n: number) => Buffer = randomBytes): PkcePair {
  const verifier = base64url(random(32))
  const challenge = base64url(createHash('sha256').update(verifier).digest())
  return { verifier, challenge, method: 'S256' }
}

/** An unguessable value tying a callback to the request that caused it. */
export function createState(random: (n: number) => Buffer = randomBytes): string {
  return base64url(random(32))
}

function base64url(buffer: Buffer): string {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export interface AuthorizationRequest {
  authorizationEndpoint: string
  clientId: string
  scopes: readonly string[]
  /** The loopback address the browser will be sent back to. */
  redirectUri: string
  state: string
  pkce: PkcePair
}

/**
 * The URL to open in the system browser.
 *
 * Built with `URL`, not string concatenation, so every value is encoded once
 * and a scope containing a space cannot smuggle a parameter.
 */
export function authorizationUrl(request: AuthorizationRequest): string {
  const url = new URL(request.authorizationEndpoint)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('client_id', request.clientId)
  url.searchParams.set('redirect_uri', request.redirectUri)
  url.searchParams.set('state', request.state)
  url.searchParams.set('code_challenge', request.pkce.challenge)
  url.searchParams.set('code_challenge_method', request.pkce.method)
  if (request.scopes.length > 0) url.searchParams.set('scope', request.scopes.join(' '))
  return url.toString()
}

/** What came back on the loopback, once it has been judged. */
export type CallbackResult =
  | { ok: true; code: string }
  | { ok: false; reason: string }

/**
 * Judge a callback.
 *
 * THIS IS THE WHOLE SECURITY SURFACE OF THE FLOW, which is why it is a pure
 * function with its own tests rather than three `if`s inside an HTTP handler.
 * Everything it refuses is something a real attack sends:
 *
 *   - a MISSING or WRONG `state` is a cross-site request forgery — somebody
 *     else's authorization code being walked into this app's session
 *   - an `error` parameter is the provider declining, and must not be read as
 *     a success with an absent code
 *   - a missing `code` on an otherwise clean callback is a malformed response,
 *     not an empty success
 *
 * The state comparison is CONSTANT-TIME. The value is high-entropy so a timing
 * attack is not the realistic threat, but a comparison that leaks is a habit,
 * and the habit is what eventually sits next to something low-entropy.
 */
export function judgeCallback(query: URLSearchParams, expectedState: string): CallbackResult {
  const error = query.get('error')
  if (error !== null && error !== '') {
    const description = query.get('error_description')
    return { ok: false, reason: description !== null && description !== '' ? description : error }
  }

  const state = query.get('state')
  if (state === null || state === '') return { ok: false, reason: 'the sign-in response carried no state' }
  if (!constantTimeEquals(state, expectedState)) {
    return { ok: false, reason: 'the sign-in response did not match the request that started it' }
  }

  const code = query.get('code')
  if (code === null || code === '') return { ok: false, reason: 'the sign-in response carried no code' }
  return { ok: true, code }
}

/**
 * Judge a HAND-BACK: the callback a SERVER sends when it did the exchange.
 *
 * `judgeCallback` above judges a provider's own redirect, which carries a code.
 * When the server is the registered party — which it must be whenever the
 * secret lives there — the browser arrives here carrying only the state, and
 * the session is collected afterwards over the app's own connection.
 *
 * The rules are otherwise identical, and in the same order: a provider's error
 * is read BEFORE the state, or a decline is reported as a forgery and somebody
 * is told something frightening and wrong.
 */
export function judgeHandBack(
  query: URLSearchParams,
  expectedState: string,
): { ok: true; state: string } | { ok: false; reason: string } {
  const error = query.get('error')
  if (error !== null && error !== '') {
    return {
      ok: false,
      reason:
        error === 'declined'
          ? 'The sign-in was declined.'
          : 'That sign-in could not be completed. You can try again.',
    }
  }
  const state = query.get('state')
  if (state === null || state === '') {
    return { ok: false, reason: 'the sign-in response carried no state' }
  }
  if (!constantTimeEquals(state, expectedState)) {
    return { ok: false, reason: 'the sign-in response did not match the request that started it' }
  }
  return { ok: true, state }
}

/** Length-safe constant-time compare of two strings. */
export function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8')
  const right = Buffer.from(b, 'utf8')
  // `timingSafeEqual` THROWS on a length mismatch, which would itself be the
  // leak. Compare lengths first and keep comparing equal-length buffers so the
  // path taken does not depend on the secret.
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

/**
 * The loopback redirect for a bound port.
 *
 * 127.0.0.1 LITERALLY, never `localhost`: the name can resolve to ::1, to a
 * hosts-file entry, or to nothing, and the redirect has to match what was
 * registered byte for byte.
 */
export function loopbackRedirectUri(port: number, path = '/callback'): string {
  return `http://127.0.0.1:${port}${path}`
}
