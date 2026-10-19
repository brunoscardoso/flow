/**
 * The single capture boundary for the embedded browser (Phase 6).
 *
 * Every capture — element, console, network — flows through `redactAndBound`
 * before it becomes a composer chip: secret-looking values are redacted, and
 * oversized network bodies are DROPPED with `withheld:true` (allowed-pattern
 * #18 — bound at the boundary; withheld is never rendered as empty).
 *
 * WHY THIS LIVES IN `shared/`, NOT `main/browser/` (a deliberate deviation from
 * the plan's `app/src/main/browser/capture-boundary.ts` path): element captures
 * flow guest → renderer and NEVER pass through the main process, while
 * console/network captures flow through main. For ONE code path
 * (allowed-pattern #14) both sides must import the SAME boundary — so it has to
 * be DOM-free and compiled by both tsconfigs, exactly like
 * browser-capture-types.ts. `controller.ts` calls it on the console/network tag
 * paths; `browser-capture-chip.ts` calls it renderer-side for element captures.
 *
 * DOM-FREE BY CONTRACT — names no DOM type; measures body size in characters
 * (a monotonic proxy for size, no `Buffer`/`TextEncoder` dependency). Pure and
 * non-mutating: every branch returns a NEW object (forbidden-pattern #4).
 *
 * Redaction is BEST-EFFORT. It errs toward over-redaction (a leaked token in a
 * chat reaches the agent and the transcript), so a few generic high-entropy
 * patterns are included even at the cost of occasionally masking benign values.
 */
import type {
  BrowserCapture,
  BrowserConsoleCapture,
  BrowserElementCapture,
  BrowserNetworkCapture,
  BrowserNetworkPayload,
} from './browser-capture-types'

/** What a redacted value is replaced with. */
export const REDACTED = '[redacted]'

/** Network bodies longer than this are dropped and flagged `withheld:true`. */
export const MAX_BODY_CHARS = 8 * 1024

/** Header NAMES redacted wholesale, whatever their value. */
const SENSITIVE_HEADER_NAME =
  /(authorization|proxy-authorization|cookie|set-cookie|x-api-key|x-auth-token|x-amz-security-token|x-csrf-token|api[-_]?key|secret|token|password|session)/i

/**
 * `key=value` / `key: value` assignments for sensitive keys — redact the VALUE,
 * keep the key so the reader still sees WHICH secret was present.
 *
 * THE OPTIONAL QUOTE BEFORE THE SEPARATOR IS NOT COSMETIC. A server printing
 * its environment writes `{"DATABASE_PASSWORD": "hunter2"}` — the key is
 * QUOTED, so a pattern expecting `password` immediately before `:` matches
 * nothing and the password goes into the artifact intact. Found 2026-09-19 by
 * running this over real server-log shapes instead of browser fixtures
 * (forbidden-pattern #19); it had been correct for every header it was written
 * against and wrong for the first env dump it met.
 *
 * `cookie` / `set-cookie` are here as well as in the header list, because a
 * backend that logs an upstream response prints the header into free TEXT,
 * where the header rule cannot see it.
 */
const SECRET_ASSIGNMENT =
  /((?:api[-_]?key|apikey|secret|token|access[-_]?token|refresh[-_]?token|client[-_]?secret|password|passwd|pwd|authorization|set-cookie|cookie)["']?\s*[=:]\s*)(["']?)([^\s"'&,;]+)\2/gi

/**
 * Credentials inside a connection string — `scheme://user:password@host`.
 *
 * A browser never prints one; a backend prints one on almost every boot
 * (`postgresql://svc:pass@db:5432/x`, `redis://:pass@cache:6379`, an AMQP or
 * Mongo URL). The PASSWORD is replaced and the user and host are kept, because
 * "which database could it not reach" is the question somebody is recording the
 * session to answer.
 */
const URL_CREDENTIALS = /([a-z][a-z0-9+.-]*:\/\/[^\s:@/]*:)([^\s@/]+)(@)/gi

/** Standalone secret-shaped tokens (order: specific → generic). */
const SECRET_TOKENS: readonly RegExp[] = [
  /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]+/g, // JWT (header.payload.sig)
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g, // GitHub tokens (ghp_/gho_/…)
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/gi, // Slack
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key id
  /\bAIza[0-9A-Za-z_-]{20,}/g, // Google API key
  /\b(?:sk|pk|rk)[-_](?:live|test|prod)?[-_]?[A-Za-z0-9]{16,}/gi, // Stripe-style
  /\b[0-9a-fA-F]{32,}\b/g, // long hex (hashes, session ids, tokens)
  /\b[A-Za-z0-9+/]{40,}={0,2}\b/g, // long base64-ish blobs
]

