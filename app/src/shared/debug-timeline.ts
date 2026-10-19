/**
 * ONE TIMELINE FROM SEVERAL SOURCES — and the short version that fits a turn.
 *
 * This is what the whole feature was for. A debug session collects browser
 * console, browser network, page interactions and the output of several
 * terminals; every record carries `at` on one measured clock; so the answer to
 * "what did the server print in the 400 ms after I clicked Save" is a sort and
 * a render.
 *
 * TWO OUTPUTS, DELIBERATELY DIFFERENT (allowed-pattern #18):
 *
 *   `timelineText`  — everything, for the file on disk. A HAR alone runs 1–22
 *                     MB and a noisy build prints tens of thousands of lines;
 *                     this is not something to put in a message.
 *   `summaryText`   — what a PERSON would read: what failed, what was slow,
 *                     what the server said around each failure, what was
 *                     clicked before it. This is what goes in the thread.
 *
 * REDACTION HAPPENS HERE, over BOTH halves. The browser's captures were already
 * redacted at their own boundary; terminal output has never been through one,
 * and server logs print connection strings and env dumps that headers never do.
 * `redactSecrets` takes text, which is exactly what terminal output is, so this
 * is one rule applied twice rather than a second implementation (NFR-5).
 *
 * Pure and DOM-free: records in, text out.
 */

import type { BrowserConsolePayload, BrowserNetworkPayload } from './browser-capture-types'
import type { DebugRecord, DebugSessionResult } from './debug-session-types'
import { redactSecrets } from './browser-capture-boundary'

/** Longest a single terminal chunk may be in the timeline. */
const MAX_CHUNK_CHARS = 2000
/**
 * How many failures the SUMMARY names.
 *
 * FIVE, NOT TWELVE. This is a context chip beside a composer, not a document —
 * a real session found 12 failures and printing each with three lines of
 * server context filled the whole conversation with a wall nobody could read
 * (user, 2026-09-21). The full record is one file away and is named on the last
 * line; the summary's job is to say what happened and where to look.
 */
const SUMMARY_SECTION_LIMIT = 5

/** How many lines of terminal context each failure carries. */
const CONTEXT_LINES_PER_FAILURE = 1

/** How many of the person's own steps the narrative retells. */
const NARRATIVE_STEP_LIMIT = 12
/** How many failures the narrative works through in full. */
const NARRATIVE_FAILURE_LIMIT = 6
/** How many terminal lines each of those failures carries. */
const NARRATIVE_CONTEXT_LINES = 4
/** How much context around a failure the summary shows. */
const CONTEXT_WINDOW_MS = 2000

/** Milliseconds from the session's start — what a reader actually wants. */
function offset(at: number, startedAt: number): string {
  const ms = Math.max(0, at - startedAt)
  if (ms < 1000) return `+${ms}ms`
  return `+${(ms / 1000).toFixed(2)}s`
}

/**
 * Terminal bytes as a reader can use them.
 *
 * Escape sequences are what makes a terminal a terminal and noise in a
 * transcript, so they go; the text does not. This is display cleanup, not
 * redaction — `redactSecrets` does that, separately and afterwards.
 */
function readableChunk(data: string): string {
  const stripped = data
    // CSI and OSC sequences — colour, cursor moves, title sets.
    .replace(/\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\][^]*(?:|\\)/g, '')
    .replace(/\r(?!\n)/g, '\n')
  return stripped.length > MAX_CHUNK_CHARS
    ? `${stripped.slice(0, MAX_CHUNK_CHARS)}\n…[${stripped.length - MAX_CHUNK_CHARS} more characters]`
    : stripped
}

