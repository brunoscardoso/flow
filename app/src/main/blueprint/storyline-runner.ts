// Code storyline feed (discovery `code-storyline`).
//
// Runs the bundled CLI `blueprint storyline --target <root> (--file | --part)
// --json` and relays its one JSON line to the board. The CLI is the only
// reader of code (allowed-pattern #14) — main narrows the answer's shape and
// the renderer never parses a line of source.
//
// The compiler comes from the APP: the bundle keeps `typescript` external, and
// main hands the child the path of the app's own copy through
// FLOW_TYPESCRIPT_PATH, so the storyline works whatever the project installed.
// Every other language is read with tree-sitter (`@vscode/tree-sitter-wasm`,
// external to the bundle too): main passes the package directory the app ships
// through FLOW_TREESITTER_PATH (plan `story-any-language`).
//
// FAIL-SOFT: a missing CLI, a timeout, a non-JSON answer or an argument
// refusal all become a StorylineRefusal with one sentence for the reader. It
// never throws and never blocks the main process (allowed-pattern #19).
import { dirname } from 'path'
import { runBundledCliCapturing } from '../agent/learn-session'
import type { BundledCli } from './derive-runner'
import { narrowStorylineNote } from './plan-notes-runner'
import type {
  StorylineAnswer,
  StorylineBand,
  StorylineNoteFact,
  StorylineNotePredictionBase,
  StorylinePhasePrediction,
  StorylinePrediction,
  StorylineRefusal,
  StorylineRefusalReason,
} from '../../shared/ipc-contract'

/**
 * A warm story is read in well under a second; this is the ceiling. The FIRST
 * read of a large checkout builds the project import index (measured on
 * orbit-app: 15–20 s cold, 260 ms warm), so the ceiling sits well above it —
 * a plan review is often the first story a project ever reads. The call is
 * async, so a long wait blocks nothing else.
 */
export const STORYLINE_TIMEOUT_MS = 60_000

/** The module main resolves and passes on — the compiler's single-file build. */
const TYPESCRIPT_SPECIFIER = 'typescript/lib/typescript.js'

/** The tree-sitter package's manifest — its directory is what the CLI is handed. */
const TREESITTER_MANIFEST_SPECIFIER = '@vscode/tree-sitter-wasm/package.json'

/** The verb's argument-refusal marker, e.g. `storyline refused: <reason> — <sentence>`. */
const REFUSAL_PATTERN = /storyline refused: (\S+) — (.+)$/

const REFUSAL_REASONS: ReadonlySet<StorylineRefusalReason> = new Set([
  'unsupported-language',
  'syntax-error',
  'too-large',
  'no-compiler',
  'not-found',
])

const NO_CLI_SENTENCE = "Flow couldn't start its code reader."
const TIMEOUT_SENTENCE = 'This took too long to read as a story.'
const UNREADABLE_SENTENCE = "Flow couldn't read this as a story."
const ONE_SUBJECT_SENTENCE = 'Pick one file or one part to read as a story.'

/**
 * THE VERB'S ARGUMENT REFUSALS, IN THE READER'S WORDS. The CLI writes those
 * lines for a terminal — they carry the ref, the path or a flag — and none of
 * that belongs in the board's text (forbidden-pattern #12). Each known reason
 * gets one fixed sentence; any other is the generic one, never the raw line.
 */
const ARGUMENT_REFUSAL_SENTENCES: ReadonlyMap<string, string> = new Map([
  ['unknown-part', "Flow couldn't find this part any more."],
  ['knowledge-unreadable', "Flow couldn't read this project's features just now."],
  ['outside-project', "That file isn't part of this project."],
  ['no-target', "Flow couldn't find this project."],
  ['arguments', ONE_SUBJECT_SENTENCE],
])

export interface StorylineRequest {
  rootId: string
  file?: string
  partRef?: string
  /** The plan whose Today ⇄ After to add — alone (no file, no part), the plan's own story of its change notes. */
  plan?: string
  /** The plan's starting commit, when the board knows it. */
  base?: string
}

export interface StorylineDeps {
  bundledCli: BundledCli | null | undefined
  run?: typeof runBundledCliCapturing
  typescriptPath?: string | null
  /** The app's `@vscode/tree-sitter-wasm` package directory (`resolveTreeSitterPath`). */
  treeSitterPath?: string | null
}

