// Learn orchestrator (progressive-learning #513 phase 6) — the SINGLE code
// path every learn trigger funnels through.
//
// Every way a module gets learned — the onboarding basic-discovery sync, the
// board's "Learn" button, and the auto triggers wired later (Phase 8/9) — ends
// up calling one of two entry points on ONE orchestrator instance:
//
//   • enqueueBasicDiscovery(rootPath) — enqueue every depth-1 module from the
//     graph that isn't already learned-fresh (deliberate items — a user asked
//     to learn the whole project, so they run regardless of the session budget).
//   • enqueueModule(rootPath, modulePath, { reason, deliberate? }) — enqueue one
//     module. The Learn button passes deliberate:true; auto triggers pass
//     deliberate:false, so the session budget can drop them once it's spent.
//
// A serial queue (concurrency 1) drains those jobs one at a time through the
// learn-session executor (runLearnPass). Each job:
//   1. transitions the module's learning-state to 'learning' (dot pulses),
//   2. enumerates + ranks its source files, picks a cheap model by payload size,
//   3. resolves a supersede request from any active investigation note (re-learn),
//   4. runs the caged read-only session + writes (the executor does the writes),
//   5. transitions to 'learned' on success, or 'stale' + a one-line toast on
//      failure.
//
// The DECISION CORE — queue state, dedupe, budget admission, supersede
// resolution, module selection, model choice — is PURE and exhaustively unit
// tested (no fs, no sqlite, no Electron). The orchestrator class holds only the
// effects (fs writes, the executor, toasts, abort controllers), all injected so
// the class is testable against fakes. This mirrors allowed-pattern #14 (the
// invariant lives in one code path, not prompt convention) and the learn-events
// / provisioner idioms (main-side, plain-Node loadable).

import { promises as fsPromises, type Dirent } from 'node:fs'
import { recordLearnEvent } from './learn-log'
import { recordSlow } from '../ipc/slow-handler'
import { join, relative } from 'node:path'

import type {
  BlueprintGraph,
  BlueprintInvestigation,
  BlueprintLearningEntry,
  BlueprintLearningStatus,
  EffortLevel,
  FlowNotification,
} from '../../shared/ipc-contract'
import { isIgnoredModule } from '../../shared/learn-ignore'
import { isCandidateDir, isSourceFileName } from '../blueprint/basic-derive'
import type { BundledCli } from '../blueprint/derive-runner'
import {
  DEFAULT_RANK_CAPS,
  isClaimFilePath,
  loadFeatureRoster,
  moduleSlug,
  rankModuleFiles,
  runLearnPass,
  type FeatureRosterEntry,
  type LearnPassParams,
  type LearnPassResult,
  type ModuleFile,
  runBundledCliCapturing,
} from '../agent/learn-session'
import { mutateLearningState, type MutateLearningState } from './learning-state'
import {
  resolveAutoModel,
  type ModelRouting,
  type RoutableModel,
} from '../../shared/model-routing'

// ════════════════════════════════════════════════════════════════════════
// PURE DECISION CORE (no fs / no sqlite / no Electron — exhaustively tested)
// ════════════════════════════════════════════════════════════════════════

/** One queued/running learn request. `deliberate` items ignore the budget. */
export interface LearnJob {
  /** Repo root (absolute) — the executor cwd and learning-state base. */
  rootPath: string
  /** Module path relative to the root — the anchor + doc identity. */
  modulePath: string
  /** Human-readable origin ('basic-discovery' | 'manual' | 'stale' | …). */
  reason: string
  /** Deliberate (user-initiated) items always run; auto items obey the budget. */
  deliberate: boolean
}

/** Dedupe key for a (root, module) pair — NUL-joined so neither half can spoof
 *  a boundary. Queued + active jobs are keyed here so a duplicate is a no-op. */
export function jobKey(rootPath: string, modulePath: string): string {
  return `${rootPath}\x00${modulePath}`
}

/** The serial queue's whole state — a plain value the pure functions fold. */
export interface LearnQueueState {
  /** FIFO of not-yet-running jobs. */
  queued: LearnJob[]
  /** The single in-flight job, or null when idle. */
  active: LearnJob | null
  /** Dedupe set of jobKeys for queued + active jobs. */
  keys: ReadonlySet<string>
  /** Count of jobs that have STARTED this session (deliberate + auto). */
  runsThisSession: number
}

/** A fresh, empty queue. */
export function initialQueueState(): LearnQueueState {
  return { queued: [], active: null, keys: new Set(), runsThisSession: 0 }
}

/** Result of an enqueue: the next state and whether the job was admitted (a
 *  duplicate of a queued/active (root, module) is NOT admitted). */
export interface EnqueueResult {
  state: LearnQueueState
  admitted: boolean
}

/** Admit a job unless an identical (root, module) is already queued/running. */
export function enqueueJob(state: LearnQueueState, job: LearnJob): EnqueueResult {
  const key = jobKey(job.rootPath, job.modulePath)
  if (state.keys.has(key)) {
    return { state, admitted: false }
  }
  const keys = new Set(state.keys)
  keys.add(key)
  return {
    state: { ...state, queued: [...state.queued, job], keys },
    admitted: true,
  }
}

/** Outcome of taking the next job off the queue. */
export type TakeNextResult =
  | { kind: 'run'; job: LearnJob; state: LearnQueueState }
  | { kind: 'dropped'; job: LearnJob; state: LearnQueueState }
  | { kind: 'empty'; state: LearnQueueState }

/**
 * Pop the head job and classify it against the budget: deliberate jobs (and
 * auto jobs while `runsThisSession < budget`) become `run` (active set,
 * runsThisSession incremented); an auto job past the budget becomes `dropped`
 * (removed from the queue, key freed, NOT run). An empty queue yields `empty`.
 */
export function takeNext(state: LearnQueueState, budget: number, pausedRoots: ReadonlySet<string> = new Set()): TakeNextResult {
  // A PAUSED PROJECT'S WORK WAITS IN PLACE (user, 2026-10-06: learning per
  // project). The next job is the first one whose project is not paused; the
  // paused ones keep their places for when that project resumes.
  const index = state.queued.findIndex((candidate) => !pausedRoots.has(candidate.rootPath))
  if (index === -1) {
    return { kind: 'empty', state }
  }
  const job = state.queued[index] as LearnJob
  const rest = [...state.queued.slice(0, index), ...state.queued.slice(index + 1)]
  const withinBudget = state.runsThisSession < budget
  if (job.deliberate || withinBudget) {
    return {
      kind: 'run',
      job,
      state: {
        ...state,
        queued: rest,
        active: job,
        runsThisSession: state.runsThisSession + 1,
      },
    }
  }
  const keys = new Set(state.keys)
  keys.delete(jobKey(job.rootPath, job.modulePath))
  return { kind: 'dropped', job, state: { ...state, queued: rest, keys } }
}

/** Clear the active job (its run finished) and free its dedupe key. */
export function completeActive(state: LearnQueueState): LearnQueueState {
  if (state.active === null) {
    return state
  }
  const keys = new Set(state.keys)
  keys.delete(jobKey(state.active.rootPath, state.active.modulePath))
  return { ...state, active: null, keys }
}

/** Result of aborting a root: next state + whether the ACTIVE job belonged to
 *  it (the class then aborts that job's controller). */
export interface AbortRootResult {
  state: LearnQueueState
  abortedActive: boolean
}

/**
 * Drop every queued job for `rootPath` and, if the active job belongs to it,
 * clear it too (signalling the class to abort the in-flight session). Jobs for
 * other roots are untouched. Used on project switch / root removal / quit.
 */
export function abortRootJobs(state: LearnQueueState, rootPath: string): AbortRootResult {
  const keys = new Set(state.keys)
  const keptQueued: LearnJob[] = []
  for (const job of state.queued) {
    if (job.rootPath === rootPath) {
      keys.delete(jobKey(job.rootPath, job.modulePath))
    } else {
      keptQueued.push(job)
    }
  }
  let active = state.active
  let abortedActive = false
  if (active !== null && active.rootPath === rootPath) {
    keys.delete(jobKey(active.rootPath, active.modulePath))
    active = null
    abortedActive = true
  }
  return { state: { ...state, queued: keptQueued, active, keys }, abortedActive }
}

/** A supersede request for a re-learn: the prior note's fingerprint + a reason. */
export interface SupersedeRequest {
  fingerprint: string
  reason: string
}

/**
 * Resolve a supersede request for a re-learn from the active investigation
 * notes: if a note is anchored to this module (`module` appears in its
 * anchorRefs), the fresh note supersedes it. Returns undefined when no active
 * note names the module — the first learn appends rather than supersedes.
 */
/**
 * Integrity reconcile (orbit-app 2026-07-21): a module whose learning-state
 * says `learned` but which has NO investigation note is unverifiable — the
 * note's hash stamps are the ONLY thing `blueprint stale-check` re-hashes, so
 * a note-less "learned" can never go stale and reads 100%-fresh forever (seen
 * live after a flow/ vault re-provision preserved learning-state.jsonl — the
 * app rewrites it — but dropped the append-only investigations.jsonl). Flip
 * those entries to `stale` so the amber dot tells the truth and a re-learn
 * regenerates the doc + stamped note. An absent/unreadable notes store counts
 * as note-less: flipping to stale is honest and recoverable (re-learn heals),
 * while trusting it silently is the permanent-100% illusion. Pure.
 */
export function reconcileNoteless(
  entries: readonly BlueprintLearningEntry[],
  investigations: readonly BlueprintInvestigation[] | undefined,
  nowIso: string,
  truncated = false,
): { entries: BlueprintLearningEntry[]; changed: boolean } {
  // ABSENCE FROM A CAPPED LIST IS NOT ABSENCE. `investigations` is a display
  // projection capped at INVESTIGATIONS_CAP; on a mature project most notes
  // are simply not in it. Concluding "note-less" from that slice flipped 24 of
  // 25 learned modules on orbit-app to `stale` — every single one of which
  // HAD a note — and it re-ran on every launch, so everything the user learned
  // went amber again the next time they opened the app.
  //
  // This pass exists to catch a genuinely note-less `learned` entry (a vault
  // re-provision that dropped investigations.jsonl). That is a real state, but
  // it can only be diagnosed from a COMPLETE list. Truncated ⇒ do nothing:
  // leaving a stale-but-fresh-looking entry is recoverable; destroying correct
  // learning state on every start is not.
  if (truncated) {
    return { entries: [...entries], changed: false }
  }
  const notes = investigations ?? []
  let changed = false
  const reconciled = entries.map((entry) => {
    if (entry.status !== 'learned') return entry
    const hasNote = notes.some((note) => noteBelongsToModule(note, entry.module))
    if (hasNote) return entry
    changed = true
    return { ...entry, status: 'stale' as const, notedAt: nowIso }
  })
  return { entries: reconciled, changed }
}

/**
 * Whether an active investigation note is THIS module's learn note.
 *
 * Two ways to match, both needed:
 *  1. The identity anchor's REF. Notes store refs with the kind stripped, so a
 *     learn target that is already a node id (`endpoint:GET /api/x`) is
 *     anchored under the bare ref (`GET /api/x`) — comparing the raw module
 *     path would never match for non-module nodes.
 *  2. The module doc the note links. Notes written before the identity-anchor
 *     fix (2026-07-30) carry only decorative anchors, so the doc path in the
 *     note text is the only remaining handle on them — without it those
 *     orphans stay active forever and the module can never be re-learned.
 *     `fingerprint` is `<text>+<refs>`, so it contains the note's `Doc:` line.
 */
