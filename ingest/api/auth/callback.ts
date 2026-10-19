/**
 * GET /api/auth/callback — where GITHUB comes back to.
 *
 * A BROWSER ARRIVES HERE, not the app. GitHub validates `redirect_uri` against
 * the one callback the OAuth App registered, and a desktop app's loopback port
 * changes every run — so the server is the registered party and this is the
 * registered URL. The first version of this pointed GitHub at the loopback and
 * GitHub refused it by name: "The redirect_uri is not associated with this
 * application."
 *
 * THE SECRET LIVES HERE AND NOWHERE ELSE, which was right all along and is the
 * reason the server has to be the one GitHub returns to.
 *
 * WHAT COMES BACK IS FLOW'S OWN SESSION, not GitHub's token: the GitHub token
 * is used once, to read an identity, and is never stored or returned.
 *
 * ONLY THE STATE TRAVELS ONWARD. The session is parked against the state and
 * the browser is redirected to the app's loopback carrying nothing else — a URL
 * lands in history, in a referrer, and in whatever the browser syncs. The app
 * trades the state for the session over its own connection (`claim.ts`).
 */

import {
  SESSION_TTL_MS,
  failureResponse,
  handBackUrl,
  signSession,
  stateUsable,
  usableSessionSecret,
  type SignInFailure,
} from '../../lib/auth-core.js'
import type { AuthDb } from '../../lib/auth-db.js'

interface VercelRequest {
  method?: string
  query?: Record<string, string | string[] | undefined>
  url?: string
}
interface VercelResponse {
  status(code: number): VercelResponse
  json(body: unknown): void
  setHeader(name: string, value: string): void
  end(body?: string): void
}

/** What GitHub tells us about a person. Injected, so tests need no network. */
export interface GithubExchange {
  (code: string): Promise<{ subject: string; displayName: string | null } | null>
}

/** A page for the person, when there is nowhere to send them back to. */
function page(message: string): string {
  return (
    `<!doctype html><meta charset="utf-8"><title>Flow</title>` +
    `<body style="font:16px system-ui;padding:3rem;max-width:32rem;margin:auto">` +
    `<p>${message}</p><p style="color:#666">You can close this tab.</p></body>`
  )
}

function one(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? '') : (value ?? '')
}

export async function handleCallback(
  request: VercelRequest,
  response: VercelResponse,
  db: AuthDb,
  exchange: GithubExchange,
  now: number = Date.now(),
  // Untrimmed and at least 32 bytes, exactly as planflow.sh reads it; anything
  // else is '' — refused below, like an absent secret.
  secret: string = usableSessionSecret(process.env['SESSION_SECRET']),
): Promise<void> {
  // A BROWSER FOLLOWING A REDIRECT, so GET — not the POST the first version
  // took. GitHub decides the method here, not us.
  if (request.method !== undefined && request.method !== 'GET') {
    response.status(405).json({ error: 'method not allowed' })
    return
  }

  const query = request.query ?? {}
  const state = one(query['state'])
  const code = one(query['code'])
  const error = one(query['error'])

  const fail = (failure: SignInFailure, redirect: string | null): void => {
    const { status, reason } = failureResponse(failure)
    // BACK TO THE APP EVEN WHEN IT FAILED, if we know where it came from —
    // leaving somebody on a server page while the app waits out a five-minute
    // deadline is the worst of both.
    const back = redirect === null ? null : handBackUrl(redirect, state)
    if (back !== null) {
      const url = new URL(back)
      url.searchParams.set('error', failure)
      response.setHeader('location', url.toString())
      response.status(302).end()
      return
    }
    response.setHeader('content-type', 'text/html; charset=utf-8')
    response.status(status).end(page(reason))
  }

  if (secret === '') {
    fail('exchange-failed', null)
    return
  }
  if (state === '') {
    response.setHeader('content-type', 'text/html; charset=utf-8')
    response.status(400).end(page('That sign-in could not be completed.'))
    return
  }

  let redirect: string | null = null
  try {
    redirect = await db.readRedirect(state)

    // THE PERSON SAID NO. Distinct from a failure, and they should land back in
    // the app rather than on a page telling them what they already know.
    if (error !== '') {
      fail('declined', redirect)
      return
    }

    const usable = stateUsable(await db.readState(state), now)
    if (!usable.ok) {
      fail(usable.failure, redirect)
      return
    }
    if (code === '') {
      fail('exchange-failed', redirect)
      return
    }

    // RETIRED BEFORE THE EXCHANGE. A code that fails to exchange has still had
    // its authorization spent, and leaving the state open would let the same
    // one be retried — the replay this exists to stop.
    await db.retireState(state)

    const identity = await exchange(code)
    if (identity === null || identity.subject === '') {
      fail(identity === null ? 'exchange-failed' : 'no-identity', redirect)
      return
    }

    await db.rememberIdentity(identity.subject, 'github', identity.displayName)
    const expiresAt = now + SESSION_TTL_MS
    await db.parkSession(state, {
      token: signSession(identity.subject, expiresAt, secret),
      subject: identity.subject,
      displayName: identity.displayName,
      expiresAt,
    })

    const back = redirect === null ? null : handBackUrl(redirect, state)
    if (back === null) {
      // Signed in, but nowhere to send them. The app will not get its session;
      // say so rather than showing a success page that is half true.
      response.setHeader('content-type', 'text/html; charset=utf-8')
      response.status(200).end(page('Signed in, but Flow could not be reached. Try again from the app.'))
      return
    }
    response.setHeader('location', back)
    response.status(302).end()
  } catch {
    fail('exchange-failed', redirect)
  }
}

/** Used once, to read an identity. The GitHub token is never kept. */
async function exchangeWithGithub(
  code: string,
): Promise<{ subject: string; displayName: string | null } | null> {
  const token = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify({
      client_id: process.env['GITHUB_CLIENT_ID'] ?? '',
      client_secret: process.env['GITHUB_CLIENT_SECRET'] ?? '',
      code,
      redirect_uri: process.env['AUTH_CALLBACK_URL'] ?? '',
    }),
  })
  if (!token.ok) return null
  const granted = (await token.json()) as { access_token?: unknown }
  if (typeof granted.access_token !== 'string' || granted.access_token === '') return null

  const who = await fetch('https://api.github.com/user', {
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${granted.access_token}`,
      'user-agent': 'flow-telemetry-ingest',
    },
  })
  if (!who.ok) return null
  const user = (await who.json()) as { id?: unknown; login?: unknown; name?: unknown }
  if (typeof user.id !== 'number') return null
  // THE NUMERIC ID, never the login: a login can be changed or given away, and
  // an identity that moves between people is not an identity.
  return {
    subject: `github|${user.id}`,
    displayName:
      typeof user.name === 'string' && user.name !== ''
        ? user.name
        : typeof user.login === 'string'
          ? user.login
          : null,
  }
}

export default async function callback(
  request: VercelRequest,
  response: VercelResponse,
): Promise<void> {
  const { createAuthDb } = await import('../../lib/auth-db.js')
  await handleCallback(request, response, createAuthDb(), exchangeWithGithub)
}
