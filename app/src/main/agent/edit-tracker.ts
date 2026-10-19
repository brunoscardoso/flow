// EditTracker — pending-diff review state for agent Edit/Write tool calls,
// built on ADR-001's canUseTool interception.
//
// Capture model (per ADR-001):
//   - At canUseTool approval time (BEFORE the SDK executes the write) the
//     PermissionBroker's approved-tool observer calls captureApprovedEdit():
//     before-content is read from disk, after-content is computed
//     deterministically from the typed tool input (Write: `content`;
//     Edit: old_string → new_string, replace_all aware).
//   - PostToolUse is the authoritative VERIFIER: verifyToolResult() re-reads
//     disk and re-syncs review state if the applied change drifted from the
//     prediction (drift invalidates the predicted diff — state follows disk).
//     It also captures edits that bypassed canUseTool (ADR watch item:
//     observation and approval are separate channels).
//
// IMPORTANT DESIGN: agent edits land on disk immediately (the SDK writes
// right after allow). Pending hunks are REVIEW state, not a shadow layer —
// accept keeps disk and folds the hunk into the baseline; reject restores
// the baseline content for that hunk on disk (atomic temp+rename write).
//
// One entry per (threadId, absolute file path) — LOG-4: keying by path alone
// let a later thread's edit overwrite threadId and misattribute the whole
// accumulated diff. Each thread's `baseline` is the content before THAT
// thread's first unreviewed edit, so sequential edits by one thread
// accumulate into a single reviewable diff, and two threads editing the same
// file each review their own edits (disk is shared — a later thread's
// baseline already contains the earlier thread's writes).
//
// registerEditReviewChannels() wires the contract's editor:pendingChanges /
// editor:resolveHunk invoke channels and broadcasts
// editor:pendingChangesUpdated. Electron is required lazily inside it so
// this module stays importable from plain Node (E2E harness).

import { EventEmitter } from 'events'
import { timed } from '../ipc/slow-handler'
import { promises as fsPromises } from 'fs'
import { randomBytes } from 'crypto'
import { basename, dirname, join, relative, resolve, sep } from 'path'

import type {
  GitFileChange,
  IpcEventChannel,
  IpcEventPayload,
  IpcInvokeChannel,
  IpcRequest,
  IpcResponse,
  PendingFileChange,
  PendingHunk,
  ResolveHunkOutcome,
} from '../../shared/ipc-contract'
import { isFlowArtifactPath } from './flow-artifacts'

/** Emitted whenever pending-change state mutates. Payload: PendingFileChange[]. */
export const PENDING_CHANGES_EVENT = 'pending-changes'

/**
 * resolveHunk convention: this hunkId resolves EVERY pending hunk of the
 * (thread, file) entry atomically (used by the strip's per-file accept-all /
 * reject-all — each strip row is one thread's entry).
 */
export const ALL_HUNKS = '*'

/** What a resolve actually did — the canonical shape lives in the IPC
 *  contract (the wire boundary), re-exported so this module's callers read
 *  from one source of truth (#1290, #1291). */
export type { ResolveHunkOutcome } from '../../shared/ipc-contract'

/** An approved Edit/Write about to execute (from the PermissionBroker). */
export interface ApprovedToolCall {
  threadId: string
  /** Project root of the owning thread — doubles as the contract rootId. */
  projectRoot: string
  toolName: string
  input: Record<string, unknown>
}

/** PostToolUse verification payload (from the AgentManager's hook). */
export interface ToolResultReport {
  threadId: string
  projectRoot: string
  toolName: string
  input: unknown
  response: unknown
}

interface TrackedFile {
  rootId: string
  /** Root-relative path with '/' separators (contract addressing). */
  filePath: string
  absPath: string
  threadId: string
  /** Content before the first unreviewed agent edit. */
  baseline: string
  /** False → the file did not exist before the agent created it. */
  baselineExisted: boolean
  /** Last known after-content (predicted, then disk-verified). */
  current: string
  /** Memoized computeHunks(baseline, current) — null after any mutation of
   *  THIS file (PERF-1: untouched files reuse their cached hunks). */
  cachedHunks: LineHunk[] | null
}