function noteBelongsToModule(note: BlueprintInvestigation, modulePath: string): boolean {
  const identityRef = modulePath.replace(/^(?:module|endpoint|table|file|symbol):/, '')
  if (note.anchorRefs.includes(identityRef)) {
    return true
  }
  return note.fingerprint.includes(`Doc: flow/brain/modules/${moduleSlug(modulePath)}.md`)
}

export function resolveSupersede(
  investigations: readonly BlueprintInvestigation[] | undefined,
  modulePath: string,
): SupersedeRequest | undefined {
  if (!investigations) {
    return undefined
  }
  const prior = investigations.find((note) => noteBelongsToModule(note, modulePath))
  if (!prior) {
    return undefined
  }
  return { fingerprint: prior.fingerprint, reason: `re-learned ${modulePath}` }
}

/** Shape of `blueprint notes --json` — only the fields the resolver needs. */
interface NotesVerbPayload {
  notes?: Array<{ fingerprint?: unknown; text?: unknown }>
}

/**
 * Resolve a re-learn's supersede pointer by ASKING THE CLI which note is active
 * on this anchor.
 *
 * The previous implementation (`resolveSupersede`, kept above for the pure
 * unit tests that cover its matching rules) scanned the snapshot's
 * investigation projection. That projection is capped at a DISPLAY limit, so on
 * a mature project the note it needed was simply not in the list: orbit-app
 * carries 362 active notes and the one blocking `e2e/tests/chats` sat at index
 * 356. No fingerprint resolved, no `--supersedes` was passed, `blueprint
 * observe` refused under its contradiction rule, and every re-learn failed.
 *
 * A cap is a rendering decision. It must never be an input to a correctness
 * one — so the question goes to the store's owner, which answers against the
 * whole file (allowed-pattern #14).
 *
 * Fail-soft: any spawn/parse failure yields `undefined`, which means "no
 * supersede pointer". That is the same state as a first-ever learn — observe
 * will refuse if a note really does exist, and the refusal now says so
 * legibly. Never throws.
 */
export async function resolveSupersedeViaCli(
  runCli: (args: readonly string[]) => Promise<{ ok: boolean; stdout: string }>,
  modulePath: string,
): Promise<SupersedeRequest | undefined> {
  // Anchors carry the kind stripped, exactly as observe stores them.
  const ref = modulePath.replace(/^(?:module|endpoint|table|file|symbol):/, '')
  let result: { ok: boolean; stdout: string }
  try {
    result = await runCli(['blueprint', 'notes', '--anchor', `module:${ref}`, '--json'])
  } catch {
    return undefined
  }
  if (!result.ok) {
    return undefined
  }
  let payload: NotesVerbPayload
  try {
    payload = JSON.parse(result.stdout.trim()) as NotesVerbPayload
  } catch {
    return undefined
  }
  const notes = Array.isArray(payload.notes) ? payload.notes : []
  // Prefer THIS module's learn note when several notes share the anchor — the
  // doc path is the note's own handle (see noteBelongsToModule).
  const docMarker = `Doc: flow/brain/modules/${moduleSlug(modulePath)}.md`
  const own = notes.find(
    (note) => typeof note.text === 'string' && note.text.includes(docMarker),
  )
  const chosen = own ?? notes[0]
  if (chosen === undefined || typeof chosen.fingerprint !== 'string') {
    return undefined
  }
  return { fingerprint: chosen.fingerprint, reason: `re-learned ${modulePath}` }
}

/**
 * The depth-1 module paths from a derived graph — folder-spine module nodes at
 * tree depth 1 (top-level source dirs). The node's `sourceFile` IS the module
 * path/dir (see the modules extractor / basic-derive). Sorted + de-duplicated
 * for deterministic enqueue order. A null/empty graph yields [].
 */
export function selectDepthOneModules(graph: BlueprintGraph | null): string[] {
  if (graph === null) {
    return []
  }
  const paths = new Set<string>()
  for (const node of graph.nodes) {
    if (node.kind === 'module' && node.meta?.depth === 1) {
      paths.add(node.sourceFile)
    }
  }
  return [...paths].sort((a, b) => a.localeCompare(b))
}

/**
 * EVERY module path in the graph, any depth — for the staleness watcher's
 * file→module mapping. `mapFileToModule` is longest-prefix, so with the full
 * list a file under `src/app` attributes to `src/app` (the module onboarding
 * now learns, #learn-ignore round 2) instead of collapsing to depth-1 `src` —
 * without this, depth-2 learned modules were never stale-checked by file churn.
 */
export function selectAllModulePaths(graph: BlueprintGraph | null): string[] {
  if (graph === null) {
    return []
  }
  const paths = new Set<string>()
  for (const node of graph.nodes) {
    if (node.kind === 'module' && typeof node.sourceFile === 'string' && node.sourceFile.length > 0) {
      paths.add(node.sourceFile)
    }
  }
  return [...paths].sort((a, b) => a.localeCompare(b))
}

/** What T1 onboarding should learn (`modules`) and what it skipped as
 *  scaffolding (`skipped`) — both sorted + deduped for determinism. */
export interface OnboardingSelection {
  modules: string[]
  skipped: string[]
}

/**
 * The modules T1 onboarding (basic discovery) should learn — "learn the basics
 * of the things, not the root folders" (#learn-ignore round 2). Root folders
 * don't tell the project's story: a depth-1 `src` with 17 child modules learned
 * as ONE blob explains nothing, while `.cursor`/`.github` scaffolding explains
 * less. Selection rules, per depth-1 module node (same node source as
 * selectDepthOneModules — `kind === 'module'` + `meta.depth`):
 *  - ignored depth-1 (defaults + dot-dirs + extras) → skipped, WHOLE subtree
 *    excluded (its children are never selected);
 *  - depth-1 with depth-2 child modules (sourceFile path-prefix children) →
 *    the NON-ignored children are selected instead of the parent; ignored
 *    children go to `skipped`;
 *  - depth-1 with no children → the module itself.
 * Never descends past depth 2 — deeper modules roll up into their depth-2
 * parent exactly as before. `skipped` is every ignored module encountered
 * (an ignored parent stands for its subtree). Pure, deterministic.
 */
export function selectOnboardingModules(
  graph: BlueprintGraph | null,
  ignoreExtras: readonly string[] = [],
): OnboardingSelection {
  if (graph === null) {
    return { modules: [], skipped: [] }
  }
  const depthOne = new Set<string>()
  const depthTwo = new Set<string>()
  for (const node of graph.nodes) {
    if (node.kind !== 'module') continue
    if (node.meta?.depth === 1) depthOne.add(node.sourceFile)
    else if (node.meta?.depth === 2) depthTwo.add(node.sourceFile)
  }
  const modules = new Set<string>()
  const skipped = new Set<string>()
  for (const parent of depthOne) {
    if (isIgnoredModule(parent, ignoreExtras)) {
      skipped.add(parent) // Whole subtree skipped — children never considered.
      continue
    }
    const children = [...depthTwo].filter((child) => child.startsWith(`${parent}/`))
    if (children.length === 0) {
      modules.add(parent)
      continue
    }
    for (const child of children) {
      if (isIgnoredModule(child, ignoreExtras)) {
        skipped.add(child)
      } else {
        modules.add(child)
      }
    }
  }
  return {
    modules: [...modules].sort((a, b) => a.localeCompare(b)),
    skipped: [...skipped].sort((a, b) => a.localeCompare(b)),
  }
}

/**
 * Filter out modules that are ALREADY learned-fresh (their latest
 * learning-state status is 'learned'). Modules that are absent, 'learning', or
 * 'stale' are kept — the basic-discovery sync (re)learns them.
 */
/**
 * How many features `blueprint features confirm --all` actually created, from
 * its one report line (`features: confirmed 3 candidate(s)`).
 *
 * Returns 0 for a refusal, a dry run ("would confirm"), or any line shape it
 * does not recognise — an unparsed line must never be reported to the user as
 * features that appeared. Matched anchored to the `confirmed` verb precisely so
 * "would confirm 3" cannot be read as three real features.
 */
/**
 * The CLI's own first line of output, or null when it said nothing.
 *
 * Refusals are one line by contract (`features refused: <reason>`), and that
 * line is the finding — quoted verbatim rather than re-phrased, so the reader
 * sees what the tool actually said.
 */
export function firstLine(stdout: string): string | null {
  const line = stdout.split('\n').find((candidate) => candidate.trim().length > 0)
  return line === undefined ? null : line.trim()
}

export function parseConfirmedCount(stdout: string): number {
  const match = /features:\s+confirmed\s+(\d+)\s+candidate/.exec(stdout)
  if (match === null) return 0
  const count = Number.parseInt(match[1] ?? '', 10)
  return Number.isFinite(count) ? count : 0
}

export function filterUnlearned(
  modulePaths: readonly string[],
  learning: readonly BlueprintLearningEntry[] | undefined,
): string[] {
  const fresh = new Set(
    (learning ?? []).filter((entry) => entry.status === 'learned').map((entry) => entry.module),
  )
  return modulePaths.filter((path) => !fresh.has(path))
}

/** Total byte payload of a set of module files — drives the model choice. */
export function totalPayloadBytes(files: readonly ModuleFile[]): number {
  return files.reduce((sum, file) => sum + file.size, 0)
}

/** Payload over this size routes to the standard tier (sonnet) instead of fast
 *  (haiku) — a large module needs the stronger model to summarize well. */
export const LARGE_PAYLOAD_BYTES = 32 * 1024

/**
 * Pick the cheap-tier model for a learn pass via the shared model-routing
 * supplier: small payloads route through 'low' effort (haiku by default), large
 * payloads through 'medium' (sonnet). Honors a user-customized routing map.
 */
export function pickLearnModel(
  payloadBytes: number,
  routing?: Partial<ModelRouting> | null,
): RoutableModel {
  const effort: EffortLevel = payloadBytes > LARGE_PAYLOAD_BYTES ? 'medium' : 'low'
  return resolveAutoModel(effort, routing)
}

// ════════════════════════════════════════════════════════════════════════
// EFFECTS — the orchestrator class (all seams injected)
// ════════════════════════════════════════════════════════════════════════

/** The project state the orchestrator reads per root before a learn pass. */
export interface LearnProjectState {
  /** Derived graph (disk graph, or a basic fallback) — source of depth-1 modules. */
  graph: BlueprintGraph | null
  /** Deduped learning-state entries — used to skip learned-fresh modules. */
  learning: readonly BlueprintLearningEntry[] | undefined
  /** Active investigation notes — used to resolve a re-learn supersede. */
  investigations: readonly BlueprintInvestigation[] | undefined
  /**
   * True when `investigations` is a CAPPED slice of a larger store. Absence of
   * a note in a truncated list proves nothing (see `reconcileNoteless`).
   */
  investigationsTruncated?: boolean
  /**
   * False when `graph` is an in-memory fallback because the project has NO
   * derived graph on disk. The store a learn pass writes its note into
   * refuses every note until a graph exists, so a sweep over a fallback graph
   * spends an agent session per module and fails each one at the end.
   * Omitted = unknown, treated as derived.
   */
  graphDerived?: boolean
}

/** A module's enumerated files, split by trust tier (trust-tiers Phase 3). */
export interface ModuleFileEntries {
  /** Source files — ranked + read by the learn pass (ground truth). */
  files: ModuleFile[]
  /** Claim-tier docs/images — offered to the pass for adjudication. */
  claimFiles: ModuleFile[]
}

/** Options for enqueueing a single module. */
export interface EnqueueModuleOptions {
  /** Origin label recorded on the job (e.g. 'manual', 'stale'). */
  reason: string
  /** Deliberate items always run; omit/false → subject to the session budget. */
  deliberate?: boolean
}

