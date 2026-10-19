/**
 * WRITING A HAR — a recording of what was RETAINED, and honest about it.
 *
 * `har-summary.ts` reads HAR files somebody captured elsewhere. This produces
 * one from a debug session's own network records, so the traffic can be opened
 * in any browser's devtools instead of read as prose.
 *
 * THE THING THIS FILE MUST NOT DO IS IMPLY COMPLETENESS.
 *
 * A real HAR is written by the browser as the traffic happens and contains
 * everything. This one is assembled from a capture buffer that:
 *
 *   - caps response bodies at 64 KB (`cdp-capture.ts`)
 *   - holds 500 entries and 4 MB per kind, evicting oldest-first
 *     (`rolling-buffer.ts`)
 *   - never saw requests the page made before the debugger attached
 *     (measured — `e2e/ux/browser-capture-clock.spec.ts`)
 *   - has had secrets removed (`browser-capture-boundary.ts`)
 *
 * Devtools will open this file and present it as fact, so every one of those
 * facts is written INTO the file, in `creator.comment` and per entry. A HAR
 * that silently omits is worse than no HAR at all, because the reader has no
 * way to know what they are not seeing.
 *
 * Pure, DOM-free: records in, JSON text out.
 */

import type { BrowserNetworkPayload } from './browser-capture-types'

/** What the session knows about its own gaps, for the file to state. */
export interface HarProvenance {
  /** When the window opened, epoch ms. */
  startedAt: number
  /** When it closed, epoch ms. */
  endedAt: number
  /** True when the capture buffer had already dropped part of the window. */
  evicted: boolean
  /** Longest body the capture kept, in bytes. */
  bodyCapBytes: number
}

/** One HAR entry, in the shape `har-summary.ts` and devtools both read. */
interface HarEntry {
  startedDateTime: string
  time: number
  request: {
    method: string
    url: string
    httpVersion: string
    headers: { name: string; value: string }[]
    queryString: never[]
    cookies: never[]
    headersSize: number
    bodySize: number
    postData?: { mimeType: string; text: string }
  }
  response: {
    status: number
    statusText: string
    httpVersion: string
    headers: { name: string; value: string }[]
    cookies: never[]
    content: { size: number; mimeType: string; text?: string }
    redirectURL: string
    headersSize: number
    bodySize: number
  }
  cache: Record<string, never>
  timings: { send: number; wait: number; receive: number }
  comment?: string
}

function headerList(headers: Record<string, string>): { name: string; value: string }[] {
  return Object.entries(headers ?? {}).map(([name, value]) => ({ name, value: String(value) }))
}

function mimeOf(headers: Record<string, string>): string {
  for (const [name, value] of Object.entries(headers ?? {})) {
    if (name.toLowerCase() === 'content-type') return String(value)
  }
  return ''
}

/**
 * The sentence a reader needs before they trust anything in the file.
 *
 * In `creator.comment` because that is the one field every HAR viewer shows
 * and no viewer hides — a comment buried on an entry is read by nobody.
 */
export function harProvenanceComment(provenance: HarProvenance, entries: number): string {
  const parts = [
    `Recorded by Flow during one debug session (${new Date(provenance.startedAt).toISOString()} to ${new Date(provenance.endedAt).toISOString()}).`,
    'This is a recording of what the session RETAINED, not of everything that happened.',
    `Response bodies over ${provenance.bodyCapBytes} bytes were truncated at capture.`,
    'Requests the page made before capture attached are absent entirely.',
    'Secrets (tokens, Authorization and Cookie headers) were removed before this file was written.',
    `${entries} entries.`,
  ]
  if (provenance.evicted) {
    parts.splice(
      2,
      0,
      'The capture buffer dropped some entries from inside this window before the file was written, so the beginning is incomplete.',
    )
  }
  return parts.join(' ')
}

/**
 * A HAR 1.2 document for these records.
 *
 * `status === 0` MEANS IT NEVER COMPLETED — a connection refused, a DNS
 * failure, an abort. HAR has no better representation than a zero status, so
 * the entry carries a comment saying so; without it a reader sees "0" and
 * assumes the file is broken rather than the request.
 */
export function writeHar(
  records: readonly BrowserNetworkPayload[],
  provenance: HarProvenance,
  creatorVersion = '1',
): string {
  const entries: HarEntry[] = records
    .slice()
    .sort((a, b) => a.ts - b.ts)
    .map((record) => {
      const responseMime = mimeOf(record.responseHeaders)
      const entry: HarEntry = {
        startedDateTime: new Date(record.ts).toISOString(),
        time: Math.max(0, record.timingMs),
        request: {
          method: record.method,
          url: record.url,
          httpVersion: 'HTTP/1.1',
          headers: headerList(record.requestHeaders),
          queryString: [],
          cookies: [],
          // -1 IS HAR'S "NOT KNOWN", and it is the truth here: the capture
          // never measured the wire size. A plausible number would be a lie a
          // reader could do arithmetic with.
          headersSize: -1,
          bodySize: record.requestBody === undefined ? -1 : record.requestBody.length,
        },
        response: {
          status: record.status,
          statusText: '',
          httpVersion: 'HTTP/1.1',
          headers: headerList(record.responseHeaders),
          cookies: [],
          content: {
            size: record.responseBody === undefined ? -1 : record.responseBody.length,
            mimeType: responseMime,
            ...(record.responseBody === undefined ? {} : { text: record.responseBody }),
          },
          redirectURL: '',
          headersSize: -1,
          bodySize: record.responseBody === undefined ? -1 : record.responseBody.length,
        },
        cache: {},
        // Only the total was measured, so it is reported as wait and the other
        // two are zero rather than invented.
        timings: { send: 0, wait: Math.max(0, record.timingMs), receive: 0 },
      }
      if (record.status === 0) {
        entry.comment = 'The request never completed — no response was received.'
      }
      if (record.responseBody === undefined && record.status !== 0) {
        entry.comment = 'The response body was not retained by the capture.'
      }
      return entry
    })

  return `${JSON.stringify(
    {
      log: {
        version: '1.2',
        creator: {
          name: 'Flow debug session',
          version: creatorVersion,
          comment: harProvenanceComment(provenance, entries.length),
        },
        entries,
      },
    },
    null,
    2,
  )}\n`
}