/** One record as one line of the timeline. */
export function renderRecord(record: DebugRecord, startedAt: number): string {
  const when = offset(record.at, startedAt).padStart(9)
  if (record.source === 'interaction') {
    const where = record.url === undefined ? '' : ` ${record.url}`
    return `${when}  you        ${record.kind} ${record.target}${where}`
  }
  if (record.source === 'terminal') {
    const text = redactSecrets(readableChunk(record.data)).trimEnd()
    if (text === '') return ''
    // A chunk can be several lines; each is indented under the first so the
    // column stays readable rather than one long row.
    const [head, ...rest] = text.split('\n')
    const lines = [`${when}  ${record.label.padEnd(10).slice(0, 10)} ${head ?? ''}`]
    for (const line of rest) lines.push(`${' '.repeat(9)}  ${' '.repeat(10)} ${line}`)
    return lines.join('\n')
  }
  const capture = record.capture
  if (capture.kind === 'console') {
    const payload = capture.payload as BrowserConsolePayload
    return `${when}  console    ${payload.level.toUpperCase()} ${redactSecrets(payload.text)}`
  }
  if (capture.kind === 'network') {
    const payload = capture.payload as BrowserNetworkPayload
    const status = payload.status === 0 ? 'FAILED' : String(payload.status)
    return `${when}  network    ${payload.method} ${payload.url} → ${status} (${payload.timingMs}ms)`
  }
  return `${when}  browser    ${capture.kind}`
}

/** The whole recording, for the file on disk. */
export function timelineText(result: DebugSessionResult): string {
  const head = [
    `Debug session ${result.id}`,
    `Started  ${new Date(result.startedAt).toISOString()}`,
    `Ended    ${new Date(result.endedAt).toISOString()} (${result.end})`,
    `Window   ${((result.endedAt - result.startedAt) / 1000).toFixed(1)}s`,
    `Sources  ${result.terminals.map((t) => t.label).join(', ') || 'no terminals in scope'} + the embedded browser`,
    `Records  ${result.records.length}`,
  ]
  for (const [source, loss] of Object.entries(result.lost)) {
    head.push(
      `NOTE     ${source} hit its ceiling: ${loss.droppedRecords} records (${loss.droppedBytes} bytes) from the START of the window were dropped`,
    )
  }
  if (result.browserEvicted) {
    head.push(
      'NOTE     the browser’s own capture buffer had already dropped part of this window before it was read',
    )
  }
  if (result.end === 'capped') {
    head.push('NOTE     this session stopped itself at its time limit — it was not finished by hand')
  }

  const body = result.records
    .map((record) => renderRecord(record, result.startedAt))
    .filter((line) => line !== '')

  const tail: string[] = []
  const preRoll = result.preRoll.filter((entry) => entry.text.trim() !== '')
  if (preRoll.length > 0) {
    tail.push(
      '',
      '── Before recording started ─────────────────────────────────────────────',
      'Untimed. The terminal display buffer carries no clock, so this cannot be',
      'placed on the timeline above — it is here as context only, and the order',
      'between it and anything else is unknown.',
      '',
    )
    for (const entry of preRoll) {
      tail.push(`[${entry.label}]`, redactSecrets(readableChunk(entry.text)).trimEnd(), '')
    }
  }

  return [...head, '', '── Timeline ─────────────────────────────────────────────────────────────', ...body, ...tail].join('\n') + '\n'
}

/** A failure worth leading with. */
interface Failure {
  at: number
  what: string
}

/**
 * The failures in a window, DEDUPED — one entry per distinct thing that broke.
 *
 * A single failed request arrives as several records: the network entry, a
 * "Failed to load resource" console line the browser prints about it, and often
 * the app's own error log. Counted separately, one 404 became three failures
 * and the summary said "8 failures" about three (user, 2026-09-21).
 *
 * The key is WHAT broke, not when: a request repeated at two different moments
 * is still worth seeing twice, so the timestamp stays out of the key only for
 * entries that land within a second of each other.
 */
function failuresIn(records: readonly DebugRecord[]): Failure[] {
  const out: Failure[] = []
  const seen = new Map<string, number>()
  const take = (at: number, what: string, key: string): void => {
    const last = seen.get(key)
    // The same failure a second later is the same failure; a minute later is a
    // new one, and a reader wants to know it happened again.
    if (last !== undefined && at - last < DEDUPE_WINDOW_MS) return
    seen.set(key, at)
    out.push({ at, what })
  }

  for (const record of records) {
    if (record.source !== 'browser') continue
    if (record.capture.kind === 'network') {
      const payload = record.capture.payload as BrowserNetworkPayload
      if (payload.status === 0 || payload.status >= 400) {
        take(
          record.at,
          `${payload.method} ${payload.url} → ${payload.status === 0 ? 'never completed' : payload.status}`,
          `net:${payload.method}:${stripQuery(payload.url)}:${payload.status}`,
        )
      }
    }
    if (record.capture.kind === 'console') {
      const payload = record.capture.payload as BrowserConsolePayload
      if (payload.level !== 'error') continue
      const text = redactSecrets(payload.text)
      // A BROWSER'S OWN NOISE ABOUT A REQUEST IS NOT A SEPARATE FAILURE. It is
      // the same 404 the network entry already reported, in different words.
      if (ECHOES_A_REQUEST.test(text)) continue
      take(record.at, text.slice(0, 160), `console:${text.slice(0, 120)}`)
    }
  }
  return out
}

