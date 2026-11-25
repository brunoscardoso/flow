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
 *  · A PAUSE IS DECIDED BY AN AGENT FIRST (intent-merge.ts): every item is
 *    decided or left for a person, then ONE CLI run applies the whole batch
 *    and commits the merge on this computer without pushing
 *    (`--decisions --no-push`); items left for a person are held aside. The
 *    merge then waits like a pause until it is reviewed. When the agent
 *    decides nothing, the pause stays exactly as the CLI put it.
 *  · A REVIEW IS NEVER SHARED UNAGREED (NFR-1). The merged batch puts the
 *    Workspace in `review`. While a review holds anything committed and not
 *    agreed, EVERY CLI run this engine starts carries `--no-push` (or is
 *    `--commit-only`) — except the one share an agree triggers (`--agreed`).
 *    Background, timer, turn and "Sync now" runs only commit this computer's
 *    work while it waits (`--commit-only`: nothing fetched, nothing merged on
 *    top). The CLI keeps its own record of the open review and refuses to
 *    publish it without `--agreed` too, so a restart or a terminal run cannot
 *    either; the engine rebuilds the review from that answer.
 *  · AGREE, DISAGREE, DECIDE. Agreeing marks items; a disagreement (reason
 *    required) puts the item back to the Workspace's version and holds this
 *    computer's text aside (`--hold-back`), then the agent decides it ONCE
 *    more with the reason; a second disagreement leaves it to the person
 *    (`needs-you`), who decides directly (`--settle-held`). Items a person
 *    must choose for are never agreed in bulk. AGREED GROUPS ARE SHARED AS
 *    SOON AS THEY ARE AGREED; THE REST WAITS HERE (FR-9): an agree that
 *    leaves items nobody has looked at (`pending`) first holds them ALL back
 *    in one local run (`--hold-back … --commit-only`) — they stay in their
 *    group as `held`, with the agent's decision, and agreeing one later writes
 *    that decision (`--settle-held`) and shares again. Disagreed, needs-you
 *    and held items are held aside, so they never hold the push. The agent's
 *    merged text is kept in memory only: after a restart a held item is the
 *    person's to decide. Agreeing every group at once (`allGroups`) holds
 *    nothing back. Each agreed decision and each disagreement is written to
 *    the shared record through the CLI's `merge-decision record`, one run at a
 *    time. A share that did not go out is reported as such, never as done.
 *
 * Nothing here throws to its caller: every failure becomes a status.
 */

import { RETRY_BASE_MS, RETRY_MAX_MS, OPEN_SYNC_COOLDOWN_MS, PUSH_DEBOUNCE_MS, QUIT_PUSH_TIMEOUT_MS, commitMessage, type EngineTimers } from './sync-timing'

import { lastJsonLine } from '../workspaces/cli-json'
import { decideConflicts, projectOf, type DecideOutcome, type DeciderDeps, type IntentItem, type IntentMergeDeps } from './intent-merge'
import type {
  WorkspaceAgentSuggestion,
  WorkspaceAgentTake,
  WorkspaceMergeGroupKey,
  WorkspaceMergeItemKind,
  WorkspaceMergeItemState,
  WorkspaceMergeRedo,
  WorkspaceMergeReview,
  WorkspaceMergeReviewGroup,
  WorkspaceMergeReviewHeld,
  WorkspaceNeedsYouReason,
  WorkspaceReviewAgreeRequest,
  WorkspaceReviewDecideRequest,
  WorkspaceReviewDisagreeRequest,
  WorkspaceReviewRefusal,
  WorkspaceReviewResult,
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
/** `workspace merge-decision list`: one local read of the shared record — short. */
export const REASONS_TIMEOUT_MS = 30_000
/** `workspace merge-decision record`: one local append — short. */
export const RECORD_TIMEOUT_MS = 30_000
/** The most characters of a person's reason kept (the record keeps one line). */
const MAX_REASON_CHARS = 500

const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const MAX_SLUG_LENGTH = 64

const OPEN_LABEL = 'changes since the last sync'
const SYNC_NOW_LABEL = 'sync requested'
const PROMOTE_LABEL = 'knowledge status checked'
const REVIEW_LABEL = 'reviewed changes shared'
const SETTLE_LABEL = 'a reviewed change settled'
const HOLD_BACK_LABEL = 'a disagreed change held back'
const HOLD_BACK_PENDING_LABEL = 'changes not reviewed yet held back'
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
  /** REQUIRED (allowed-pattern #26): the capable one-shot agent that writes one text from both sides. */
  mergeIntent: IntentMergeDeps['merge']
  /** REQUIRED (allowed-pattern #26): the fast one-shot agent that sorts a waiting merge's items in batches. */
  decideFast: DeciderDeps['decideFast']
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
  /** Agree to items of the open review; shares the agreed part once nothing is left un-looked-at. */
  reviewAgree(request: WorkspaceReviewAgreeRequest): Promise<WorkspaceReviewResult>
  /** Disagree with items (a reason is required): held back, then decided once more by the agent. */
  reviewDisagree(request: WorkspaceReviewDisagreeRequest): Promise<WorkspaceReviewResult>
  /** A person decides one held item directly. */
  reviewDecide(request: WorkspaceReviewDecideRequest): Promise<WorkspaceReviewResult>
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
  if (value['suggested'] === 'both') ask.suggested = 'both'
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

const CLI_STATES = ['synced', 'local-only', 'nothing-to-do', 'ask', 'review', 'behind', 'offline', 'no-access', 'committed', 'merged-local'] as const
type CliState = (typeof CLI_STATES)[number]

/** Why the remote refused a `no-access` sync (the CLI's `rejection`); null when an older CLI did not say. */
type CliRejection =
  | { kind: 'access' }
  | { kind: 'author-not-allowed'; email: string | null }
  | { kind: 'pull-request-required' }
  | { kind: 'declined' }

/** One item a committed merge decided (the CLI's `mergedItems`); `held` = the Workspace's version kept, this machine's text aside. */
interface CliMergedItem {
  id: string
  path: string
  take: string
  held: boolean
  /** Absent from an older CLI. */
  kind?: WorkspaceMergeItemKind
}

interface CliResult {
  state: CliState
  name: string | null
  ahead: number
  asks: WorkspaceSyncAsk[]
  reviews: WorkspaceSyncReview[]
  rejection: CliRejection | null
  /** Empty from a CLI that does not say. */
  mergedItems: CliMergedItem[]
  /** What is held aside on this computer now; empty from a CLI that does not say. */
  heldAside: WorkspaceMergeReviewHeld[]
}

const ITEM_KINDS: readonly WorkspaceMergeItemKind[] = [...ASK_KINDS, ...REVIEW_KINDS, 'combine']

/** Lenient: an entry that cannot be read is left out, never fatal (these only feed the review). */
function readMergedItems(value: unknown): CliMergedItem[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry): CliMergedItem[] => {
    if (!isRecord(entry) || typeof entry['id'] !== 'string' || typeof entry['path'] !== 'string' || typeof entry['take'] !== 'string') return []
    const kind = entry['kind']
    return [
      {
        id: entry['id'],
        path: entry['path'],
        take: entry['take'],
        held: entry['held'] === true,
        ...((ITEM_KINDS as readonly unknown[]).includes(kind) ? { kind: kind as WorkspaceMergeItemKind } : {}),
      },
    ]
  })
}