/**
 * How ONE project's basic discovery ended, as `runBasicDiscovery` reports it —
 * the answer the basic-discovery coordinator (learn/basic-discovery.ts) turns
 * into "this project has its basic discovery" or a retry.
 *
 *   · `done`      — every selected module reached an end and at least one was
 *                   learned, or there was nothing to learn (`learned` 0,
 *                   `failed` 0: an empty or scaffolding-only project, or one
 *                   whose modules were all learned already).
 *   · `failed`    — nothing was learned: every module failed, the project's
 *                   structure could not be read, or the run paused itself after
 *                   failures in a row. `reason` is a plain sentence.
 *   · `not-ready` — the project is still being set up; nothing was enqueued.
 *   · `cancelled` — the project's learning was stopped (removed, Stop, quit).
 */
export type BasicDiscoveryRunOutcome =
  | { kind: 'done'; learned: number; failed: number }
  | { kind: 'failed'; reason: string }
  | { kind: 'not-ready' }
  | { kind: 'cancelled' }

/** One project's basic discovery in flight — see runBasicDiscovery. */
interface BasicDiscoveryTracker {
  /** Modules of this run not finished yet. */
  pending: Set<string>
  learned: number
  failed: number
  /** Modules that were stopped rather than judged (an abort, a root that went unready). */
  stopped: number
  /** When the run began (epoch ms, injected clock) — the stall watchdog's floor. */
  startedAt: number
  promise: Promise<BasicDiscoveryRunOutcome>
  resolve: (outcome: BasicDiscoveryRunOutcome) => void
}

/** What starting a basic discovery did (internal). */
type BasicDiscoveryStart =
  | { kind: 'enqueued'; modules: string[] }
  | { kind: 'settled'; outcome: BasicDiscoveryRunOutcome }

/** Injectable seams for the orchestrator — every effect is a dependency. */
/**
 * How long one learn pass may run before it is stopped.
 *
 * Generous on purpose — a pass is an agent session reading a module — but
 * finite, because the alternative was measured: ten minutes on one 20 KB file
 * with 350 modules waiting behind it.
 */
const PASS_TIMEOUT_MS = 10 * 60_000

/**
 * How long a pass may produce NO sign of life before it is treated as gone.
 *
 * A working pass reads, greps, thinks and writes, and every one of those now
 * reports. Three minutes of complete silence is not slow work; it is a session
 * that will not come back, and the queue behind it is real.
 */
const PASS_SILENCE_MS = 3 * 60_000

/** How many failures in a row stop a run — see recordOutcome. */
const CONSECUTIVE_FAILURE_LIMIT = 3

/**
 * How long a basic discovery may wait with the learn queue NOT MOVING — no
 * pass started or ended anywhere — before it is reported as failed.
 *
 * Longer than one pass may take (PASS_TIMEOUT_MS), so a slow module is never
 * mistaken for a stall: when this trips, something is holding the queue that
 * will not let go, and a person is owed "it didn't work, Try again" rather than
 * "Learning…" for good (live, 2026-10-06).
 */
export const BASIC_DISCOVERY_STALL_MS = 20 * 60_000

/**
 * The same limit while learning stands aside for a person's own agent turn
 * (setYielding). That wait is deliberate and a turn can run for an hour, so it
 * gets far longer — but still finite: a turn whose end was never reported
 * must not hold a sweep for ever.
 */
export const BASIC_DISCOVERY_YIELD_STALL_MS = 3 * 60 * 60_000

/** How often the stall watchdog looks (only while a basic discovery is pending). */
const BASIC_DISCOVERY_STALL_CHECK_MS = 60_000

/** The sentences a stopped basic discovery ends with (shown in a thread — no paths, no settings). */
const STALLED_REASON = 'Learning stopped making progress.'
const PAUSED_AFTER_FAILURES_REASON = 'Learning paused itself after several parts in a row could not be learned.'
const PAUSED_BY_PERSON_REASON = 'Learning is paused.'
const NO_GRAPH_REASON = "Flow couldn't map this project's structure, so there was nothing to learn from."


/**
 * A basic discovery CLAIMS its modules' queued jobs, whoever queued them:
 *
 *   · each becomes deliberate — a job an automatic re-learn queued first must
 *     not be dropped for budget underneath the run counting on it;
 *   · they move to the FRONT of the queue, in their order — the sweep is what
 *     a person is waiting on (one project at a time), and it must not wait
 *     behind another project's left-over queue. Live, 2026-10-06: a sweep sat
 *     behind sixty resumed jobs of three other projects, and one of those
 *     projects failing three in a row paused everything before it got a turn.
 *
 * The active job is untouched. Pure.
 */
export function claimQueuedJobs(
  state: LearnQueueState,
  rootPath: string,
  modules: readonly string[],
): LearnQueueState {
  const wanted = new Set(modules)
  const claimed: LearnJob[] = []
  const rest: LearnJob[] = []
  for (const job of state.queued) {
    if (job.rootPath === rootPath && wanted.has(job.modulePath)) {
      claimed.push(job.deliberate ? job : { ...job, deliberate: true })
    } else {
      rest.push(job)
    }
  }
  if (claimed.length === 0) return state
  return { ...state, queued: [...claimed, ...rest] }
}

/** How long a root's feature roster stays good — see loadRoster. */
const ROSTER_TTL_MS = 60_000

export interface LearnOrchestratorDeps {
  /** Read the graph / learning / investigations for a root (observer-backed). */
  readProjectState: (rootPath: string) => Promise<LearnProjectState>
  /** True when a root is provisioned + ready to learn (refuse otherwise). */
  isRootReady: (rootPath: string) => boolean
  /** The app-embedded planflow-ai CLI, passed through to the executor. */
  bundledCli: BundledCli
  /** Surface a one-line failure toast to every window. */
  notify: (notification: FlowNotification) => void
  /**
   * Basic discovery's FEATURE-GENERATION step settled (`learn:featuresDiscovered`).
   *
   * Called on EVERY exit of that step, including the ones that produce no
   * toast: an unready root, a CLI refusal, a repo that names no capability.
   * The blueprint board shows a running indicator from the moment its "Run
   * basic discovery" button is pressed until it hears this — a branch that
   * stays silent leaves that indicator spinning forever, which is the same
   * class of bug as the dead button it replaced.
   */
  onFeaturesDiscovered?: (event: { rootPath: string; added: number; reason: string | null }) => void
  /** Runs one learn pass. Default: runLearnPass (the real executor). */
  runPass?: (params: LearnPassParams) => Promise<LearnPassResult>
  /** Run the bundled CLI and capture stdout. Default: runBundledCliCapturing.
   *  Used to ask the store which note is active on an anchor — the question a
   *  capped snapshot projection could not answer (see resolveSupersedeViaCli). */
  runCli?: (cwd: string, args: readonly string[]) => Promise<{ ok: boolean; stdout: string }>
  /** Enumerate a module's ranked-able source files. Default: fs walk under the module dir.
   *  Back-compat seam — injecting this (without enumerateModuleEntries) yields no claim files. */
  enumerateModuleFiles?: (rootPath: string, modulePath: string) => Promise<ModuleFile[]>
  /** Enumerate a module's source + claim files in one pass. Default: fs walk
   *  under the module dir. Takes precedence over enumerateModuleFiles. */
  enumerateModuleEntries?: (rootPath: string, modulePath: string) => Promise<ModuleFileEntries>
  /** Resolve `flow/brain/.structure/` for a root. Default: the fixed suffix. */
  structureDirFor?: (rootPath: string) => string
  /**
   * Read-modify-write learning-state as one critical section. Default:
   * `mutateLearningState`.
   *
   * ONE seam, not a `readLearning` + `writeLearning` pair: the store is a full
   * rewrite, so the read that decides the rewrite has to be inside the same
   * lock as the write. Two seams let a call site put them on either side of an
   * await, which is the silent lost update the lock exists to stop — the app
   * would drop whatever the CLI (or a second orchestrator) wrote in between,
   * with no error to notice.
   */
  mutateLearning?: MutateLearningState
  /** Choose the model for a payload size. Default: pickLearnModel (no custom routing). */
  resolveModel?: (payloadBytes: number) => RoutableModel
  /** Account-resolved auth env for the caged session (per root). Optional. */
  resolveAuthEnv?: (rootPath: string) => Promise<NodeJS.ProcessEnv | undefined>
  /** Ignore-list extras for a root (flowconfig `learn_ignore`, see
   *  shared/learn-ignore). The built-in default segments always apply to the
   *  AUTOMATIC basic-discovery sweep; this adds the per-project patterns.
   *  Optional — omit (or fail) → defaults only. `enqueueModule` (manual /
   *  run-release) is deliberately NOT gated by the ignore list. */
  readLearnIgnore?: (rootPath: string) => Promise<string[]>
  /**
   * Derive the project's blueprint graph on disk; true when it now exists.
   * Basic discovery calls it when `readProjectState` reports no derived graph
   * (`graphDerived: false`). Optional — omitted, the sweep proceeds as before.
   */
  deriveGraph?: (rootPath: string) => Promise<boolean>
  /** Clock — default new Date() (tests inject a fixed clock). */
  now?: () => Date
  /** Max jobs to RUN per session before auto items are dropped (default 10). */
  budget?: number
  /** Best-effort error sink for background failures (default console.warn). */
  onError?: (message: string, error: unknown) => void
  /** Notified each time the caged learner reads a file (live-progress; throttled
   *  by the caller). Optional — omit to disable progress emission. */
  onLearnRead?: (rootPath: string, modulePath: string, file: string) => void
  /** Override the per-pass deadline (tests). Default: ten minutes. */
  passTimeoutMs?: number
  /** Override the silence watchdog (tests). Default: three minutes. */
  passSilenceMs?: number
  /** Override the wait before a failed resume is tried again (tests). Default: fifteen seconds. */
  resumeRetryMs?: number
}

/** How long a resume that hit a missing/half-made `flow/` waits before trying again. */
const RESUME_RETRY_MS = 15_000
/** How many times a failing resume is retried before it waits for the next trigger. */
const MAX_RESUME_RETRIES = 3

const DEFAULT_BUDGET = 10
const STRUCTURE_SUFFIX = join('flow', 'brain', '.structure')

/**
 * The serial learn orchestrator. One instance per app; construct in main, feed
 * it triggers via the two enqueue methods, and abort per-root on project switch
 * / root removal / quit.
 */
export class LearnOrchestrator {
  private state = initialQueueState()
  private draining = false
  private disposed = false
  private paused = false
  /** Projects a person paused on their own — their queued work waits; others run. */
  private readonly pausedRoots = new Set<string>()

  /** True while a user-facing agent turn is running — see setYielding. */
  private yielding = false

  /** Why the drain is paused: a person's Pause, or the run stopping itself after failures. */
  private pausedBy: 'person' | 'failures' = 'person'

  /**
   * When the queue last MOVED (a pass started or ended, a job was dropped, a
   * pause or a yield lifted), epoch ms on the injected clock — what the basic
   * discovery stall watchdog measures against.
   */
  private lastMovementAt = 0

  /** The stall watchdog's timer, alive only while a basic discovery is pending. */
  private stallTimer: ReturnType<typeof setInterval> | null = null

  /** Consecutive failed passes — see recordOutcome. */
  private consecutiveFailures = 0

  /** The root the last failure belonged to, for the paused notification. */
  private lastFailureRoot = ''

  /** How long one learn pass may run before it is stopped (see runJob). */
  private readonly passTimeoutMs: number

  /** How long a pass may say NOTHING before it is treated as gone. */
  private readonly passSilenceMs: number