interface LineHunk {
  /** Zero-based start line in the baseline. */
  beforeStart: number
  beforeLines: string[]
  /** Zero-based start line in the current content. */
  afterStart: number
  afterLines: string[]
}

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit'])
/** LCS cell guard — beyond this the middle collapses into a single hunk. */
const MAX_LCS_CELLS = 1_000_000

export class EditTracker extends EventEmitter {
  /** Keyed by (threadId, absolute file path) — see trackKey() (LOG-4). */
  private readonly files = new Map<string, TrackedFile>()
  /** Per-file resolveHunk serialization (LOG-3) — keyed by absolute path
   *  ACROSS threads, because disk writes to one file must never interleave
   *  regardless of which thread's review is being resolved. */
  private readonly resolveQueues = new Map<string, Promise<void>>()

  // ── Capture (canUseTool approval time, per ADR-001) ────────────────────

  /**
   * Record an approved Edit/Write BEFORE the SDK executes it. Reads
   * before-content from disk, computes after-content from the tool input.
   * Never throws — capture failures must not block the tool call.
   */
  async captureApprovedEdit(call: ApprovedToolCall): Promise<void> {
    if (!EDIT_TOOLS.has(call.toolName)) return
    try {
      const absPath = extractFilePath(call.input)
      if (!absPath) return
      // flow/ artifacts are auto-written — never surface them for review.
      if (isFlowArtifactPath(call.projectRoot, absPath)) return

      const tracked = this.files.get(trackKey(call.threadId, absPath))
      const before = tracked
        ? { content: tracked.current, existed: true }
        : await readFileOrMissing(absPath)

      const after = predictAfterContent(call.toolName, call.input, before.content)
      if (after === null) return // Edit old_string absent — the tool itself will error.

      this.upsert({
        absPath,
        rootId: call.projectRoot,
        threadId: call.threadId,
        before,
        after,
      })
      this.emitChanged()
    } catch (error) {
      console.error('[EditTracker] Failed to capture approved edit:', error)
    }
  }

  // ── Verification (PostToolUse hook, per ADR-001) ───────────────────────

  /**
   * Authoritative post-execution check: re-sync review state from disk.
   * Also captures Edit/Write calls that bypassed canUseTool, using the
   * SDK's own `originalFile` record as the before-content.
   */
  async verifyToolResult(report: ToolResultReport): Promise<void> {
    if (!EDIT_TOOLS.has(report.toolName)) return
    try {
      const input = asRecord(report.input)
      const absPath = input ? extractFilePath(input) : null
      if (!absPath) return
      // flow/ artifacts are auto-written — never surface them for review.
      if (isFlowArtifactPath(report.projectRoot, absPath)) return

      const disk = await readFileOrMissing(absPath)
      const key = trackKey(report.threadId, absPath)
      const tracked = this.files.get(key)

      if (tracked) {
        if (disk.content === tracked.current) return
        // Prediction drift is review-invalidating: disk is the truth.
        console.warn(
          `[EditTracker] PostToolUse mismatch for ${absPath} — re-syncing review state from disk`,
        )
        tracked.current = disk.content
        tracked.cachedHunks = null
        this.dropIfSettled(key)
        this.emitChanged()
        return
      }

      // Bypass capture: no canUseTool roundtrip captured the pre-write content.
      // When the SDK response carries `originalFile`, that IS the real baseline.
      // When it doesn't, the baseline is UNKNOWN — and we must NOT infer
      // "agent-created" from the tool name: a Write can OVERWRITE an existing
      // file, and marking that existed:false makes a later reject `rm` a
      // pre-existing file (#108). So an unknown baseline is treated as
      // existed:true — reject reverts, never deletes. Worst case a genuinely-new
      // bypass file is emptied rather than removed on reject: a harmless
      // leftover, not data loss. (Restoring the true original in bypass mode
      // would require capturing before-content in a PreToolUse hook.)
      const originalFile = extractOriginalFile(report.response)
      this.upsert({
        absPath,
        rootId: report.projectRoot,
        threadId: report.threadId,
        before:
          originalFile !== null
            ? { content: originalFile, existed: true }
            : { content: '', existed: true },
        after: disk.content,
      })
      this.emitChanged()
    } catch (error) {
      console.error('[EditTracker] Failed to verify tool result:', error)
    }
  }

