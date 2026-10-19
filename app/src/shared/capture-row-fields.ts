/**
 * WHAT A DRAWER ROW SHOWS AT A GLANCE.
 *
 * A row is read in a list of a hundred, scanned rather than studied, so what it
 * prints has to answer the questions somebody scans FOR: which request is this,
 * what kind of thing came back, how big was it, and where in my code did this
 * come from.
 *
 * The first cut printed a method, a status, a whole URL and a duration — which
 * is the address bar plus a number. A long URL also ate the row, so the part a
 * reader identifies a request by (its last path segment) was the part that got
 * ellipsized away.
 *
 * Pure and DOM-free: the shortening rules are where this goes wrong, and they
 * are testable without a browser.
 */

import type { BrowserNetworkPayload } from './browser-capture-types'

/** The fields a network row prints, already shortened. */
export interface NetworkRowFields {
  method: string
  /** Status as shown — '—' when the request never completed. */
  status: string
  /** What identifies the request: the last path segment, or the host for a root. */
  name: string
  /** Where it went, for the rows whose names collide. */
  host: string
  /** A short content type: json, html, png… or '' when unknown. */
  type: string
  /** Human size, or '' when nothing was measured. */
  size: string
  /** The full URL, for the row's tooltip. */
  url: string
}

/** Bytes as a person reads them. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return ''
  if (bytes < 1024) return `${Math.round(bytes)} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} kB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/**
 * A content type as one word.
 *
 * `application/json; charset=utf-8` is not something to print in a column six
 * characters wide, and the half that matters is the subtype.
 */
export function shortType(contentType: string): string {
  const base = (contentType.split(';')[0] ?? '').trim().toLowerCase()
  if (base === '') return ''
  const [top, sub] = base.split('/')
  if (sub === undefined || sub === '') return top ?? ''
  // `application/vnd.api+json` is json; `image/svg+xml` is svg.
  const plus = sub.split('+')
  const tail = plus.length > 1 ? (plus[plus.length - 1] ?? sub) : sub
  const cleaned = (plus.length > 1 ? plus[0] : tail) ?? sub
  const pick = plus.length > 1 && tail === 'json' ? 'json' : cleaned
  return (pick.split('.').pop() ?? pick).slice(0, 12)
}

/** The size a response declared, or the body we kept. 0 when neither. */
function sizeOf(payload: BrowserNetworkPayload): number {
  for (const [name, value] of Object.entries(payload.responseHeaders ?? {})) {
    if (name.toLowerCase() === 'content-length') {
      const n = Number(value)
      if (Number.isFinite(n) && n > 0) return n
    }
  }
  return payload.responseBody?.length ?? 0
}

/**
 * The name a reader identifies a request by.
 *
 * The LAST path segment, which is what a person says out loud ("the templates
 * call"), falling back to the host for a root request. A query string is
 * dropped — it is in the detail view, and it is usually longer than the name.
 */
export function requestName(url: string): { name: string; host: string } {
  try {
    const parsed = new URL(url)
    const segments = parsed.pathname.split('/').filter((part) => part !== '')
    const last = segments[segments.length - 1]
    return { name: last === undefined ? parsed.host : last, host: parsed.host }
  } catch {
    // A malformed URL is still a row somebody has to read; show what there is.
    return { name: url.slice(0, 60), host: '' }
  }
}

export function networkRowFields(payload: BrowserNetworkPayload): NetworkRowFields {
  const { name, host } = requestName(payload.url)
  const type = shortType(contentTypeHeader(payload.responseHeaders))
  return {
    method: payload.method.toUpperCase(),
    // 0 = never completed (see BrowserNetworkPayload.status).
    status: payload.status === 0 ? '—' : String(payload.status),
    name,
    host,
    type,
    size: formatBytes(sizeOf(payload)),
    url: payload.url,
  }
}

function contentTypeHeader(headers: Record<string, string>): string {
  for (const [name, value] of Object.entries(headers ?? {})) {
    if (name.toLowerCase() === 'content-type') return String(value)
  }
  return ''
}

/**
 * A console entry's source, as Chrome prints it on the right of a row.
 *
 * `componentPath` is a stable anchor captured for every entry and shown
 * nowhere — the top stack frame for a console call. A reader scanning for
 * "where did this come from" had to expand a row to find out.
 *
 * Returns '' when the anchor says nothing useful, so a row can leave the column
 * empty rather than print a placeholder.
 */
export function consoleSource(componentPath: string | null | undefined): string {
  if (typeof componentPath !== 'string') return ''
  const trimmed = componentPath.trim()
  if (trimmed === '' || trimmed === 'unknown') return ''
  // A file URL or a long path is read from its TAIL: `…/app/form.ts:42`.
  const tail = trimmed.split('/').pop() ?? trimmed
  return tail.length > 40 ? `…${tail.slice(-39)}` : tail
}
