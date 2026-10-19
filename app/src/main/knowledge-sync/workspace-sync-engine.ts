/**
 * THE WORKSPACE SYNC ENGINE — the knowledge sync lifecycle, keyed by WORKSPACE.
 *
 * A project linked into a Workspace has no knowledge repository of its own:
 * its `flow/` is a link into the Workspace folder, which is ONE git repository
 * for every project in it. This engine keeps one record per Workspace and runs
 * the same lifecycle the per-project engine runs (sync-engine.ts) — on open,
 * after a turn, on "Sync now", a retry when the host can't be reached, a
 * bounded last COMMIT on quit — but every step is ONE call to the CLI door:
 *
 *     planflow-ai workspace sync --workspace <slug> --message=<label> --json
 *
 * Rules that shape the code:
 *
 *  · THE CLI IS THE SOURCE OF TRUTH (allowed-pattern #14). Nothing here runs
 *    git, reads the Workspace folder, or decides what merges. The CLI commits,
 *    fetches, merges safely, asks, and pushes; this engine schedules it and
 *    turns its JSON into a status. Async, bounded, never synchronous
 *    (allowed-pattern #19).
 *  · ONE QUEUE PER WORKSPACE. Two syncs of one Workspace never overlap (the
 *    CLI would refuse the second with `sync-busy` anyway).
 *  · N TURNS → ONE SYNC. The first finished turn arms a timer; turns that end
 *    before it fires join it. One CLI run commits all of them, so a long
 *    session does not fetch once per turn — and a busy one is never starved.
 *  · A PAUSE WAITS FOR A PERSON. `ask` and `review` become `paused` with the
 *    payload. Nothing retries a paused Workspace on its own: a turn, an open
 *    and a timer all leave it alone. Only "Sync now" or a decision (`resolve`)
 *    runs it again, and the pause clears when the CLI no longer asks.
 *  · `no-access` (the shared repository refused this person's access) waits
 *    for a person like a pause: no back-off, no timer, no turn or open runs
 *    it; "Sync now" tries again. One notification, on the transition.
 *  · QUIT NEVER STARTS A NETWORK MERGE. It runs `workspace sync --commit-only`
 *    for each Workspace with turns waiting — commit, nothing else — and the
 *    next open exchanges them.
 *  · `offline` retries on the per-project engine's back-off; `behind` (the
 *    repository kept moving) and `sync-busy` (another sync of this Workspace
 *    is running on this computer) retry ONCE; every other refusal is `error`
 *    with one plain sentence.
 *  · TEXT IS OURS. The CLI writes for terminal users and its `detail` can carry
 *    git output and folder names: it goes to the log, never to a status
 *    (forbidden-pattern #12). Every sentence here names the Workspace by name.
 *  · Status is emitted ONLY when it changed, and only that Workspace's
 *    (allowed-pattern #17).
 *  · `lastSyncedAt` survives a restart: it is written through the injected
 *    store (app settings rows — no schema change).
 *
 * Nothing here throws to its caller: every failure becomes a status.
 */

import { RETRY_BASE_MS, RETRY_MAX_MS, OPEN_SYNC_COOLDOWN_MS, PUSH_DEBOUNCE_MS, QUIT_PUSH_TIMEOUT_MS, commitMessage, type EngineTimers } from './sync-timing'
import { lastJsonLine } from '../workspaces/cli-json'
import type {
  WorkspaceResolveRequest,
  WorkspaceResolveResult,
  WorkspaceSyncAsk,
  WorkspaceSyncReview,
  WorkspaceSyncState,
  WorkspaceSyncStatus,
  WorkspaceSyncTake,
} from '../../shared/workspaces-contract'

/** A `workspace sync` run: commit, fetch and push all over the network — generous, still bounded. */
export const WORKSPACE_SYNC_TIMEOUT_MS = 5 * 60_000
/** The first finished turn arms this; later turns join it. */
export const TURN_SYNC_DELAY_MS = PUSH_DEBOUNCE_MS
/** `behind` / `sync-busy`: the one retry comes this much later. */
export const ONE_RETRY_MS = RETRY_BASE_MS
/** Quit waits at most this long for the last commits (the per-project engine's bound). */
export const QUIT_SYNC_TIMEOUT_MS = QUIT_PUSH_TIMEOUT_MS
/**
 * The CLI's own bound on a commit-only run. Longer than the quit wait on
 * purpose: quit stops WAITING at its bound, but a commit killed half-way would
 * leave git's index lock behind.
 */
export const COMMIT_ONLY_TIMEOUT_MS = 60_000

const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const MAX_SLUG_LENGTH = 64

