// ThreadStore — persistence for threads, messages, and tool calls.
//
// Single writer over the Flow database. Emits `change` events so the IPC
// layer can broadcast updates to renderer windows without polling.

import { EventEmitter } from 'events'
import { repointedTabs } from './repoint-tabs'
import { TabSetStore } from './tab-set-store'
import { randomUUID } from 'crypto'
import { join } from 'path'

import type { FlowDatabase } from './db'
import { withTransaction } from './db'
import { PROJECT_STATE_TABLE, THREAD_PROJECT_ROOT_COLUMN } from './storage-names'

export type ThreadStatus = 'idle' | 'working' | 'needs-decision' | 'blocked' | 'done' | 'failed'
export type MessageRole = 'user' | 'assistant' | 'system'
/** Mirrors the contract's ToolCallStatus — `interrupted` is a deliberate stop,
 *  never a failure (#1217). */
export type ToolCallStatus =
  | 'pending'
  | 'running'
  | 'success'
  | 'error'
  | 'denied'
  | 'interrupted'

export interface ThreadRecord {
  id: string
  projectRoot: string
  title: string
  sdkSessionId: string | null
  model: string | null
  effort: string | null
  status: ThreadStatus
  createdAt: string
  updatedAt: string
  /** ISO timestamp the thread was archived, or null when active. */
  archivedAt: string | null
  /** ISO timestamp the thread was imported from a Claude Code session, or null
   *  when it is a native app thread. */
  importedAt: string | null
  /** ISO timestamp the thread was pinned, or null when unpinned. Pinned threads
   *  bypass the sidebar's recency filter and sort to the top. */
  pinnedAt: string | null
  /** When true, the SDK session runs in bypassPermissions mode (no prompts). */
  bypassPermissions: boolean
  /**
   * The loop this thread IS a run of, or null for an ordinary conversation.
   *
   * Set once, at creation, and never rewritten: a run does not stop having been
   * a run when it finishes, and the sidebar's glyph, the board's card and the
   * loops screen all read this one field rather than guessing from the title.
   */
  originLoop: string | null
  /** The sentence that run was pointed at, verbatim — null when it had none. */
  originAim: string | null
  /** The run's name (`TOL-001`), minted when it started. Null off a loop. */
  originKey: string | null
  /** Parent conversation when this thread is a promoted SUB-AGENT (#1931), else
   *  null/absent for an ordinary top-level thread. */
  parentThreadId?: string | null
  /** The parent's Task tool-call this thread was promoted from (#1931), else
   *  null/absent — used for idempotent promotion and continuation seeding. */
  originToolCallId?: string | null
  /**
   * Absolute path of the git worktree this thread owns, or null when it has
   * none (a chat-only thread, and every thread that predates the feature).
   *
   * Stored EXACTLY as `planflow-ai worktree` returned it and never recomputed:
   * the command realpaths its target, so its answer is git's own spelling of
   * the path. A path derived here would disagree the moment a root is reached
   * through a symlink, and every match against `git worktree list` would miss.
   */
  worktreePath: string | null
  /**
   * The branch that worktree is on, or null while it is DETACHED — which is the
   * normal early state, not a failure: a thread has no title until its first
   * turn succeeds, so there is nothing to name a branch after until then. Read
   * null as "not named yet", never as "no worktree" (`worktreePath` answers
   * that).
   */
  worktreeBranch: string | null
  /** The ref the worktree was cut FROM. The only record of where the work is
   *  meant to land — re-deriving it from the project's current HEAD would
   *  retarget the merge every time the user switched branches. */
  worktreeBase: string | null
  /**
   * The remote this thread publishes to, or null while it is UNBOUND.
   *
   * MIRROR OF GIT, NOT THE TRUTH. `branch.<local>.remote` is authoritative;
   * these four fields exist so a list of fifteen worktrees costs no child
   * processes (allowed-pattern #19). When the two disagree — somebody used
   * plain git — git wins and the mirror is rewritten from it.
   */
  remote: string | null
  /**
   * The branch name on that remote — which is NOT the local branch name and
   * usually differs wherever a project has a naming convention.
   *
   * Null means unbound: nobody has decided where this thread publishes. Unbound
   * is refused at push and asked about, never quietly filled in from the local
   * name — the wrong-but-valid push is the failure this whole field exists to
   * prevent.
   */
  remoteBranch: string | null
  /**
   * The branch a pull request from this thread opens against, or null to fall
   * back to `worktreeBase`. The one part of a binding git has no config slot
   * for, and the reason the mirror cannot be replaced by reading git alone.
   */
  prBase: string | null
  /**
   * The remote branch this thread used to be bound to, kept after a rename
   * re-pointed the upstream. The old branch is STILL ON THE REMOTE — nothing
   * here deletes it — and this is what lets a surface say so instead of
   * leaving an orphan to be discovered.
   */
  previouslyPushedAs: string | null
  /**
   * True when this checkout was cut from a base that could not be refreshed
   * first — the remote was slow, unreachable, or somebody stopped waiting.
   *
   * A FLAG, NOT A FAILURE. The cut happened and the work in it is fine; what is
   * unknown is whether the branch it started from was current. False is the
   * ordinary answer — a thread with no checkout, and a checkout whose refresh
   * completed, both honestly report nothing known to be behind.
   */
  baseMayBeBehind: boolean
  /**
   * The autopilot chain driving this thread, or null when none is.
   *
   * Null is the ordinary answer: an ordinary conversation has no chain, and a
   * thread whose chain ended has none any more. A value means a driver is
   * issuing this thread's steps, and it names WHICH run — so two chains on one
   * project are told apart in the record the way they are in memory.
   */
  chainId: string | null
  /**
   * The step of the flow that chain last issued — `discovery`, `create-plan`,
   * `execute-plan`, `review-code` — or null when nothing is being driven.
   *
   * WRITTEN BY THE DRIVER, NOT BY THE AGENT. This is what makes "which step is
   * this thread on" answerable without inferring it from what the model said
   * about itself, which is the whole reason the column exists. A stage name a
   * build does not recognise is simply a chain it cannot draw.
   */
  chainStage: string | null
}

/** The chain a driver is running on a thread, as it hands it to the store. */
export interface ThreadChain {
  /** The run's id. */
  chainId: string
  /** The step it last issued, or null before it has issued one. */
  stage: string | null
}

/**
 * Where a thread publishes, as a caller hands it to the store.
 *
 * `remote` and `remoteBranch` are required together because half a binding is
 * not a binding — a remote with no branch would read as bound and push nowhere.
 * `previouslyPushedAs` is optional and, when omitted, LEAVES the existing value
 * alone: a rename records the old name once, and a later edit of the PR base
 * must not erase that record.
 */
export interface ThreadBinding {
  remote: string
  remoteBranch: string
  prBase: string | null
  previouslyPushedAs?: string | null
}

export interface MessageRecord {
  id: string
  threadId: string
  role: MessageRole
  content: string
  createdAt: string
  /** The model that produced an assistant message (#129); null for user/system
   *  rows and for messages persisted before this was tracked. */
  model: string | null
  /** True on the assistant message that ended its turn (schema v36, see
   *  markTurnEnd). Present ONLY when set — an unmarked row, including every row
   *  written before v36, leaves the field out, so old payloads are unchanged. */
  endsTurn?: boolean
  /** Parent Task tool-call id when this is a SUB-AGENT message; null/absent on
   *  the main thread (#1931 — sub-agent sub-chats). */
  parentToolCallId?: string | null
}

export interface ToolCallRecord {
  id: string
  threadId: string
  messageId: string | null
  toolName: string
  inputJson: string | null
  outputJson: string | null
  status: ToolCallStatus
  startedAt: string
  completedAt: string | null
  /** Parent Task tool-call id when this is a SUB-AGENT tool call; null/absent on
   *  the main thread (#1931 — sub-agent sub-chats). */
  parentToolCallId?: string | null
  /** The sub-agent this SPAWN tool call started (the runtime's `task_id`, which
   *  is also the SDK session-storage transcript key) — null/absent for every
   *  call that is not a spawn, and for spawns that predate the capture (#1931
   *  transcript backfill). Written once via setToolCallAgentId. */
  agentId?: string | null
  /** Set when a BOUNDED read deliberately left the output behind — the store
   *  decides this now, because it is the layer that can avoid loading the blob
   *  at all. Never stored; see the contract's field for what a card owes the
   *  reader when it is true (withheld is not empty). */
  outputWithheld?: boolean
}

/** The analyzer projection of a tool call (brain usage/savings): everything
 *  except thread_id/message_id, which per-thread readers already know. */
export interface ToolCallSlimRecord {
  id: string
  toolName: string
  inputJson: string | null
  outputJson: string | null
  status: ToolCallStatus
  startedAt: string
  completedAt: string | null
}

export interface CreateThreadInput {
  projectRoot: string
  title?: string
  model?: string
  effort?: string
  /** Explicit permission mode. When omitted, the app-wide autonomy default applies. */
  bypassPermissions?: boolean
  /** The loop this thread runs — set only by the press that starts a run. */
  originLoop?: string
  /** What that run was pointed at, verbatim. */
  originAim?: string
  /** The run's key (`TOL-001`), minted by the caller that started it. */
  originKey?: string
  /** Parent conversation when creating a promoted sub-agent child thread (#1931). */
  parentThreadId?: string
  /** The parent's Task tool-call this child thread is promoted from (#1931). */
  originToolCallId?: string
}

/** One imported message carrying its ORIGINAL Claude Code timestamp. */
export interface ImportMessageInput {
  role: MessageRole
  content: string
  createdAt: string
}

/**
 * A whole Claude Code session imported in one shot. Unlike createThread +
 * appendMessage, every timestamp is EXPLICIT so the imported thread sorts by
 * its original session times (NFR4) and each message keeps its own time — the
 * standard write API would stamp `now` and bump updated_at on every append.
 */
export interface ImportThreadInput {
  projectRoot: string
  title: string
  /** Claude Code sessionId — stored as sdk_session_id (dedup + resume handle). */
  sdkSessionId: string
  createdAt: string
  updatedAt: string
  importedAt: string
  messages: ImportMessageInput[]
}

export interface UpdateThreadInput {
  title?: string
  model?: string | null
  effort?: string | null
  status?: ThreadStatus
  /** true archives (sets archived_at=now), false unarchives (clears it). */
  archived?: boolean
  /** true pins (sets pinned_at=now), false unpins (clears it). */
  pinned?: boolean
  /** Run the thread's session with permission prompts skipped (bypassPermissions). */
  bypassPermissions?: boolean
}

export interface ThreadChangeEvent {
  entity: 'thread' | 'message' | 'tool_call'
  action: 'created' | 'updated' | 'deleted'
  threadId: string
  /**
   * The checkout the row had, present ONLY on a thread deletion that had one.
   *
   * WHY THE EVENT CARRIES IT. A deletion is the one change whose subject cannot
   * be looked up afterwards: by the time a listener hears, the row naming the
   * checkout is gone, and a release would have nothing to point at. Reading it
   * here — once, in the single place every delete door passes through — is what
   * lets the files be freed without a second deletion path going looking for
   * them (allowed-pattern #23: optional, so no other caller has to answer it,
   * and absent means "there was none" rather than "nobody asked").
   *
   * It is a fact about what WAS there, not an instruction. Nothing in this
   * store acts on it.
   */
  abandoned?: { projectRoot: string; worktreePath: string; branch: string | null }
}