/**
 * Redact secret-looking substrings from free text. Assignments first (so
 * `token=abcdef` masks only the value), then `Bearer <token>`, then standalone
 * token shapes. Idempotent — re-running over an already-redacted string is a
 * safe no-op, which is why the renderer chip model can run it defensively over
 * captures that main already redacted.
 */
export function redactSecrets(input: string): string {
  if (input.length === 0) return input
  // THE VALUE'S QUOTES SURVIVE. A redacted body is still read — by a person,
  // and by anything that parses it — so `{"token":"[redacted]"}` is right and
  // `{"token":[redacted]}` is broken JSON that merely looks redacted.
  let out = input.replace(
    SECRET_ASSIGNMENT,
    (_match, prefix: string, quote: string) => `${prefix}${quote}${REDACTED}${quote}`,
  )
  // BEFORE the standalone shapes: a connection string's password is often
  // short and ordinary-looking, so nothing below would catch it, and the URL is
  // the only context that proves it is a credential at all.
  out = out.replace(
    URL_CREDENTIALS,
    (_match, prefix: string, _secret: string, at: string) => `${prefix}${REDACTED}${at}`,
  )
  out = out.replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, `Bearer ${REDACTED}`)
  for (const pattern of SECRET_TOKENS) out = out.replace(pattern, REDACTED)
  return out
}

/** A fresh headers record with sensitive names masked and values scrubbed. */
function redactHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [name, value] of Object.entries(headers)) {
    out[name] = SENSITIVE_HEADER_NAME.test(name) ? REDACTED : redactSecrets(value)
  }
  return out
}

/** Bound a single body: absent → absent; oversized → withheld; else redacted. */
function boundBody(body: string | undefined): { value?: string; withheld: boolean } {
  if (body === undefined) return { withheld: false }
  if (body.length > MAX_BODY_CHARS) return { withheld: true }
  return { value: redactSecrets(body), withheld: false }
}

function boundElement(capture: BrowserElementCapture): BrowserElementCapture {
  const { payload } = capture
  const props =
    payload.props === undefined
      ? undefined
      : Object.fromEntries(
          Object.entries(payload.props).map(([key, value]) => [key, redactSecrets(value)]),
        )
  return {
    ...capture,
    redacted: true,
    payload: {
      ...payload,
      domSummary: redactSecrets(payload.domSummary),
      ...(props === undefined ? {} : { props }),
    },
  }
}

function boundConsole(capture: BrowserConsoleCapture): BrowserConsoleCapture {
  const { payload } = capture
  return {
    ...capture,
    redacted: true,
    payload: {
      ...payload,
      text: redactSecrets(payload.text),
      ...(payload.stack === undefined ? {} : { stack: redactSecrets(payload.stack) }),
    },
  }
}

function boundNetwork(capture: BrowserNetworkCapture): BrowserNetworkCapture {
  const { payload } = capture
  const requestBody = boundBody(payload.requestBody)
  const responseBody = boundBody(payload.responseBody)
  const withheld = requestBody.withheld || responseBody.withheld || capture.withheld === true
  // Build the payload EXPLICITLY rather than spreading `payload` — a spread would
  // re-introduce the very body we just decided to withhold. A withheld body is
  // simply absent from the output; the `withheld` flag carries the "load on
  // demand" meaning (never rendered as empty).
  const nextPayload: BrowserNetworkPayload = {
    method: payload.method,
    url: payload.url,
    status: payload.status,
    timingMs: payload.timingMs,
    ts: payload.ts,
    requestHeaders: redactHeaders(payload.requestHeaders),
    responseHeaders: redactHeaders(payload.responseHeaders),
    ...(requestBody.value === undefined ? {} : { requestBody: requestBody.value }),
    ...(responseBody.value === undefined ? {} : { responseBody: responseBody.value }),
  }
  return {
    ...capture,
    redacted: true,
    ...(withheld ? { withheld: true } : {}),
    payload: nextPayload,
  }
}

/**
 * Redact secrets and bound oversized payloads for one capture. Pure — returns a
 * new object, never mutates the input — and always sets `redacted:true`. The
 * exhaustive switch over the discriminated union means a new kind is a compile
 * error here, not a silent unredacted passthrough.
 */
export function redactAndBound(capture: BrowserCapture): BrowserCapture {
  switch (capture.kind) {
    case 'element':
      return boundElement(capture)
    case 'console':
      return boundConsole(capture)
    case 'network':
      return boundNetwork(capture)
  }
}
