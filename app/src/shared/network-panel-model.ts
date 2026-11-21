/**
 * THE NETWORK PANEL'S RULES, without a DOM.
 *
 * Modelled on Chrome's Network panel (user, 2026-11-20: "that network tab is so
 * hard to debug … use the inspect network from google chrome as inspiration").
 * What a reader does there — filter by text and by `status:` / `method:` /
 * `domain:` / `larger-than:`, narrow by type, sort a column, read a waterfall
 * and a summary — is decided here, so it is testable without a browser. The
 * view (`renderer/browser/network-panel.ts`) only draws what this returns.
 *
 * One addition Chrome does not have: GROUP REPEATS. A page that polls sends the
 * same request every few seconds, and a list of forty identical rows hides the
 * one that differs. Grouped, they are one row with a count, showing the latest.
 */

import type { BrowserNetworkCapture, BrowserNetworkPayload, BrowserPageTimings } from './browser-capture-types'
import { contentTypeOf } from './network-detail'

// ── Types of request ──────────────────────────────────────────────────────

export type NetworkType = 'fetch' | 'doc' | 'css' | 'js' | 'font' | 'img' | 'media' | 'socket' | 'other'
export type NetworkTypeFilter = 'all' | NetworkType

/** The chips. Chrome's order, except that Fetch/XHR leads and is what a
 *  panel opens on (the requests a person debugging an app looks for), and All
 *  comes last. */
export const NETWORK_TYPE_FILTERS: readonly { id: NetworkTypeFilter; label: string }[] = [
  { id: 'fetch', label: 'Fetch/XHR' },
  { id: 'doc', label: 'Doc' },
  { id: 'css', label: 'CSS' },
  { id: 'js', label: 'JS' },
  { id: 'font', label: 'Font' },
  { id: 'img', label: 'Img' },
  { id: 'media', label: 'Media' },
  { id: 'socket', label: 'Socket' },
  { id: 'other', label: 'Other' },
  { id: 'all', label: 'All' },
]

/** The chip a panel opens on. */
export const DEFAULT_NETWORK_TYPE: NetworkTypeFilter = 'fetch'

const BY_RESOURCE_TYPE: Record<string, NetworkType> = {
  Fetch: 'fetch',
  XHR: 'fetch',
  Document: 'doc',
  Stylesheet: 'css',
  Script: 'js',
  Font: 'font',
  Image: 'img',
  Media: 'media',
  WebSocket: 'socket',
  EventSource: 'socket',
}

/** Which chip a request belongs to: the browser's own word, else its MIME type. */
export function typeOf(payload: BrowserNetworkPayload): NetworkType {
  if (payload.resourceType !== undefined) return BY_RESOURCE_TYPE[payload.resourceType] ?? 'other'
  const mime = (payload.mimeType ?? contentTypeOf(payload.responseHeaders)).toLowerCase()
  if (mime.includes('json') || mime.includes('graphql')) return 'fetch'
  if (mime.includes('html')) return 'doc'
  if (mime.includes('css')) return 'css'
  if (mime.includes('javascript') || mime.includes('ecmascript')) return 'js'
  if (mime.includes('font')) return 'font'
  if (mime.startsWith('image/')) return 'img'
  if (mime.startsWith('video/') || mime.startsWith('audio/')) return 'media'
  return 'other'
}

/** The Type column: the browser's word in lower case, as Chrome prints it. */
export function typeLabel(payload: BrowserNetworkPayload): string {
  if (payload.resourceType !== undefined) return payload.resourceType.toLowerCase()
  const type = typeOf(payload)
  return type === 'other' ? '' : type
}

// ── Status, size, names ───────────────────────────────────────────────────

/** True for a request that failed or came back 4xx/5xx. */
export function isError(payload: BrowserNetworkPayload): boolean {
  return payload.failure !== undefined || payload.status === 0 || payload.status >= 400
}

/** The Status column. A request that never got an answer says so in words. */
export function statusLabel(payload: BrowserNetworkPayload): string {
  if (payload.canceled === true) return '(canceled)'
  if (payload.failure !== undefined && payload.failure.startsWith('blocked')) return '(blocked)'
  if (payload.status === 0) return '(failed)'
  return String(payload.status)
}

/** The failure in a reader's words: `net::ERR_CONNECTION_REFUSED` → `connection refused`. */
export function failureLabel(payload: BrowserNetworkPayload): string {
  const raw = payload.failure
  if (raw === undefined || raw === '') return ''
  if (raw.startsWith('blocked: ')) return `blocked (${raw.slice(9).replace(/_/g, ' ').toLowerCase()})`
  return raw.replace(/^net::ERR_/, '').replace(/_/g, ' ').toLowerCase()
}