/** Emitted for every mutation. Payload: ThreadChangeEvent. */
export const THREAD_STORE_CHANGE_EVENT = 'change'

/** Emitted whenever the thread_roots table is written (add/replace/prune) —
 *  the thread-scope layer's re-derivation trigger. `threadId` is null for a
 *  path-wide prune (pruneThreadRootsByPath touches many threads at once).
 *  Separate from THREAD_STORE_CHANGE_EVENT on purpose: thread_roots writes
 *  never fed `threads:updated` and existing behavior stays untouched. */
export const THREAD_ROOTS_CHANGED_EVENT = 'thread-roots-changed'

/** Payload for THREAD_ROOTS_CHANGED_EVENT. */
export interface ThreadRootsChangedEvent {
  threadId: string | null
}

interface ThreadRow {
  id: string
  /** Physical column name kept for cross-build compatibility (storage-names.ts). */
  [THREAD_PROJECT_ROOT_COLUMN]: string
  title: string
  sdk_session_id: string | null
  model: string | null
  effort: string | null
  status: string
  created_at: string
  updated_at: string
  archived_at: string | null
  imported_at: string | null
  pinned_at: string | null
  bypass_permissions: number
  origin_loop: string | null
  origin_aim: string | null
  origin_key: string | null
  parent_thread_id: string | null
  origin_tool_call_id: string | null
  worktree_path: string | null
  worktree_branch: string | null
  worktree_base: string | null
  remote: string | null
  remote_branch: string | null
  pr_base: string | null
  previously_pushed_as: string | null
  base_may_be_behind: number | null
  chain_id: string | null
  chain_stage: string | null
}

interface MessageRow {
  id: string
  thread_id: string
  role: string
  content: string
  created_at: string
  model: string | null
  /** 1 on the assistant message that ended its turn; 0 otherwise (v36 default). */
  ends_turn: number
  /** Parent Task tool-call id for a sub-agent message; null on the main thread (#1931). */
  parent_tool_call_id: string | null
}

interface ToolCallRow {
  id: string
  thread_id: string
  message_id: string | null
  tool_name: string
  input_json: string | null
  output_json: string | null
  status: string
  started_at: string
  completed_at: string | null
  /** Parent Task tool-call id for a sub-agent tool call; null on the main thread (#1931). */
  parent_tool_call_id: string | null
  /** The sub-agent a SPAWN call started (schema v38); null everywhere else (#1931). */
  agent_id?: string | null
}

/** The trace a quit-interrupted turn leaves in its transcript (#1216). */
export const QUIT_INTERRUPTION_NOTE =
  'Interrupted — Flow was closed while this turn was running'

export class ThreadStore extends EventEmitter {
  /** PERF-4: whether the FTS5 search index exists — detected once, lazily. */
  private ftsAvailable: boolean | null = null

  /**
   * @param defaultBypassPermissions app-wide autonomy default applied to new
   *   threads when `createThread` is not given an explicit `bypassPermissions`.
   * @param defaultModelSelection the user's persisted model+effort preference
   *   (#848/#885), applied when a thread is created or imported with no
   *   explicit model. Lives HERE — the one code path every creator (sidebar
   *   threads, task threads, Claude-session imports) goes through — so no
   *   creation path can silently skip it again.
   */
  constructor(
    private readonly db: FlowDatabase,
    private readonly defaultBypassPermissions: () => boolean = () => false,
    private readonly defaultModelSelection: () => { model: string | null; effort: string | null } = () => ({
      model: null,
      effort: null,
    }),
  ) {
    super()
  }

