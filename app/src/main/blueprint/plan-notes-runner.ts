// Plan change notes feed (plan `plan_change_review`, Phase 5).
//
// Runs the bundled CLI's `plan notes <plan> --json` (the one reader) and
// `plan note <plan> --note <n> …` (the ONE writer of a note's status and
// verdict, allowed-pattern #14) and relays their answers. Main never edits a
// plan file itself: the plan file is the record, and the CLI owns it.
//
// The reader resolves each change note's quote against today's code with the
// storyline's readers, so it is handed the same compiler and tree-sitter paths
// the storyline is (FLOW_TYPESCRIPT_PATH / FLOW_TREESITTER_PATH).
//
// NARROWED, NOT TRUSTED: a malformed note is dropped, never guessed into
// shape, and the counts are recounted from the notes that survived — so a
// count can never promise a note the reader will not see.
//
// FAIL-SOFT: a missing CLI, a timeout, a non-JSON answer or a refusal all
// become `{ ok: false, reason, detail }` with one sentence for the reader —
// the refusal's own sentence, without any command hint (forbidden-pattern
// #12). Never throws, never blocks the main process (allowed-pattern #19).
import { runBundledCliCapturing } from '../agent/learn-session'
import type { BundledCli } from './derive-runner'
import { withoutCommandHint } from '../../shared/command-hint'
import type {
  NoteQuote,
  PlanNoteCounts,
  PlanNoteKind,
  PlanNoteReport,
  PlanNoteStatus,
  PlanNoteVerdict,
  PlanNotesAnswer,
  PlanNotesFailure,
  PlanSetNoteAnswer,
  PlanSetNoteRequest,
  PlanUnreadableNote,
  StorylineNote,
} from '../../shared/ipc-contract'

/**
 * Reading resolves every quote against today's code. NOT the storyline's
 * ceiling (`STORYLINE_TIMEOUT_MS`, 60 s, sized for a cold import index) — this
 * comment once said it was while the value was a third of it.
 */
export const PLAN_NOTES_TIMEOUT_MS = 20_000

/** Writing rewrites one line of one file. */
export const PLAN_NOTE_WRITE_TIMEOUT_MS = 10_000

/** The family's refusal line: `plan refused: <reason> — <sentence>`. */
const REFUSAL_PATTERN = /plan refused: (\S+) — (.+)$/

const NO_CLI_SENTENCE = "Flow couldn't start its plan reader."
const TIMEOUT_SENTENCE = 'Reading this plan took too long.'
const WRITE_TIMEOUT_SENTENCE = 'Recording this took too long, so it may not have been saved.'
const UNREADABLE_SENTENCE = "Flow couldn't read this plan's notes."
const WRITE_UNREADABLE_SENTENCE = "Flow couldn't record this decision."
const NO_PLAN_SENTENCE = 'Pick a plan to read its notes.'
const BAD_NOTE_SENTENCE = 'Pick one note to decide.'
const ONE_DECISION_SENTENCE = 'Choose a status or a verdict for this note, not both.'
const MISSING_WHY_SENTENCE = 'A verdict needs one sentence saying why.'

/**
 * REASONS WHOSE CLI SENTENCE IS NOT FOR A READER. `write-failed` carries the
 * file system's own message (an absolute path, an errno) — right for a
 * terminal, a wall of internals on a card. Its fixed sentence is shown; the
 * raw line goes to the console.
 */
const FIXED_REFUSAL_SENTENCES: ReadonlyMap<string, string> = new Map([
  ['write-failed', "Flow couldn't save the plan file, so this decision was not recorded."],
])

const NOTE_KINDS: ReadonlySet<PlanNoteKind> = new Set(['change', 'new', 'file'])
const NOTE_STATUSES: ReadonlySet<PlanNoteStatus> = new Set(['proposed', 'accepted', 'rejected'])
const NOTE_VERDICTS: ReadonlySet<PlanNoteVerdict> = new Set(['done', 'differs', 'not-built'])
const QUOTE_FOUND: ReadonlySet<NoteQuote['found']> = new Set(['once', 'none', 'many'])

export interface PlanNotesDeps {
  /** Required (may be null): a call site that forgets the CLI does not compile (allowed-pattern #26). */
  bundledCli: BundledCli | null | undefined
  run?: typeof runBundledCliCapturing
  typescriptPath?: string | null
  treeSitterPath?: string | null
}

export interface ReadPlanNotesRequest {
  rootPath: string
  plan: string
}

type RunResult = Awaited<ReturnType<typeof runBundledCliCapturing>>

// ── Narrowing ───────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

