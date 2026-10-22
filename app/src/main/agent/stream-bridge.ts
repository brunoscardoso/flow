// StreamBridge — translates the SDK's message stream into the contract's
// AgentStreamEvent union, persisting durable records to ThreadStore as they
// arrive and emitting events for IPC broadcast.
//
// One bridge instance lives per thread session and is fed every SDKMessage
// the Query yields. It owns the mapping between SDK identifiers
// (tool_use_id, session_id) and Flow records (ToolCallRecord.id,
// threads.sdk_session_id).
//
// Persistence granularity: text deltas stream over IPC only; the assistant
// message text is persisted once, when the completed SDK assistant message
// arrives. Tool calls are persisted at start (pending) and completion
// (success/error/denied). NOTE: the messageId used in streaming events is a
// bridge-generated correlation id — the persisted MessageRecord gets its own
// id from ThreadStore.appendMessage (renderers reconcile via threads:updated).
//
// Subagent traffic (parent_tool_use_id !== null) is ignored in v1 — only the
// main-thread conversation is persisted and streamed.

import { randomUUID } from 'crypto'

import type {
  SDKAssistantMessage,
  SDKMessage,
  SDKPartialAssistantMessage,
  SDKResultMessage,
  SDKUserMessage,
  SDKUserMessageReplay,
} from '@anthropic-ai/claude-agent-sdk'

import type { AgentStreamEvent, ToolCallStatus } from '../../shared/ipc-contract'
import { turnFailureDetail, turnFailureNote } from '../../shared/turn-failure'
import type { SubtaskRecord, ThreadStore } from '../store/thread-store'
import type { SubtaskRegistry } from './subtask-registry'
import type { BackgroundTaskTracker } from './background-tasks'
import { isTurnResultTerminal } from './turn-completion'
import { turnUsageTotals } from './turn-usage'

export interface StreamBridgeCallbacks {
  /** First init message binds the SDK session id to the thread. */
  onSessionId(sessionId: string): void
  /** Every translated event — the IPC layer broadcasts these. */
  emit(event: AgentStreamEvent): void
  /** A turn finished; `success` flags a clean result (used for auto-titling). */
  onTurnComplete?(success: boolean): void
  /**
   * A tool use reached a moment worth announcing, with the payloads exactly as
   * they were stored.
   *
   * THE ONE PLACE THIS IS ANNOUNCED, so a reader of a tool payload does not need
   * a capture path of its own. Everything an assistant does already lands here
   * with its thread and its input; a second reader polling the tool-call table
   * for the same rows would be a duplicate of this line that could fall behind
   * it, and there would then be two answers to "what did the assistant just do".
   *
   * The bridge does not know or care who listens or what they do with it — it
   * reports, exactly as it does for every other event. Observers must not throw
   * and must not block; both are enforced at the call site rather than trusted.
   */
  onToolCallRecorded?(observation: ToolCallObservation): void
  /**
   * Where the thread's live background tasks are kept.
   *
   * Shared with the rest of main rather than owned here, because a tracker per
   * bridge would be a tracker per SESSION — and the surfaces that ask "what is
   * this thread still waiting on" are asking across every thread at once, from
   * an IPC handler that has no bridge in hand. Optional so a bridge in a test
   * (or a runtime that reports no background work) simply does not track.
   */
  backgroundTasks?: BackgroundTaskTracker
  /**
   * The subtask registry (plan mid-run-subtasks note 6). The SDK's own task
   * events are the truth about a background agent's start and end: the bridge
   * hands them over, and the registry decides what they mean for a ticket. A
   * task that is not a subtask (a skill sub-agent) changes nothing there.
   */
  subtasks?: Pick<SubtaskRegistry, 'onTaskStarted' | 'onTaskSettled'>
  /**
   * A settle freed a slot and `next` may start. The bridge does not own the
   * session's input, so it reports; the AgentManager tells the agent.
   */
  onSubtaskSlotFree?(next: SubtaskRecord): void
}

/**
 * The two moments a tool call is announced at.
 *
 * WHY THERE ARE TWO, AND WHY IT IS NOT TWO CALLBACKS (thread-tasklist, Phase 3b).
 * This started as one announcement made when the call was persisted, which is
 * everything a reader needs for a tool whose payload is entirely in what the
 * assistant SENT. It is not enough for a tool whose payload is a question: the
 * assistant's newer task protocol asks for a task WITHOUT an id and is TOLD what
 * the task is called, so the identity every later call is addressed to exists
 * only in the answer — which, at the moment the call is recorded, has not
 * happened yet. A reader wired to the first moment can never see it.
 *
 * The alternatives were worse in the same way as each other. Moving the single
 * announcement to completion would silently delay every existing reader and lose
 * the calls that never come back at all. A second callback for answers would put
 * "what did the assistant just do" behind two doors, which is the split this
 * whole line exists to avoid. So it stays ONE callback, fired at two named
 * moments, and a reader states which moment it is interested in — the union makes
 * that a compiler question rather than a matter of remembering which fields are
 * populated when.
 */
export type ToolCallObservation =
  | {
      /** Persisted and announced as it started — INPUT ONLY, no answer exists. */
      phase: 'recorded'
      toolName: string
      inputJson: string | null
    }
  | {
      /** Settled, one way or another — the answer and the verdict are in. */
      phase: 'completed'
      toolName: string
      inputJson: string | null
      outputJson: string | null
      /**
       * How it ended. ANNOUNCED FOR EVERY TERMINAL STATUS, including the failed,
       * the denied and the interrupted: a reader that only wants the successful
       * ones can say so, and a bridge that filtered on its behalf would be
       * deciding what a failure means to somebody else.
       */
      status: ToolCallStatus
    }

