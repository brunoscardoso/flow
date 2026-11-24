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
 *  · `no-access` (the shared repository refused the sync — this person's
 *    access, or a policy such as an author-email rule or pull-request-only
 *    branch, named by the CLI's `rejection`) waits for a person like a pause:
 *    no back-off, no timer, no turn or open runs it; "Sync now" tries again.
 *    One notification, on the transition.
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
 *  · PROMOTION BEFORE SYNC (FR-7). `open`, "Sync now" and a 10-minute timer
 *    per opened Workspace run the CLI's `workspace promote` first, inside the
 *    Workspace's queue — so it never overlaps a sync, at most one is in
 *    flight, and a cooldown keeps open + timer from running it twice. Never
 *    while the sync waits for a person. A failure is logged and the sync runs
 *    anyway; a promotion that decided anything is carried by a sync (the
 *    status log is append-only and synced like every other file).
 *  · A PAUSE MADE ONLY OF INTENT DOCUMENTS IS MERGED BY AN AGENT (FR-12,
 *    intent-merge.ts): every text first, then every resolve, then one
 *    notification with Undo. Anything the agent cannot merge stays a pause.
 *    Undo and "keep yours / theirs" put a document back as a NEW commit
 *    through the CLI (`--put-back`), then sync — never a force push.
 *
 * Nothing here throws to its caller: every failure becomes a status.
 */

import { RETRY_BASE_MS, RETRY_MAX_MS, OPEN_SYNC_COOLDOWN_MS, PUSH_DEBOUNCE_MS, QUIT_PUSH_TIMEOUT_MS, commitMessage, type EngineTimers } from './sync-timing'
import { createHash } from 'node:crypto'

import { lastJsonLine } from '../workspaces/cli-json'
import { settleIntentAsks, type IntentItem, type IntentMergeDeps } from './intent-merge'
import type {
  IntentMergeKeep,
  WorkspaceIntentMergeSet,
  WorkspaceIntentMergesRequest,
  WorkspaceKeepIntentRequest,
  WorkspaceKeepIntentResult,
  WorkspaceResolveRequest,
  WorkspaceResolveResult,
  WorkspaceSyncAsk,
  WorkspaceSyncReview,
  WorkspaceSyncCause,
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
/** `workspace promote`: one fetch per project with drafts plus host questions — bounded well below a sync. */
export const PROMOTE_TIMEOUT_MS = 2 * 60_000
/** While a Workspace is open, promotion runs this often (FR-7). */
export const PROMOTE_INTERVAL_MS = 10 * 60_000
/** A promotion started this recently is not started again by an open or the timer. */
export const PROMOTE_COOLDOWN_MS = 5 * 60_000
/** How many merge sets per Workspace this computer keeps for Undo / "See both". */
const KEPT_MERGE_SETS = 5

const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const MAX_SLUG_LENGTH = 64

const OPEN_LABEL = 'changes since the last sync'
const SYNC_NOW_LABEL = 'sync requested'
const PROMOTE_LABEL = 'knowledge status checked'
const PUT_BACK_LABEL = 'a merged document put back'
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
  /**
   * Runs the bundled CLI's `workspace promote`. Separate from `runCli` because
   * the promotion asks the code host's own tool (`gh`) itself, so its child
   * needs the person's PATH (a GUI-launched app cannot see Homebrew's folder).
   */
  runPromotionCli: WorkspaceSyncCliRunner
  /** REQUIRED (allowed-pattern #26): the one-shot agent that merges an intent document. */
  mergeIntent: IntentMergeDeps['merge']
  /** An agent merged a pause away: raise ONE notification for the set. */
  onIntentMerged: (slug: string, name: string | null, set: WorkspaceIntentMergeSet) => void
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
  /** The documents one agent merge settled, while this computer holds them. */
  intentMerges(request: WorkspaceIntentMergesRequest): WorkspaceIntentMergeSet | null
  /** Put merged documents to one text (`ours` = Undo): a new commit each, then a sync. */
  keepIntent(request: WorkspaceKeepIntentRequest): Promise<WorkspaceKeepIntentResult>
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
  if (value['agentMergeable'] === true) {
    ask.agentMergeable = true
    ask.base = typeof value['base'] === 'string' ? value['base'] : null
    ask.theirAuthor = authorOf(value['theirAuthor'])
  }
  return ask
}

/** A git author name for a sentence: one plain line, or null. */
function authorOf(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const name = value.replace(/[\r\n\t]+/g, ' ').trim()
  return name === '' ? null : name.slice(0, 80)
}

function readReview(value: unknown): WorkspaceSyncReview {
  if (!isRecord(value)) throw new MalformedAnswer('review')
  const kind = value['kind']
  if (!(REVIEW_KINDS as readonly unknown[]).includes(kind)) throw new MalformedAnswer('review.kind')
  const review: WorkspaceSyncReview = {
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
  if (value['agentMergeable'] === true) {
    review.agentMergeable = true
    review.theirAuthor = authorOf(value['theirAuthor'])
  }
  return review
}

const CLI_STATES = ['synced', 'local-only', 'nothing-to-do', 'ask', 'review', 'behind', 'offline', 'no-access', 'committed'] as const
type CliState = (typeof CLI_STATES)[number]

/** Why the remote refused a `no-access` sync (the CLI's `rejection`); null when an older CLI did not say. */
type CliRejection =
  | { kind: 'access' }
  | { kind: 'author-not-allowed'; email: string | null }
  | { kind: 'pull-request-required' }
  | { kind: 'declined' }

interface CliResult {
  state: CliState
  name: string | null
  ahead: number
  asks: WorkspaceSyncAsk[]
  reviews: WorkspaceSyncReview[]
  rejection: CliRejection | null
}

/** Lenient on purpose: an unknown or missing rejection falls back to the generic access sentence. */
function readRejection(value: unknown): CliRejection | null {
  if (!isRecord(value)) return null
  switch (value['kind']) {
    case 'access':
    case 'pull-request-required':
    case 'declined':
      return { kind: value['kind'] }
    case 'author-not-allowed': {
      const email = value['email']
      return { kind: 'author-not-allowed', email: typeof email === 'string' && email.trim() !== '' ? email : null }
    }
    default:
      return null
  }
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
    rejection: readRejection(payload['rejection']),
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
  authorNotAllowed: (name: string, email: string | null) =>
    email === null
      ? `${name}'s shared repository refused your changes because of the email address on them. Your changes are kept on this computer.`
      : `${name}'s shared repository doesn't accept changes from ${email}. Your changes are kept on this computer.`,
  pullRequestRequired: (name: string) =>
    `${name}'s shared repository only accepts changes through a pull request, so Flow can't send yours. Ask whoever manages it to let Flow update it directly. Your changes are kept on this computer.`,
  declined: (name: string) =>
    `${name}'s shared repository declined your changes because of a rule set by whoever manages it. Your changes are kept on this computer.`,
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
  keptOurs: (title: string) => `Flow put back your version of "${title}".`,
  keptOursMany: (count: number) => `Flow put back your versions of ${count} documents.`,
  keptTheirs: (title: string, who: string) => `Flow kept ${who}'s version of "${title}".`,
  keptTheirsMany: (count: number) => `Flow kept your teammates' versions of ${count} documents.`,
  keptMerged: (title: string) => `Flow kept the merged version of "${title}".`,
  keptMergedMany: (count: number) => `Flow kept the merged versions of ${count} documents.`,
  intentChanged: (title: string) => `Someone changed "${title}" since Flow merged it, so Flow left it as it is.`,
  intentGone: 'Flow no longer has that merge on this computer.',
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

/** The remote's refusal, in its own terms — a policy is never reported as missing access. */
function noAccessSentence(name: string, rejection: CliRejection | null): string {
  switch (rejection?.kind) {
    case 'author-not-allowed':
      return WORKSPACE_SYNC_SENTENCES.authorNotAllowed(name, rejection.email)
    case 'pull-request-required':
      return WORKSPACE_SYNC_SENTENCES.pullRequestRequired(name)
    case 'declined':
      return WORKSPACE_SYNC_SENTENCES.declined(name)
    default:
      return WORKSPACE_SYNC_SENTENCES.noAccess(name)
  }
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
  /** Why the last sync could not exchange, when a person can act on it by changing the branch or repository. */
  cause: WorkspaceSyncCause | null
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
  /** When the last promotion started (epoch ms), or null. */
  promotedAt: number | null
  promoteInFlight: boolean
  /** The 10-minute promotion timer — armed on the first open, cleared only on forget/quit. */
  promoteTimer: unknown
  /** The last few agent merges, newest last — what Undo and "See both" read. */
  mergeSets: WorkspaceIntentMergeSet[]
}

interface RunOptions {
  message: string
  timeoutMs: number
  resolve?: { path: string; id: string; take: string }
  /** `--commit-only`: commit, nothing else. */
  commitOnly?: boolean
  /** `--put-back`: one intent document to a chosen text, over exactly the text last seen. */
  putBack?: { path: string; expect: string; take: string }
}

/** sha256 hex of a text's UTF-8 bytes — what the CLI's `--expect` compares. */
function textHash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
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
        cause: null,
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
        promotedAt: null,
        promoteInFlight: false,
        promoteTimer: null,
        mergeSets: [],
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
      ...(rec.cause === null ? {} : { cause: rec.cause }),
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

  function set(
    rec: WorkspaceRecord,
    state: WorkspaceRecord['state'],
    detail: string | null,
    items?: { asks: WorkspaceSyncAsk[]; reviews: WorkspaceSyncReview[] },
    cause: WorkspaceSyncCause | null = null,
  ): void {
    rec.state = state
    rec.cause = cause
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
    if (options.putBack !== undefined) {
      args.push(`--put-back=${options.putBack.path}`, `--expect=${options.putBack.expect}`, `--take=${options.putBack.take}`)
    }
    args.push('--json')
    // EVERY RUN IS LOGGED (user, 2026-11-24 — a teammate's sync kept failing
    // with nothing to go on): what was asked, how long it took, what came back.
    // The commit message is left out; it can carry a person's words.
    const asked = args.filter((arg) => !arg.startsWith('--message='))
    const started = Date.now()
    deps.log('workspace sync started', { slug: rec.slug, args: asked })
    const run = await deps.runCli(deps.cwd, args, { timeoutMs: options.timeoutMs })
    const ms = Date.now() - started
    const payload = lastJsonLine(run.stdout)
    if (run.ok && payload !== null && payload['action'] === 'sync' && typeof payload['refused'] !== 'string') {
      deps.log('workspace sync finished', {
        slug: rec.slug,
        ms,
        state: payload['state'],
        branch: payload['branch'],
        pushed: payload['pushed'],
        pulled: payload['pulled'],
        committed: payload['committed'] === null || payload['committed'] === undefined ? null : 'yes',
        asks: Array.isArray(payload['asks']) ? payload['asks'].length : 0,
        reviews: Array.isArray(payload['reviews']) ? payload['reviews'].length : 0,
      })
      try {
        return { kind: 'result', result: readResult(payload) }
      } catch (error) {
        deps.log('workspace sync answered in a shape this build cannot read', { slug: rec.slug, field: (error as Error).message })
        return { kind: 'unavailable' }
      }
    }
    if (!run.ok && payload !== null && typeof payload['refused'] === 'string') {
      // The CLI's sentence is for terminal users: it stays in the log.
      const { action: _action, refused: _refused, detail: _detail, ...extra } = payload
      deps.log('workspace sync refused', { slug: rec.slug, ms, reason: payload['refused'], detail: payload['detail'], extra, stderr: tail(run.stderr) })
      return { kind: 'refused', reason: payload['refused'] }
    }
    deps.log('workspace sync gave no usable answer', {
      slug: rec.slug,
      ms,
      ok: run.ok,
      error: run.error,
      stderr: tail(run.stderr),
      stdout: tail(run.stdout),
    })
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
    let outcome = await callCli(rec, options)
    if (rec.forgotten) return outcome
    // A pause nobody has looked at yet, made only of intent documents: an agent
    // merges it before it ever reaches a person. Never on a person's own
    // decision or put-back — those are a person's choice already.
    let mergedSet: WorkspaceIntentMergeSet | null = null
    if (
      outcome.kind === 'result' &&
      (outcome.result.state === 'ask' || outcome.result.state === 'review') &&
      options.resolve === undefined &&
      options.putBack === undefined &&
      options.commitOnly !== true
    ) {
      const settled = await settleByAgent(rec, outcome.result, options)
      if (rec.forgotten) return outcome
      if (settled.outcome !== null) outcome = settled.outcome
      mergedSet = settled.set
    }
    try {
      return fold(rec, outcome, carried, retryOnce)
    } finally {
      if (mergedSet !== null) {
        try {
          deps.onIntentMerged(rec.slug, rec.name, mergedSet)
        } catch (error) {
          deps.log('intent merge listener failed', { error: String(error) })
        }
      }
    }
  }

  /**
   * Ask the agent for every intent document of a pause, then resolve each
   * through the CLI (intent-merge.ts). `outcome` is the last CLI answer when
   * anything was resolved (it says where things stand now); `set` is the
   * merge set when every item was merged.
   */
  async function settleByAgent(
    rec: WorkspaceRecord,
    result: CliResult,
    options: RunOptions,
  ): Promise<{ outcome: CliOutcome | null; set: WorkspaceIntentMergeSet | null }> {
    const items: IntentItem[] = [...result.asks, ...result.reviews]
    const seen: { last: CliOutcome | null } = { last: null }
    const merged = await settleIntentAsks(rec.slug, items, {
      merge: deps.mergeIntent,
      timers: deps.timers,
      log: deps.log,
      resolve: async (item, mergedText) => {
        const temp = await deps.writeTempText(mergedText)
        try {
          const answer = await callCli(rec, {
            message: options.message,
            timeoutMs: WORKSPACE_SYNC_TIMEOUT_MS,
            resolve: { path: item.path, id: item.id, take: `file:${temp.path}` },
          })
          if (answer.kind !== 'result') return false
          seen.last = answer
          return true
        } finally {
          await temp.dispose().catch(() => undefined)
        }
      },
    })
    if (merged.kind !== 'settled') return { outcome: seen.last, set: null }
    const at = deps.now()
    const set: WorkspaceIntentMergeSet = {
      slug: rec.slug,
      mergeId: `m${at.toString(36)}${rec.mergeSets.length}`,
      at: new Date(at).toISOString(),
      documents: merged.documents,
    }
    rec.mergeSets.push(set)
    if (rec.mergeSets.length > KEPT_MERGE_SETS) rec.mergeSets.splice(0, rec.mergeSets.length - KEPT_MERGE_SETS)
    return { outcome: seen.last, set }
  }

  /** Fold one CLI answer into the record. */
  function fold(rec: WorkspaceRecord, outcome: CliOutcome, carried: number, retryOnce: boolean): CliOutcome {
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
      set(rec, 'error', refusalSentence(outcome.reason, nameIn(rec)), undefined, outcome.reason === 'unrelated-history' ? 'unrelated-history' : null)
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
        set(rec, 'no-access', noAccessSentence(nameIn(rec), result.rejection), undefined, result.rejection?.kind ?? 'access')
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

  // ── Promotion (FR-7) ──

  /**
   * Run `workspace promote` once. Inside the Workspace's queue (the callers
   * enqueue it), so it never overlaps a sync. Answers whether it decided
   * anything (solid, stale or abandoned) — the status lines a sync should
   * carry. Never throws; a failure is logged and the sync goes on.
   */
  async function promote(rec: WorkspaceRecord, force: boolean): Promise<boolean> {
    if (!mayRun(rec) || waitsForPerson(rec) || rec.promoteInFlight) return false
    if (!force && rec.promotedAt !== null && deps.now() - rec.promotedAt < PROMOTE_COOLDOWN_MS) return false
    rec.promoteInFlight = true
    rec.promotedAt = deps.now()
    try {
      const run = await deps.runPromotionCli(deps.cwd, ['workspace', 'promote', '--workspace', rec.slug, '--json'], {
        timeoutMs: PROMOTE_TIMEOUT_MS,
      })
      const payload = lastJsonLine(run.stdout)
      if (!run.ok || payload === null || payload['action'] !== 'promote' || !isRecord(payload['totals'])) {
        deps.log('workspace promote gave no usable answer', {
          slug: rec.slug,
          refused: payload?.['refused'],
          error: run.error,
          stderr: run.stderr,
        })
        return false
      }
      const projects = payload['projects']
      if (Array.isArray(projects)) {
        for (const project of projects) {
          if (isRecord(project) && project['state'] === 'failed') {
            deps.log('workspace promote could not check a project', { slug: rec.slug, project: project['project'], detail: project['detail'] })
          }
        }
      }
      const totals = payload['totals']
      const count = (key: string): number => {
        const value = totals[key]
        return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
      }
      return count('solid') + count('stale') + count('abandoned') > 0
    } catch (error) {
      deps.log('workspace promote failed', { slug: rec.slug, error: String(error) })
      return false
    } finally {
      rec.promoteInFlight = false
    }
  }

  /** While a Workspace is open, promotion runs every PROMOTE_INTERVAL_MS — never over a pause. */
  function armPromoteTimer(rec: WorkspaceRecord): void {
    if (closed || rec.forgotten || rec.promoteTimer !== null) return
    rec.promoteTimer = deps.timers.setTimeout(() => {
      rec.promoteTimer = null
      if (!mayRun(rec)) return
      armPromoteTimer(rec)
      if (waitsForPerson(rec)) return
      void enqueue(rec, async () => {
        if (await promote(rec, false)) await background(rec, PROMOTE_LABEL)
      })
    }, PROMOTE_INTERVAL_MS)
  }

  // ── Public API ──

  function recentlySynced(rec: WorkspaceRecord): boolean {
    return rec.state === 'synced' && rec.lastSyncedAt !== null && deps.now() - rec.lastSyncedAt < OPEN_SYNC_COOLDOWN_MS
  }

  function open(slug: string): Promise<void> {
    if (closed || !isWorkspaceSlug(slug)) return Promise.resolve()
    const rec = record(slug)
    armPromoteTimer(rec)
    if (rec.openInFlight !== null) return rec.openInFlight
    const run = enqueue(rec, async () => {
      if (waitsForPerson(rec)) return
      // Promotion first (its own cooldown); a promotion that decided anything
      // is carried by a sync even inside the open cooldown.
      const promoted = await promote(rec, false)
      if (recentlySynced(rec) && !promoted) return
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
      // A person asked: promotion runs whatever its cooldown — but never over a pause.
      await promote(rec, true)
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

  // ── Intent merges: Undo and "See both" ──

  function copySet(set: WorkspaceIntentMergeSet): WorkspaceIntentMergeSet {
    return { ...set, documents: set.documents.map((document) => ({ ...document })) }
  }

  function intentMerges(request: WorkspaceIntentMergesRequest): WorkspaceIntentMergeSet | null {
    if (!isWorkspaceSlug(request.slug)) return null
    const set = records.get(request.slug)?.mergeSets.find((candidate) => candidate.mergeId === request.mergeId)
    return set === undefined ? null : copySet(set)
  }

  function keptSentence(keep: IntentMergeKeep, documents: readonly WorkspaceIntentMergeSet['documents'][number][]): string {
    const s = WORKSPACE_SYNC_SENTENCES
    const [only] = documents
    if (documents.length === 1 && only !== undefined) {
      if (keep === 'ours') return s.keptOurs(only.title)
      if (keep === 'theirs') return s.keptTheirs(only.title, only.theirName ?? 'your teammate')
      return s.keptMerged(only.title)
    }
    if (keep === 'ours') return s.keptOursMany(documents.length)
    if (keep === 'theirs') return s.keptTheirsMany(documents.length)
    return s.keptMergedMany(documents.length)
  }

  async function keepIntent(request: WorkspaceKeepIntentRequest): Promise<WorkspaceKeepIntentResult> {
    if (!isWorkspaceSlug(request.slug)) {
      return { ok: false, reason: 'not-found', detail: WORKSPACE_SYNC_SENTENCES.intentGone, status: IDLE_STATUS(null) }
    }
    const rec = record(request.slug)
    let answer: WorkspaceKeepIntentResult | null = null
    await enqueue(rec, async () => {
      const set = rec.mergeSets.find((candidate) => candidate.mergeId === request.mergeId)
      const chosen =
        set === undefined
          ? []
          : set.documents.filter((document) => request.documentId === undefined || document.id === request.documentId)
      if (set === undefined || chosen.length === 0 || closed || rec.forgotten) {
        answer = { ok: false, reason: 'not-found', detail: WORKSPACE_SYNC_SENTENCES.intentGone, status: statusOf(rec) }
        return
      }
      const textOf = (document: (typeof chosen)[number], which: IntentMergeKeep): string =>
        which === 'ours' ? document.ours : which === 'theirs' ? document.theirs : document.merged
      for (const document of chosen) {
        if (document.current === request.keep) continue
        let temp: TempText | null = null
        try {
          temp = await deps.writeTempText(textOf(document, request.keep))
          const message = rec.turnLabels.length > 0 ? turnsMessage(rec.turnLabels) : commitMessage(PUT_BACK_LABEL)
          const outcome = await sync(
            rec,
            {
              message,
              timeoutMs: WORKSPACE_SYNC_TIMEOUT_MS,
              // Only over exactly the text this computer put there: a teammate's later edit is never overwritten.
              putBack: { path: document.path, expect: textHash(textOf(document, document.current)), take: `file:${temp.path}` },
            },
            true,
          )
          if (outcome.kind === 'refused' && (outcome.reason === 'stale-decision' || outcome.reason === 'invalid-resolution')) {
            // Read where things stand, so the status is not left mid-sync.
            await sync(rec, { message, timeoutMs: WORKSPACE_SYNC_TIMEOUT_MS }, true)
            answer = { ok: false, reason: 'stale', detail: WORKSPACE_SYNC_SENTENCES.intentChanged(document.title), status: statusOf(rec) }
            return
          }
          if (outcome.kind !== 'result') {
            answer = { ok: false, reason: 'failed', detail: rec.detail ?? WORKSPACE_SYNC_SENTENCES.failed(nameIn(rec)), status: statusOf(rec) }
            return
          }
          document.current = request.keep
        } catch (error) {
          deps.log('putting a merged document back failed', { slug: rec.slug, error: String(error) })
          answer = { ok: false, reason: 'failed', detail: WORKSPACE_SYNC_SENTENCES.failed(nameIn(rec)), status: statusOf(rec) }
          return
        } finally {
          if (temp !== null) await temp.dispose().catch(() => undefined)
        }
      }
      answer = { ok: true, detail: keptSentence(request.keep, chosen), set: copySet(set), status: statusOf(rec) }
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
    rec.promoteTimer = clearTimer(rec.promoteTimer)
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
      rec.promoteTimer = clearTimer(rec.promoteTimer)
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

  return { open, commitAfterTurn, syncNow, resolve, intentMerges, keepIntent, status, forget, quit }
}

/** The last part of a CLI stream, for a log line — never the whole thing. */
function tail(text: string | undefined, max = 2000): string {
  if (text === undefined || text === '') return ''
  return text.length <= max ? text : `…${text.slice(-max)}`
}
