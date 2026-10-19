/**
 * THE SIGN-IN DECISIONS, as pure functions.
 *
 * Same split as `ingest-core.ts`: everything that DECIDES lives here with a
 * test, and the routes are the thin part that talks to a request, a database
 * and GitHub.
 *
 * ── WHY THE EXCHANGE IS THE SERVER'S ────────────────────────────────────────
 *
 * A desktop binary cannot hold a client secret — anyone can unzip it, which is
 * the same fact that makes the telemetry key write-only. So the app opens
 * GitHub with a PUBLIC client id and a loopback redirect, gets a code back, and
 * hands that code here. The secret never leaves the server, and a stolen code is
 * worth nothing without it.
 *
 * ── THE SERVER MINTS THE STATE, NOT ONLY THE CLIENT ─────────────────────────
 *
 * The desktop flow already checks `state` itself (`oauth-desktop.ts`), and that
 * check is worth keeping — but it is a check the CLIENT makes about its own
 * request, and a client is the thing an attacker replaces. Minting the state
 * here, recording it, and retiring it on use gives the server the one thing the
 * client cannot provide: the knowledge that this authorization was started by
 * somebody, once, and has not been redeemed already.
 *
 * ── THE SESSION IS SIGNED, NOT LOOKED UP ────────────────────────────────────
 *
 * Flow's own token is an HMAC over the subject and an expiry. Verifying it costs
 * no database read and no round trip to GitHub, which is what the plan asks for.
 * The cost, stated: revoking one BEFORE it expires would need a denylist, and
 * there is none. Expiry is the only revocation today.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

/** How long a Flow session lasts. Long enough not to nag, short enough to end. */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60_000

/** How long an unredeemed authorization may sit before it is stale. */
export const STATE_TTL_MS = 10 * 60_000

/** What Flow asks GitHub for. The narrowest thing that yields an identity. */
export const GITHUB_SCOPES = ['read:user'] as const

/** An unguessable value tying a callback to the start that caused it. */
export function mintState(random: (n: number) => Buffer = randomBytes): string {
  return random(32).toString('base64url')
}

/**
 * Where the browser is sent.
 *
 * ── THE REDIRECT IS THE SERVER'S, NOT THE APP'S ─────────────────────────────
 *
 * This first sent the app's own loopback (`http://127.0.0.1:<port>/callback`),
 * which is the right pattern when a client holds its own credentials. It is the
 * WRONG one here and GitHub says so: "The redirect_uri is not associated with
 * this application."
 *
 * An OAuth App registers ONE callback URL and GitHub validates against it. A
 * loopback port changes every run and can never be that URL. The secret lives on
 * the server, so the server is the registered party, so the server is where
 * GitHub comes back to — and it hands off to the app afterwards, using the
 * loopback it recorded at `start`.
 *
 * Every test passed through this because they all used a fake provider that
 * accepted whatever it was given. The one party that enforces the rule was the
 * one party never in the loop.
 */
export function githubAuthorizeUrl(input: {
  clientId: string
  /** The SERVER's registered callback — must match GitHub's registration. */
  redirectUri: string
  state: string
}): string {
  const url = new URL('https://github.com/login/oauth/authorize')
  url.searchParams.set('client_id', input.clientId)
  url.searchParams.set('redirect_uri', input.redirectUri)
  url.searchParams.set('state', input.state)
  url.searchParams.set('scope', GITHUB_SCOPES.join(' '))
  return url.toString()
}

/**
 * A REDIRECT MUST BE ONE WE PUBLISHED.
 *
 * The client asks for a loopback port it just bound, so the exact URI cannot be
 * known in advance — but "anything the caller says" would turn this into an open
 * redirector that mails authorization codes wherever it is told. Loopback only,
 * http only (a loopback has no certificate), and a real port.
 */
export function isAllowedRedirect(uri: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(uri)
  } catch {
    return false
  }
  if (parsed.protocol !== 'http:') return false
  // 127.0.0.1 LITERALLY — `localhost` can resolve anywhere, and ::1 is a
  // different address the desktop flow never binds.
  if (parsed.hostname !== '127.0.0.1') return false
  const port = Number(parsed.port)
  if (!Number.isInteger(port) || port < 1024 || port > 65535) return false
  return parsed.search === '' && parsed.hash === ''
}