  /** When the active pass started (epoch ms), for the panel's elapsed clock. */
  private activeStartedAt = 0
  private activeAbort: AbortController | null = null
  /** Per-store write chain — serializes read-modify-write of learning-state so a
   *  burst of transitions (e.g. "Learn all" enqueuing every module) can't clobber
   *  each other via stale reads / last-writer-wins. Keyed by structureDir. */
  private readonly transitionChains = new Map<string, Promise<void>>()

  /**
   * ONE RESUME PER ROOT AT A TIME. Startup calls `resumeInterrupted` for every
   * root, then again for every root on each roots-changed event and once more
   * on each ready edge — live 2026-10-09 that was ~15 calls for one project
   * whose `flow` link was dangling, each an unhandled ENOTDIR rejection. Calls
   * that arrive while one runs fold into a single re-run after it.
   */
  private readonly resumesInFlight = new Map<string, Promise<void>>()
  private readonly resumeAgain = new Set<string>()
  /** A failed resume's single pending retry, and how many it has used. */
  private readonly resumeRetries = new Map<string, { timer: ReturnType<typeof setTimeout> | null; attempts: number }>()
  private readonly resumeRetryMs: number

  // Per-batch basic-discovery accounting for the FINISHED summary. Finish is
  // detected off queue state (no basic-discovery job left), so aborts/drops that
  // remove jobs from the queue can never wedge the counter; the tally is display-
  // only. `ranBasicDiscovery` guards the one-shot emit + resets after firing.
  private ranBasicDiscovery = false
  private basicDiscoveryLearned = 0
  private basicDiscoveryFailed = 0
  private basicDiscoveryRoot: string | null = null
  /** Roots whose current basic discovery is automatic, so it raises no toasts. */
  private readonly quietBasicRoots = new Set<string>()

  /** Basic discoveries someone is waiting on, by root — see runBasicDiscovery. */
  private readonly basicTrackers = new Map<string, BasicDiscoveryTracker>()

  private readonly runPass: (params: LearnPassParams) => Promise<LearnPassResult>
  private readonly runCli: (
    cwd: string,
    args: readonly string[],
  ) => Promise<{ ok: boolean; stdout: string }>
  private readonly enumerateModuleEntries: (
    rootPath: string,
    modulePath: string,
  ) => Promise<ModuleFileEntries>
  private readonly structureDirFor: (rootPath: string) => string
  private readonly mutateLearning: MutateLearningState
  private readonly resolveModel: (payloadBytes: number) => RoutableModel
  private readonly now: () => Date
  private readonly budget: number
  private readonly onError: (message: string, error: unknown) => void

  constructor(private readonly deps: LearnOrchestratorDeps) {
    this.runPass = deps.runPass ?? runLearnPass
    this.runCli =
      deps.runCli ??
      ((cwd, args) => runBundledCliCapturing(deps.bundledCli, cwd, args))
    this.enumerateModuleEntries = resolveEnumerator(deps)
    this.structureDirFor = deps.structureDirFor ?? ((rootPath) => join(rootPath, STRUCTURE_SUFFIX))
    this.mutateLearning = deps.mutateLearning ?? mutateLearningState
    this.resolveModel = deps.resolveModel ?? ((bytes) => pickLearnModel(bytes))
    this.now = deps.now ?? (() => new Date())
    this.budget = deps.budget ?? DEFAULT_BUDGET
    this.onError = deps.onError ?? ((message, error) => console.warn(`[LearnOrchestrator] ${message}`, error))
    this.passTimeoutMs = deps.passTimeoutMs ?? PASS_TIMEOUT_MS
    this.passSilenceMs = deps.passSilenceMs ?? PASS_SILENCE_MS
    this.resumeRetryMs = deps.resumeRetryMs ?? RESUME_RETRY_MS
  }

  /**
   * Generate the project's FEATURE LIST as part of basic discovery: stage
   * candidates from the repo's own surfaces, then promote them.
   *
   * Why these two verbs and not a re-bootstrap: `features discover` updates
   * anchors on features that already exist (through `writeFeature`, which
   * preserves every human-owned field) and stages the rest as CANDIDATES, and
   * `features confirm --all` promotes only slugs that are not taken. So this is
   * safe to run on a curated project — it adds what is new and rewrites
   * nothing. Loosening derive's empty-store gate instead would resurrect
   * features the user deliberately deleted, which is exactly what that gate
   * exists to prevent.
   *
   * FAIL-SOFT: a refusal or a missing CLI must never cost the user their module
   * learning, so every failure is swallowed to the error sink and the caller
   * proceeds. Reports through the same notify channel only when it actually
   * created something — silence when a repo names no capability, matching
   * derive's own rule.
   */
  private async generateFeatures(rootPath: string): Promise<void> {
    // EVERY EXIT SIGNALS. The board runs a spinner from the press of its "Run
    // basic discovery" button until it hears this event, so a branch that
    // returns without raising one leaves that spinner turning forever — the
    // discipline `drawFeatureView` already enforces for the drawing pass.
    const settled = (added: number, reason: string | null): void => {
      this.deps.onFeaturesDiscovered?.({ rootPath, added, reason })
    }
    try {
      const discover = await this.runCli(rootPath, ['blueprint', 'features', 'discover'])
      if (!discover.ok) {
        this.onError(`basic-discovery feature discover failed for ${rootPath}`, discover.stdout)
        settled(0, firstLine(discover.stdout) ?? 'feature discovery refused')
        return
      }
      const confirm = await this.runCli(rootPath, ['blueprint', 'features', 'confirm', '--all'])
      if (!confirm.ok) {
        // `confirm --all` refuses when there is nothing staged — the ordinary
        // case for a project whose features already exist, not an error worth
        // a toast. It goes to the sink and nothing else.
        this.onError(`basic-discovery feature confirm failed for ${rootPath}`, confirm.stdout)
        // …and it is ALSO what a repo with nothing minable produces. That is a
        // completed discovery which found nothing, not a failure — reporting it
        // as one would put an error in front of a user whose project simply
        // names no capability twice over. Any OTHER refusal is a real failure
        // and keeps its reason.
        const line = firstLine(confirm.stdout)
        settled(0, line !== null && line.includes('no staged candidates') ? null : (line ?? 'feature confirm refused'))
        return
      }
      const confirmed = parseConfirmedCount(confirm.stdout)
      if (confirmed > 0) {
        this.deps.notify({
          kind: 'state-change',
          rootId: rootPath,
          title: 'Features discovered',
          body: `Added ${confirmed} feature(s) to the board`,
          timestamp: this.now().toISOString(),
          level: 'info',
          action: { label: 'Open blueprint', event: 'flow:open-blueprint' },
        })
      }
      settled(confirmed, null)
    } catch (error) {
      this.onError(`basic-discovery feature generation failed for ${rootPath}`, error)
      settled(0, error instanceof Error ? error.message : 'feature generation failed')
    }
  }

  /**
   * Enqueue the onboarding selection for `rootPath` — non-ignored depth-2
   * children of container modules plus leaf depth-1 modules
   * (selectOnboardingModules: "learn the basics, not the root folders") that
   * aren't already learned-fresh. Ignored scaffolding (built-in segments +
   * dot-dirs + the root's `learn_ignore` extras) is skipped and surfaced in
   * the STARTED toast — a manual Learn of an ignored module stays allowed via
   * enqueueModule. Deliberate (a user asked to learn the project). No-op when
   * the root isn't ready. Errors reading the graph are swallowed to the sink;
   * an unreadable ignore list falls back to the built-in defaults.
   */
  async enqueueBasicDiscovery(rootPath: string): Promise<void> {
    await this.startBasicDiscovery(rootPath)
  }

  /**
   * Run ONE project's basic discovery and answer when it has ENDED — every
   * module it selected learned, failed or stopped. The one way to ask "is this
   * project's basic discovery finished, and did it work?" (the coordinator
   * waits on it before a held message is sent).
   *
   * JOINS a run already in flight for the root rather than starting a second.
   * Modules that were already queued (a resumed queue, a person's Learn press)
   * count toward the run: their completion is what ends it, whoever queued
   * them. `resume: true` is a person pressing Try again — it lifts a pause the
   * run put on itself after failures in a row, exactly as the Learning panel's
   * Resume does.
   */
  async runBasicDiscovery(
    rootPath: string,
    options: { resume?: boolean; announce?: boolean } = {},
  ): Promise<BasicDiscoveryRunOutcome> {
    // An AUTOMATIC sweep (a project joined a Workspace, a thread needs it) is
    // quiet: the learn dots and the Learning panel already show it, and a toast
    // per project per launch buried everything else (47 at once, 2026-10-06).
    // A person's press still announces; failures still surface where waited on.
    if (options.announce === false) this.quietBasicRoots.add(rootPath)
    else this.quietBasicRoots.delete(rootPath)
    const running = this.basicTrackers.get(rootPath)
    if (running !== undefined) {
      if (options.resume === true && this.paused) this.setPaused(false)
      return running.promise
    }
    if (options.resume === true && this.paused) this.setPaused(false)
    // A PAUSED LEARNER ANSWERS AT ONCE. A pause settles every basic discovery
    // alive at that moment — but one STARTED afterwards admitted its modules
    // into a queue nobody was draining and waited for ever. Live, 2026-10-06:
    // one project's passes failed three in a row, the learner paused itself,
    // the coordinator started the next project's sweep, and that project's
    // chip read "Learning…" until the app was quit. Only a person's Try again
    // (`resume`) lifts a pause.
    if (this.paused) {
      return {
        kind: 'failed',
        reason: this.pausedBy === 'failures' ? PAUSED_AFTER_FAILURES_REASON : PAUSED_BY_PERSON_REASON,
      }
    }
    // The tracker exists BEFORE the jobs are admitted: a job that finishes in
    // the same tick as its admission must find someone to tell.
    let resolve: (outcome: BasicDiscoveryRunOutcome) => void = () => undefined
    const promise = new Promise<BasicDiscoveryRunOutcome>((settle) => {
      resolve = settle
    })
    const tracker: BasicDiscoveryTracker = {
      pending: new Set(),
      learned: 0,
      failed: 0,
      stopped: 0,
      startedAt: this.now().getTime(),
      promise,
      resolve,
    }
    this.basicTrackers.set(rootPath, tracker)
    this.armStallWatchdog()
    const started = await this.startBasicDiscovery(rootPath, (modules) => {
      for (const modulePath of modules) tracker.pending.add(modulePath)
    })
    if (started.kind === 'settled') {
      this.settleTracker(rootPath, started.outcome)
    } else {
      // Drain may already have finished every one of them.
      this.maybeFinishTracker(rootPath)
    }
    return promise
  }

