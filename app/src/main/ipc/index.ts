// IPC registry — registers ipcMain.handle handlers for the main-process
// managers and wires manager change events to renderer broadcasts.
//
// Channel names and request/response/payload types come EXCLUSIVELY from the
// shared contract (src/shared/ipc-contract.ts) — the single source of truth
// for the main ↔ renderer boundary. The typed `handle`/`broadcast` helpers
// below make it a compile error to register a channel the contract doesn't
// define or to return a shape the contract doesn't declare.
//
// Only channels with a backing manager are registered here; agent channels
// live in src/main/agent/ipc.ts, file IO in src/main/project/files.ts, and
// flow observation in src/main/flow/flow-observer.ts. Contract channels for
// domains that don't exist yet (editor, terminal, git) stay
// declared-but-unregistered until their managers land.
//
// SECURITY: credential VALUES never cross this boundary main → renderer — the
// renderer can list service names, set, and delete, but never read secrets.

import { checkAttachRoots } from '../project/attach-roots'
import { createAddressableRoots } from '../project/addressable-roots'
import { app as electronApp, ipcMain, BrowserWindow, dialog, shell } from 'electron'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import type {
  IpcEventChannel,
  IpcEventPayload,
  IpcInvokeChannel,
  IpcRequest,
  IpcResponse,
  LearnForgetTally,
  ThreadSummary,
  TaskSummary,
  ToolCallRecord,
} from '../../shared/ipc-contract'
import type { AppSettingsStore } from '../store/app-settings-store'
import type { AttachmentStore } from '../store/attachment-store'
import type { UpdaterManager } from '../updater/updater-manager'
import { notifyEditorContextFlushed } from '../project/editor-context-flush'
import { captureScreenRegion } from '../attachments/capture'
import { isCaptureSupported } from '../attachments/capture-support'
import { browserController } from '../browser/controller'
import { captureScreenshot } from '../browser/screenshot'
import { importClaudeSessions } from '../claude-import'
import { readSlowLog, recordSlow, timed } from './slow-handler'

/** A batch bigger than this is a bug in the recorder, not evidence — the log is
 *  for moments a person felt, and no one felt two hundred of them at once. */
const MAX_RECORDED_LINES = 200
import {
  ThreadStore,
  THREAD_STORE_CHANGE_EVENT,
  type ThreadRecord,
  type ThreadChangeEvent,
} from '../store/thread-store'
import {
  TaskStore,
  TASK_STORE_CHANGE_EVENT,
  type TaskRecord,
  type TaskChangeEvent,
} from '../store/task-store'
import { IntegrationsManager } from '../integrations/integrations-manager'
import {
  applyTaskUpdate,
  chooseTaskProjects,
  createManualTask,
  createTaskFromIssue,
  createTaskFromQueueItem,
  ensureTaskThread,
  generateTaskBrief,
  rememberChosenProjects,
  syncTaskTitleFromThread,
  taskHasBriefContent,
  type BriefGenerator,
  type TaskProjectsRecord,
} from '../tasks/task-service'
import { removeProject } from '../project/remove-project'
import { forgetListAllCache } from '../project/files'
import { forgetContentSearchCache } from '../project/content-search'
import { addRootAndMaybeActivate } from '../project/add-root'
import { nextActiveRootAfterRemove, resolveActiveRoot } from '../../shared/root-selection'
import {
  ProjectRegistry,
  PROJECT_LIST_CHANGED_EVENT,
  PROJECT_FILES_CHANGED_EVENT,
  type RegisteredProject,
  type ProjectFilesChangedEvent,
} from '../project/project-registry'
import { makeRootsBroadcast } from '../project/roots-broadcast'
import {
  ProjectContextManager,
  ACTIVE_PROJECT_CHANGED_EVENT,
} from '../project/project-context'
import {
  ThreadScopeManager,
  THREAD_SCOPE_CHANGED_EVENT,
} from '../project/thread-scope-manager'
import type { ProjectContext, ThreadScope } from '../../shared/ipc-contract'
import type { BoardLoop } from '../tasks/board-loop'
import type { AutopilotChain } from '../drive/autopilot-chain'
import type { DebugSessionSummary, DebugStopResult } from '../../shared/debug-session-ipc'
import { DebugSessionRecorder } from '../debug/debug-session'
import type { TerminalSource } from '../debug/debug-wiring'
import { makeDebugSessionDeps } from '../debug/debug-wiring'
import { writeDebugArtifact } from '../debug/debug-artifact'
import { summaryText } from '../../shared/debug-timeline'

/** Quiet window before batched thread change events are broadcast. */
const BROADCAST_DEBOUNCE_MS = 50

/**
 * The longest a batch may be held while events keep arriving.
 *
 * A plain debounce resets on every event, so a stream that never pauses for
 * 50ms never flushes: the surfaces see nothing at all while the agent works
 * hardest, then one enormous batch when it finally breathes. Both failure modes
 * — the storm and the starvation — come from the same missing bound.
 */
const BROADCAST_MAX_WAIT_MS = 250

/**
 * Batch events for broadcast: quiet for `BROADCAST_DEBOUNCE_MS`, or at most
 * `BROADCAST_MAX_WAIT_MS` since the first one, whichever comes first.
 *
 * ONE HELPER FOR BOTH STREAMS (allowed-pattern #14): thread and task events had
 * the same hand-rolled debounce, which meant one could be fixed and the other
 * left — and their consumers see them as the same kind of thing.
 */
export function makeEventBatch<T>(
  flush: (events: T[]) => void,
  /** Injected so a test can drive the ceiling without sleeping through it. */
  now: () => number = () => Date.now(),
): {
  push: (event: T) => void
  dispose: () => void
} {
  let pending: T[] = []
  let timer: NodeJS.Timeout | null = null
  let firstAt = 0
  const send = (): void => {
    if (timer !== null) clearTimeout(timer)
    timer = null
    const events = pending
    pending = []
    if (events.length > 0) flush(events)
  }
  return {
    push: (event: T): void => {
      if (pending.length === 0) firstAt = now()
      pending.push(event)
      if (now() - firstAt >= BROADCAST_MAX_WAIT_MS) {
        send()
        return
      }
      if (timer !== null) clearTimeout(timer)
      timer = setTimeout(send, BROADCAST_DEBOUNCE_MS)
    },
    dispose: (): void => {
      if (timer !== null) clearTimeout(timer)
      timer = null
      pending = []
    },
  }
}

