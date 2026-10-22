/**
 * Pure, DOM-free REQUEST fold for the conversation feed (plan_chat-cleanup,
 * FR-1–FR-10, FR-15).
 *
 * `turn-summary.ts` folds one assistant message plus its tools. A person does
 * not read turns, though: they ask for something and wait for the answer. A
 * request that runs a skill speaks six or seven times before it answers, and a
 * background wake-up adds more turns after the answer. So this module folds on
 * the widest axis: everything from a person's message to the request's FINAL
 * answer becomes one unit — numbered steps (each assistant message with the
 * tools after it) and one answer.
 *
 * Disciplines inherited from `planTurns` and `planToolGroups`:
 *   - Order is NEVER changed. `entries` on a request holds every entry it
 *     covers in the original order, so the fold is reversible and idempotent.
 *   - Every input entry appears exactly once. The one entry that is not SHOWN
 *     is the exact `No change.` answer — it is still in `entries`, and counted
 *     in `hiddenNoChange`, so nothing is deleted (NFR-2).
 *   - A card the person must act on (a permission ask, a question) is never
 *     folded: it passes through and splits the request.
 *   - No DOM, no view types: the caller classifies its own entries.
 *
 * How the answer is chosen (FR-7, FR-8):
 *   - The answer is the LAST turn-ending assistant message (`endsTurn: true`)
 *     whose text is not exactly `No change.`. Earlier turn-ending messages —
 *     "I'll continue when the helpers report" — stay in the steps.
 *   - A request in which NO message carries the mark (every thread stored
 *     before the mark existed) falls back to its last assistant message.
 *   - A request part that a card ended gets no fallback: its turn was waiting
 *     on the person, not finished.
 *   - A request that a LATER person's message ended while its turn was still
 *     running gets no fallback either (plan_mid-run-subtasks): a mid-run
 *     message goes into the live turn, so no turn-end mark falls between the
 *     two messages and the turn's answer lands in the later request. It is
 *     recognised from the marks alone — it has none, and the requests after it
 *     either carry one or are the running one — and it is `continued`; the
 *     message that ended it is `sentWhileWorking`. A thread with no marks at
 *     all (stored before the mark existed) keeps the old fallback.
 *   - A wake-up turn ending `No change.` is hidden; one ending with a real
 *     reply replaces the shown answer (FR-9, FR-10).
 */
import type { ToolCallRecord } from '../../shared/ipc-contract'
import { turnSummary } from './turn-summary'

/**
 * What an entry is, as far as the request fold cares. Injected by the caller.
 *
 * - `user` opens a request. `createdAt` (optional) is when the work started.
 * - `assistant` is a step, or the answer. `endsTurn` is the stored turn-end
 *   mark; `content` is read only to recognise the exact `No change.` reply.
 * - `tool` belongs to the step before it. It carries the stored record so the
 *   counts come from `turnSummary`, the one place tool facts are derived
 *   (allowed-pattern #14) — no copied "which status failed" rule here.
 * - `card` is a permission ask or a question card: never folded, it ends the
 *   request so far and passes through as itself.
 * - `other` is a system row (an artifact marker, a failure notice). It stays
 *   visible, in order, AFTER the answer (`trailing`) — those rows are the doc
 *   cards FR-6 puts under the answer. Outside any request it passes through.
 */
export type RequestRole =
  | { kind: 'user'; createdAt?: string }
  | {
      kind: 'assistant'
      messageId: string
      endsTurn: boolean
      content: string
      model: string | null
      createdAt: string
    }
  | { kind: 'tool'; messageId: string | null; record: ToolCallRecord }
  | { kind: 'card' }
  | { kind: 'other' }

/** One step of a request: an assistant message and the tools after it. A step
 *  whose tools ran before any message (or after the answer, or after a hidden
 *  `No change.`) has no head. */
export interface RequestStep<T> {
  head: T | null
  tools: T[]
}

