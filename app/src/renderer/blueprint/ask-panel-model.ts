// Ask the Blueprint — the panel's whole behaviour as a pure reducer (plan
// `ask_the_blueprint`, Phase 3, change note 7).
//
// The view is thin: it turns DOM events and `ask:state` events into
// `AskPanelEvent`s, hands them to `reduceAsk`, and draws what comes back. The
// board asks `askDecoration(state)` what the map shows and redraws only when
// that answer changes (NFR-4, allowed-pattern #17).
//
// ONE QUESTION IS A TURN. The first turn is the question; every later turn is
// a follow-up on the same saved entry (FR-12). Inside a turn, the fast answer
// and the checked answer REPLACE EACH OTHER IN PLACE — main sends the best
// answer so far on every state event, and the turn keeps only that, plus
// whether the checked one changed from the first (FR-6).
//
// DOM-free and clock-free: every event that needs a time carries `at`, so the
// reducer is testable without a window or a timer.

import type {
  AskAnswer,
  AskOpenTag,
  AskSavedThread,
  AskStaleResult,
  AskStateEvent,
  AskStep,
} from '../../shared/ask-contract'

/* ── State ──────────────────────────────────────────────────────────────── */

export type AskTagKind = 'feature' | 'part' | 'conversation'

/** One chip in the question box. */
export interface AskTag {
  id: string
  kind: AskTagKind
  label: string
}

/** A tag the pasted text names, waiting for the person to add it (FR-3). */
export interface AskSuggestion {
  id: string
  kind: 'feature' | 'part'
  label: string
}

/** Where one turn stands. `idle` is the panel with no turn at all. */
export type AskPanelPhase = 'idle' | 'fast' | 'digging' | 'done' | 'partial' | 'error'

/** A saved answer opened from the list — read, not asked. */
export interface AskSavedMark {
  id: string
  author: string
  ts: string
  stale: boolean
  usedConversation: boolean
}

/** One question and its answer. */
export interface AskTurn {
  /** Main's id for the run; null between Ask and `ask:start`'s answer, and for a saved answer. */
  askId: string | null
  question: string
  tags: AskTag[]
  phase: Exclude<AskPanelPhase, 'idle'>
  /** The best answer so far — the fast one, then the checked one in its place. */
  answer: AskAnswer | null
  /** The first answer's text, kept only to say whether the checked one changed. */
  firstExplanation: string | null
  changedFromFirst: boolean
  steps: AskStep[]
  reads: number
  /** How long the dig has run, as main last reported it. */
  digElapsedMs: number
  /** When Ask was pressed (the view's clock), for "4 s" beside the badge. */
  startedAt: number
  /** How long the shown answer took, from Ask. */
  answeredAfterMs: number | null
  /** The plain sentence an error ends with. */
  error: string | null
  /** Stop here was pressed and main has not answered with partial yet. */
  stopping: boolean
  /** Present when this turn is a saved answer opened from a list. */
  saved: AskSavedMark | null
}

export type AskPanelView = 'compose' | 'answer' | 'history'

export interface AskPanelState {
  open: boolean
  view: AskPanelView
  /** The question box's text. */
  draft: string
  /** The chips in the question box. */
  tags: AskTag[]
  /** Tags the pasted text names, not yet added. */
  suggestions: AskSuggestion[]
  /** Saved questions about the tagged features (FR-4), newest first. */
  askedBefore: AskSavedThread[]
  /** Saved entries whose code changed since (FR-13). */
  staleIds: string[]
  /** The saved list the history button shows; null until it is read. */
  history: AskSavedThread[] | null
  /** Why the saved list could not be read, as a plain sentence. */
  historyError: string | null
  /** The question and its follow-ups, oldest first. Empty in compose. */
  turns: AskTurn[]
}

export function initialAskState(): AskPanelState {
  return {
    open: false,
    view: 'compose',
    draft: '',
    tags: [],
    suggestions: [],
    askedBefore: [],
    staleIds: [],
    history: null,
    historyError: null,
    turns: [],
  }
}

/* ── Events ─────────────────────────────────────────────────────────────── */

