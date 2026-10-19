/**
 * WHAT A NETWORK CAPTURE ACTUALLY CONTAINS, arranged for reading.
 *
 * The drawer's network rows showed a method, a status, a URL and a duration —
 * and the payload had carried headers and bodies the whole time, captured and
 * redacted, rendered nowhere. "There is no information relevant there" (user,
 * 2026-09-21) was a rendering gap, not a capture one.
 *
 * This is the pure half: sections a reader can expand, and a cURL a reader can
 * paste. DOM-free, so the arrangement and the escaping are testable without a
 * browser — which is where the mistakes in both actually live.
 *
 * REDACTION HAS ALREADY HAPPENED. Every payload reaching here came through
 * `browser-capture-boundary.ts`, so an Authorization header is already
 * `[redacted]` and a token in a body is already gone. Nothing here re-reads
 * secrets, and the cURL it emits is safe to paste for the same reason — but it
 * is also, for the same reason, not guaranteed to REPLAY: a redacted auth
 * header is not the one the server wants. The command says so itself.
 */

import type { BrowserNetworkPayload } from './browser-capture-types'

/** One labelled block in the detail view. */
export interface DetailSection {
  title: string
  /** Name/value rows, for headers and the general block. */
  rows?: { name: string; value: string }[]
  /** A body, when there is one to show. */
  body?: string
  /** Said instead of a body when there is nothing — never rendered as empty. */
  note?: string
}

/** How much of a body the detail view prints before it is cut. */
const MAX_BODY_PREVIEW = 20_000

function headerRows(headers: Record<string, string>): { name: string; value: string }[] {
  return Object.entries(headers ?? {})
    .map(([name, value]) => ({ name, value: String(value) }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

function bodySection(
  title: string,
  body: string | undefined,
  /** True when the capture says a body existed but was not kept. */
  withheld: boolean,
): DetailSection {
  if (body !== undefined && body.length > 0) {
    return {
      title,
      body:
        body.length > MAX_BODY_PREVIEW
          ? `${body.slice(0, MAX_BODY_PREVIEW)}\n\n…${body.length - MAX_BODY_PREVIEW} more characters, truncated for display.`
          : body,
    }
  }
  // WITHHELD IS NOT EMPTY (allowed-pattern #18). Rendering "nothing here" for a
  // body the capture dropped is the app lying about what it saw.
  return { title, note: withheld ? 'Not retained by the capture.' : 'No body.' }
}

/** Pretty-print a JSON body; leave anything else exactly as it came. */
export function formatBody(body: string, contentType: string): string {
  if (!/json/i.test(contentType)) return body
  try {
    return JSON.stringify(JSON.parse(body), null, 2)
  } catch {
    // A body that claims to be JSON and is not is itself the finding — showing
    // it raw is more useful than showing an error about it.
    return body
  }
}

/** The content type a header set declares, or ''. */
export function contentTypeOf(headers: Record<string, string>): string {
  for (const [name, value] of Object.entries(headers ?? {})) {
    if (name.toLowerCase() === 'content-type') return String(value)
  }
  return ''
}

/**
 * One tab of the detail view.
 *
 * TABS, NOT A STACK. Everything at once meant a Content-Security-Policy header
 * — routinely a paragraph — pushed the response body clean off the bottom, and
 * finding the one section you wanted meant scrolling past five you did not
 * (user, 2026-09-21, with a screenshot of exactly that).
 *
 * The split follows what a person is actually asking: what did I SEND, what did
 * it SAY, and what were the headers around it.
 */
export interface DetailTab {
  id: 'headers' | 'request' | 'response'
  label: string
  sections: DetailSection[]
  /** True when this tab has nothing in it — the strip dims it rather than
   *  hiding it, so the set of tabs never changes shape between rows. */
  empty: boolean
}

/** The detail view as tabs. */
export function detailTabs(payload: BrowserNetworkPayload, withheld = false): DetailTab[] {
  const sections = detailSections(payload, withheld)
  const pick = (title: string): DetailSection[] =>
    sections.filter((section) => section.title === title)

  const headers = [...pick('General'), ...pick('Request headers'), ...pick('Response headers')]
  const request = pick('Request body')
  const response = pick('Response body')

  // A body tab is EMPTY when its section is a note rather than content. The
  // tab still appears: a strip whose tabs come and go makes a reader hunt for
  // the one that moved.
  const hasBody = (group: DetailSection[]): boolean =>
    group.some((section) => section.body !== undefined && section.body.length > 0)

  return [
    { id: 'headers', label: 'Headers', sections: headers, empty: false },
    { id: 'request', label: 'Request', sections: request, empty: !hasBody(request) },
    { id: 'response', label: 'Response', sections: response, empty: !hasBody(response) },
  ]
}

/** The detail view's sections, in reading order. */
export function detailSections(
  payload: BrowserNetworkPayload,
  withheld = false,
): DetailSection[] {
  const requestType = contentTypeOf(payload.requestHeaders)
  const responseType = contentTypeOf(payload.responseHeaders)
  const general: { name: string; value: string }[] = [
    { name: 'Request URL', value: payload.url },
    { name: 'Method', value: payload.method },
    {
      name: 'Status',
      value: payload.status === 0 ? 'failed — the request never completed' : String(payload.status),
    },
    { name: 'Duration', value: `${Math.round(payload.timingMs)} ms` },
    { name: 'Time', value: new Date(payload.ts).toLocaleTimeString() },
  ]

  const request = bodySection('Request body', payload.requestBody, withheld)
  if (request.body !== undefined) request.body = formatBody(request.body, requestType)
  const response = bodySection('Response body', payload.responseBody, withheld)
  if (response.body !== undefined) response.body = formatBody(response.body, responseType)

  return [
    { title: 'General', rows: general },
    {
      title: 'Request headers',
      rows: headerRows(payload.requestHeaders),
      ...(Object.keys(payload.requestHeaders ?? {}).length === 0
        ? { note: 'None captured.' }
        : {}),
    },
    {
      title: 'Response headers',
      rows: headerRows(payload.responseHeaders),
      ...(Object.keys(payload.responseHeaders ?? {}).length === 0
        ? { note: 'None captured.' }
        : {}),
    },
    request,
    response,
  ]
}

/** Single-quote a value for a POSIX shell, the only safe way to embed one. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/**
 * The request as a cURL command.
 *
 * SAFE TO PASTE, NOT GUARANTEED TO REPLAY — and it says so in its own first
 * line. The capture redacts credentials before anything reaches here, so an
 * `Authorization` header in this command reads `[redacted]` and the server will
 * refuse it. That is the correct trade (a command that replays would be a
 * command that leaks), and a reader who does not know it would spend a while
 * debugging the wrong 401.
 */
export function toCurl(payload: BrowserNetworkPayload): string {
  const parts: string[] = [`curl ${shellQuote(payload.url)}`]
  if (payload.method.toUpperCase() !== 'GET') {
    parts.push(`  -X ${payload.method.toUpperCase()}`)
  }
  let redacted = false
  for (const { name, value } of headerRows(payload.requestHeaders)) {
    if (value.includes('[redacted]')) redacted = true
    parts.push(`  -H ${shellQuote(`${name}: ${value}`)}`)
  }
  if (payload.requestBody !== undefined && payload.requestBody.length > 0) {
    if (payload.requestBody.includes('[redacted]')) redacted = true
    parts.push(`  --data-raw ${shellQuote(payload.requestBody)}`)
  }
  const command = parts.join(' \\\n')
  return redacted
    ? `# Credentials in this request were redacted at capture, so this command\n# will not authenticate as the page did.\n${command}\n`
    : `${command}\n`
}