/**
 * Where the app's own TypeScript compiler lives, resolved the same way the
 * LSP adapter resolves its servers — null when the app ships without one, in
 * which case the CLI falls back to whatever it can find and, failing that,
 * answers `no-compiler` on its own.
 */
export function resolveTypeScriptPath(resolve: (specifier: string) => string = require.resolve): string | null {
  try {
    return resolve(TYPESCRIPT_SPECIFIER)
  } catch {
    // Absent is an expected state (see above), not an error to report.
    return null
  }
}

/**
 * Where the app's own tree-sitter package lives (its directory, holding
 * `wasm/`) — null when the app ships without it, in which case the CLI falls
 * back to its own install and, failing that, answers `no-compiler` naming the
 * language for every file that is not TypeScript or JavaScript.
 */
export function resolveTreeSitterPath(resolve: (specifier: string) => string = require.resolve): string | null {
  try {
    return dirname(resolve(TREESITTER_MANIFEST_SPECIFIER))
  } catch {
    // Absent is an expected state (see above), not an error to report.
    return null
  }
}

function refusal(reason: StorylineRefusalReason, sentence: string): StorylineRefusal {
  return { ok: false, reason, sentence }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const RESULT_ARRAYS = ['files', 'pieces', 'calls', 'typeUses', 'entries', 'classes'] as const

const COMPARE_ARRAYS = ['removed', 'unreadable', 'predicted'] as const
const COMPARE_RECORDS = ['pieces', 'hunks', 'hiddenLines', 'summary'] as const

const PHASE_PREDICTION_KINDS: ReadonlySet<string> = new Set(['changes', 'planned', 'planned-file'])
const NOTE_FACTS: ReadonlySet<StorylineNoteFact> = new Set(['changed', 'added', 'unchanged', 'removed'])

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

/** A comparison the view can draw: its arrays and records where they belong. */
function isCompare(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value) || typeof value.plan !== 'string') return false
  if (value.base !== null && typeof value.base !== 'string') return false
  return COMPARE_ARRAYS.every((key) => Array.isArray(value[key])) && COMPARE_RECORDS.every((key) => isRecord(value[key]))
}

/** An old-style prediction (a plan's phases and Story anchors), or null. */
function narrowPhasePrediction(value: Record<string, unknown>): StorylinePhasePrediction | null {
  if (typeof value.kind !== 'string' || !PHASE_PREDICTION_KINDS.has(value.kind)) return null
  if (typeof value.file !== 'string' || typeof value.task !== 'string') return null
  if (value.phase !== null && typeof value.phase !== 'number') return null
  const prediction: StorylinePhasePrediction = {
    kind: value.kind as StorylinePhasePrediction['kind'],
    file: value.file,
    phase: value.phase as number | null,
    task: value.task,
  }
  if (typeof value.pieceId === 'string') prediction.pieceId = value.pieceId
  if (typeof value.symbol === 'string') prediction.symbol = value.symbol
  return prediction
}

/** The fields every note prediction carries, or null when its file or note is not one. */
function narrowNoteBase(value: Record<string, unknown>): StorylineNotePredictionBase | null {
  if (typeof value.file !== 'string' || value.file === '') return null
  const note = narrowStorylineNote(value.note)
  if (note === null) return null
  const base: StorylineNotePredictionBase = { file: value.file, note }
  if (typeof value.project === 'string' && value.project !== '') base.project = value.project
  if (value.codeUnavailable === true) base.codeUnavailable = true
  if (value.fileMissing === true) base.fileMissing = true
  if (typeof value.fact === 'string' && NOTE_FACTS.has(value.fact as StorylineNoteFact)) {
    base.fact = value.fact as StorylineNoteFact
  }
  return base
}

function narrowCallerPieces(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {}
  const pieces: Record<string, string> = {}
  for (const [caller, pieceId] of Object.entries(value)) {
    if (typeof pieceId === 'string') pieces[caller] = pieceId
  }
  return pieces
}