  /** Begin a basic discovery; `beforeAdmit` learns the modules before any job runs. */
  private async startBasicDiscovery(
    rootPath: string,
    beforeAdmit?: (modules: readonly string[]) => void,
  ): Promise<BasicDiscoveryStart> {
    if (this.disposed || !this.deps.isRootReady(rootPath)) {
      // SAY WHY NOTHING HAPPENED. This return used to be completely silent —
      // no toast, no event, no error — so on a freshly added project the
      // Settings button (and now the board's) simply did nothing. The board
      // disables its control on an unready root, and this is the backstop for
      // the race where readiness changes between the paint and the press.
      this.deps.onFeaturesDiscovered?.({
        rootPath,
        added: 0,
        reason: this.disposed ? 'the app is shutting down' : 'this project is not ready yet',
      })
      return { kind: 'settled', outcome: this.disposed ? { kind: 'cancelled' } : { kind: 'not-ready' } }
    }
    // FEATURES FIRST — basic discovery answers "what does this project do",
    // and until this ran it only ever answered "what modules does it have".
    // Feature generation lived in exactly one place, the lazy bootstrap inside
    // `blueprint derive`, gated on an EMPTY store — one chance per project. A
    // project whose first derive found nothing minable (no graph yet, surfaces
    // not present at that instant) was left with a permanently empty feature
    // board that no amount of basic discovery could repair, because nothing in
    // the app ever invoked feature generation again.
    await this.generateFeatures(rootPath)
    let projectState: LearnProjectState
    try {
      projectState = await this.deps.readProjectState(rootPath)
      // NO DERIVED GRAPH, NO LEARNING. Live, 2026-10-06: three Workspace
      // projects had no graph on disk (it is derived, so it did not travel
      // with the move into the Workspace folder); their modules were picked
      // from an in-memory fallback, and every pass ran a full agent session
      // only to have its note refused for want of a graph — three in a row,
      // and learning paused for every project. Derive first; if that does not
      // work, say so once instead of failing module by module.
      if (projectState.graphDerived === false && this.deps.deriveGraph !== undefined) {
        const derived = await this.deriveGraphOnce(rootPath)
        if (derived) projectState = await this.deps.readProjectState(rootPath)
        if (!derived || projectState.graphDerived === false) {
          return { kind: 'settled', outcome: { kind: 'failed', reason: NO_GRAPH_REASON } }
        }
      }
    } catch (error) {
      this.onError(`basic-discovery read failed for ${rootPath}`, error)
      // #1169: a console.warn is not feedback. This click costs an agent run,
      // and the user is watching for something to happen.
      this.deps.notify({
        kind: 'state-change',
        rootId: rootPath,
        title: "Couldn't start basic discovery",
        body: "Couldn't read the project structure — try again.",
        timestamp: this.now().toISOString(),
        level: 'error',
      })
      return { kind: 'settled', outcome: { kind: 'failed', reason: "Flow couldn't read the project's structure." } }
    }
    let ignoreExtras: string[] = []
    try {
      ignoreExtras = (await this.deps.readLearnIgnore?.(rootPath)) ?? []
    } catch {
      ignoreExtras = [] // Fail-soft: defaults still apply below.
    }
    const selection = selectOnboardingModules(projectState.graph, ignoreExtras)
    const modules = filterUnlearned(selection.modules, projectState.learning)
    if (modules.length > 0) {
      // STARTED: an actionable heads-up with a deep-link to the board + learning
      // panel. The per-batch finish tally is reset here so the FINISHED summary
      // counts only this drain's basic-discovery jobs. When scaffolding was
      // skipped, the toast says WHAT and WHY in the same single line ("detect
      // and suggest that ignore during the discovery").
      const skippedClause =
        selection.skipped.length > 0
          ? ` — skipped ${selection.skipped.length} scaffolding module(s) (mocks, tests and hidden folders)`
          : '…'
      this.basicDiscoveryRoot = rootPath
      if (!this.quietBasicRoots.has(rootPath)) this.deps.notify({
        kind: 'state-change',
        rootId: rootPath,
        title: 'Basic discovery started',
        body: `Learning ${modules.length} module(s)${skippedClause}`,
        timestamp: this.now().toISOString(),
        level: 'info',
        action: { label: 'Open blueprint', event: 'flow:open-blueprint', openLearning: true },
      })
    }
    if (modules.length === 0) {
      // #1169: NOTHING to learn is the case that most needs saying — the ask is
      // one-time and destructive of its own affordance, so silence here reads as
      // "the button is broken". The explanation was already composed above and
      // then thrown away: the skipped clause lived INSIDE `modules.length > 0`,
      // so it was unreachable exactly when "everything was skipped" was the only
      // thing there was to say.
      const skipped = selection.skipped.length
      const why =
        skipped > 0
          ? `Skipped ${skipped} scaffolding module(s) (mocks, tests and hidden folders).`
          : selection.modules.length > 0
            ? 'Every module here has already been learned.'
            : 'No modules were found to learn yet — this can happen before the first blueprint derive completes.'
      if (!this.quietBasicRoots.has(rootPath)) this.deps.notify({
        kind: 'state-change',
        rootId: rootPath,
        title: 'Nothing to learn yet',
        body: why,
        timestamp: this.now().toISOString(),
        level: 'info',
      })
      return { kind: 'settled', outcome: { kind: 'done', learned: 0, failed: 0 } }
    }
    beforeAdmit?.(modules)
    for (const modulePath of modules) {
      this.admit({ rootPath, modulePath, reason: 'basic-discovery', deliberate: true })
    }
    this.state = claimQueuedJobs(this.state, rootPath, modules)
    this.drain()
    return { kind: 'enqueued', modules }
  }

  /** A module of a tracked basic discovery reached an end (null = stopped, not judged). */
  private trackModuleEnd(job: LearnJob, learned: boolean | null): void {
    const tracker = this.basicTrackers.get(job.rootPath)
    if (tracker === undefined || !tracker.pending.delete(job.modulePath)) return
    if (learned === true) tracker.learned += 1
    if (learned === false) tracker.failed += 1
    if (learned === null) tracker.stopped += 1
    this.maybeFinishTracker(job.rootPath)
  }

  /** End a tracked run once nothing of it is left. */
  private maybeFinishTracker(rootPath: string): void {
    const tracker = this.basicTrackers.get(rootPath)
    if (tracker === undefined || tracker.pending.size > 0) return
    // Nothing learned and something merely STOPPED: the run did not get to an
    // answer, which is not the same as having one.
    if (tracker.learned === 0 && tracker.failed === 0 && tracker.stopped > 0) {
      this.settleTracker(rootPath, { kind: 'cancelled' })
      return
    }
    if (tracker.learned === 0 && tracker.failed > 0) {
      this.settleTracker(rootPath, {
        kind: 'failed',
        reason: tracker.failed === 1 ? "The one part of it Flow tried couldn't be learned." : `None of the ${String(tracker.failed)} parts Flow tried could be learned.`,
      })
      return
    }
    this.settleTracker(rootPath, { kind: 'done', learned: tracker.learned, failed: tracker.failed })
  }

  private settleTracker(rootPath: string, outcome: BasicDiscoveryRunOutcome): void {
    const tracker = this.basicTrackers.get(rootPath)
    if (tracker === undefined) return
    this.basicTrackers.delete(rootPath)
    if (this.basicTrackers.size === 0) this.disarmStallWatchdog()
    tracker.resolve(outcome)
  }

  /** Derives in flight, by root — a sweep and a resumed job share one. */
  private readonly derivesInFlight = new Map<string, Promise<boolean>>()

  /** `deps.deriveGraph`, one at a time per root. Never rejects. */
  private deriveGraphOnce(rootPath: string): Promise<boolean> {
    const derive = this.deps.deriveGraph
    if (derive === undefined) return Promise.resolve(false)
    const running = this.derivesInFlight.get(rootPath)
    if (running !== undefined) return running
    const run = derive(rootPath)
      .catch((error: unknown) => {
        this.onError(`blueprint derive failed for ${rootPath}`, error)
        return false
      })
      .finally(() => this.derivesInFlight.delete(rootPath))
    this.derivesInFlight.set(rootPath, run)
    return run
  }

  /** The queue moved — see lastMovementAt. */
  private noteMovement(): void {
    this.lastMovementAt = this.now().getTime()
  }

  private armStallWatchdog(): void {
    if (this.stallTimer !== null) return
    this.stallTimer = setInterval(() => this.checkStalledDiscoveries(), BASIC_DISCOVERY_STALL_CHECK_MS)
    // Never the reason the process stays alive.
    this.stallTimer.unref?.()
  }

  private disarmStallWatchdog(): void {
    if (this.stallTimer === null) return
    clearInterval(this.stallTimer)
    this.stallTimer = null
  }

  /**
   * THE STALL WATCHDOG (its timer calls this; tests call it with an injected
   * clock). A basic discovery whose queue has not moved for
   * BASIC_DISCOVERY_STALL_MS — or BASIC_DISCOVERY_YIELD_STALL_MS while
   * learning stands aside for a person's turn — ends as failed with a plain
   * sentence, so whoever waits on it gets Try again instead of "Learning…" for
   * good. Its queued jobs are left alone: if the queue moves again later they
   * still run, and the project counts as discovered once anything is learned.
   */
  checkStalledDiscoveries(): void {
    const now = this.now().getTime()
    const limit = this.yielding ? BASIC_DISCOVERY_YIELD_STALL_MS : BASIC_DISCOVERY_STALL_MS
    for (const [rootPath, tracker] of [...this.basicTrackers]) {
      const since = Math.max(this.lastMovementAt, tracker.startedAt)
      if (now - since < limit) continue
      this.onError(`basic discovery made no progress for ${String(Math.round((now - since) / 60_000))} min; reporting it failed`, rootPath)
      this.settleTracker(rootPath, { kind: 'failed', reason: STALLED_REASON })
    }
  }

  /** Every tracked run ends the same way (a pause after failures, quit). */
  private settleAllTrackers(outcome: BasicDiscoveryRunOutcome): void {
    for (const rootPath of [...this.basicTrackers.keys()]) this.settleTracker(rootPath, outcome)
  }

  /**
   * Enqueue one module for a learn pass. The Learn button passes
   * deliberate:true; auto triggers pass deliberate:false. No-op when the root
   * isn't ready or the pair is already queued/running.
   */
  enqueueModule(rootPath: string, modulePath: string, options: EnqueueModuleOptions): void {
    if (this.disposed) return
    if (!this.deps.isRootReady(rootPath)) {
      // A SILENT DROP IS WHY THIS WAS UNDIAGNOSABLE. `isRootReady` is
      // `provisioningState === 'ready'`, and until now a request that failed it
      // returned here with no error, no log and nothing on screen: the panel
      // went on reading "Idle · 0/362 learned" while every press did nothing.
      // The user's words were "the learning is not working at all", and there
      // was no way for them — or for anyone reading the panel — to find out
      // why, because the refusal left no trace anywhere.
      //
      // The basic-discovery path two hundred lines down already settled this
      // for itself (#1169: "a console.warn is not feedback. This click costs an
      // agent run, and the user is watching for something to happen"). The same
      // click, on the same panel, deserved the same answer.
      //
      // ONLY FOR A DELIBERATE REQUEST. Automatic re-learn (T3) probes roots
      // constantly and is expected to find some of them mid-provision; toasting
      // that would be noise about a decision nobody made. A person who pressed
      // a button is owed a reason; a background sweep is not.
      if (options.deliberate === true) {
        this.deps.notify({
          kind: 'state-change',
          rootId: rootPath,
          title: 'Learning has not started',
          // Says what is true about the project, not what to type
          // (forbidden-pattern #12) — and names the thing that has to happen.
          body: 'Flow is still setting this project up. Learning starts once that finishes.',
          timestamp: this.now().toISOString(),
          level: 'error',
        })
      }
      return
    }
    this.admit({
      rootPath,
      modulePath,
      reason: options.reason,
      deliberate: options.deliberate ?? false,
    })
    this.drain()
  }