  // ── Review state ────────────────────────────────────────────────────────

  /** Current pending changes (optionally scoped to one project root). */
  listPendingChanges(rootId?: string): PendingFileChange[] {
    const changes: PendingFileChange[] = []
    for (const tracked of this.files.values()) {
      if (rootId && tracked.rootId !== rootId) continue
      const hunks = this.hunksFor(tracked)
      if (hunks.length === 0) continue
      changes.push({
        rootId: tracked.rootId,
        filePath: tracked.filePath,
        threadId: tracked.threadId,
        hunks: hunks.map(toPendingHunk),
      })
    }
    return changes
  }

  /**
   * Accept keeps the change on disk and folds it into the baseline; reject
   * restores the baseline content for that hunk and rewrites the file
   * (atomic temp+rename). hunkId ALL_HUNKS ('*') resolves every pending hunk
   * of the (thread, file) entry. threadId disambiguates when two threads
   * have pending changes on the same file (LOG-4).
   */
  async resolveHunk(params: {
    rootId: string
    filePath: string
    threadId: string
    hunkId: string
    action: 'accept' | 'reject'
    /**
     * #1290: how many hunks the CALLER believes are in scope (what its UI is
     * showing). Disk is re-read at resolution time and any drift joins this
     * entry's diff, so a whole-file reject can cover edits the user made and
     * saved AFTER the review was broadcast — and destroy them, uncommitted and
     * unrecoverable, under a count that said "1 pending hunk".
     *
     * When the real target count exceeds this, nothing is written: the call
     * returns `scope-changed` with the true count so the caller can re-derive
     * and ask. Omit it to proceed regardless (the confirmed re-issue).
     */
    expectedHunks?: number
  }): Promise<ResolveHunkOutcome> {
    // LOG-3: serialize per absolute file path — unserialized read-modify-write
    // lets two rapid resolutions on one file silently lose the first revert.
    const queueKey = resolve(params.rootId, ...params.filePath.split('/'))
    const previous = this.resolveQueues.get(queueKey) ?? Promise.resolve()
    const run = previous.then(() => this.resolveHunkSerialized(params))
    // The queue tail must never reject (a failed resolve would wedge the
    // file's queue); callers still see the failure through `run`.
    const tail = run.then(
      () => undefined,
      () => undefined,
    )
    this.resolveQueues.set(queueKey, tail)
    void tail.then(() => {
      if (this.resolveQueues.get(queueKey) === tail) {
        this.resolveQueues.delete(queueKey)
      }
    })
    return run
  }