/** A note prediction (change / new / file), or null — a required field wrong drops it. */
function narrowNotePrediction(value: Record<string, unknown>): StorylinePrediction | null {
  const base = narrowNoteBase(value)
  if (base === null) return null
  const pieceId = typeof value.pieceId === 'string' ? { pieceId: value.pieceId } : {}
  const quoteLines = value.quoteLines
  // Where a quote landed — a change note's in its function, a file note's in its file.
  const quoted = {
    ...(isRecord(quoteLines) &&
    isPositiveInteger(quoteLines.startLine) &&
    isPositiveInteger(quoteLines.endLine) &&
    quoteLines.endLine >= quoteLines.startLine
      ? { quoteLines: { startLine: quoteLines.startLine, endLine: quoteLines.endLine } }
      : {}),
    ...(value.quoteMissing === true ? { quoteMissing: true as const } : {}),
    ...(isPositiveInteger(value.quoteCount) ? { quoteCount: value.quoteCount } : {}),
  }
  if (value.kind === 'note-file') return { ...base, kind: 'note-file', ...pieceId, ...quoted }
  if (typeof value.symbol !== 'string' || value.symbol === '') return null
  if (value.kind === 'note-change') {
    return {
      ...base,
      kind: 'note-change',
      symbol: value.symbol,
      ...pieceId,
      ...quoted,
      ...(value.pieceMissing === true ? { pieceMissing: true as const } : {}),
    }
  }
  if (value.kind === 'note-new') {
    if (typeof value.signature !== 'string' || typeof value.purpose !== 'string' || !isStringArray(value.callers)) return null
    return {
      ...base,
      kind: 'note-new',
      symbol: value.symbol,
      signature: value.signature,
      purpose: value.purpose,
      callers: [...value.callers],
      callerPieces: narrowCallerPieces(value.callerPieces),
      ...pieceId,
    }
  }
  return null
}

/** One prediction of either family, or null when it is neither. */
export function narrowPrediction(value: unknown): StorylinePrediction | null {
  if (!isRecord(value)) return null
  if (typeof value.kind === 'string' && value.kind.startsWith('note-')) return narrowNotePrediction(value)
  return narrowPhasePrediction(value)
}

/** One project's band, or null. */
function narrowBand(value: unknown): StorylineBand | null {
  if (!isRecord(value) || !isStringArray(value.files)) return null
  if (value.project !== null && (typeof value.project !== 'string' || value.project === '')) return null
  const band: StorylineBand = { project: value.project as string | null, files: [...value.files] }
  if (typeof value.colorIndex === 'number' && Number.isInteger(value.colorIndex) && value.colorIndex >= 0) {
    band.colorIndex = value.colorIndex
  }
  return band
}

/**
 * The minimal shape check: a result carries its arrays, a refusal its words.
 * A malformed `compare` is dropped, never relayed — the story still draws, as
 * it would outside a plan. Inside a sound `compare`, each prediction is
 * narrowed and a malformed one dropped; malformed bands are dropped one by
 * one, and a `bands` that is not a list is dropped whole.
 */
function asAnswer(value: unknown): StorylineAnswer | null {
  if (!isRecord(value) || typeof value.ok !== 'boolean') return null
  if (value.ok) {
    if (!RESULT_ARRAYS.every((key) => Array.isArray(value[key]))) return null
    const rest: Record<string, unknown> = { ...value }
    if (value.compare !== undefined) {
      if (isCompare(value.compare)) {
        const predicted = (value.compare.predicted as unknown[])
          .map(narrowPrediction)
          .filter((prediction): prediction is StorylinePrediction => prediction !== null)
        rest.compare = { ...value.compare, predicted }
      } else {
        delete rest.compare
      }
    }
    if (value.bands !== undefined) {
      if (Array.isArray(value.bands)) {
        rest.bands = value.bands.map(narrowBand).filter((band): band is StorylineBand => band !== null)
      } else {
        delete rest.bands
      }
    }
    return rest as unknown as StorylineAnswer
  }
  if (typeof value.reason !== 'string' || typeof value.sentence !== 'string') return null
  return value as unknown as StorylineAnswer
}

/** The LAST stdout line that parses as an answer — noise before it is ignored. */
export function parseStorylineStdout(stdout: string): StorylineAnswer | null {
  const lines = stdout.split('\n').map((line) => line.trim())
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]
    if (!line.startsWith('{')) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      // Not JSON after all — keep scanning upward for the answer line.
      continue
    }
    const answer = asAnswer(parsed)
    if (answer !== null) return answer
  }
  return null
}

