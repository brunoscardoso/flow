// One question end to end (Ask the Blueprint, Phase 2 — plan note 4).
//
//   1. FAST PASS — the `low` route, from gathered knowledge only. It answers in
//      seconds and says whether the knowledge was enough or thin.
//   2. DIG — the `medium` route, only when the fast pass said "thin". Bounded:
//      about 40 file reads (counted through `onRead`) and about 3 minutes
//      (the abort signal). Stop here aborts it and keeps the best answer so far,
//      marked partial.
//   3. WRITES — the orchestrator does every write; each caged session is
//      read-only. Code facts the dig confirmed go through the bundled CLI's
//      `blueprint observe` (fail-soft: the footer says when they were not
//      saved). The answer goes through `blueprint qa record` (or `qa follow-up`)
//      — a failed save is an `error` state carrying the answer, never hidden.
//
// UNMERGED WORK IS CONTEXT. A tagged conversation whose branch is not merged
// makes the answer say "in progress on branch X (not merged)"; when the
// project's own checkout is on that branch, the dig read unmerged code, so no
// fact is written at all.
//
// STATE IS SENT ON CHANGE ONLY (NFR-4, allowed-pattern #17): an `ask:state`
// event leaves here only when the step list or the answer differs from the
// last one sent — never per streamed activity.
//
// Every dependency is injected and required (allowed-pattern #26); nothing here
// has a working default that writes anything (forbidden-pattern #15).

import type {
  AskAnswer,
  AskPhase,
  AskRequest,
  AskSource,
  AskStateEvent,
  AskStep,
  AskVerdict,
} from '../../shared/ask-contract'
import { withoutCommandHint } from '../../shared/command-hint'
import { resolveAutoModel, type ModelRouting } from '../../shared/model-routing'
import { extractJsonObject, type CagedSessionParams, type CliRunResult } from '../agent/learn-session'
import type { AskContext, AskGit, CondensedThread } from './ask-context'

// ── Budget ──────────────────────────────────────────────────────────────────

/** The dig's read cap (NFR-2). */
export const ASK_DIG_MAX_READS = 40
/** The dig's time cap (NFR-2). */
export const ASK_DIG_MAX_MS = 3 * 60_000
/** The fast pass answers from knowledge; this only catches a pass that hangs. */
export const ASK_FAST_MAX_MS = 60_000
const FAST_MAX_TURNS = 4
const DIG_MAX_TURNS = 60
/** Steps the digging card shows — the newest ones. */
const MAX_VISIBLE_STEPS = 8
/** Facts one answer may record. */
const MAX_FACTS = 8
const OBSERVE_TIMEOUT_MS = 20_000
const QA_TIMEOUT_MS = 30_000

// ── Sentences (UI text — no commands, paths or settings: forbidden #12) ─────

const NO_ANSWER_SENTENCE = "Flow couldn't put an answer together for this question."
const SAVE_FAILED_SENTENCE = "The answer couldn't be saved."
const STOPPED_SENTENCE = 'Stopped before the code check finished.'
const BUDGET_SENTENCE = 'The code check reached its limit before it finished.'

// ── Types ───────────────────────────────────────────────────────────────────

/** One run of a question: the request plus what main minted for it. */
export interface AskRunInput extends AskRequest {
  askId: string
  /** Stop here — aborting it ends the run and keeps the best answer as partial. */
  stopSignal: AbortSignal
}

/** How a run ended. `answer` is present whenever one was shown. */
export interface AskResult {
  askId: string
  outcome: 'done' | 'partial' | 'error'
  answer: AskAnswer | null
  error?: string
}