const OPEN_LABEL = 'changes since the last sync'
const SYNC_NOW_LABEL = 'sync requested'
const QUIT_LABEL = 'changes before closing'
/** How many turn labels one commit message names before it just counts them. */
const MAX_NAMED_TURNS = 3

const TAKES: readonly WorkspaceSyncTake[] = ['ours', 'theirs', 'merged', 'file']
const ASK_KINDS: readonly WorkspaceSyncAsk['kind'][] = ['decision', 'same-feature', 'overlapping-anchors', 'same-discovery']
const REVIEW_KINDS: readonly WorkspaceSyncReview['kind'][] = ['conflict', 'add-add', 'modify-delete']

export function isWorkspaceSlug(value: string): boolean {
  return value.length <= MAX_SLUG_LENGTH && SLUG_PATTERN.test(value)
}

// ── Dependencies ────────────────────────────────────────────────────────────

/** Structurally `CliRunResult` / `WorkspaceCliRun`. */
export interface WorkspaceSyncCliRun {
  ok: boolean
  stdout: string
  error?: string
  stderr?: string
}

/** Runs the bundled CLI in `cwd`; never rejects (runBundledCliCapturing). */
export type WorkspaceSyncCliRunner = (
  cwd: string,
  args: readonly string[],
  options: { timeoutMs: number },
) => Promise<WorkspaceSyncCliRun>

/** Where `lastSyncedAt` is kept across restarts (epoch ms). */
export interface LastSyncedStore {
  get(id: string): number | null
  set(id: string, at: number): void
}

/** A merged text handed to the CLI as `file:<path>`, removed afterwards. */
export interface TempText {
  path: string
  dispose(): Promise<void>
}

/** Every dependency is REQUIRED (allowed-pattern #26): no silent real default. */
export interface WorkspaceSyncEngineDeps {
  /** The ONLY way anything is synced: the bundled CLI. */
  runCli: WorkspaceSyncCliRunner
  /** Where the verb runs (it names its Workspace; the person's home folder). */
  cwd: string
  lastSynced: LastSyncedStore
  /** Write a merged text somewhere private for the CLI to read. */
  writeTempText: (text: string) => Promise<TempText>
  now: () => number
  timers: EngineTimers
  /** The Workspace's display name (from workspace.json), so a refusal — which carries
   *  no name — never shows the slug to a person. Null when unknown. */
  nameOf: (slug: string) => Promise<string | null>
  /** A Workspace's status changed. Called only on a real change. */
  /** `name` is null until the Workspace's name is known — never its folder slug. */
  onStatus: (slug: string, name: string | null, status: WorkspaceSyncStatus) => void
  /** Diagnostics only (the CLI's own words); never UI. */
  log: (message: string, detail?: Record<string, unknown>) => void
}

export interface WorkspaceSyncEngine {
  /** Sync on open — skipped within the cooldown of a complete sync, and while paused. */
  open(slug: string): Promise<void>
  /** A turn finished writing this Workspace's knowledge: one sync follows, however many turns end meanwhile. */
  commitAfterTurn(slug: string, label: string): void
  /** Commit, bring in, send — now. A person asked, so a pause or an error is tried again. */
  syncNow(slug: string): Promise<WorkspaceSyncStatus>
  /** Apply a person's decision about one paused item, then sync again. */
  resolve(request: WorkspaceResolveRequest): Promise<WorkspaceResolveResult>
  /** The Workspace's current status. Reading it starts nothing. */
  status(slug: string): WorkspaceSyncStatus
  /** The Workspace left this computer: clear its timers and drop its record. */
  forget(slug: string): void
  /** One commit-only run per Workspace with turns waiting (no network). Never waits longer than QUIT_SYNC_TIMEOUT_MS. */
  quit(): Promise<void>
}

// ── Reading the CLI's answer — rebuilt field by field ──────────────────────

type Json = Record<string, unknown>

class MalformedAnswer extends Error {}

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function text(value: unknown, what: string): string {
  if (typeof value !== 'string') throw new MalformedAnswer(what)
  return value
}

function textOrNull(value: unknown, what: string): string | null {
  if (value === null || value === undefined) return null
  return text(value, what)
}

function takes(value: unknown): WorkspaceSyncTake[] {
  if (!Array.isArray(value)) throw new MalformedAnswer('options')
  return value.filter((entry): entry is WorkspaceSyncTake => (TAKES as readonly unknown[]).includes(entry))
}