export interface IpcDependencies {
  threadStore: ThreadStore
  taskStore: TaskStore
  integrations: IntegrationsManager
  projectRegistry: ProjectRegistry
  /**
   * The terminal manager, for the debug session's recording half.
   *
   * REQUIRED, not optional. A session constructed without it would record the
   * browser and silently claim to be recording the terminals too — the whole
   * point of the feature, missing, with no compile error to say so
   * (allowed-pattern #26).
   */
  terminalManager: () => TerminalSource | null
  projectContext: ProjectContextManager
  /** Thread-scope derivation (multi-project threads) — serves
   *  `project:getThreadScope` and pushes `project:threadScopeChanged`.
   *  Optional so tests/headless harnesses can omit it (empty scope then). */
  threadScope?: ThreadScopeManager
  /** One-shot generator for a task's technical brief (wired to the AgentManager). */
  briefGenerator: BriefGenerator
  /** The board's own loop — built in index.ts, where the AgentManager lives. */
  boardLoop: BoardLoop
  /**
   * The autopilot chain — built in index.ts for the same reason the board's
   * loop is: it needs the AgentManager to start a turn. Optional so tests and
   * headless harnesses can omit it; `flow:chain` then answers "not running" and
   * starts nothing, which is the honest answer for a process that has no driver.
   */
  autopilotChain?: AutopilotChain
  /**
   * Merge a Review card's pull request and advance it to Done. Built in
   * index.ts, where both the TaskStore (to resolve the card and move it) and the
   * ThreadLandingService (to run the merge) live. Optional so tests/headless
   * harnesses can omit it — `tasks:mergePr` then answers "not available".
   */
  mergeTaskPr?: (taskId: string) => Promise<import('../../shared/ipc-contract').TaskMergeResult>
  /** Image-attachment persistence + read (#456). */
  attachmentStore: AttachmentStore
  /** App-wide settings — threads:create reads the persisted model+effort
   *  preference (#848). Optional so tests/harnesses can omit it. */
  appSettings?: AppSettingsStore
  /**
   * Usage events (client-identity Phase 3).
   *
   * Optional for the same reason as `appSettings`: a harness that does not care
   * about telemetry should not have to build one. Every call site uses `?.`, so
   * an absent service is silence rather than a crash — and silence is the
   * correct behaviour, since the switch defaults to off anyway.
   */
  telemetry?: import('../telemetry/telemetry-service').TelemetryService
  /**
   * Backfill an EMPTY promoted sub-agent child from SDK session storage (#1931,
   * subagent-backfill.ts). Awaited by `threads:openSubagent` BEFORE it answers,
   * so the renderer's thread switch lands on a populated child — a first
   * promotion of an old run may take a moment, which is the honest cost of
   * reading the transcript it never had. Fail-soft inside (never throws);
   * optional so tests and headless harnesses can omit it.
   */
  backfillSubagentThread?: (childThreadId: string) => Promise<unknown>
  /** In-app auto-update controller (#auto-update). */
  updater: UpdaterManager
  /**
   * Fire-and-forget auto-provisioning trigger (ide-auto-provisioning). Called
   * with a root's path whenever it's added or activated; the Provisioner decides
   * whether to provision/refresh/skip and never blocks the IPC response; once
   * it settles, a project in no Workspace joins `workspace` (the current one
   * when absent). Optional so tests and headless harnesses can omit it.
   */
  maybeProvision?: (rootPath: string, options?: { workspace?: string }) => void
  /**
   * Toast "that project's folder isn't there" (#974/#1118). Called when an
   * activation is refused because the requested root is unreachable, so the
   * refusal is never a silent no-op. Optional — omitted, the refusal still
   * happens and only the console line records it.
   */
  notifyUnreachableRoot?: (rootPath: string) => void
  /**
   * Close a removed project's terminals (#1484). Optional so headless harnesses
   * and tests can omit it; when absent, removal behaves exactly as it used to.
   */
  disposeTerminalsForRoot?: (rootPath: string) => void
  /**
   * Forget what Flow held about a removed project's place in a Workspace (a
   * move waiting on a person, a failure) so it stops being listed as needing
   * attention. REQUIRED (allowed-pattern #26).
   */
  forgetKnowledgeRoot: (rootPath: string) => void
  /**
   * Manual re-provision (settings surface's "Re-provision now" action,
   * ide-auto-provisioning phase 5). Unlike `maybeProvision`, this FORCES the
   * bundled CLI's provision flow regardless of the root's current stamp —
   * re-running init is idempotent, so this is just `maybeProvision` with the
   * decision hard-coded to 'provision'. Resolves once the run completes so the
   * settings row can await it; success/failure still surface via
   * `project:listChanged` / a `flow:notification` toast like every other
   * provisioning path. Optional so tests and headless harnesses can omit it.
   */
  provisionRoot?: (rootPath: string) => Promise<void>
  /**
   * Record + act on the basic-discovery onboarding answer (#513 phase 2).
   * Called with a root's path and the user's answer ('yes' also requests the
   * discovery via the main-side learn emitter; the Settings action re-fires
   * with 'yes'). Optional so tests/headless harnesses can omit it.
   */
  answerBasicDiscovery?: (
    rootPath: string,
    answer: import('../../shared/ipc-contract').BasicDiscoveryAnswer,
  ) => void
  /**
   * Answer the chat-learn ask — 'yes' learns the area the conversation worked
   * in and re-levels the store so it hangs under the feature that owns it.
   * Optional so tests/headless harnesses can omit it.
   */
  answerChatLearn?: (
    rootPath: string,
    modulePath: string,
    answer: import('../../shared/ipc-contract').BasicDiscoveryAnswer,
  ) => void
  /**
   * Learn (or re-learn) a single module (#513 phase 6) — the board's "Learn"
   * button. Enqueues a deliberate learn pass on the main-side orchestrator.
   * Optional so tests/headless harnesses can omit it.
   */
  learnModule?: (rootPath: string, modulePath: string) => void
  learnFeature?: (request: IpcRequest<'learn:learnFeature'>) => void
  generateFeatureView?: (request: IpcRequest<'learn:generateFeatureView'>) => void
  /**
   * Pause/resume the learn drain loop (the Learning panel's Pause button,
   * #learn-controls). Global — the orchestrator's queue is global-serial. Main
   * echoes the resulting state on the `learn:pausedChanged` broadcast.
   * Optional so tests/headless harnesses can omit it.
   */
  learnPause?: (paused: boolean) => void
  /** Pause or resume one project's learning. */
  learnPauseRoot?: (rootPath: string, paused: boolean) => void
  /** Where each project stands on its basic discovery (learn:basicDiscoveryState). */
  basicDiscoveryState?: (
    roots: readonly string[],
  ) => Record<string, import('../../shared/basic-discovery').BasicDiscoveryStatus>
  /** What the learner is doing right now (learn:status). */
  learnStatus?: () => {
    running: boolean
    paused: boolean
    activeModule: string | null
    /** The root the active pass belongs to — see the channel's own doc. */
    activeRoot: string | null
    queued: number
    startedAt: number | null
  }
  /** The learner's recent activity, oldest first (learn:log). */
  learnLog?: () => Array<{
    at: number
    kind: 'queued' | 'start' | 'read' | 'learned' | 'failed' | 'stopped' | 'note'
    module: string
    detail?: string
  }>
  /**
   * Stop a root's learning (the Learning panel's Stop button): abort the
   * active pass + drop the queue; orphaned entries flip stale immediately.
   * Optional so tests/headless harnesses can omit it.
   */
  learnCancel?: (rootPath: string) => Promise<void>
  /**
   * Wipe a root's learning-state (the Learning panel's Reset button) — every
   * module reads never-learned again; docs and investigation notes untouched.
   * Optional so tests/headless harnesses can omit it.
   */
  learnReset?: (
    rootPath: string,
    options: { dryRun: boolean },
  ) => Promise<{ ok: boolean; tally?: LearnForgetTally; reason?: string }>
  /**
   * Read a root's cumulative brain-retrieval counters (brain-first-retrieval
   * Phase 4) — serves the Learning panel's "Brain retrieval" line. Fail-soft
   * by contract (zeros on a missing/corrupt store). Optional so
   * tests/headless harnesses can omit it (zeros then).
   */
  brainUsage?: (rootPath: string) => Promise<import('../../shared/ipc-contract').BrainUsageTotals>
  /**
   * Estimated tokens saved by knowledge search across ONE thread (the
   * conversation pane's cumulative chip) — a pure recompute over the thread's
   * persisted tool calls plus the root's rolling burst samples. Fail-soft by
   * contract (unknown thread → zero). Optional so tests/headless harnesses
   * can omit it (zero then).
   */
  brainThreadSavings?: (
    threadId: string,
  ) => Promise<import('../../shared/ipc-contract').BrainThreadSavings>
}

/** The app-settings rows behind a task's chosen projects (task-service's record). */
function taskProjectsRecord(appSettings: AppSettingsStore): TaskProjectsRecord {
  return {
    setExtra: (taskId, roots) => appSettings.setTaskExtraProjects(taskId, roots),
    markChosen: (taskId) => appSettings.markTaskProjectsChosen(taskId),
  }
}

/** TaskStore record → contract summary (renderer-facing). */
function toTaskSummary(record: TaskRecord): TaskSummary {
  return {
    id: record.id,
    projectRoot: record.projectRoot,
    title: record.title,
    source: record.source,
    externalKey: record.externalKey,
    externalUrl: record.externalUrl,
    lane: record.lane,
    suggestDone: record.suggestDone,
    threadId: record.threadId,
    originThreadId: record.originThreadId,
    description: record.description,
    images: record.images,
    autoFix: record.autoFix,
    prUrl: record.prUrl,
    brief: record.brief,
    briefStatus: record.briefStatus,
    archivedAt: record.archivedAt,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  }
}

/** ThreadStore record → contract summary. */

/**
 * A tool call's own summary keys — the short values a collapsed card prints.
 *
 * DUPLICATED BY VALUE, deliberately: `inputSummary` in tool-card.ts owns the
 * rendering rule and this owns what survives the wire, and they are on opposite
 * sides of the IPC boundary. A shared import would drag renderer code into main
 * for four strings; what matters is that anything the card might print is kept,
 * which the test asserts against the card's own list.
 */
const SUMMARY_KEYS = ['file_path', 'command', 'pattern', 'path', 'prompt', 'description', 'query']

/** Longest scalar kept whole inside a stubbed input — a path or a command. */
const SUMMARY_VALUE_MAX = 400

/** Inputs shorter than this are cheap enough to send as they are. */
const INPUT_KEEP_BYTES = 2_000