/** Everything runAsk touches. All required (allowed-pattern #26). */
export interface AskDeps {
  /** A caged, read-only session — `runCagedSession` in production. */
  runSession: (params: CagedSessionParams) => Promise<string>
  /** The bundled CLI, asynchronously, with a timeout — never rejects. */
  runCli: (cwd: string, args: readonly string[], options: { timeoutMs: number }) => Promise<CliRunResult>
  /** Async git, argv only. */
  git: AskGit
  /** Milliseconds since an epoch — the dig's elapsed time. */
  now: () => number
  /** Gather the knowledge an answer is given (see ask-context.ts). */
  gatherContext: (input: { rootPath: string; question: string; tags: readonly string[]; conversationIds: readonly string[] }) => Promise<AskContext>
  /** The person's effort → model map (Auto routing). */
  routing: () => Partial<ModelRouting> | null
  /** The project's bound credentials for the caged session; undefined = ambient. */
  authEnv: (rootPath: string) => Promise<NodeJS.ProcessEnv | undefined>
  /** Who is asking — written as the saved entry's author. */
  author: (rootPath: string) => Promise<string>
  /** True when `relPath` is a regular file inside `rootPath`. */
  fileExists: (rootPath: string, relPath: string) => Promise<boolean>
  /** Write the record's JSON somewhere the CLI can read it; `cleanup` removes it. */
  writeInputFile: (json: string) => Promise<{ path: string; cleanup: () => Promise<void> }>
  /** Send one state event to the renderer. */
  emit: (event: AskStateEvent) => void
  /** Budget override (tests). Omitted → the NFR-2 defaults. */
  limits?: { digMaxReads?: number; digMaxMs?: number; fastMaxMs?: number }
}

// ── Parsing the structured return (lenient) ─────────────────────────────────

/** A fact the dig says the code confirms. */
export interface ParsedFact {
  text: string
  file: string
  symbol?: string
}

/** What one pass returned, leniently. */
export interface ParsedReturn {
  explanation: string
  thin: boolean
  sources: Array<{ label: string; featureId?: string; file?: string }>
  verdict?: AskVerdict
  reply?: string
  facts: ParsedFact[]
  couldNotFind?: string
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/** Drop a code fence around a plain-text answer. */
function unfence(raw: string): string {
  return raw.replace(/^\s*```[a-z]*\s*\n?/i, '').replace(/\n?```\s*$/, '').trim()
}

/**
 * Parse a pass's return. The explanation ALWAYS survives: a reply that is not
 * JSON is shown as text; a JSON reply without an explanation shows nothing
 * invented. Sources, verdict, reply and facts that are malformed are omitted.
 * Null only when there is nothing to show at all.
 */
export function parseAskReturn(raw: string): ParsedReturn | null {
  const text = raw.trim()
  if (text === '') return null
  const json = extractJsonObject(text)
  let record: Record<string, unknown> | null = null
  if (json !== null) {
    try {
      const parsed: unknown = JSON.parse(json)
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) record = parsed as Record<string, unknown>
    } catch {
      record = null
    }
  }
  if (record === null) {
    const plain = unfence(text)
    return plain === '' ? null : { explanation: plain, thin: true, sources: [], facts: [] }
  }
  const explanation = str(record.explanation) ?? str(record.answer)
  if (explanation === undefined) {
    // JSON with no explanation: the text around it is the best there is.
    const outside = unfence(text.replace(json ?? '', ''))
    if (outside === '') return null
    return { explanation: outside, thin: true, sources: [], facts: [] }
  }
  const sources: ParsedReturn['sources'] = []
  if (Array.isArray(record.sources)) {
    for (const item of record.sources) {
      if (typeof item === 'string' && item.trim() !== '') {
        sources.push({ label: item.trim() })
        continue
      }
      if (typeof item !== 'object' || item === null) continue
      const source = item as Record<string, unknown>
      const label = str(source.label) ?? str(source.file) ?? str(source.featureId)
      if (label === undefined) continue
      const featureId = str(source.featureId)
      const file = str(source.file)
      sources.push({ label, ...(featureId ? { featureId } : {}), ...(file ? { file } : {}) })
    }
  }
  let verdict: AskVerdict | undefined
  if (typeof record.verdict === 'object' && record.verdict !== null) {
    const v = record.verdict as Record<string, unknown>
    const label = str(v.label)
    const risk = str(v.risk)
    if (label !== undefined) verdict = { label, ...(risk ? { risk } : {}) }
  } else if (str(record.verdict) !== undefined) {
    verdict = { label: str(record.verdict) as string }
  }
  const facts: ParsedFact[] = []
  if (Array.isArray(record.facts)) {
    for (const item of record.facts) {
      if (typeof item !== 'object' || item === null) continue
      const fact = item as Record<string, unknown>
      const factText = str(fact.text)
      const file = str(fact.file)
      if (factText === undefined || file === undefined) continue
      const symbol = str(fact.symbol)
      facts.push({ text: factText, file, ...(symbol ? { symbol } : {}) })
    }
  }
  const knowledge = str(record.knowledge)?.toLowerCase()
  const reply = str(record.reply)
  const couldNotFind = str(record.couldNotFind)
  return {
    explanation,
    thin: knowledge !== 'enough',
    sources,
    ...(verdict ? { verdict } : {}),
    ...(reply ? { reply } : {}),
    facts,
    ...(couldNotFind ? { couldNotFind } : {}),
  }
}