/**
 * The terminal lines worth quoting under a failure.
 *
 * TAKING WHATEVER WAS NEAREST IN TIME DOES NOT WORK. A busy backend logs
 * continuously, so a ±2s window around a failure is four lines of whatever that
 * service happened to be doing — and every failure in the artifact quoted the
 * same four, none of them related to any of them (user, 2026-09-21).
 *
 * Scored instead, by whether a line could plausibly be ABOUT this failure:
 * it mentions the path, it mentions the status, it is an error or a warning, or
 * it came just after (a server logs a failure after handling it, not before).
 * Nothing scoring zero is quoted at all — better to say the terminals were
 * silent than to print four unrelated lines under a heading that claims
 * otherwise.
 */
export function terminalContextFor(
  failure: { at: number; what: string },
  records: readonly DebugRecord[],
  limit: number,
): { label: string; text: string }[] {
  const path = pathIn(failure.what)
  const status = /→ (\d{3})\b/.exec(failure.what)?.[1]

  const scored: { score: number; at: number; label: string; text: string }[] = []
  for (const record of records) {
    if (record.source !== 'terminal') continue
    const delta = record.at - failure.at
    if (delta < -CONTEXT_WINDOW_MS || delta > CONTEXT_WINDOW_MS) continue
    const cleaned = redactSecrets(readableChunk(record.data))
    for (const raw of cleaned.split('\n')) {
      const line = raw.trim()
      if (line === '') continue
      let score = 0
      if (path !== null && line.includes(path)) score += 6
      if (status !== undefined && line.includes(status)) score += 3
      if (/\b(error|exception|traceback|failed|fatal)\b/i.test(line)) score += 4
      if (/\bwarn/i.test(line)) score += 1
      // A server logs a failure AFTER handling the request.
      if (delta >= 0) score += 1
      // Routine trace is what floods the window in the first place.
      if (/\bDEBUG\b/.test(line)) score -= 2
      if (score <= 0) continue
      scored.push({ score, at: record.at, label: record.label, text: line })
    }
  }

  scored.sort((a, b) => b.score - a.score || Math.abs(a.at - failure.at) - Math.abs(b.at - failure.at))
  const out: { label: string; text: string }[] = []
  const seen = new Set<string>()
  for (const entry of scored) {
    if (out.length >= limit) break
    const key = `${entry.label}:${entry.text}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ label: entry.label, text: entry.text })
  }
  return out
}

/** The request path a failure line names, for matching against server logs. */
function pathIn(what: string): string | null {
  const url = /(https?:\/\/[^\s]+)/.exec(what)?.[1]
  if (url === undefined) return null
  try {
    const { pathname } = new URL(url)
    return pathname === '/' ? null : pathname
  } catch {
    return null
  }
}

/** Within this, the same failure is the same occurrence. */
const DEDUPE_WINDOW_MS = 5000

/** Console lines the browser emits ABOUT a request the network entry has. */
const ECHOES_A_REQUEST =
  /^Failed to load resource|^net::ERR_|ERR_(?:CONNECTION|ABORTED|FAILED|NAME_NOT)/

/** A URL without its query, so the same endpoint keys the same. */
function stripQuery(url: string): string {
  const at = url.indexOf('?')
  return at === -1 ? url : url.slice(0, at)
}

/**
 * The version that goes in the thread.
 *
 * LEADS WITH WHAT FAILED, because that is why somebody recorded. Then, for each
 * failure, what the terminals printed around it — which is the correlation the
 * engineer used to assemble by hand, and the entire reason this feature exists.
 */
export function summaryText(result: DebugSessionResult, artifactPath: string | null): string {
  const seconds = ((result.endedAt - result.startedAt) / 1000).toFixed(1)
  const lines: string[] = [
    `**Debug session** — ${seconds}s, ${result.records.length} records across ${result.terminals.length === 0 ? 'no terminals' : result.terminals.map((t) => t.label).join(' + ')} and the browser.`,
  ]
  if (result.end === 'capped') {
    lines.push('', 'It stopped itself at its time limit rather than running on.')
  }

  const failures = failuresIn(result.records)
  if (failures.length === 0) {
    lines.push('', 'Nothing failed inside the window — no error logs and no failed requests.')
  } else {
    lines.push('', `**${failures.length} failure${failures.length === 1 ? '' : 's'}:**`)
    for (const failure of failures.slice(0, SUMMARY_SECTION_LIMIT)) {
      lines.push(`- \`${offset(failure.at, result.startedAt)}\` ${failure.what}`)
      // WHAT THE SERVER SAID AROUND IT. This is the half an engineer used to
      // fetch from another pane by hand.
      const nearby = result.records.filter(
        (record) =>
          record.source === 'terminal' &&
          Math.abs(record.at - failure.at) <= CONTEXT_WINDOW_MS,
      )
      for (const record of nearby.slice(0, CONTEXT_LINES_PER_FAILURE)) {
        if (record.source !== 'terminal') continue
        const text = redactSecrets(readableChunk(record.data)).trim().split('\n')[0] ?? ''
        if (text !== '') lines.push(`  - \`${record.label}\` ${text.slice(0, 110)}`)
      }
      // AND WHAT THE PERSON DID BEFORE IT — the other half of the correlation.
      const before = result.records
        .filter((record) => record.source === 'interaction' && record.at <= failure.at)
        .slice(-1)[0]
      if (before !== undefined && before.source === 'interaction') {
        lines.push(`  - you ${before.kind} ${before.target} just before this`)
      }
    }
    if (failures.length > SUMMARY_SECTION_LIMIT) {
      lines.push(`- …and ${failures.length - SUMMARY_SECTION_LIMIT} more, in the full record.`)
    }
  }

  const notes: string[] = []
  for (const [source, loss] of Object.entries(result.lost)) {
    notes.push(`${source} dropped ${loss.droppedRecords} records from the start of the window`)
  }
  if (result.browserEvicted) {
    notes.push('the browser’s capture buffer had already dropped part of this window')
  }
  if (notes.length > 0) lines.push('', `_Incomplete: ${notes.join('; ')}._`)

  if (artifactPath !== null) {
    lines.push('', `Full timeline and HAR: \`${artifactPath}\``)
  } else {
    // The artifact could not be written; the summary still reaches the thread,
    // because the summary is the part a person reads.
    lines.push('', '_The full record could not be written to disk, so this summary is all of it._')
  }
  return lines.join('\n')
}