/**
 * The input a card can still SUMMARIZE, without the file it carried.
 *
 * A `Write` call's input is `{file_path, content}` and the content is the whole
 * file — measured at 2.18 MB across a 600-call session with 20% writes, which
 * is the bulk left over once outputs are bounded. But the collapsed card prints
 * `file_path` FROM that input, so withholding it outright would blank the
 * summary line of every old write. So the short scalars survive and the long
 * ones do not: the card reads exactly as it did, and the body it never showed
 * unopened is fetched if the reader opens it.
 *
 * An input that does not parse keeps its first `INPUT_KEEP_BYTES` — the summary
 * falls back to the raw text, and a prefix is the most of that text we can
 * honestly keep.
 */
function stubInput(inputJson: string): string {
  let parsed: unknown
  try {
    parsed = JSON.parse(inputJson)
  } catch {
    return inputJson.slice(0, INPUT_KEEP_BYTES)
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return inputJson.slice(0, INPUT_KEEP_BYTES)
  }
  const kept: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value === 'string') {
      if (value.length <= SUMMARY_VALUE_MAX || SUMMARY_KEYS.includes(key)) {
        kept[key] = value.slice(0, SUMMARY_VALUE_MAX)
      }
      continue
    }
    // Numbers, booleans and null are free; nested objects and arrays are the
    // shape a big payload hides in, so they go.
    if (value === null || typeof value === 'number' || typeof value === 'boolean') kept[key] = value
  }
  return JSON.stringify(kept)
}

/**
 * Trim what a list read carries: the newest `limit` calls whole, the rest
 * summarized.
 *
 * MEASURED, WHICH IS WHY IT EXISTS. A synthetic 600-call session with 8 KB
 * outputs and 20% writes of ~14 KB files serializes to 6.98 MB, and the
 * conversation pane re-read it on every thread open AND every turn's reconcile
 * — the wait cursor a reader sees on a click. Bounded: 0.9 MB.
 *
 * ORDERED BY THE READ, NOT RE-SORTED: `listToolCalls` returns oldest first, so
 * the newest are the tail — the same entries the history window mounts.
 * A limit of 0 (or absent) means the caller wants the lot, which is what the
 * import path and any exporter needs.
 *
 * The record is COPIED, never mutated: the store's rows are shared with the
 * caller that asked for everything, and quietly emptying one here is how a
 * payload would exist in SQLite and nowhere else. The `*Withheld` flags are set
 * only where something was actually taken away — a call that never produced an
 * output reads exactly as it always did, because "empty" and "not sent" are
 * different facts and a card must never present the second as the first.
 */
export function boundedToolCalls(
  calls: readonly ToolCallRecord[],
  limit: number | undefined,
): ToolCallRecord[] {
  if (limit === undefined || limit <= 0 || calls.length <= limit) return [...calls]
  const keepFrom = calls.length - limit
  return calls.map((call, index) => {
    if (index >= keepFrom) return call
    const trimmed: ToolCallRecord = { ...call }
    if (call.outputJson !== null) {
      trimmed.outputJson = null
      trimmed.outputWithheld = true
    }
    if (call.inputJson !== null && call.inputJson.length > INPUT_KEEP_BYTES) {
      trimmed.inputJson = stubInput(call.inputJson)
      trimmed.inputWithheld = true
    }
    return trimmed
  })
}

function toThreadSummary(
  record: ThreadRecord,
  additionalRoots: string[] = [],
  attachedWorktrees: Array<{ rootPath: string; path: string | null; branch: string | null }> = [],
): ThreadSummary {
  return {
    id: record.id,
    projectRoot: record.projectRoot,
    ...(attachedWorktrees.length === 0 ? {} : { attachedWorktrees }),
    title: record.title,
    sdkSessionId: record.sdkSessionId,
    model: record.model,
    effort: record.effort,
    status: record.status,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    archivedAt: record.archivedAt,
    imported: record.importedAt !== null,
    pinnedAt: record.pinnedAt,
    bypassPermissions: record.bypassPermissions,
    additionalRoots,
    originLoop: record.originLoop,
    originAim: record.originAim,
    originKey: record.originKey,
    parentThreadId: record.parentThreadId,
    originToolCallId: record.originToolCallId,
    worktreePath: record.worktreePath,
    worktreeBranch: record.worktreeBranch,
    worktreeBase: record.worktreeBase,
    remote: record.remote,
    remoteBranch: record.remoteBranch,
    prBase: record.prBase,
    previouslyPushedAs: record.previouslyPushedAs,
  }
}

/**
 * Register all contract-defined handlers and wire manager change events to
 * renderer broadcasts. Returns a dispose function that unregisters
 * everything (used on app shutdown).
 */