/** Bytes that crossed the network: measured, else declared, else the body kept. */
export function transferSize(payload: BrowserNetworkPayload): number {
  if (payload.transferBytes !== undefined) return payload.transferBytes
  const declared = Number(headerValue(payload.responseHeaders, 'content-length'))
  if (Number.isFinite(declared) && declared > 0) return declared
  return payload.responseBody?.length ?? 0
}

/** Bytes of the decoded response. */
export function resourceSize(payload: BrowserNetworkPayload): number {
  return payload.resourceBytes ?? transferSize(payload)
}

function headerValue(headers: Record<string, string> | undefined, name: string): string {
  for (const [key, value] of Object.entries(headers ?? {})) if (key.toLowerCase() === name) return String(value)
  return ''
}

/** Bytes as Chrome prints them. */
export function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  if (bytes < 1000) return `${String(Math.round(bytes))} B`
  if (bytes < 1_000_000) return `${(bytes / 1000).toFixed(1)} kB`
  return `${(bytes / 1_000_000).toFixed(1)} MB`
}

/** Milliseconds as Chrome prints them. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return ''
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)} s`
  return `${String(Math.round(ms))} ms`
}

export function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return ''
  }
}

/** The Name column: the last path segment plus the query, else the host. */
export function nameOf(url: string): string {
  try {
    const parsed = new URL(url)
    if (parsed.protocol === 'data:') return url.slice(0, 40)
    const last = parsed.pathname.split('/').filter(Boolean).pop()
    return `${last ?? parsed.host}${parsed.search}`
  } catch {
    return url
  }
}

/** The Initiator column: `file.js:12`, or what started it. */
export function initiatorLabel(payload: BrowserNetworkPayload): string {
  const initiator = payload.initiator
  if (initiator === undefined) return ''
  if (initiator.url !== undefined) {
    const file = nameOf(initiator.url).split('?')[0] ?? initiator.url
    return initiator.line !== undefined ? `${file}:${String(initiator.line)}` : file
  }
  if (initiator.type === 'preflight') return 'preflight'
  if (initiator.type === 'parser') return 'page'
  return initiator.type === 'other' ? 'other' : initiator.type
}

const LOCAL_HOSTS = /^(localhost|127\.0\.0\.1|\[::1\]|[^.]+\.localhost)(:\d+)?$/i

/**
 * Whether `host` belongs to the page's own site: the same host, both local
 * servers, or the same parent domain (`api.acme.com` beside `app.acme.com`).
 * Used by "Hide other sites", which drops analytics and flag services.
 */
export function isSameSite(pageHost: string, host: string): boolean {
  if (pageHost === '' || host === '') return true
  if (pageHost === host) return true
  if (LOCAL_HOSTS.test(pageHost) && LOCAL_HOSTS.test(host)) return true
  const base = (name: string): string => name.replace(/:\d+$/, '').split('.').slice(-2).join('.')
  return base(pageHost) === base(host)
}

// ── The filter box ─────────────────────────────────────────────────────────

export type NetworkFilterKey = 'status' | 'method' | 'domain' | 'larger-than' | 'mime-type'

export interface NetworkQuery {
  /** Plain words: each must appear in the URL (or must not, with `-`). */
  words: { text: string; negate: boolean }[]
  /** `key:value` filters, each optionally negated with a leading `-`. */
  filters: { key: NetworkFilterKey; value: string; negate: boolean }[]
}

const FILTER_KEYS: readonly NetworkFilterKey[] = ['status', 'method', 'domain', 'larger-than', 'mime-type']

/** Read the filter box: `status:404 -domain:launchdarkly.com orders`. */
export function parseNetworkQuery(text: string): NetworkQuery {
  const query: NetworkQuery = { words: [], filters: [] }
  for (const raw of text.trim().split(/\s+/).filter(Boolean)) {
    const negate = raw.startsWith('-') && raw.length > 1
    const token = negate ? raw.slice(1) : raw
    const colon = token.indexOf(':')
    const key = colon > 0 ? token.slice(0, colon).toLowerCase() : ''
    const value = colon > 0 ? token.slice(colon + 1) : ''
    if ((FILTER_KEYS as readonly string[]).includes(key) && value !== '') {
      query.filters.push({ key: key as NetworkFilterKey, value: value.toLowerCase(), negate })
    } else {
      query.words.push({ text: token.toLowerCase(), negate })
    }
  }
  return query
}

/** `10k` → 10000, `1.5m` → 1500000, `512` → 512. NaN when unreadable. */
export function parseSize(text: string): number {
  const match = /^(\d+(?:\.\d+)?)\s*([km]?)b?$/i.exec(text.trim())
  if (match === null) return Number.NaN
  const n = Number(match[1])
  const unit = (match[2] ?? '').toLowerCase()
  return unit === 'm' ? n * 1_000_000 : unit === 'k' ? n * 1000 : n
}