function readHeldAside(value: unknown): WorkspaceMergeReviewHeld[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry): WorkspaceMergeReviewHeld[] => {
    if (!isRecord(entry) || typeof entry['id'] !== 'string' || typeof entry['path'] !== 'string') return []
    const kind = entry['kind']
    if (!(ITEM_KINDS as readonly unknown[]).includes(kind)) return []
    return [{ id: entry['id'], path: entry['path'], kind: kind as WorkspaceMergeItemKind, heldAt: typeof entry['heldAt'] === 'string' ? entry['heldAt'] : '' }]
  })
}

/** One line of the shared merge-decisions record, as the decider's guidance needs it. */
interface RecordedReason {
  kind: string
  project: string
  take: string
  summary: string
  reason: string
  outcome: 'agreed' | 'disagreed'
  ts: string
}

const GROUP_ORDER: readonly WorkspaceMergeReviewGroup['key'][] = ['combined', 'merged', 'took-theirs', 'kept-mine', 'kept-both', 'identical']

/**
 * A merge that COMBINED two Workspaces set up separately is one item of its
 * own, first in the review: the CLI shares it only once a person agrees.
 */
function combineEntries(result: Pick<CliResult, 'mergedItems'>): ReviewEntry[] {
  return result.mergedItems
    .filter((item) => item.kind === 'combine' && !item.held)
    .map((item) => ({ ...entryBase(item.id, '', 'combine'), group: 'combined' as const, take: 'theirs' as const }))
}

/**
 * One item of the open review as the engine keeps it. `heldHere`: this
 * computer's text is held aside by the CLI (never committed), so the item can
 * never be published by a share; `recorded`: its agreed decision is in the
 * shared record already.
 */
interface ReviewEntry {
  id: string
  path: string
  kind: WorkspaceMergeItemKind
  /** Where it is shown: a decided group, the agent's "needs you", or held with no decision remembered. */
  section: 'group' | 'needs-you' | 'held'
  group: WorkspaceMergeGroupKey | null
  /** The agent's decision (group items). */
  take: WorkspaceAgentTake | null
  /** The agent's one-line reason (group items). */
  reason: string
  /**
   * The agent's decided text for `take: 'file'` — what agreeing a HELD group
   * item writes (the held store keeps this computer's original text, not the
   * decision). In memory only: after a restart a held item has no decision
   * remembered and is the person's to decide (`section: 'held'`).
   */
  content: string | null
  needsYouReason: WorkspaceNeedsYouReason | null
  suggestion: WorkspaceAgentSuggestion | null
  state: WorkspaceMergeItemState
  disagreedReason: string | null
  redo: WorkspaceMergeRedo | null
  /** What a person decided directly, for the record. */
  decided: 'ours' | 'theirs' | 'file' | null
  heldHere: boolean
  recorded: boolean
}

/** The agent-decided merge waiting for review, kept in memory (the CLI keeps what protects it). */
interface OpenReview {
  mergedAt: string
  entries: ReviewEntry[]
  /** What the CLI says is held aside on this computer now. */
  held: WorkspaceMergeReviewHeld[]
  /** Each item's two sides as the agent saw them — what a redo needs. Empty after a restart. */
  items: Map<string, IntentItem>
}

function entryBase(id: string, path: string, kind: WorkspaceMergeItemKind): ReviewEntry {
  return {
    id,
    path,
    kind,
    section: 'group',
    group: null,
    take: null,
    reason: '',
    content: null,
    needsYouReason: null,
    suggestion: null,
    state: 'pending',
    disagreedReason: null,
    redo: null,
    decided: null,
    heldHere: false,
    recorded: false,
  }
}

/**
 * The open review of one agent-decided merge: the decisions the CLI says it
 * applied (and did not hold), the items left for a person (held aside), and
 * everything held aside on this computer now.
 */
function openReviewOf(
  at: number,
  items: readonly (WorkspaceSyncAsk | WorkspaceSyncReview)[],
  decided: DecideOutcome,
  result: Pick<CliResult, 'mergedItems' | 'heldAside'>,
): OpenReview {
  const byId = new Map(items.map((item) => [item.id, item]))
  const applied = new Set(result.mergedItems.filter((item) => !item.held).map((item) => item.id))
  const heldIds = new Set(result.heldAside.map((held) => held.id))
  const entries: ReviewEntry[] = [...combineEntries(result)]
  for (const key of GROUP_ORDER) {
    for (const decision of decided.decisions) {
      const item = byId.get(decision.id)
      if (decision.group !== key || !applied.has(decision.id) || item === undefined) continue
      entries.push({
        ...entryBase(decision.id, item.path, item.kind),
        group: key,
        take: decision.take,
        reason: decision.reason,
        content: decision.take === 'file' ? (decision.content ?? '') : null,
      })
    }
  }
  for (const left of decided.needsYou) {
    const item = byId.get(left.id)
    if (item === undefined) continue
    entries.push({
      ...entryBase(left.id, item.path, item.kind),
      section: 'needs-you',
      state: 'needs-you',
      needsYouReason: left.reason,
      suggestion: left.suggestion === undefined ? null : { ...left.suggestion },
      heldHere: heldIds.has(left.id),
    })
  }
  const review: OpenReview = { mergedAt: new Date(at).toISOString(), entries, held: [], items: new Map(byId) }
  withHeld(review, result.heldAside)
  return review
}