function readAsk(value: unknown): WorkspaceSyncAsk {
  if (!isRecord(value)) throw new MalformedAnswer('ask')
  const kind = value['kind']
  if (!(ASK_KINDS as readonly unknown[]).includes(kind)) throw new MalformedAnswer('ask.kind')
  const ask: WorkspaceSyncAsk = {
    id: text(value['id'], 'ask.id'),
    kind: kind as WorkspaceSyncAsk['kind'],
    topic: text(value['topic'], 'ask.topic'),
    path: text(value['path'], 'ask.path'),
    existingPath: text(value['existingPath'], 'ask.existingPath'),
    existing: textOrNull(value['existing'], 'ask.existing'),
    incoming: textOrNull(value['incoming'], 'ask.incoming'),
    merged: textOrNull(value['merged'], 'ask.merged'),
    truncated: value['truncated'] === true,
    options: takes(value['options']),
  }
  const anchors = value['anchors']
  if (Array.isArray(anchors)) ask.anchors = anchors.filter((anchor): anchor is string => typeof anchor === 'string')
  return ask
}

function readReview(value: unknown): WorkspaceSyncReview {
  if (!isRecord(value)) throw new MalformedAnswer('review')
  const kind = value['kind']
  if (!(REVIEW_KINDS as readonly unknown[]).includes(kind)) throw new MalformedAnswer('review.kind')
  return {
    id: text(value['id'], 'review.id'),
    kind: kind as WorkspaceSyncReview['kind'],
    path: text(value['path'], 'review.path'),
    base: textOrNull(value['base'], 'review.base'),
    existing: textOrNull(value['existing'], 'review.existing'),
    incoming: textOrNull(value['incoming'], 'review.incoming'),
    conflicted: textOrNull(value['conflicted'], 'review.conflicted'),
    truncated: value['truncated'] === true,
    options: takes(value['options']),
  }
}

const CLI_STATES = ['synced', 'local-only', 'nothing-to-do', 'ask', 'review', 'behind', 'offline', 'no-access', 'committed'] as const
type CliState = (typeof CLI_STATES)[number]

interface CliResult {
  state: CliState
  name: string | null
  ahead: number
  asks: WorkspaceSyncAsk[]
  reviews: WorkspaceSyncReview[]
}

type CliOutcome = { kind: 'result'; result: CliResult } | { kind: 'refused'; reason: string } | { kind: 'unavailable' }

function readResult(payload: Json): CliResult {
  const state = payload['state']
  if (!(CLI_STATES as readonly unknown[]).includes(state)) throw new MalformedAnswer('state')
  const workspace = payload['workspace']
  const asks = payload['asks']
  const reviews = payload['reviews']
  if (!Array.isArray(asks) || !Array.isArray(reviews)) throw new MalformedAnswer('asks/reviews')
  const ahead = payload['ahead']
  return {
    state: state as CliState,
    name: isRecord(workspace) && typeof workspace['name'] === 'string' ? workspace['name'] : null,
    ahead: typeof ahead === 'number' && Number.isFinite(ahead) && ahead > 0 ? Math.floor(ahead) : 0,
    asks: asks.map(readAsk),
    reviews: reviews.map(readReview),
  }
}

// ── Sentences — the only words a status carries ────────────────────────────

/** Plain sentences, the Workspace named by its name. No paths, commands or setting names (forbidden-pattern #12). */
export const WORKSPACE_SYNC_SENTENCES = {
  askDecision: (name: string) => `Two people changed the same decision in ${name}. Flow needs you to choose which one to keep.`,
  askTopic: (name: string) => `Two people wrote about the same topic in ${name}. Flow needs you to choose which one to keep.`,
  review: (name: string) => `The same note changed on two computers in ${name}. Flow needs you to choose what it should say.`,
  offline: (name: string) =>
    `Flow couldn't reach ${name}'s shared repository. Your changes are kept on this computer, and Flow will try again.`,
  noAccess: (name: string) => `Flow can't reach ${name}'s shared repository with your access.`,
  behind: (name: string) => `${name}'s shared repository changed while Flow was syncing. Flow will try again shortly.`,
  localOnly: (name: string) => `${name} has no shared repository yet, so its knowledge stays on this computer.`,
  busy: (name: string) => `${name} is already being synced on this computer. Flow will try again shortly.`,
  personalFiles: (name: string) =>
    `Some of the changes in ${name} are personal files that are never shared, so nothing was sent.`,
  noIdentity: (name: string) => `Git doesn't know your name on this computer yet, so Flow can't save ${name}'s knowledge in your name.`,
  mergeInProgress: (name: string) => `A merge was left unfinished in ${name}, so Flow won't sync over it.`,
  notOnBranch: (name: string) => `${name}'s knowledge isn't on a branch, so Flow can't sync it.`,
  badRemote: (name: string) => `${name}'s shared repository address isn't one Flow can use.`,
  notARepo: (name: string) => `${name}'s knowledge folder isn't a repository Flow can sync.`,
  commitFailed: (name: string) => `Flow couldn't save the changes in ${name}. Nothing was sent.`,
  mergeFailed: (name: string) => `Flow couldn't bring in ${name}'s latest changes. Nothing was sent.`,
  unknown: (name: string) => `${name} isn't a Workspace Flow can read on this computer.`,
  failed: (name: string) => `Flow couldn't sync ${name} just now. Try again in a moment.`,
  notWaiting: (name: string) => `Nothing in ${name} is waiting for that decision any more.`,
  stale: 'This changed since you looked at it. Here is what is waiting now — choose again.',
  incomingUnsafe: (name: string) =>
    `The shared repository for ${name} now contains files Flow won't bring onto this computer.`,
  remoteRewritten: (name: string) =>
    `Someone rewrote the shared history of ${name}. Flow stopped so nothing is lost; ask whoever manages it.`,
  unrelatedHistory: (name: string) =>
    `The shared repository for ${name} already holds a different history, so Flow won't mix the two. Connect ${name} to an empty repository, or join the Workspace it holds instead.`,
  invalidTake: 'That choice can\'t settle this item.',
  unknownWorkspace: "That Workspace isn't on this computer.",
} as const