/** Raw streaming event carried by SDKPartialAssistantMessage. */
type RawStreamEvent = SDKPartialAssistantMessage['event']

/**
 * SUB-AGENT LIVE LAYER (#1931 follow-up) — per-spawn streaming state, keyed by
 * the TOP-LEVEL Task record id.
 *
 * A promoted child thread has no SDK session of its own while the origin runs:
 * its rows are written by the PARENT's session (redirect-at-write). Before
 * this, the child pane learned about them only through debounced
 * `threads:updated` refetches — no live text, no running tool chips. This
 * state is what lets the bridge re-emit the sub-agent's live traffic on the
 * SAME stream channel the main chat uses, targeted at the CHILD's threadId, so
 * a pane bound to the child renders exactly like the main chat.
 *
 * `childThreadId` is resolved from ThreadStore (the one spawn → child mapping,
 * allowed-pattern #14) at message boundaries — never per token — and is also
 * refreshed from every persisted row's OWN home (a homed row is proof of
 * promotion). Null means "not promoted": nothing is emitted, exactly the old
 * behavior.
 */
interface SubagentLiveState {
  /** The promoted child thread, or null while the spawn is unpromoted. */
  childThreadId: string | null
  /** Correlation id of the sub-agent assistant message currently streaming. */
  streamMessageId: string | null
  /** Content-block index → block type, from the sub-agent's stream events. */
  openBlocks: Map<number, string>
  /** Whether partial text deltas were emitted to the child since the last
   *  persisted assistant message — when true, the persisted text needs no
   *  synthetic live burst (it already streamed token by token). */
  deltasEmitted: boolean
  /** Last PERSISTED child message id — what the child-targeted `done` names. */
  lastMessageId: string | null
}

/**
 * PERF-2: text deltas are coalesced — buffered and flushed at most once per
 * this window (~one frame) instead of one IPC emission per token. Non-delta
 * events flush immediately first, so relative ordering is preserved.
 * Persistence is untouched: message content is persisted from the completed
 * SDK assistant message, never from deltas.
 */
const DELTA_FLUSH_INTERVAL_MS = 16

export class StreamBridge {
  /** Correlation id for the assistant message currently streaming. */
  private streamMessageId: string | null = null
  /** Coalesced-but-unflushed delta text (PERF-2). */
  private pendingDeltaText = ''
  /** Correlation id the buffered delta text belongs to. */
  private pendingDeltaMessageId: string | null = null
  /** Thread the buffered delta text is addressed to — the parent by default, a
   *  promoted CHILD for sub-agent deltas (#1931 live layer). A target change
   *  flushes first, so parent and sub-agent text never coalesce together. */
  private pendingDeltaThreadId: string | null = null
  private deltaFlushTimer: NodeJS.Timeout | null = null
  /** Content-block index → block type, from content_block_start events. */
  private readonly openBlocks = new Map<number, string>()
  /** SDK tool_use_id → persisted ToolCallRecord.id. */
  private readonly toolCallIds = new Map<string, string>()
  /** SUB-AGENT (#1931): the same tool_use_id → record.id mapping, NEVER deleted.
   *  `toolCallIds` drops an entry when its tool_result lands — which for a
   *  BACKGROUNDED sub-agent is immediately, while the runtime's task events
   *  (`task_started`/`task_progress`, which carry the spawning `tool_use_id`)
   *  keep arriving for as long as the task runs. This map is what joins those
   *  events back to the persisted row deterministically. Session-lifetime,
   *  one small entry per top-level tool call. */
  private readonly spawnRecordIds = new Map<string, string>()
  /** Persisted id of the last assistant message (tool calls attach to it). */
  private lastAssistantMessageId: string | null = null
  /** The last assistant message persisted IN THIS TURN — the one the turn-end
   *  result marks (ThreadStore.markTurnEnd). Separate from
   *  lastAssistantMessageId, which outlives the turn so tool calls keep a
   *  parent: a turn that wrote no text must mark nothing, not re-mark the
   *  previous turn's message. Cleared when the turn ends. */
  private turnAssistantMessageId: string | null = null
  /** SUB-AGENT (#1931): a sub-agent tool_use_id → its persisted ToolCallRecord.id.
   *  Kept SEPARATE from `toolCallIds` so the nested-turn gate (`toolCallIds.size`
   *  in handleResult) is never affected by sub-agent tool calls. */
  private readonly subagentRecordIds = new Map<string, string>()
  /** SUB-AGENT (#1931): any sub-agent tool_use_id → the TOP-LEVEL `Task` record
   *  id it ultimately belongs under, so nested sub-agents flatten to the top
   *  Task (Q3). Built as sub-agent tool calls are recorded. */
  private readonly subagentTopLevel = new Map<string, string>()
  /** SUB-AGENT LIVE LAYER (#1931 follow-up): per-spawn streaming state, keyed
   *  by the top-level Task record id. Entries are dropped when the spawn
   *  settles (its child-targeted `done`); the map is session-lifetime and one
   *  small entry per live spawn. */
  private readonly subagentLive = new Map<string, SubagentLiveState>()
  /** #981: the user asked to stop the in-flight turn. Set by AgentManager
   *  BEFORE awaiting the SDK interrupt, so the aborted turn's result message
   *  (which arrives with a non-success subtype) is classified as a deliberate
   *  stop — settled idle with a calm notice — instead of a failure. */
  private interruptRequested = false

  constructor(
    private readonly threadId: string,
    private readonly threadStore: ThreadStore,
    private readonly callbacks: StreamBridgeCallbacks,
  ) {}