/**
 * The review rebuilt from the CLI alone — after a restart, or a merge this
 * engine did not make: each decided item as `pending`, grouped by what it took
 * (the agent's reasons are not known any more), and the held items as `held`.
 */
function reviewFromCli(at: number, result: Pick<CliResult, 'mergedItems' | 'heldAside'>): OpenReview {
  const entries = result.mergedItems.flatMap((item): ReviewEntry[] => {
    if (item.held || item.kind === 'combine') return []
    const take: WorkspaceAgentTake = item.take === 'ours' ? 'ours' : item.take === 'theirs' ? 'theirs' : 'file'
    const group: WorkspaceMergeGroupKey = take === 'ours' ? 'kept-mine' : take === 'theirs' ? 'took-theirs' : 'merged'
    return [{ ...entryBase(item.id, item.path, item.kind ?? 'conflict'), group, take }]
  })
  entries.unshift(...combineEntries(result))
  const review: OpenReview = { mergedAt: new Date(at).toISOString(), entries, held: [], items: new Map() }
  withHeld(review, result.heldAside)
  return review
}

/**
 * Fold the CLI's held list in: an entry whose held text is gone (settled
 * elsewhere) and that nobody agreed is dropped; a held item Flow has no entry
 * for becomes a `held` entry a person can decide.
 */
function withHeld(review: OpenReview, heldAside: readonly WorkspaceMergeReviewHeld[]): void {
  const heldIds = new Set(heldAside.map((held) => held.id))
  review.entries = review.entries.filter((entry) => !entry.heldHere || heldIds.has(entry.id) || entry.state === 'agreed')
  const known = new Set(review.entries.map((entry) => entry.id))
  for (const held of heldAside) {
    if (known.has(held.id)) {
      const entry = review.entries.find((candidate) => candidate.id === held.id)
      if (entry !== undefined && entry.state !== 'agreed') entry.heldHere = true
      continue
    }
    review.entries.push({ ...entryBase(held.id, held.path, held.kind), section: 'held', state: 'held', heldHere: true })
  }
  review.held = heldAside.map((held) => ({ ...held }))
}

/** A newer merge's review on top of the open one: what was already looked at keeps its state. */
function mergeReviews(older: OpenReview, newer: OpenReview): OpenReview {
  const ids = new Set(newer.entries.map((entry) => entry.id))
  const kept = older.entries.filter((entry) => !ids.has(entry.id))
  const items = new Map([...older.items, ...newer.items])
  return { mergedAt: newer.mergedAt, entries: [...kept, ...newer.entries], held: newer.held, items }
}

/** What a status shows of the open review. */
function publicReview(review: OpenReview): WorkspaceMergeReview {
  const groups: WorkspaceMergeReviewGroup[] = []
  for (const key of GROUP_ORDER) {
    const members = review.entries
      .filter((entry) => entry.section === 'group' && entry.group === key)
      .map((entry) => ({
        id: entry.id,
        path: entry.path,
        kind: entry.kind,
        take: entry.take ?? 'theirs',
        reason: entry.reason,
        state: entry.state,
        ...(entry.disagreedReason === null ? {} : { disagreedReason: entry.disagreedReason }),
        ...(entry.redo === null ? {} : { redo: { ...entry.redo } }),
        ...(entry.suggestion === null ? {} : { suggestion: { ...entry.suggestion } }),
      }))
    if (members.length > 0) groups.push({ key, count: members.length, items: members })
  }
  const needsYou = review.entries
    .filter((entry) => entry.section === 'needs-you')
    .map((entry) => ({
      id: entry.id,
      path: entry.path,
      kind: entry.kind,
      reason: entry.needsYouReason ?? 'agent-unavailable',
      ...(entry.suggestion === null ? {} : { suggestion: { ...entry.suggestion } }),
      state: entry.state === 'agreed' ? ('agreed' as const) : ('needs-you' as const),
    }))
  const stateOf = new Map(review.entries.map((entry) => [entry.id, entry.state]))
  const held = review.held.map((entry) => ({ ...entry, state: stateOf.get(entry.id) ?? 'held' }))
  return { mergedAt: review.mergedAt, groups, needsYou, held }
}

/** What a status shows of one agent-decided merge, straight from the decider and the CLI's answer. */
export function reviewOf(
  at: number,
  items: readonly (WorkspaceSyncAsk | WorkspaceSyncReview)[],
  decided: DecideOutcome,
  result: Pick<CliResult, 'mergedItems' | 'heldAside'>,
): WorkspaceMergeReview {
  return publicReview(openReviewOf(at, items, decided, result))
}

/**
 * A held group item whose agent decision can still be written as it was made:
 * `ours` (the held text IS this computer's) and `theirs` always; `file` only
 * while its decided text is remembered.
 */
function decisionKept(entry: ReviewEntry): boolean {
  return entry.section === 'group' && entry.take !== null && (entry.take !== 'file' || entry.content !== null)
}

/** May a person agree to this entry (alone or in bulk)? Never an item that needs their own choice. */
function agreeable(entry: ReviewEntry): boolean {
  if (entry.state === 'pending') return true
  if (entry.state === 'redone') return entry.redo !== null
  if (entry.state === 'held') return decisionKept(entry)
  return false
}

/** Something committed here that no person agreed to yet: while true, nothing this engine runs may publish. */
function reviewHoldsPush(review: OpenReview | null): boolean {
  return review !== null && review.entries.some((entry) => entry.state === 'pending' || (entry.state === 'agreed' && !entry.heldHere))
}

/**
 * The agreed part may go out: nothing is left un-looked-at, and something
 * agreed waits. Disagreed, redone, needs-you and held items are held aside —
 * the share carries the Workspace's version there — so they never hold it.
 * An item nobody has looked at yet (`pending`) is committed with the agent's
 * decision and so WOULD be published: an agree first holds every pending item
 * back (`holdBackPending`, FR-9), which is what lets agreed groups go out at
 * once while the rest waits here.
 */
function readyToShare(review: OpenReview | null): boolean {
  if (review === null) return false
  if (review.entries.some((entry) => entry.state === 'pending')) return false
  return review.entries.some((entry) => entry.state === 'agreed')
}