function matchesFilter(payload: BrowserNetworkPayload, key: NetworkFilterKey, value: string): boolean {
  switch (key) {
    case 'status': {
      if (value === 'failed') return payload.status === 0 || payload.failure !== undefined
      const label = statusLabel(payload)
      const pattern = value.replace(/x/g, '')
      return label.startsWith(pattern)
    }
    case 'method':
      return payload.method.toLowerCase() === value
    case 'domain': {
      const host = hostOf(payload.url).toLowerCase()
      if (value.startsWith('*.')) return host.endsWith(value.slice(1)) || host === value.slice(2)
      return host.includes(value)
    }
    case 'larger-than': {
      const limit = parseSize(value)
      return Number.isFinite(limit) && transferSize(payload) > limit
    }
    case 'mime-type':
      return (payload.mimeType ?? contentTypeOf(payload.responseHeaders)).toLowerCase().includes(value)
  }
}

/** Whether one request passes the filter box. An empty box passes everything. */
export function matchesQuery(payload: BrowserNetworkPayload, query: NetworkQuery): boolean {
  const url = payload.url.toLowerCase()
  for (const word of query.words) if (url.includes(word.text) === word.negate) return false
  for (const filter of query.filters) if (matchesFilter(payload, filter.key, filter.value) === filter.negate) return false
  return true
}

export function isEmptyQuery(query: NetworkQuery): boolean {
  return query.words.length === 0 && query.filters.length === 0
}

// ── Rows ───────────────────────────────────────────────────────────────────

export interface NetworkFilters {
  query: string
  type: NetworkTypeFilter
  /** Show what the filter box does NOT match. Chips and toggles still apply. */
  invert: boolean
  errorsOnly: boolean
  hideOtherSites: boolean
  /** The page's own host, for "Hide other sites". */
  pageHost: string
}

export type NetworkSortKey = 'name' | 'status' | 'method' | 'type' | 'initiator' | 'size' | 'time' | 'start'

export interface NetworkRowOptions {
  group: boolean
  sort: { key: NetworkSortKey; direction: 1 | -1 } | null
}

/** One row of the list: a request, or a group of identical ones. */
export interface NetworkRow {
  /** The request shown — the newest of its group. */
  capture: BrowserNetworkCapture
  /** Every request this row stands for, oldest first. */
  ids: string[]
  count: number
}

/** Identical requests: same method, address and answer. */
export function groupKey(payload: BrowserNetworkPayload): string {
  return `${payload.method} ${payload.url} ${statusLabel(payload)}`
}

export function passesFilters(capture: BrowserNetworkCapture, filters: NetworkFilters, query = parseNetworkQuery(filters.query)): boolean {
  const payload = capture.payload
  if (filters.type !== 'all' && typeOf(payload) !== filters.type) return false
  if (filters.errorsOnly && !isError(payload)) return false
  if (filters.hideOtherSites && !isSameSite(filters.pageHost, hostOf(payload.url))) return false
  if (isEmptyQuery(query)) return true
  return matchesQuery(payload, query) !== filters.invert
}

/** The list a reader sees: filtered, grouped when asked, sorted when asked. */
export function buildRows(
  captures: readonly BrowserNetworkCapture[],
  filters: NetworkFilters,
  options: NetworkRowOptions,
): NetworkRow[] {
  const query = parseNetworkQuery(filters.query)
  const kept = captures.filter((capture) => passesFilters(capture, filters, query))
  let rows: NetworkRow[]
  if (options.group) {
    const byKey = new Map<string, NetworkRow>()
    rows = []
    for (const capture of kept) {
      const key = groupKey(capture.payload)
      const row = byKey.get(key)
      if (row === undefined) {
        const fresh: NetworkRow = { capture, ids: [capture.id], count: 1 }
        byKey.set(key, fresh)
        rows.push(fresh)
      } else {
        row.capture = capture
        row.ids.push(capture.id)
        row.count += 1
      }
    }
  } else {
    rows = kept.map((capture) => ({ capture, ids: [capture.id], count: 1 }))
  }
  return options.sort === null ? rows : sortRows(rows, options.sort.key, options.sort.direction)
}

function sortValue(row: NetworkRow, key: NetworkSortKey): string | number {
  const payload = row.capture.payload
  switch (key) {
    case 'name':
      return nameOf(payload.url).toLowerCase()
    case 'status':
      return payload.status
    case 'method':
      return payload.method
    case 'type':
      return typeLabel(payload)
    case 'initiator':
      return initiatorLabel(payload)
    case 'size':
      return transferSize(payload)
    case 'time':
      return payload.timingMs
    case 'start':
      return payload.ts
  }
}