  private async resolveHunkSerialized(params: {
    rootId: string
    filePath: string
    threadId: string
    hunkId: string
    action: 'accept' | 'reject'
    expectedHunks?: number
  }): Promise<ResolveHunkOutcome> {
    const tracked = this.findTracked(params.rootId, params.filePath, params.threadId)
    if (!tracked) {
      throw new Error(
        `[EditTracker] No pending changes for ${params.filePath} (thread ${params.threadId})`,
      )
    }

    // Re-read disk at resolution time — the user (or another thread) may
    // have touched the file after the last broadcast. Disk is the truth:
    // unreviewed drift joins THIS entry's diff at resolution time.
    const disk = await readFileOrMissing(tracked.absPath)
    tracked.current = disk.content
    tracked.cachedHunks = null

    const hunks = this.hunksFor(tracked)
    const targets =
      params.hunkId === ALL_HUNKS
        ? hunks
        : hunks.filter((hunk) => toPendingHunk(hunk).hunkId === params.hunkId)
    if (targets.length === 0) {
      // Hunk ids embed position + content hash, so ANY edit invalidates them.
      // This stays a THROW — it is a genuine failure of the requested action.
      // #1291 was that the renderer swallowed it to console.error, leaving a
      // widget offering an action that could never succeed; the renderer now
      // reports it and re-derives.
      throw new Error(
        `[EditTracker] Unknown or already-resolved hunk ${params.hunkId} in ${params.filePath}`,
      )
    }

    // #1290: the scope grew under the caller. Write nothing; let it ask.
    if (params.expectedHunks !== undefined && targets.length > params.expectedHunks) {
      this.emitChanged() // the caller's view is stale — refresh it either way
      return { status: 'scope-changed', hunks: targets.length, expected: params.expectedHunks }
    }

    if (params.action === 'accept') {
      tracked.baseline = applyHunksToBaseline(tracked.baseline, targets)
      tracked.baselineExisted = true
    } else {
      const reverted = revertHunksInCurrent(tracked.current, targets)
      if (reverted === tracked.baseline && !tracked.baselineExisted) {
        // Rejecting everything on an agent-created file restores nonexistence.
        await fsPromises.rm(tracked.absPath, { force: true })
      } else {
        await writeFileAtomic(tracked.absPath, reverted)
      }
      tracked.current = reverted
    }
    tracked.cachedHunks = null

    this.dropIfSettled(trackKey(tracked.threadId, tracked.absPath))
    this.emitChanged()
    return { status: 'resolved', hunks: targets.length }
  }

  /**
   * Reconcile pending review state against git (#893): the source-control
   * panel and the pending-hunks strip must agree. Two signals mark a tracked
   * file's review as settled OUTSIDE the strip:
   *
   *  1. The file is ABSENT from git changes — its content was committed (or
   *     reverted to HEAD). The review happened in source control; offering
   *     Accept/Reject for it now is stale, and Reject would destructively
   *     restore a pre-edit baseline over committed work.
   *  2. The file is fully STAGED with no further worktree edits — approval IS
   *     staging (#857), so staging in source control IS the accept.
   *
   * Either way the entry resolves as ACCEPTED: the baseline folds to disk,
   * nothing on disk changes, and the strip row clears. A file still dirty in
   * the worktree (unstaged, or staged-then-re-edited) stays pending. Called
   * on every git:changed for the root; fail-soft, never throws.
   *
   * Known benign race: between captureApprovedEdit and the SDK's disk write,
   * a git refresh could see the file clean and settle the entry early —
   * PostToolUse verification re-captures the edit from disk right after, so
   * disk truth always wins.
   */
  async reconcileWithGit(
    rootId: string,
    changes: ReadonlyArray<Pick<GitFileChange, 'filePath' | 'staged' | 'worktreeState'>>,
  ): Promise<void> {
    const byPath = new Map(changes.map((change) => [change.filePath, change]))
    let mutated = false
    for (const [key, tracked] of [...this.files]) {
      if (tracked.rootId !== rootId) continue
      const change = byPath.get(tracked.filePath)
      const settledByGit =
        change === undefined ||
        (change.staged === true && (change.worktreeState === null || change.worktreeState === undefined))
      if (!settledByGit) continue
      try {
        const disk = await readFileOrMissing(tracked.absPath)
        tracked.baseline = disk.content
        tracked.current = disk.content
        tracked.baselineExisted = disk.existed
        tracked.cachedHunks = null
        this.files.delete(key)
        mutated = true
      } catch {
        // Unreadable disk — leave the entry; the next refresh retries.
      }
    }
    if (mutated) this.emitChanged()
  }

  /** Discard all review state (baselines are forgotten, disk is untouched). */
  clear(): void {
    if (this.files.size === 0) return
    this.files.clear()
    this.emitChanged()
  }

  // ── Internals ───────────────────────────────────────────────────────────