export function registerIpcHandlers(deps: IpcDependencies): () => void {
  const {
    threadStore,
    taskStore,
    integrations,
    projectRegistry,
    terminalManager,
    projectContext,
    threadScope,
    briefGenerator,
    boardLoop,
    autopilotChain,
    mergeTaskPr,
    attachmentStore,
    appSettings,
    telemetry,
    backfillSubagentThread,
    updater,
    maybeProvision,
    notifyUnreachableRoot,
    disposeTerminalsForRoot,
    forgetKnowledgeRoot,
    provisionRoot,
    answerBasicDiscovery,
    answerChatLearn,
    learnModule,
    learnFeature,
    generateFeatureView,
    learnPause,
    learnPauseRoot,
    learnStatus,
    basicDiscoveryState,
    learnLog,
    learnCancel,
    learnReset,
    brainUsage,
    brainThreadSavings,
  } = deps

  const registeredChannels: IpcInvokeChannel[] = []
  /** What `threads:setRoots` may add: a registered project root (attach-roots.ts). */
  const attachGate = createAddressableRoots({ registeredRoots: () => projectRegistry.getRoots() })

  /** Contract-typed ipcMain.handle: channel, request, and response are all
   *  checked against IpcInvokeMap, so this registry cannot drift. */
  function handle<C extends IpcInvokeChannel>(
    channel: C,
    handler: (request: IpcRequest<C>) => IpcResponse<C> | Promise<IpcResponse<C>>,
  ): void {
    registeredChannels.push(channel)
    ipcMain.handle(channel, (_event, request: IpcRequest<C>) => timed(channel, handler)(request))
  }

  // ── threads ──────────────────────────────────────────────────────────
  handle('threads:list', ({ projectRoot, includeArchived, limit, includeChildren }) => {
    const records = threadStore.listThreads(projectRoot, { includeArchived, limit, includeChildren })
    // ONE roots read for the whole page, not one per row — the N+1 that re-fired
    // on every visible threads:updated batch (allowed-pattern #18).
    const roots = threadStore.getThreadRootsBatch(records.map((record) => record.id))
    return records.map((record) => toThreadSummary(record, roots.get(record.id) ?? []))
  })
  // Promoted sub-agent child threads of a parent, for sidebar nesting (#1931).
  handle('threads:children', ({ parentThreadId }) => {
    const records = threadStore.listChildThreads(parentThreadId)
    const roots = threadStore.getThreadRootsBatch(records.map((record) => record.id))
    return records.map((record) => toThreadSummary(record, roots.get(record.id) ?? []))
  })
  // Promote a sub-agent to a navigable child thread (create-or-return), re-homing
  // its persisted rows into the child so the pane can switch to it (#1931). A
  // child with NOTHING to re-home (a run predating the capture, or one whose
  // internals never reached this process) is backfilled from SDK session
  // storage before answering, so the renderer never switches to an empty child
  // that has a recoverable transcript.
  handle('threads:openSubagent', async ({ parentThreadId, toolCallId }) => {
    const record = threadStore.openSubagentThread(parentThreadId, toolCallId)
    if (backfillSubagentThread) await backfillSubagentThread(record.id)
    return toThreadSummary(record, threadStore.getThreadRoots(record.id))
  })
  // A SUMMARY, NOT A TRANSCRIPT. This is the composer's re-read on every
  // thread-entity event of a streaming turn — measured at 1,306 KB and 14ms per
  // call on an 1,800-call thread, to answer a question about three fields. It
  // had been bounded twice already (2.74 MB of messages, then the tool
  // outputs), which is twice that a payload nobody read was made smaller
  // instead of absent. The pane fetches its own window from messages:list /
  // toolCalls:list — that is where a transcript belongs.
  handle('threads:get', ({ threadId }) => {
    const record = threadStore.getThread(threadId)
    if (!record) return null
    // The one reader that needs per-project checkouts — the worktree panel asks
    // through here. The list paths stay on the cheap shape they had.
    return toThreadSummary(
      record,
      threadStore.getThreadRoots(threadId),
      threadStore.getThreadRootWorktrees(threadId).map((entry) => ({
        rootPath: entry.rootPath,
        // THE PATH IS THE ANSWER TO "HAS A COPY", and dropping it here is what
        // made the panel ask about the branch instead.
        path: entry.worktreePath === '' ? null : entry.worktreePath,
        branch: entry.branch,
      })),
    )
  })
  handle(
    'threads:create',
    ({ projectRoot, title, model, effort, additionalRoots, originLoop, originAim, originKey }) => {
      // The persisted model+effort preference (#848) is applied INSIDE
      // ThreadStore.createThread — the one code path every creator shares
      // (#885 found task threads and imports bypassing a handler-level check).
      const thread = threadStore.createThread({
        projectRoot,
        title,
        model,
        effort,
        // A run's provenance, passed straight through: the renderer that
        // pressed Run is the only place that knows which loop it pressed for.
        ...(originLoop === undefined ? {} : { originLoop }),
        ...(originAim === undefined ? {} : { originAim }),
        ...(originKey === undefined ? {} : { originKey }),
      })
      const extras = additionalRoots ?? []
      if (extras.length > 0) {
        threadStore.setThreadRoots(thread.id, extras)
      }
      // WHICH RUNTIMES PEOPLE ACTUALLY USE. The two facts that make this worth
      // counting are the provider and the model; the title, the project and the
      // roots are none of telemetry's business and cannot be passed — the
      // event's shape does not have anywhere to put them.
      // A thread carries a MODEL; the runtime it runs under is resolved from
      // settings, not stored on the record — so it is read from the same place
      // the thread itself will read it.
      const runtime = appSettings?.getDefaultProvider() ?? null
      telemetry?.record('thread.created', {
        at: Date.now(),
        ...(runtime === null ? {} : { provider: runtime }),
        ...(thread.model === null ? {} : { model: thread.model }),
      })
      return toThreadSummary(thread, threadStore.getThreadRoots(thread.id))
    },
  )
  handle('threads:update', ({ threadId, patch }) => {
    const summary = toThreadSummary(threadStore.updateThread(threadId, patch))
    // #1447: a task and its 1:1 chat are ONE object with ONE name. `tasks:update`
    // already mirrors a rename onto the thread; this is the missing other
    // direction. Without it, renaming the chat — which is what the sidebar
    // offers as soon as a search flattens a task into an ordinary thread row
    // (#1061) — wrote the thread only, so the board card, the detail modal and
    // the idle sidebar row all kept the OLD name and the typed one appeared
    // nowhere. The object carried two names permanently, and search could not
    // find the chat by the name its own row was displaying.
    //
    // Guarded on a real change so a patch that merely restates the title does
    // not bump the board's sort clock and yank the card up a lane (#1192).
    if (patch.title !== undefined) {
      syncTaskTitleFromThread({ taskStore }, threadId, patch.title)
    }
    return summary
  })
  // Replace a thread's additional context roots (#695). setThreadRoots dedupes and
  // drops the primary, so the agent's next turn reads the new additionalDirectories.
  handle('threads:setRoots', ({ threadId, roots }) => {
    const thread = threadStore.getThread(threadId)
    if (!thread) {
      throw new Error(`[Threads] Cannot set roots on unknown thread: ${threadId}`)
    }
    // Only projects Flow knows may be ADDED: an attached root becomes a folder
    // a runtime may write. The registered-roots gate, with no worktree widening.
    const checked = checkAttachRoots(roots, threadStore.getThreadRoots(threadId), attachGate)
    if (!checked.ok) {
      throw new Error(`[Threads] Cannot attach ${checked.refused.length} folder(s) that are not open projects`)
    }
    threadStore.setThreadRoots(threadId, checked.roots)
    return toThreadSummary(thread, threadStore.getThreadRoots(threadId))
  })
  handle('threads:delete', ({ threadId }) => {
    // A task owns exactly one thread. The FK already nulls task.thread_id on
    // delete, but silently — no task change event — so every task surface kept a
    // cached task pointing at the DEAD id and dispatched flow:open-thread for a
    // thread that no longer existed (#1061). Unlink explicitly first so the
    // unlink rides out on tasks:updated.
    //
    // THE THREAD'S COPY IS NOT RELEASED HERE, deliberately. The sidebar's own
    // delete flow already does it (`#delete` → `threads:releaseWorktree`),
    // gated by the same `threadDeleteNotice` that writes the sentence a person
    // reads. A second release in this handler would be one rule in two layers
    // (allowed-pattern #14) — and the notice, not this handler, is what knows
    // whether anything would be lost.
    taskStore.clearThread(threadId)
    threadStore.deleteThread(threadId)
  })
  handle('threads:search', ({ query, projectRoot }) => {
    const records = threadStore.searchThreads(query, projectRoot)
    // Same batched roots read as threads:list — one query, not one per match.
    const roots = threadStore.getThreadRootsBatch(records.map((record) => record.id))
    return records.map((record) => toThreadSummary(record, roots.get(record.id) ?? []))
  })
  // Import a project's Claude Code CLI sessions as threads. The reader path is
  // derived in main from the validated rootPath (never a renderer file path);
  // dedup makes repeated calls no-ops without reading any transcript, and the
  // import itself is async so large stores don't freeze the main process
  // (#1667). ThreadStore change events flow to the renderer through the
  // existing threads:updated broadcast.
  handle('threads:importClaude', ({ rootPath }) =>
    importClaudeSessions(threadStore, rootPath),
  )
  // Estimated tokens saved by knowledge search across one thread (the
  // conversation pane's cumulative brain chip). Fail-soft: no dep → zero.
  handle('threads:brainSavings', async ({ threadId }) => {
    // #1280: the no-dep answer carries the provenance fields too — an
    // uncalibrated zero, which is exactly what "no estimator" means.
    if (!brainThreadSavings) {
      return { savedTokens: 0, rootSavedTokens: 0, calibrated: false, hits: 0 }
    }
    return brainThreadSavings(threadId)
  })

  // ── tasks ────────────────────────────────────────────────────────────
  handle('tasks:list', ({ projectRoot, includeArchived }) =>
    taskStore.listTasks(projectRoot, { includeArchived }).map(toTaskSummary),
  )
  handle('tasks:create', ({ projectRoot, title, description, additionalRoots }) =>
    toTaskSummary(
      createManualTask(
        { taskStore, threadStore },
        { projectRoot, title, description, additionalRoots },
      ),
    ),
  )
  handle('tasks:importIssue', async ({ projectRoot, keyOrUrl, additionalRoots }) => {
    const { task, created } = await createTaskFromIssue(
      { taskStore, threadStore, integrations },
      { projectRoot, keyOrUrl, additionalRoots },
    )
    // A freshly imported issue/PR gets a technical brief in the background — the
    // modal shows it (and its `pending` state) via tasks:updated. Fire-and-forget.
    if (created && taskHasBriefContent(task)) {
      // Fire-and-forget: generateTaskBrief never throws, but keep a defensive
      // .catch so no future change can leak an unhandled rejection here (#114).
      void generateTaskBrief({ taskStore, briefGenerator }, task.id).catch(() => {})
    }
    return { task: toTaskSummary(task), created }
  })
  // The run record for an item the board already read (FR-7). Same store, same
  // dedup, same background brief as the importer above — the ONLY difference is
  // that the issue's facts arrive in the request instead of being refetched, so
  // a ledger queue (no tracker to fetch from) and a GitHub queue on a machine
  // with no token both end up with the record their claim earned.
  handle('tasks:createFromQueueItem', (request) => {
    // The ticked projects become the thread's attached roots — the same gate
    // `threads:setRoots` applies, since an attached root is a folder the
    // session may write.
    const asked = request.additionalRoots ?? []
    const checked = checkAttachRoots(asked, [], attachGate)
    if (!checked.ok) {
      throw new Error(`Cannot attach ${checked.refused.length} folder(s) that are not open projects`)
    }
    const { task, created } = createTaskFromQueueItem(
      { taskStore, threadStore },
      { ...request, ...(asked.length === 0 ? {} : { additionalRoots: checked.roots }) },
    )
    if (created && request.projectsChosen === true && appSettings !== undefined) {
      rememberChosenProjects(taskProjectsRecord(appSettings), task.id, checked.roots)
      // The board re-reads a card's projects on this (as for any card's projects).
      broadcast('workspaces:changed', { cause: 'task-projects' })
    }
    if (created && taskHasBriefContent(task)) {
      // Fire-and-forget, defensively caught — same contract as the import path.
      void generateTaskBrief({ taskStore, briefGenerator }, task.id).catch(() => {})
    }
    return { task: toTaskSummary(task), created }
  })
  // A card's "Change": the projects of a task whose chat has not started.
  handle('tasks:setProjects', ({ taskId, roots }) => {
    if (appSettings === undefined) throw new Error("This build of Flow cannot change a task's projects")
    if (!Array.isArray(roots) || roots.length === 0) throw new Error('Choose at least one project for this task.')
    const existing = taskStore.getTask(taskId)
    const carried = existing === null ? [] : [existing.projectRoot]
    const checked = checkAttachRoots(roots, carried, attachGate)
    if (!checked.ok) {
      throw new Error(`Cannot use ${checked.refused.length} folder(s) that are not open projects`)
    }
    const { task, additionalRoots } = chooseTaskProjects(
      { taskStore, threadStore, projects: taskProjectsRecord(appSettings) },
      { taskId, roots: checked.roots },
    )
    broadcast('workspaces:changed', { cause: 'task-projects' })
    return { task: toTaskSummary(task), additionalRoots }
  })
  // START / STOP / READ. One channel for all three because they are one
  // question — what is this project's loop doing — and a surface that could ask
  // it two ways would eventually get two answers.
  handle('tasks:boardLoop', async ({ projectRoot, run }) => {
    const status =
      run === undefined
        ? boardLoop.status(projectRoot)
        : run
          ? await boardLoop.start(projectRoot)
          : boardLoop.stop(projectRoot)
    return { projectRoot, ...status }
  })
  // START / END / READ, one channel for all three because they are one question
  // — what is this conversation's chain doing — and a surface that could ask it
  // two ways would eventually get two answers. Omitting `run` READS: drawing the
  // state must never be able to start a chain.
  handle('flow:chain', async ({ threadId, run, aim }) => {
    if (autopilotChain === undefined) {
      return {
        threadId,
        running: false,
        step: null,
        waitingOnYou: false,
        stoppedReason: null,
        prUrl: null,
        notPublished: null,
      }
    }
    if (run === undefined) return autopilotChain.status(threadId)
    // `run: false` ends it and leaves the thread exactly where it is. No reason
    // is recorded: a person's own gesture needs no explanation, and inventing
    // one would put words in their mouth on a surface they are reading.
    return run ? await autopilotChain.begin(threadId, { aim }) : autopilotChain.end(threadId)
  })
  handle('tasks:update', ({ taskId, patch }) => {
    // The one update path (task-service.applyTaskUpdate): the same code the board
    // tools call, so a card moved from the chat agent triggers exactly what a
    // card dragged in the UI does. The three side effects — thread-title sync,
    // brief-on-activation, close-remote-on-done — live there now, wired here to
    // the real AppSettingsStore, IntegrationsManager and flow:notification.
    const record = applyTaskUpdate(
      {
        taskStore,
        threadStore,
        briefGenerator,
        closeRemote: {
          isEnabled: () => appSettings?.getCloseRemoteOnDone() ?? false,
          closeIssue: (ref, opts) => integrations.closeIssue(ref, opts),
          notify: ({ rootId, title, body, level }) =>
            broadcast('flow:notification', {
              kind: 'state-change',
              rootId,
              title,
              body,
              level,
              timestamp: new Date().toISOString(),
            }),
        },
      },
      taskId,
      patch,
    )
    return toTaskSummary(record)
  })
  handle('tasks:mergePr', async ({ taskId }) => {
    // Absent dependency (a headless harness) → nothing merges, and that is said
    // rather than pretended. The merge itself, the Done move and the Review-card
    // resolution all live behind this one closure (built in index.ts) so the
    // handler stays a thin relay.
    if (mergeTaskPr === undefined) {
      return { ok: false, detail: 'Flow can’t merge pull requests from here.' }
    }
    return mergeTaskPr(taskId)
  })
  handle('tasks:delete', ({ taskId }) => {
    // TaskStore returns the linked thread id so deletion of the thread (and its
    // cascade + change events) stays authoritative in ThreadStore.
    const { threadId } = taskStore.deleteTask(taskId)
    if (threadId) threadStore.deleteThread(threadId)
    // The card's extra Workspace projects live in a settings row (no schema
    // change — see app-settings-store.ts); it goes with the card.
    appSettings?.forgetTaskExtraProjects(taskId)
  })
  // Recovery for a task whose 1:1 chat was deleted from the sidebar (#1061):
  // attach a fresh thread so "Open chat" reaches a conversation instead of being
  // a dead click with no in-app way out. Idempotent for a healthy task.
  handle('tasks:ensureThread', ({ taskId }) =>
    toTaskSummary(ensureTaskThread({ taskStore, threadStore }, taskId)),
  )
  handle('tasks:generateBrief', async ({ taskId }) => {
    const record = await generateTaskBrief({ taskStore, briefGenerator }, taskId)
    if (!record) throw new Error(`Task no longer exists: ${taskId}`)
    return toTaskSummary(record)
  })

  // ── integrations (Jira / GitHub, read-only via stored PAT) ───────────
  handle('integrations:setToken', async (secrets) => {
    // Await: setToken now verifies the credential before storing (#1503), and a
    // refusal must reach the renderer as the rejection it catches — not die in
    // main as an unhandled rejection while the panel paints success.
    await integrations.setToken(secrets)
  })
  handle('integrations:status', async ({ provider }) => ({
    provider,
    ...(await integrations.status(provider)),
  }))
  handle('integrations:clearToken', ({ provider }) => {
    integrations.clearToken(provider)
  })
  // FAIL-SOFT BY CONTRACT: the board draws this, and a rejected promise there
  // would be an empty column where a reason belongs. Every failure — no token,
  // an expired one, a tracker that could not be reached — comes back as its own
  // sentence on `reason`, which is the string the column shows verbatim.
  handle('integrations:assigned', async ({ provider }) => {
    try {
      // The mode + custom query are a GLOBAL, non-secret preference in
      // app_settings; a build wired without that store (or a provider never
      // configured) reads the historical default — assigned, no query.
      const options = appSettings?.getIssueListConfig(provider) ?? { mode: 'assigned', query: '' }
      return {
        ok: true,
        provider,
        items: await integrations.listAssigned(provider, options),
        reason: null,
      }
    } catch (error) {
      return {
        ok: false,
        provider,
        items: [],
        reason: error instanceof Error ? error.message : String(error),
      }
    }
  })
  // The board selector and the settings query field both read/write this. When
  // no app-settings store is wired, reads answer the default and writes are a
  // no-op that echoes it back — the column keeps working as assigned-only.
  handle('integrations:getListConfig', ({ provider }) =>
    appSettings?.getIssueListConfig(provider) ?? { mode: 'assigned', query: '' },
  )
  handle('integrations:setListConfig', ({ provider, mode, query }) =>
    appSettings?.setIssueListConfig(provider, { mode, query }) ?? {
      mode: mode ?? 'assigned',
      query: query ?? '',
    },
  )
  // Whether moving a promoted tracker card to Done closes the remote ticket
  // (#1885). Default ON — an app with no settings store reads the same default the
  // store would, so the Settings toggle and the tasks:update gate never disagree.
  handle('integrations:getCloseOnDone', () => ({
    enabled: appSettings?.getCloseRemoteOnDone() ?? true,
  }))
  handle('integrations:setCloseOnDone', ({ enabled }) => {
    appSettings?.setCloseRemoteOnDone(enabled)
    return { enabled: appSettings?.getCloseRemoteOnDone() ?? enabled }
  })
  // WHAT THE TYPED QUERY WOULD RETURN — a save-time preview count. FAIL-SOFT
  // like `assigned`: a settings field draws this, and a rejected promise there
  // would be a broken frame where a count belongs.
  handle('integrations:previewList', async ({ provider, query }) => {
    try {
      const items = await integrations.previewList(provider, query)
      return {
        ok: true,
        count: items.length,
        sample: items
          .slice(0, 3)
          .map((issue) => issue.title)
          .filter((title) => title.length > 0),
        reason: null,
      }
    } catch (error) {
      return {
        ok: false,
        count: 0,
        sample: [],
        reason: error instanceof Error ? error.message : String(error),
      }
    }
  })
  // FAIL-SOFT, for the same reason `assigned` is: a card draws this, and a
  // rejected promise there would be a broken frame where a sentence belongs.
  handle('integrations:imageData', async ({ provider, url }) => {
    try {
      const { dataUri, bytes } = await integrations.imageData(provider, url)
      return { ok: true, dataUri, bytes, reason: null }
    } catch (error) {
      return {
        ok: false,
        dataUri: null,
        bytes: 0,
        reason: error instanceof Error ? error.message : String(error),
      }
    }
  })
  // threads:setModel is registered by the agent IPC module
  // (src/main/agent/ipc.ts) — it persists via ThreadStore AND applies the
  // model to the live SDK session. threads:update still patches model/effort
  // through the store only.

  // ── messages / tool calls ────────────────────────────────────────────
  handle('messages:list', ({ threadId, limit }) =>
    // Merge image attachments (#456) onto each message; only user messages carry
    // them, and `listForMessage` is empty for the rest, so this stays cheap.
    threadStore.listMessages(threadId, limit === undefined ? {} : { limit }).map((message) => {
      const attachments = attachmentStore.listForMessage(message.id)
      return attachments.length > 0 ? { ...message, attachments } : message
    }),
  )

  // ── attachments (#456) ───────────────────────────────────────────────
  handle('attachments:read', ({ attachmentId }) => attachmentStore.read(attachmentId))
  // #1063 — reveal a persisted attachment in the OS file manager. The store
  // resolves the id to an absolute path confined to the attachments root; a bad
  // or unknown id yields null and the reveal is a quiet no-op.
  handle('attachments:revealPath', ({ attachmentId }) => {
    const absolute = attachmentStore.absolutePath(attachmentId)
    if (absolute) shell.showItemInFolder(absolute)
  })
  handle('attachments:captureScreen', async () => {
    if (!isCaptureSupported(process.platform)) return null
    return captureScreenRegion()
  })

  // ── browser (embedded <webview> tab) ─────────────────────────────────────
  // The controller tracks the guest via `did-attach-webview`; init() registers
  // that listener now, before the main window is created (see controller.ts).
  // Its bufferUpdated/tagPosted emitters are wired to `broadcast` for Phase 5/6,
  // which fills in the real capture/tag/buffer path — the stubs below let every
  // browser:* handler register and the contract typecheck today.
  browserController.init()
  browserController.setBroadcast({
    bufferUpdated: (payload) => broadcast('browser:bufferUpdated', payload),
    tagPosted: (payload) => broadcast('browser:tagPosted', payload),
  })
  handle('browser:navigate', ({ url }) => browserController.navigate(url))
  handle('browser:back', () => browserController.back())
  handle('browser:forward', () => browserController.forward())
  handle('browser:reload', () => browserController.reload())
  handle('browser:setInspect', ({ on }) => browserController.setInspect(on))
  handle('browser:capabilities', () => browserController.capabilities())
  handle('browser:captureScreenshot', () =>
    captureScreenshot(browserController.currentGuest()),
  )
  handle('browser:tagRecent', ({ kind, window }) => browserController.tagRecent(kind, window))
  handle('browser:tagEntry', ({ kind, id }) => browserController.tagEntry(kind, id))
  handle('browser:bufferSlice', ({ kind, selector }) =>
    browserController.bufferSlice(kind, selector),
  )
  handle('browser:clearCaptures', () => browserController.clearCaptures())

  // ── Debug session ─────────────────────────────────────────────────────────
  //
  // ONE WINDOW ACROSS TWO WORLDS. The recorder owns the window's rules and
  // knows nothing about Electron; `makeDebugSessionDeps` hands it this app's
  // terminals, browser buffer and thread scope. The handlers below are the only
  // place the two meet.
  const debugRecorder = new DebugSessionRecorder(
    makeDebugSessionDeps({
      terminals: terminalManager,
      browser: browserController,
      // THE CONVERSATION'S SCOPE, which the scope manager owns — a thread
      // record carries one `projectRoot` and knows nothing about the other
      // projects the conversation spans.
      scopeRoots: () => (threadScope?.current().roots ?? []).map((root) => root.rootPath),
      activeProjectRoot: () => projectContext.activeRoot(),
    }),
  )

  /** A live session, shrunk to what a control can draw (allowed-pattern #18). */
  const debugSummary = (): DebugSessionSummary | null => {
    const status = debugRecorder.status()
    if (status === null) return null
    return {
      id: status.id,
      threadId: status.threadId,
      startedAt: status.startedAt,
      terminals: status.terminals.map((terminal) => terminal.label),
      records: status.records,
    }
  }

  /**
   * WHICH CONVERSATION A SESSION BELONGS TO — resolved HERE, not taken from the
   * renderer.
   *
   * The first cut trusted a `threadId` the renderer tracked by listening for
   * `flow:open-thread`. That event is dispatched only by TASK surfaces opening
   * a task's chat; clicking a thread in the sidebar — the way a person actually
   * selects one — never fires it. So the id was null in normal use, nothing was
   * posted to the conversation, and the feature looked dead (user, 2026-09-21:
   * "nothing happens... not seeing nothing being added to the context").
   *
   * Main already knows: `ProjectContext.activeThreadId` is persisted as "last
   * thread selected in this project", written on the real selection path. A
   * caller may still pass an id — a surface that genuinely knows better, like a
   * task view — and it wins; otherwise this answers.
   */
  const threadForSession = (fromRenderer: string | null): string | null => {
    if (fromRenderer !== null) return fromRenderer
    return projectContext.getActiveProject()?.activeThreadId ?? null
  }

  handle('debug:start', ({ threadId }) => {
    debugRecorder.start(threadForSession(threadId))
    // The guest records what the person DOES only while a session is live.
    browserController.setRecording(true)
    return debugSummary() as DebugSessionSummary
  })

  handle('debug:status', () => {
    // ASKED, NOT TIMED: a session that has outlived its ceiling stops here,
    // on the next question anyone asks about it, rather than on a timer in main
    // that is a thing to leak and a thing to test with fake clocks.
    if (debugRecorder.expired()) void stopDebugSession('capped')
    return debugSummary()
  })

  handle('debug:interaction', ({ kind, at, target, url }) => {
    // Dropped when nothing is recording — the recorder's own rule. An
    // interaction outside the window is not part of the reproduction.
    debugRecorder.interaction({
      source: 'interaction',
      at,
      target,
      kind,
      ...(url === undefined ? {} : { url }),
    })
  })

  handle('debug:stop', () => stopDebugSession('finished'))

  async function stopDebugSession(
    end: 'finished' | 'capped',
  ): Promise<DebugStopResult | null> {
    const result = debugRecorder.stop(end)
    browserController.setRecording(false)
    if (result === null) return null

    // OFF THE PATH EVERY WINDOW WAITS ON (NFR-4). Merging, redacting and
    // writing a session's records is not work to do between two IPC calls.
    //
    // INTO THE PROJECT THE SESSION BELONGS TO — see `debug-artifact.ts` for why
    // it is no longer in userData (nothing there can be opened).
    //
    // The THREAD's root first, and the active project only when a session had
    // no thread. Those are usually the same, and when they are not, "wherever
    // the app is pointing" is the wrong answer: a session recorded for a
    // conversation belongs with that conversation's project.
    const threadRoot =
      result.threadId === null
        ? null
        : (threadStore.getThread(result.threadId)?.projectRoot ?? null)
    const root = threadRoot ?? projectContext.activeRoot()
    const artifact = root === null ? null : await writeDebugArtifact(result, root)
    const summary = artifact?.summary ?? summaryText(result, null)

    // NOT APPENDED AS A MESSAGE. It was, and a real session's summary filled
    // the conversation with an unreadable wall — a transcript is for the
    // conversation, and a recording is a REFERENCE to attach (user,
    // 2026-09-21). The renderer turns this result into a context chip and opens
    // the file, which is what `flow:add-to-chat` and `flow:open-file-path` are
    // for and neither can be driven from main.
    // HOW LONG AND HOW BIG, and nothing else. A debug session's whole content
    // is terminal output, network traffic and page interactions — the most
    // sensitive material this app holds — so what is counted here is the
    // recording's SHAPE. The event has nowhere to put anything else.
    telemetry?.record('debug.session.finished', {
      at: Date.now(),
      durationMs: result.endedAt - result.startedAt,
      count: result.records.length,
    })

    return {
      artifactDir: artifact?.dir ?? null,
      // THE SHORT ONE. The timeline is the source of truth and is cited from
      // inside it; what opens, and what the chip points at, is the summary.
      timelinePath: artifact?.summaryRelPath ?? null,
      projectRoot: artifact?.projectRoot ?? null,
      summary,
      records: result.records.length,
      end: result.end,
    }
  }

  handle('messages:append', ({ threadId, role, content }) =>
    threadStore.appendMessage(threadId, role, content),
  )
  // THE HEAVIEST READ IN THE APP, BOUNDED. A thread's tool outputs are its bulk
  // — measured 4.96 MB for 600 calls at 8 KB each — and the renderer mounts a
  // window of the newest entries, so shipping every older output is paid for
  // and thrown away. The newest `outputLimit` keep theirs; the rest say they
  // were withheld, and a card fetches its own when the reader opens it.
  handle('toolCalls:list', ({ threadId, outputLimit, since, atLeast }) =>
    // The bound goes into the QUERY, not just the answer: the old shape read
    // 6.51 MB of blobs out of SQLite to hand back 815 KB, on the process every
    // window waits behind. boundedToolCalls still runs — it owns the input
    // summarization, and it is the one place that decides what "withheld"
    // means for a caller that passed no limit at all.
    boundedToolCalls(
      threadStore.listToolCalls(threadId, {
        ...(outputLimit === undefined ? {} : { outputLimit }),
        ...(since === undefined ? {} : { since }),
        ...(atLeast === undefined ? {} : { atLeast }),
      }),
      outputLimit,
    ),
  )
  handle('toolCalls:get', ({ threadId, toolCallId }) =>
    threadStore.getToolCall(threadId, toolCallId),
  )
  // A sub-agent's transcript (#1931): messages + tool calls captured under the
  // parent Task tool call, outputs withheld like toolCalls:list.
  handle('threads:subagentTranscript', ({ threadId, toolCallId, outputLimit }) => ({
    messages: threadStore.listSubagentMessages(threadId, toolCallId),
    toolCalls: threadStore.listSubagentToolCalls(threadId, toolCallId, {
      ...(outputLimit === undefined ? {} : { outputLimit }),
    }),
  }))

  // ── project ──────────────────────────────────────────────────────────
  /** The Workspace a new project joins, as the renderer named it — a slug, or nothing. */
  const workspaceOption = (workspace: unknown): { workspace?: string } =>
    typeof workspace === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(workspace) && workspace.length <= 64
      ? { workspace }
      : {}
  // Adding a root also ENTERS it when nothing is active yet, so opening your
  // first project actually activates it (#382). Shared by both add paths so the
  // invariant lives in one place (see add-root.ts).
  const addRootPorts = {
    addRoot: (rootPath: string) => projectRegistry.addRoot(rootPath),
    activeRoot: () => projectContext.activeRoot(),
    setActiveProject: (rootPath: string) => {
      projectContext.setActiveProject(rootPath)
    },
  }
  /**
   * Hand the active project to a surviving root after `rootPath` leaves the
   * sidebar, then forget its state (#1080). Order matters: activating the
   * survivor FIRST moves `#activeRoot` off the removed path, so `forget()` no
   * longer has to emit the "no project" null — the app never passes through an
   * empty state on the way to a perfectly good sibling, and the survivor is
   * PERSISTED (setActiveProject stamps last_active_at) so the next launch lands
   * there too. Main-side rather than per-surface, so removal via the sidebar
   * menu, the palette or a future surface all behave identically (#14).
   */
  const handOffActiveProject = (rootPath: string): void => {
    if (projectContext.activeRoot() === rootPath) {
      const survivor = nextActiveRootAfterRemove(projectRegistry.getRoots(), rootPath)
      if (survivor !== null) projectContext.setActiveProject(survivor)
    }
    projectContext.forget(rootPath)
  }
  // Availability is re-evaluated on every roots() read (#1118): a stat per root
  // is cheap, and it means no surface can render a project as healthy after its
  // folder was moved/deleted/unmounted mid-session. refreshAvailability emits
  // rootsChanged only on an actual transition, so this can't loop.
  handle('project:list', () => {
    projectRegistry.refreshAvailability()
    return projectRegistry.getRoots()
  })
  handle('project:add', ({ path, workspace }) => {
    const root = addRootAndMaybeActivate(addRootPorts, path)
    // Fire-and-forget: keep this project scaffolded for the bundled CLI without
    // blocking the addRoot response (ide-auto-provisioning), then put it in its
    // Workspace.
    maybeProvision?.(root.rootPath, workspaceOption(workspace))
    return root
  })
  handle('project:pickFolder', async () => {
    // Dialog only — NO root added, NOTHING activated. The caller decides what
    // to do with the path (thread context-roots Browse…).
    const parent =
      BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null
    const options: Electron.OpenDialogOptions = {
      title: 'Add Folder to Context',
      properties: ['openDirectory', 'createDirectory'],
    }
    const result = parent
      ? await dialog.showOpenDialog(parent, options)
      : await dialog.showOpenDialog(options)
    const picked = result.filePaths[0]
    return result.canceled || !picked ? null : picked
  })
  handle('project:open', async ({ path, workspace }) => {
    // `path` pre-resolved = the pick already happened (e2e drives the real
    // post-pick path this way; the native dialog is invisible to Playwright).
    let picked = path ?? null
    if (picked === null) {
      const parent =
        BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null
      const options: Electron.OpenDialogOptions = {
        title: 'Open Project',
        properties: ['openDirectory', 'createDirectory'],
      }
      const result = parent
        ? await dialog.showOpenDialog(parent, options)
        : await dialog.showOpenDialog(options)
      const chosen = result.filePaths[0]
      if (result.canceled || !chosen) {
        return null
      }
      picked = chosen
    }
    // addRoot dedupes an already-present root and emits rootsChanged, which the
    // file tree and thread sidebar listen for; `always` fires activeProjectChanged
    // so the titlebar, tree, editor and terminals rebind. FOREGROUND open: the
    // user named this project, so entering it IS the action — under the
    // background-add guard, picking an already-open folder was a total no-op
    // (#1008), and picking a new one while the sidebar was hidden gave no
    // feedback at all.
    const root = addRootAndMaybeActivate(addRootPorts, picked, 'always')
    maybeProvision?.(root.rootPath, workspaceOption(workspace)) // fire-and-forget (ide-auto-provisioning)
    return root
  })
  handle('project:reorderRoots', ({ orderedPaths }) =>
    projectRegistry.reorderRoots(orderedPaths),
  )
  handle('project:remove', ({ rootPath }) => {
    // Cascade: delete the project's tasks + threads, drop the root, forget its
    // context — so a project with threads actually leaves the sidebar.
    removeProject(
      {
        threadStore,
        taskStore,
        removeRoot: (path) => projectRegistry.removeRoot(path),
        // #1484: the project's shells go with it. Without this they keep running
        // — invisible with another project open, a ghost tab without one.
        disposeTerminals: disposeTerminalsForRoot,
      },
      rootPath,
    )
    // The flat file list goes with it. A cached walk of a directory this app no
    // longer manages is a snapshot nothing will ever invalidate.
    forgetListAllCache(rootPath)
    // …and its cached content searches, for the same reason.
    forgetContentSearchCache(rootPath)
    // …and anything Flow held about its place in a Workspace.
    forgetKnowledgeRoot(rootPath)
    handOffActiveProject(rootPath)
  })
  handle('project:listDir', ({ rootPath, relPath }) =>
    projectRegistry.listDirectory(rootPath, relPath),
  )
  handle('project:listCommands', ({ rootPath }) => projectRegistry.listCommands(rootPath))

  // ── project context (ADR-002) ────────────────────────────────────────
  handle('project:active', () => projectContext.getActiveProject())
  handle('project:setActive', ({ rootPath }) => {
    // Switching projects is a natural "re-read the world" moment, and the
    // cheapest place to catch a folder that vanished mid-session (#1118).
    projectRegistry.refreshAvailability()
    // Backstop for every activation surface: binding the app to a directory
    // that isn't there produces an empty, silently-erroring window (#974).
    // The renderer marks such rows inert, but the invariant lives here so no
    // surface can opt out — and it's NOT a silent refusal: the caller is told
    // where it actually landed, and the user gets a toast naming the problem.
    const decision = resolveActiveRoot(projectRegistry.getRoots(), rootPath)
    if (decision.reason !== 'requested') {
      console.warn(`[Project] Refusing to activate unreachable root: ${rootPath}`)
      notifyUnreachableRoot?.(rootPath)
      return projectContext.getActiveProject()
    }
    // Activating a project is also a provisioning trigger — a stale project
    // heals the moment the user opens it (fire-and-forget; ide-auto-provisioning).
    maybeProvision?.(rootPath)
    return projectContext.setActiveProject(rootPath)
  })
  handle('project:saveOpenFiles', ({ rootPath, openFiles, activeFile, dirtyBuffers }) => {
    projectContext.saveOpenFiles(rootPath, openFiles, activeFile, dirtyBuffers)
  })
  // Per-conversation tab sets: each thread keeps its own tabs, the project
  // keeps its own while no thread is selected.
  handle('project:loadTabSet', ({ rootPath, threadId }) =>
    projectContext.loadTabSet(rootPath, threadId),
  )
  handle('project:saveTabSet', ({ rootPath, threadId, openFiles, activeFile, dirtyBuffers, openViews }) => {
    projectContext.saveTabSet(rootPath, threadId, { openFiles, activeFile, dirtyBuffers, openViews })
  })
  // Per-scope shells — read-only here; main persists them itself as shells
  // open, close and exit (terminal/shell-persistence.ts).
  handle('project:loadScopeTerminals', ({ rootPath, threadId }) =>
    projectContext.loadScopeTerminals(rootPath, threadId),
  )
  // #1443: the renderer says its hot-exit state is persisted, so teardown may
  // proceed. Resolving the waiter is all this does — the write itself came
  // through project:saveOpenFiles just above.
  handle('project:editorContextFlushed', () => {
    notifyEditorContextFlushed()
  })
  handle('project:setActiveThread', ({ rootPath, threadId }) => {
    projectContext.setActiveThread(rootPath, threadId)
  })
  // Thread scope (multi-project threads): the invoke is the snapshot pair of
  // the threadScopeChanged push below. Empty scope when no manager is wired.
  handle('project:getThreadScope', () =>
    threadScope ? threadScope.current() : { threadId: null, roots: [] },
  )
  // User accent override (sidebar color picker). One write path — the manager
  // persists, mirrors in memory, and emits rootsChanged; the scope manager
  // re-derives off that event, so threadScopeChanged fans out too.
  handle('project:setRootAccent', ({ rootPath, color }) =>
    projectRegistry.setRootAccent(rootPath, color),
  )
  handle('project:provisionRoot', async ({ rootPath }) => {
    await provisionRoot?.(rootPath)
  })

  // ── learn (progressive-learning #513) ────────────────────────────────
  handle('learn:answerBasicDiscovery', ({ rootId, answer }) => {
    answerBasicDiscovery?.(rootId, answer)
  })
  handle('learn:answerChatLearn', ({ rootId, modulePath, answer }) => {
    answerChatLearn?.(rootId, modulePath, answer)
  })
  handle('learn:generateFeatureView', (request) => {
    generateFeatureView?.(request)
    return Promise.resolve()
  })

  handle('learn:learnFeature', (request) => {
    learnFeature?.(request)
    return Promise.resolve()
  })

  handle('learn:learnModule', ({ rootId, modulePath }) => {
    learnModule?.(rootId, modulePath)
  })
  // ASKED, NOT INFERRED — see the channel's contract note.
  handle('learn:log', () => ({ entries: learnLog?.() ?? [] }))
  handle('learn:basicDiscoveryState', ({ roots }) => basicDiscoveryState?.(roots) ?? {})
  handle('learn:status', () =>
    learnStatus?.() ?? {
      running: false,
      paused: false,
      activeModule: null,
      activeRoot: null,
      queued: 0,
      startedAt: null,
    },
  )
  handle('learn:pause', ({ paused }) => {
    learnPause?.(paused)
    return { ok: true as const }
  })
  handle('learn:pauseRoot', ({ rootId, paused }) => {
    if (typeof rootId === 'string' && rootId !== '') learnPauseRoot?.(rootId, paused === true)
    return { ok: true as const }
  })
  handle('learn:cancel', async ({ rootId }) => {
    if (!learnCancel) return { ok: false }
    await learnCancel(rootId)
    return { ok: true }
  })
  handle('learn:reset', async ({ rootId, dryRun }) => {
    if (!learnReset) return { ok: false, reason: 'learning is not wired in this build' }
    return learnReset(rootId, { dryRun: dryRun === true })
  })
  handle('learn:brainUsage', async ({ rootId }) => {
    if (!brainUsage) {
      return { searches: 0, freshHits: 0, staleHits: 0, misses: 0, savedTokens: 0, updatedAt: null }
    }
    return brainUsage(rootId)
  })

  // ── broadcasts ───────────────────────────────────────────────────────

  // Thread mutations arrive in bursts (streaming appends) — batch them.
  const threadBatch = makeEventBatch<ThreadChangeEvent>((events) =>
    broadcast('threads:updated', events),
  )
  const onThreadChange = (event: ThreadChangeEvent): void => {
    threadBatch.push(event)
  }
  threadStore.on(THREAD_STORE_CHANGE_EVENT, onThreadChange)

  // Task mutations (creation, lane moves) — batch like thread events.
  const taskBatch = makeEventBatch<TaskChangeEvent>((events) => broadcast('tasks:updated', events))
  const onTaskChange = (event: TaskChangeEvent): void => {
    taskBatch.push(event)
  }
  taskStore.on(TASK_STORE_CHANGE_EVENT, onTaskChange)

  // Project file events are already debounced inside the manager.
  // Coalesced + de-duplicated at the source — see roots-broadcast.ts.
  const rootsBroadcast = makeRootsBroadcast((roots) => broadcast('project:listChanged', roots))
  const onRootsChanged = (roots: RegisteredProject[]): void => {
    rootsBroadcast.push(roots)
  }
  const onFilesChanged = (event: ProjectFilesChangedEvent): void => {
    broadcast('project:fileChanged', event)
  }
  projectRegistry.on(PROJECT_LIST_CHANGED_EVENT, onRootsChanged)
  projectRegistry.on(PROJECT_FILES_CHANGED_EVENT, onFilesChanged)

  const onActiveProjectChanged = (context: ProjectContext | null): void => {
    broadcast('project:activeChanged', context)
  }
  projectContext.on(ACTIVE_PROJECT_CHANGED_EVENT, onActiveProjectChanged)

  const onThreadScopeChanged = (scope: ThreadScope): void => {
    broadcast('project:threadScopeChanged', scope)
  }
  threadScope?.on(THREAD_SCOPE_CHANGED_EVENT, onThreadScopeChanged)

  // ── diagnostics ──────────────────────────────────────────────────────────
  // Whoever saw the stall writes it down. The renderer sees a blocked paint and
  // a slow interaction; the preload sees a round trip that queued; main sees its
  // own loop. One file holds all three, in the order they happened, so "it is
  // slow" has an answer that does not require reproducing it.
  handle('diagnostics:record', ({ lines }) => {
    for (const line of lines.slice(0, MAX_RECORDED_LINES)) recordSlow(line)
  })
  handle('diagnostics:report', () => {
    const text = readSlowLog()
    return { text, empty: text.trim().length === 0 }
  })

  // ── auto-update (#auto-update) ───────────────────────────────────────────
  handle('updater:check', () => updater.check())
  // Post-update "What's new" (one-shot): compares this run's version with the
  // stamped previous run; a difference is reported exactly once, then stamped.
  // `repo` (the public releases repo) comes from the packaged app-update.yml —
  // the renderer fetches the release-note body from GitHub with it.
  handle('updater:whatsNew', () => {
    const current = electronApp.getVersion()
    let repo: string | null = null
    try {
      const yml = readFileSync(join(process.resourcesPath, 'app-update.yml'), 'utf8')
      const owner = /^owner:\s*(\S+)/m.exec(yml)?.[1]
      const name = /^repo:\s*(\S+)/m.exec(yml)?.[1]
      if (owner && name) repo = `${owner}/${name}`
    } catch {
      repo = null // dev / unpackaged — no feed config
    }
    if (appSettings === undefined) return { changedTo: null, previous: null, repo }
    const previous = appSettings.getLastRunVersion()
    if (previous === current) return { changedTo: null, previous, repo }
    appSettings.setLastRunVersion(current)
    // First install (no previous stamp) is NOT an update — stamp silently.
    return { changedTo: previous !== null ? current : null, previous, repo }
  })
  // Release notes fetched in MAIN (#online-notes): the renderer's CSP is
  // connect-src 'self' on purpose, so its fetch to api.github.com was blocked
  // and mis-read as "offline". Fail-soft null on any error; 5s timeout.
  handle('updater:releaseNotes', async ({ repo, version }) => {
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return { notes: null }
    try {
      const response = await fetch(
        `https://api.github.com/repos/${repo}/releases/tags/v${encodeURIComponent(version)}`,
        {
          headers: { Accept: 'application/vnd.github+json' },
          signal: AbortSignal.timeout(5_000),
        },
      )
      if (!response.ok) return { notes: null }
      const release = (await response.json()) as { body?: string | null }
      const body = release.body?.trim()
      return { notes: body !== undefined && body !== '' ? body : null }
    } catch {
      return { notes: null }
    }
  })
  handle('updater:download', async () => {
    await updater.download()
  })
  handle('updater:install', () => {
    updater.install()
  })

  return function disposeIpcHandlers(): void {
    for (const channel of registeredChannels) {
      ipcMain.removeHandler(channel)
    }
    registeredChannels.length = 0
    threadBatch.dispose()
    threadStore.off(THREAD_STORE_CHANGE_EVENT, onThreadChange)
    taskBatch.dispose()
    rootsBroadcast.dispose()
    taskStore.off(TASK_STORE_CHANGE_EVENT, onTaskChange)
    projectRegistry.off(PROJECT_LIST_CHANGED_EVENT, onRootsChanged)
    projectRegistry.off(PROJECT_FILES_CHANGED_EVENT, onFilesChanged)
    projectContext.off(ACTIVE_PROJECT_CHANGED_EVENT, onActiveProjectChanged)
    threadScope?.off(THREAD_SCOPE_CHANGED_EVENT, onThreadScopeChanged)
  }
}

/** Send a contract event to every open window (payload typed by channel). */
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
