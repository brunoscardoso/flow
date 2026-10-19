/**
 * What an agent is told about a HAR file.
 *
 * A HAR is a network recording — every request a page made, with headers,
 * timings and often the response bodies. The ones this was written against run
 * 1 MB to 22 MB, so the whole file cannot go into a turn: it is not a document
 * that happens to be long, it is a few hundred structured records of which a
 * person cares about a handful.
 *
 * BOUND THE PAYLOAD AT THE BOUNDARY (allowed-pattern #18). The summary answers
 * the questions somebody actually opens a HAR to ask — what failed, what was
 * slow, who was talked to, in what order — and the raw file stays on disk for
 * the entry that turns out to matter. What is deliberately NOT here is every
 * request: a 418-line table is the same wall of noise as the file.
 *
 * NO BODIES, NO HEADERS, NO COOKIES. A HAR from a real session carries session
 * tokens, auth headers and response payloads. This reads a recording somebody
 * captured from their own browser, and the summary is written into a chat
 * message that is persisted and sent to a model — so the shape of the traffic
 * crosses that line and its contents do not. An agent that needs a specific
 * body asks for that entry by index, from the file, deliberately.
 *
 * Pure and DOM-free: it takes text and returns text, so it runs under the app's
 * node-env jest and can be exercised against a real 5 MB capture without a
 * renderer.
 */

/** How many rows each section of the summary may print. */
const SECTION_LIMIT = 12

/** Slower than this and a request is worth naming on its own. */
const SLOW_MS = 2000

export interface HarEntrySummary {
  index: number
  method: string
  status: number
  url: string
  ms: number
  bytes: number
}

export interface HarSummary {
  /** Total requests in the recording. */
  entries: number
  /** Distinct hosts, most-used first. */
  hosts: Array<{ host: string; count: number }>
  /** Status code → how many. */
  statuses: Array<{ status: number; count: number }>
  /** Everything that returned 4xx/5xx or carried a transport error. */
  failures: HarEntrySummary[]
  /** Everything slower than {@link SLOW_MS}, slowest first. */
  slow: HarEntrySummary[]
  /** Wall time from the first request to the end of the last, in ms. */
  spanMs: number
}

/** The parse failed, and why — never a throw into a send path. */
export interface HarParseFailure {
  ok: false
  reason: string
}

export type HarReadResult = ({ ok: true } & HarSummary) | HarParseFailure

interface RawEntry {
  request?: { method?: unknown; url?: unknown }
  response?: { status?: unknown; _error?: unknown; bodySize?: unknown; _transferSize?: unknown }
  time?: unknown
  startedDateTime?: unknown
}

function asNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/** The host, or '' when the url is not one. Never throws on a malformed url. */
export function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return ''
  }
}

/** Descending by the given key, then by index so ties never reorder. */
function ranked(entries: HarEntrySummary[], key: 'ms' | 'bytes'): HarEntrySummary[] {
  return [...entries].sort((a, b) => b[key] - a[key] || a.index - b.index)
}

/**
 * Read a HAR into the facts worth reporting.
 *
 * Structural checks only — `log.entries` being an array is the whole contract,
 * and a file that fails it is reported rather than half-read. Individual
 * entries are read defensively: a recording with one odd record still answers
 * every question about the other four hundred.
 */