export type AskPanelEvent =
  /** Open. With text or tags, a fresh question; with neither, where it was left. */
  | { type: 'open'; text?: string; tags?: AskTag[] }
  | { type: 'close' }
  | { type: 'draft'; text: string }
  | { type: 'add-tag'; tag: AskTag }
  | { type: 'remove-tag'; id: string }
  /** What the suggester found in pasted text. Already-tagged ids are dropped here. */
  | { type: 'suggest'; suggestions: AskSuggestion[] }
  | { type: 'accept-suggestion'; id: string }
  | { type: 'accept-all-suggestions' }
  | { type: 'dismiss-suggestions' }
  | { type: 'asked-before'; threads: AskSavedThread[]; stale: AskStaleResult[] }
  /** Ask pressed — the question in the box, or a follow-up. */
  | { type: 'submit'; question: string; followUp: boolean; at: number }
  /** `ask:start` answered with an id for the newest turn. */
  | { type: 'started'; askId: string }
  /** `ask:start` refused. */
  | { type: 'start-failed'; sentence: string }
  /** One `ask:state` event. Events for a run no turn owns are ignored. */
  | { type: 'state'; event: AskStateEvent; at: number }
  | { type: 'stop' }
  /** Back to the question box, keeping the tags. */
  | { type: 'new-question' }
  | { type: 'show-history' }
  | { type: 'history'; threads: AskSavedThread[]; stale: AskStaleResult[] }
  | { type: 'history-failed'; sentence: string }
  /** A saved answer picked from a list: shown as a turn, with its follow-ups. */
  | { type: 'open-saved'; thread: AskSavedThread }

/* ── The reducer ────────────────────────────────────────────────────────── */

/** How many follow-ups one question keeps (FR-12: "one short thread"). */
export const MAX_FOLLOW_UPS = 6

export function reduceAsk(state: AskPanelState, event: AskPanelEvent): AskPanelState {
  switch (event.type) {
    case 'open': {
      const fresh = event.text !== undefined || (event.tags !== undefined && event.tags.length > 0)
      if (!fresh) return { ...state, open: true }
      return {
        ...state,
        open: true,
        view: 'compose',
        draft: event.text ?? '',
        tags: uniqueTags(event.tags ?? []),
        suggestions: [],
        turns: [],
      }
    }
    case 'close':
      return state.open ? { ...state, open: false } : state
    case 'draft':
      return event.text === state.draft ? state : { ...state, draft: event.text }
    case 'add-tag': {
      if (state.tags.some((tag) => tag.id === event.tag.id)) return state
      return {
        ...state,
        tags: [...state.tags, event.tag],
        suggestions: state.suggestions.filter((suggestion) => suggestion.id !== event.tag.id),
      }
    }
    case 'remove-tag': {
      if (!state.tags.some((tag) => tag.id === event.id)) return state
      return { ...state, tags: state.tags.filter((tag) => tag.id !== event.id) }
    }
    case 'suggest': {
      const tagged = new Set(state.tags.map((tag) => tag.id))
      const suggestions = event.suggestions.filter((suggestion) => !tagged.has(suggestion.id))
      return { ...state, suggestions }
    }
    case 'accept-suggestion': {
      const suggestion = state.suggestions.find((candidate) => candidate.id === event.id)
      if (suggestion === undefined) return state
      return reduceAsk(state, { type: 'add-tag', tag: { ...suggestion } })
    }
    case 'accept-all-suggestions': {
      if (state.suggestions.length === 0) return state
      const tags = uniqueTags([...state.tags, ...state.suggestions.map((suggestion) => ({ ...suggestion }))])
      return { ...state, tags, suggestions: [] }
    }
    case 'dismiss-suggestions':
      return state.suggestions.length === 0 ? state : { ...state, suggestions: [] }
    case 'asked-before':
      return {
        ...state,
        askedBefore: newestFirst(event.threads),
        staleIds: mergeStale(state.staleIds, event.stale),
      }
    case 'submit':
      return submit(state, event.question, event.followUp, event.at)
    case 'started':
      return updateNewest(state, (turn) => (turn.askId === null && turn.saved === null ? { ...turn, askId: event.askId } : turn))
    case 'start-failed':
      return updateNewest(state, (turn) =>
        turn.askId === null && turn.saved === null ? { ...turn, phase: 'error', error: event.sentence } : turn,
      )
    case 'state':
      return applyStateEvent(state, event.event, event.at)
    case 'stop':
      return updateNewest(state, (turn) => (turn.phase === 'digging' || turn.phase === 'fast' ? { ...turn, stopping: true } : turn))
    case 'new-question':
      return { ...state, view: 'compose', draft: '', suggestions: [], turns: [] }
    case 'show-history':
      return { ...state, view: 'history', historyError: null }
    case 'history':
      return {
        ...state,
        history: newestFirst(event.threads),
        historyError: null,
        staleIds: mergeStale(state.staleIds, event.stale),
      }
    case 'history-failed':
      return { ...state, history: state.history ?? [], historyError: event.sentence }
    case 'open-saved':
      return { ...state, view: 'answer', turns: savedTurns(event.thread, state.staleIds.includes(event.thread.id)) }
  }
}