  /** Feed one SDK message through the bridge. Never throws — a malformed
   *  message must not kill the session loop. */
  handleMessage(message: SDKMessage): void {
    try {
      this.translate(message)
    } catch (error) {
      console.error('[StreamBridge] Failed to handle SDK message:', error)
      this.callbacks.emit({
        kind: 'error',
        threadId: this.threadId,
        message: `Stream bridge error: ${error instanceof Error ? error.message : String(error)}`,
      })
    }
  }

  private translate(message: SDKMessage): void {
    // Any non-delta traffic flushes buffered delta text first so the
    // renderer sees events in stream order (PERF-2).
    if (message.type !== 'stream_event') {
      this.flushPendingDelta()
    }
    switch (message.type) {
      case 'system':
        if (message.subtype === 'init') {
          this.callbacks.onSessionId(message.session_id)
          // Surface the model the SDK actually resolved (accurate even for
          // 'auto') so the composer can show "using <model>" (#129).
          if (typeof message.model === 'string' && message.model.length > 0) {
            this.callbacks.emit({ kind: 'model', threadId: this.threadId, model: message.model })
          }
        } else if (message.subtype === 'permission_denied') {
          this.completeToolCall(message.tool_use_id, 'denied', message.message)
        } else {
          this.handleBackgroundTaskMessage(message)
        }
        return
      case 'stream_event':
        if (message.parent_tool_use_id === null) {
          this.handleStreamEvent(message.event)
        } else {
          // SUB-AGENT LIVE LAYER (#1931 follow-up): a sub-agent's partials
          // stream into its PROMOTED child thread; unpromoted spawns stay
          // silent, exactly as before.
          this.handleSubagentStreamEvent(message.parent_tool_use_id, message.event)
        }
        return
      case 'assistant':
        if (message.parent_tool_use_id === null) {
          this.handleAssistantMessage(message)
        } else {
          // SUB-AGENT (#1931): persisted (tagged with the parent Task id), not
          // streamed — the persisted rows fire threads:updated, which the
          // sub-chat tab refetches. Main-thread path above is unchanged.
          this.handleSubagentAssistant(message)
        }
        return
      case 'user':
        if (message.parent_tool_use_id === null) {
          this.handleToolResults(message)
        } else {
          this.handleSubagentToolResults(message)
        }
        return
      case 'result':
        this.handleResult(message)
        return
      default:
        // Status/system chatter (auth_status, …) — not part of the v1 stream
        // contract. The background-task family used to be swept up here too;
        // it is now read above, which is what tells the app a thread whose turn
        // has ended is still owed work.
        return
    }
  }

  /**
   * The background-task family — what a thread is still waiting on once its
   * turn is over.
   *
   * These four subtypes are the ONLY evidence the app has for work that
   * outlives a turn, and every one of them was falling through this switch. A
   * thread that launched four review agents therefore went `done` and every
   * surface went quiet, with the agents still running ("seems to me that the
   * chat is stopped, everywhere").
   *
   * The tracker owns the rules (level replaces, edges decorate, a settled task
   * dies either way) — allowed-pattern #14. This only routes, and only
   * broadcasts when the set a surface would DRAW actually changed: the level
   * fires on every membership change in the session, most of which say nothing
   * new about this thread.
   */
  private handleBackgroundTaskMessage(message: SDKMessage & { type: 'system' }): void {
    this.forwardSubtaskEvent(message)
    const tasks = this.callbacks.backgroundTasks
    if (tasks === undefined) return
    let changed = false
    if (message.subtype === 'background_tasks_changed') {
      changed = tasks.applyLevel(this.threadId, message.tasks)
    } else if (message.subtype === 'task_started') {
      const toolCallId = this.resolveSpawnRecordId(message.tool_use_id)
      this.persistSpawnAgentId(toolCallId, message.task_id)
      changed = tasks.applyStarted(this.threadId, { ...message, toolCallId })
    } else if (message.subtype === 'task_progress') {
      const toolCallId = this.resolveSpawnRecordId(message.tool_use_id)
      // Progress repeats what the start said, but the start can race ahead of
      // the spawn's persistence — the write-once setter makes repeats free.
      this.persistSpawnAgentId(toolCallId, message.task_id)
      changed = tasks.applyProgress(this.threadId, { ...message, toolCallId })
    } else if (message.subtype === 'task_notification') {
      // A BACKGROUNDED spawn's real end (#1931 live layer): its Task tool_result
      // arrived long ago ("backgrounded"), so the child-targeted `done` below in
      // finalizeToolCall already fired once — but live traffic kept flowing and
      // re-opened the child pane's turn. This settles it for good. Resolved
      // BEFORE applySettled, which removes the task from the list.
      const settling = tasks.list(this.threadId).find((task) => task.id === message.task_id)
      if (settling?.toolCallId !== undefined) this.emitSubagentDone(settling.toolCallId)
      changed = tasks.applySettled(this.threadId, message.task_id)
    } else {
      return
    }
    if (changed) this.emitBackgroundTasks()
  }

  /**
   * Hand `task_started` / `task_notification` to the subtask registry, ahead
   * of (and independent of) the tracker: the tracker forgets a task on settle,
   * the registry keeps the row. Never throws into the task-event path.
   */
  private forwardSubtaskEvent(message: SDKMessage & { type: 'system' }): void {
    const registry = this.callbacks.subtasks
    if (registry === undefined) return
    try {
      if (message.subtype === 'task_started') {
        if (message.tool_use_id === undefined) return
        registry.onTaskStarted({ threadId: this.threadId, toolUseId: message.tool_use_id, taskId: message.task_id })
      } else if (message.subtype === 'task_notification') {
        const settled = registry.onTaskSettled({
          threadId: this.threadId,
          taskId: message.task_id,
          status: message.status,
          ...(message.status === 'failed' && message.summary !== '' ? { error: message.summary } : {}),
        })
        if (settled.next !== null) this.callbacks.onSubtaskSlotFree?.(settled.next)
      }
    } catch (error) {
      console.error('[StreamBridge] subtask event failed:', error)
    }
  }