/** How many changes a review is about — the number a sentence names. */
function reviewSize(review: OpenReview): number {
  return review.entries.length
}

/** The record's word for what an entry took. */
function recordTake(entry: ReviewEntry): string {
  if (entry.decided !== null) return entry.decided
  if (entry.redo !== null) return entry.redo.take
  if (entry.group === 'kept-both') return 'both'
  return entry.take ?? 'theirs'
}

const GROUP_SUMMARY: Record<WorkspaceMergeGroupKey, string> = {
  combined: 'combined two Workspaces set up separately',
  'kept-both': 'kept both notes',
  'took-theirs': "took the Workspace's version",
  'kept-mine': "kept this computer's version",
  merged: 'merged both into one text',
  identical: 'both sides said the same',
}

function recordSummary(entry: ReviewEntry): string {
  if (entry.decided !== null) return entry.decided === 'file' ? 'a person wrote the text' : entry.decided === 'ours' ? "a person kept this computer's version" : "a person kept the Workspace's version"
  if (entry.redo !== null) return `redone: ${entry.redo.take === 'file' ? 'merged both into one text' : entry.redo.take === 'ours' ? "kept this computer's version" : "took the Workspace's version"}`
  return entry.group === null ? 'settled' : GROUP_SUMMARY[entry.group]
}

/** One line, bounded: what the shared record keeps of a person's words. */
function oneLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, MAX_REASON_CHARS)
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
    mergedItems: readMergedItems(payload['mergedItems']),
    heldAside: readHeldAside(payload['heldAside']),
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
  mergedForReview: (name: string, count: number) =>
    `Flow merged ${count} ${count === 1 ? 'change' : 'changes'} in ${name} on this computer. Review them before they're shared.`,
  reasonRequired: 'Say why you disagree, so Flow can try again with that in mind.',
  needsDecision: 'Some of these need you to choose what they should say. Choose for each of them on its own.',
  reviewItemGone: (name: string) => `That change in ${name} is no longer waiting for review.`,
  reviewNotAllowed: "That change can't be settled that way right now.",
  reviewStale: 'That changed since Flow merged it, so Flow left it as it is.',
  pendingChanged: (name: string) =>
    `Some changes in ${name} that you haven't reviewed yet changed since Flow merged them, so nothing was shared. What you agreed to is kept on this computer.`,
  notShared: (name: string) => `Flow couldn't share the changes you agreed to in ${name}. They are kept on this computer.`,
  newChangesArrived: (name: string) =>
    `New changes arrived in ${name} while Flow was sharing yours, so nothing was shared yet. Review what came in first.`,
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
  /** The agent-decided merge committed here and waiting for review, or null. */
  review: OpenReview | null
}