function submit(state: AskPanelState, raw: string, followUp: boolean, at: number): AskPanelState {
  const question = raw.trim()
  if (question === '') return state
  // A follow-up waits for the turn before it: two runs on one thread would
  // race for the same saved entry.
  if (followUp) {
    const last = state.turns[state.turns.length - 1]
    if (last === undefined || isRunning(last)) return state
    if (state.turns.length > MAX_FOLLOW_UPS) return state
    return { ...state, view: 'answer', turns: [...state.turns, newTurn(question, last.tags, at)] }
  }
  return { ...state, view: 'answer', draft: '', suggestions: [], turns: [newTurn(question, state.tags, at)] }
}

function newTurn(question: string, tags: AskTag[], at: number): AskTurn {
  return {
    askId: null,
    question,
    tags,
    phase: 'fast',
    answer: null,
    firstExplanation: null,
    changedFromFirst: false,
    steps: [],
    reads: 0,
    digElapsedMs: 0,
    startedAt: at,
    answeredAfterMs: null,
    error: null,
    stopping: false,
    saved: null,
  }
}

function applyStateEvent(state: AskPanelState, event: AskStateEvent, at: number): AskPanelState {
  const index = state.turns.findIndex((turn) => turn.askId === event.askId)
  if (index === -1) return state
  const turn = state.turns[index]
  const next: AskTurn = { ...turn }
  // THE ANSWER IN PLACE. A state event without an answer keeps the one shown:
  // a dig step does not take the fast answer away.
  if (event.answer !== null) {
    const changedText = turn.answer === null || turn.answer.explanation !== event.answer.explanation
    if (turn.firstExplanation === null) next.firstExplanation = event.answer.explanation
    next.answer = event.answer
    if (changedText) next.answeredAfterMs = Math.max(0, at - turn.startedAt)
    next.changedFromFirst =
      event.answer.confidence === 'checked' &&
      next.firstExplanation !== null &&
      next.firstExplanation.trim() !== event.answer.explanation.trim()
  }
  switch (event.phase.kind) {
    case 'fast':
      next.phase = 'fast'
      break
    case 'digging':
      next.phase = 'digging'
      next.steps = event.phase.steps
      next.reads = event.phase.reads
      next.digElapsedMs = event.phase.elapsedMs
      break
    case 'done':
      next.phase = 'done'
      next.stopping = false
      break
    case 'partial':
      next.phase = 'partial'
      next.stopping = false
      break
    case 'error':
      next.phase = 'error'
      next.error = event.phase.sentence
      next.stopping = false
      break
  }
  const turns = state.turns.slice()
  turns[index] = next
  return { ...state, turns }
}

function savedTurns(thread: AskSavedThread, stale: boolean): AskTurn[] {
  const entries = [thread, ...thread.followUps]
  return entries.map((entry) => {
    const answer: AskAnswer = {
      explanation: entry.answer,
      confidence: entry.partial ? 'first' : 'checked',
      thin: false,
      sources: entry.sources.map((source) => ({ n: null, ...source })),
      ...(entry.verdict !== undefined ? { verdict: entry.verdict } : {}),
      ...(entry.reply !== undefined ? { reply: entry.reply } : {}),
      factsLearned: entry.factsLearned,
      factsSaved: true,
      savedId: entry.id,
      ...(entry.branchInProgress !== undefined ? { branchInProgress: entry.branchInProgress } : {}),
      partial: entry.partial,
    }
    numberSources(answer)
    return {
      askId: null,
      question: entry.question,
      tags: entry.tags.map((id) => ({ id, kind: kindOfId(id), label: labelOfId(id) })),
      phase: entry.partial ? ('partial' as const) : ('done' as const),
      answer,
      firstExplanation: entry.answer,
      changedFromFirst: false,
      steps: [],
      reads: 0,
      digElapsedMs: 0,
      startedAt: 0,
      answeredAfterMs: null,
      error: null,
      stopping: false,
      saved: { id: entry.id, author: entry.author, ts: entry.ts, stale, usedConversation: entry.usedConversation },
    }
  })
}