/** A repo-relative path, or null when it is absolute, escapes, or is empty. */
export function repoRelative(rootPath: string, file: string): string | null {
  let path = file.trim().replace(/\\/g, '/')
  const root = rootPath.replace(/\\/g, '/').replace(/\/+$/, '') + '/'
  if (path.startsWith(root)) path = path.slice(root.length)
  path = path.replace(/^\.\//, '').replace(/:\d+(?::\d+)?$/, '')
  if (path === '' || path.startsWith('/') || /^[A-Za-z]:/.test(path)) return null
  if (path.split('/').some((segment) => segment === '..')) return null
  return path
}

/**
 * Resolve sources to feature or part ids the Blueprint knows. A featureId the
 * graph does not have is dropped (the source keeps its label, without a map
 * number); a bare slug resolves when `feature:<slug>` exists. Files are kept
 * only when they exist here — the saved log refuses citing code that is not.
 */
export async function resolveSources(
  rootPath: string,
  sources: ParsedReturn['sources'],
  knownIds: readonly string[],
  fileExists: AskDeps['fileExists'],
): Promise<AskSource[]> {
  const known = new Set(knownIds)
  const resolved: AskSource[] = []
  let n = 0
  const seen = new Set<string>()
  for (const source of sources) {
    let featureId: string | undefined
    if (source.featureId !== undefined) {
      const candidate = source.featureId.startsWith('feature:') ? source.featureId : `feature:${source.featureId}`
      if (known.has(candidate)) featureId = candidate
    }
    let file: string | undefined
    if (source.file !== undefined) {
      const rel = repoRelative(rootPath, source.file)
      if (rel !== null && (await fileExists(rootPath, rel).catch(() => false))) file = rel
    }
    const key = `${source.label}\u0000${featureId ?? ''}\u0000${file ?? ''}`
    if (seen.has(key)) continue
    seen.add(key)
    resolved.push({
      n: featureId !== undefined ? ++n : null,
      label: source.label,
      ...(featureId ? { featureId } : {}),
      ...(file ? { file } : {}),
    })
  }
  return resolved
}

// ── Prompts ─────────────────────────────────────────────────────────────────

function renderContext(question: string, tags: readonly string[], context: AskContext): string[] {
  const lines: string[] = [`Question: ${question}`, '']
  if (tags.length > 0) lines.push(`The person tagged: ${tags.join(', ')}`, '')
  if (context.features.length > 0) {
    lines.push('## Features on the Blueprint (id — name — summary)')
    for (const feature of context.features) {
      const mark = feature.tagged ? ' [tagged]' : ''
      const owner = feature.partOf !== undefined ? ` (part of ${feature.partOf})` : ''
      lines.push(`- ${feature.id}${mark}${owner} — ${feature.name} — ${feature.summary || '(no summary yet)'}`)
    }
    for (const relation of context.relations) lines.push(`- relation: ${relation.from} → ${relation.to}`)
    lines.push('')
  }
  if (context.hits.length > 0) {
    lines.push('## Project knowledge (search hits)')
    for (const hit of context.hits) {
      const project = hit.project !== undefined ? ` [${hit.project}]` : ''
      lines.push(`- ${hit.file}${project} — ${hit.title}: ${hit.snippet.replace(/\s+/g, ' ').trim()}`)
    }
    lines.push('')
  }
  if (context.notes.length > 0) {
    lines.push('## Recorded notes about the code')
    for (const note of context.notes) lines.push(`- ${note.text.split('\n')[0]} (${note.anchors.slice(0, 3).join(', ')})`)
    lines.push('')
  }
  for (const thread of context.threads) {
    lines.push(`## A conversation the person tagged: "${thread.title}"`)
    if (thread.branch !== null && thread.merged === false) {
      lines.push(`Its work is on branch ${thread.branch}, NOT merged. It is in progress — never describe it as how the code works.`)
    }
    for (const message of thread.personMessages) lines.push(`Person: ${message}`)
    for (const answer of thread.answers) lines.push(`Agent's answer: ${answer}`)
    if (thread.filesChanged.length > 0) lines.push(`Files it changed: ${thread.filesChanged.join(', ')}`)
    if (thread.linkedDocs.length > 0) lines.push(`Plans or discoveries: ${thread.linkedDocs.join(', ')}`)
    lines.push('')
  }
  return lines
}

const RETURN_SHAPE = [
  'Return ONLY one JSON object, no prose around it:',
  '{',
  '  "explanation": "the answer in plain words, short paragraphs, for a product manager or an engineer",',
  '  "knowledge": "enough" or "thin",',
  '  "sources": [{"label": "what the reader sees", "featureId": "feature:<slug> or feature:<slug>/<part> from the list above", "file": "repo-relative path"}],',
  '  "verdict": {"label": "e.g. Yes · medium effort", "risk": "the main risk in one sentence"} — only for a can-we-build question, else null,',
  '  "reply": "a short message the person can send back to whoever asked" or null',
]

export function buildFastPrompt(question: string, tags: readonly string[], context: AskContext): string {
  return [
    'You answer a question about this software project from what its knowledge already says.',
    'Answer from the knowledge below. Do not explore the code; one quick check is allowed only if it settles the question.',
    'Say "thin" when the knowledge does not really answer the question — a deeper code check follows then.',
    'Use only feature ids from the list below; leave featureId out when none fits. Never invent a file.',
    '',
    ...renderContext(question, tags, context),
    ...RETURN_SHAPE,
    '}',
  ].join('\n')
}

export function buildDigPrompt(
  question: string,
  tags: readonly string[],
  context: AskContext,
  first: ParsedReturn | null,
  maxReads: number,
): string {
  return [
    'You answer a question about this software project by reading its code. You may only read.',
    `You have about ${maxReads} file reads and a few minutes — read the files that settle the question first.`,
    'Use only feature ids from the list below; leave featureId out when none fits. Cite only files you read.',
    'Work on an unmerged branch is in progress: mention it, never state it as how the code works.',
    '',
    ...renderContext(question, tags, context),
    ...(first !== null ? ['## A first answer from knowledge (may be wrong or thin)', first.explanation, ''] : []),
    ...RETURN_SHAPE,
    '  "facts": [{"text": "one sentence that is true of the code you read", "file": "repo-relative path you read", "symbol": "the function or type, if one"}],',
    '  "couldNotFind": "what you could not find, in one sentence" or null',
    '}',
  ].join('\n')
}

// ── State emission (on change only) ─────────────────────────────────────────

function phaseKey(phase: AskPhase): string {
  // `reads` and `elapsedMs` ride along with a change; they never cause one.
  if (phase.kind === 'digging') return `digging:${JSON.stringify(phase.steps)}`
  return phase.kind === 'error' ? `error:${phase.sentence}` : phase.kind
}

function createEmitter(input: AskRunInput, emit: AskDeps['emit']) {
  let lastKey: string | null = null
  return (phase: AskPhase, answer: AskAnswer | null): void => {
    const key = `${phaseKey(phase)}\u0000${answer === null ? '' : JSON.stringify(answer)}`
    if (key === lastKey) return
    lastKey = key
    emit({ askId: input.askId, rootId: input.rootId, phase, answer })
  }
}

// ── The run ─────────────────────────────────────────────────────────────────

/** A promise that settles with '' the moment `signal` aborts. */
function untilAborted(signal: AbortSignal): Promise<string> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve('')
      return
    }
    signal.addEventListener('abort', () => resolve(''), { once: true })
  })
}