interface RunOptions {
  message: string
  timeoutMs: number
  resolve?: { path: string; id: string; take: string }
  /** `--commit-only`: commit, nothing else. */
  commitOnly?: boolean
  /** `--decisions <file>`: the agent's whole batch, applied in ONE merge. */
  decisions?: string
  /** `--hold <ids>` (with `decisions`): the Workspace's version is kept there, this machine's text held aside. */
  hold?: readonly string[]
  /** `--no-push`: commit, fetch and merge, publish nothing. */
  noPush?: boolean
  /** `--settle-held <id> --take <take>`: one held item written as a local commit. */
  settleHeld?: { id: string; take: string }
  /** `--hold-back <ids>`: review items put back to the Workspace's version, this machine's text held aside. */
  holdBack?: readonly string[]
  /** `--agreed`: a person agreed to the open review — the ONLY run that may publish it. */
  agreed?: boolean
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
        review: null,
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
      ...(rec.review === null ? {} : { review: publicReview(rec.review) }),
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
    if (options.decisions !== undefined) {
      args.push(`--decisions=${options.decisions}`)
      if (options.hold !== undefined && options.hold.length > 0) args.push(`--hold=${options.hold.join(',')}`)
    }
    if (options.settleHeld !== undefined) args.push(`--settle-held=${options.settleHeld.id}`, `--take=${options.settleHeld.take}`)
    if (options.holdBack !== undefined) args.push(`--hold-back=${options.holdBack.join(',')}`)
    // THE GUARD (NFR-1): while a review holds anything committed and not
    // agreed, no run but the agreed share may publish — whoever asked for it.
    const mayPublish = options.commitOnly !== true && options.noPush !== true && (options.agreed === true || !reviewHoldsPush(rec.review))
    if (options.commitOnly !== true && !mayPublish) args.push('--no-push')
    if (options.agreed === true) args.push('--agreed')
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
    // A pause nobody has looked at yet: the agent decides it before it ever
    // reaches a person. Never on a person's own decision — that is a person's
    // choice already — and never on the agent's own batch.
    if (
      outcome.kind === 'result' &&
      (outcome.result.state === 'ask' || outcome.result.state === 'review') &&
      options.resolve === undefined &&
      options.decisions === undefined &&
      options.settleHeld === undefined &&
      options.holdBack === undefined &&
      options.commitOnly !== true
    ) {
      const settled = await settleByAgent(rec, outcome.result, options)
      if (rec.forgotten) return outcome
      if (settled !== null) outcome = settled
    }
    return fold(rec, outcome, carried, retryOnce)
  }

  /**
   * The recorded reasons for one kind of conflict in one project, newest
   * first — read from the shared record through the CLI ONCE per settle (the
   * first prompt that needs them), never per item. A record that cannot be
   * read gives no reasons; it never stops a merge.
   */
  function reasonsLookup(rec: WorkspaceRecord): DeciderDeps['reasonsFor'] {
    let listed: Promise<RecordedReason[]> | null = null
    return async (kind, project) => {
      if (project === null) return []
      listed ??= listReasons(rec)
      const entries = await listed
      return entries
        .filter((entry) => entry.kind === kind && entry.project === project)
        .sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0))
        .map((entry) => `${entry.summary === '' ? `took ${entry.take}` : entry.summary} — ${entry.outcome}: ${entry.reason}`)
    }
  }

  async function listReasons(rec: WorkspaceRecord): Promise<RecordedReason[]> {
    try {
      const run = await deps.runCli(deps.cwd, ['workspace', 'merge-decision', 'list', '--workspace', rec.slug, '--json'], {
        timeoutMs: REASONS_TIMEOUT_MS,
      })
      const payload = lastJsonLine(run.stdout)
      const listed = payload?.['decisions']
      if (!run.ok || payload === null || payload['action'] !== 'merge-decision' || !Array.isArray(listed)) {
        deps.log('the recorded merge reasons could not be read', { slug: rec.slug, error: run.error, stderr: tail(run.stderr) })
        return []
      }
      return listed.flatMap((entry): RecordedReason[] => {
        if (!isRecord(entry)) return []
        const { kind, project, take, summary, reason, outcome, ts } = entry
        if (typeof kind !== 'string' || typeof project !== 'string' || typeof reason !== 'string' || reason.trim() === '') return []
        return [
          {
            kind,
            project,
            take: typeof take === 'string' ? take : '',
            summary: typeof summary === 'string' ? summary : '',
            reason,
            outcome: outcome === 'disagreed' ? 'disagreed' : 'agreed',
            ts: typeof ts === 'string' ? ts : '',
          },
        ]
      })
    } catch (error) {
      deps.log('the recorded merge reasons could not be read', { slug: rec.slug, error: String(error) })
      return []
    }
  }

  /**
   * The agent decides every item of a pause (intent-merge.ts), then ONE CLI
   * run applies the whole batch, committing the merge HERE and pushing
   * nothing (`--decisions <file> --no-push`) — one merge, not one per item.
   *
   * Items left for a person cannot stay undecided in that run: the CLI
   * refuses to commit a merge while anything waits. They go in `--hold`
   * WITHOUT a decision of their own: the merge keeps the Workspace's version
   * at their paths, and this machine's text — exactly as it was, since no
   * decision rewrote it — is held aside on this computer, never committed and
   * so never pushed. (A `theirs` decision beside the hold would have held the
   * Workspace's text aside instead, losing this machine's.) The review later
   * asks the person about them and settles each one. Nothing the person has
   * not seen leaves this computer: the merge waits for review either way.
   *
   * Returns the batch's answer, or null when the pause should stay as the CLI
   * first put it — the per-item choices of before: the agent decided nothing,
   * or the batch was refused (a side changed meanwhile, a take not accepted).
   */
  async function settleByAgent(rec: WorkspaceRecord, result: CliResult, options: RunOptions): Promise<CliOutcome | null> {
    const items: IntentItem[] = [...result.asks, ...result.reviews]
    if (items.length === 0) return null
    const decided = await decideConflicts(rec.slug, items, {
      merge: deps.mergeIntent,
      decideFast: deps.decideFast,
      reasonsFor: reasonsLookup(rec),
      timers: deps.timers,
      log: deps.log,
    })
    if (decided.decisions.length === 0) {
      deps.log('the agent decided nothing; the pause waits for a person', { slug: rec.slug, items: items.length })
      return null
    }
    const batch = JSON.stringify({
      decisions: decided.decisions.map((decision) => ({
        id: decision.id,
        take: decision.take,
        ...(decision.take === 'file' ? { content: decision.content ?? '' } : {}),
      })),
    })
    const temp = await deps.writeTempText(batch)
    let answer: CliOutcome
    try {
      answer = await callCli(rec, {
        message: options.message,
        timeoutMs: WORKSPACE_SYNC_TIMEOUT_MS,
        decisions: temp.path,
        hold: decided.needsYou.map((item) => item.id),
        noPush: true,
      })
    } finally {
      await temp.dispose().catch(() => undefined)
    }
    if (answer.kind !== 'result') {
      deps.log('the agent\'s decisions were not applied; the pause waits for a person', {
        slug: rec.slug,
        answer: answer.kind === 'refused' ? answer.reason : 'unavailable',
      })
      return null
    }
    if (answer.result.state === 'merged-local') {
      const fresh = openReviewOf(deps.now(), items, decided, answer.result)
      rec.review = rec.review === null ? fresh : mergeReviews(rec.review, fresh)
    }
    return answer
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
    if (rec.review !== null) {
      withHeld(rec.review, result.heldAside)
      if (rec.review.entries.length === 0) rec.review = null
    }
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
      case 'merged-local': {
        // Merged and committed HERE, nothing pushed: it waits for review.
        // Nothing retries on its own, and every run until it is agreed only
        // commits. A review this engine did not build (a restart, a terminal
        // run) is rebuilt from what the CLI recorded.
        clearTimers(rec)
        rec.retryAttempt = 0
        if (rec.review === null) {
          const rebuilt = reviewFromCli(deps.now(), result)
          rec.review = rebuilt.entries.length === 0 ? null : rebuilt
        }
        if (rec.review === null) {
          // Merged here with nothing to review (no decision in it): an ordinary sync publishes it.
          set(rec, 'idle', null)
          break
        }
        set(rec, 'review', WORKSPACE_SYNC_SENTENCES.mergedForReview(nameIn(rec), reviewSize(rec.review)))
        break
      }
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

  /** Waiting for a person: a decision, a review, or access only they can fix. */
  function waitsForPerson(rec: WorkspaceRecord): boolean {
    return rec.state === 'paused' || rec.state === 'no-access' || rec.state === 'review'
  }

  /**
   * While a review waits, a sync only COMMITS this computer's work: nothing
   * is fetched, nothing merged on top of what the person is reviewing, and
   * nothing published. The review state and its sentence stay as they are.
   */
  async function commitDuringReview(rec: WorkspaceRecord, label: string): Promise<void> {
    if (!mayRun(rec)) return
    const carried = rec.turnLabels.length
    const message = carried > 0 ? turnsMessage(rec.turnLabels) : commitMessage(label)
    const outcome = await callCli(rec, { message, timeoutMs: COMMIT_ONLY_TIMEOUT_MS, commitOnly: true })
    if (rec.forgotten) return
    if (outcome.kind === 'result') {
      rec.turnLabels.splice(0, carried)
      if (rec.review !== null) withHeld(rec.review, outcome.result.heldAside)
      emitIfChanged(rec)
    }
  }

  /** A sync nobody asked for: never over a pause or refused access, never while off; only a commit during a review. */
  async function background(rec: WorkspaceRecord, label: string, retryOnce = false): Promise<void> {
    if (!mayRun(rec)) return
    if (rec.state === 'review') {
      if (rec.turnLabels.length > 0) await commitDuringReview(rec, label)
      return
    }
    if (waitsForPerson(rec)) return
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
      if (rec.state === 'review') return background(rec, OPEN_LABEL)
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
    // A pause waits for a person: the turn is carried by the sync that settles
    // it. A review does not: the turn is committed here (and nothing more).
    if (waitsForPerson(rec) && rec.state !== 'review') return
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
      if (rec.state === 'review') {
        // A person asked during a review: share the agreed part if it is ready
        // (a share that failed is tried again here), otherwise only commit.
        if (readyToShare(rec.review)) await shareReview(rec)
        else await commitDuringReview(rec, SYNC_NOW_LABEL)
        return
      }
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

  // ── The review: agree, disagree, decide, share ──

  function refusal(rec: WorkspaceRecord, reason: WorkspaceReviewRefusal, detail: string): WorkspaceReviewResult {
    return { ok: false, reason, detail, status: statusOf(rec) }
  }

  /** Run one review request inside the Workspace's queue; anything thrown becomes `failed`. */
  async function reviewStep(slug: string, work: (rec: WorkspaceRecord, review: OpenReview) => Promise<WorkspaceReviewResult>): Promise<WorkspaceReviewResult> {
    if (!isWorkspaceSlug(slug)) {
      return { ok: false, reason: 'unknown-workspace', detail: WORKSPACE_SYNC_SENTENCES.unknownWorkspace, status: IDLE_STATUS(null) }
    }
    const rec = record(slug)
    let answer: WorkspaceReviewResult | null = null
    await enqueue(rec, async () => {
      if (closed || rec.forgotten) return
      if (rec.review === null) {
        answer = refusal(rec, 'not-waiting', WORKSPACE_SYNC_SENTENCES.reviewItemGone(nameIn(rec)))
        return
      }
      try {
        answer = await work(rec, rec.review)
      } catch (error) {
        deps.log('a review step failed', { slug, error: String(error) })
        answer = refusal(rec, 'failed', WORKSPACE_SYNC_SENTENCES.failed(nameIn(rec)))
      }
    })
    return answer ?? refusal(rec, 'failed', WORKSPACE_SYNC_SENTENCES.failed(nameIn(rec)))
  }

  /** The review's sentence again (after an item changed), unless the state says something else. */
  function reviewSentence(rec: WorkspaceRecord): void {
    if (rec.review !== null && rec.review.entries.length === 0) rec.review = null
    if (rec.state === 'review' && rec.review !== null) {
      set(rec, 'review', WORKSPACE_SYNC_SENTENCES.mergedForReview(nameIn(rec), reviewSize(rec.review)))
    } else emitIfChanged(rec)
  }

  /**
   * Append one line to the shared record through the CLI's verb (the ONE
   * writer). A line that cannot be written is logged; it never stops a review.
   */
  async function recordDecision(rec: WorkspaceRecord, entry: ReviewEntry, outcome: 'agreed' | 'disagreed', reason: string): Promise<boolean> {
    // A combine is not a decision about one file: the record holds file decisions only.
    if (entry.kind === 'combine') return false
    const project = projectOf(entry.path)
    if (project === null) {
      deps.log('a review decision names no project; not recorded', { slug: rec.slug })
      return false
    }
    const args = [
      'workspace',
      'merge-decision',
      'record',
      '--workspace',
      rec.slug,
      `--kind=${entry.kind}`,
      `--project=${project}`,
      `--path=${entry.path}`,
      `--take=${recordTake(entry)}`,
      `--summary=${recordSummary(entry)}`,
      `--reason=${oneLine(reason)}`,
      `--outcome=${outcome}`,
      '--json',
    ]
    try {
      const run = await deps.runCli(deps.cwd, args, { timeoutMs: RECORD_TIMEOUT_MS })
      const payload = lastJsonLine(run.stdout)
      if (run.ok && payload !== null && payload['action'] === 'merge-decision') return true
      deps.log('a review decision could not be recorded', { slug: rec.slug, refused: payload?.['refused'], error: run.error, stderr: tail(run.stderr) })
    } catch (error) {
      deps.log('a review decision could not be recorded', { slug: rec.slug, error: String(error) })
    }
    return false
  }

  /**
   * One local CLI step of a review — `--settle-held` or `--hold-back`, always
   * `--commit-only`: nothing fetched, merged or published. Answers the
   * refusal reason, or null when it was done.
   */
  async function localStep(rec: WorkspaceRecord, options: Pick<RunOptions, 'settleHeld' | 'holdBack'>, label: string): Promise<string | null> {
    const carried = rec.turnLabels.length
    const message = carried > 0 ? turnsMessage(rec.turnLabels) : commitMessage(label)
    const outcome = await callCli(rec, { message, timeoutMs: COMMIT_ONLY_TIMEOUT_MS, commitOnly: true, ...options })
    if (outcome.kind === 'refused') return outcome.reason
    if (outcome.kind === 'unavailable') return 'unavailable'
    rec.turnLabels.splice(0, carried)
    if (rec.review !== null) withHeld(rec.review, outcome.result.heldAside)
    return null
  }

  /**
   * Share the agreed part: record every agreed decision not recorded yet (one
   * CLI run at a time), then ONE sync with `--agreed` — the only run that may
   * publish a review. Held items go out as the Workspace's version. Answers
   * null when it was shared, or the sentence saying why it was not: a share
   * that did not go out is never reported as done (forbidden-pattern #20).
   */
  async function shareReview(rec: WorkspaceRecord): Promise<string | null> {
    const review = rec.review
    if (review === null) return null
    for (const entry of review.entries) {
      if (entry.state !== 'agreed' || entry.recorded) continue
      entry.recorded = await recordDecision(rec, entry, 'agreed', entry.disagreedReason ?? entry.reason)
    }
    const message = rec.turnLabels.length > 0 ? turnsMessage(rec.turnLabels) : commitMessage(REVIEW_LABEL)
    const outcome = await sync(rec, { message, timeoutMs: WORKSPACE_SYNC_TIMEOUT_MS, agreed: true }, false)
    if (rec.forgotten) return null
    if (outcome.kind === 'result' && (outcome.result.state === 'synced' || outcome.result.state === 'nothing-to-do')) {
      // Shared: what was agreed is out. What is still held aside waits for a
      // person, and no longer holds anything back.
      if (rec.review !== null) {
        rec.review.entries = rec.review.entries.filter((entry) => entry.state !== 'agreed')
        if (rec.review.entries.length === 0) rec.review = null
      }
      emitIfChanged(rec)
      return null
    }
    if (outcome.kind === 'result' && outcome.result.state === 'merged-local') {
      // New changes came in and the agent settled them: they join the review.
      return WORKSPACE_SYNC_SENTENCES.newChangesArrived(nameIn(rec))
    }
    if (outcome.kind === 'result' && (outcome.result.state === 'ask' || outcome.result.state === 'review')) {
      // New changes wait for a person (the pause): the review waits behind it.
      return rec.detail ?? WORKSPACE_SYNC_SENTENCES.notShared(nameIn(rec))
    }
    // Refused, offline, no access, an error: nothing was shared. The review
    // stays open and SAYS so; nothing retries on its own ("Sync now" or the
    // next agree tries again), so nothing else can run over it.
    const why = rec.detail ?? WORKSPACE_SYNC_SENTENCES.notShared(nameIn(rec))
    const cause = rec.cause
    clearTimers(rec)
    if (rec.review !== null) set(rec, 'review', why, undefined, cause)
    return why
  }

  /**
   * FR-9 — agreed groups are shared as soon as they are agreed; the rest waits
   * here. Items nobody has looked at yet (`pending`) are committed with the
   * agent's decision, so before an agree shares anything they are ALL put back
   * to the Workspace's version in ONE local run (`--hold-back … --commit-only`),
   * this computer's text held aside. Each stays in its group as `held`, with
   * the agent's decision and reason, so the person can still agree it later —
   * which writes that decision (`settleEntry`). A `file` decision whose text is
   * not remembered (a review rebuilt after a restart) becomes the person's to
   * decide. Answers null when done or when there was nothing to hold, else the
   * sentence saying why nothing was shared.
   */
  async function holdBackPending(rec: WorkspaceRecord): Promise<string | null> {
    const review = rec.review
    if (review === null) return null
    const pending = review.entries.filter((entry) => entry.state === 'pending')
    if (pending.length === 0 || !review.entries.some((entry) => entry.state === 'agreed')) return null
    const refused = await localStep(rec, { holdBack: pending.map((entry) => entry.id) }, HOLD_BACK_PENDING_LABEL)
    if (refused === 'stale-decision') return WORKSPACE_SYNC_SENTENCES.pendingChanged(nameIn(rec))
    if (refused === 'unknown-review-item' || refused === 'unavailable') return WORKSPACE_SYNC_SENTENCES.notShared(nameIn(rec))
    if (refused !== null) return refusalSentence(refused, nameIn(rec))
    for (const entry of pending) {
      entry.state = 'held'
      entry.heldHere = true
      if (!decisionKept(entry)) Object.assign(entry, { section: 'held', group: null, take: null, reason: '' })
    }
    return null
  }

  /**
   * After a request changed items: share when ready, and answer honestly.
   * `holdPending` (an agree): what nobody has looked at yet is held back
   * first, so the agreed part goes out now.
   */
  async function afterChange(rec: WorkspaceRecord, holdPending = false): Promise<WorkspaceReviewResult> {
    if (holdPending) {
      const why = await holdBackPending(rec)
      if (why !== null) {
        // Nothing was shared, and the review SAYS so (forbidden-pattern #20).
        if (rec.review !== null) set(rec, 'review', why)
        return refusal(rec, 'not-shared', why)
      }
    }
    if (readyToShare(rec.review)) {
      const why = await shareReview(rec)
      if (why !== null) return refusal(rec, 'not-shared', why)
      return { ok: true, status: statusOf(rec) }
    }
    reviewSentence(rec)
    return { ok: true, status: statusOf(rec) }
  }

  /** Settle a held entry to what was decided, as a local commit. Null when done, else the refusal for the person. */
  async function settleEntry(rec: WorkspaceRecord, entry: ReviewEntry, take: 'ours' | 'theirs' | 'file', text: string | null): Promise<WorkspaceReviewResult | null> {
    let temp: TempText | null = null
    // Marked agreed BEFORE the run answers: its answer no longer lists the
    // item as held, and an unagreed entry that is no longer held is dropped.
    const before = { state: entry.state, heldHere: entry.heldHere }
    try {
      if (take === 'file') temp = await deps.writeTempText(text ?? '')
      entry.state = 'agreed'
      entry.heldHere = false
      const refused = await localStep(rec, { settleHeld: { id: entry.id, take: temp === null ? take : `file:${temp.path}` } }, SETTLE_LABEL)
      if (refused !== null) Object.assign(entry, before)
      if (refused === 'unknown-held') {
        // Settled elsewhere meanwhile: it no longer waits here.
        if (rec.review !== null) rec.review.entries = rec.review.entries.filter((candidate) => candidate !== entry)
        reviewSentence(rec)
        return refusal(rec, 'not-waiting', WORKSPACE_SYNC_SENTENCES.reviewItemGone(nameIn(rec)))
      }
      if (refused !== null) return refusal(rec, 'failed', refusalSentence(refused, nameIn(rec)))
      return null
    } catch (error) {
      Object.assign(entry, before)
      throw error
    } finally {
      if (temp !== null) await temp.dispose().catch(() => undefined)
    }
  }

  async function reviewAgree(request: WorkspaceReviewAgreeRequest): Promise<WorkspaceReviewResult> {
    return reviewStep(request.slug, async (rec, review) => {
      let chosen: ReviewEntry[]
      if (request.allGroups === true) {
        // "Agree to all groups": every group item a person may agree to; never "Needs you".
        chosen = review.entries.filter((entry) => entry.section === 'group' && agreeable(entry))
        if (chosen.length === 0) return refusal(rec, 'not-waiting', WORKSPACE_SYNC_SENTENCES.reviewItemGone(nameIn(rec)))
      } else {
        chosen =
          request.group !== undefined
            ? review.entries.filter((entry) => entry.section === 'group' && entry.group === request.group)
            : review.entries.filter((entry) => (request.ids ?? []).includes(entry.id))
        if (chosen.length === 0 || (request.ids !== undefined && chosen.length !== new Set(request.ids).size)) {
          return refusal(rec, 'not-waiting', WORKSPACE_SYNC_SENTENCES.reviewItemGone(nameIn(rec)))
        }
        // A person's own choice is never made in bulk: refuse the whole request.
        if (chosen.some((entry) => entry.state !== 'agreed' && !agreeable(entry))) {
          return refusal(rec, 'needs-decision', WORKSPACE_SYNC_SENTENCES.needsDecision)
        }
      }
      // What is held aside is written here first, one local commit each: a
      // redo as redone, a held-back decision exactly as the agent made it.
      for (const entry of chosen) {
        let failed: WorkspaceReviewResult | null = null
        if (entry.state === 'redone' && entry.redo !== null) {
          failed = await settleEntry(rec, entry, entry.redo.take, entry.redo.content ?? null)
        } else if (entry.state === 'held' && entry.take !== null) {
          failed = await settleEntry(rec, entry, entry.take, entry.content)
        }
        if (failed !== null) return failed
      }
      for (const entry of chosen) {
        if (entry.state === 'pending') entry.state = 'agreed'
      }
      return afterChange(rec, true)
    })
  }

  async function reviewDisagree(request: WorkspaceReviewDisagreeRequest): Promise<WorkspaceReviewResult> {
    return reviewStep(request.slug, async (rec, review) => {
      const reason = request.reason.trim()
      if (reason === '') return refusal(rec, 'reason-required', WORKSPACE_SYNC_SENTENCES.reasonRequired)
      const chosen = review.entries.filter((entry) => request.ids.includes(entry.id))
      if (chosen.length === 0 || chosen.length !== new Set(request.ids).size) {
        return refusal(rec, 'not-waiting', WORKSPACE_SYNC_SENTENCES.reviewItemGone(nameIn(rec)))
      }
      // A held-back group item still carries the agent's decision: it may be disagreed with (already held aside).
      if (chosen.some((entry) => entry.state !== 'pending' && entry.state !== 'redone' && !(entry.state === 'held' && decisionKept(entry)))) {
        return refusal(rec, 'needs-decision', WORKSPACE_SYNC_SENTENCES.needsDecision)
      }
      // The agent's committed decisions go back to the Workspace's version
      // first, this computer's text held aside — so they never hold the share.
      const toHold = chosen.filter((entry) => entry.state === 'pending').map((entry) => entry.id)
      if (toHold.length > 0) {
        const refused = await localStep(rec, { holdBack: toHold }, HOLD_BACK_LABEL)
        if (refused === 'stale-decision') return refusal(rec, 'stale', WORKSPACE_SYNC_SENTENCES.reviewStale)
        if (refused === 'unknown-review-item') return refusal(rec, 'not-waiting', WORKSPACE_SYNC_SENTENCES.reviewItemGone(nameIn(rec)))
        if (refused !== null) return refusal(rec, 'failed', refusalSentence(refused, nameIn(rec)))
      }
      for (const entry of chosen) {
        await recordDecision(rec, entry, 'disagreed', reason)
        entry.heldHere = true
        entry.disagreedReason = oneLine(reason)
        // A second disagreement: the person decides it (FR-8). No third try.
        entry.state = entry.state === 'redone' ? 'needs-you' : 'disagreed'
      }
      await redo(rec, chosen.filter((entry) => entry.state === 'disagreed'), reason)
      return afterChange(rec)
    })
  }

  /**
   * The agent decides disagreed items ONCE more, with the person's reason as
   * guidance beside the recorded ones. A redo is held aside until agreed.
   * Without the item's two sides (a restart), or without an answer, the item
   * is left to the person.
   */
  async function redo(rec: WorkspaceRecord, entries: readonly ReviewEntry[], reason: string): Promise<void> {
    const review = rec.review
    if (review === null || entries.length === 0) return
    const items = entries.flatMap((entry) => {
      const item = review.items.get(entry.id)
      return item === undefined ? [] : [item]
    })
    const recorded = reasonsLookup(rec)
    const decided =
      items.length === 0
        ? { decisions: [], needsYou: [] }
        : await decideConflicts(rec.slug, items, {
            merge: deps.mergeIntent,
            decideFast: deps.decideFast,
            reasonsFor: async (kind, project) => [
              `A person disagreed with the earlier decision for this item. Their reason: ${oneLine(reason)}`,
              ...(await recorded(kind, project)),
            ],
            timers: deps.timers,
            log: deps.log,
          })
    for (const entry of entries) {
      const decision = decided.decisions.find((candidate) => candidate.id === entry.id)
      if (decision !== undefined) {
        entry.state = 'redone'
        entry.redo = { take: decision.take, reason: decision.reason, ...(decision.take === 'file' ? { content: decision.content ?? '' } : {}) }
        continue
      }
      const left = decided.needsYou.find((candidate) => candidate.id === entry.id)
      entry.state = 'needs-you'
      entry.suggestion = left?.suggestion === undefined ? null : { ...left.suggestion }
    }
  }

  async function reviewDecide(request: WorkspaceReviewDecideRequest): Promise<WorkspaceReviewResult> {
    return reviewStep(request.slug, async (rec, review) => {
      const entry = review.entries.find((candidate) => candidate.id === request.id)
      if (entry === undefined) return refusal(rec, 'not-waiting', WORKSPACE_SYNC_SENTENCES.reviewItemGone(nameIn(rec)))
      // Only an item held aside can be settled here: its text was never committed.
      if (!entry.heldHere || entry.state === 'agreed' || entry.state === 'pending') {
        return refusal(rec, 'not-allowed', WORKSPACE_SYNC_SENTENCES.reviewNotAllowed)
      }
      const take = request.take === 'text' ? 'file' : request.take
      const failed = await settleEntry(rec, entry, take, request.take === 'text' ? request.text : null)
      if (failed !== null) return failed
      entry.decided = take
      return afterChange(rec)
    })
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

  return { open, commitAfterTurn, syncNow, resolve, reviewAgree, reviewDisagree, reviewDecide, status, forget, quit }
}

/** The last part of a CLI stream, for a log line — never the whole thing. */
function tail(text: string | undefined, max = 2000): string {
  if (text === undefined || text === '') return ''
  return text.length <= max ? text : `…${text.slice(-max)}`
}