const OPTIONAL_NOTE_STRINGS = ['project', 'symbol', 'where', 'what', 'why', 'signature', 'purpose', 'reason'] as const

/**
 * One note as the plan holds it, or null when it is not one. Required fields
 * must be exactly right; an optional field of the wrong type is left out, and
 * a verdict outside the vocabulary takes its sentence with it.
 */
export function narrowStorylineNote(value: unknown): StorylineNote | null {
  if (!isRecord(value)) return null
  const { n, phase, kind, target, file, status, comments } = value
  if (!isPositiveInteger(n) || !isNonNegativeInteger(phase)) return null
  if (typeof kind !== 'string' || !NOTE_KINDS.has(kind as PlanNoteKind)) return null
  if (typeof target !== 'string' || target === '' || typeof file !== 'string' || file === '') return null
  if (typeof status !== 'string' || !NOTE_STATUSES.has(status as PlanNoteStatus)) return null
  if (comments !== undefined && !Array.isArray(comments)) return null
  const note: StorylineNote = {
    n,
    phase,
    kind: kind as PlanNoteKind,
    target,
    file,
    status: status as PlanNoteStatus,
    comments: Array.isArray(comments) ? comments.filter((item): item is string => typeof item === 'string') : [],
  }
  for (const key of OPTIONAL_NOTE_STRINGS) {
    const field = value[key]
    if (typeof field === 'string') note[key] = field
  }
  if (isStringArray(value.callers)) note.callers = [...value.callers]
  if (typeof value.verdict === 'string' && NOTE_VERDICTS.has(value.verdict as PlanNoteVerdict)) {
    note.verdict = value.verdict as PlanNoteVerdict
    if (typeof value.verdictWhy === 'string') note.verdictWhy = value.verdictWhy
  }
  return note
}

function narrowQuote(value: unknown): NoteQuote | null {
  if (!isRecord(value) || typeof value.found !== 'string' || !QUOTE_FOUND.has(value.found as NoteQuote['found'])) return null
  const quote: NoteQuote = { found: value.found as NoteQuote['found'] }
  if (isPositiveInteger(value.startLine) && isPositiveInteger(value.endLine) && value.endLine >= value.startLine) {
    quote.startLine = value.startLine
    quote.endLine = value.endLine
  }
  if (isPositiveInteger(value.count)) quote.count = value.count
  return quote
}

/** A note as `plan notes` reports it: the note, plus where its quote was found. */
export function narrowPlanNoteReport(value: unknown): PlanNoteReport | null {
  const note = narrowStorylineNote(value)
  if (note === null || !isRecord(value)) return null
  const report: PlanNoteReport = { ...note }
  const quote = narrowQuote(value.quote)
  if (quote !== null) report.quote = quote
  if (value.fileMissing === true) report.fileMissing = true
  if (value.symbolMissing === true) report.symbolMissing = true
  if (value.functionUnchecked === true) report.functionUnchecked = true
  return report
}

function narrowUnreadable(value: unknown): PlanUnreadableNote | null {
  if (!isRecord(value) || !isPositiveInteger(value.line) || typeof value.reason !== 'string') return null
  return isPositiveInteger(value.n) ? { line: value.line, reason: value.reason, n: value.n } : { line: value.line, reason: value.reason }
}

/**
 * The counts of the notes the reader will actually see. The CLI's own counts
 * describe the notes IT parsed; once a malformed one is dropped here they can
 * only be honest by being recounted — so they always are (proposed =
 * unreviewed).
 */
export function countPlanNotes(notes: readonly StorylineNote[]): PlanNoteCounts {
  const accepted = notes.filter((note) => note.status === 'accepted').length
  const rejected = notes.filter((note) => note.status === 'rejected').length
  return { total: notes.length, accepted, rejected, unreviewed: notes.length - accepted - rejected }
}

/** The JSON objects on stdout, last first — a refusal's prose may follow its payload (allowed-pattern #24). */
function jsonObjectsLastFirst(stdout: string): Record<string, unknown>[] {
  const objects: Record<string, unknown>[] = []
  const lines = stdout.split('\n').map((line) => line.trim())
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]
    if (!line.startsWith('{')) continue
    try {
      const parsed: unknown = JSON.parse(line)
      if (isRecord(parsed)) objects.push(parsed)
    } catch {
      // Not JSON after all — keep scanning upward for the answer line.
      continue
    }
  }
  return objects
}