/** A saved entry's sources carry no map numbers; number the ones that name a feature or part. */
function numberSources(answer: AskAnswer): void {
  let n = 0
  answer.sources = answer.sources.map((source) => ({ ...source, n: source.featureId !== undefined ? ++n : null }))
}

function updateNewest(state: AskPanelState, update: (turn: AskTurn) => AskTurn): AskPanelState {
  const last = state.turns[state.turns.length - 1]
  if (last === undefined) return state
  const next = update(last)
  if (next === last) return state
  return { ...state, turns: [...state.turns.slice(0, -1), next] }
}

function uniqueTags(tags: readonly AskTag[]): AskTag[] {
  const seen = new Set<string>()
  const out: AskTag[] = []
  for (const tag of tags) {
    if (seen.has(tag.id)) continue
    seen.add(tag.id)
    out.push(tag)
  }
  return out
}

function newestFirst(threads: readonly AskSavedThread[]): AskSavedThread[] {
  return threads.slice().sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0))
}

function mergeStale(current: readonly string[], results: readonly AskStaleResult[]): string[] {
  const set = new Set(current)
  for (const result of results) {
    if (result.stale) set.add(result.id)
    else set.delete(result.id)
  }
  return [...set]
}

/* ── Reading the state ──────────────────────────────────────────────────── */

/** True while main is still working on this turn. */
export function isRunning(turn: AskTurn): boolean {
  return turn.phase === 'fast' || turn.phase === 'digging'
}

/** The newest turn, or null in compose. */
export function currentTurn(state: AskPanelState): AskTurn | null {
  return state.turns[state.turns.length - 1] ?? null
}

/** Where the panel stands as a whole: the newest turn's phase, else idle. */
export function askPhase(state: AskPanelState): AskPanelPhase {
  return currentTurn(state)?.phase ?? 'idle'
}

/** Every run id a turn is waiting on — what `ask:state` events are filtered by. */
export function runningAskIds(state: AskPanelState): string[] {
  return state.turns.filter((turn) => turn.askId !== null && isRunning(turn)).map((turn) => turn.askId as string)
}

/** The id `followUpOf` names for the next follow-up: the first turn's saved entry. */
export function followUpTarget(state: AskPanelState): string | null {
  const first = state.turns[0]
  if (first === undefined) return null
  return first.saved?.id ?? first.answer?.savedId ?? null
}

/** Whether a follow-up can be asked now. */
export function canFollowUp(state: AskPanelState): boolean {
  const last = currentTurn(state)
  if (last === null || isRunning(last)) return false
  if (state.turns.length > MAX_FOLLOW_UPS) return false
  return followUpTarget(state) !== null
}

/** Feature and part ids among some tags (conversations are not on the map). */
export function mapTagIds(tags: readonly AskTag[]): string[] {
  return tags.filter((tag) => tag.kind !== 'conversation').map((tag) => tag.id)
}

/** Conversation ids among some tags. */
export function conversationTagIds(tags: readonly AskTag[]): string[] {
  return tags.filter((tag) => tag.kind === 'conversation').map((tag) => tag.id)
}

/** A feature or part id's kind, read off its shape. */
export function kindOfId(id: string): AskTagKind {
  if (!id.startsWith('feature:')) return 'conversation'
  return id.slice('feature:'.length).includes('/') ? 'part' : 'feature'
}

/** A readable name for an id when nothing better is known: its last segment. */
export function labelOfId(id: string): string {
  const bare = id.replace(/^feature:/, '')
  const last = bare.split('/').pop() ?? bare
  return last.replace(/[-_]+/g, ' ').replace(/^\w/, (c) => c.toUpperCase())
}

/** An opener's tags as chips, labelled from what it said or the id itself. */
export function tagsFromOpen(tags: readonly AskOpenTag[] | undefined, threadId?: string, threadTitle?: string): AskTag[] {
  const out: AskTag[] = (tags ?? []).map((tag) => ({ id: tag.id, kind: tag.kind, label: tag.label ?? labelOfId(tag.id) }))
  if (threadId !== undefined && !out.some((tag) => tag.id === threadId)) {
    out.push({ id: threadId, kind: 'conversation', label: threadTitle ?? 'This conversation' })
  }
  return out
}