/** Run one caged pass, settling at once when its signal aborts. Never rejects. */
async function runPass(deps: AskDeps, params: CagedSessionParams, signal: AbortSignal): Promise<string> {
  try {
    return await Promise.race([deps.runSession(params), untilAborted(signal)])
  } catch {
    return ''
  }
}

function branchSentence(threads: readonly CondensedThread[]): string | undefined {
  const branches = [...new Set(threads.filter((t) => t.branch !== null && t.merged === false).map((t) => t.branch as string))]
  if (branches.length === 0) return undefined
  return `Already in progress on branch ${branches.join(', ')} (not merged)`
}

function toAnswer(
  parsed: ParsedReturn,
  sources: AskSource[],
  confidence: AskAnswer['confidence'],
  thin: boolean,
  extra: Partial<AskAnswer>,
): AskAnswer {
  return {
    explanation: parsed.explanation,
    confidence,
    thin,
    sources,
    ...(parsed.verdict ? { verdict: parsed.verdict } : {}),
    ...(parsed.reply ? { reply: parsed.reply } : {}),
    factsLearned: 0,
    factsSaved: true,
    partial: false,
    ...(parsed.couldNotFind ? { couldNotFind: parsed.couldNotFind } : {}),
    ...extra,
  }
}

/** The CLI's refusal sentence — the JSON payload's `detail`, else its refusal line — without a command hint. */
export function refusalSentence(result: CliRunResult): string | null {
  const transcript = `${result.stdout}\n${result.stderr ?? ''}`
  for (const line of transcript.split('\n').reverse()) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('{')) continue
    try {
      const payload = JSON.parse(trimmed) as { detail?: unknown }
      if (typeof payload.detail === 'string' && payload.detail.trim() !== '') return withoutCommandHint(payload.detail.trim())
    } catch {
      // not the payload line
    }
  }
  const refused = /qa refused: [^—\n]*—\s*(.+)/.exec(transcript)
  return refused !== null ? withoutCommandHint(refused[1].trim()) : null
}

