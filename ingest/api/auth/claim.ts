/**
 * POST /api/auth/claim — the app collects its session.
 *
 * The browser came back to the server, so the session was issued there; this is
 * how it reaches the app WITHOUT travelling through a URL. A URL lands in
 * browser history, in a referrer, and in whatever the person's browser syncs,
 * and a session token is exactly the thing that must not.
 *
 * ONE COLLECTION PER AUTHORIZATION. `claimed_at` is set conditionally, so two
 * claims racing cannot both succeed, and a second attempt is refused as the
 * replay it is.
 */

import { claimable, failureResponse, judgeClaimBody } from '../../lib/auth-core.js'
import type { AuthDb } from '../../lib/auth-db.js'

interface VercelRequest {
  method?: string
  body?: unknown
}
interface VercelResponse {
  status(code: number): VercelResponse
  json(body: unknown): void
}

export async function handleClaim(
  request: VercelRequest,
  response: VercelResponse,
  db: AuthDb,
  now: number = Date.now(),
): Promise<void> {
  if (request.method !== 'POST') {
    response.status(405).json({ error: 'method not allowed' })
    return
  }
  const judged = judgeClaimBody(request.body)
  if (!judged.ok) {
    response.status(judged.status).json({ error: judged.reason })
    return
  }
  try {
    const record = await db.readClaim(judged.state)
    const verdict = claimable(record, now)
    if (!verdict.ok) {
      const { status, reason } = failureResponse(verdict.failure)
      response.status(status).json({ error: reason })
      return
    }
    await db.markClaimed(judged.state)
    response.status(200).json({
      token: verdict.token,
      subject: record?.subject ?? '',
      displayName: record?.displayName ?? null,
      expiresAt: record?.expiresAt ?? null,
    })
  } catch {
    response.status(503).json({ error: 'unavailable' })
  }
}

export default async function claim(
  request: VercelRequest,
  response: VercelResponse,
): Promise<void> {
  const { createAuthDb } = await import('../../lib/auth-db.js')
  await handleClaim(request, response, createAuthDb())
}