  private upsert(params: {
    absPath: string
    rootId: string
    threadId: string
    before: { content: string; existed: boolean }
    after: string
  }): void {
    const key = trackKey(params.threadId, params.absPath)
    const existing = this.files.get(key)
    if (existing) {
      existing.current = params.after
      existing.cachedHunks = null
      this.dropIfSettled(key)
      return
    }
    if (params.before.content === params.after) return
    this.files.set(key, {
      rootId: params.rootId,
      filePath: toRootRelative(params.rootId, params.absPath),
      absPath: params.absPath,
      threadId: params.threadId,
      baseline: params.before.content,
      baselineExisted: params.before.existed,
      current: params.after,
      cachedHunks: null,
    })
  }

  /** Memoized computeHunks — recomputed only after a mutation of THIS file. */
  private hunksFor(tracked: TrackedFile): LineHunk[] {
    if (tracked.cachedHunks === null) {
      tracked.cachedHunks = computeHunks(tracked.baseline, tracked.current)
    }
    return tracked.cachedHunks
  }

  private dropIfSettled(key: string): void {
    const tracked = this.files.get(key)
    if (tracked && tracked.baseline === tracked.current) {
      this.files.delete(key)
    }
  }

  private findTracked(rootId: string, filePath: string, threadId: string): TrackedFile | null {
    for (const tracked of this.files.values()) {
      if (
        tracked.rootId === rootId &&
        tracked.filePath === filePath &&
        tracked.threadId === threadId
      ) {
        return tracked
      }
    }
    return null
  }

  private emitChanged(): void {
    this.emit(PENDING_CHANGES_EVENT, this.listPendingChanges())
  }
}

// ── IPC registration ───────────────────────────────────────────────────────

export interface EditReviewIpcDependencies {
  tracker: EditTracker
}

/**
 * Register the contract's editor:pendingChanges / editor:resolveHunk invoke
 * handlers and broadcast editor:pendingChangesUpdated on state changes.
 * Returns a dispose function. Electron is loaded lazily so importing this
 * module from plain Node (test harness) never touches it.
 */
export function registerEditReviewChannels(deps: EditReviewIpcDependencies): () => void {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const electron = require('electron') as typeof import('electron')
  const { ipcMain, BrowserWindow } = electron
  const { tracker } = deps

  const registeredChannels: IpcInvokeChannel[] = []

  function handle<C extends IpcInvokeChannel>(
    channel: C,
    handler: (request: IpcRequest<C>) => IpcResponse<C> | Promise<IpcResponse<C>>,
  ): void {
    registeredChannels.push(channel)
    ipcMain.handle(channel, (_event, request: IpcRequest<C>) => timed(channel, handler)(request))
  }

  handle('editor:pendingChanges', ({ rootId }) => tracker.listPendingChanges(rootId))
  handle('editor:resolveHunk', (request) => tracker.resolveHunk(request))

  const onPendingChanges = (changes: IpcEventPayload<'editor:pendingChangesUpdated'>): void => {
    broadcast('editor:pendingChangesUpdated', changes)
  }
  tracker.on(PENDING_CHANGES_EVENT, onPendingChanges)

  function broadcast<C extends IpcEventChannel>(
    channel: C,
    payload: IpcEventPayload<C>,
  ): void {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) {
        window.webContents.send(channel, payload)
      }
    }
  }

  return function disposeEditReviewChannels(): void {
    for (const channel of registeredChannels) {
      ipcMain.removeHandler(channel)
    }
    registeredChannels.length = 0
    tracker.off(PENDING_CHANGES_EVENT, onPendingChanges)
  }
}

// ── Tracked-file keying (LOG-4) ────────────────────────────────────────────

/** Map key scoping tracked state per (threadId, absolute path). '\0' cannot
 *  appear in either component, so the key is collision-free. */
function trackKey(threadId: string, absPath: string): string {
  return `${threadId}\u0000${absPath}`
}

// ── Tool-input interpretation ──────────────────────────────────────────────

function extractFilePath(input: Record<string, unknown>): string | null {
  const candidate = input['file_path']
  return typeof candidate === 'string' && candidate.length > 0 ? resolve(candidate) : null
}