  /**
   * Reconcile learning-state left mid-flight by a previous session (#learn-stuck):
   * on a fresh process NOTHING is actually learning, so any persisted 'learning'
   * or 'queued' entry is orphaned — it would otherwise pin the panel on
   * "Learning…" forever (button disabled) even though the reader is idle. Reset
   * each to 'stale' so it reads as needs-(re)learn and "Learn all" can re-enqueue
   * it. No-op when nothing is interrupted. Call at startup and on root add.
   */
  async reconcileInterrupted(rootPath: string): Promise<void> {
    const structureDir = this.structureDirFor(rootPath)
    const now = this.now().toISOString()
    // The project read stays OUTSIDE the critical section on purpose: it can
    // fall through to deriveBasicGraph, which walks the repo, and holding a
    // ten-second-stale lock across a repo walk invites another writer to
    // declare us dead and take the lock over mid-rewrite. It is an INPUT to the
    // decision, not part of the store, so reading it a moment early is safe;
    // the learning entries themselves are read inside. Fail-soft: an unreadable
    // project skips the noteless pass rather than guessing.
    let projectState: LearnProjectState | null = null
    try {
      projectState = await this.deps.readProjectState(rootPath)
    } catch {
      // Unreadable project state — reconcile the interrupted entries only.
    }
    await this.mutateLearning(structureDir, (existing) => {
      // ONE batched rewrite — NOT a transition() per module. After "Learn all" a
      // big project can have hundreds of interrupted entries; a rewrite each would
      // be hundreds of serialized file writes + a watcher-refresh storm, so the
      // panel never settled off "Learning…". Remap all in memory, write once.
      let changed = false
      let final: readonly BlueprintLearningEntry[] = existing.map((entry) => {
        if (entry.status === 'learning' || entry.status === 'queued') {
          changed = true
          return { ...entry, status: 'stale' as const, notedAt: now }
        }
        return entry
      })
      // Second integrity pass: `learned` entries with NO investigation note are
      // unverifiable (nothing for stale-check to re-hash) — flip them stale so
      // re-learn can heal them.
      if (projectState !== null) {
        const noteless = reconcileNoteless(
          final,
          projectState.investigations,
          now,
          projectState.investigationsTruncated === true,
        )
        if (noteless.changed) {
          final = noteless.entries
          changed = true
        }
      }
      return changed ? final : null
    })
  }

  /**
   * Resume the learning a previous session left unfinished (#1132).
   *
   * Closing the app mid-"Learn all" used to throw the whole queue away: the
   * jobs lived only in memory, and startup's reconcile flipped every persisted
   * 'queued'/'learning' entry to 'stale' — so the user reopened Flow to a wall
   * of stale modules and learning that never restarted. The queue IS durable —
   * it is the learning-state store — so a restart re-admits those modules with
   * the reason and deliberateness they were enqueued with (an entry from before
   * this fix carries neither and resumes as deliberate: only an explicit action
   * fills a queue that survives a session).
   *
   * 'learning' entries are rewritten to 'queued' first — nothing is running in
   * a fresh process, and a persisted 'learning' would pin the panel (#learn-
   * stuck). A root that is not provisioned yet is left queued for the next
   * attempt (roots-changed fires again when provisioning finishes) rather than
   * being discarded. The `learned`-without-a-note integrity pass still runs.
   */
  resumeInterrupted(rootPath: string): Promise<void> {
    if (this.disposed) return Promise.resolve()
    const running = this.resumesInFlight.get(rootPath)
    if (running !== undefined) {
      this.resumeAgain.add(rootPath)
      return running
    }
    const run = this.resumeInterruptedOnce(rootPath)
      .then(() => {
        const retry = this.resumeRetries.get(rootPath)
        if (retry !== undefined && retry.timer === null) this.resumeRetries.delete(rootPath)
      })
      .catch((error: unknown) => this.resumeFailed(rootPath, error))
      .finally(() => {
        this.resumesInFlight.delete(rootPath)
        if (this.resumeAgain.delete(rootPath) && !this.disposed) void this.resumeInterrupted(rootPath)
      })
    this.resumesInFlight.set(rootPath, run)
    return run
  }

  /**
   * A resume that failed NEVER rejects: whoever fired it (`void …`) has no one
   * to tell. A transient filesystem miss — `flow` missing or a link that does
   * not resolve yet, as while a Workspace link is being made — logs ONE line
   * and is tried again once after a pause, at most MAX_RESUME_RETRIES times;
   * after that the next trigger (a ready edge, a roots change) tries again.
   */
  private resumeFailed(rootPath: string, error: unknown): void {
    const code = (error as { code?: unknown } | null)?.code
    const transient = code === 'ENOENT' || code === 'ENOTDIR' || code === 'EBUSY' || code === 'EAGAIN'
    const retry = this.resumeRetries.get(rootPath) ?? { timer: null, attempts: 0 }
    if (retry.timer !== null) return // one is already scheduled — and its line already printed
    const reason = error instanceof Error ? error.message : String(error)
    if (!transient || retry.attempts >= MAX_RESUME_RETRIES || this.disposed) {
      this.resumeRetries.delete(rootPath)
      this.onError(`could not resume interrupted learning for ${rootPath}; the next trigger tries again`, reason)
      return
    }
    retry.attempts += 1
    this.onError(
      `could not resume interrupted learning for ${rootPath} yet (retry ${retry.attempts}/${MAX_RESUME_RETRIES} in ${Math.round(this.resumeRetryMs / 1000)}s)`,
      reason,
    )
    retry.timer = setTimeout(() => {
      retry.timer = null
      if (!this.disposed) void this.resumeInterrupted(rootPath)
    }, this.resumeRetryMs)
    ;(retry.timer as { unref?: () => void }).unref?.()
    this.resumeRetries.set(rootPath, retry)
  }

  private async resumeInterruptedOnce(rootPath: string): Promise<void> {
    if (this.disposed) return
    const structureDir = this.structureDirFor(rootPath)
    const now = this.now().toISOString()
    // Read outside the critical section, for the reason reconcileInterrupted
    // gives: this can walk the repo, and the store's lock goes stale in ten
    // seconds.
    let projectState: LearnProjectState | null = null
    try {
      projectState = await this.deps.readProjectState(rootPath)
    } catch {
      // Unreadable project state — resume the interrupted entries only.
    }
    // The jobs to re-admit are decided from the SAME read that produces the
    // rewrite, so a module can never be resumed off a view the rewrite then
    // contradicts.
    let resumable: LearnJob[] = []
    await this.mutateLearning(structureDir, (existing) => {
      // ONE batched rewrite for the whole set (see reconcileInterrupted) — a
      // per-module transition() here would be hundreds of serialized writes.
      let changed = false
      const resuming: LearnJob[] = []
      let final: readonly BlueprintLearningEntry[] = existing.map((entry) => {
        if (entry.status !== 'learning' && entry.status !== 'queued') return entry
        resuming.push({
          rootPath,
          modulePath: entry.module,
          reason: entry.reason ?? 'resumed',
          deliberate: entry.deliberate ?? true,
        })
        if (entry.status === 'learning') {
          changed = true
          return { ...entry, status: 'queued' as const, notedAt: now }
        }
        return entry
      })
      if (projectState !== null) {
        const noteless = reconcileNoteless(
          final,
          projectState.investigations,
          now,
          projectState.investigationsTruncated === true,
        )
        if (noteless.changed) {
          final = noteless.entries
          changed = true
        }
      }
      resumable = resuming
      return changed ? final : null
    })
    if (resumable.length === 0 || !this.deps.isRootReady(rootPath)) return
    for (const job of resumable) {
      // persist:false — the store already says 'queued' for every one of these,
      // so re-writing it would be the write storm this method exists to avoid.
      this.admit(job, { persist: false })
    }
    this.drain()
  }

  /**
   * Abort all learning for a root: drop its queued jobs and tear down the
   * in-flight session if it belongs to the root. Idempotent.
   */
  abortRoot(rootPath: string): void {
    const { state, abortedActive } = abortRootJobs(this.state, rootPath)
    this.state = state
    this.settleTracker(rootPath, { kind: 'cancelled' })
    if (abortedActive) {
      this.activeAbort?.abort()
    }
  }

  /**
   * Count a pass's outcome, and STOP A RUN THAT IS ONLY PRODUCING FAILURES.
   *
   * Reported live: a wall of "Could not learn <module>: went quiet and was
   * stopped" toasts while the app crawled. Three minutes of silence each, three
   * hundred modules queued — a treadmill that costs the machine everything and
   * produces nothing, one toast at a time. Three consecutive failures is not a
   * flaky module; it is a run that is not working, and it should say so once and
   * stop rather than grind for hours.
   *
   * Any success resets it: a single bad module never stops a healthy run.
   */
  private recordOutcome(ok: boolean, rootPath = ''): void {
    if (rootPath.length > 0) this.lastFailureRoot = rootPath
    if (ok) {
      this.consecutiveFailures = 0
      return
    }
    this.consecutiveFailures += 1
    if (this.consecutiveFailures < CONSECUTIVE_FAILURE_LIMIT || this.paused) return
    this.paused = true
    this.pausedBy = 'failures'
    // A run that stopped itself has ended for everyone waiting on one: a held
    // message must hear "it didn't work" and offer Try again, not wait on a
    // queue nobody is draining.
    this.settleAllTrackers({ kind: 'failed', reason: 'Learning stopped after several parts in a row could not be learned.' })
    recordLearnEvent({
      at: Date.now(),
      kind: 'note',
      module: '',
      detail: `paused after ${String(this.consecutiveFailures)} failures in a row`,
    })
    this.deps.notify({
      kind: 'state-change',
      rootId: this.lastFailureRoot,
      title: 'Learning paused',
      body: `${String(this.consecutiveFailures)} modules in a row could not be learned. The queue is kept — press Resume in the Learning panel to try again.`,
      timestamp: this.now().toISOString(),
      level: 'warn',
    })
  }

  /**
   * Pause/resume the drain loop (the Learning panel's Pause button). While
   * paused no NEW job is taken — the queue stays intact and an in-flight pass
   * finishes (and records) normally. Resuming kicks the drain so queued work
   * continues where it left off. Global — the queue is global-serial anyway.
   */
  setPaused(paused: boolean): void {
    this.paused = paused
    if (paused) {
      this.pausedBy = 'person'
      return
    }
    // A person's Resume is a fresh start: without this one more failure
    // re-paused at once, before anything they asked for got a turn.
    this.consecutiveFailures = 0
    this.noteMovement()
    this.drain()
  }

  /**
   * Pause or resume ONE project's learning (the per-project Learning panel).
   * Its queued work stays queued and skipped; every other project keeps
   * learning. An in-flight pass of that project finishes and records.
   */
  setRootPaused(rootPath: string, paused: boolean): void {
    if (paused) {
      this.pausedRoots.add(rootPath)
      return
    }
    if (!this.pausedRoots.delete(rootPath)) return
    this.noteMovement()
    this.drain()
  }

  /** The projects paused on their own. */
  pausedRootPaths(): string[] {
    return [...this.pausedRoots].sort()
  }

  /**
   * Stand aside while the user's own agent is working.
   *
   * SEPARATE FROM PAUSE, deliberately: pause is a person's decision and must
   * survive; this is the app being polite. A learn run is hundreds of agent
   * sessions, and one of them competing with the turn somebody is watching is
   * the difference between "the IDE is thinking" and "the IDE is slow".
   *
   * The in-flight pass finishes — killing it would waste the work and leave a
   * module stale — but no new one starts until the user's turn is done.
   */
  setYielding(yielding: boolean): void {
    if (this.yielding === yielding) return
    this.yielding = yielding
    if (!yielding) {
      this.noteMovement()
      this.drain()
    }
  }

  /** True while standing aside for the user's own agent turn. */
  isYielding(): boolean {
    return this.yielding
  }