/**
 * What a sentence calls a Workspace whose name is not known yet. NEVER the
 * folder slug: a slug is an internal address, not something a person named.
 */
export const UNNAMED_WORKSPACE = 'the Workspace'

function nameIn(rec: { name: string | null }): string {
  return rec.name ?? UNNAMED_WORKSPACE
}

function refusalSentence(reason: string, name: string): string {
  const s = WORKSPACE_SYNC_SENTENCES
  switch (reason) {
    case 'personal-files':
      return s.personalFiles(name)
    case 'no-identity':
      return s.noIdentity(name)
    case 'merge-in-progress':
      return s.mergeInProgress(name)
    case 'detached-head':
      return s.notOnBranch(name)
    case 'invalid-remote':
      return s.badRemote(name)
    case 'not-a-git-repo':
      return s.notARepo(name)
    case 'commit-failed':
      return s.commitFailed(name)
    case 'merge-failed':
      return s.mergeFailed(name)
    case 'incoming-unsafe':
      return s.incomingUnsafe(name)
    case 'remote-rewritten':
      return s.remoteRewritten(name)
    case 'unrelated-history':
      return s.unrelatedHistory(name)
    case 'no-workspace':
    case 'which-workspace':
    case 'unknown-workspace':
    case 'malformed-workspace':
      return s.unknown(name)
    default:
      return s.failed(name)
  }
}

function pausedSentence(name: string, asks: readonly WorkspaceSyncAsk[]): string {
  if (asks.length === 0) return WORKSPACE_SYNC_SENTENCES.review(name)
  return asks.some((ask) => ask.kind === 'decision') ? WORKSPACE_SYNC_SENTENCES.askDecision(name) : WORKSPACE_SYNC_SENTENCES.askTopic(name)
}

/** One commit message for every turn a sync carries. */
export function turnsMessage(labels: readonly string[]): string {
  const distinct = [...new Set(labels)]
  if (distinct.length === 0) return commitMessage(OPEN_LABEL)
  if (distinct.length <= MAX_NAMED_TURNS) return commitMessage(distinct.join('; '))
  return commitMessage(`${labels.length} turns`)
}

// ── Engine ──────────────────────────────────────────────────────────────────

interface WorkspaceRecord {
  slug: string
  /** The Workspace's name from the last CLI answer; null until then (never the slug). */
  name: string | null
  state: WorkspaceSyncState
  lastSyncedAt: number | null
  detail: string | null
  asks: WorkspaceSyncAsk[]
  reviews: WorkspaceSyncReview[]
  /** Commits here the shared repository doesn't have (from the last answer). */
  ahead: number
  queue: Promise<void>
  openInFlight: Promise<void> | null
  turnTimer: unknown
  /** Labels of the turns the next sync carries. */
  turnLabels: string[]
  retryTimer: unknown
  retryAttempt: number
  lastEmitted: string
  forgotten: boolean
}

interface RunOptions {
  message: string
  timeoutMs: number
  resolve?: { path: string; id: string; take: string }
  /** `--commit-only`: commit, nothing else. */
  commitOnly?: boolean
}

const IDLE_STATUS = (lastSyncedAt: number | null): WorkspaceSyncStatus => ({
  state: 'idle',
  lastSyncedAt: lastSyncedAt === null ? null : new Date(lastSyncedAt).toISOString(),
  detail: null,
  asks: [],
  reviews: [],
})