/**
 * Deterministic after-content from the typed tool input (ADR-001): Write is
 * `content`; Edit replaces old_string with new_string using the tool's own
 * semantics (first occurrence, or every occurrence with replace_all); MultiEdit
 * applies its `edits` array sequentially, each over the prior result (the tool
 * is atomic — any edit that doesn't apply fails the whole call).
 * Null → the prediction is impossible (the tool call itself will fail).
 */
function predictAfterContent(
  toolName: string,
  input: Record<string, unknown>,
  before: string,
): string | null {
  if (toolName === 'Write') {
    const content = input['content']
    return typeof content === 'string' ? content : null
  }

  if (toolName === 'MultiEdit') {
    const edits = input['edits']
    if (!Array.isArray(edits) || edits.length === 0) return null
    let current = before
    for (const edit of edits) {
      const record = asRecord(edit)
      if (!record) return null
      const next = applyStringEdit(
        current,
        record['old_string'],
        record['new_string'],
        record['replace_all'],
      )
      if (next === null) return null
      current = next
    }
    return current
  }

  return applyStringEdit(before, input['old_string'], input['new_string'], input['replace_all'])
}

/**
 * One Edit-style string replacement (shared by Edit and each MultiEdit entry).
 * Null when the edit can't apply: non-string args, empty old_string, or
 * old_string absent from `before`.
 */
function applyStringEdit(
  before: string,
  oldString: unknown,
  newString: unknown,
  replaceAll: unknown,
): string | null {
  if (typeof oldString !== 'string' || typeof newString !== 'string') return null
  if (oldString.length === 0 || !before.includes(oldString)) return null

  if (replaceAll === true) {
    return before.split(oldString).join(newString)
  }
  const index = before.indexOf(oldString)
  return before.slice(0, index) + newString + before.slice(index + oldString.length)
}

/** PostToolUse Edit responses carry the SDK's own before-content record. */
function extractOriginalFile(response: unknown): string | null {
  const record = asRecord(response)
  const originalFile = record?.['originalFile']
  return typeof originalFile === 'string' ? originalFile : null
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

// ── Filesystem helpers ─────────────────────────────────────────────────────

async function readFileOrMissing(
  absPath: string,
): Promise<{ content: string; existed: boolean }> {
  try {
    const content = await fsPromises.readFile(absPath, 'utf8')
    return { content, existed: true }
  } catch (error) {
    if (isFileMissingError(error)) {
      return { content: '', existed: false }
    }
    throw error
  }
}

function isFileMissingError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as NodeJS.ErrnoException).code === 'ENOENT'
  )
}

/** Same atomic temp+rename pattern as project:writeFile. */
async function writeFileAtomic(absPath: string, content: string): Promise<void> {
  const tempPath = join(
    dirname(absPath),
    `.${basename(absPath)}.${randomBytes(6).toString('hex')}.flow-tmp`,
  )
  try {
    await fsPromises.writeFile(tempPath, content, 'utf8')
    await fsPromises.rename(tempPath, absPath)
  } catch (error) {
    await fsPromises.rm(tempPath, { force: true }).catch(() => undefined)
    throw error
  }
}

function toRootRelative(rootId: string, absPath: string): string {
  const rel = relative(resolve(rootId), absPath)
  return rel.split(sep).join('/')
}

// ── Line diff (hunk computation) ───────────────────────────────────────────
//
// Line-based diff with common prefix/suffix trimming and an LCS core over
// the remaining middle. Splitting on '\n' keeps a trailing-newline-terminated
// file's final empty segment as its own "line", so joins are byte-exact —
// the property accept/reject correctness depends on.