/* ── What the map shows (FR-2, FR-7, FR-8, FR-10) ───────────────────────── */

/** A part's live state on the map while the dig runs. */
export type AskLiveState = 'read' | 'reading' | 'thin'

export interface AskDecoration {
  /** False when the panel is closed — the map is the board's own again. */
  active: boolean
  /** Everything not named below recedes. */
  dimOthers: boolean
  /** Tagged features and parts — solid outline. */
  outlined: string[]
  /** Named by the answer but not tagged — dashed outline. */
  mentioned: string[]
  /** Live states while digging. */
  live: Array<{ id: string; state: AskLiveState }>
  /** Source numbers, matching the numbered list in the panel. */
  numbers: Array<{ id: string; n: number; label: string }>
  /** "+N facts learned", on one cell. */
  facts: { id: string; count: number } | null
}

const NO_DECORATION: AskDecoration = {
  active: false,
  dimOthers: false,
  outlined: [],
  mentioned: [],
  live: [],
  numbers: [],
  facts: null,
}

/**
 * What the map shows for this state. Pure, and stable: the same state always
 * gives an equal answer, so the board can compare keys and skip a redraw.
 */
export function askDecoration(state: AskPanelState): AskDecoration {
  if (!state.open) return NO_DECORATION
  const turn = state.view === 'answer' ? currentTurn(state) : null
  const tags = turn !== null ? turn.tags : state.tags
  const outlined = mapTagIds(tags)
  if (turn === null) {
    return { ...NO_DECORATION, active: true, dimOthers: outlined.length > 0, outlined }
  }
  const answer = turn.answer
  const tagged = new Set(outlined)
  const cited = new Set<string>()
  const numbers: AskDecoration['numbers'] = []
  for (const source of answer?.sources ?? []) {
    if (source.featureId === undefined) continue
    cited.add(source.featureId)
    if (source.n !== null) numbers.push({ id: source.featureId, n: source.n, label: shortLabel(source.label) })
  }
  const mentioned = [...cited].filter((id) => !tagged.has(id) && !outlined.some((tag) => isWithin(id, tag)))

  const live: AskDecoration['live'] = []
  if (turn.phase === 'digging' || turn.phase === 'fast') {
    for (const id of outlined) live.push({ id, state: cited.has(id) ? 'read' : 'reading' })
    for (const id of mentioned) live.push({ id, state: 'read' })
  } else if (turn.phase === 'partial') {
    // THE DIG STOPPED: a tagged part the answer never reached is still thin.
    for (const id of outlined) if (!cited.has(id)) live.push({ id, state: 'thin' })
  }

  const showNumbers = turn.phase === 'done' || turn.phase === 'partial'
  let facts: AskDecoration['facts'] = null
  if (showNumbers && answer !== null && answer.factsLearned > 0) {
    const withFile = answer.sources.find((source) => source.featureId !== undefined && source.file !== undefined)
    const id = withFile?.featureId ?? outlined[0] ?? numbers[0]?.id
    if (id !== undefined) facts = { id, count: answer.factsLearned }
  }
  return {
    active: true,
    dimOthers: true,
    outlined,
    mentioned,
    live,
    numbers: showNumbers ? numbers : [],
    facts,
  }
}

/** A stable key for a decoration — the board redraws only when it changes. */
export function decorationKey(decoration: AskDecoration): string {
  return JSON.stringify(decoration)
}

/** "Connectors › Credentials" → "Credentials": the cell already says its feature. */
function shortLabel(label: string): string {
  const parts = label.split('›')
  return (parts[parts.length - 1] ?? label).trim()
}

/** True when `id` is `ancestor` or a part of it. */
function isWithin(id: string, ancestor: string): boolean {
  return id === ancestor || id.startsWith(`${ancestor}/`)
}

/** How a decoration lands on one drawn cell. */
export interface AskCellMark {
  role: 'tagged' | 'mentioned' | null
  live: AskLiveState | null
  numbers: Array<{ n: number; label: string }>
  facts: number
}

