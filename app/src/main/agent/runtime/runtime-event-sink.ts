// Persist a normalized event stream to the thread store (multi_runtime_support).
//
// StreamBridge does two jobs for Claude: translate SDK messages to
// AgentStreamEvents AND persist the durable transcript (assistant text, tool
// calls, status) so a thread survives reload. A non-Claude runtime
// (CodexRuntime) emits AgentStreamEvents DIRECTLY — it never goes through
// StreamBridge — so without this sink its threads would stream live but persist
// nothing and come back empty on reload.
//
// This is StreamBridge's persistence half, fed by the normalized events instead
// of SDK messages: the coordinator wires a runtime's `onEvent` to BOTH this sink
// (persist) and emitStream (stream to the renderer). It writes exactly the
// durable set StreamBridge writes — assistant messages, tool calls, thread
// status — and ignores the ephemeral ones (usage/thinking/done), so a reloaded
// Codex thread matches a reloaded Claude thread.

import type { AgentStreamEvent } from '../../../shared/ipc-contract'
import type { ThreadStore } from '../../store/thread-store'

/** The store surface the sink needs — a real ThreadStore satisfies it. */
export type EventSinkStore = Pick<
  ThreadStore,
  'appendMessage' | 'recordToolCall' | 'updateToolCall' | 'updateThread' | 'markTurnEnd'
>

export class RuntimeEventSink {
  /** messageId → text accumulated across its deltas, flushed on text-stop. */
  private readonly textByMessage = new Map<string, string>()
  /** event-side tool id → the store's tool-call id (the StreamBridge mapping). */
  private readonly toolStoreIds = new Map<string, string>()
  /** The model the last `model` event reported — stamped on persisted messages. */
  private model: string | undefined
  /** The last persisted assistant message — tool calls link back to it. */
  private lastAssistantMessageId: string | null = null
  /** The last assistant message persisted in THIS turn — marked as the turn's end on `done`. */
  private turnAssistantMessageId: string | null = null

  constructor(
    private readonly threadId: string,
    private readonly store: EventSinkStore,
  ) {}

  handle(event: AgentStreamEvent): void {
    switch (event.kind) {
      case 'model':
        this.model = event.model
        return
      case 'message-start':
        this.textByMessage.set(event.messageId, '')
        return
      case 'message-delta':
        this.textByMessage.set(
          event.messageId,
          (this.textByMessage.get(event.messageId) ?? '') + event.text,
        )
        return
      case 'text-stop': {
        const text = this.textByMessage.get(event.messageId) ?? ''
        this.textByMessage.delete(event.messageId)
        // Empty text blocks persist nothing — parity with StreamBridge, which
        // only writes a message from completed assistant content.
        if (text.length > 0) {
          const persisted = this.store.appendMessage(this.threadId, 'assistant', text, this.model ?? null)
          this.lastAssistantMessageId = persisted.id
          this.turnAssistantMessageId = persisted.id
        }
        return
      }
      case 'tool-start': {
        const record = this.store.recordToolCall({
          threadId: this.threadId,
          ...(this.lastAssistantMessageId !== null ? { messageId: this.lastAssistantMessageId } : {}),
          toolName: event.toolCall.toolName,
          ...(event.toolCall.inputJson !== null ? { inputJson: event.toolCall.inputJson } : {}),
        })
        this.store.updateToolCall(record.id, { status: 'running' })
        this.toolStoreIds.set(event.toolCall.id, record.id)
        return
      }
      case 'tool-end': {
        const storeId = this.toolStoreIds.get(event.toolCall.id)
        // An end without a matching start (dropped/duplicated) is ignored, never
        // a crash — the runtime's stream is fail-soft and so is persistence.
        if (storeId !== undefined) {
          this.store.updateToolCall(storeId, {
            status: event.toolCall.status,
            outputJson: event.toolCall.outputJson,
            completedAt: event.toolCall.completedAt,
          })
        }
        return
      }
      case 'status':
        this.store.updateThread(this.threadId, { status: event.status })
        return
      case 'done': {
        // The turn's last message is its answer — the same mark StreamBridge
        // writes, so a Copilot or Codex thread folds like a Claude one. A turn
        // that wrote no text marks nothing.
        const id = this.turnAssistantMessageId
        this.turnAssistantMessageId = null
        if (id !== null) {
          try {
            this.store.markTurnEnd(id)
          } catch (error) {
            console.warn('[RuntimeEventSink] could not mark the turn end', { threadId: this.threadId, error })
          }
        }
        return
      }
      default:
        // usage / brain-savings / thinking / error are streamed to the
        // renderer but not part of the durable transcript (StreamBridge parity).
        return
    }
  }
}