  /** The persisted record id a task event's `tool_use_id` points at, or
   *  undefined when the event carried none / the spawn was never persisted
   *  here (a session resumed mid-task). The DETERMINISTIC half of the
   *  live-task → persisted-row join (#1931); the renderer's heuristic is
   *  the fallback, never the first choice. */
  private resolveSpawnRecordId(toolUseId: string | undefined): string | undefined {
    if (toolUseId === undefined) return undefined
    return this.spawnRecordIds.get(toolUseId) ?? this.toolCallIds.get(toolUseId)
  }

  /** Persist the sub-agent's id (`task_id`) onto its SPAWN record — the key a
   *  later promotion resolves the SDK session-storage transcript with (#1931
   *  transcript backfill). Write-once in the store; never allowed to throw into
   *  the task-event path (a failed stamp only degrades a future promotion to
   *  transcript matching). */
  private persistSpawnAgentId(toolCallId: string | undefined, taskId: string): void {
    if (toolCallId === undefined || taskId.length === 0) return
    try {
      this.threadStore.setToolCallAgentId(toolCallId, taskId)
    } catch (error) {
      console.error('[StreamBridge] Failed to persist spawn agent id:', error)
    }
  }

  /** Broadcast this thread's live background tasks — the whole set, always. */
  private emitBackgroundTasks(): void {
    const tasks = this.callbacks.backgroundTasks
    if (tasks === undefined) return
    this.callbacks.emit({
      kind: 'background-tasks',
      threadId: this.threadId,
      tasks: tasks.list(this.threadId),
    })
  }

  // ── Partial (streaming) events ─────────────────────────────────────────

  private handleStreamEvent(event: RawStreamEvent): void {
    if (event.type !== 'content_block_delta' || event.delta.type !== 'text_delta') {
      this.flushPendingDelta()
    }
    switch (event.type) {
      case 'message_start':
        this.streamMessageId = randomUUID()
        this.callbacks.emit({
          kind: 'message-start',
          threadId: this.threadId,
          messageId: this.streamMessageId,
        })
        return
      case 'content_block_start': {
        const blockType: string = event.content_block.type
        this.openBlocks.set(event.index, blockType)
        if (blockType === 'thinking' || blockType === 'redacted_thinking') {
          this.callbacks.emit({ kind: 'thinking', threadId: this.threadId, active: true })
        }
        return
      }
      case 'content_block_delta':
        if (event.delta.type === 'text_delta' && this.streamMessageId) {
          this.queueDelta(this.streamMessageId, event.delta.text)
        }
        return
      case 'content_block_stop': {
        const blockType = this.openBlocks.get(event.index)
        this.openBlocks.delete(event.index)
        if (blockType === 'thinking' || blockType === 'redacted_thinking') {
          this.callbacks.emit({ kind: 'thinking', threadId: this.threadId, active: false })
        }
        // A TEXT block ending is a signal too, and dropping it cost the renderer
        // its loader. The pane clears its spinner on the first delta — text IS
        // the feedback while it flows — and had nothing to tell it the flow had
        // stopped, so a turn that finished a sentence and then thought for a few
        // seconds before its next tool showed no activity at all.
        //
        // `streamMessageId` is the message the deltas were attributed to, so the
        // stop names the same message the pane is holding open. A stop with no
        // open message is dropped rather than invented.
        if (blockType === 'text' && this.streamMessageId !== null) {
          this.callbacks.emit({
            kind: 'text-stop',
            threadId: this.threadId,
            messageId: this.streamMessageId,
          })
        }
        return
      }
      default:
        return
    }
  }

  // ── Delta coalescing (PERF-2) ──────────────────────────────────────────

  /** Buffer delta text; a ~16ms timer flushes it as ONE message-delta.
   *  `threadId` defaults to the parent; a promoted child's deltas pass the
   *  child id (#1931 live layer). */
  private queueDelta(messageId: string, text: string, threadId: string = this.threadId): void {
    if (
      (this.pendingDeltaMessageId !== null && this.pendingDeltaMessageId !== messageId) ||
      (this.pendingDeltaThreadId !== null && this.pendingDeltaThreadId !== threadId)
    ) {
      this.flushPendingDelta()
    }
    this.pendingDeltaMessageId = messageId
    this.pendingDeltaThreadId = threadId
    this.pendingDeltaText += text
    if (this.deltaFlushTimer === null) {
      this.deltaFlushTimer = setTimeout(() => this.flushPendingDelta(), DELTA_FLUSH_INTERVAL_MS)
    }
  }

  /** Emit buffered delta text now (timer tick or a non-delta event arrived). */
  private flushPendingDelta(): void {
    if (this.deltaFlushTimer !== null) {
      clearTimeout(this.deltaFlushTimer)
      this.deltaFlushTimer = null
    }
    const messageId = this.pendingDeltaMessageId
    const threadId = this.pendingDeltaThreadId ?? this.threadId
    const text = this.pendingDeltaText
    this.pendingDeltaMessageId = null
    this.pendingDeltaThreadId = null
    this.pendingDeltaText = ''
    if (messageId === null || text.length === 0) return
    this.callbacks.emit({
      kind: 'message-delta',
      threadId,
      messageId,
      text,
    })
  }

  // ── Completed assistant messages (text + tool_use blocks) ──────────────