function computeHunks(before: string, after: string): LineHunk[] {
  if (before === after) return []
  const a = before.split('\n')
  const b = after.split('\n')

  let prefix = 0
  const maxPrefix = Math.min(a.length, b.length)
  while (prefix < maxPrefix && a[prefix] === b[prefix]) prefix++

  let suffix = 0
  const maxSuffix = Math.min(a.length, b.length) - prefix
  while (suffix < maxSuffix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix++

  const middleA = a.slice(prefix, a.length - suffix)
  const middleB = b.slice(prefix, b.length - suffix)

  if (middleA.length * middleB.length > MAX_LCS_CELLS) {
    // Guard for very large diffs: one hunk covering the whole changed middle.
    return [
      { beforeStart: prefix, beforeLines: middleA, afterStart: prefix, afterLines: middleB },
    ]
  }

  return lcsHunks(middleA, middleB, prefix)
}

/** Contiguous non-matching runs from an LCS backtrack, offset into the files. */
function lcsHunks(a: string[], b: string[], offset: number): LineHunk[] {
  const rows = a.length + 1
  const cols = b.length + 1
  // Flat Int32 LCS-length table (rows × cols).
  const table = new Int32Array(rows * cols)
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i * cols + j] =
        a[i] === b[j]
          ? table[(i + 1) * cols + j + 1] + 1
          : Math.max(table[(i + 1) * cols + j], table[i * cols + j + 1])
    }
  }

  const hunks: LineHunk[] = []
  let i = 0
  let j = 0
  let open: LineHunk | null = null

  const openHunk = (): LineHunk => {
    if (!open) {
      open = { beforeStart: i, beforeLines: [], afterStart: j, afterLines: [] }
      hunks.push(open)
    }
    return open
  }

  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      open = null
      i++
      j++
    } else if (j < b.length && (i === a.length || table[i * cols + j + 1] >= table[(i + 1) * cols + j])) {
      openHunk().afterLines.push(b[j])
      j++
    } else {
      openHunk().beforeLines.push(a[i])
      i++
    }
  }

  for (const hunk of hunks) {
    hunk.beforeStart += offset
    hunk.afterStart += offset
  }
  return hunks
}

/**
 * Contract mapping. `range` addresses the hunk's lines in the CURRENT file
 * (zero-based, end-exclusive); a pure deletion collapses to a zero-length
 * range at the deletion point. hunkId is deterministic for a given
 * (baseline, current) pair so recomputation before resolve finds it again.
 */
function toPendingHunk(hunk: LineHunk): PendingHunk {
  const beforeText = hunk.beforeLines.join('\n')
  const afterText = hunk.afterLines.join('\n')
  return {
    hunkId: `${hunk.afterStart}-${hunk.beforeLines.length}-${hashText(`${beforeText}\x00${afterText}`)}`,
    range: {
      start: { line: hunk.afterStart, character: 0 },
      end: { line: hunk.afterStart + hunk.afterLines.length, character: 0 },
    },
    beforeText,
    afterText,
    status: 'pending',
  }
}

/** djb2-xor — tiny stable content hash for hunk identity. */
function hashText(text: string): string {
  let hash = 5381
  for (let index = 0; index < text.length; index++) {
    hash = ((hash << 5) + hash) ^ text.charCodeAt(index)
  }
  return (hash >>> 0).toString(36)
}

/**
 * Accept: fold the hunks' after-lines into the baseline (replace each
 * before-run with its after-run, descending so indices stay valid).
 */
function applyHunksToBaseline(baseline: string, hunks: LineHunk[]): string {
  const lines = baseline.split('\n')
  const ordered = [...hunks].sort((x, y) => y.beforeStart - x.beforeStart)
  for (const hunk of ordered) {
    lines.splice(hunk.beforeStart, hunk.beforeLines.length, ...hunk.afterLines)
  }
  return lines.join('\n')
}

/**
 * Reject: restore the hunks' before-lines into the current content (replace
 * each after-run with its before-run, descending so indices stay valid).
 */
function revertHunksInCurrent(current: string, hunks: LineHunk[]): string {
  const lines = current.split('\n')
  const ordered = [...hunks].sort((x, y) => y.afterStart - x.afterStart)
  for (const hunk of ordered) {
    lines.splice(hunk.afterStart, hunk.afterLines.length, ...hunk.beforeLines)
  }
  return lines.join('\n')
}