/** `plan notes --json`'s answer, narrowed — null when stdout carries none. */
export function parsePlanNotesStdout(stdout: string): PlanNotesAnswer | null {
  for (const value of jsonObjectsLastFirst(stdout)) {
    if (value.refused !== undefined) continue
    if (typeof value.plan !== 'string' || typeof value.path !== 'string' || !Array.isArray(value.notes)) continue
    const notes = value.notes.map(narrowPlanNoteReport).filter((note): note is PlanNoteReport => note !== null)
    const unreadable = Array.isArray(value.unreadable)
      ? value.unreadable.map(narrowUnreadable).filter((entry): entry is PlanUnreadableNote => entry !== null)
      : []
    return { ok: true, plan: value.plan, path: value.path, notes, counts: countPlanNotes(notes), unreadable }
  }
  return null
}

/** `plan note --json`'s answer, narrowed — null when stdout carries none (or the note is malformed). */
export function parsePlanNoteStdout(stdout: string): PlanSetNoteAnswer | null {
  for (const value of jsonObjectsLastFirst(stdout)) {
    if (value.refused !== undefined) continue
    if (typeof value.plan !== 'string' || typeof value.path !== 'string' || typeof value.changed !== 'boolean') continue
    const note = narrowPlanNoteReport(value.note)
    if (note === null) continue
    return { ok: true, plan: value.plan, path: value.path, changed: value.changed, note }
  }
  return null
}

// ── Refusals ────────────────────────────────────────────

function failure(reason: string | null, detail: string): PlanNotesFailure {
  return { ok: false, reason, detail }
}

/** `there is no active plan named 'x'` → `There is no active plan named 'x'.` */
function asSentence(fragment: string): string {
  const flat = withoutCommandHint(fragment.replace(/\s+/g, ' ').trim())
  if (flat === '') return flat
  const capital = flat.charAt(0).toUpperCase() + flat.slice(1)
  return /[.!?]$/.test(capital) ? capital : `${capital}.`
}

/** The verb's own refusal line, wherever the transcript put it (allowed-pattern #15). */
function refusalFromTranscript(transcript: string): PlanNotesFailure | null {
  for (const line of transcript.split('\n')) {
    const match = REFUSAL_PATTERN.exec(line.trim())
    if (match === null) continue
    const reason = match[1]
    const fixed = FIXED_REFUSAL_SENTENCES.get(reason)
    if (fixed !== undefined) {
      console.warn(`[plan-notes] ${line.trim()}`)
      return failure(reason, fixed)
    }
    const sentence = asSentence(match[2])
    return sentence === '' ? null : failure(reason, sentence)
  }
  return null
}

/** The refusal payload's reason, when only the stdout payload made it out. */
function refusedReason(stdout: string): string | null {
  for (const value of jsonObjectsLastFirst(stdout)) {
    if (typeof value.refused === 'string') return value.refused
  }
  return null
}

function failureOf(result: RunResult, timeoutSentence: string, fallback: string): PlanNotesFailure {
  if (result.error === 'timed out') return failure(null, timeoutSentence)
  const transcript = [result.stdout, result.stderr ?? '', result.error ?? ''].join('\n')
  return refusalFromTranscript(transcript) ?? failure(refusedReason(result.stdout), fallback)
}

// ── Arguments ───────────────────────────────────────────

/** The plan as a positional the verb reads as a plan: non-empty and never a flag. */
function planArg(plan: unknown): string | null {
  if (typeof plan !== 'string') return null
  const trimmed = plan.trim()
  return trimmed === '' || trimmed.startsWith('-') ? null : trimmed
}

/** One line of free text, or null when there is none. */
function oneLine(text: unknown): string | null {
  if (typeof text !== 'string') return null
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat === '' ? null : flat
}

/** The reader resolves quotes with the storyline's readers; the writer reads no code. */
function readerEnv(deps: PlanNotesDeps): Record<string, string> {
  const env: Record<string, string> = {}
  if (deps.typescriptPath) env.FLOW_TYPESCRIPT_PATH = deps.typescriptPath
  if (deps.treeSitterPath) env.FLOW_TREESITTER_PATH = deps.treeSitterPath
  return env
}

async function runCli(
  deps: PlanNotesDeps & { bundledCli: BundledCli },
  cwd: string,
  args: string[],
  timeoutMs: number,
  env: Record<string, string> = {},
): Promise<RunResult | null> {
  const run = deps.run ?? runBundledCliCapturing
  try {
    return await run(deps.bundledCli, cwd, args, {
      timeoutMs,
      ...(Object.keys(env).length > 0 ? { env } : {}),
    })
  } catch (error) {
    // The default runner never rejects; an injected one might. Log, then answer.
    console.warn('[plan-notes] run failed:', error)
    return null
  }
}

