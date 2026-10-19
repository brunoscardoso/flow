/**
 * THE INGEST ENDPOINT — POST /api/events.
 *
 * Thin on purpose. Every decision lives in `../lib/ingest-core.ts` and has a
 * test; this is the part that talks to a request and a database, which is the
 * part that cannot be meaningfully unit-tested.
 *
 * IT NEVER READS ANYTHING BACK. There is no GET, no query parameter that
 * selects, and no response body carrying data. The key that reaches it ships
 * inside a desktop binary anyone can unzip, so the only safe thing it can do is
 * write — and "write-only" has to be true of the ENDPOINT, not just of the
 * credential's intent.
 */

import { judgeBody, isAuthorized, isOverLimit, shouldCount, windowStart } from '../lib/ingest-core.js'

interface VercelRequest {
  method?: string
  headers: Record<string, string | string[] | undefined>
  body?: unknown
}
interface VercelResponse {
  status(code: number): VercelResponse
  json(body: unknown): void
  setHeader(name: string, value: string): void
}

/** Injected in tests; the real one is created per invocation. */
export interface Db {
  /** Events already counted for this install in this window. */
  countInWindow(installId: string, windowStartMs: number): Promise<number>
  /** Store the batch and add to the window's count, atomically. */
  record(installId: string | null, windowStartMs: number, events: unknown[]): Promise<void>
}

export async function handle(
  request: VercelRequest,
  response: VercelResponse,
  db: Db,
  now: number = Date.now(),
  expectedKey: string = process.env['INGEST_KEY'] ?? '',
): Promise<void> {
  // NO CORS HEADER, DELIBERATELY. This is called by a desktop process, never by
  // a browser page. Sending `Access-Control-Allow-Origin` would invite exactly
  // the caller this endpoint has no reason to serve.
  if (request.method !== 'POST') {
    response.status(405).json({ error: 'method not allowed' })
    return
  }

  const auth = request.headers['authorization']
  if (!isAuthorized(typeof auth === 'string' ? auth : undefined, expectedKey)) {
    // NOTHING ABOUT WHY. A 401 that distinguishes "no key" from "wrong key" is
    // a key-guessing oracle.
    response.status(401).json({ error: 'unauthorized' })
    return
  }

  const raw = request.body
  const judged = judgeBody(raw, byteLengthOf(raw))
  if (!judged.ok) {
    response.status(judged.error.status).json({ error: judged.error.reason })
    return
  }

  const bucket = windowStart(now)
  const { installId, events } = judged.value

  try {
    if (shouldCount(installId)) {
      const already = await db.countInWindow(installId, bucket)
      if (isOverLimit(already, events.length)) {
        // 429 WITH NO DETAIL of how much is left — that is a budget a flooder
        // would otherwise tune against.
        response.status(429).json({ error: 'too many events' })
        return
      }
    }
    await db.record(installId, bucket, events)
  } catch {
    // A DATABASE THAT IS DOWN IS A 503, NOT A 500, and the client treats every
    // failure the same way regardless: it drops the batch and never retries.
    // So this costs a handful of counts and nothing else.
    response.status(503).json({ error: 'unavailable' })
    return
  }

  // ACCEPTED, WITH AN EMPTY BODY. Nothing is echoed: an endpoint that reflects
  // what it was given is one an attacker can use to confirm what it stores.
  response.status(202).json({})
}

function byteLengthOf(raw: unknown): number {
  try {
    return JSON.stringify(raw)?.length ?? 0
  } catch {
    // Circular, or otherwise unserializable. It cannot be stored either, and
    // reporting it as over-size gets it refused by the ordinary path.
    return Number.MAX_SAFE_INTEGER
  }
}

/**
 * THE VERCEL ENTRYPOINT.
 *
 * Vercel calls a default export with (request, response); `handle` above takes
 * its database as an argument so every decision in it can be tested against a
 * fake. This is the four lines that join the two — and the only place a real
 * connection is made.
 *
 * The db module is imported LAZILY so that a deployment whose Postgres is not
 * yet connected fails on the request rather than at module load, where the
 * failure is an opaque function crash instead of the 503 this endpoint
 * promises.
 */
export default async function ingest(
  request: VercelRequest,
  response: VercelResponse,
): Promise<void> {
  const { createDb } = await import('../lib/db.js')
  await handle(request, response, createDb())
}