  private handleAssistantMessage(message: SDKAssistantMessage): void {
    const textParts: string[] = []
    const toolUses: Array<{ id: string; name: string; input: unknown }> = []

    for (const block of message.message.content) {
      if (block.type === 'text') {
        textParts.push(block.text)
      } else if (block.type === 'tool_use') {
        toolUses.push({ id: block.id, name: block.name, input: block.input })
      }
    }

    const text = textParts.join('')
    if (text.length > 0) {
      // Record the model that produced this message (the Anthropic message's own
      // `model`, accurate even for an 'auto'/routed session) for the per-message
      // badge (#129).
      const model = typeof message.message.model === 'string' ? message.message.model : null
      const persisted = this.threadStore.appendMessage(this.threadId, 'assistant', text, model)
      this.lastAssistantMessageId = persisted.id
      this.turnAssistantMessageId = persisted.id
    }

    for (const toolUse of toolUses) {
      const record = this.threadStore.recordToolCall({
        threadId: this.threadId,
        messageId: this.lastAssistantMessageId ?? undefined,
        toolName: toolUse.name,
        inputJson: safeStringify(toolUse.input),
      })
      this.threadStore.updateToolCall(record.id, { status: 'running' })
      this.toolCallIds.set(toolUse.id, record.id)
      this.spawnRecordIds.set(toolUse.id, record.id)
      this.callbacks.emit({
        kind: 'tool-start',
        threadId: this.threadId,
        toolCall: { ...record, status: 'running' },
      })
      // AFTER the record and after the event, so an observer can never be the
      // reason a tool call went unpersisted or unannounced. This moment carries
      // no answer — the tool has not run yet — which is exactly why there is a
      // second one below.
      this.announce({
        phase: 'recorded',
        toolName: record.toolName,
        inputJson: record.inputJson,
      })
    }
  }

  // ── Tool results (arrive as synthetic user messages) ───────────────────

  private handleToolResults(message: SDKUserMessage | SDKUserMessageReplay): void {
    const content = message.message.content
    if (!Array.isArray(content)) return

    for (const block of content) {
      if (typeof block !== 'object' || block === null) continue
      if (!('type' in block) || block.type !== 'tool_result') continue
      const toolUseId = 'tool_use_id' in block ? String(block.tool_use_id) : null
      if (!toolUseId) continue
      const isError = 'is_error' in block && block.is_error === true
      const output = 'content' in block ? block.content : null
      this.completeToolCall(
        toolUseId,
        isError ? 'error' : 'success',
        safeStringify(output),
      )
    }
  }

  // ── Sub-agent capture (#1931) ────────────────────────────────────────────
  // Sub-agent messages arrive with `parent_tool_use_id` set to the parent Task
  // tool_use id (or, for a NESTED sub-agent, another sub-agent tool_use id). We
  // persist them tagged with the TOP-LEVEL Task's record id so a sub-chat is
  // "rows where parent_tool_call_id = <taskId>". Persistence only — no stream
  // event — so the main stream contract is untouched (C-1).

  /** Resolve a sub-agent message's `parent_tool_use_id` to the TOP-LEVEL Task's
   *  persisted record id, or null when it cannot be attributed. */
  private resolveSubagentTop(parentToolUseId: string): string | null {
    const direct = this.toolCallIds.get(parentToolUseId)
    if (direct !== undefined) return direct
    const backgrounded = this.spawnRecordIds.get(parentToolUseId)
    if (backgrounded !== undefined) return backgrounded
    return this.subagentTopLevel.get(parentToolUseId) ?? null
  }

  /** The live-layer state for a spawn, created on first contact. */
  private subagentLiveState(top: string): SubagentLiveState {
    let state = this.subagentLive.get(top)
    if (state === undefined) {
      state = {
        childThreadId: null,
        streamMessageId: null,
        openBlocks: new Map(),
        deltasEmitted: false,
        lastMessageId: null,
      }
      this.subagentLive.set(top, state)
    }
    return state
  }

  /**
   * The promoted child for a top-level Task record, from THE one mediating
   * spawn → child lookup (ThreadStore, allowed-pattern #14) — the bridge never
   * keeps a mapping of its own. Called at sub-agent MESSAGE boundaries only,
   * never per token. Optional-chained + guarded so an older store (or a test
   * fake without the method) degrades to "unpromoted", never to a dead turn.
   */
  private promotedChildOf(topRecordId: string): string | null {
    try {
      return this.threadStore.promotedChildId?.(this.threadId, topRecordId) ?? null
    } catch (error) {
      console.error('[StreamBridge] promoted-child lookup failed:', error)
      return null
    }
  }