  /**
   * What is happening RIGHT NOW — the live answer, from the only place that
   * knows it.
   *
   * The Learning panel used to infer this from the learning-state FILE: any
   * row saying 'queued' or 'learning' meant "a sync is live". A file is a
   * record of intent, not of a running process — so three rows left queued by
   * a closed session made the panel insist it was learning for fifteen hours,
   * with a stale "reading …" line under it and the Learn all button disabled.
   */
  /**
   * What is happening RIGHT NOW, across every root.
   *
   * `activeRoot` IS PART OF THE ANSWER, and leaving it out was a real defect.
   * One orchestrator serves every project, so the active pass can belong to a
   * project the reader is not looking at — while the Learning panel's Stop and
   * Reset only reach the root the board is currently viewing
   * (`#stopLearning` sends `#activeRoot`; `abortRootJobs` matches
   * `job.rootPath` exactly).
   *
   * Reported live: the panel sat on "Learning orbit_core/web/api/v1 · 2m 51s"
   * reading a file under .../Acme/orbit-core, and Stop and Reset did
   * nothing at all — because they were cancelling a different root's queue
   * while another root's pass ran on. Nothing was stuck; the screen was
   * describing one project and its buttons were aimed at another.
   *
   * A caller that knows which root a pass belongs to can say so, or scope what
   * it shows. A caller that does not cannot tell the difference between "your
   * project is learning" and "some project is learning", and the buttons
   * underneath quietly stop meaning what they say.
   */
  status(): {
    running: boolean
    paused: boolean
    activeModule: string | null
    /** The root the active pass belongs to — null when nothing is running. */
    activeRoot: string | null
    queued: number
    /** When the active pass started (epoch ms) — "six minutes on one module" is
     *  the fact somebody needs, and it was nowhere on screen. */
    startedAt: number | null
    /** Queued jobs per project — the per-project panel's own count. */
    queuedByRoot: Record<string, number>
    /** Projects paused on their own. */
    pausedRoots: string[]
  } {
    const queuedByRoot: Record<string, number> = {}
    for (const job of this.state.queued) queuedByRoot[job.rootPath] = (queuedByRoot[job.rootPath] ?? 0) + 1
    return {
      queuedByRoot,
      pausedRoots: this.pausedRootPaths(),
      running: this.state.active !== null,
      paused: this.paused || this.yielding,
      activeModule: this.state.active?.modulePath ?? null,
      activeRoot: this.state.active?.rootPath ?? null,
      queued: this.state.queued.length,
      startedAt: this.state.active === null ? null : this.activeStartedAt,
    }
  }

  /** True while the drain loop is paused (no new passes start). */
  isPaused(): boolean {
    return this.paused
  }

  /**
   * Stop all learning for a root NOW (the Learning panel's Stop button): abort
   * the in-flight pass + drop the queued jobs (abortRoot), then reconcile
   * immediately so the orphaned 'queued'/'learning' entries flip to 'stale'
   * today instead of on next startup — the aborted active pass returns without
   * recording anything, so reconcile covers its entry too.
   */
  async cancelRoot(rootPath: string): Promise<void> {
    this.abortRoot(rootPath)
    await this.reconcileInterrupted(rootPath)
  }

  /**
   * Wipe a root's learning-state entirely (the Learning panel's Reset button):
   * abort the in-flight pass + drop the queued jobs, then write an EMPTY store
   * via the serialized per-store writer chain — every module reads
   * never-learned again. Docs (`flow/brain/modules/*.md`) and investigation
   * notes are untouched.
   */
  async resetRoot(rootPath: string): Promise<void> {
    this.abortRoot(rootPath)
    const structureDir = this.structureDirFor(rootPath)
    const prior = this.transitionChains.get(structureDir) ?? Promise.resolve()
    const run = prior.then(async () => {
      try {
        // A wipe is still a read-modify-write as far as the store is concerned:
        // going through the same seam is what makes a CLI verb mid-wipe wait
        // rather than interleave with it.
        await this.mutateLearning(structureDir, () => [])
      } catch (error) {
        this.onError(`learning-state reset failed for ${rootPath}`, error)
      }
    })
    this.transitionChains.set(structureDir, run)
    await run
  }

  /** Tear everything down (app quit) — abort the active session, drop the queue. */
  dispose(): void {
    this.disposed = true
    for (const retry of this.resumeRetries.values()) if (retry.timer !== null) clearTimeout(retry.timer)
    this.resumeRetries.clear()
    this.settleAllTrackers({ kind: 'cancelled' })
    this.disarmStallWatchdog()
    this.activeAbort?.abort()
    this.state = { ...initialQueueState() }
  }

  // ── internals ──────────────────────────────────────────────────────────

  private admit(job: LearnJob, options: { persist?: boolean } = {}): void {
    recordLearnEvent({
      at: Date.now(),
      kind: 'queued',
      module: job.modulePath,
      detail: job.deliberate ? 'you asked for this one' : job.reason,
    })
    const result = enqueueJob(this.state, job)
    this.state = result.state
    if (result.admitted && options.persist !== false) {
      // Make the queue VISIBLE the moment a job is accepted (live UX finding:
      // a second Learn click looked like a no-op while the first pass ran).
      // The drain loop promotes queued → learning when the pass starts.
      void this.transition(job.rootPath, job.modulePath, 'queued', job)
    }
  }

  /** Kick the serial drain loop (idempotent — one loop at a time). */
  private drain(): void {
    if (this.draining || this.disposed) {
      return
    }
    this.draining = true
    void this.loop().finally(() => {
      this.draining = false
    })
  }

  /** Ask the store which note is active on this module's anchor (see
   *  `resolveSupersedeViaCli`). Fail-soft — undefined means "no pointer". */
  private resolveSupersedeFor(
    rootPath: string,
    modulePath: string,
  ): Promise<SupersedeRequest | undefined> {
    // NOT SHORT-CIRCUITED FROM THE PROJECTION, deliberately. Skipping this
    // spawn when the snapshot shows no note for the anchor looked like a free
    // saving — and it is the exact bug this path was written to fix: the
    // projection is capped, and on orbit-app the note it needed sat at index
    // 356 of 362. The CLI answers against the whole store; a process spawn is
    // cheaper than a re-learn that silently loses its history.
    return resolveSupersedeViaCli((args) => this.runCli(rootPath, args), modulePath)
  }

  private async loop(): Promise<void> {
    for (;;) {
      // Paused: leave the queue intact and start nothing new — the pass that
      // just finished (if any) has already recorded via completeActive above.
      // setPaused(false) re-kicks drain(), which resumes exactly here.
      if (this.disposed || this.paused || this.yielding) {
        return
      }
      const outcome = takeNext(this.state, this.budget, this.pausedRoots)
      this.state = outcome.state
      if (outcome.kind === 'empty') {
        return
      }
      if (outcome.kind === 'dropped') {
        await this.onBudgetDrop(outcome.job)
        this.noteMovement()
        // A dropped job is an END too: a basic discovery counting it must hear
        // so (stopped, not judged), or its tracker waits for ever.
        this.trackModuleEnd(outcome.job, null)
        continue
      }
      const wasBasicDiscovery = outcome.job.reason === 'basic-discovery'
      this.noteMovement()
      const verdict = await this.runJob(outcome.job)
      this.state = completeActive(this.state)
      this.noteMovement()
      // AFTER the job has left the active slot: a basic discovery started
      // while this job was finishing counts it as one of its own, and must
      // hear it end.
      this.trackModuleEnd(outcome.job, verdict)
      // FINISHED: the last basic-discovery job of a batch just cleared the queue.
      if (
        wasBasicDiscovery &&
        this.ranBasicDiscovery &&
        !this.disposed &&
        !this.hasPendingBasicDiscovery()
      ) {
        this.emitBasicDiscoveryFinished()
      }
    }
  }

  /** True while any queued job still carries reason 'basic-discovery' (active is
   *  already cleared by completeActive before this is consulted). */
  private hasPendingBasicDiscovery(): boolean {
    return this.state.queued.some((job) => job.reason === 'basic-discovery')
  }

  /** Record a basic-discovery job's terminal outcome into the batch tally. */
  private recordBasicDiscovery(job: LearnJob, learned: boolean): void {
    if (job.reason !== 'basic-discovery') {
      return
    }
    this.ranBasicDiscovery = true
    this.basicDiscoveryRoot = job.rootPath
    if (learned) {
      this.basicDiscoveryLearned += 1
    } else {
      this.basicDiscoveryFailed += 1
    }
  }

  /** Emit the one-shot basic-discovery FINISHED summary and reset the tally. */
  private emitBasicDiscoveryFinished(): void {
    const learned = this.basicDiscoveryLearned
    const failed = this.basicDiscoveryFailed
    const rootId = this.basicDiscoveryRoot ?? ''
    this.ranBasicDiscovery = false
    this.basicDiscoveryLearned = 0
    this.basicDiscoveryFailed = 0
    this.basicDiscoveryRoot = null
    // The batch summary is the LAST word of a sweep, so the quiet flag lives
    // until here (a tracker settles a moment earlier, at its last module).
    if (this.quietBasicRoots.delete(rootId)) return
    this.deps.notify({
      kind: 'state-change',
      rootId,
      title: 'Basic discovery finished',
      body: `${learned} learned, ${failed} failed`,
      timestamp: this.now().toISOString(),
      level: 'info',
      action: { label: 'Open blueprint', event: 'flow:open-blueprint', openLearning: true },
    })
  }

  /**
   * An auto job dropped for budget: leave a 'stale' learning-state entry so the
   * module's dot stays amber (the staleness that triggered the re-learn is NOT
   * cleared). Silent — hitting the budget is expected, not an error.
   */
  private async onBudgetDrop(job: LearnJob): Promise<void> {
    await this.transition(job.rootPath, job.modulePath, 'stale')
  }

  /**
   * The project's feature roster — the names a learn pass may relate TO.
   *
   * Fail-soft on every path (`loadFeatureRoster` swallows a refusal, and this
   * swallows a throw): a pass with no roster writes prose instead of an edge,
   * which is the behaviour that shipped for months. Losing a module's learning
   * over a roster read would be strictly worse.
   */
  /** Feature roster per root, with the time it was read — see loadRoster. */
  private readonly rosterCache = new Map<string, { at: number; roster: FeatureRosterEntry[] }>()

  private async loadRoster(rootPath: string): Promise<FeatureRosterEntry[]> {
    // ONE ROSTER PER ROOT, NOT ONE PER MODULE. This spawns the bundled CLI, and
    // spawning from Electron's main process is not cheap: a sample taken during
    // a live stall found 73% of main's CPU inside posix_spawn. A run over 365
    // modules asked the same question 365 times.
    const cached = this.rosterCache.get(rootPath)
    if (cached !== undefined && Date.now() - cached.at < ROSTER_TTL_MS) return cached.roster
    try {
      const roster = await loadFeatureRoster(this.deps.bundledCli, rootPath, (_cli, cwd, args) =>
        this.runCli(cwd, args),
      )
      this.rosterCache.set(rootPath, { at: Date.now(), roster })
      return roster
    } catch {
      return []
    }
  }