export type SessionToken = string

/** Fewest bytes the session signing secret may have: 256 bits. */
export const MIN_SESSION_SECRET_BYTES = 32

/**
 * `SESSION_SECRET` as it may be used, or '' when it may not.
 *
 * READ EXACTLY AS planflow.sh READS IT. planflow.sh verifies the tokens signed
 * here (`plan-flow-lp/src/lib/env.ts`, `requireSecret`), so both sides take the
 * value byte for byte — NOT trimmed — and both refuse one shorter than 32 bytes.
 * A secret one side trimmed and the other did not would sign tokens the other
 * calls forged; a short one is guessable offline from any token it signed.
 * '' is what the callback already treats as "not configured" and refuses.
 */
export function usableSessionSecret(raw: string | undefined): string {
  if (raw === undefined) return ''
  return Buffer.byteLength(raw, 'utf8') < MIN_SESSION_SECRET_BYTES ? '' : raw
}

/** Sign a session. `subject` is the provider's stable id for the person. */
export function signSession(
  subject: string,
  expiresAt: number,
  secret: string,
): SessionToken {
  const body = Buffer.from(JSON.stringify({ sub: subject, exp: expiresAt }), 'utf8').toString(
    'base64url',
  )
  return `${body}.${hmac(body, secret)}`
}

export type SessionVerdict =
  | { ok: true; subject: string; expiresAt: number }
  | { ok: false; reason: 'malformed' | 'bad-signature' | 'expired' }

/**
 * Verify a session, without touching a database or GitHub.
 *
 * THE SIGNATURE IS CHECKED BEFORE THE BODY IS BELIEVED. Reading `exp` out of an
 * unverified body and returning `expired` would answer a forger's question for
 * them — it tells them the body parsed, which is one bit they did not have.
 */
export function verifySession(
  token: string,
  secret: string,
  now: number,
): SessionVerdict {
  const cut = token.lastIndexOf('.')
  if (cut <= 0) return { ok: false, reason: 'malformed' }
  const body = token.slice(0, cut)
  const signature = token.slice(cut + 1)
  if (!constantTimeEquals(signature, hmac(body, secret))) {
    return { ok: false, reason: 'bad-signature' }
  }
  let parsed: { sub?: unknown; exp?: unknown }
  try {
    parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as typeof parsed
  } catch {
    return { ok: false, reason: 'malformed' }
  }
  if (typeof parsed.sub !== 'string' || parsed.sub === '') return { ok: false, reason: 'malformed' }
  if (typeof parsed.exp !== 'number') return { ok: false, reason: 'malformed' }
  if (parsed.exp <= now) return { ok: false, reason: 'expired' }
  return { ok: true, subject: parsed.sub, expiresAt: parsed.exp }
}

function hmac(body: string, secret: string): string {
  return createHmac('sha256', secret).update(body).digest('base64url')
}

function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8')
  const right = Buffer.from(b, 'utf8')
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

/**
 * What a start request may ask for.
 *
 * `redirectUri` is the only caller-controlled value and the only one that could
 * do harm, which is why it has a rule of its own above.
 */
export type StartJudgement =
  | { ok: true; redirectUri: string }
  | { ok: false; status: number; reason: string }

export function judgeStart(raw: unknown): StartJudgement {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, status: 400, reason: 'expected an object' }
  }
  const redirectUri = (raw as Record<string, unknown>)['redirectUri']
  if (typeof redirectUri !== 'string' || redirectUri === '') {
    return { ok: false, status: 400, reason: 'expected a redirectUri' }
  }
  if (!isAllowedRedirect(redirectUri)) {
    // NO ECHO of what was rejected: repeating the caller's URI back is how a
    // refusal becomes a reflection an attacker can use.
    return { ok: false, status: 400, reason: 'that redirect is not allowed' }
  }
  return { ok: true, redirectUri }
}

export type CallbackJudgement =
  | { ok: true; code: string; state: string }
  | { ok: false; status: number; reason: string }