/**
 * THE SHORT VERSION — what a person actually reads.
 *
 * `timelineText` is the record: every console line, every request, every chunk
 * of server output, in order. It is the SOURCE OF TRUTH and it is 4,500 lines
 * of it, which is exactly the wrong thing to hand somebody who just wants to
 * know what went wrong (user, 2026-09-21).
 *
 * This is the story of the reproduction instead: where the person was, what
 * they did, what came back, and what the server said about it — in that order,
 * because that is the order a person reconstructs it in. The full record is
 * named at the bottom, one click away, for the moment the short version is not
 * enough.
 *
 * Both are written. Neither replaces the other.
 */
export function narrativeText(
  result: DebugSessionResult,
  links: {
    /**
     * The timeline, relative TO THE PROJECT — not to this file.
     *
     * A sibling link (`timeline.md`) rendered fine and opened nothing: the
     * markdown surface resolves a link against the project root, so a path
     * relative to the summary's own folder pointed at a file that is not there
     * (user, 2026-09-21: "when i click on the timeline.md i'm not able to open
     * it").
     */
    timeline: string
  },
): string {
  const seconds = ((result.endedAt - result.startedAt) / 1000).toFixed(1)
  const when = new Date(result.startedAt).toLocaleString()
  const out: string[] = [
    '# Debug session',
    '',
    `${when} · ${seconds}s · ${result.records.length} records`,
    '',
  ]

  const sources = result.terminals.map((terminal) => terminal.label)
  out.push(
    sources.length === 0
      ? 'Captured the browser. No terminals were in this conversation.'
      : `Captured the browser and ${sources.join(', ')}.`,
    '',
  )

  // ── WHERE THEY WERE, AND WHAT THEY DID ──────────────────────────────────
  const steps = result.records.filter(
    (record): record is Extract<DebugRecord, { source: 'interaction' }> =>
      record.source === 'interaction',
  )
  out.push('## What you did', '')
  if (steps.length === 0) {
    out.push(
      'Nothing was captured from the page itself — no clicks and no navigation.',
      'Either the reproduction happened outside the browser, or it began before',
      'the session did.',
    )
  } else {
    const firstPage = steps.find((step) => step.url !== undefined)?.url
    if (firstPage !== undefined) out.push(`Started on \`${firstPage}\`.`, '')
    for (const step of steps.slice(0, NARRATIVE_STEP_LIMIT)) {
      const at = offset(step.at, result.startedAt)
      if (step.kind === 'click') out.push(`- \`${at}\` clicked **${step.target}**`)
      else out.push(`- \`${at}\` ${step.kind} \`${step.url ?? ''}\``)
    }
    if (steps.length > NARRATIVE_STEP_LIMIT) {
      out.push(`- …and ${steps.length - NARRATIVE_STEP_LIMIT} more, in the full record.`)
    }
  }
  out.push('')

  // ── WHAT CAME BACK ──────────────────────────────────────────────────────
  const failures = failuresIn(result.records)
  out.push('## What went wrong', '')
  if (failures.length === 0) {
    out.push('Nothing failed inside the window — no error logs and no failed requests.')
  } else {
    out.push(`${failures.length} failure${failures.length === 1 ? '' : 's'}.`, '')
    for (const failure of failures.slice(0, NARRATIVE_FAILURE_LIMIT)) {
      out.push(`### \`${offset(failure.at, result.startedAt)}\` ${failure.what}`, '')
      const before = steps.filter((step) => step.at <= failure.at).slice(-1)[0]
      if (before !== undefined) {
        out.push(`Right after you ${before.kind === 'click' ? 'clicked' : before.kind} **${before.target}**.`, '')
      }
      // WHAT THE SERVER SAID, which is the half that used to be fetched from
      // another pane by hand and is the entire reason this feature exists.
      // Scored rather than nearest-in-time — see `terminalContextFor`.
      const context = terminalContextFor(failure, result.records, NARRATIVE_CONTEXT_LINES)
      if (context.length === 0) {
        out.push('Nothing in the terminals looks related to this.', '')
      } else {
        out.push('The terminals said:', '')
        for (const line of context) out.push(`- \`${line.label}\` ${line.text.slice(0, 200)}`)
        out.push('')
      }
    }
    if (failures.length > NARRATIVE_FAILURE_LIMIT) {
      out.push(`…and ${failures.length - NARRATIVE_FAILURE_LIMIT} more, in the full record.`, '')
    }
  }

  // ── WHAT THIS DOES NOT SAY ──────────────────────────────────────────────
  const gaps: string[] = []
  for (const [source, loss] of Object.entries(result.lost)) {
    gaps.push(`${source} dropped ${loss.droppedRecords} records from the start of the window`)
  }
  if (result.browserEvicted) {
    gaps.push("the browser's capture buffer had already dropped part of this window")
  }
  if (result.end === 'capped') gaps.push('this session stopped itself at its time limit')
  if (steps.length === 0) gaps.push('no page interactions were captured')
  if (gaps.length > 0) {
    out.push('## What this does not cover', '', ...gaps.map((gap) => `- ${gap}`), '')
  }

  // ── THE SOURCE OF TRUTH ─────────────────────────────────────────────────
  out.push(
    '## The full record',
    '',
    `Everything above is a reading of [\`${links.timeline}\`](${links.timeline}) — every`,
    'record from every source, in the order it happened. That file is the source',
    'of truth; this one is a summary of it.',
  )
  // THE HAR IS NOT LINKED. It is written beside the timeline for anyone who
  // wants to open it in devtools, but a summary is what a person reads, and a
  // second link to a megabyte of JSON is a thing to explain rather than a thing
  // to use (user, 2026-09-21: "we don't need to attach into the summary").
  return out.join('\n') + '\n'
}