  /**
   * Live partials from a sub-agent (#1931 follow-up): re-emit them on the main
   * stream channel targeted at the spawn's PROMOTED child thread, so a pane
   * bound to the child renders live text / thinking exactly like the main chat.
   *
   * Promotion is re-checked once per sub-agent message (`message_start`) — a
   * child promoted mid-message starts streaming at the next message, and its
   * just-run promotion already loaded everything persisted so far. Unpromoted
   * spawns emit nothing (the old behavior, to the byte).
   *
   * The persisted rows stay the durable source: correlation ids here never
   * persist, and the child-targeted `done` (emitSubagentDone) makes the pane
   * reconcile against the store — the same live-vs-persisted contract the main
   * chat uses.
   */
  private handleSubagentStreamEvent(parentToolUseId: string, event: RawStreamEvent): void {
    const top = this.resolveSubagentTop(parentToolUseId)
    if (top === null) return
    const state = this.subagentLiveState(top)
    if (event.type !== 'content_block_delta' || event.delta.type !== 'text_delta') {
      this.flushPendingDelta()
    }
    switch (event.type) {
      case 'message_start':
        // The one promotion re-check per message — never per token.
        state.childThreadId = this.promotedChildOf(top)
        state.openBlocks.clear()
        if (state.childThreadId === null) {
          state.streamMessageId = null
          return
        }
        state.streamMessageId = randomUUID()
        this.callbacks.emit({
          kind: 'message-start',
          threadId: state.childThreadId,
          messageId: state.streamMessageId,
        })
        return
      case 'content_block_start': {
        if (state.childThreadId === null) return
        const blockType: string = event.content_block.type
        state.openBlocks.set(event.index, blockType)
        if (blockType === 'thinking' || blockType === 'redacted_thinking') {
          this.callbacks.emit({ kind: 'thinking', threadId: state.childThreadId, active: true })
        }
        return
      }
      case 'content_block_delta':
        if (
          event.delta.type === 'text_delta' &&
          state.childThreadId !== null &&
          state.streamMessageId !== null
        ) {
          this.queueDelta(state.streamMessageId, event.delta.text, state.childThreadId)
          state.deltasEmitted = true
        }
        return
      case 'content_block_stop': {
        if (state.childThreadId === null) return
        const blockType = state.openBlocks.get(event.index)
        state.openBlocks.delete(event.index)
        if (blockType === 'thinking' || blockType === 'redacted_thinking') {
          this.callbacks.emit({ kind: 'thinking', threadId: state.childThreadId, active: false })
        }
        // Mirrors the parent path: a text block ending tells the child pane its
        // streaming text stopped, so its loader can come back.
        if (blockType === 'text' && state.streamMessageId !== null) {
          this.callbacks.emit({
            kind: 'text-stop',
            threadId: state.childThreadId,
            messageId: state.streamMessageId,
          })
        }
        return
      }
      default:
        return
    }
  }

  /**
   * The spawn settled — if its sub-agent was streaming into a promoted child,
   * close that child's live layer with a targeted `done`, which is what makes
   * the pane reconcile its live nodes against the persisted rows (no dupes, no
   * frozen loader). Emitted from finalizeToolCall (the Task's tool_result /
   * interrupt) and from task_notification (a backgrounded spawn's real end).
   * Idempotent: the state is deleted with the first emission.
   */
  private emitSubagentDone(spawnRecordId: string): void {
    const live = this.subagentLive.get(spawnRecordId)
    if (live === undefined || live.childThreadId === null) return
    this.subagentLive.delete(spawnRecordId)
    this.callbacks.emit({
      kind: 'done',
      threadId: live.childThreadId,
      messageId: live.lastMessageId ?? '',
    })
  }

  /** Persist a sub-agent's assistant message — its text and the tool uses it
   *  made — tagged with the top-level Task record id. */
  private handleSubagentAssistant(message: SDKAssistantMessage): void {
    const parentUseId = message.parent_tool_use_id
    if (parentUseId === null) return
    const top = this.resolveSubagentTop(parentUseId)
    if (top === null) return

    const textParts: string[] = []
    const thinkingParts: string[] = []
    const toolUses: Array<{ id: string; name: string; input: unknown }> = []
    for (const block of message.message.content) {
      if (block.type === 'text') {
        textParts.push(block.text)
      } else if (block.type === 'thinking') {
        // #1931: the sub-agent's reasoning (forwarded by forwardSubagentText) —
        // capture it so the sub-chat shows the thinking process, not just tools.
        const thinking = (block as { thinking?: unknown }).thinking
        if (typeof thinking === 'string') thinkingParts.push(thinking)
      } else if (block.type === 'tool_use') {
        toolUses.push({ id: block.id, name: block.name, input: block.input })
      }
    }

    // Thinking leads (rendered as a muted blockquote by the sub-chat), then the
    // answer — a compact mirror of how the main conversation reads.
    const answer = textParts.join('')
    const thinking = thinkingParts.join('').trim()
    const segments: string[] = []
    if (thinking.length > 0) segments.push(`> 💭 ${thinking.replace(/\n/g, '\n> ')}`)
    if (answer.length > 0) segments.push(answer)
    const text = segments.join('\n\n')
    let messageId: string | undefined
    if (text.length > 0) {
      const model = typeof message.message.model === 'string' ? message.message.model : null
      const persisted = this.threadStore.appendMessage(this.threadId, 'assistant', text, model, top)
      messageId = persisted.id
      // LIVE LAYER (#1931 follow-up): the store homed the row — a home that is
      // not the parent IS the promoted child (redirect-at-write), so the store
      // stays the one attribution authority. Remember it for the spawn's
      // targeted `done`, and if no partial deltas reached the child for this
      // message (runtime without sub-agent partials, or a promotion that landed
      // mid-message), emit the persisted text as one live burst so the child
      // updates instantly instead of waiting out the foreign-refresh debounce.
      if (persisted.threadId !== this.threadId) {
        const live = this.subagentLiveState(top)
        live.childThreadId = persisted.threadId
        live.lastMessageId = persisted.id
        if (!live.deltasEmitted) {
          const syntheticId = randomUUID()
          this.callbacks.emit({
            kind: 'message-start',
            threadId: persisted.threadId,
            messageId: syntheticId,
          })
          this.callbacks.emit({
            kind: 'message-delta',
            threadId: persisted.threadId,
            messageId: syntheticId,
            text,
          })
          this.callbacks.emit({
            kind: 'text-stop',
            threadId: persisted.threadId,
            messageId: syntheticId,
          })
        }
        live.deltasEmitted = false
      }
    }

    for (const toolUse of toolUses) {
      const record = this.threadStore.recordToolCall({
        threadId: this.threadId,
        messageId,
        toolName: toolUse.name,
        inputJson: safeStringify(toolUse.input),
        parentToolCallId: top,
      })
      this.threadStore.updateToolCall(record.id, { status: 'running' })
      this.subagentRecordIds.set(toolUse.id, record.id)
      // This sub-agent tool may itself spawn a sub-agent — map its id to the
      // same top-level Task so that descendant flattens here too.
      this.subagentTopLevel.set(toolUse.id, top)
      // LIVE LAYER (#1931 follow-up): a tool homed into the promoted child gets
      // the same live tool-start the main chat gets, targeted at the child, so
      // the chip appears running the moment the sub-agent starts it.
      if (record.threadId !== this.threadId) {
        this.subagentLiveState(top).childThreadId = record.threadId
        this.callbacks.emit({
          kind: 'tool-start',
          threadId: record.threadId,
          toolCall: { ...record, status: 'running' },
        })
      }
    }
  }

