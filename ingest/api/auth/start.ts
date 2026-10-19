/**
 * POST /api/auth/start — begin a sign-in.
 *
 * Mints a state, remembers it, and returns the GitHub URL for the desktop app
 * to open in the system browser. It reads nothing back and returns nothing about
 * anybody: the only thing that leaves here is a URL the caller could mostly have
 * built themselves.
 *
 * WHY THE SERVER MINTS THE STATE. The desktop flow checks `state` itself, and
 * that check is worth keeping — but it is a check the client makes about its own
 * request, and the client is what an attacker replaces. Minting it here is how
 * the CALLBACK can know this authorization was started once and has not already
 * been redeemed.
 */

import { githubAuthorizeUrl, judgeStart, mintState } from '../../lib/auth-core.js'
import type { AuthDb } from '../../lib/auth-db.js'

interface VercelRequest {
  method?: string
  body?: unknown
}
interface VercelResponse {
  status(code: number): VercelResponse
  json(body: unknown): void
}

export async function handleStart(
  request: VercelRequest,
  response: VercelResponse,
  db: AuthDb,
  clientId: string = process.env['GITHUB_CLIENT_ID'] ?? '',
  /** THIS server's registered callback — must match GitHub's registration. */
  callbackUrl: string = process.env['AUTH_CALLBACK_URL'] ?? '',
): Promise<void> {
  if (request.method !== 'POST') {
    response.status(405).json({ error: 'method not allowed' })
    return
  }
  // AN UNCONFIGURED SERVER OFFERS NO SIGN-IN, rather than a URL that cannot
  // work. This is the state a deployment is in before anybody sets it up.
  if (clientId === '' || callbackUrl === '') {
    response.status(503).json({ error: 'sign-in is not configured' })
    return
  }

  const judged = judgeStart(request.body)
  if (!judged.ok) {
    response.status(judged.status).json({ error: judged.reason })
    return
  }

  // THE APP'S LOOPBACK IS RECORDED, NOT SENT TO GITHUB. GitHub validates
  // `redirect_uri` against the ONE callback the OAuth App registered, and a
  // loopback port changes every run. So the loopback is where the browser is
  // sent back to at the END, by us — see `callback.ts`.
  const state = mintState()
  try {
    await db.rememberState(state, judged.redirectUri)
  } catch {
    response.status(503).json({ error: 'unavailable' })
    return
  }

  response.status(200).json({
    url: githubAuthorizeUrl({ clientId, redirectUri: callbackUrl, state }),
    state,
  })
}

export default async function start(
  request: VercelRequest,
  response: VercelResponse,
): Promise<void> {
  const { createAuthDb } = await import('../../lib/auth-db.js')
  await handleStart(request, response, createAuthDb())
}