  /** Runs one job; answers learned (true), failed (false) or stopped (null). */
  private async runJob(job: LearnJob): Promise<boolean | null> {
    const { rootPath, modulePath } = job
    // Readiness can change between enqueue and run (root removed / re-provision).
    if (!this.deps.isRootReady(rootPath)) {
      return null
    }
    this.activeStartedAt = Date.now()
    recordLearnEvent({ at: Date.now(), kind: 'start', module: modulePath })
    // ALSO in the performance log, on the same clock as the stalls. Learning is
    // an agent session per module and the natural suspect whenever the app
    // drags; a timeline where "learning src" and "[main] blocked 3000ms" sit
    // next to each other settles that in a glance instead of an argument.
    recordSlow(`[learn] started ${modulePath}`)
    await this.transition(rootPath, modulePath, 'learning', job)

    let entries: ModuleFileEntries
    let noGraph = false
    try {
      entries = await this.enumerateModuleEntries(rootPath, modulePath)
      // Still read the project: it is this path's readiness check (an
      // unreadable root must fail here, not mid-pass). Its investigations are
      // no longer used to resolve supersede — that question goes to the CLI,
      // which answers against the whole store rather than a capped projection.
      const state = await this.deps.readProjectState(rootPath)
      // A job resumed from an earlier session can reach here before its
      // project's sweep has derived a graph: derive (once, shared) rather than
      // spend an agent session whose note would be refused.
      if (state.graphDerived === false && this.deps.deriveGraph !== undefined && !(await this.deriveGraphOnce(rootPath))) {
        noGraph = true
        throw new Error('the project has no blueprint graph')
      }
    } catch (error) {
      this.onError(`learn setup failed for ${rootPath}/${modulePath}`, error)
      await this.transition(rootPath, modulePath, 'stale')
      // No graph is the PROJECT's problem, said once by its basic discovery —
      // not a toast per queued module.
      if (!noGraph) this.deps.notify(this.failureToast(rootPath, modulePath, 'could not read the module'))
      this.recordBasicDiscovery(job, false)
      return false
    }

    const supersede = await this.resolveSupersedeFor(rootPath, modulePath)
    const ranked = rankModuleFiles(entries.files, DEFAULT_RANK_CAPS)
    const model = this.resolveModel(totalPayloadBytes(ranked))
    const abort = new AbortController()
    this.activeAbort = abort

    // A PASS THAT NEVER ENDS IS A QUEUE THAT NEVER MOVES. Reported live: ten
    // minutes on one 20 KB HTML file, with 350 modules waiting behind it and
    // the panel honestly reporting "Learning flow/resources" the whole time.
    // A learn pass is an agent session; it can stall on a model, a tool, a
    // network hiccup — and nothing bounded it. Now one does, and the module is
    // marked stale so the next attempt can pick it up.
    let timedOut = false
    let stalled = false
    const deadline = setTimeout(() => {
      timedOut = true
      abort.abort()
    }, this.passTimeoutMs)

    // SILENCE IS THE OTHER FAILURE. A pass that is thinking, grepping or
    // writing says so now (onActivity); one that says NOTHING for minutes is
    // not working slowly, it is gone — and waiting out the full deadline
    // wastes the queue's time. Every sign of life resets this.
    let silence: ReturnType<typeof setTimeout> | null = null
    const heardSomething = (): void => {
      if (silence !== null) clearTimeout(silence)
      silence = setTimeout(() => {
        stalled = true
        abort.abort()
      }, this.passSilenceMs)
    }
    heardSomething()
    const noteActivity = (kind: string, detail?: string): void => {
      heardSomething()
      recordLearnEvent({
        at: Date.now(),
        kind: 'note',
        module: modulePath,
        detail: detail === undefined ? kind : `${kind}: ${detail}`,
      })
    }

    let result: LearnPassResult
    try {
      const authEnv = await this.deps.resolveAuthEnv?.(rootPath)
      // THE ROSTER, at the moment the pass is built. It goes through the same
      // injected CLI runner as every other store read here, so a test never
      // spawns a process and a missing/older CLI simply yields no roster —
      // which renders no block at all, exactly the prompt this had before.
      const roster = await this.loadRoster(rootPath)
      result = await this.runPass({
        rootPath,
        modulePath,
        files: entries.files,
        model,
        bundledCli: this.deps.bundledCli,
        abortSignal: abort.signal,
        onRead: (file) => {
          heardSomething()
          this.deps.onLearnRead?.(rootPath, modulePath, file)
        },
        onActivity: noteActivity,
        ...(roster.length > 0 ? { roster } : {}),
        ...(entries.claimFiles.length > 0 ? { claimFiles: entries.claimFiles } : {}),
        ...(supersede ? { supersede } : {}),
        ...(authEnv ? { authEnv } : {}),
      })
    } catch (error) {
      result = { ok: false, reason: error instanceof Error ? error.message : String(error) }
    } finally {
      clearTimeout(deadline)
      if (silence !== null) clearTimeout(silence)
      this.activeAbort = null
    }

    // A pass we stopped for taking too long is a FAILURE, not a teardown: the
    // module is marked stale and the queue moves on.
    if (timedOut || stalled) {
      const why = stalled ? 'went quiet and was stopped' : 'took too long and was stopped'
      recordLearnEvent({ at: Date.now(), kind: 'stopped', module: modulePath, detail: why })
      await this.transition(rootPath, modulePath, 'stale')
      this.deps.notify(this.failureToast(rootPath, modulePath, why))
      this.recordBasicDiscovery(job, false)
      this.recordOutcome(false, rootPath)
      return false
    }

    // An intentional teardown (project switch / quit) — don't record 'stale' or
    // toast a cancellation; the module simply stays mid-learn for next session.
    if (abort.signal.aborted || this.disposed) {
      return null
    }

    // Fail-soft adjudication warnings (trust-tiers): a failed adjudicate never
    // fails the learn — log each to the sink and move on.
    for (const warning of result.adjudicationWarnings ?? []) {
      this.onError(`learn adjudication for ${rootPath}/${modulePath}`, warning)
    }

    this.recordOutcome(result.ok, rootPath)
    recordSlow(
      `[learn] ${result.ok ? 'finished' : 'gave up on'} ${modulePath} after ` +
        `${String(Date.now() - (this.activeStartedAt ?? Date.now()))}ms` +
        `${result.ok ? '' : ` (${result.reason ?? 'unknown error'})`}`,
    )
    if (result.ok) {
      recordLearnEvent({ at: Date.now(), kind: 'learned', module: modulePath })
      await this.transition(rootPath, modulePath, 'learned')
    } else {
      recordLearnEvent({
        at: Date.now(),
        kind: 'failed',
        module: modulePath,
        ...(result.reason === undefined ? {} : { detail: result.reason }),
      })
      await this.transition(rootPath, modulePath, 'stale')
      this.deps.notify(this.failureToast(rootPath, modulePath, result.reason ?? 'unknown error'))
    }
    this.recordBasicDiscovery(job, result.ok)
    return result.ok
  }

  /**
   * Upsert a module's learning-state status via full-rewrite dedup. Each store's
   * read-modify-write is SERIALIZED on a per-structureDir chain, so a burst of
   * transitions (e.g. "Learn all" enqueuing every module) applies one-at-a-time —
   * without this, concurrent writers read stale state and the last write clobbers
   * the rest (silent lost updates), and they raced on the temp file (ENOENT).
   *
   * The chain is a THROUGHPUT device, not the invariant. It only knows about
   * this object: a second orchestrator, or a `planflow-ai` verb, is invisible
   * to it. The invariant — read and rewrite in one critical section — belongs
   * to `mutateLearning`, whose lock file every writer on the machine shares.
   * Chaining first is what keeps a "Learn all" burst from queueing hundreds of
   * writers on that lock.
   */
  private async transition(
    rootPath: string,
    modulePath: string,
    status: BlueprintLearningStatus,
    /** The job behind a 'queued'/'learning' write — persisted so a restart can
     *  resume this exact request rather than dropping it (#1132). */
    origin?: Pick<LearnJob, 'reason' | 'deliberate'>,
  ): Promise<void> {
    const structureDir = this.structureDirFor(rootPath)
    const prior = this.transitionChains.get(structureDir) ?? Promise.resolve()
    const run = prior.then(async () => {
      try {
        await this.mutateLearning(structureDir, (existing) => {
          const entry: BlueprintLearningEntry = {
            module: modulePath,
            status,
            notedAt: this.now().toISOString(),
            ...(origin ? { reason: origin.reason, deliberate: origin.deliberate } : {}),
          }
          return [...existing, entry]
        })
      } catch (error) {
        this.onError(`learning-state write failed for ${rootPath}/${modulePath}`, error)
      }
    })
    this.transitionChains.set(structureDir, run)
    await run
  }

  private failureToast(rootPath: string, modulePath: string, reason: string): FlowNotification {
    return {
      kind: 'state-change',
      rootId: rootPath,
      title: 'Learning failed',
      body: `Could not learn ${modulePath}: ${reason}`,
      timestamp: this.now().toISOString(),
      level: 'warn',
    }
  }
}

// ── default module-file enumerator ─────────────────────────────────────────

/** Directory depth cap for the module walk — matches the executor's ranking
 *  budget (a handful of files is enough to summarize a module). */
const ENUMERATE_MAX_DEPTH = 6

/**
 * Default enumerator: ONE walk of the module directory (`<root>/<modulePath>`)
 * collecting BOTH its source files (basic-derive's source-extension +
 * ignored-dir rules — one definition of "source file") and its claim-tier
 * docs/images (learn-session's `isClaimFilePath`, mirroring the CLI's
 * `classifyTier` claim rules) as repo-relative `ModuleFile`s (path + byte
 * size). Fail-soft: unreadable dirs/files are skipped. The caged session runs
 * with cwd = root, so paths are repo-relative (Read resolves them — claim
 * files are readable through the exact same convention as code files).
 * rankModuleFiles / capClaimFiles cap the sets downstream.
 */
export async function defaultEnumerateModuleEntries(
  rootPath: string,
  modulePath: string,
): Promise<ModuleFileEntries> {
  const moduleDir = join(rootPath, modulePath)
  const files: ModuleFile[] = []
  const claimFiles: ModuleFile[] = []
  const walk = async (absDir: string, depth: number): Promise<void> => {
    if (depth > ENUMERATE_MAX_DEPTH) {
      return
    }
    let entries: Dirent[]
    try {
      entries = await fsPromises.readdir(absDir, { withFileTypes: true })
    } catch {
      return // Unreadable dir — skip.
    }
    for (const dirent of entries) {
      const abs = join(absDir, dirent.name)
      if (dirent.isFile()) {
        const relPath = relative(rootPath, abs).split('\\').join('/')
        const isSource = isSourceFileName(dirent.name)
        if (!isSource && !isClaimFilePath(relPath)) {
          continue
        }
        let size = 0
        try {
          size = (await fsPromises.stat(abs)).size
        } catch {
          continue // Vanished/unreadable — skip.
        }
        ;(isSource ? files : claimFiles).push({ path: relPath, size })
      } else if (
        dirent.isDirectory() &&
        isCandidateDir({ name: dirent.name, isDirectory: true, isFile: false })
      ) {
        await walk(abs, depth + 1)
      }
    }
  }
  await walk(moduleDir, 1)
  return { files, claimFiles }
}

/**
 * Back-compat enumerator: source files only (the pre-trust-tiers shape).
 * Delegates to the single walk above.
 */
export async function defaultEnumerateModuleFiles(
  rootPath: string,
  modulePath: string,
): Promise<ModuleFile[]> {
  return (await defaultEnumerateModuleEntries(rootPath, modulePath)).files
}

/**
 * Resolve the constructor's enumerator seam: an injected
 * `enumerateModuleEntries` wins; a legacy injected `enumerateModuleFiles` is
 * adapted (no claim files); otherwise the default single-walk enumerator runs.
 */
function resolveEnumerator(
  deps: LearnOrchestratorDeps,
): (rootPath: string, modulePath: string) => Promise<ModuleFileEntries> {
  if (deps.enumerateModuleEntries) {
    return deps.enumerateModuleEntries
  }
  const legacy = deps.enumerateModuleFiles
  if (legacy) {
    return async (rootPath, modulePath) => ({
      files: await legacy(rootPath, modulePath),
      claimFiles: [],
    })
  }
  return defaultEnumerateModuleEntries
}