/** Sort a copy. Ties keep the order the requests were made in. */
export function sortRows(rows: readonly NetworkRow[], key: NetworkSortKey, direction: 1 | -1): NetworkRow[] {
  return rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => {
      const x = sortValue(a.row, key)
      const y = sortValue(b.row, key)
      const order = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y))
      return order === 0 ? a.index - b.index : order * direction
    })
    .map(({ row }) => row)
}

/** The chips' counts: how many requests of each type there are. */
export function typeCounts(captures: readonly BrowserNetworkCapture[]): Record<NetworkType, number> {
  const counts: Record<NetworkType, number> = { fetch: 0, doc: 0, css: 0, js: 0, font: 0, img: 0, media: 0, socket: 0, other: 0 }
  for (const capture of captures) counts[typeOf(capture.payload)] += 1
  return counts
}

// ── Summary and timeline ──────────────────────────────────────────────────

export interface NetworkSummary {
  shown: number
  total: number
  transferred: number
  resources: number
  failed: number
  /** From the first request's start to the last one's end, ms. */
  finish: number | null
  /** Page milestones, ms after the first request started. */
  domContentLoaded: number | null
  load: number | null
}

/** The bar under the list. `shownIds` counts every request a row stands for. */
export function summarize(
  rows: readonly NetworkRow[],
  all: readonly BrowserNetworkCapture[],
  timings: BrowserPageTimings | null,
): NetworkSummary {
  const shownIds = new Set(rows.flatMap((row) => row.ids))
  const shown = all.filter((capture) => shownIds.has(capture.id))
  const range = timeRange(all)
  const since = (at: number | null | undefined): number | null =>
    at === null || at === undefined || range === null || at < range.start ? null : at - range.start
  return {
    shown: shown.length,
    total: all.length,
    transferred: shown.reduce((sum, capture) => sum + transferSize(capture.payload), 0),
    resources: shown.reduce((sum, capture) => sum + resourceSize(capture.payload), 0),
    failed: shown.filter((capture) => isError(capture.payload)).length,
    finish: range === null ? null : range.end - range.start,
    domContentLoaded: since(timings?.domContentLoaded),
    load: since(timings?.load),
  }
}

/** When the first request started and the last one ended, epoch ms. */
export function timeRange(captures: readonly BrowserNetworkCapture[]): { start: number; end: number } | null {
  if (captures.length === 0) return null
  let start = Infinity
  let end = -Infinity
  for (const { payload } of captures) {
    start = Math.min(start, payload.ts)
    end = Math.max(end, payload.ts + Math.max(0, payload.timingMs))
  }
  return { start, end: Math.max(end, start + 1) }
}

/** A request's bar on the waterfall, as fractions of the range (0..1). */
export function barOf(payload: BrowserNetworkPayload, range: { start: number; end: number }): { left: number; width: number } {
  const total = range.end - range.start
  const left = Math.min(1, Math.max(0, (payload.ts - range.start) / total))
  const width = Math.min(1 - left, Math.max(0, payload.timingMs) / total)
  return { left, width }
}

/** A request's steps, in order, for the waterfall and the Timing tab. */
export const PHASE_STEPS: readonly { id: keyof NonNullable<BrowserNetworkPayload['phases']>; label: string; group: 'queue' | 'connection' | 'response' }[] = [
  { id: 'queued', label: 'Queued', group: 'queue' },
  { id: 'dns', label: 'DNS lookup', group: 'connection' },
  { id: 'connect', label: 'Connecting', group: 'connection' },
  { id: 'tls', label: 'TLS', group: 'connection' },
  { id: 'send', label: 'Sending request', group: 'response' },
  { id: 'wait', label: 'Waiting for server', group: 'response' },
  { id: 'download', label: 'Downloading', group: 'response' },
]

export function phaseList(payload: BrowserNetworkPayload): { id: string; label: string; group: string; ms: number }[] {
  const phases = payload.phases
  if (phases === undefined) return []
  return PHASE_STEPS.flatMap((step) => {
    const ms = phases[step.id]
    return ms === undefined ? [] : [{ id: step.id, label: step.label, group: step.group, ms }]
  })
}

// ── What is on screen ─────────────────────────────────────────────────────

/** Whether a request was made while the panel was recording and after the
 *  last Clear. Pausing and clearing hide; nothing is deleted. */
export function isRecorded(ts: number, clearedAt: number | null, pauses: readonly { from: number; to: number | null }[]): boolean {
  if (clearedAt !== null && ts <= clearedAt) return false
  return !pauses.some((pause) => ts >= pause.from && (pause.to === null || ts <= pause.to))
}