  /** Finalize a sub-agent's tool calls from its tool_result blocks. */
  private handleSubagentToolResults(message: SDKUserMessage | SDKUserMessageReplay): void {
    const content = message.message.content
    if (!Array.isArray(content)) return
    for (const block of content) {
      if (typeof block !== 'object' || block === null) continue
      if (!('type' in block) || block.type !== 'tool_result') continue
      const toolUseId = 'tool_use_id' in block ? String(block.tool_use_id) : null
      if (!toolUseId) continue
      const recordId = this.subagentRecordIds.get(toolUseId)
      if (recordId === undefined) continue
      this.subagentRecordIds.delete(toolUseId)
      // By ID, not (thread, id): a promoted sub-agent's rows live in the CHILD
      // thread (#1931 — homed there at write, or moved by the promotion), and
      // keying on the parent would silently drop their completions.
      const record = this.threadStore.getToolCallById(recordId)
      if (!record || isTerminalToolStatus(record.status)) continue
      const isError = 'is_error' in block && block.is_error === true
      const output = 'content' in block ? block.content : null
      const status = isError ? 'error' : 'success'
      const outputJson = safeStringify(output)
      const completedAt = new Date().toISOString()
      this.threadStore.updateToolCall(recordId, { status, outputJson, completedAt })
      // LIVE LAYER (#1931 follow-up): a completion for a tool living in the
      // promoted child flips its live chip, same as the main chat's tool-end.
      if (record.threadId !== this.threadId) {
        const top = this.subagentTopLevel.get(toolUseId)
        if (top !== undefined) this.subagentLiveState(top).childThreadId = record.threadId
        this.callbacks.emit({
          kind: 'tool-end',
          threadId: record.threadId,
          toolCall: { ...record, status, outputJson, completedAt },
        })
      }
    }
  }

  private completeToolCall(
    toolUseId: string,
    status: 'success' | 'error' | 'denied' | 'interrupted',
    output: string | null,
  ): void {
    const recordId = this.toolCallIds.get(toolUseId)
    if (!recordId) return
    this.toolCallIds.delete(toolUseId)
    this.finalizeToolCall(recordId, status, output)
  }

  /** Persist a terminal status + emit tool-end. Guarded by the record's
   *  CURRENT status (LOG-6): a late genuine tool_result for a call already
   *  resolved by an interrupt must neither crash nor double-complete. */
  private finalizeToolCall(
    recordId: string,
    status: 'success' | 'error' | 'denied' | 'interrupted',
    output: string | null,
  ): void {
    const record = this.threadStore.getToolCall(this.threadId, recordId)
    if (!record || isTerminalToolStatus(record.status)) return

    const completedAt = new Date().toISOString()
    this.threadStore.updateToolCall(recordId, {
      status,
      outputJson: output,
      completedAt,
    })
    this.callbacks.emit({
      kind: 'tool-end',
      threadId: this.threadId,
      toolCall: { ...record, status, outputJson: output, completedAt },
    })
    // The second moment, announced under the same rule as the first: AFTER the
    // record and after the event, so an observer can never be the reason a tool
    // call went unpersisted or unannounced.
    this.announce({
      phase: 'completed',
      toolName: record.toolName,
      inputJson: record.inputJson,
      outputJson: output,
      status,
    })
    // LIVE LAYER (#1931 follow-up): if this record was a spawn streaming into a
    // promoted child, the child's live turn ends here — a foreground spawn's
    // real end, a backgrounded spawn's "backgrounded" moment (its real end
    // settles again via task_notification), and the interrupt path all pass
    // through this one finalization.
    this.emitSubagentDone(recordId)
  }

  /**
   * Hand one observation to whoever is listening, and survive them.
   *
   * ONE GUARDED CALL SITE FOR BOTH MOMENTS (allowed-pattern #14). "An observer
   * that throws is the observer's bug and is not allowed to become the turn's" is
   * an invariant of this bridge, and an invariant re-implemented at each
   * announcement is one that lasts until the announcement somebody adds without
   * the try.
   */
  private announce(observation: ToolCallObservation): void {
    try {
      this.callbacks.onToolCallRecorded?.(observation)
    } catch (error) {
      console.error('[StreamBridge] Tool-call observer threw:', error)
    }
  }

  /**
   * LOG-6: resolve every non-terminal tool call this bridge is still waiting
   * on to 'error' with an interrupted marker, emitting matching tool-end
   * events. Called on interrupt and on session teardown — once the SDK turn
   * is gone, no tool_result will ever arrive, so 'running' records would
   * otherwise stay open forever. Never throws (used in finally blocks); a
   * late tool_result for an aborted call is ignored (map cleared + status
   * guard in finalizeToolCall).
   */
  /** #981: mark the in-flight turn as deliberately stopped by the user.
   *  Classification keys on this fact (main issued the abort) — never on
   *  parsing the SDK's diagnostic text. */
  markInterruptRequested(): void {
    this.interruptRequested = true
  }

  /** #981: forget a pending interrupt mark. Called when a new turn starts —
   *  a stale mark from a stop whose result never arrived must not swallow
   *  the next turn's genuine failure. */
  clearInterruptRequested(): void {
    this.interruptRequested = false
  }