export function judgeCallbackBody(raw: unknown): CallbackJudgement {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, status: 400, reason: 'expected an object' }
  }
  const record = raw as Record<string, unknown>
  const code = record['code']
  const state = record['state']
  if (typeof code !== 'string' || code === '' || code.length > 512) {
    return { ok: false, status: 400, reason: 'expected a code' }
  }
  if (typeof state !== 'string' || state === '' || state.length > 512) {
    return { ok: false, status: 400, reason: 'expected a state' }
  }
  return { ok: true, code, state }
}

/**
 * WHY A SIGN-IN FAILED, in this endpoint's own words.
 *
 * GitHub's messages are GitHub's — they name hosts, they change, and relaying
 * one hands a caller information about the server's own configuration. Each of
 * these is a distinct refusal because each is a distinct thing to have gone
 * wrong, and collapsing them would make the one that matters unfindable.
 */
export type SignInFailure =
  | 'unknown-state'
  | 'state-expired'
  | 'state-already-used'
  | 'declined'
  | 'exchange-failed'
  | 'no-identity'

export function failureResponse(failure: SignInFailure): { status: number; reason: string } {
  switch (failure) {
    case 'declined':
      return { status: 400, reason: 'the sign-in was declined' }
    case 'unknown-state':
    case 'state-expired':
    case 'state-already-used':
      // ONE ANSWER FOR THREE CAUSES, deliberately — the distinction is recorded
      // for us, not told to the caller, because "that state existed once" is a
      // fact a replayer would like confirmed.
      return { status: 400, reason: 'that sign-in is no longer valid — start again' }
    case 'exchange-failed':
      return { status: 502, reason: 'the sign-in could not be completed' }
    case 'no-identity':
      return { status: 502, reason: 'the sign-in did not return an identity' }
  }
}

/** Is a recorded state still usable at `now`? */
export function stateUsable(
  record: { createdAt: number; usedAt: number | null } | null,
  now: number,
): { ok: true } | { ok: false; failure: SignInFailure } {
  if (record === null) return { ok: false, failure: 'unknown-state' }
  if (record.usedAt !== null) return { ok: false, failure: 'state-already-used' }
  if (now - record.createdAt > STATE_TTL_MS) return { ok: false, failure: 'state-expired' }
  return { ok: true }
}

/**
 * Can the app collect the session this state now holds?
 *
 * TWO GATES, TWO MOMENTS. `usedAt` says GitHub's code has been spent — set when
 * the browser came back — and `claimedAt` says the app has already collected
 * the result. A flow must pass the first and fail the second: a claim before
 * the callback has nothing to give, and a second claim is a replay.
 */
export function claimable(
  record: {
    createdAt: number
    usedAt: number | null
    claimedAt: number | null
    token: string | null
  } | null,
  now: number,
): { ok: true; token: string } | { ok: false; failure: SignInFailure } {
  if (record === null) return { ok: false, failure: 'unknown-state' }
  if (record.claimedAt !== null) return { ok: false, failure: 'state-already-used' }
  if (now - record.createdAt > STATE_TTL_MS) return { ok: false, failure: 'state-expired' }
  // Nothing to collect yet — the browser has not come back.
  if (record.usedAt === null || record.token === null) {
    return { ok: false, failure: 'unknown-state' }
  }
  return { ok: true, token: record.token }
}

export type ClaimJudgement =
  | { ok: true; state: string }
  | { ok: false; status: number; reason: string }

export function judgeClaimBody(raw: unknown): ClaimJudgement {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, status: 400, reason: 'expected an object' }
  }
  const state = (raw as Record<string, unknown>)['state']
  if (typeof state !== 'string' || state === '' || state.length > 512) {
    return { ok: false, status: 400, reason: 'expected a state' }
  }
  return { ok: true, state }
}

/**
 * Where the browser is sent once the server has the session.
 *
 * ONLY THE STATE TRAVELS. The session token would otherwise sit in a URL, and a
 * URL lands in browser history, in a referrer, and in whatever the person's
 * browser syncs. The app trades the state for the token over its own connection.
 */
export function handBackUrl(loopbackRedirect: string, state: string): string | null {
  if (!isAllowedRedirect(loopbackRedirect)) return null
  const url = new URL(loopbackRedirect)
  url.searchParams.set('state', state)
  return url.toString()
}