/** The verb's own refusal line, wherever the transcript put it (allowed-pattern #15). */
function refusalFromTranscript(transcript: string): StorylineRefusal | null {
  for (const line of transcript.split('\n')) {
    const match = REFUSAL_PATTERN.exec(line.trim())
    if (match === null) continue
    if (REFUSAL_REASONS.has(match[1] as StorylineRefusalReason)) {
      return refusal(match[1] as StorylineRefusalReason, match[2].trim())
    }
    return refusal('not-found', ARGUMENT_REFUSAL_SENTENCES.get(match[1]) ?? UNREADABLE_SENTENCE)
  }
  return null
}

/**
 * `--file` or `--part` — exactly one — or neither when a plan is named: a
 * plan's own story, built from its change notes (the plan review).
 */
function subjectArgs(request: StorylineRequest): string[] | null {
  const hasFile = typeof request.file === 'string' && request.file !== ''
  const hasPart = typeof request.partRef === 'string' && request.partRef !== ''
  if (!hasFile && !hasPart) return flagValue(request.plan) === null ? null : []
  if (hasFile === hasPart) return null
  if (hasFile) return ['--file', request.file as string]
  return ['--part', request.partRef as string]
}

/** A flag value the verb may read as a value: non-empty, and never another flag. */
function flagValue(value: string | undefined): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed === '' || trimmed.startsWith('-') ? null : trimmed
}

/** `--plan` / `--base`, when the story is asked for in a plan's context. */
function planArgs(request: StorylineRequest): string[] {
  const plan = flagValue(request.plan)
  if (plan === null) return []
  const base = flagValue(request.base)
  return base === null ? ['--plan', plan] : ['--plan', plan, '--base', base]
}

/** Read one file (or one part's files) as a story. Never throws. */
export async function runStoryline(deps: StorylineDeps, request: StorylineRequest): Promise<StorylineAnswer> {
  const subject = subjectArgs(request)
  if (subject === null) return refusal('not-found', ONE_SUBJECT_SENTENCE)
  if (!deps.bundledCli) return refusal('no-compiler', NO_CLI_SENTENCE)

  const run = deps.run ?? runBundledCliCapturing
  const args = ['blueprint', 'storyline', '--target', request.rootId, ...subject, ...planArgs(request), '--json']
  const env: Record<string, string> = {}
  if (deps.typescriptPath) env.FLOW_TYPESCRIPT_PATH = deps.typescriptPath
  if (deps.treeSitterPath) env.FLOW_TREESITTER_PATH = deps.treeSitterPath
  const options = {
    timeoutMs: STORYLINE_TIMEOUT_MS,
    ...(Object.keys(env).length > 0 ? { env } : {}),
  }
  let result: Awaited<ReturnType<typeof runBundledCliCapturing>>
  try {
    result = await run(deps.bundledCli, request.rootId, args, options)
  } catch (error) {
    // The default runner never rejects; an injected one might. Log, then answer.
    console.warn('[storyline] run failed:', error)
    return refusal('not-found', UNREADABLE_SENTENCE)
  }

  const answer = parseStorylineStdout(result.stdout)
  if (answer !== null) return answer
  if (result.error === 'timed out') return refusal('too-large', TIMEOUT_SENTENCE)
  const transcript = [result.stdout, result.stderr ?? '', result.error ?? ''].join('\n')
  return refusalFromTranscript(transcript) ?? refusal('not-found', UNREADABLE_SENTENCE)
}

/**
 * One run per identical request while it is in flight.
 *
 * A cold read builds the project import index (15–20 s on a large checkout),
 * and the board asks for the same story from more than one place at once —
 * a plan review opening, a re-render, a second pane. Each ask used to spawn
 * its own CLI, so N viewers meant N cold builds racing each other for the same
 * index. Concurrent asks for the same (root, subject, plan, base) now share
 * the one answer; the entry is dropped the moment it settles, so nothing is
 * cached past the run and the next ask always reads today's code.
 */
export function shareStorylineRuns(
  run: (request: StorylineRequest) => Promise<StorylineAnswer>,
): (request: StorylineRequest) => Promise<StorylineAnswer> {
  const inFlight = new Map<string, Promise<StorylineAnswer>>()
  return (request) => {
    const key = JSON.stringify([
      request.rootId,
      request.file ?? null,
      request.partRef ?? null,
      request.plan ?? null,
      request.base ?? null,
    ])
    const existing = inFlight.get(key)
    if (existing !== undefined) return existing
    const started = run(request).finally(() => inFlight.delete(key))
    inFlight.set(key, started)
    return started
  }
}