  /** Model+effort a new/imported thread starts with when the input carries no
   *  explicit model: the persisted preference. Auto carries no effort (#332). */
  #preferredModelSelection(): { model: string | null; effort: string | null } {
    const preferred = this.defaultModelSelection()
    if (preferred.model === null) return { model: null, effort: null }
    return { model: preferred.model, effort: preferred.model === 'auto' ? null : preferred.effort }
  }

  // ── Threads ────────────────────────────────────────────────────────────

  createThread(input: CreateThreadInput): ThreadRecord {
    const now = new Date().toISOString()
    // Explicit input wins; otherwise inherit the app-wide autonomy default (#48).
    const bypassPermissions = input.bypassPermissions ?? this.defaultBypassPermissions()
    // Explicit model wins; otherwise the persisted preference (#848/#885).
    const preferred = input.model === undefined ? this.#preferredModelSelection() : null
    const thread: ThreadRecord = {
      id: randomUUID(),
      projectRoot: input.projectRoot,
      title: input.title ?? 'New thread',
      sdkSessionId: null,
      model: input.model ?? preferred?.model ?? null,
      effort: input.effort ?? preferred?.effort ?? null,
      status: 'idle',
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      importedAt: null,
      pinnedAt: null,
      bypassPermissions,
      originLoop: input.originLoop ?? null,
      originAim: input.originAim ?? null,
      originKey: input.originKey ?? null,
      parentThreadId: input.parentThreadId ?? null,
      originToolCallId: input.originToolCallId ?? null,
      // A worktree is never created here. It is cut at the thread's first
      // message, by the layer that owns the CLI, and written back through
      // `setThreadWorktree` — a thread that is only ever chatted to keeps all
      // three nulls for its whole life.
      worktreePath: null,
      worktreeBranch: null,
      worktreeBase: null,
      // Nothing publishes at creation, so nothing is bound at creation. The
      // binding is decided by a person at the first push and written back
      // through `setThreadBinding`; a thread that never pushes keeps these
      // four nulls for its whole life and is never asked about them.
      remote: null,
      remoteBranch: null,
      prBase: null,
      previouslyPushedAs: null,
      // Nothing was cut, so nothing was cut from a stale base.
      baseMayBeBehind: false,
      // A thread is not born chained. A driver writes these when it starts
      // issuing steps and clears them when it ends.
      chainId: null,
      chainStage: null,
    }
    this.db
      .prepare(
        `INSERT INTO threads (id, ${THREAD_PROJECT_ROOT_COLUMN}, title, sdk_session_id, model, effort, status, created_at, updated_at, bypass_permissions, origin_loop, origin_aim, origin_key, parent_thread_id, origin_tool_call_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        thread.id,
        thread.projectRoot,
        thread.title,
        thread.sdkSessionId,
        thread.model,
        thread.effort,
        thread.status,
        thread.createdAt,
        thread.updatedAt,
        bypassPermissions ? 1 : 0,
        thread.originLoop,
        thread.originAim,
        thread.originKey,
        thread.parentThreadId,
        thread.originToolCallId,
      )
    this.emitChange({ entity: 'thread', action: 'created', threadId: thread.id })
    return thread
  }

  // ── Multi-project threads (#45) ──────────────────────────────────────────
  // A thread's PRIMARY project is threads.workspace_root (the project root); ADDITIONAL projects
  // live in thread_roots. getThreadRoots returns the extras only (never the
  // primary), so callers can compose the full set as [primary, ...extras].

  /** Add one additional root to a thread (idempotent via the UNIQUE index). */
  addThreadRoot(threadId: string, rootPath: string): void {
    this.db
      .prepare('INSERT OR IGNORE INTO thread_roots (thread_id, root_path) VALUES (?, ?)')
      .run(threadId, rootPath)
    this.emitThreadRootsChanged(threadId)
  }

  /** Replace a thread's additional roots with `roots` (deduped, primary-safe). */
  setThreadRoots(threadId: string, roots: readonly string[]): void {
    const primary = this.getThread(threadId)?.projectRoot ?? null
    const extras = [...new Set(roots)].filter((root) => root && root !== primary)
    const replace = this.db.transaction((rows: string[]) => {
      this.db.prepare('DELETE FROM thread_roots WHERE thread_id = ?').run(threadId)
      const insert = this.db.prepare(
        'INSERT OR IGNORE INTO thread_roots (thread_id, root_path) VALUES (?, ?)',
      )
      for (const root of rows) insert.run(threadId, root)
    })
    replace(extras)
    this.emitThreadRootsChanged(threadId)
  }

  /** A thread's additional roots (excludes the primary project root).
   *  PERF: called for every thread on every threads:list — the statement is
   *  prepared once, lazily, instead of re-parsed per call. */
  getThreadRoots(threadId: string): string[] {
    this.threadRootsStmt ??= this.db.prepare(
      'SELECT root_path FROM thread_roots WHERE thread_id = ? ORDER BY root_path ASC',
    )
    const rows = this.threadRootsStmt.all(threadId) as Array<{ root_path: string }>
    return rows.map((row) => row.root_path)
  }

  /** Lazily-prepared hot statement backing getThreadRoots. */
  private threadRootsStmt: ReturnType<FlowDatabase['prepare']> | null = null

  /**
   * Where a session works in each of the thread's OTHER projects: that
   * project's thread checkout when it has one, its main checkout otherwise.
   * Same order as getThreadRoots.
   *
   * The session's extra folders must ask HERE, not getThreadRoots. Asking for
   * the attached projects themselves handed every runtime their MAIN
   * checkouts — so a thread isolated across two repos was writing straight
   * into the reader's tree in the second one, beside the checkout made for it.
   * The primary project's checkout is `sessionRootFor`'s answer, not a row.
   */
  getThreadSessionRoots(threadId: string, exclude?: (rootPath: string) => boolean): string[] {
    const rows = this.db
      .prepare(
        `SELECT root_path, worktree_path FROM thread_roots
          WHERE thread_id = ? ORDER BY root_path ASC`,
      )
      .all(threadId) as Array<{ root_path: string; worktree_path: string | null }>
    // `exclude` is asked about the PROJECT (root_path), never its checkout: a
    // project still being learned is attached but not yet a session folder.
    return rows.filter((row) => exclude === undefined || !exclude(row.root_path)).map((row) =>
      row.worktree_path !== null && row.worktree_path !== '' ? row.worktree_path : row.root_path,
    )
  }

  /**
   * The checkouts a thread's OTHER projects have, if any.
   *
   * A thread can carry several projects, and until migration 33 only the one it
   * started in could have a checkout — so a multi-project thread was isolated in
   * one repository and writing straight into the others, with nothing on screen
   * saying so. These rows are the others.
   *
   * The PRIMARY project's checkout is not here; it lives on `threads` and always
   * has. The two never describe the same project, so they cannot disagree about
   * one (see migration 33 for why it was not moved).
   */
  getThreadRootWorktrees(
    threadId: string,
  ): Array<{ rootPath: string; worktreePath: string; branch: string | null; base: string | null }> {
    const rows = this.db
      .prepare(
        `SELECT root_path, worktree_path, worktree_branch, worktree_base
           FROM thread_roots
          WHERE thread_id = ? AND worktree_path IS NOT NULL
          ORDER BY root_path ASC`,
      )
      .all(threadId) as Array<{
      root_path: string
      worktree_path: string
      worktree_branch: string | null
      worktree_base: string | null
    }>
    return rows.map((row) => ({
      rootPath: row.root_path,
      worktreePath: row.worktree_path,
      branch: row.worktree_branch,
      base: row.worktree_base,
    }))
  }

  /**
   * The checkouts of `rootPath` held by threads that have it ATTACHED — the
   * reverse of `getThreadRootWorktrees`. A thread's checkout of its own
   * project is on `threads`; these are the others, and anything that asks
   * "who owns this project's checkouts" needs both halves.
   */
  listAttachedCheckouts(rootPath: string): Array<{ threadId: string; worktreePath: string }> {
    const rows = this.db
      .prepare(
        `SELECT thread_id, worktree_path FROM thread_roots
          WHERE root_path = ? AND worktree_path IS NOT NULL AND worktree_path != ''
          ORDER BY thread_id ASC`,
      )
      .all(rootPath) as Array<{ thread_id: string; worktree_path: string }>
    return rows.map((row) => ({ threadId: row.thread_id, worktreePath: row.worktree_path }))
  }

  /**
   * Record — or clear — one attached project's checkout.
   *
   * THE SINGLE WRITER for these three columns (allowed-pattern #14). `null`
   * clears the row's checkout without removing the project from the thread:
   * releasing a checkout and detaching a project are different acts, and a
   * writer that conflated them would make "let this copy go" quietly drop a
   * repository out of the conversation.
   *
   * A root the thread does not carry is ignored rather than inserted — this
   * records a fact ABOUT an attachment and must never create one.
   */
  setThreadRootWorktree(
    threadId: string,
    rootPath: string,
    worktree: { path: string; branch: string | null; base: string | null } | null,
  ): void {
    const result = this.db
      .prepare(
        `UPDATE thread_roots
            SET worktree_path = ?, worktree_branch = ?, worktree_base = ?
          WHERE thread_id = ? AND root_path = ?`,
      )
      .run(worktree?.path ?? null, worktree?.branch ?? null, worktree?.base ?? null, threadId, rootPath)
    if (result.changes > 0) {
      this.emitChange({ entity: 'thread', action: 'updated', threadId })
    }
  }

  /**
   * Roots for MANY threads in ONE query — the batched form of getThreadRoots.
   * threads:list and threads:search used to call getThreadRoots per returned
   * row, an N+1 that re-fired on every visible threads:updated batch and grew
   * with the lifetime thread count. This collapses it to a single IN-list read.
   * Returns a map from thread id to its additional roots; ids with no extra
   * roots are absent, so callers default to [] (allowed-pattern #18/#14).
   */
  getThreadRootsBatch(threadIds: readonly string[]): Map<string, string[]> {
    const result = new Map<string, string[]>()
    if (threadIds.length === 0) return result
    const placeholders = threadIds.map(() => '?').join(', ')
    const rows = this.db
      .prepare(
        `SELECT thread_id, root_path FROM thread_roots
         WHERE thread_id IN (${placeholders}) ORDER BY root_path ASC`,
      )
      .all(...threadIds) as Array<{ thread_id: string; root_path: string }>
    for (const row of rows) {
      const existing = result.get(row.thread_id)
      if (existing) existing.push(row.root_path)
      else result.set(row.thread_id, [row.root_path])
    }
    return result
  }

  /**
   * Remove `rootPath` from EVERY thread's additional-root set. Called when a
   * project is removed so a thread primaried elsewhere doesn't keep the removed
   * project in its SDK session scope / permission containment — the FK cascade
   * only fires on THREAD deletion, not project removal (#261). Returns the number
   * of rows pruned.
   */
  pruneThreadRootsByPath(rootPath: string): number {
    const pruned = this.db
      .prepare('DELETE FROM thread_roots WHERE root_path = ?')
      .run(rootPath).changes
    if (pruned > 0) {
      this.emitThreadRootsChanged(null) // path-wide — many threads may be affected
    }
    return pruned
  }

  /** The ONE thread_roots change announcement — every write above routes
   *  through here (thread-scope re-derivation trigger, allowed-pattern #14). */
  private emitThreadRootsChanged(threadId: string | null): void {
    const event: ThreadRootsChangedEvent = { threadId }
    this.emit(THREAD_ROOTS_CHANGED_EVENT, event)
  }

  /**
   * Import a whole Claude Code session as a thread in one transaction: the
   * thread row (with explicit created/updated/imported times + sdk_session_id)
   * plus every message (each keeping its original timestamp). Callers MUST
   * dedup on sdkSessionId first — the UNIQUE index on sdk_session_id will throw
   * on a re-import otherwise. Emits a single 'thread:created' change.
   */
  importThread(input: ImportThreadInput): ThreadRecord {
    // Imported sessions have no model of their own — start from the persisted
    // preference like every other new thread (#885).
    const preferred = this.#preferredModelSelection()
    const thread: ThreadRecord = {
      id: randomUUID(),
      projectRoot: input.projectRoot,
      title: input.title,
      sdkSessionId: input.sdkSessionId,
      model: preferred.model,
      effort: preferred.effort,
      status: 'idle',
      createdAt: input.createdAt,
      updatedAt: input.updatedAt,
      archivedAt: null,
      importedAt: input.importedAt,
      pinnedAt: null,
      bypassPermissions: false,
      // An imported Claude Code session was not started from a loop here, and
      // nothing in the transcript could tell us it was somewhere else.
      originLoop: null,
      originAim: null,
      originKey: null,
      // …and it was never a promoted sub-agent of ours either (#1931).
      parentThreadId: null,
      originToolCallId: null,
      // An imported session ran in the user's own checkout, wherever that was;
      // it has no worktree of ours to point at.
      worktreePath: null,
      worktreeBranch: null,
      worktreeBase: null,
      // …and no binding either. Whatever that session pushed, it pushed from
      // the user's own checkout with the user's own git config; inferring a
      // binding from a transcript would be a guess wearing a record's clothes.
      remote: null,
      remoteBranch: null,
      prBase: null,
      previouslyPushedAs: null,
      baseMayBeBehind: false,
      // An imported session was never driven by a chain of ours, and nothing in
      // a transcript could say that it was.
      chainId: null,
      chainStage: null,
    }
    withTransaction(this.db, () => {
      this.db
        .prepare(
          `INSERT INTO threads (id, ${THREAD_PROJECT_ROOT_COLUMN}, title, sdk_session_id, model, effort, status, created_at, updated_at, imported_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          thread.id,
          thread.projectRoot,
          thread.title,
          thread.sdkSessionId,
          thread.model,
          thread.effort,
          thread.status,
          thread.createdAt,
          thread.updatedAt,
          thread.importedAt,
        )
      const insertMessage = this.db.prepare(
        'INSERT INTO messages (id, thread_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)',
      )
      for (const message of input.messages) {
        insertMessage.run(randomUUID(), thread.id, message.role, message.content, message.createdAt)
      }
    })
    this.emitChange({ entity: 'thread', action: 'created', threadId: thread.id })
    return thread
  }

  getThread(id: string): ThreadRecord | null {
    const row = this.db.prepare('SELECT * FROM threads WHERE id = ?').get(id) as
      | ThreadRow
      | undefined
    return row ? toThreadRecord(row) : null
  }

  /** The promoted sub-agent CHILD threads of a parent, newest first (#1931). */
  listChildThreads(parentThreadId: string): ThreadRecord[] {
    const rows = this.db
      .prepare(
        'SELECT * FROM threads WHERE parent_thread_id = ? AND archived_at IS NULL ORDER BY updated_at DESC',
      )
      .all(parentThreadId) as ThreadRow[]
    return rows.map(toThreadRecord)
  }

  /**
   * Promote a sub-agent (a parent Task tool-call) to a REAL child thread, or
   * return the existing one (idempotent by parent + origin tool-call) — #1931.
   * The child is seeded by RE-HOMING the sub-agent's persisted rows (schema v36,
   * `parent_tool_call_id`) into it, so the conversation pane can switch to it.
   */
  openSubagentThread(parentThreadId: string, toolCallId: string): ThreadRecord {
    const existing = this.db
      .prepare(
        'SELECT * FROM threads WHERE parent_thread_id = ? AND origin_tool_call_id = ? LIMIT 1',
      )
      .get(parentThreadId, toolCallId) as ThreadRow | undefined
    if (existing) {
      // Re-opening a DISMISSED child un-archives it (#1931 follow-up): the
      // sidebar's hover ✕ archives the child, and opening it again from the
      // Background activity popover is the explicit ask for it back — the
      // pane must never sit on a thread no list shows. Same rule (and same
      // metadata-only write, updated_at untouched) as the redirected-row
      // proof-of-life unarchive in #promotedChildId.
      if (existing.archived_at !== null) {
        this.db.prepare('UPDATE threads SET archived_at = NULL WHERE id = ?').run(existing.id)
        this.emitChange({ entity: 'thread', action: 'updated', threadId: existing.id })
        existing.archived_at = null
      }
      this.#rehomeSubagentRows(existing.id, parentThreadId, toolCallId)
      return toThreadRecord(existing)
    }
    const parent = this.getThread(parentThreadId)
    if (!parent) {
      throw new Error(`[ThreadStore] openSubagentThread: unknown parent ${parentThreadId}`)
    }
    const call = this.getToolCall(parentThreadId, toolCallId)
    const child = this.createThread({
      projectRoot: parent.projectRoot,
      title: subagentThreadTitle(call?.inputJson ?? null),
      parentThreadId,
      originToolCallId: toolCallId,
    })
    this.#rehomeSubagentRows(child.id, parentThreadId, toolCallId)
    return child
  }

  /**
   * The promoted child thread for a parent's sub-agent tool call, or null when
   * the sub-agent was never promoted (#1931).
   *
   * THE ONE MEDIATING LOOKUP for live child-thread sync (allowed-pattern #14):
   * `appendMessage` and `recordToolCall` both ask it when a write arrives
   * tagged with a `parentToolCallId`, and home the row DIRECTLY into the child
   * — so a promoted sub-agent's chat keeps receiving rows while the origin
   * session streams, with `threads:updated` events carrying the CHILD's id
   * (which is what the conversation pane bound to the child listens for).
   *
   * A redirected write is also PROOF OF LIFE: an archived child about to
   * receive one is demonstrably still running, so its `archived_at` is cleared
   * here — in the one lookup both writers share — and a thread `updated` event
   * re-shows it in the sidebar (the same event archive/unarchive emit via
   * `updateThread`). Otherwise the rows would land in a thread no list shows.
   */
  /**
   * Public face of the spawn → child lookup (#1931 live layer): the stream
   * bridge asks it at sub-agent MESSAGE boundaries to target live stream
   * events at the promoted child. Same code path, same proof-of-life
   * unarchive — live traffic for an archived child is evidence it still runs,
   * exactly like a redirected write.
   */
  promotedChildId(parentThreadId: string, toolCallId: string): string | null {
    return this.#promotedChildId(parentThreadId, toolCallId)
  }

  #promotedChildId(parentThreadId: string, toolCallId: string): string | null {
    const row = this.db
      .prepare(
        'SELECT id, archived_at FROM threads WHERE parent_thread_id = ? AND origin_tool_call_id = ? LIMIT 1',
      )
      .get(parentThreadId, toolCallId) as { id: string; archived_at: string | null } | undefined
    if (row === undefined) return null
    if (row.archived_at !== null) {
      // Like updateThread's archive toggle, this is metadata, not activity —
      // updated_at is left alone (#164); the write that follows bumps it if it
      // is a message.
      this.db.prepare('UPDATE threads SET archived_at = NULL WHERE id = ?').run(row.id)
      this.emitChange({ entity: 'thread', action: 'updated', threadId: row.id })
    }
    return row.id
  }

  /** Move the parent's sub-agent rows (parent_tool_call_id = toolCallId) into the
   *  child thread, clearing the tag so they read as the child's own transcript. */
  #rehomeSubagentRows(childThreadId: string, parentThreadId: string, toolCallId: string): void {
    withTransaction(this.db, () => {
      this.db
        .prepare(
          'UPDATE messages SET thread_id = ?, parent_tool_call_id = NULL WHERE thread_id = ? AND parent_tool_call_id = ?',
        )
        .run(childThreadId, parentThreadId, toolCallId)
      this.db
        .prepare(
          'UPDATE tool_calls SET thread_id = ?, parent_tool_call_id = NULL WHERE thread_id = ? AND parent_tool_call_id = ?',
        )
        .run(childThreadId, parentThreadId, toolCallId)
    })
    this.emitChange({ entity: 'message', action: 'updated', threadId: childThreadId })
    this.emitChange({ entity: 'tool_call', action: 'updated', threadId: childThreadId })
  }

  /**
   * List threads, newest activity first. Filter by project root if given.
   * Archived threads are EXCLUDED unless `includeArchived` is set — the
   * default list is active threads only.
   */
  listThreads(
    projectRoot?: string,
    options: { includeArchived?: boolean; limit?: number; includeChildren?: boolean } = {},
  ): ThreadRecord[] {
    const conditions: string[] = []
    const params: Array<string | number> = []
    if (projectRoot) {
      conditions.push(`${THREAD_PROJECT_ROOT_COLUMN} = ?`)
      params.push(projectRoot)
    }
    if (!options.includeArchived) {
      conditions.push('archived_at IS NULL')
    }
    // Promoted sub-agent CHILD threads are shown nested under their parent, not
    // loose in the top-level list — exclude them unless asked (#1931).
    if (!options.includeChildren) {
      conditions.push('parent_thread_id IS NULL')
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
    // Newest activity first; an optional LIMIT returns the most-recent N for
    // bounded callers (the palette recents). Omitted/<=0 = the whole list — the
    // sidebar history and count-for-destruction callers need it (pattern #18).
    const limited = options.limit !== undefined && options.limit > 0
    const limitClause = limited ? ' LIMIT ?' : ''
    if (limited) params.push(options.limit as number)
    const rows = this.db
      .prepare(`SELECT * FROM threads ${where} ORDER BY updated_at DESC${limitClause}`)
      .all(...params) as ThreadRow[]
    return rows.map(toThreadRecord)
  }

  /**
   * Mark an existing thread as a run of `loop` — once, and never again.
   *
   * WHY THIS EXISTS AT ALL, given `originLoop` is documented as set at creation:
   * the board's loop works a TASK'S OWN 1:1 thread, and that thread was created
   * with the task, long before anybody pressed play. It has no way to have been
   * born a run. Refusing to mark it would mean a loop-driven conversation drew
   * the ordinary chat glyph and the sidebar could not tell the two apart, which
   * is the exact thing the field exists for.
   *
   * THE INVARIANT THAT MATTERS SURVIVES: never rewritten. A thread becomes a run
   * once and stays one — a run does not stop having been a run when it finishes,
   * and a second loop cannot claim a thread the first one already worked. So the
   * write is conditional in SQL rather than in a caller's `if`, and a thread
   * that is already a run is left exactly as it is.
   */
  markAsLoopRun(threadId: string, loop: string, aim: string | null = null): void {
    this.db
      .prepare(
        `UPDATE threads SET origin_loop = ?, origin_aim = ?
         WHERE id = ? AND origin_loop IS NULL`,
      )
      .run(loop, aim, threadId)
    this.emitChange({ entity: 'thread', action: 'updated', threadId })
  }

  updateThread(id: string, patch: UpdateThreadInput): ThreadRecord {
    const existing = this.getThread(id)
    if (!existing) {
      throw new Error(`[ThreadStore] Cannot update unknown thread: ${id}`)
    }
    const now = new Date().toISOString()
    // `updated_at` is the "last activity" clock the sidebar sorts on. Only real
    // activity (title/model/effort/status) bumps it — metadata-only toggles
    // (pin/archive/autonomous) must NOT, or unpinning an old thread yanks it to
    // the top of the recency list (#164). Mirrors setBrief, which already skips
    // the bump. The pin/archive TIMESTAMPS still use `now` (when it happened).
    const hasActivity =
      patch.title !== undefined ||
      patch.model !== undefined ||
      patch.effort !== undefined ||
      patch.status !== undefined
    const updatedAt = hasActivity ? now : existing.updatedAt
    const archivedAt =
      patch.archived === undefined
        ? existing.archivedAt
        : patch.archived
          ? (existing.archivedAt ?? now)
          : null
    const pinnedAt =
      patch.pinned === undefined
        ? existing.pinnedAt
        : patch.pinned
          ? (existing.pinnedAt ?? now)
          : null
    const updated: ThreadRecord = {
      ...existing,
      title: patch.title ?? existing.title,
      model: patch.model !== undefined ? patch.model : existing.model,
      effort: patch.effort !== undefined ? patch.effort : existing.effort,
      status: patch.status ?? existing.status,
      updatedAt,
      archivedAt,
      pinnedAt,
      bypassPermissions: patch.bypassPermissions ?? existing.bypassPermissions,
    }
    this.db
      .prepare(
        'UPDATE threads SET title = ?, model = ?, effort = ?, status = ?, updated_at = ?, archived_at = ?, pinned_at = ?, bypass_permissions = ? WHERE id = ?',
      )
      .run(
        updated.title,
        updated.model,
        updated.effort,
        updated.status,
        updated.updatedAt,
        updated.archivedAt,
        updated.pinnedAt,
        updated.bypassPermissions ? 1 : 0,
        id,
      )
    this.emitChange({ entity: 'thread', action: 'updated', threadId: id })
    return updated
  }

  /**
   * Reconcile in-flight state left over from a previous run. SDK sessions do
   * NOT survive an app restart, so any thread persisted as 'working' /
   * 'needs-decision' / 'blocked' — and any tool call still 'running' /
   * 'pending' — is stale and would otherwise show a spinner forever. Reset
   * threads to 'idle' and stuck tool calls to 'error'. Runs once at startup.
   *
   * A restart cleanup is NOT activity: it leaves threads.updated_at (the
   * last-activity clock the sidebar sorts on) untouched, so an interrupted
   * thread doesn't jump to the top on every relaunch (#262, mirrors #164).
   */
  reconcileInterruptedWork(): void {
    const now = new Date().toISOString()
    // Captured BEFORE the reset below flips them to idle (#1216).
    const interrupted = this.db
      .prepare(
        `SELECT id FROM threads WHERE status IN ('working', 'needs-decision', 'blocked')`,
      )
      .all() as Array<{ id: string }>
    this.db
      .prepare(
        `UPDATE threads SET status = 'idle'
         WHERE status IN ('working', 'needs-decision', 'blocked')`,
      )
      .run()
    this.db
      .prepare(
        `UPDATE tool_calls
         SET status = 'error', output_json = '{"interrupted":true}', completed_at = ?
         WHERE status IN ('running', 'pending')`,
      )
      .run(now)

    // #1216: leave a TRACE. Quitting mid-turn reset the thread to idle and
    // dropped the in-flight answer, so the thread came back looking like the
    // question was never asked — no system row, no error card, nothing to say
    // the reply is missing or that the work may be half-done. Every other
    // unfinished turn now says so (#981's "Interrupted by you", #1048's
    // persisted failure note); a quit was the one that said nothing.
    //
    // Written only for threads that were genuinely mid-turn, and only when the
    // last row isn't already such a note, so repeated relaunches can't stack
    // duplicates. Like the resets above, this is NOT activity: updated_at stays
    // put so an interrupted thread doesn't jump the sidebar on every relaunch
    // (#262/#164).
    for (const row of interrupted) {
      const last = this.db
        .prepare(
          `SELECT content FROM messages WHERE thread_id = ? AND parent_tool_call_id IS NULL
           ORDER BY created_at DESC, rowid DESC LIMIT 1`,
        )
        .get(row.id) as { content?: string } | undefined
      if (last?.content === QUIT_INTERRUPTION_NOTE) continue
      // Written directly rather than through appendMessage(): that bumps
      // threads.updated_at, and a restart cleanup must not (#262/#164) — an
      // interrupted thread would jump the sidebar on every relaunch.
      this.db
        .prepare(
          'INSERT INTO messages (id, thread_id, role, content, created_at, model) VALUES (?, ?, ?, ?, ?, ?)',
        )
        .run(randomUUID(), row.id, 'system', QUIT_INTERRUPTION_NOTE, now, null)
      this.emitChange({ entity: 'message', action: 'created', threadId: row.id })
    }
  }

  /** Delete a thread and (via FK cascade) its messages and tool calls. */
  deleteThread(id: string): void {
    // READ BEFORE THE DELETE, because after it there is nothing to read. This
    // is the only moment anything can still say which checkout belonged to this
    // conversation; the row goes on the next line and takes the answer with it.
    const doomed = this.getThread(id)
    const abandoned =
      doomed !== null && doomed.worktreePath !== null
        ? {
            projectRoot: doomed.projectRoot,
            worktreePath: doomed.worktreePath,
            branch: doomed.worktreeBranch,
          }
        : undefined
    const result = this.db.prepare('DELETE FROM threads WHERE id = ?').run(id)
    // Null any project's active-thread pointer to the now-deleted thread, so a
    // later switch into that project doesn't select a ghost — which left the
    // review reject guard armed with a stale thread and destroyed uncommitted
    // work (#411). active_thread_id is a soft pointer, not an FK cascade.
    this.db
      .prepare(`UPDATE ${PROJECT_STATE_TABLE} SET active_thread_id = NULL WHERE active_thread_id = ?`)
      .run(id)
    // The conversation's own editor tabs go with it: nothing could ever select
    // it again to restore them.
    new TabSetStore(this.db).deleteThread(id)
    if (result.changes > 0) {
      this.emitChange({
        entity: 'thread',
        action: 'deleted',
        threadId: id,
        ...(abandoned === undefined ? {} : { abandoned }),
      })
    }
  }

  /**
   * Search threads by title or message content (case-insensitive), newest
   * activity first.
   *
   * PERF-4: backed by the FTS5 index from migration v2 (token/prefix
   * matching) instead of an unindexed leading-wildcard LIKE scan. The LIKE
   * path survives only as a fallback for SQLite builds without FTS5 and for
   * queries with no indexable token (e.g. punctuation-only). The response
   * shape is unchanged either way.
   */
  searchThreads(query: string, projectRoot?: string): ThreadRecord[] {
    if (this.hasFtsIndex()) {
      const match = buildFtsMatchExpression(query)
      if (match !== null) {
        // #1364: UNION the FTS hits with a substring scan. FTS5 matches by
        // token PREFIX, and `_` is a token character, so `snake_case` and
        // `camelCase` names are single indivisible tokens — a phrase the user
        // can read verbatim in a thread title ("store migration", "SER_STORE")
        // returned "No threads match". A search box over titles the user is
        // LOOKING AT has to match what they see.
        //
        // FTS still carries the fast path and the message-content recall; the
        // LIKE pass only adds the substring hits it structurally cannot find.
        return this.mergeByRecency(
          this.searchThreadsFts(match, projectRoot),
          this.searchThreadsLike(query, projectRoot),
        )
      }
    }
    return this.searchThreadsLike(query, projectRoot)
  }

  /** Combine two result sets, de-duplicated, newest activity first — the order
   *  both queries already return (#1364). */
  private mergeByRecency(primary: ThreadRecord[], secondary: ThreadRecord[]): ThreadRecord[] {
    if (secondary.length === 0) return primary
    const seen = new Set(primary.map((thread) => thread.id))
    const merged = [...primary]
    for (const thread of secondary) {
      if (seen.has(thread.id)) continue
      seen.add(thread.id)
      merged.push(thread)
    }
    return merged.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }

  /** FTS availability, detected once — the v2 migration is a no-op (no FTS
   *  tables) when the bundled SQLite lacks FTS5. */
  private hasFtsIndex(): boolean {
    if (this.ftsAvailable === null) {
      const row = this.db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'messages_fts'")
        .get()
      this.ftsAvailable = row !== undefined
    }
    return this.ftsAvailable
  }

  private searchThreadsFts(match: string, projectRoot?: string): ThreadRecord[] {
    const rootClause = projectRoot ? `AND t.${THREAD_PROJECT_ROOT_COLUMN} = ?` : ''
    const params: string[] = projectRoot ? [match, match, projectRoot] : [match, match]
    const rows = this.db
      .prepare(
        `SELECT t.* FROM threads t
         WHERE (
           t.rowid IN (SELECT rowid FROM threads_fts WHERE threads_fts MATCH ?)
           OR t.id IN (
             SELECT m.thread_id FROM messages m
             WHERE m.parent_tool_call_id IS NULL
               AND m.rowid IN (SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?)
           )
         ) ${rootClause}
         ORDER BY t.updated_at DESC`,
      )
      .all(...params) as ThreadRow[]
    return rows.map(toThreadRecord)
  }

  /** Case-insensitive substring scan. Pre-v2 this was the whole search; since
   *  #1364 it also unions into the FTS path, which cannot match inside a
   *  token however plainly the user can read it. */
  private searchThreadsLike(query: string, projectRoot?: string): ThreadRecord[] {
    const pattern = `%${escapeLikePattern(query)}%`
    const rootClause = projectRoot ? `AND t.${THREAD_PROJECT_ROOT_COLUMN} = ?` : ''
    const params: string[] = projectRoot
      ? [pattern, pattern, projectRoot]
      : [pattern, pattern]
    const rows = this.db
      .prepare(
        `SELECT DISTINCT t.* FROM threads t
         LEFT JOIN messages m ON m.thread_id = t.id
         WHERE (t.title LIKE ? ESCAPE '\\'
                OR (m.content LIKE ? ESCAPE '\\' AND m.parent_tool_call_id IS NULL)) ${rootClause}
         ORDER BY t.updated_at DESC`,
      )
      .all(...params) as ThreadRow[]
    return rows.map(toThreadRecord)
  }

  // ── SDK session mapping ────────────────────────────────────────────────

  /** Persist the SDK session ID for a thread so sessions can be resumed. */
  setSdkSessionId(threadId: string, sdkSessionId: string | null): void {
    const result = this.db
      .prepare('UPDATE threads SET sdk_session_id = ?, updated_at = ? WHERE id = ?')
      .run(sdkSessionId, new Date().toISOString(), threadId)
    if (result.changes === 0) {
      throw new Error(`[ThreadStore] Cannot map session for unknown thread: ${threadId}`)
    }
    this.emitChange({ entity: 'thread', action: 'updated', threadId })
  }

  // ── Worktree (the checkout a thread owns) ──────────────────────────────

  /**
   * Record the worktree a thread owns. `path` must be the path the
   * `planflow-ai worktree` CLI RETURNED, never one recomputed here — see
   * ThreadRecord.worktreePath.
   *
   * Deliberately its own writer rather than a field on UpdateThreadInput: this
   * is bookkeeping about where the thread lives, not activity in it, so it must
   * not bump `updated_at` and yank the thread to the top of the sidebar's
   * recency list (#164). Passing `null` for the whole worktree clears all three
   * — what pruning leaves behind.
   *
   * CLEARING ALSO CLEARS THE BINDING. A binding describes where THIS checkout's
   * branch publishes; once the checkout is gone the local branch it was keyed on
   * is gone with it, and a mirror left behind would have the next surface report
   * a remote target for work that no longer has anywhere to be pushed from. It
   * removes nothing on the remote — the branch that was pushed is still there,
   * and deleting a remote ref is nobody's side effect (forbidden-pattern #15).
   *
   * `baseMayBeBehind` TRAVELS WITH THE CUT, because the cut is what answers it:
   * only the caller that just created a checkout knows whether the base it
   * started from was refreshed first. It is OPTIONAL and, when omitted, leaves
   * the stored answer alone — the callers that merely rename a branch or
   * retarget a record are not making a new cut and must not silently clear a
   * warning that is still true. The single writer of checkout state stays the
   * single writer; clearing the worktree clears this with it.
   */
  setThreadWorktree(
    threadId: string,
    worktree: {
      path: string
      branch: string | null
      base: string | null
      baseMayBeBehind?: boolean
    } | null,
  ): void {
    const answersFreshness = worktree !== null && worktree.baseMayBeBehind !== undefined
    const result =
      worktree === null
        ? this.db
            .prepare(
              `UPDATE threads
                 SET worktree_path = NULL, worktree_branch = NULL, worktree_base = NULL,
                     remote = NULL, remote_branch = NULL, pr_base = NULL,
                     previously_pushed_as = NULL, base_may_be_behind = NULL
               WHERE id = ?`,
            )
            .run(threadId)
        : this.db
            .prepare(
              `UPDATE threads
                 SET worktree_path = ?, worktree_branch = ?, worktree_base = ?
                     ${answersFreshness ? ', base_may_be_behind = ?' : ''}
               WHERE id = ?`,
            )
            .run(
              ...(answersFreshness
                ? [
                    worktree.path,
                    worktree.branch,
                    worktree.base,
                    worktree.baseMayBeBehind === true ? 1 : 0,
                    threadId,
                  ]
                : [worktree.path, worktree.branch, worktree.base, threadId]),
            )
    if (result.changes === 0) {
      throw new Error(`[ThreadStore] Cannot set worktree for unknown thread: ${threadId}`)
    }
    this.emitChange({ entity: 'thread', action: 'updated', threadId })
  }

  /**
   * Mirror the remote binding a thread was given — THE ONLY WRITER of these
   * four columns (allowed-pattern #14).
   *
   * IT MIRRORS, IT DOES NOT DECIDE. Every value here came from a person's
   * answer, written first to git's own upstream config by the CLI verb that
   * owns that write, or read back from that config when the two had drifted.
   * Nothing in this method may invent a remote, a branch or a base: the whole
   * point of the feature is that an unbound thread is asked rather than guessed
   * at, and a store that helpfully filled in a default would put the guess back
   * one layer down where nobody sees it.
   *
   * Like `setThreadWorktree`, this is bookkeeping and not activity: it must not
   * bump `updated_at` and reorder the sidebar. `null` unbinds — the thread goes
   * back to having no remote target, which is refused at push, not defaulted.
   *
   * `previouslyPushedAs` omitted LEAVES the stored value alone, so editing a PR
   * base cannot erase the record of a rename; pass `null` explicitly to clear it.
   */
  setThreadBinding(threadId: string, binding: ThreadBinding | null): void {
    const keepsPreviously = binding !== null && binding.previouslyPushedAs === undefined
    const result = this.db
      .prepare(
        `UPDATE threads
           SET remote = ?, remote_branch = ?, pr_base = ?,
               previously_pushed_as = ${keepsPreviously ? 'previously_pushed_as' : '?'}
         WHERE id = ?`,
      )
      .run(
        ...(keepsPreviously
          ? [binding.remote, binding.remoteBranch, binding.prBase, threadId]
          : [
              binding?.remote ?? null,
              binding?.remoteBranch ?? null,
              binding?.prBase ?? null,
              binding?.previouslyPushedAs ?? null,
              threadId,
            ]),
      )
    if (result.changes === 0) {
      throw new Error(`[ThreadStore] Cannot set binding for unknown thread: ${threadId}`)
    }
    this.emitChange({ entity: 'thread', action: 'updated', threadId })
  }

  /**
   * Record the autopilot chain driving a thread — THE ONLY WRITER of these two
   * columns (allowed-pattern #14).
   *
   * IT RECORDS, IT DOES NOT DECIDE. The driver has already chosen what to issue
   * from observable state; this is where that choice becomes a fact somebody
   * can look up, so "which step is this conversation on" never has to be
   * inferred from what the model wrote about itself.
   *
   * `null` ENDS THE RECORD — a chain that finished, stopped itself, or was
   * ended by a person. It does not touch the conversation, its work or its
   * branch; ending a chain stops the next step, nothing else.
   *
   * Bookkeeping, not activity: like `setThreadBinding` it leaves `updated_at`
   * alone so the sidebar does not reorder itself every time a step is issued.
   * A thread deleted out from under a running chain throws, which is what the
   * driver's caller catches — an unknown id is a programming error everywhere
   * else this store is written.
   */
  setThreadChain(threadId: string, chain: ThreadChain | null): void {
    const result = this.db
      .prepare('UPDATE threads SET chain_id = ?, chain_stage = ? WHERE id = ?')
      .run(chain?.chainId ?? null, chain?.stage ?? null, threadId)
    if (result.changes === 0) {
      throw new Error(`[ThreadStore] Cannot set the chain for unknown thread: ${threadId}`)
    }
    this.emitChange({ entity: 'thread', action: 'updated', threadId })
  }

  /**
   * Every thread that currently owns a checkout, paired with the project root
   * it was cut from. This is the address gate's widening source (see
   * project/addressable-roots.ts): a worktree is never a registered project
   * root, so without this the editor, the file tree and the git write channels
   * refuse every path inside a thread's own worktree.
   *
   * Rows with a null `worktree_path` are excluded in SQL rather than filtered
   * after the fact — "this thread has no checkout" must never reach a caller
   * that would read it as a root to trust.
   */
  /**
   * Every checkout, with what it would need to be RENAMED — the upgrade's whole
   * input.
   *
   * ONE READ, BOTH TABLES, because a conversation's checkouts are spread across
   * them and a migration that saw half would leave a thread pointing at one
   * renamed directory and one that moved without its record.
   *
   * The title travels because the new name comes from it: a checkout named
   * after a thread id has no name of its own to keep.
   */
  listCheckoutsForRename(): Array<{
    threadId: string
    title: string | null
    rootPath: string
    worktreePath: string
    kind: 'primary' | 'attached'
  }> {
    const rows = this.db
      .prepare(
        `SELECT id AS thread_id, title, ${THREAD_PROJECT_ROOT_COLUMN} AS root_path, worktree_path,
                'primary' AS kind
           FROM threads WHERE worktree_path IS NOT NULL AND worktree_path != ''
         UNION ALL
         SELECT r.thread_id AS thread_id, t.title AS title, r.root_path AS root_path,
                r.worktree_path, 'attached' AS kind
           FROM thread_roots r JOIN threads t ON t.id = r.thread_id
          WHERE r.worktree_path IS NOT NULL AND r.worktree_path != ''`,
      )
      .all() as Array<{
      thread_id: string
      title: string | null
      root_path: string
      worktree_path: string
      kind: 'primary' | 'attached'
    }>
    return rows.map((row) => ({
      threadId: row.thread_id,
      title: row.title,
      rootPath: row.root_path,
      worktreePath: row.worktree_path,
      kind: row.kind,
    }))
  }

  /**
   * Point a checkout's record at where it now lives — the second half of a
   * rename, and the half whose absence would leave the app looking for a
   * directory that moved.
   *
   * EVERY TABLE THAT HOLDS THE PATH, THROUGH ONE VERB, because a caller that had
   * to remember which ones a given checkout lives in would eventually forget.
   *
   * IT DID FORGET ONE. This rewrote `threads` and `thread_roots` — the records
   * the rename was ABOUT — and left `workspace_state`, which stores a project's
   * open editor tabs as `{ rootPath, relPath }` pairs addressing the checkout by
   * path, plus the unsaved contents of those tabs keyed by absolute path. So the
   * migration moved 21 directories, repointed every thread, and left the tabs
   * pointing at folders that no longer existed: every activation of that project
   * rehydrated them and threw `Unknown root` once per tab, forever (user,
   * 2026-09-18). Forbidden-pattern #17 — grep for the leftovers after a rewrite.
   */
  repointCheckout(worktreePath: string, nextPath: string): void {
    this.db
      .prepare('UPDATE threads SET worktree_path = ? WHERE worktree_path = ?')
      .run(nextPath, worktreePath)
    this.db
      .prepare('UPDATE thread_roots SET worktree_path = ? WHERE worktree_path = ?')
      .run(nextPath, worktreePath)
    this.#repointOpenTabs(worktreePath, nextPath)
  }

  /**
   * Move a project's persisted tabs onto a checkout's new path.
   *
   * PARSED, NOT STRING-REPLACED. These are JSON columns and the path appears in
   * them as a value; a textual swap would also hit a file whose NAME happens to
   * contain the old path, and would corrupt the row rather than fail loudly.
   *
   * A row nobody has to change is left completely alone — including its
   * `last_active_at`, which decides which project boots (#1080).
   */
  #repointOpenTabs(worktreePath: string, nextPath: string): void {
    const rows = this.db
      .prepare(`SELECT project_root, open_files, dirty_buffers FROM ${PROJECT_STATE_TABLE}`)
      .all() as Array<{ project_root: string; open_files: string; dirty_buffers: string }>
    const update = this.db.prepare(
      `UPDATE ${PROJECT_STATE_TABLE} SET open_files = ?, dirty_buffers = ? WHERE project_root = ?`,
    )
    for (const row of rows) {
      const moved = repointedTabs(row.open_files, row.dirty_buffers, worktreePath, nextPath)
      if (moved === null) continue
      update.run(moved.openFiles, moved.dirtyBuffers, row.project_root)
    }
    // …and every conversation's own tab set, which addresses checkouts the
    // same way (thread_tab_state, v34).
    new TabSetStore(this.db).repoint(worktreePath, nextPath)
  }

  listThreadWorktrees(): Array<{ worktreePath: string; projectRoot: string }> {
    // BOTH TABLES, BECAUSE A THREAD OWNS MORE THAN ONE CHECKOUT.
    //
    // This read `threads` alone — the checkout of the project a conversation
    // STARTED in — and every attached project's checkout lives in
    // `thread_roots`. Its one consumer is the address gate, so a checkout this
    // query did not return was a path the renderer could not list: the explorer
    // answered "Project folder not found" over a directory the app had just
    // created, naming the thread id it could not resolve (user, 2026-09-17,
    // after pressing "Give it a copy too" on an attached project).
    //
    // The gate is one predicate over one list (allowed-pattern #14); the bug
    // was that the list only knew half of what it was gating.
    const rows = this.db
      .prepare(
        `SELECT worktree_path, ${THREAD_PROJECT_ROOT_COLUMN} AS project_root FROM threads WHERE worktree_path IS NOT NULL
         UNION ALL
         SELECT worktree_path, root_path AS project_root FROM thread_roots
           WHERE worktree_path IS NOT NULL AND worktree_path != ''`,
      )
      .all() as Array<{ worktree_path: string; project_root: string }>
    return rows.map((row) => ({
      worktreePath: row.worktree_path,
      projectRoot: row.project_root,
    }))
  }

  /**
   * The ids of every thread whose worktree is `worktreePath` (#1906) — the
   * reverse of `getThread(id)?.worktreePath`, used to fan a `git:changed`
   * broadcast out to the change-review card(s) watching that worktree. Normally
   * a single id (one thread owns a worktree), but the query is a list so a
   * shared/reused worktree can't silently drop a watcher.
   */
  threadIdsForWorktree(worktreePath: string): string[] {
    const rows = this.db
      .prepare('SELECT id FROM threads WHERE worktree_path = ?')
      .all(worktreePath) as Array<{ id: string }>
    return rows.map((row) => row.id)
  }

  /**
   * Every thread whose CHANGE REVIEW reads this repository — the ones that own
   * it as their checkout, plus the ones that simply work in it because they
   * never got a checkout of their own.
   *
   * The review's fan-out asked `threadIdsForWorktree` alone, which was the whole
   * story while every thread got a copy. After the worktree gate made copies
   * loops-only it stopped being: a commit in a project fired `git:changed`, the
   * fan-out matched no thread, and the open Changes tab kept listing files that
   * were no longer uncommitted — it still said "Uncommitted" over work that had
   * just been committed.
   */
  threadIdsReviewing(rootPath: string): string[] {
    const rows = this.db
      .prepare(
        `SELECT id FROM threads WHERE worktree_path = ? OR (${THREAD_PROJECT_ROOT_COLUMN} = ? AND (worktree_path IS NULL OR worktree_path = ''))`,
      )
      .all(rootPath, rootPath) as Array<{ id: string }>
    return rows.map((row) => row.id)
  }

  getThreadBySdkSessionId(sdkSessionId: string): ThreadRecord | null {
    const row = this.db
      .prepare('SELECT * FROM threads WHERE sdk_session_id = ?')
      .get(sdkSessionId) as ThreadRow | undefined
    return row ? toThreadRecord(row) : null
  }

  // ── Messages ───────────────────────────────────────────────────────────

  appendMessage(
    threadId: string,
    role: MessageRole,
    content: string,
    model: string | null = null,
    parentToolCallId: string | null = null,
    // The transcript-backfill writer's timestamp (#1931): a materialized row
    // keeps its SDK session-storage time so the child reads in original order.
    // Omitted everywhere else — live writes stamp now (allowed-pattern #23).
    createdAt?: string,
  ): MessageRecord {
    // A sub-agent row whose spawn was PROMOTED to a child thread is homed into
    // the child directly (#1931) — written there untagged, exactly as the
    // promotion re-home would have left it, so the child's chat live-updates
    // while the origin session keeps streaming.
    const promotedChild =
      parentToolCallId === null ? null : this.#promotedChildId(threadId, parentToolCallId)
    const homeThreadId = promotedChild ?? threadId
    const homeParentToolCallId = promotedChild === null ? parentToolCallId : null
    const now = new Date().toISOString()
    const message: MessageRecord = {
      id: randomUUID(),
      threadId: homeThreadId,
      role,
      content,
      createdAt: createdAt ?? now,
      model,
      parentToolCallId: homeParentToolCallId,
    }
    withTransaction(this.db, () => {
      this.db
        .prepare(
          'INSERT INTO messages (id, thread_id, role, content, created_at, model, parent_tool_call_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
        )
        .run(
          message.id,
          message.threadId,
          message.role,
          message.content,
          message.createdAt,
          message.model,
          message.parentToolCallId ?? null,
        )
      this.db.prepare('UPDATE threads SET updated_at = ? WHERE id = ?').run(now, homeThreadId)
    })
    this.emitChange({ entity: 'message', action: 'created', threadId: homeThreadId })
    return message
  }

  /**
   * The thread whose agent most recently WROTE `relPath` under `rootPath`, or
   * null (#1717). The artifact-marker sink attributes a doc's card to its
   * writer first and the active thread only as a fallback: during a long run
   * the user is often reading ANOTHER thread when the agent writes the doc,
   * so active-thread attribution dropped the marker (or parked it on an
   * unrelated thread) and the card vanished on the next reload (#1056's
   * suppression working as designed on a marker that was never written).
   * LIKE on the path suffix matches both absolute and relative tool inputs;
   * the thread must belong to the root so a same-named doc in another
   * project can never claim it.
   *
   * "Belong" means ANY of the thread's projects — its primary root or one
   * attached to it (thread_roots). A conversation started in one project
   * routinely writes its discovery into a sibling it attached (live
   * 2026-10-09: a orbit-argo-applications thread wrote
   * orbit-app/flow/discovery/…); scoping to the primary root alone left that
   * doc with no writer, no marker, and no card.
   *
   * THE TWO BRANCHES MATCH DIFFERENT THINGS, ON PURPOSE. Flow docs share names
   * across projects (`flow/discovery/discovery_x_v1.md` can exist in both), so
   * the relative suffix only identifies a file in the project the agent RUNS
   * in. For an attached project it would credit the thread with a write to
   * the same-named doc in its PRIMARY project — claiming a hand-written doc
   * next door. So:
   *   - primary root  → the relative suffix (absolute and relative inputs)
   *   - attached root → only the absolute forms in `absoluteForms`: the path
   *     through the project (`<root>/<relPath>`) and its realpath, because
   *     `flow/` is a link and an agent may have written either. The caller
   *     resolves the realpath (the store does no filesystem reads); with none
   *     given, `<root>/<relPath>` alone is used.
   */
  latestWriterThreadFor(
    rootPath: string,
    relPath: string,
    absoluteForms: readonly string[] = [],
  ): string | null {
    const forms = [...new Set([join(rootPath, relPath), ...absoluteForms])]
    const attachedMatch = forms.map(() => 'tc.input_json LIKE ?').join(' OR ')
    const row = this.db
      .prepare(
        `SELECT tc.thread_id AS threadId FROM tool_calls tc
         JOIN threads t ON t.id = tc.thread_id
         WHERE tc.tool_name IN ('Write', 'Edit', 'MultiEdit', 'NotebookEdit')
           AND tc.parent_tool_call_id IS NULL
           AND ((t.${THREAD_PROJECT_ROOT_COLUMN} = ? AND tc.input_json LIKE ?)
                OR (EXISTS (SELECT 1 FROM thread_roots r WHERE r.thread_id = t.id AND r.root_path = ?)
                    AND (${attachedMatch})))
         ORDER BY tc.started_at DESC LIMIT 1`,
      )
      .get(rootPath, `%${relPath}%`, rootPath, ...forms.map((form) => `%${form}%`)) as
      | { threadId: string }
      | undefined
    return row?.threadId ?? null
  }

  /** True when the thread already carries a `system` row with exactly this
   *  content — the once-per-(thread, docPath) guard for artifact markers
   *  (#1056, shared/artifact-marker.ts). */
  hasSystemMessage(threadId: string, content: string): boolean {
    const row = this.db
      .prepare(
        "SELECT 1 FROM messages WHERE thread_id = ? AND parent_tool_call_id IS NULL AND role = 'system' AND content = ? LIMIT 1",
      )
      .get(threadId, content)
    return row !== undefined
  }

  /** `createdAt` of a thread's USER messages, oldest first — the turn
   *  boundaries for the brainSavings thread recompute (see
   *  brain-savings.ts splitByTurnBoundaries). PERF: skips message content. */
  listUserMessageTimes(threadId: string): string[] {
    const rows = this.db
      .prepare(
        "SELECT created_at FROM messages WHERE thread_id = ? AND parent_tool_call_id IS NULL AND role = 'user' ORDER BY created_at ASC, id ASC",
      )
      .all(threadId) as Array<{ created_at: string }>
    return rows.map((row) => row.created_at)
  }

  /**
   * A thread's messages, oldest first.
   *
   * `limit` takes the NEWEST n and returns them still in order — the shape a
   * transcript view wants, because it mounts a window at the bottom. Measured
   * on a real profile: one thread's 1,260 messages are 2.74 MB, and the pane
   * mounts 200 of them (forbidden-pattern #13 — shipping a collection because
   * the view renders part of it). Omit `limit` for everything: exporters, the
   * "show earlier" fetch, and every caller that really does want the lot.
   */
  listMessages(threadId: string, options: { limit?: number } = {}): MessageRecord[] {
    const limit = options.limit
    // TIE-BREAK ON rowid, NOT id. Timestamps are millisecond-resolution and a
    // burst of messages shares one, so the tie-break decides the order — and
    // `id` is a random string, i.e. an arbitrary order that the bounded read
    // (which walks from the other end) would not agree with. rowid IS the
    // insertion order, so both directions describe the same transcript.
    if (limit === undefined || limit <= 0) {
      const rows = this.db
        .prepare(
          'SELECT * FROM messages WHERE thread_id = ? AND parent_tool_call_id IS NULL ORDER BY created_at ASC, rowid ASC',
        )
        .all(threadId) as MessageRow[]
      return rows.map(toMessageRecord)
    }
    const rows = this.db
      .prepare(
        'SELECT * FROM messages WHERE thread_id = ? AND parent_tool_call_id IS NULL ORDER BY created_at DESC, rowid DESC LIMIT ?',
      )
      .all(threadId, limit) as MessageRow[]
    return rows.reverse().map(toMessageRecord)
  }

  /**
   * Mark one assistant message as the one that ended its turn.
   *
   * The feed shows a request's answer from this mark (plan_chat-cleanup FR-7/8):
   * the last turn-ending assistant message of the request. The one caller is
   * StreamBridge.handleResult, on every turn end — success, interrupt, failure.
   *
   * Returns true only when a row changed. An unknown id, a user or system row,
   * or a row already marked changes nothing and returns false.
   */
  markTurnEnd(messageId: string): boolean {
    const row = this.db
      .prepare("SELECT thread_id FROM messages WHERE id = ? AND role = 'assistant' AND ends_turn = 0")
      .get(messageId) as { thread_id: string } | undefined
    if (row === undefined) return false
    const result = this.db
      .prepare('UPDATE messages SET ends_turn = 1 WHERE id = ?')
      .run(messageId)
    if (result.changes === 0) return false
    this.emitChange({ entity: 'message', action: 'updated', threadId: row.thread_id })
    return true
  }

  /** A sub-agent's messages (oldest first), keyed by the parent Task tool-call
   *  id — the sub-chat transcript half (#1931). */
  listSubagentMessages(threadId: string, parentToolCallId: string): MessageRecord[] {
    const rows = this.db
      .prepare(
        'SELECT * FROM messages WHERE thread_id = ? AND parent_tool_call_id = ? ORDER BY created_at ASC, rowid ASC',
      )
      .all(threadId, parentToolCallId) as MessageRow[]
    return rows.map(toMessageRecord)
  }

  /** How many messages a thread has — what a bounded read cannot say. */
  countMessages(threadId: string): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS n FROM messages WHERE thread_id = ? AND parent_tool_call_id IS NULL')
      .get(threadId) as { n: number } | undefined
    return row?.n ?? 0
  }

  // ── Tool calls ─────────────────────────────────────────────────────────

  recordToolCall(input: {
    threadId: string
    messageId?: string
    toolName: string
    inputJson?: string
    /** Parent Task tool-call id when this call belongs to a sub-agent (#1931). */
    parentToolCallId?: string | null
    /** Transcript-backfill timestamp (#1931) — a materialized row keeps its SDK
     *  session-storage time. Omitted everywhere else; live writes stamp now. */
    startedAt?: string
  }): ToolCallRecord {
    // Promoted sub-agent? Home the row into the child thread directly — the
    // mirror of appendMessage's redirect (#1931), same mediating lookup.
    const parentToolCallId = input.parentToolCallId ?? null
    const promotedChild =
      parentToolCallId === null ? null : this.#promotedChildId(input.threadId, parentToolCallId)
    const toolCall: ToolCallRecord = {
      id: randomUUID(),
      threadId: promotedChild ?? input.threadId,
      messageId: input.messageId ?? null,
      toolName: input.toolName,
      inputJson: input.inputJson ?? null,
      outputJson: null,
      status: 'pending',
      startedAt: input.startedAt ?? new Date().toISOString(),
      completedAt: null,
      parentToolCallId: promotedChild === null ? parentToolCallId : null,
    }
    this.db
      .prepare(
        `INSERT INTO tool_calls (id, thread_id, message_id, tool_name, input_json, output_json, status, started_at, completed_at, parent_tool_call_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        toolCall.id,
        toolCall.threadId,
        toolCall.messageId,
        toolCall.toolName,
        toolCall.inputJson,
        toolCall.outputJson,
        toolCall.status,
        toolCall.startedAt,
        toolCall.completedAt,
        toolCall.parentToolCallId ?? null,
      )
    this.emitChange({ entity: 'tool_call', action: 'created', threadId: toolCall.threadId })
    return toolCall
  }

  updateToolCall(
    id: string,
    patch: { status?: ToolCallStatus; outputJson?: string | null; completedAt?: string | null },
  ): void {
    const row = this.db.prepare('SELECT * FROM tool_calls WHERE id = ?').get(id) as
      | ToolCallRow
      | undefined
    if (!row) {
      throw new Error(`[ThreadStore] Cannot update unknown tool call: ${id}`)
    }
    this.db
      .prepare('UPDATE tool_calls SET status = ?, output_json = ?, completed_at = ? WHERE id = ?')
      .run(
        patch.status ?? row.status,
        patch.outputJson !== undefined ? patch.outputJson : row.output_json,
        patch.completedAt !== undefined ? patch.completedAt : row.completed_at,
        id,
      )
    this.emitChange({ entity: 'tool_call', action: 'updated', threadId: row.thread_id })
  }

  /**
   * Record which sub-agent a SPAWN tool call started (#1931 transcript backfill).
   *
   * Write-once in SQL (`agent_id IS NULL`), because the runtime repeats the id
   * on every `task_progress` and an identity does not change — and no event is
   * emitted: nothing a renderer draws reads this column, and a broadcast per
   * progress tick would be churn for no surface (allowed-pattern #17). An
   * unknown id is a no-op, not an error — the spawn may have been recorded by a
   * previous process this session resumed from.
   */
  setToolCallAgentId(id: string, agentId: string): void {
    this.db
      .prepare('UPDATE tool_calls SET agent_id = ? WHERE id = ? AND agent_id IS NULL')
      .run(agentId, id)
  }

  /**
   * A thread's tool calls, oldest first.
   *
   * `outputLimit` keeps the newest N outputs and leaves the rest NULL with
   * `outputWithheld` set — the same answer the IPC layer used to build by
   * reading everything and throwing most of it away. MEASURED on a 600-call
   * session (20% writes, 8 KB outputs): the read materialized 6.51 MB in the
   * main process to hand back 815 KB, and it runs on every thread open and
   * every turn's history reconcile. Bounding it in SQL: 1.68 MB, because the
   * blobs are never loaded at all.
   *
   * WITHHELD IS NOT EMPTY (pattern #18). The flag is set only where a row
   * actually had an output, which SQLite answers from the record header
   * without reading the value.
   *
   * No limit — the default — still returns everything: exporters, the import
   * path and the transcript builder all need the lot, and a bound they cannot
   * turn off would silently truncate what they write.
   */
  listToolCalls(
    threadId: string,
    options: { outputLimit?: number; since?: string; atLeast?: number } = {},
  ): ToolCallRecord[] {
    const limit = options.outputLimit
    // THE WINDOW, AND A FLOOR UNDER IT.
    //
    // `since` is the span the caller will actually show — the timestamp of the
    // oldest message its feed mounted. Calls older than that belong to turns
    // nobody is looking at, and shipping them measured 1.19 MB of metadata on
    // an 1,800-call thread, on every open and every turn's reconcile.
    //
    // `atLeast` is the floor that keeps that honest when the two streams are
    // out of step: an agent-heavy turn runs hundreds of calls between two
    // messages, so the oldest mounted MESSAGE can be newer than every call
    // worth showing — and without a floor those cards would simply vanish from
    // the feed. The read is the union: everything inside the span, plus the
    // newest `atLeast` whatever their timestamps say.
    //
    // Both are resolved in SQL. Filtering in JS would bound what crosses IPC
    // while main still built every row it was about to drop.
    const since = options.since
    const atLeast = options.atLeast
    const bindings: Record<string, string | number> = { threadId }
    let windowClause = ''
    if (since !== undefined) {
      bindings['since'] = since
      windowClause = ' AND started_at >= @since'
      if (atLeast !== undefined && atLeast > 0) {
        bindings['atLeast'] = atLeast
        windowClause =
          ` AND (started_at >= @since OR id IN (
              SELECT id FROM tool_calls WHERE thread_id = @threadId AND parent_tool_call_id IS NULL
              ORDER BY started_at DESC, id DESC LIMIT @atLeast
            ))`
      }
    }

    if (limit === undefined || limit <= 0) {
      const rows = this.db
        .prepare(
          `SELECT * FROM tool_calls WHERE thread_id = @threadId AND parent_tool_call_id IS NULL${windowClause}
           ORDER BY started_at ASC, id ASC`,
        )
        .all(bindings) as ToolCallRow[]
      return rows.map(toToolCallRecord)
    }
    // TWO CHEAP READS, NOT ONE CLEVER ONE. A window function over the whole
    // thread sorts every row to find the newest N — measured at 3.02ms against
    // 1.65ms for the unbounded read, which is a smaller payload bought with
    // more CPU on the process everything waits behind. Instead: the rows
    // WITHOUT their blobs (SQLite answers `IS NOT NULL` from the record header,
    // so nothing large is loaded), then the newest N outputs through the
    // (thread_id, started_at) index.
    const rows = this.db
      .prepare(
        `SELECT id, thread_id, message_id, tool_name, input_json, status, started_at, completed_at, parent_tool_call_id, agent_id,
                output_json IS NOT NULL AS has_output
         FROM tool_calls WHERE thread_id = @threadId AND parent_tool_call_id IS NULL${windowClause}
         ORDER BY started_at ASC, id ASC`,
      )
      .all(bindings) as Array<Omit<ToolCallRow, 'output_json'> & { has_output: number }>
    const newest = this.db
      .prepare(
        `SELECT id, output_json FROM tool_calls WHERE thread_id = @threadId AND parent_tool_call_id IS NULL${windowClause}
         ORDER BY started_at DESC, id DESC LIMIT @limit`,
      )
      .all({ ...bindings, limit }) as Array<{ id: string; output_json: string | null }>
    const outputs = new Map(newest.map((row) => [row.id, row.output_json]))
    return rows.map((row) => {
      const output = outputs.get(row.id)
      const record = toToolCallRecord({ ...row, output_json: output ?? null })
      // Withheld only where something was actually taken away: a call that
      // never produced an output must read exactly as it always did.
      return output === undefined && row.has_output === 1
        ? { ...record, outputWithheld: true }
        : record
    })
  }

  /** Point-read one tool call. PERF: the stream bridge finalizes every tool
   *  call — a list-and-find there materialized the whole thread's output
   *  blobs per completion. */
  getToolCall(threadId: string, id: string): ToolCallRecord | null {
    const row = this.db
      .prepare('SELECT * FROM tool_calls WHERE thread_id = ? AND id = ? LIMIT 1')
      .get(threadId, id) as ToolCallRow | undefined
    return row ? toToolCallRecord(row) : null
  }

  /** Point-read one tool call WHEREVER it lives (#1931). A sub-agent's row can
   *  be re-homed into a promoted child thread mid-run, so the bridge's
   *  sub-agent completion path cannot key by the parent's thread id — this is
   *  that path's read, not a general replacement for `getToolCall`. */
  getToolCallById(id: string): ToolCallRecord | null {
    const row = this.db.prepare('SELECT * FROM tool_calls WHERE id = ? LIMIT 1').get(id) as
      | ToolCallRow
      | undefined
    return row ? toToolCallRecord(row) : null
  }

  /**
   * A sub-agent's tool calls (oldest first), keyed by the parent Task tool-call
   *  id — the sub-chat transcript half (#1931). `outputLimit` withholds older
   *  outputs exactly like `listToolCalls` (fetched on demand via toolCalls:get).
   */
  listSubagentToolCalls(
    threadId: string,
    parentToolCallId: string,
    options: { outputLimit?: number } = {},
  ): ToolCallRecord[] {
    const limit = options.outputLimit
    if (limit === undefined || limit <= 0) {
      const rows = this.db
        .prepare(
          'SELECT * FROM tool_calls WHERE thread_id = ? AND parent_tool_call_id = ? ORDER BY started_at ASC, id ASC',
        )
        .all(threadId, parentToolCallId) as ToolCallRow[]
      return rows.map(toToolCallRecord)
    }
    const rows = this.db
      .prepare(
        `SELECT id, thread_id, message_id, tool_name, input_json, status, started_at, completed_at, parent_tool_call_id, agent_id,
                output_json IS NOT NULL AS has_output
         FROM tool_calls WHERE thread_id = ? AND parent_tool_call_id = ? ORDER BY started_at ASC, id ASC`,
      )
      .all(threadId, parentToolCallId) as Array<
      Omit<ToolCallRow, 'output_json'> & { has_output: number }
    >
    const newest = this.db
      .prepare(
        `SELECT id, output_json FROM tool_calls WHERE thread_id = ? AND parent_tool_call_id = ?
         ORDER BY started_at DESC, id DESC LIMIT ?`,
      )
      .all(threadId, parentToolCallId, limit) as Array<{ id: string; output_json: string | null }>
    const outputs = new Map(newest.map((row) => [row.id, row.output_json]))
    return rows.map((row) => {
      const output = outputs.get(row.id)
      const record = toToolCallRecord({ ...row, output_json: output ?? null })
      return output === undefined && row.has_output === 1
        ? { ...record, outputWithheld: true }
        : record
    })
  }

  /** Number of persisted tool calls for a thread (cheap COUNT(*)) — the
   *  brainSavings IPC's cache-freshness probe. */
  countToolCalls(threadId: string): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS count FROM tool_calls WHERE thread_id = ? AND parent_tool_call_id IS NULL')
      .get(threadId) as { count: number }
    return row.count
  }

  /**
   * Tool calls from `fromIndex` onward, in the same (started_at, id) order as
   * listToolCalls, with the analyzer projection. PERF: the per-turn analyzers
   * keep a cursor — the OFFSET runs in SQL (backed by
   * idx_tool_calls_thread_started) instead of materializing every prior
   * turn's rows to slice them in JS.
   */
  listToolCallsSlim(threadId: string, fromIndex = 0): ToolCallSlimRecord[] {
    const rows = this.db
      .prepare(
        `SELECT id, tool_name, input_json, output_json, status, started_at, completed_at
         FROM tool_calls WHERE thread_id = ? AND parent_tool_call_id IS NULL ORDER BY started_at ASC, id ASC LIMIT -1 OFFSET ?`,
      )
      .all(threadId, fromIndex) as Array<Omit<ToolCallRow, 'thread_id' | 'message_id'>>
    return rows.map((row) => ({
      id: row.id,
      toolName: row.tool_name,
      inputJson: row.input_json,
      outputJson: row.output_json,
      status: row.status as ToolCallStatus,
      startedAt: row.started_at,
      completedAt: row.completed_at,
    }))
  }

  /** Name + input of a thread's tool calls (same order as listToolCalls).
   *  PERF: brain working-set capture re-derives from the WHOLE thread each
   *  turn and never reads outputs — this projection skips the output blobs. */
  listToolCallInputs(threadId: string): Array<{ toolName: string; inputJson: string | null }> {
    const rows = this.db
      .prepare(
        'SELECT tool_name, input_json FROM tool_calls WHERE thread_id = ? AND parent_tool_call_id IS NULL ORDER BY started_at ASC, id ASC',
      )
      .all(threadId) as Array<{ tool_name: string; input_json: string | null }>
    return rows.map((row) => ({ toolName: row.tool_name, inputJson: row.input_json }))
  }

  /**
   * Each tool call reduced to the ONE thing a working-set capture reads: which
   * file it touched.
   *
   * The capture runs on every successful turn and asked for every input WHOLE —
   * measured at 1.69 MB on a 600-call thread, because a Write's input is the
   * file it wrote — to pull `file_path` out of each one. SQLite extracts the
   * two path fields itself, so the blobs are never loaded and never become JS
   * strings on the process that draws the UI.
   *
   * `json_valid` guards the rows whose input was never JSON: SQLite raises on
   * malformed input rather than returning null, and a capture is best-effort.
   */
  listToolCallPaths(threadId: string): Array<{ toolName: string; filePath: string | null }> {
    const rows = this.db
      .prepare(
        `SELECT tool_name,
                CASE WHEN json_valid(input_json)
                  THEN coalesce(
                    json_extract(input_json, '$.file_path'),
                    json_extract(input_json, '$.notebook_path')
                  )
                END AS file_path
         FROM tool_calls WHERE thread_id = ? AND parent_tool_call_id IS NULL ORDER BY started_at ASC, id ASC`,
      )
      .all(threadId) as Array<{ tool_name: string; file_path: string | null }>
    return rows.map((row) => ({ toolName: row.tool_name, filePath: row.file_path }))
  }

  private emitChange(event: ThreadChangeEvent): void {
    this.emit(THREAD_STORE_CHANGE_EVENT, event)
  }
}

/** A child thread's title from the parent Task tool-call's input (#1931). */
function subagentThreadTitle(inputJson: string | null): string {
  if (inputJson === null) return 'Sub-agent'
  try {
    const parsed = JSON.parse(inputJson) as { description?: unknown; subagent_type?: unknown }
    const description = typeof parsed.description === 'string' ? parsed.description.trim() : ''
    if (description.length > 0) return description
    const type = typeof parsed.subagent_type === 'string' ? parsed.subagent_type.trim() : ''
    return type.length > 0 ? type : 'Sub-agent'
  } catch {
    return 'Sub-agent'
  }
}

function toThreadRecord(row: ThreadRow): ThreadRecord {
  return {
    id: row.id,
    projectRoot: row[THREAD_PROJECT_ROOT_COLUMN],
    title: row.title,
    sdkSessionId: row.sdk_session_id,
    model: row.model,
    effort: row.effort,
    status: row.status as ThreadStatus,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at ?? null,
    importedAt: row.imported_at ?? null,
    pinnedAt: row.pinned_at ?? null,
    bypassPermissions: (row.bypass_permissions ?? 0) !== 0,
    originLoop: row.origin_loop ?? null,
    originAim: row.origin_aim ?? null,
    originKey: row.origin_key ?? null,
    parentThreadId: row.parent_thread_id ?? null,
    originToolCallId: row.origin_tool_call_id ?? null,
    worktreePath: row.worktree_path ?? null,
    worktreeBranch: row.worktree_branch ?? null,
    worktreeBase: row.worktree_base ?? null,
    remote: row.remote ?? null,
    remoteBranch: row.remote_branch ?? null,
    prBase: row.pr_base ?? null,
    previouslyPushedAs: row.previously_pushed_as ?? null,
    // NULL is the answer for every thread that predates the column and every
    // one that never had a checkout — and it reads as false, which is the
    // truthful reading: nothing is known to be behind.
    baseMayBeBehind: (row.base_may_be_behind ?? 0) !== 0,
    // NULL for every thread that predates the columns and every one no chain
    // is driving — which is almost all of them, and reads as "nothing is
    // running this conversation's steps for it".
    chainId: row.chain_id ?? null,
    chainStage: row.chain_stage ?? null,
  }
}

function toMessageRecord(row: MessageRow): MessageRecord {
  return {
    id: row.id,
    threadId: row.thread_id,
    role: row.role as MessageRole,
    content: row.content,
    createdAt: row.created_at,
    model: row.model ?? null,
    ...(row.ends_turn === 1 ? { endsTurn: true } : {}),
    parentToolCallId: row.parent_tool_call_id ?? null,
  }
}

function toToolCallRecord(row: ToolCallRow): ToolCallRecord {
  return {
    id: row.id,
    threadId: row.thread_id,
    messageId: row.message_id,
    toolName: row.tool_name,
    inputJson: row.input_json,
    outputJson: row.output_json,
    status: row.status as ToolCallStatus,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    parentToolCallId: row.parent_tool_call_id ?? null,
    agentId: row.agent_id ?? null,
  }
}

/** Escape LIKE wildcards in user input so search treats them literally. */
function escapeLikePattern(input: string): string {
  return input.replace(/[\\%_]/g, (match) => `\\${match}`)
}

/**
 * PERF-4: user text → FTS5 MATCH expression. Tokens are runs of letters,
 * digits, `_` and `%` (mirroring the index tokenizer's tokenchars); each is
 * double-quoted — which neutralizes all FTS query syntax (AND/OR/NOT,
 * parens, colons) — and given a `*` prefix flag. Multiple tokens AND
 * together. Returns null when the input contains no indexable token
 * (empty/punctuation-only) so callers can fall back to the LIKE scan.
 */
function buildFtsMatchExpression(query: string): string | null {
  const tokens = query.match(/[\p{L}\p{N}_%]+/gu)
  if (!tokens || tokens.length === 0) {
    return null
  }
  return tokens.map((token) => `"${token.replace(/"/g, '""')}"*`).join(' ')
}
