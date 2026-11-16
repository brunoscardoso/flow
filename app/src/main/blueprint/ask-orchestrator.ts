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
// WORKSPACE SCOPE (plan `ask_the_blueprint_workspace`, notes 6 and 7). A run
// with a resolved scope works from a project→root map instead of one root: the
// sessions' cwd is one local in-scope project and the other local ones are
// extra read roots (reads contained to all of them); prompts name the
// projects and say which are answered from knowledge only; sources resolve
// back to (project, path) by the checkout that contains them; facts are
// written into their own project; the answer is saved through
// `blueprint qa record | follow-up --workspace`; the dig gets a larger budget
// (60 reads, 4 minutes). Touchpoints between in-scope projects the answer
// found and the Workspace has not recorded come back as suggested
// connections — recorded only when a person presses Save as connection, never
// here. A run without a scope is the project ask, unchanged.
//
// Every dependency is injected and required (allowed-pattern #26); nothing here
// has a working default that writes anything (forbidden-pattern #15).

import {
  qualifyFeatureId,
  splitQualifiedFeatureId,
  type AskAnswer,
  type AskConnectionKind,
  type AskPhase,
  type AskRequest,
  type AskSource,
  type AskStateEvent,
  type AskStep,
  type AskSuggestedConnection,
  type AskVerdict,
} from '../../shared/ask-contract'
import { withoutCommandHint } from '../../shared/command-hint'
import { resolveAutoModel, type ModelRouting } from '../../shared/model-routing'
import { extractJsonObject, type CagedSessionParams, type CliRunResult } from '../agent/learn-session'
import type { AskContext, AskGit, AskNote, AskResolvedScope, AskScopeProject, CondensedThread } from './ask-context'

// ── Budget ──────────────────────────────────────────────────────────────────

/** The dig's read cap (NFR-2). */
export const ASK_DIG_MAX_READS = 40
/** The dig's time cap (NFR-2). */
export const ASK_DIG_MAX_MS = 3 * 60_000
/** The dig's read cap across every project of a Workspace ask (NFR-2). */
export const ASK_WORKSPACE_DIG_MAX_READS = 60
/** The dig's time cap for a Workspace ask (NFR-2). */
export const ASK_WORKSPACE_DIG_MAX_MS = 4 * 60_000
/** Suggested connections one answer may carry. */
const MAX_SUGGESTED_CONNECTIONS = 5
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
const NO_CODE_HERE_SENTENCE = "None of these projects is on this computer, so their code couldn't be checked."

// ── Types ───────────────────────────────────────────────────────────────────

/** One run of a question: the request plus what main minted for it. */
export interface AskRunInput extends AskRequest {
  askId: string
  /** Stop here — aborting it ends the run and keeps the best answer as partial. */
  stopSignal: AbortSignal
  /** A Workspace ask's scope, resolved by the gate. Absent = the project ask of `rootId`. */
  scope?: AskResolvedScope
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
  gatherContext: (input: {
    rootPath: string
    question: string
    tags: readonly string[]
    conversationIds: readonly string[]
    workspace?: AskResolvedScope
  }) => Promise<AskContext>
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
  /** Workspace scope: the project the file is in, when the model said. */
  project?: string
}

/** A touchpoint between two projects the model named (unchecked). */
export interface ParsedConnection {
  from: string
  to: string
  kind: string
  note?: string
}