  /** #981: true while an interrupt has been requested but not yet settled. */
  get wasInterruptRequested(): boolean {
    return this.interruptRequested
  }

  abortOpenToolCalls(reason = 'interrupted'): void {
    if (this.toolCallIds.size === 0) return
    const recordIds = Array.from(this.toolCallIds.values())
    this.toolCallIds.clear()
    // #1217: a stop you asked for is not a failure. This finalized every open
    // call as `error` — the same status a genuinely failed tool gets — and
    // explained it with the raw internal marker, so the card showed a red ⊗ and
    // `{"interrupted": true, …}` directly above the calm "Interrupted by you"
    // note #981 added. The record already carried the fact; it had nowhere to go.
    const output = reason === 'interrupted' ? 'Stopped when you interrupted the turn' : `Stopped: ${reason}`
    for (const recordId of recordIds) {
      try {
        this.finalizeToolCall(recordId, 'interrupted', output)
      } catch (error) {
        console.error('[StreamBridge] Failed to abort open tool call:', error)
      }
    }
  }

  // ── Turn completion ────────────────────────────────────────────────────

  /** Mark this turn's last assistant message as the turn's end, then forget
   *  it. A store failure is logged, never thrown: the turn must still settle. */
  private markTurnEnd(): void {
    const messageId = this.turnAssistantMessageId
    this.turnAssistantMessageId = null
    if (messageId === null) return
    try {
      this.threadStore.markTurnEnd(messageId)
    } catch (error) {
      console.error('[StreamBridge] Failed to mark the turn end:', { threadId: this.threadId, messageId, error })
    }
  }

  private handleResult(message: SDKResultMessage): void {
    // #464: a `result` that lands while parent tool calls are still open is a nested
    // (sub-agent / Task) turn finishing — NOT the parent's end. Ignore it, or the
    // thread flips to 'done' while the agent is still working. The real turn-end
    // result arrives once every parent tool call (incl. the Task) has its result.
    if (!isTurnResultTerminal(this.toolCallIds.size)) {
      return
    }
    // #1136: `usage.input_tokens` is only the UNCACHED remainder — the cache
    // buckets carry the rest of what the turn sent. turnUsageTotals owns the
    // sum so the footer reports real input, not the leftover.
    const usage = turnUsageTotals(message.usage)
    this.callbacks.emit({
      kind: 'usage',
      threadId: this.threadId,
      inputTokens: usage.inputTokens,
      cachedInputTokens: usage.cachedInputTokens,
      outputTokens: usage.outputTokens,
    })

    const interrupted = this.interruptRequested
    this.interruptRequested = false

    // The end of every turn — a person's or a wake-up's, finished, interrupted
    // or failed — is a stored fact before anyone hears `done`: the feed picks
    // a request's answer from this mark (plan_chat-cleanup FR-7/8). Marked
    // first, so the reconcile the status/done events trigger already reads it.
    this.markTurnEnd()

    if (message.subtype === 'success' && !message.is_error) {
      this.threadStore.updateThread(this.threadId, { status: 'done' })
      this.callbacks.emit({ kind: 'status', threadId: this.threadId, status: 'done' })
    } else if (interrupted) {
      // #981: the user pressed Interrupt — this non-success result is the
      // aborted turn settling, NOT a crash. Settle idle (matching the intent
      // AgentManager#interrupt already stated) with a calm persisted notice;
      // the SDK's raw diagnostic ([ede_diagnostic] …) never reaches the UI.
      // Genuine failures keep the error card below (#846/#878 unregressed).
      this.threadStore.appendMessage(this.threadId, 'system', 'Interrupted by you')
      this.threadStore.updateThread(this.threadId, { status: 'idle' })
      this.callbacks.emit({ kind: 'status', threadId: this.threadId, status: 'idle' })
    } else {
      const detail =
        message.subtype === 'success'
          ? message.result
          : message.errors.join('; ') || message.subtype
      // THE RUNTIME'S DIAGNOSTIC IS NOT A SENTENCE. `[ede_diagnostic]
      // result_type=user …` named the SDK's internals and reported an ordinary
      // `stop_reason=tool_use` as a failure; it stays in the log, where its
      // audience is, and never reaches the card.
      if (turnFailureDetail(detail) === null) {
        console.warn('[StreamBridge] turn ended without a reportable reason', {
          threadId: this.threadId,
          detail,
        })
      }
      const failureNote = turnFailureNote(detail)
      // #1048: persist the failure BEFORE emitting. The stream events below are
      // ephemeral — a pane mounted on ANOTHER thread drops them, and its history
      // rebuild reads persisted rows only, so without this row a background
      // failure left no trace anywhere. The renderer recognizes the prefix and
      // renders the row as the same error card the live path shows (and skips
      // its in-memory #turnError re-append when this row is present).
      this.threadStore.appendMessage(this.threadId, 'system', failureNote)
      this.threadStore.updateThread(this.threadId, { status: 'failed' })
      this.callbacks.emit({ kind: 'status', threadId: this.threadId, status: 'failed' })
      this.callbacks.emit({
        kind: 'error',
        threadId: this.threadId,
        message: failureNote,
      })
    }

    this.callbacks.emit({
      kind: 'done',
      threadId: this.threadId,
      messageId: this.lastAssistantMessageId ?? this.streamMessageId ?? '',
    })
    this.streamMessageId = null
    this.openBlocks.clear()

    this.callbacks.onTurnComplete?.(message.subtype === 'success' && !message.is_error)
  }
}

function isTerminalToolStatus(status: ToolCallStatus): boolean {
  return status === 'success' || status === 'error' || status === 'denied'
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? 'null'
  } catch {
    return '"[unserializable]"'
  }
}