/** A folded request — the person's message to the final answer. */
export interface Request<T> {
  request: true
  /** The person's message, or null for a request that continues after a card
   *  (or that starts the slice without one). */
  user: T | null
  /** The steps, in order. The answer is never a step; tools that ran under
   *  the answer message form a headless step at their place. */
  steps: Array<RequestStep<T>>
  /** The shown answer, or null when no turn has given one. */
  answer: T | null
  /** How many exact `No change.` replies were removed from view. */
  hiddenNoChange: number
  /** True for the last request of the slice while its work is not done. */
  live: boolean
  /** A later message of the person's ended this request while its turn was
   *  still running, so its answer is in a request after it. */
  continued: boolean
  /** The person sent this request's message while the agent was working on
   *  the request before it. */
  sentWhileWorking: boolean
  /** System rows of the request, shown after the answer in their order. */
  trailing: T[]
  /** Every entry the request covers, in the original order — the inverse of
   *  the fold, including the hidden `No change.` replies. */
  entries: T[]
}

/** A render unit of the request fold: a pass-through single, or a request. */
export type RequestUnit<T> = { request: false; entry: T } | Request<T>

export interface PlanRequestsOptions {
  /**
   * Whether the thread is running a turn now. When given, it decides `live`
   * for the last request, and a running request gets NO fallback answer — its
   * messages are steps of a turn that has not ended. When omitted, `live` is
   * inferred: the last request with no answer and no hidden `No change.`.
   */
  running?: boolean
}

const NO_CHANGE = 'No change.'

/**
 * True only for the exact reply `No change.`, after trimming whitespace.
 *
 * Exact text, by design: no case folding, no backticks, no "Nothing new." —
 * the writing rules tell the agent to reply exactly this, and anything else is
 * a real answer that must stay visible. Hiding by a guess at wording is
 * ruled out (plan Intent).
 */
export function isNoChangeAnswer(content: string): boolean {
  return content.trim() === NO_CHANGE
}

type Item<T> =
  | { kind: 'assistant'; entry: T; endsTurn: boolean; noChange: boolean }
  | { kind: 'tool'; entry: T }
  | { kind: 'other'; entry: T }

interface Open<T> {
  user: T | null
  items: Array<Item<T>>
  entries: T[]
  /** A card ended this part: the turn was waiting on the person, not done,
   *  so the unmarked fallback must not crown a step as the answer. */
  endedByCard: boolean
  /** A later person's message ended this part (not a card, not the slice). */
  endedByUser: boolean
}

/**
 * Fold a sorted entry list into request units. See the module header for the
 * rules; order is preserved and every entry appears exactly once.
 */
export function planRequests<T>(
  entries: readonly T[],
  classify: (entry: T) => RequestRole,
  options: PlanRequestsOptions = {},
): Array<RequestUnit<T>> {
  // Requests stay open builders until the end: whether one is the LAST request
  // (for `live` and the running case) is known only after the whole slice.
  const pending: Array<{ request: false; entry: T } | Open<T>> = []
  let open: Open<T> | null = null

  const ensureOpen = (): Open<T> => {
    if (open === null) {
      open = { user: null, items: [], entries: [], endedByCard: false, endedByUser: false }
      pending.push(open)
    }
    return open
  }

  for (const entry of entries) {
    const role = classify(entry)
    switch (role.kind) {
      case 'user':
        if (open !== null) open.endedByUser = true
        open = { user: entry, items: [], entries: [entry], endedByCard: false, endedByUser: false }
        pending.push(open)
        break
      case 'card':
        if (open !== null) open.endedByCard = true
        open = null
        pending.push({ request: false, entry })
        break
      case 'other':
        if (open === null) {
          pending.push({ request: false, entry })
        } else {
          open.items.push({ kind: 'other', entry })
          open.entries.push(entry)
        }
        break
      case 'assistant': {
        const target = ensureOpen()
        target.items.push({
          kind: 'assistant',
          entry,
          endsTurn: role.endsTurn,
          noChange: isNoChangeAnswer(role.content),
        })
        target.entries.push(entry)
        break
      }
      case 'tool': {
        const target = ensureOpen()
        target.items.push({ kind: 'tool', entry })
        target.entries.push(entry)
        break
      }
    }
  }

  // A card after the last request does not make it any less the last.
  let lastIndex = -1
  pending.forEach((unit, index) => {
    if (!('request' in unit)) lastIndex = index
  })

  const continued = continuedRequests(pending, lastIndex, options.running === true)

  let previousContinued = false
  return pending.map((unit, index): RequestUnit<T> => {
    if ('request' in unit) {
      previousContinued = false
      return unit
    }
    const isLast = index === lastIndex
    const isContinued = continued.has(unit)
    // A running request has no fallback answer: its unmarked messages are the
    // steps of a turn that has not ended yet. A continued one has none either:
    // its turn's answer is in a later request.
    const request = settle(
      unit,
      unit.endedByCard || isContinued || (isLast && options.running === true),
    )
    request.continued = isContinued
    request.sentWhileWorking = previousContinued && unit.user !== null
    previousContinued = isContinued
    if (isLast) {
      request.live =
        options.running ?? (request.answer === null && request.hiddenNoChange === 0)
    }
    return request
  })
}

