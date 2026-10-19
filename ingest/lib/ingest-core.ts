/**
 * THE INGEST FUNCTION'S DECISIONS, as pure functions.
 *
 * Everything the endpoint has to get right — is this caller allowed, is this
 * body plausible, has this installation sent too much — decided here, with no
 * network, no database and no framework, so each rule has a test rather than a
 * deployment.
 *
 * ── WHAT THIS ENDPOINT IS, AND WHAT IT IS NOT ───────────────────────────────
 *
 * It accepts events from a desktop app whose ingest key is readable by anyone
 * who unzips it. That is not a flaw to be patched — it is the shape of the
 * problem — so the key is a WRITE-ONLY door, and this function is written on the
 * assumption that anyone can knock on it:
 *
 *   - it never reads anything back, so a stolen key cannot exfiltrate
 *   - it bounds every dimension of a request, so a key-holder cannot exhaust
 *     the database by being enthusiastic
 *   - it stores what it is given as a DOCUMENT rather than trusting the shape,
 *     because a shipped binary keeps posting the shape it was built with for
 *     months and no migration ever reaches a copy installed in March
 */

/** Hard bounds. Generous for a real client, ruinous for nobody. */
export const LIMITS = {
  /** The client batches at 50; the server does not take the client's word. */
  maxEventsPerRequest: 100,
  /** A whole request. Events are counts and durations, a few hundred bytes. */
  maxBodyBytes: 256 * 1024,
  /** One event, serialized. */
  maxEventBytes: 8 * 1024,
  /** Keys on one event — the contract has ~19; this is room, not a target. */
  maxFieldsPerEvent: 40,
  /** Any single string value. An install id is 16 chars; a version is ~8. */
  maxValueLength: 512,
}

/** Per-installation rate limit. */
export const RATE = {
  windowMs: 60 * 60_000,
  /** Events per install per hour. A busy day is a few dozen. */
  maxEventsPerWindow: 500,
}

export type Rejection = { status: number; reason: string }
export type Accepted = { installId: string | null; events: Record<string, unknown>[] }
export type IngestJudgement = { ok: true; value: Accepted } | { ok: false; error: Rejection }

/**
 * Is this caller holding the key?
 *
 * CONSTANT-TIME, and length-checked first because the comparison throws on a
 * mismatch. The key is high-entropy so timing is not the realistic attack, but
 * a leaking comparison is a habit, and the habit is what ends up next to
 * something short.
 */
export function isAuthorized(header: string | undefined, expected: string): boolean {
  if (expected === '') return false // an unconfigured server authorizes nobody
  const prefix = 'Bearer '
  if (header === undefined || !header.startsWith(prefix)) return false
  const given = header.slice(prefix.length)
  return constantTimeEquals(given, expected)
}

function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

/**
 * Judge a request body.
 *
 * Returns the events to store, or the refusal to send back. Every bound is
 * checked here rather than at the database, because the point of a bound is to
 * be cheap — a 40 MB body rejected after being parsed into rows has already
 * cost what it was going to cost.
 */
export function judgeBody(raw: unknown, byteLength: number): IngestJudgement {
  if (byteLength > LIMITS.maxBodyBytes) {
    return { ok: false, error: { status: 413, reason: 'body too large' } }
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, error: { status: 400, reason: 'expected an object' } }
  }
  const events = (raw as Record<string, unknown>)['events']
  if (!Array.isArray(events)) {
    return { ok: false, error: { status: 400, reason: 'expected an events array' } }
  }
  if (events.length === 0) {
    return { ok: false, error: { status: 400, reason: 'no events' } }
  }
  if (events.length > LIMITS.maxEventsPerRequest) {
    return { ok: false, error: { status: 413, reason: 'too many events in one request' } }
  }

  const checked: Record<string, unknown>[] = []
  for (const event of events) {
    if (typeof event !== 'object' || event === null || Array.isArray(event)) {
      return { ok: false, error: { status: 400, reason: 'an event was not an object' } }
    }
    const record = event as Record<string, unknown>
    const keys = Object.keys(record)
    if (keys.length > LIMITS.maxFieldsPerEvent) {
      return { ok: false, error: { status: 400, reason: 'an event had too many fields' } }
    }
    for (const key of keys) {
      const value = record[key]
      if (typeof value === 'string' && value.length > LIMITS.maxValueLength) {
        return { ok: false, error: { status: 400, reason: 'a value was too long' } }
      }
      // Nested objects are not part of this contract and are the cheapest way
      // to smuggle bulk past a field count.
      if (typeof value === 'object' && value !== null) {
        return { ok: false, error: { status: 400, reason: 'a value was not a scalar' } }
      }
    }
    if (JSON.stringify(record).length > LIMITS.maxEventBytes) {
      return { ok: false, error: { status: 400, reason: 'an event was too large' } }
    }
    checked.push(record)
  }

  return { ok: true, value: { installId: installIdOf(checked), events: checked } }
}

/**
 * The installation a batch belongs to, for rate limiting.
 *
 * NULL WHEN THE BATCH DOES NOT AGREE WITH ITSELF. A client sends one
 * installation's events; a batch carrying two is either a bug or somebody
 * spreading their traffic across ids to evade a limit. Either way it is not a
 * batch this endpoint knows how to count, and the caller treats null as
 * unattributable.
 */
function installIdOf(events: Record<string, unknown>[]): string | null {
  const ids = new Set<string>()
  for (const event of events) {
    const id = event['installId']
    if (typeof id === 'string' && id !== '') ids.add(id)
  }
  return ids.size === 1 ? ([...ids][0] as string) : null
}

/**
 * Has this installation sent too much?
 *
 * Pure: given what has been counted in the current window, say yes or no. The
 * counting itself is the caller's, because it is the part that needs a database.
 */
export function isOverLimit(countInWindow: number, incoming: number): boolean {
  return countInWindow + incoming > RATE.maxEventsPerWindow
}

/** Which window a moment falls in — the bucket a counter is keyed by. */
export function windowStart(now: number): number {
  return Math.floor(now / RATE.windowMs) * RATE.windowMs
}

/**
 * An UNATTRIBUTABLE batch is accepted but never counted.
 *
 * Refusing it would reject a legitimate client whose first batch predates an
 * install id; counting it under one bucket would let every anonymous poster
 * exhaust one another's budget. It is bounded by the request limits above like
 * everything else, and that is the only bound it gets — a deliberate, stated
 * acceptance rather than an oversight.
 */
export function shouldCount(installId: string | null): installId is string {
  return installId !== null
}