export function readHar(text: string): HarReadResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { ok: false, reason: 'this file is not JSON, so it is not a HAR recording' }
  }
  const log = (parsed as { log?: { entries?: unknown } } | null)?.log
  const raw = log?.entries
  if (!Array.isArray(raw)) {
    return { ok: false, reason: 'this JSON has no log.entries, so it is not a HAR recording' }
  }

  const hosts = new Map<string, number>()
  const statuses = new Map<number, number>()
  const failures: HarEntrySummary[] = []
  const slow: HarEntrySummary[] = []
  let first = Number.POSITIVE_INFINITY
  let last = 0

  raw.forEach((value, index) => {
    const entry = (value ?? {}) as RawEntry
    const url = asString(entry.request?.url)
    const status = asNumber(entry.response?.status)
    const ms = Math.round(asNumber(entry.time))
    const summary: HarEntrySummary = {
      index,
      method: asString(entry.request?.method) || 'GET',
      status,
      url,
      ms,
      // `_transferSize` is what actually crossed the wire; `bodySize` is -1 for
      // anything served from cache, and a negative byte count reads as a bug.
      bytes: Math.max(0, asNumber(entry.response?._transferSize) || asNumber(entry.response?.bodySize)),
    }
    const host = hostOf(url)
    if (host !== '') hosts.set(host, (hosts.get(host) ?? 0) + 1)
    statuses.set(status, (statuses.get(status) ?? 0) + 1)
    // A transport error has no status at all, which is exactly the failure a
    // person is usually hunting — status 0 must not read as "fine".
    if (status >= 400 || status === 0 || asString(entry.response?._error) !== '') {
      failures.push(summary)
    }
    if (ms >= SLOW_MS) slow.push(summary)

    const started = Date.parse(asString(entry.startedDateTime))
    if (Number.isFinite(started)) {
      first = Math.min(first, started)
      last = Math.max(last, started + ms)
    }
  })

  return {
    ok: true,
    entries: raw.length,
    hosts: [...hosts.entries()]
      .map(([host, count]) => ({ host, count }))
      .sort((a, b) => b.count - a.count || a.host.localeCompare(b.host)),
    statuses: [...statuses.entries()]
      .map(([status, count]) => ({ status, count }))
      .sort((a, b) => a.status - b.status),
    failures,
    slow: ranked(slow, 'ms'),
    spanMs: Number.isFinite(first) ? Math.max(0, Math.round(last - first)) : 0,
  }
}

function seconds(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`
}

function kb(bytes: number): string {
  return bytes >= 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
    : `${Math.round(bytes / 1024)} KB`
}

function row(entry: HarEntrySummary): string {
  const status = entry.status === 0 ? 'failed' : String(entry.status)
  return `  [${entry.index}] ${entry.method} ${status} · ${seconds(entry.ms)} · ${entry.url}`
}

function capped(entries: HarEntrySummary[]): string[] {
  const shown = entries.slice(0, SECTION_LIMIT).map(row)
  const rest = entries.length - shown.length
  return rest > 0 ? [...shown, `  …and ${rest} more`] : shown
}

/**
 * The summary as the agent reads it.
 *
 * `fileName` and `filePath` answer different questions: the first is what the
 * person called it, the second is where to go for the entry this summary does
 * not contain. `filePath` is OPTIONAL because it is not always knowable — a
 * pasted file has no path — and a summary that named one it does not have would
 * be a dead end wearing a pointer's clothes.
 */
export function harSummaryText(input: {
  fileName: string
  filePath?: string
  byteSize: number
  summary: HarSummary
}): string {
  const { summary } = input
  const lines: string[] = [
    `${input.fileName} — HAR network recording, ${kb(input.byteSize)}, ${summary.entries} requests over ${seconds(summary.spanMs)}.`,
    '',
  ]

  if (summary.hosts.length > 0) {
    lines.push(
      `Hosts: ${summary.hosts
        .slice(0, SECTION_LIMIT)
        .map((h) => `${h.host} (${h.count})`)
        .join(', ')}`,
    )
  }
  if (summary.statuses.length > 0) {
    lines.push(
      `Statuses: ${summary.statuses
        .map((s) => `${s.status === 0 ? 'failed' : s.status}×${s.count}`)
        .join(', ')}`,
    )
  }

  lines.push('')
  if (summary.failures.length === 0) {
    lines.push('No failed requests.')
  } else {
    lines.push(`Failed (${summary.failures.length}):`, ...capped(summary.failures))
  }
  if (summary.slow.length > 0) {
    lines.push('', `Slower than ${SLOW_MS / 1000}s (${summary.slow.length}):`, ...capped(summary.slow))
  }

  // THE WAY BACK IN. The summary is deliberately not the file; this is how an
  // agent gets the one entry that turns out to matter, and saying so is what
  // keeps the omission a boundary rather than a loss. Without a path there is
  // no way back in, and the line says that instead of pointing nowhere.
  lines.push(
    '',
    input.filePath === undefined
      ? 'Headers, cookies and bodies are NOT in this summary, and the recording itself was not attached — ask for it if a specific entry matters.'
      : `Headers, cookies and bodies are NOT in this summary. The full recording is at ${input.filePath} — read it for a specific entry by its [index]. If that read is refused, the file is outside this thread's projects; "Add folder to context…" on the thread menu opens it.`,
  )
  return lines.join('\n')
}