/** What one pass returned, leniently. */
export interface ParsedReturn {
  explanation: string
  thin: boolean
  sources: Array<{ label: string; featureId?: string; file?: string; project?: string }>
  verdict?: AskVerdict
  reply?: string
  facts: ParsedFact[]
  couldNotFind?: string
  /** Workspace scope: present only when the return carried any. */
  connections?: ParsedConnection[]
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
      const project = str(source.project)
      sources.push({ label, ...(featureId ? { featureId } : {}), ...(file ? { file } : {}), ...(project ? { project } : {}) })
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
      const project = str(fact.project)
      facts.push({ text: factText, file, ...(symbol ? { symbol } : {}), ...(project ? { project } : {}) })
    }
  }
  const connections: ParsedConnection[] = []
  if (Array.isArray(record.connections)) {
    for (const item of record.connections) {
      if (typeof item !== 'object' || item === null) continue
      const raw = item as Record<string, unknown>
      const from = str(raw.from)
      const to = str(raw.to)
      const kind = str(raw.kind)
      if (from === undefined || to === undefined || kind === undefined) continue
      const note = str(raw.note)
      connections.push({ from, to, kind, ...(note ? { note } : {}) })
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
    ...(connections.length > 0 ? { connections } : {}),
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

/** The checkouts a Workspace ask can cite files from, and the session's own. */
export interface AskSourceRoots {
  projects: readonly AskScopeProject[]
  /** The project whose checkout the session ran in — where a bare relative path points. */
  cwdProject: string | null
}

/**
 * Where a cited file is: the (project, repo-relative path) candidates, best
 * first. An absolute path belongs to the checkout that contains it; a relative
 * one may start with `<project>/`, else it is relative to the named project,
 * else to the session's own checkout. Only projects on this computer appear.
 */
export function locateFileCandidates(
  roots: AskSourceRoots,
  file: string,
  hint?: string,
): Array<{ project: string; rootPath: string; rel: string }> {
  const local = roots.projects.filter((p): p is AskScopeProject & { rootPath: string } => p.rootPath !== null)
  const path = file.trim().replace(/\\/g, '/')
  if (path.startsWith('/') || /^[A-Za-z]:/.test(path)) {
    const owner = [...local]
      .sort((a, b) => b.rootPath.length - a.rootPath.length)
      .find((p) => {
        const root = p.rootPath.replace(/\\/g, '/').replace(/\/+$/, '')
        return path === root || path.startsWith(`${root}/`)
      })
    if (owner === undefined) return []
    const rel = repoRelative(owner.rootPath, path)
    return rel === null ? [] : [{ project: owner.slug, rootPath: owner.rootPath, rel }]
  }
  const out: Array<{ project: string; rootPath: string; rel: string }> = []
  const push = (project: AskScopeProject & { rootPath: string }, candidate: string): void => {
    const rel = repoRelative(project.rootPath, candidate)
    if (rel !== null && !out.some((c) => c.project === project.slug && c.rel === rel)) out.push({ project: project.slug, rootPath: project.rootPath, rel })
  }
  const normalized = path.replace(/^\.\//, '')
  const slash = normalized.indexOf('/')
  if (slash > 0) {
    const prefixed = local.find((p) => p.slug === normalized.slice(0, slash))
    if (prefixed !== undefined) push(prefixed, normalized.slice(slash + 1))
  }
  const named = local.find((p) => p.slug === hint)
  if (named !== undefined) push(named, normalized)
  const own = local.find((p) => p.slug === roots.cwdProject)
  if (own !== undefined && hint === undefined) push(own, normalized)
  return out
}

/** The first candidate that is a file in its project's checkout, or null. */
async function locateFile(
  roots: AskSourceRoots,
  file: string,
  hint: string | undefined,
  fileExists: AskDeps['fileExists'],
): Promise<{ project: string; rootPath: string; rel: string } | null> {
  for (const candidate of locateFileCandidates(roots, file, hint)) {
    if (await fileExists(candidate.rootPath, candidate.rel).catch(() => false)) return candidate
  }
  return null
}

/** A cited feature id resolved to a qualified id some in-scope project knows, with its project. */
function resolveWorkspaceFeature(
  raw: string,
  hint: string | undefined,
  roots: AskSourceRoots,
  known: ReadonlySet<string>,
): { id: string; project: string } | null {
  const id = raw.startsWith('feature:') ? raw : `feature:${raw}`
  const qualified = splitQualifiedFeatureId(id)
  if (qualified !== null) return known.has(id) ? { id, project: qualified.project } : null
  if (hint !== undefined) {
    const candidate = qualifyFeatureId(hint, id)
    return known.has(candidate) ? { id: candidate, project: hint } : null
  }
  // No project named: accept only when exactly one in-scope project has it.
  const matches = roots.projects.map((p) => ({ id: qualifyFeatureId(p.slug, id), project: p.slug })).filter((m) => known.has(m.id))
  return matches.length === 1 ? matches[0] : null
}

/** Workspace scope of `resolveSources`. */
async function resolveWorkspaceSources(
  roots: AskSourceRoots,
  sources: ParsedReturn['sources'],
  knownIds: readonly string[],
  fileExists: AskDeps['fileExists'],
): Promise<AskSource[]> {
  const known = new Set(knownIds)
  const slugs = new Set(roots.projects.map((p) => p.slug))
  const resolved: AskSource[] = []
  const seen = new Set<string>()
  let n = 0
  for (const source of sources) {
    const hint = source.project !== undefined && slugs.has(source.project) ? source.project : undefined
    let file: { project: string; rel: string } | null = null
    if (source.file !== undefined) {
      // A project not on this computer can cite a feature, never a file.
      const remote = hint !== undefined && roots.projects.some((p) => p.slug === hint && p.rootPath === null)
      if (!remote) file = await locateFile(roots, source.file, hint, fileExists)
    }
    const feature =
      source.featureId !== undefined ? resolveWorkspaceFeature(source.featureId, hint ?? file?.project, roots, known) : null
    // A file and a feature of two different projects: the file wins (it was read).
    const project = file?.project ?? feature?.project ?? hint
    const featureId = feature !== null && feature.project === project ? feature.id : undefined
    const key = `${source.label}\u0000${featureId ?? ''}\u0000${project ?? ''}\u0000${file?.rel ?? ''}`
    if (seen.has(key)) continue
    seen.add(key)
    resolved.push({
      // POSITIONAL: the answer's [n] cites the nth source it listed.
      n: ++n,
      label: source.label,
      ...(featureId ? { featureId } : {}),
      ...(file ? { file: file.rel } : {}),
      ...(project ? { project } : {}),
    })
  }
  return resolved
}

/**
 * Resolve sources to feature or part ids the Blueprint knows. A featureId the
 * graph does not have is dropped (the source keeps its label); a bare slug
 * resolves when `feature:<slug>` exists. Every source is numbered by its
 * position, so the answer's `[n]` citations land on the nth source. Files are kept
 * only when they exist here — the saved log refuses citing code that is not.
 *
 * Workspace scope (`target` is the in-scope checkouts): each file resolves to
 * the project whose checkout contains it (a `<project>/` prefix accepted) and
 * is kept only when it exists there; a feature is kept only when its project
 * knows it; a source in a project not on this computer keeps its feature,
 * never a file.
 */
export async function resolveSources(
  target: string | AskSourceRoots,
  sources: ParsedReturn['sources'],
  knownIds: readonly string[],
  fileExists: AskDeps['fileExists'],
): Promise<AskSource[]> {
  if (typeof target !== 'string') return resolveWorkspaceSources(target, sources, knownIds, fileExists)
  const rootPath = target
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
      // POSITIONAL: the answer's [n] cites the nth source it listed.
      n: ++n,
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
  const scope = context.workspace
  if (scope !== undefined) {
    lines.push(`## Projects in this question (Workspace ${scope.name})`)
    for (const project of scope.projects) {
      const where = project.local ? 'code on this computer' : 'knowledge only — not on this computer, never cite its files'
      lines.push(`- ${project.slug} — ${project.name} — ${where}${project.readable ? '' : ' (its feature map could not be read)'}`)
    }
    lines.push('')
    if (scope.links.length > 0) {
      lines.push('## Recorded connections between these projects')
      for (const link of scope.links) lines.push(`- ${link.from} —${link.kind}→ ${link.to}${link.note !== undefined ? ` — ${link.note}` : ''}`)
      lines.push('')
    }
  }
  if (context.features.length > 0) {
    lines.push('## Features on the Blueprint (id — name — summary)')
    for (const feature of context.features) {
      const mark = feature.tagged ? ' [tagged]' : ''
      const owner = feature.partOf !== undefined ? ` (part of ${feature.partOf})` : ''
      // A DRAFT IS LABELLED WHERE IT IS READ: what the agent quotes from it
      // must say it is work in progress on that branch, never how the code works.
      const draft = feature.draftBranch !== undefined ? ` [work in progress on ${feature.draftBranch}, not merged]` : ''
      lines.push(`- ${feature.id}${mark}${owner}${draft} — ${feature.name} — ${feature.summary || '(no summary yet)'}`)
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
    if (context.notes.some((note) => note.status === 'draft')) {
      lines.push(
        'A note that starts "Work in progress on <branch>" was learned on a branch that is not merged. If you use it, say "Work in progress on <branch>" and that it may change. Never present it as how the code works.',
      )
    }
    for (const note of context.notes) lines.push(askNoteLine(note))
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

/**
 * THE ANSWER IS STRUCTURED MARKDOWN, so the panel formats it from structure
 * rather than guessing from prose: a one-sentence lead on the first line,
 * short headed sections with real lists, backticked code names, positional
 * [n] citations and an optional "Not covered:" line. The panel's renderer
 * (`ask-answer-model`) reads exactly this grammar and still shows plain prose.
 */
const EXPLANATION_RULES = [
  'markdown for a product manager or an engineer:',
  'line 1 is the answer in ONE sentence;',
  'then 1 to 4 short sections, each a line starting with "### " (a heading of a few words) followed by "- " bullet lines or one short paragraph;',
  'wrap code names (functions, types, routes, settings) and file paths in backticks;',
  'cite a source as [n], n being its position in "sources" (1 is the first);',
  'when part of the question could not be checked, end with one line starting "Not covered: ".',
]

const EXPLANATION_SHAPE = JSON.stringify(
  [...EXPLANATION_RULES.slice(0, 4), 'name a feature from the list above as `feature:<slug>` in backticks;', ...EXPLANATION_RULES.slice(4)].join(' '),
)

const WORKSPACE_EXPLANATION_SHAPE = JSON.stringify(
  [
    ...EXPLANATION_RULES.slice(0, 4),
    'name the project each part of it is about, and a feature from the list above as `feature:<project>::<slug>` in backticks;',
    ...EXPLANATION_RULES.slice(4),
  ].join(' '),
)

const RETURN_SHAPE = [
  'Return ONLY one JSON object, no prose around it:',
  '{',
  `  "explanation": ${EXPLANATION_SHAPE},`,
  '  "knowledge": "enough" or "thin",',
  '  "sources": [{"label": "what the reader sees", "featureId": "feature:<slug> or feature:<slug>/<part> from the list above", "file": "repo-relative path"}],',
  '  "verdict": {"label": "e.g. Yes · medium effort", "risk": "the main risk in one sentence"} — only for a can-we-build question, else null,',
  '  "reply": "a short message the person can send back to whoever asked" or null',
]

/** The Workspace return shape: every source and fact names its project; touchpoints are suggested. */
const WORKSPACE_RETURN_SHAPE = [
  'Return ONLY one JSON object, no prose around it:',
  '{',
  `  "explanation": ${WORKSPACE_EXPLANATION_SHAPE},`,
  '  "knowledge": "enough" or "thin",',
  '  "sources": [{"label": "what the reader sees", "project": "<project slug>", "featureId": "feature:<project>::<slug> or feature:<project>::<slug>/<part> from the list above", "file": "path relative to that project\'s folder"}],',
  '  "verdict": {"label": "e.g. Yes · medium effort", "risk": "the main risk in one sentence"} — only for a can-we-build question, else null,',
  '  "reply": "a short message the person can send back to whoever asked" or null,',
  '  "connections": [{"from": "<project>/<feature-slug> or <project>/endpoint:<METHOD /path> (also file:, module:, symbol:, table:)", "to": "the other project\'s end, same form", "kind": "calls" | "exposes" | "consumes" | "relates", "note": "how they touch, one line"}] — only touchpoints between two DIFFERENT projects above that are not among the recorded connections; else []',
]

function projectList(context: AskContext): string {
  return (context.workspace?.projects ?? []).map((p) => p.slug).join(', ')
}

export function buildFastPrompt(question: string, tags: readonly string[], context: AskContext): string {
  if (context.workspace !== undefined) {
    return [
      `You answer a question about these software projects (${projectList(context)}) from what their knowledge already says.`,
      'Answer from the knowledge below. Do not explore the code; one quick check is allowed only if it settles the question.',
      'Say "thin" when the knowledge does not really answer the question — a deeper code check follows then.',
      'Use only feature ids from the list below; leave featureId out when none fits. Never invent a file.',
      'A project marked knowledge only is not on this computer: answer about it from its knowledge and never cite a file of it.',
      '',
      ...renderContext(question, tags, context),
      ...WORKSPACE_RETURN_SHAPE,
      '}',
    ].join('\n')
  }
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
  /** Workspace scope: each local project's folder; the first is the working folder. */
  folders: ReadonlyArray<{ project: string; path: string }> = [],
): string {
  if (context.workspace !== undefined) {
    const knowledgeOnly = context.workspace.projects.filter((p) => !p.local).map((p) => p.slug)
    return [
      `You answer a question about these software projects (${projectList(context)}) by reading their code. You may only read.`,
      'Their folders on this computer (read only inside these):',
      ...folders.map((folder, at) => `- ${folder.project}: ${folder.path}${at === 0 ? ' (your working folder)' : ''}`),
      ...(knowledgeOnly.length > 0
        ? [`Not on this computer — answer about them from knowledge only, never cite their files: ${knowledgeOnly.join(', ')}`]
        : []),
      `You have about ${maxReads} file reads and a few minutes across all of them — read the files that settle the question first.`,
      'Use only feature ids from the list below; leave featureId out when none fits. Cite only files you read, each with its project.',
      'Work on an unmerged branch is in progress: mention it, never state it as how the code works.',
      '',
      ...renderContext(question, tags, context),
      ...(first !== null ? ['## A first answer from knowledge (may be wrong or thin)', first.explanation, ''] : []),
      ...WORKSPACE_RETURN_SHAPE.slice(0, -1),
      `${WORKSPACE_RETURN_SHAPE[WORKSPACE_RETURN_SHAPE.length - 1]},`,
      '  "facts": [{"text": "one sentence that is true of the code you read", "project": "<project slug>", "file": "path relative to that project\'s folder", "symbol": "the function or type, if one"}],',
      '  "couldNotFind": "what you could not find, in one sentence" or null',
      '}',
    ].join('\n')
  }
  return [
    'You answer a question about this software project by reading its code. You may only read.',
    `You have about ${maxReads} file reads and a few minutes — read the files that settle the question first.`,
    'Use only feature ids from the list below; leave featureId out when none fits. Cite only files you read.',
    'Work on an unmerged branch is in progress: mention it, never state it as how the code works.',
    '',
    ...renderContext(question, tags, context),
    ...(first !== null ? ['## A first answer from knowledge (may be wrong or thin)', first.explanation, ''] : []),
    ...RETURN_SHAPE.slice(0, -1),
    `${RETURN_SHAPE[RETURN_SHAPE.length - 1]},`,
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
    emit({ askId: input.askId, rootId: input.rootId, ...workspaceOf(input), phase, answer })
  }
}

/** `{ workspace }` on a Workspace ask's events; nothing on a project ask's. */
function workspaceOf(input: AskRunInput): { workspace?: string } {
  return input.scope !== undefined ? { workspace: input.scope.workspace.slug } : {}
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
  const refused = /(?:qa|workspace) refused: [^—\n]*—\s*(.+)/.exec(transcript)
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
  const scope = input.scope
  const record: Record<string, unknown> = {
    author,
    question: input.question.trim(),
    tags: [...tags],
    conversationCount,
    usedConversation: conversationCount > 0,
    answer: answer.explanation,
    sources: answer.sources
      // The Workspace writer refuses a source that names no project.
      .filter((source) => scope === undefined || source.project !== undefined)
      .map((source) => ({
        label: source.label,
        ...(scope !== undefined && source.project ? { project: source.project } : {}),
        ...(source.featureId ? { featureId: source.featureId } : {}),
        ...(source.file ? { file: source.file } : {}),
      })),
    ...(scope !== undefined ? { projectsRead: answer.projectsRead ?? [], knowledgeOnly: answer.knowledgeOnly ?? [] } : {}),
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
    // A Workspace answer: one writer for the Workspace record AND every cited project's pointer.
    const where = scope !== undefined ? ['--workspace', scope.workspace.slug, '--target', input.rootId] : []
    const result = await deps
      .runCli(scope !== undefined ? input.rootId : rootPath, ['blueprint', 'qa', verb, ...where, '--input', file.path, '--json'], {
        timeoutMs: QA_TIMEOUT_MS,
      })
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
    deps.emit({ askId: input.askId, rootId: input.rootId, ...workspaceOf(input), phase: { kind: 'error', sentence: NO_ANSWER_SENTENCE }, answer: null })
    return { askId: input.askId, outcome: 'error', answer: null, error: NO_ANSWER_SENTENCE }
  }
}

// ── Workspace scope helpers ─────────────────────────────────────────────────

const CONNECTION_KINDS = new Set<AskConnectionKind>(['calls', 'exposes', 'consumes', 'relates'])
const ANCHOR_KINDS = new Set(['endpoint', 'file', 'module', 'symbol', 'table'])

/** Where a Workspace ask runs: cwd at one local project, the other local ones as extra read roots. */
export interface AskSessionRoots {
  cwd: string
  /** The project the cwd is, or null when no in-scope project is on this computer. */
  cwdProject: string | null
  /** The other local in-scope checkouts. */
  readRoots: string[]
  /** Every local in-scope project, the cwd's first. */
  folders: Array<{ project: string; path: string }>
}

/** Pick the session's roots: the board's own project when it is local and in scope, else the first local one. */
export function sessionRootsOf(scope: AskResolvedScope, rootId: string): AskSessionRoots {
  const local = scope.projects.filter((p): p is AskScopeProject & { rootPath: string } => p.rootPath !== null)
  const own = local.find((p) => p.rootPath === rootId) ?? local[0]
  if (own === undefined) return { cwd: rootId, cwdProject: null, readRoots: [], folders: [] }
  const others = local.filter((p) => p !== own)
  return {
    cwd: own.rootPath,
    cwdProject: own.slug,
    readRoots: others.map((p) => p.rootPath),
    folders: [own, ...others].map((p) => ({ project: p.slug, path: p.rootPath })),
  }
}

/** The Workspace tags the saved log can take: qualified features the scope knows, projects and links of the Workspace. */
function workspaceTags(tags: readonly string[], scope: AskResolvedScope, known: ReadonlySet<string>): string[] {
  const projects = new Set(scope.workspaceProjects)
  return tags.filter((tag) => {
    const project = /^project:([A-Za-z0-9._-]+)$/.exec(tag)
    if (project !== null) return projects.has(project[1])
    const link = /^link:([A-Za-z0-9._-]+)::([A-Za-z0-9._-]+)$/.exec(tag)
    if (link !== null) return projects.has(link[1]) && projects.has(link[2]) && link[1] !== link[2]
    const feature = splitQualifiedFeatureId(tag)
    if (feature === null) return false
    return known.size === 0 ? projects.has(feature.project) : known.has(tag)
  })
}

/** One link end, normalised to the Workspace writer's spelling (`<project>/<slug>` for a feature); null when it is not one. */
function normalizeEnd(raw: string, projects: ReadonlySet<string>): { address: string; project: string } | null {
  const value = raw.trim()
  const slash = value.indexOf('/')
  if (slash <= 0) return null
  const project = value.slice(0, slash).trim()
  let ref = value.slice(slash + 1).trim()
  if (!projects.has(project) || ref === '') return null
  const colon = ref.indexOf(':')
  if (colon > 0) {
    const prefix = ref.slice(0, colon)
    if (prefix === 'feature') {
      const rest = ref.slice(colon + 1)
      const qualified = /^([A-Za-z0-9._-]+)::(.+)$/.exec(rest)
      if (qualified !== null && qualified[1] !== project) return null
      ref = (qualified !== null ? qualified[2] : rest).split('/')[0]
      if (!/^[A-Za-z0-9._-]+$/.test(ref)) return null
    } else if (!ANCHOR_KINDS.has(prefix) || ref.slice(colon + 1).trim() === '') {
      return null
    }
  } else if (!/^[A-Za-z0-9._-]+$/.test(ref)) {
    return null
  }
  return { address: `${project}/${ref}`, project }
}

/**
 * The answer's touchpoints between two in-scope projects that the Workspace
 * has not recorded. A suggestion whose two ends are already linked (either
 * way, any kind) is dropped; nothing here records anything.
 */
export function suggestConnections(parsed: readonly ParsedConnection[] | undefined, scope: AskResolvedScope): AskSuggestedConnection[] {
  if (parsed === undefined) return []
  const inScope = new Set(scope.projects.map((p) => p.slug))
  const recorded = new Set(scope.links.flatMap((link) => [`${link.from}\u0000${link.to}`, `${link.to}\u0000${link.from}`]))
  const out: AskSuggestedConnection[] = []
  for (const raw of parsed) {
    const kind = raw.kind.trim().toLowerCase() as AskConnectionKind
    if (!CONNECTION_KINDS.has(kind)) continue
    const from = normalizeEnd(raw.from, inScope)
    const to = normalizeEnd(raw.to, inScope)
    if (from === null || to === null || from.project === to.project) continue
    if (recorded.has(`${from.address}\u0000${to.address}`)) continue
    const id = `${from.address}|${kind}|${to.address}`
    if (out.some((c) => c.id === id)) continue
    const note = raw.note?.replace(/\s+/g, ' ').trim()
    out.push({
      id,
      kind,
      fromProject: from.project,
      from: from.address,
      toProject: to.project,
      to: to.address,
      ...(note ? { note } : {}),
    })
    if (out.length >= MAX_SUGGESTED_CONNECTIONS) break
  }
  return out
}

/** Names for a sentence: `a`, `a and b`, `a, b and c`. */
function namesOf(names: readonly string[]): string {
  if (names.length <= 1) return names.join('')
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}

/** Facts grouped by the local project whose checkout holds the cited file — the project each fact is about. */
async function factsByProject(
  facts: readonly ParsedFact[],
  roots: AskSourceRoots,
  fileExists: AskDeps['fileExists'],
): Promise<Map<string, ParsedFact[]>> {
  const byRoot = new Map<string, ParsedFact[]>()
  for (const fact of facts.slice(0, MAX_FACTS)) {
    const located = await locateFile(roots, fact.file, fact.project, fileExists)
    if (located === null) continue
    const list = byRoot.get(located.rootPath) ?? []
    list.push({ text: fact.text, file: located.rel, ...(fact.symbol !== undefined ? { symbol: fact.symbol } : {}) })
    byRoot.set(located.rootPath, list)
  }
  return byRoot
}

async function runAskUnguarded(input: AskRunInput, deps: AskDeps): Promise<AskResult> {
  const scope = input.scope
  const roots = scope !== undefined ? sessionRootsOf(scope, input.rootId) : null
  // The project ask's one root; a Workspace ask's session cwd.
  const rootPath = roots !== null ? roots.cwd : input.rootId
  const sourceRoots: string | AskSourceRoots =
    scope !== undefined ? { projects: scope.projects, cwdProject: roots?.cwdProject ?? null } : rootPath
  const emit = createEmitter(input, deps.emit)
  const digMaxReads = deps.limits?.digMaxReads ?? (scope !== undefined ? ASK_WORKSPACE_DIG_MAX_READS : ASK_DIG_MAX_READS)
  const digMaxMs = deps.limits?.digMaxMs ?? (scope !== undefined ? ASK_WORKSPACE_DIG_MAX_MS : ASK_DIG_MAX_MS)
  const fastMaxMs = deps.limits?.fastMaxMs ?? ASK_FAST_MAX_MS
  // A Workspace session always passes its roots: present = every read contained to them (NFR-3).
  const readRoots = roots !== null ? { readRoots: roots.readRoots } : {}
  const fail = (sentence: string, answer: AskAnswer | null): AskResult => {
    emit({ kind: 'error', sentence }, answer)
    return { askId: input.askId, outcome: 'error', answer, error: sentence }
  }

  emit({ kind: 'fast' }, null)
  const routing = deps.routing()
  const authEnv = await deps.authEnv(rootPath).catch(() => undefined)
  const context = await deps.gatherContext({
    rootPath: scope !== undefined ? input.rootId : rootPath,
    question: input.question,
    tags: input.tags,
    conversationIds: input.conversationIds,
    ...(scope !== undefined ? { workspace: scope } : {}),
  })
  const branchInProgress = branchSentence(context.threads)
  const known = new Set(context.knownIds)
  // Tags the Blueprint does not know would make the save refuse; an empty
  // known set means no graph could be read, and the writer checks grammar only.
  const tags =
    scope !== undefined
      ? workspaceTags(input.tags, scope, known)
      : known.size === 0
        ? input.tags
        : input.tags.filter((tag) => known.has(tag))
  const knowledgeOnly = scope !== undefined ? scope.projects.filter((p) => p.rootPath === null).map((p) => p.slug) : []
  const extra: Partial<AskAnswer> = {
    ...(branchInProgress !== undefined ? { branchInProgress } : {}),
    ...(scope !== undefined ? { projectsRead: [], knowledgeOnly } : {}),
  }
  const withConnections = (answer: AskAnswer, parsed: ParsedReturn): AskAnswer => {
    if (scope === undefined) return answer
    const suggested = suggestConnections(parsed.connections, scope)
    return suggested.length > 0 ? { ...answer, suggestedConnections: suggested } : answer
  }

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
          ...readRoots,
        },
        fastAbort.signal,
      )
  clearTimeout(fastTimer)
  input.stopSignal.removeEventListener('abort', onStop)
  const fast = parseAskReturn(fastRaw)
  let best: AskAnswer | null = null
  if (fast !== null) {
    const sources = await resolveSources(sourceRoots, fast.sources, context.knownIds, deps.fileExists)
    best = withConnections(toAnswer(fast, sources, 'first', fast.thin, extra), fast)
  }

  // ── 2. Dig, only when knowledge is thin (and some code is on this computer) ──
  let digResult: ParsedReturn | null = null
  let digEndedEarly: 'stopped' | 'budget' | null = null
  const readsByProject = new Map<string, number>()
  const canDig = roots === null || roots.cwdProject !== null
  const needDig = !input.stopSignal.aborted && (fast === null || fast.thin) && canDig
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
        prompt: buildDigPrompt(input.question, input.tags, context, fast, digMaxReads, roots?.folders ?? []),
        model: resolveAutoModel('medium', routing),
        maxTurns: DIG_MAX_TURNS,
        abortSignal: digAbort.signal,
        ...(authEnv !== undefined ? { authEnv } : {}),
        ...readRoots,
        onRead: (filePath) => {
          if (digAbort.signal.aborted) return
          reads += 1
          if (typeof sourceRoots === 'string') {
            const rel = repoRelative(rootPath, filePath) ?? filePath
            addStep(`Read ${rel}`)
          } else {
            const [where] = locateFileCandidates(sourceRoots, filePath)
            if (where !== undefined) readsByProject.set(where.project, (readsByProject.get(where.project) ?? 0) + 1)
            addStep(`Read ${where !== undefined ? `${where.project}/${where.rel}` : filePath}`)
          }
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
    const projectsRead = scope !== undefined ? scope.projects.filter((p) => (readsByProject.get(p.slug) ?? 0) > 0).map((p) => p.slug) : null
    const readExtra: Partial<AskAnswer> = projectsRead !== null ? { projectsRead } : {}
    if (digResult !== null) {
      const sources = await resolveSources(sourceRoots, digResult.sources, context.knownIds, deps.fileExists)
      best = withConnections(
        toAnswer(digResult, sources, 'checked', false, { ...extra, ...readExtra, partial: digEndedEarly !== null }),
        digResult,
      )
    } else if (best !== null && digEndedEarly !== null) {
      best = {
        ...best,
        ...readExtra,
        partial: true,
        couldNotFind: best.couldNotFind ?? (digEndedEarly === 'budget' ? BUDGET_SENTENCE : STOPPED_SENTENCE),
      }
    } else if (best !== null) {
      best = { ...best, ...readExtra }
    }
  } else if (best !== null && fast !== null && fast.thin && input.stopSignal.aborted) {
    // Stopped before the dig the thin first answer called for could start.
    best = { ...best, partial: true, couldNotFind: best.couldNotFind ?? STOPPED_SENTENCE }
  } else if (best !== null && fast !== null && fast.thin && !canDig) {
    // A Workspace ask with no in-scope project on this computer: knowledge is all there is.
    best = { ...best, couldNotFind: best.couldNotFind ?? NO_CODE_HERE_SENTENCE }
  }

  if (best === null) {
    if (input.stopSignal.aborted) {
      emit({ kind: 'partial' }, null)
      return { askId: input.askId, outcome: 'partial', answer: null }
    }
    return fail(NO_ANSWER_SENTENCE, null)
  }

  // A partial Workspace answer names the projects whose code was not read.
  if (scope !== undefined && best.partial) {
    const read = new Set(best.projectsRead ?? [])
    const notRead = scope.projects.filter((p) => !read.has(p.slug)).map((p) => p.name)
    if (notRead.length > 0) {
      const sentence = `Code not read in ${namesOf(notRead)}.`
      best = { ...best, couldNotFind: best.couldNotFind !== undefined ? `${best.couldNotFind} ${sentence}` : sentence }
    }
  }

  // ── 3. Facts (dig only; never from unmerged work), each into its own project ──
  if (digResult !== null && digResult.facts.length > 0) {
    const unmerged = context.threads.filter((t) => t.branch !== null && t.merged === false).map((t) => t.branch)
    const unmergedAt = async (root: string): Promise<boolean> => {
      if (unmerged.length === 0) return false
      const here = await currentBranch(deps, root)
      return here !== null && unmerged.includes(here)
    }
    if (typeof sourceRoots === 'string') {
      if (!(await unmergedAt(rootPath))) {
        const { learned, saved } = await writeFacts(deps, rootPath, digResult.facts)
        best = { ...best, factsLearned: learned, factsSaved: saved }
      }
    } else {
      let learned = 0
      let saved = true
      let wrote = false
      for (const [root, facts] of await factsByProject(digResult.facts, sourceRoots, deps.fileExists)) {
        if (await unmergedAt(root)) continue
        const result = await writeFacts(deps, root, facts)
        wrote = true
        learned += result.learned
        saved = saved && result.saved
      }
      if (wrote) best = { ...best, factsLearned: learned, factsSaved: saved }
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

/**
 * One recorded note as the prompt carries it. A draft is labelled with its
 * branch — "Work in progress on <branch>: … Not merged yet, so this may
 * change." — so the answer that quotes it says so (FR-9).
 */
export function askNoteLine(note: AskNote): string {
  const project = note.project !== undefined ? `[${note.project}] ` : ''
  const text = note.text.split('\n')[0]
  const anchors = ` (${note.anchors.slice(0, 3).join(', ')})`
  if (note.status !== 'draft') return `- ${project}${text}${anchors}`
  const branch = note.branch ?? 'another branch'
  return `- ${project}Work in progress on ${branch}: ${text} Not merged yet, so this may change.${anchors}`
}