/**
 * Project a decoration onto the cells drawn at this depth. An id that is not
 * drawn lands on the drawn cell that holds it — a part named at the project's
 * top level marks its feature — and an id with no drawn holder is dropped.
 * A part drawn while its FEATURE is tagged (inside that feature) reads as tagged.
 */
export function projectDecoration(decoration: AskDecoration, drawnIds: ReadonlySet<string>): Map<string, AskCellMark> {
  const marks = new Map<string, AskCellMark>()
  if (!decoration.active) return marks
  const mark = (id: string): AskCellMark => {
    let current = marks.get(id)
    if (current === undefined) {
      current = { role: null, live: null, numbers: [], facts: 0 }
      marks.set(id, current)
    }
    return current
  }
  const holders = (id: string): string[] => {
    if (drawnIds.has(id)) return [id]
    const owner = ownerOf(id)
    if (owner !== null && drawnIds.has(owner)) return [owner]
    // The tagged id is a feature and its parts are what is drawn.
    return [...drawnIds].filter((drawn) => drawn.startsWith(`${id}/`))
  }
  for (const id of decoration.outlined) for (const cell of holders(id)) mark(cell).role = 'tagged'
  for (const id of decoration.mentioned) {
    for (const cell of holders(id)) {
      const current = mark(cell)
      if (current.role === null) current.role = 'mentioned'
    }
  }
  const rank: Record<AskLiveState, number> = { reading: 3, thin: 2, read: 1 }
  for (const { id, state } of decoration.live) {
    for (const cell of holders(id)) {
      const current = mark(cell)
      if (current.live === null || rank[state] > rank[current.live]) current.live = state
    }
  }
  for (const { id, n, label } of decoration.numbers) {
    for (const cell of holders(id).slice(0, 1)) mark(cell).numbers.push({ n, label })
  }
  if (decoration.facts !== null) {
    const cell = holders(decoration.facts.id)[0]
    if (cell !== undefined) mark(cell).facts = decoration.facts.count
  }
  return marks
}

/** `feature:<slug>/<part>` → `feature:<slug>`; null for a feature or anything else. */
function ownerOf(id: string): string | null {
  if (!id.startsWith('feature:')) return null
  const slash = id.indexOf('/')
  return slash === -1 ? null : id.slice(0, slash)
}

/** "3 days ago", "just now" — for the asked-before rows. `now` is injected. */
export function ageLabel(ts: string, now: number): string {
  const then = Date.parse(ts)
  if (Number.isNaN(then)) return ''
  const seconds = Math.max(0, Math.round((now - then) / 1000))
  if (seconds < 60) return 'just now'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} h ago`
  const days = Math.round(hours / 24)
  if (days === 1) return 'yesterday'
  if (days < 30) return `${days} days ago`
  const months = Math.round(days / 30)
  return months <= 1 ? 'a month ago' : `${months} months ago`
}

/** "4 s", "1 min 40 s" — how long an answer took. */
export function durationLabel(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds} s`
  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60
  return rest === 0 ? `${minutes} min` : `${minutes} min ${rest} s`
}

/** "Coworkers and Connectors", "A, B and C". */
export function listLabel(labels: readonly string[]): string {
  if (labels.length <= 1) return labels[0] ?? ''
  return `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`
}

/**
 * The prompt "Continue in a conversation" puts in the composer (FR-17): the
 * question, the answer and its sources. The person sends it; nothing is sent.
 */
export function continuePrompt(turn: AskTurn): string {
  const lines: string[] = [turn.question.trim(), '']
  const answer = turn.answer
  if (answer !== null) {
    lines.push('The Blueprint answered:', answer.explanation.trim())
    if (answer.verdict !== undefined) {
      lines.push('', `Can we build it? ${answer.verdict.label}${answer.verdict.risk !== undefined ? ` — ${answer.verdict.risk}` : ''}`)
    }
    if (answer.branchInProgress !== undefined) lines.push('', answer.branchInProgress)
    const sources = answer.sources.filter((source) => source.label !== '' || source.file !== undefined)
    if (sources.length > 0) {
      lines.push('', 'Sources:')
      sources.forEach((source, index) => {
        const n = source.n ?? index + 1
        lines.push(`${n}. ${source.label}${source.file !== undefined ? ` (${source.file})` : ''}`)
      })
    }
  }
  return lines.join('\n').trim()
}