function hasMark<T>(open: Open<T>): boolean {
  return open.items.some((item) => item.kind === 'assistant' && item.endsTurn)
}

/**
 * The requests a later person's message ended mid-turn. Walked from the end:
 * a request with no mark is continued when the request right after it (with
 * no card between) has a mark, is itself continued, or is the last one while
 * a turn runs. A slice with no mark at all continues nothing — it predates
 * the mark, and the fallback answer is the only one it has.
 */
function continuedRequests<T>(
  pending: ReadonlyArray<{ request: false; entry: T } | Open<T>>,
  lastIndex: number,
  running: boolean,
): Set<Open<T>> {
  const out = new Set<Open<T>>()
  // Does the request after the one being judged carry the turn on?
  let nextCarries: boolean = false
  for (let index = pending.length - 1; index >= 0; index -= 1) {
    const unit = pending[index]
    if ('request' in unit) {
      nextCarries = false
      continue
    }
    const marked: boolean = hasMark(unit)
    const isContinued: boolean = !marked && unit.endedByUser && !unit.endedByCard && nextCarries
    if (isContinued) out.add(unit)
    nextCarries = marked || isContinued || (index === lastIndex && running)
  }
  return out
}

/** Choose the answer, hide the `No change.` replies, and build the steps. */
function settle<T>(open: Open<T>, noFallback = false): Request<T> {
  const assistants = open.items.filter(
    (item): item is Extract<Item<T>, { kind: 'assistant' }> => item.kind === 'assistant',
  )
  const marked = assistants.some((item) => item.endsTurn)
  // The answer candidates: the turn-ending messages, or — for a request stored
  // before the mark existed — every assistant message, so the last one wins.
  let candidates: typeof assistants
  if (marked) candidates = assistants.filter((item) => item.endsTurn)
  else if (noFallback) candidates = []
  else candidates = assistants

  const hidden = new Set<Item<T>>(candidates.filter((item) => item.noChange))
  const real = candidates.filter((item) => !item.noChange)
  const answerItem = real.length > 0 ? real[real.length - 1] : null

  const steps: Array<RequestStep<T>> = []
  const trailing: T[] = []
  let current: RequestStep<T> | null = null
  for (const item of open.items) {
    if (item.kind === 'other') {
      trailing.push(item.entry)
      continue
    }
    if (item.kind === 'tool') {
      if (current === null) {
        current = { head: null, tools: [] }
        steps.push(current)
      }
      current.tools.push(item.entry)
      continue
    }
    if (item === answerItem || hidden.has(item)) {
      // Not a step. Tools that follow it open a headless step at their place.
      current = null
      continue
    }
    current = { head: item.entry, tools: [] }
    steps.push(current)
  }

  return {
    request: true,
    user: open.user,
    steps,
    answer: answerItem === null ? null : answerItem.entry,
    hiddenNoChange: hidden.size,
    live: false,
    continued: false,
    sentWhileWorking: false,
    trailing,
    entries: open.entries,
  }
}

// ── The work row's facts ────────────────────────────────────────────────────

/** The facts one work row states. */
export interface RequestSummary {
  /** From the person's message (or the first activity) to the last activity,
   *  or to now while live. Null when no time is known. */
  elapsedMs: number | null
  tools: number
  /** Error or denied — never interrupted (`FAILED_STATUSES`). */
  failed: number
  /** Distinct files written to. */
  filesEdited: number
  /** The answer's model, else the newest step's model with one. */
  model: string | null
  /** The request was ended by a later message while its turn ran — its row
   *  reads as continued, not as a finished answer. Absent = false. */
  continued?: boolean
}

export interface RequestSummaryDeps<T> {
  classify: (entry: T) => RequestRole
  /** The clock for a live request's elapsed time. Defaults to `Date.now`. */
  now?: () => number
}