// ── The two calls ───────────────────────────────────────

/** A plan's notes, counts and unreadable notes. Never throws. */
export async function readPlanNotes(deps: PlanNotesDeps, request: ReadPlanNotesRequest): Promise<PlanNotesAnswer> {
  const plan = planArg(request.plan)
  if (plan === null) return failure(null, NO_PLAN_SENTENCE)
  if (!deps.bundledCli) return failure(null, NO_CLI_SENTENCE)
  const args = ['plan', 'notes', plan, '--target', request.rootPath, '--json']
  const result = await runCli({ ...deps, bundledCli: deps.bundledCli }, request.rootPath, args, PLAN_NOTES_TIMEOUT_MS, readerEnv(deps))
  if (result === null) return failure(null, UNREADABLE_SENTENCE)
  return parsePlanNotesStdout(result.stdout) ?? failureOf(result, TIMEOUT_SENTENCE, UNREADABLE_SENTENCE)
}

/**
 * The decision's flags — exactly one of a status (with an optional reason) or
 * a verdict (with its sentence), checked here so an impossible request never
 * spawns. Free text is passed as `--flag=value` so a sentence that starts
 * with a dash is never read as another flag.
 */
function decisionArgs(request: PlanSetNoteRequest): string[] | PlanNotesFailure {
  const hasStatus = request.status !== undefined
  const hasVerdict = request.verdict !== undefined
  if (hasStatus === hasVerdict) return failure(null, ONE_DECISION_SENTENCE)
  if (hasStatus) {
    if (!NOTE_STATUSES.has(request.status as PlanNoteStatus)) return failure(null, ONE_DECISION_SENTENCE)
    const reason = oneLine(request.reason)
    return ['--status', request.status as string, ...(reason === null ? [] : [`--reason=${reason}`])]
  }
  if (!NOTE_VERDICTS.has(request.verdict as PlanNoteVerdict)) return failure(null, ONE_DECISION_SENTENCE)
  const why = oneLine(request.why)
  if (why === null) return failure(null, MISSING_WHY_SENTENCE)
  return ['--verdict', request.verdict as string, `--why=${why}`]
}

/** Record one note's status or verdict through the CLI's one writer. Never throws. */
export async function setPlanNote(deps: PlanNotesDeps, request: PlanSetNoteRequest): Promise<PlanSetNoteAnswer> {
  const plan = planArg(request.plan)
  if (plan === null) return failure(null, NO_PLAN_SENTENCE)
  if (!isPositiveInteger(request.note)) return failure(null, BAD_NOTE_SENTENCE)
  const decision = decisionArgs(request)
  if (!Array.isArray(decision)) return decision
  if (!deps.bundledCli) return failure(null, NO_CLI_SENTENCE)
  const args = ['plan', 'note', plan, '--note', String(request.note), ...decision, '--target', request.rootPath, '--json']
  const result = await runCli({ ...deps, bundledCli: deps.bundledCli }, request.rootPath, args, PLAN_NOTE_WRITE_TIMEOUT_MS)
  if (result === null) return failure(null, WRITE_UNREADABLE_SENTENCE)
  return parsePlanNoteStdout(result.stdout) ?? failureOf(result, WRITE_TIMEOUT_SENTENCE, WRITE_UNREADABLE_SENTENCE)
}

/**
 * Decisions on one plan, recorded one after another.
 *
 * Each `plan note` rewrites its plan file whole: read, change one line, write.
 * Two run at once — a person deciding two notes in quick succession — and both
 * read the same original, so the second write puts back the line the first
 * one changed and that decision is silently lost. Writes to the SAME plan of
 * the same project queue behind each other; different plans never wait. A
 * write that fails does not block the next (the queue continues on settle).
 */
export function serializePlanNoteWrites(
  write: (request: PlanSetNoteRequest) => Promise<PlanSetNoteAnswer>,
): (request: PlanSetNoteRequest) => Promise<PlanSetNoteAnswer> {
  const tails = new Map<string, Promise<unknown>>()
  return (request) => {
    const key = JSON.stringify([request.rootPath, request.plan])
    const previous = tails.get(key) ?? Promise.resolve()
    const next = previous.then(
      () => write(request),
      () => write(request),
    )
    // Settled-and-swallowed, so a failure is the caller's to read, never the
    // next write's reason to fail.
    const tail = next.then(
      () => undefined,
      () => undefined,
    )
    tails.set(key, tail)
    void tail.then(() => {
      if (tails.get(key) === tail) tails.delete(key)
    })
    return next
  }
}