export function createWorkspaceSyncEngine(deps: WorkspaceSyncEngineDeps): WorkspaceSyncEngine {
  const records = new Map<string, WorkspaceRecord>()
  let closed = false
  let silenced = false

  function storedLastSynced(slug: string): number | null {
    try {
      return deps.lastSynced.get(slug)
    } catch (error) {
      deps.log('reading the last sync time failed', { slug, error: String(error) })
      return null
    }
  }

  function record(slug: string): WorkspaceRecord {
    let rec = records.get(slug)
    if (rec === undefined) {
      rec = {
        slug,
        name: null,
        state: 'idle',
        lastSyncedAt: storedLastSynced(slug),
        detail: null,
        asks: [],
        reviews: [],
        ahead: 0,
        queue: Promise.resolve(),
        openInFlight: null,
        turnTimer: null,
        turnLabels: [],
        retryTimer: null,
        retryAttempt: 0,
        lastEmitted: '',
        forgotten: false,
      }
      rec.lastEmitted = JSON.stringify(statusOf(rec))
      records.set(slug, rec)
    }
    return rec
  }

  function statusOf(rec: WorkspaceRecord): WorkspaceSyncStatus {
    return {
      state: rec.state,
      lastSyncedAt: rec.lastSyncedAt === null ? null : new Date(rec.lastSyncedAt).toISOString(),
      detail: rec.detail,
      asks: rec.asks.map((ask) => ({ ...ask, options: [...ask.options], ...(ask.anchors === undefined ? {} : { anchors: [...ask.anchors] }) })),
      reviews: rec.reviews.map((review) => ({ ...review, options: [...review.options] })),
    }
  }

  function emitIfChanged(rec: WorkspaceRecord): void {
    if (silenced || rec.forgotten) return
    const next = statusOf(rec)
    const serialized = JSON.stringify(next)
    if (serialized === rec.lastEmitted) return
    rec.lastEmitted = serialized
    try {
      deps.onStatus(rec.slug, rec.name, next)
    } catch (error) {
      deps.log('status listener failed', { error: String(error) })
    }
  }

  function set(rec: WorkspaceRecord, state: WorkspaceRecord['state'], detail: string | null, items?: { asks: WorkspaceSyncAsk[]; reviews: WorkspaceSyncReview[] }): void {
    rec.state = state
    // A sentence may open with the Workspace's stand-in name ("the Workspace").
    rec.detail = detail === null || detail === '' ? detail : `${detail.charAt(0).toUpperCase()}${detail.slice(1)}`
    if (items !== undefined) {
      rec.asks = items.asks
      rec.reviews = items.reviews
    } else if (state !== 'syncing') {
      rec.asks = []
      rec.reviews = []
    }
    emitIfChanged(rec)
  }

  function synced(rec: WorkspaceRecord): void {
    rec.lastSyncedAt = deps.now()
    try {
      deps.lastSynced.set(rec.slug, rec.lastSyncedAt)
    } catch (error) {
      deps.log('keeping the last sync time failed', { slug: rec.slug, error: String(error) })
    }
  }

  function enqueue(rec: WorkspaceRecord, work: () => Promise<void>): Promise<void> {
    const run = rec.queue.then(work, work).catch((error: unknown) => {
      deps.log('workspace sync step failed', { slug: rec.slug, error: String(error) })
    })
    rec.queue = run
    return run
  }

  function clearTimer(handle: unknown): null {
    if (handle !== null) deps.timers.clearTimeout(handle)
    return null
  }

  function clearTimers(rec: WorkspaceRecord): void {
    rec.turnTimer = clearTimer(rec.turnTimer)
    rec.retryTimer = clearTimer(rec.retryTimer)
  }

  /** Every timer re-checks before it acts: the Workspace may be gone, the app may be closing. */
  function mayRun(rec: WorkspaceRecord): boolean {
    return !closed && !rec.forgotten
  }

  // ── One CLI run ──

  async function callCli(rec: WorkspaceRecord, options: RunOptions): Promise<CliOutcome> {
    if (rec.name === null) {
      const known = await deps.nameOf(rec.slug).catch(() => null)
      if (known !== null && known.trim() !== '') rec.name = known
    }
    const args = ['workspace', 'sync', '--workspace', rec.slug, `--message=${options.message}`]
    if (options.commitOnly === true) args.push('--commit-only')
    if (options.resolve !== undefined) {
      // The item's id pins the decision to exactly what the person saw.
      args.push(`--resolve=${options.resolve.path}`, `--id=${options.resolve.id}`, `--take=${options.resolve.take}`)
    }
    args.push('--json')
    const run = await deps.runCli(deps.cwd, args, { timeoutMs: options.timeoutMs })
    const payload = lastJsonLine(run.stdout)
    if (run.ok && payload !== null && payload['action'] === 'sync' && typeof payload['refused'] !== 'string') {
      try {
        return { kind: 'result', result: readResult(payload) }
      } catch (error) {
        deps.log('workspace sync answered in a shape this build cannot read', { slug: rec.slug, field: (error as Error).message })
        return { kind: 'unavailable' }
      }
    }
    if (!run.ok && payload !== null && typeof payload['refused'] === 'string') {
      // The CLI's sentence is for terminal users: it stays in the log.
      deps.log('workspace sync refused', { slug: rec.slug, reason: payload['refused'], detail: payload['detail'] })
      return { kind: 'refused', reason: payload['refused'] }
    }
    deps.log('workspace sync gave no usable answer', { slug: rec.slug, error: run.error, stderr: run.stderr })
    return { kind: 'unavailable' }
  }

  function scheduleRetry(rec: WorkspaceRecord, delay: number): void {
    if (closed || rec.forgotten) return
    rec.retryTimer = clearTimer(rec.retryTimer)
    rec.retryTimer = deps.timers.setTimeout(() => {
      rec.retryTimer = null
      if (!mayRun(rec)) return
      void enqueue(rec, () => background(rec, OPEN_LABEL))
    }, delay)
  }

  function scheduleBackoff(rec: WorkspaceRecord): void {
    const delay = Math.min(RETRY_BASE_MS * 2 ** rec.retryAttempt, RETRY_MAX_MS)
    rec.retryAttempt += 1
    scheduleRetry(rec, delay)
  }

  /**
   * Run the verb and fold its answer into the record. `retryOnce` says whether
   * a `behind` / `sync-busy` answer may schedule its one retry (false for the
   * retry itself, so it is ONE).
   */
  async function sync(rec: WorkspaceRecord, options: RunOptions, retryOnce: boolean): Promise<CliOutcome> {
    rec.retryTimer = clearTimer(rec.retryTimer)
    const carried = rec.turnLabels.length
    set(rec, 'syncing', null, { asks: rec.asks, reviews: rec.reviews })
    const outcome = await callCli(rec, options)
    if (rec.forgotten) return outcome
    if (outcome.kind === 'unavailable') {
      set(rec, 'error', WORKSPACE_SYNC_SENTENCES.failed(nameIn(rec)))
      return outcome
    }
    if (outcome.kind === 'refused') {
      if (outcome.reason === 'sync-busy') {
        set(rec, 'idle', WORKSPACE_SYNC_SENTENCES.busy(nameIn(rec)))
        if (retryOnce) scheduleRetry(rec, ONE_RETRY_MS)
        return outcome
      }
      if (outcome.reason === 'nothing-to-resolve' || outcome.reason === 'invalid-resolution' || outcome.reason === 'stale-decision') {
        return outcome
      }
      set(rec, 'error', refusalSentence(outcome.reason, nameIn(rec)))
      return outcome
    }
    const result = outcome.result
    if (result.name !== null) rec.name = result.name
    rec.ahead = result.ahead
    // Every turn carried so far is committed (or waiting on a person's decision, which commits it).
    rec.turnLabels.splice(0, carried)
    switch (result.state) {
      case 'synced':
      case 'nothing-to-do':
        rec.retryAttempt = 0
        synced(rec)
        set(rec, 'synced', null)
        break
      case 'local-only':
        rec.retryAttempt = 0
        set(rec, 'local-only', WORKSPACE_SYNC_SENTENCES.localOnly(nameIn(rec)))
        break
      case 'ask':
      case 'review':
        // A PAUSE: nothing is armed, nothing retries on its own.
        clearTimers(rec)
        set(rec, 'paused', pausedSentence(nameIn(rec), result.asks), { asks: result.asks, reviews: result.reviews })
        break
      case 'offline':
        set(rec, 'offline', WORKSPACE_SYNC_SENTENCES.offline(nameIn(rec)))
        scheduleBackoff(rec)
        break
      case 'no-access':
        // Waits for a person: retrying cannot grant access. "Sync now" tries again.
        clearTimers(rec)
        rec.retryAttempt = 0
        set(rec, 'no-access', WORKSPACE_SYNC_SENTENCES.noAccess(nameIn(rec)))
        break
      case 'committed':
        // Only a commit-only run answers this; nothing was exchanged.
        set(rec, 'idle', null)
        break
      case 'behind':
        set(rec, 'idle', WORKSPACE_SYNC_SENTENCES.behind(nameIn(rec)))
        if (retryOnce) scheduleRetry(rec, ONE_RETRY_MS)
        break
    }
    return outcome
  }

  /** Waiting for a person: a decision, or access only they can fix. */
  function waitsForPerson(rec: WorkspaceRecord): boolean {
    return rec.state === 'paused' || rec.state === 'no-access'
  }

  /** A sync nobody asked for: never over a pause or refused access, never while off. */
  async function background(rec: WorkspaceRecord, label: string, retryOnce = false): Promise<void> {
    if (!mayRun(rec) || waitsForPerson(rec)) return
    const message = rec.turnLabels.length > 0 ? turnsMessage(rec.turnLabels) : commitMessage(label)
    await sync(rec, { message, timeoutMs: WORKSPACE_SYNC_TIMEOUT_MS }, retryOnce)
  }

  // ── Public API ──

  function recentlySynced(rec: WorkspaceRecord): boolean {
    return rec.state === 'synced' && rec.lastSyncedAt !== null && deps.now() - rec.lastSyncedAt < OPEN_SYNC_COOLDOWN_MS
  }

  function open(slug: string): Promise<void> {
    if (closed || !isWorkspaceSlug(slug)) return Promise.resolve()
    const rec = record(slug)
    if (rec.openInFlight !== null) return rec.openInFlight
    const run = enqueue(rec, async () => {
      if (waitsForPerson(rec) || recentlySynced(rec)) return
      await background(rec, OPEN_LABEL, true)
    }).finally(() => {
      if (rec.openInFlight === run) rec.openInFlight = null
    })
    rec.openInFlight = run
    return run
  }

  function commitAfterTurn(slug: string, label: string): void {
    if (closed || !isWorkspaceSlug(slug)) return
    const rec = record(slug)
    rec.turnLabels.push(label)
    // A pause waits for a person: the turn is carried by the sync that settles it.
    if (waitsForPerson(rec)) return
    // ARMED ONCE: turns that end before it fires join this sync.
    if (rec.turnTimer !== null) return
    rec.turnTimer = deps.timers.setTimeout(() => {
      rec.turnTimer = null
      if (!mayRun(rec)) return
      void enqueue(rec, () => background(rec, OPEN_LABEL, true))
    }, TURN_SYNC_DELAY_MS)
  }

  async function syncNow(slug: string): Promise<WorkspaceSyncStatus> {
    if (!isWorkspaceSlug(slug)) return IDLE_STATUS(null)
    const rec = record(slug)
    await enqueue(rec, async () => {
      if (closed || rec.forgotten) return
      clearTimers(rec)
      rec.retryAttempt = 0
      const message = rec.turnLabels.length > 0 ? turnsMessage(rec.turnLabels) : commitMessage(SYNC_NOW_LABEL)
      await sync(rec, { message, timeoutMs: WORKSPACE_SYNC_TIMEOUT_MS }, true)
    })
    return statusOf(rec)
  }

  async function resolve(request: WorkspaceResolveRequest): Promise<WorkspaceResolveResult> {
    const { slug } = request
    if (!isWorkspaceSlug(slug)) {
      return { ok: false, reason: 'unknown-workspace', detail: WORKSPACE_SYNC_SENTENCES.unknownWorkspace, status: IDLE_STATUS(null) }
    }
    const rec = record(slug)
    let answer: WorkspaceResolveResult | null = null
    await enqueue(rec, async () => {
      const waiting = [...rec.asks, ...rec.reviews]
      const item =
        request.id !== undefined
          ? waiting.find((candidate) => candidate.id === request.id)
          : waiting.find((candidate) => candidate.path === request.path)
      if (rec.state !== 'paused' || item === undefined) {
        answer = { ok: false, reason: 'not-waiting', detail: WORKSPACE_SYNC_SENTENCES.notWaiting(nameIn(rec)), status: statusOf(rec) }
        return
      }
      const wanted: WorkspaceSyncTake = request.take === 'text' ? 'file' : request.take
      if (!item.options.includes(wanted)) {
        answer = { ok: false, reason: 'invalid-take', detail: WORKSPACE_SYNC_SENTENCES.invalidTake, status: statusOf(rec) }
        return
      }
      let temp: TempText | null = null
      try {
        if (request.take === 'text') temp = await deps.writeTempText(request.text)
        const take = temp === null ? request.take : `file:${temp.path}`
        const message = rec.turnLabels.length > 0 ? turnsMessage(rec.turnLabels) : commitMessage(SYNC_NOW_LABEL)
        const outcome = await sync(
          rec,
          { message, timeoutMs: WORKSPACE_SYNC_TIMEOUT_MS, resolve: { path: item.path, id: item.id, take } },
          true,
        )
        if (outcome.kind === 'refused' && outcome.reason === 'stale-decision') {
          // The item changed since the person looked: read where things stand
          // and show the card again with what is waiting NOW.
          await sync(rec, { message, timeoutMs: WORKSPACE_SYNC_TIMEOUT_MS }, true)
          answer = { ok: false, reason: 'stale', detail: WORKSPACE_SYNC_SENTENCES.stale, status: statusOf(rec) }
          return
        }
        if (outcome.kind === 'refused' && outcome.reason === 'nothing-to-resolve') {
          // The question is gone (settled elsewhere, or the remote moved): an ordinary sync says where things stand.
          await sync(rec, { message, timeoutMs: WORKSPACE_SYNC_TIMEOUT_MS }, true)
          answer = { ok: false, reason: 'not-waiting', detail: WORKSPACE_SYNC_SENTENCES.notWaiting(nameIn(rec)), status: statusOf(rec) }
          return
        }
        if (outcome.kind === 'refused' && outcome.reason === 'invalid-resolution') {
          // Still paused on the same items: the CLI did not accept this choice.
          set(rec, 'paused', pausedSentence(nameIn(rec), rec.asks), { asks: rec.asks, reviews: rec.reviews })
          answer = { ok: false, reason: 'invalid-take', detail: WORKSPACE_SYNC_SENTENCES.invalidTake, status: statusOf(rec) }
          return
        }
        if (outcome.kind !== 'result') {
          answer = { ok: false, reason: 'failed', detail: rec.detail ?? WORKSPACE_SYNC_SENTENCES.failed(nameIn(rec)), status: statusOf(rec) }
          return
        }
        answer = { ok: true, status: statusOf(rec) }
      } catch (error) {
        deps.log('applying a workspace decision failed', { slug, error: String(error) })
        answer = { ok: false, reason: 'failed', detail: WORKSPACE_SYNC_SENTENCES.failed(nameIn(rec)), status: statusOf(rec) }
      } finally {
        if (temp !== null) await temp.dispose().catch(() => undefined)
      }
    })
    return answer ?? { ok: false, reason: 'failed', detail: WORKSPACE_SYNC_SENTENCES.failed(nameIn(rec)), status: statusOf(rec) }
  }

  function status(slug: string): WorkspaceSyncStatus {
    if (!isWorkspaceSlug(slug)) return IDLE_STATUS(null)
    const rec = records.get(slug)
    // Reading never creates a record: the renderer may ask about any name.
    return rec === undefined ? IDLE_STATUS(storedLastSynced(slug)) : statusOf(rec)
  }

  function forget(slug: string): void {
    const rec = records.get(slug)
    if (rec === undefined) return
    clearTimers(rec)
    rec.forgotten = true
    records.delete(slug)
  }

  /** Commit what the turns wrote — nothing else: closing never starts a network merge. */
  async function commitBeforeClosing(rec: WorkspaceRecord): Promise<void> {
    const carried = rec.turnLabels.length
    const message = carried > 0 ? turnsMessage(rec.turnLabels) : commitMessage(QUIT_LABEL)
    const outcome = await callCli(rec, { message, timeoutMs: COMMIT_ONLY_TIMEOUT_MS, commitOnly: true })
    if (outcome.kind === 'result') rec.turnLabels.splice(0, carried)
  }

  async function quit(): Promise<void> {
    closed = true
    const attempts: Promise<void>[] = []
    for (const rec of records.values()) {
      // Only uncommitted work: commits already made wait for the next open to be sent.
      const waiting = rec.turnLabels.length > 0 || rec.turnTimer !== null
      clearTimers(rec)
      if (!waiting) continue
      // Local and safe in every state — a pause, refused access or an error included.
      attempts.push(enqueue(rec, () => commitBeforeClosing(rec)))
    }
    if (attempts.length > 0) {
      let timer: unknown = null
      let timedOut = false
      await Promise.race([
        Promise.allSettled(attempts).then(() => undefined),
        new Promise<void>((resolveTimeout) => {
          timer = deps.timers.setTimeout(() => {
            timedOut = true
            resolveTimeout()
          }, QUIT_SYNC_TIMEOUT_MS)
        }),
      ])
      if (timer !== null) deps.timers.clearTimeout(timer)
      // NOT killed at this bound: a commit stopped half-way would leave git's
      // index lock behind. It finishes on its own (bounded by COMMIT_ONLY_TIMEOUT_MS); we stop waiting.
      if (timedOut) deps.log('quit: stopped waiting for the Workspace commits still running', { count: attempts.length })
    }
    silenced = true
  }

  return { open, commitAfterTurn, syncNow, resolve, status, forget, quit }
}