/** The saved entry's id from `qa record --json`'s stdout (the last parseable `{` line). */
export function savedIdOf(stdout: string): string | null {
  for (const line of stdout.split('\n').reverse()) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('{')) continue
    try {
      const parsed = JSON.parse(trimmed) as { entry?: { id?: unknown } }
      if (typeof parsed.entry?.id === 'string') return parsed.entry.id
    } catch {
      // keep scanning
    }
  }
  return null
}

/** `blueprint observe` args for one fact: its file is the identity anchor, a symbol decorates it. */
export function buildAskObserveArgs(fact: { text: string; file: string; symbol?: string }): string[] {
  const args = [
    'blueprint',
    'observe',
    '--lenient-anchors',
    '--conflict-scope',
    'primary',
    `--note=${fact.text.replace(/\s+/g, ' ').trim()}`,
    '--anchor',
    `file:${fact.file}`,
  ]
  if (fact.symbol !== undefined && /^[A-Za-z_$][\w$.]*$/.test(fact.symbol)) {
    args.push('--anchor', `symbol:${fact.file}#${fact.symbol}`)
  }
  return args
}

async function currentBranch(deps: AskDeps, rootPath: string): Promise<string | null> {
  const result = await deps.git(rootPath, ['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => null)
  if (result === null || !result.ok) return null
  const branch = result.stdout.trim()
  return branch === '' || branch === 'HEAD' ? null : branch
}

/** Record the dig's facts through `observe`. Fail-soft: counts what was written and whether anything failed. */
async function writeFacts(
  deps: AskDeps,
  rootPath: string,
  facts: readonly ParsedFact[],
): Promise<{ learned: number; saved: boolean }> {
  let learned = 0
  let failed = 0
  for (const fact of facts.slice(0, MAX_FACTS)) {
    const file = repoRelative(rootPath, fact.file)
    if (file === null || !(await deps.fileExists(rootPath, file).catch(() => false))) continue
    const result = await deps
      .runCli(rootPath, buildAskObserveArgs({ ...fact, file }), { timeoutMs: OBSERVE_TIMEOUT_MS })
      .catch((): CliRunResult => ({ ok: false, stdout: '' }))
    if (result.ok) learned += 1
    else failed += 1
  }
  return { learned, saved: failed === 0 }
}

/** Save the answer through `blueprint qa record | follow-up`. Returns the id, or the sentence why not. */
async function saveAnswer(
  deps: AskDeps,
  input: AskRunInput,
  rootPath: string,
  answer: AskAnswer,
  tags: readonly string[],
  conversationCount: number,
): Promise<{ ok: true; id: string } | { ok: false; sentence: string }> {
  const author = (await deps.author(rootPath).catch(() => '')).trim() || 'someone'
  const record: Record<string, unknown> = {
    author,
    question: input.question.trim(),
    tags: [...tags],
    conversationCount,
    usedConversation: conversationCount > 0,
    answer: answer.explanation,
    sources: answer.sources.map((source) => ({
      label: source.label,
      ...(source.featureId ? { featureId: source.featureId } : {}),
      ...(source.file ? { file: source.file } : {}),
    })),
    factsLearned: answer.factsLearned,
    partial: answer.partial,
    ...(answer.verdict ? { verdict: answer.verdict } : {}),
    ...(answer.reply ? { reply: answer.reply } : {}),
    ...(answer.branchInProgress ? { branchInProgress: answer.branchInProgress } : {}),
    ...(input.followUpOf ? { parentId: input.followUpOf } : {}),
  }
  let file: { path: string; cleanup: () => Promise<void> }
  try {
    file = await deps.writeInputFile(JSON.stringify(record))
  } catch {
    return { ok: false, sentence: SAVE_FAILED_SENTENCE }
  }
  try {
    const verb = input.followUpOf ? 'follow-up' : 'record'
    const result = await deps
      .runCli(rootPath, ['blueprint', 'qa', verb, '--input', file.path, '--json'], { timeoutMs: QA_TIMEOUT_MS })
      .catch((): CliRunResult => ({ ok: false, stdout: '' }))
    const id = result.ok ? savedIdOf(result.stdout) : null
    if (id !== null) return { ok: true, id }
    const why = refusalSentence(result)
    return { ok: false, sentence: why === null ? SAVE_FAILED_SENTENCE : `${SAVE_FAILED_SENTENCE} ${capitalize(why)}` }
  } finally {
    await file.cleanup().catch(() => undefined)
  }
}

function capitalize(text: string): string {
  const sentence = text.charAt(0).toUpperCase() + text.slice(1)
  return /[.!?]$/.test(sentence) ? sentence : `${sentence}.`
}

/**
 * One question end to end: fast pass, a bounded dig only when knowledge is
 * thin, lenient parse, facts through observe, the answer through `qa record`.
 * Never throws — every ending is an AskResult and a final state event.
 */
export async function runAsk(input: AskRunInput, deps: AskDeps): Promise<AskResult> {
  try {
    return await runAskUnguarded(input, deps)
  } catch (error) {
    // An injected dependency threw. The panel still gets an ending.
    console.warn('[ask] run failed:', error)
    deps.emit({ askId: input.askId, rootId: input.rootId, phase: { kind: 'error', sentence: NO_ANSWER_SENTENCE }, answer: null })
    return { askId: input.askId, outcome: 'error', answer: null, error: NO_ANSWER_SENTENCE }
  }
}

async function runAskUnguarded(input: AskRunInput, deps: AskDeps): Promise<AskResult> {
  const rootPath = input.rootId
  const emit = createEmitter(input, deps.emit)
  const digMaxReads = deps.limits?.digMaxReads ?? ASK_DIG_MAX_READS
  const digMaxMs = deps.limits?.digMaxMs ?? ASK_DIG_MAX_MS
  const fastMaxMs = deps.limits?.fastMaxMs ?? ASK_FAST_MAX_MS
  const fail = (sentence: string, answer: AskAnswer | null): AskResult => {
    emit({ kind: 'error', sentence }, answer)
    return { askId: input.askId, outcome: 'error', answer, error: sentence }
  }

  emit({ kind: 'fast' }, null)
  const routing = deps.routing()
  const authEnv = await deps.authEnv(rootPath).catch(() => undefined)
  const context = await deps.gatherContext({
    rootPath,
    question: input.question,
    tags: input.tags,
    conversationIds: input.conversationIds,
  })
  const branchInProgress = branchSentence(context.threads)
  const known = new Set(context.knownIds)
  // Tags the Blueprint does not know would make the save refuse; an empty
  // known set means no graph could be read, and the writer checks grammar only.
  const tags = known.size === 0 ? input.tags : input.tags.filter((tag) => known.has(tag))
  const extra: Partial<AskAnswer> = branchInProgress !== undefined ? { branchInProgress } : {}

  // ── 1. Fast pass ──
  const fastAbort = new AbortController()
  const onStop = (): void => fastAbort.abort()
  input.stopSignal.addEventListener('abort', onStop, { once: true })
  const fastTimer = setTimeout(() => fastAbort.abort(), fastMaxMs)
  const fastRaw = input.stopSignal.aborted
    ? ''
    : await runPass(
        deps,
        {
          cwd: rootPath,
          prompt: buildFastPrompt(input.question, input.tags, context),
          model: resolveAutoModel('low', routing),
          maxTurns: FAST_MAX_TURNS,
          abortSignal: fastAbort.signal,
          ...(authEnv !== undefined ? { authEnv } : {}),
        },
        fastAbort.signal,
      )
  clearTimeout(fastTimer)
  input.stopSignal.removeEventListener('abort', onStop)
  const fast = parseAskReturn(fastRaw)
  let best: AskAnswer | null = null
  if (fast !== null) {
    const sources = await resolveSources(rootPath, fast.sources, context.knownIds, deps.fileExists)
    best = toAnswer(fast, sources, 'first', fast.thin, extra)
  }

  // ── 2. Dig, only when knowledge is thin ──
  let digResult: ParsedReturn | null = null
  let digEndedEarly: 'stopped' | 'budget' | null = null
  const needDig = !input.stopSignal.aborted && (fast === null || fast.thin)
  if (needDig) {
    const startedAt = deps.now()
    const steps: string[] = []
    let reads = 0
    const digAbort = new AbortController()
    let budgetHit = false
    const stopDig = (): void => digAbort.abort()
    input.stopSignal.addEventListener('abort', stopDig, { once: true })
    const digTimer = setTimeout(() => {
      budgetHit = true
      digAbort.abort()
    }, digMaxMs)
    const showSteps = (): void => {
      const visible = steps.slice(-MAX_VISIBLE_STEPS)
      const shown: AskStep[] = visible.map((label, at) => ({
        label,
        state: at === visible.length - 1 ? 'current' : 'done',
      }))
      emit({ kind: 'digging', steps: shown, reads, elapsedMs: deps.now() - startedAt }, best)
    }
    const addStep = (label: string): void => {
      if (steps[steps.length - 1] === label) return
      steps.push(label)
      showSteps()
    }
    addStep('Looking through the code')
    const digRaw = await runPass(
      deps,
      {
        cwd: rootPath,
        prompt: buildDigPrompt(input.question, input.tags, context, fast, digMaxReads),
        model: resolveAutoModel('medium', routing),
        maxTurns: DIG_MAX_TURNS,
        abortSignal: digAbort.signal,
        ...(authEnv !== undefined ? { authEnv } : {}),
        onRead: (filePath) => {
          if (digAbort.signal.aborted) return
          reads += 1
          const rel = repoRelative(rootPath, filePath) ?? filePath
          addStep(`Read ${rel}`)
          if (reads >= digMaxReads) {
            budgetHit = true
            digAbort.abort()
          }
        },
        onActivity: (kind, detail) => {
          if (digAbort.signal.aborted) return
          if (kind === 'tool' && (detail === 'Grep' || detail === 'Glob')) addStep('Searching the code')
          else if (kind === 'writing') addStep('Writing the answer')
        },
      },
      digAbort.signal,
    )
    clearTimeout(digTimer)
    input.stopSignal.removeEventListener('abort', stopDig)
    if (digAbort.signal.aborted) digEndedEarly = input.stopSignal.aborted ? 'stopped' : budgetHit ? 'budget' : 'stopped'
    digResult = parseAskReturn(digRaw)
    if (digResult !== null) {
      const sources = await resolveSources(rootPath, digResult.sources, context.knownIds, deps.fileExists)
      best = toAnswer(digResult, sources, 'checked', false, { ...extra, partial: digEndedEarly !== null })
    } else if (best !== null && digEndedEarly !== null) {
      best = {
        ...best,
        partial: true,
        couldNotFind: best.couldNotFind ?? (digEndedEarly === 'budget' ? BUDGET_SENTENCE : STOPPED_SENTENCE),
      }
    }
  } else if (best !== null && fast !== null && fast.thin && input.stopSignal.aborted) {
    // Stopped before the dig the thin first answer called for could start.
    best = { ...best, partial: true, couldNotFind: best.couldNotFind ?? STOPPED_SENTENCE }
  }

  if (best === null) {
    if (input.stopSignal.aborted) {
      emit({ kind: 'partial' }, null)
      return { askId: input.askId, outcome: 'partial', answer: null }
    }
    return fail(NO_ANSWER_SENTENCE, null)
  }

  // ── 3. Facts (dig only; never from unmerged work) ──
  if (digResult !== null && digResult.facts.length > 0) {
    const unmergedHere = await (async (): Promise<boolean> => {
      const unmerged = context.threads.filter((t) => t.branch !== null && t.merged === false).map((t) => t.branch)
      if (unmerged.length === 0) return false
      const here = await currentBranch(deps, rootPath)
      return here !== null && unmerged.includes(here)
    })()
    if (!unmergedHere) {
      const { learned, saved } = await writeFacts(deps, rootPath, digResult.facts)
      best = { ...best, factsLearned: learned, factsSaved: saved }
    }
  }

  // ── 4. Save the answer — a failure is shown, never hidden ──
  const saved = await saveAnswer(deps, input, rootPath, best, tags, context.threads.length)
  if (!saved.ok) return fail(saved.sentence, best)
  best = { ...best, savedId: saved.id }
  const outcome: AskResult['outcome'] = best.partial ? 'partial' : 'done'
  emit({ kind: outcome }, best)
  return { askId: input.askId, outcome, answer: best }
}