/**
 * Reduce a request to the facts its work row states. The tool counts are
 * `turnSummary` over the request's tool records — the same rule a turn row
 * uses for failures and files edited, in one code path.
 */
export function requestSummary<T>(request: Request<T>, deps: RequestSummaryDeps<T>): RequestSummary {
  const records: ToolCallRecord[] = []
  const times: number[] = []
  let start: number | null = null
  let model: string | null = null
  let answerModel: string | null = null

  const addTime = (iso: string | null | undefined): void => {
    if (iso === null || iso === undefined) return
    const ms = Date.parse(iso)
    if (!Number.isNaN(ms)) times.push(ms)
  }

  for (const entry of request.entries) {
    const role = deps.classify(entry)
    if (role.kind === 'user') {
      if (role.createdAt !== undefined) {
        const ms = Date.parse(role.createdAt)
        if (!Number.isNaN(ms)) start = ms
      }
    } else if (role.kind === 'assistant') {
      addTime(role.createdAt)
      if (entry === request.answer) answerModel = role.model
      else if (role.model !== null) model = role.model
    } else if (role.kind === 'tool') {
      records.push(role.record)
      addTime(role.record.startedAt)
      addTime(role.record.completedAt)
    }
  }

  const counts = turnSummary(records)
  const first = start ?? (times.length > 0 ? Math.min(...times) : null)
  let elapsedMs: number | null = null
  if (first !== null) {
    const end = request.live
      ? (deps.now ?? Date.now)()
      : times.length > 0
        ? Math.max(...times)
        : first
    elapsedMs = Math.max(0, end - first)
  }

  return {
    elapsedMs,
    tools: counts.tools,
    failed: counts.failed,
    filesEdited: counts.filesEdited,
    model: answerModel ?? model,
    ...(request.continued ? { continued: true } : {}),
  }
}

const SEPARATOR = ' ' + String.fromCharCode(183) + ' '
/** The closing fact of a request a mid-run message ended. */
export const CONTINUED_TEXT = 'continued below'
const MINUTE_MS = 60_000
const MINUTES_PER_HOUR = 60

const plural = (count: number, noun: string): string =>
  count + ' ' + noun + (count === 1 ? '' : 's')

/** `<1 min`, `6 min`, `1 h`, `1 h 5 min` — whole minutes, rounded down. */
export function formatRequestElapsed(ms: number): string {
  const minutes = Math.floor(ms / MINUTE_MS)
  if (minutes < 1) return '<1 min'
  if (minutes < MINUTES_PER_HOUR) return minutes + ' min'
  const hours = Math.floor(minutes / MINUTES_PER_HOUR)
  const rest = minutes % MINUTES_PER_HOUR
  return rest === 0 ? hours + ' h' : hours + ' h ' + rest + ' min'
}

/** One piece of the row's line, with whether it is the failure fact. */
export interface RequestRowSegment {
  text: string
  failed: boolean
}

/**
 * The row's line as segments: `Worked 6 min`, `25 tools`, `1 failed`,
 * `2 files edited` — or `Working`, `3 min`, `19 tools` while live. A zero
 * count is omitted. The failure segment is flagged by VALUE, as
 * `turnRowSegments` does, so no other segment can inherit the error tint.
 */
export function requestRowSegments(summary: RequestSummary, live: boolean): RequestRowSegment[] {
  const time = summary.elapsedMs === null ? null : formatRequestElapsed(summary.elapsedMs)
  const texts: string[] = []
  if (live) {
    texts.push('Working')
    if (time !== null) texts.push(time)
  } else {
    texts.push(time === null ? 'Worked' : 'Worked ' + time)
  }
  if (summary.tools > 0) texts.push(plural(summary.tools, 'tool'))
  const failedText = summary.failed > 0 ? summary.failed + ' failed' : null
  if (failedText !== null) texts.push(failedText)
  if (summary.filesEdited > 0) texts.push(plural(summary.filesEdited, 'file') + ' edited')
  if (!live && summary.continued === true) texts.push(CONTINUED_TEXT)
  return texts.map((text) => ({ text, failed: text === failedText }))
}

/** The row's whole line, e.g. `Worked 6 min · 25 tools · 1 failed · 2 files edited`. */
export function requestRowLabel(summary: RequestSummary, live: boolean): string {
  return requestRowSegments(summary, live)
    .map((segment) => segment.text)
    .join(SEPARATOR)
}
