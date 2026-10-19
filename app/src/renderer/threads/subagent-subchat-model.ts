/**
 * The sub-agent sub-chat feed (#1931) — pure, DOM-free, testable.
 *
 * A sub-agent's transcript is its messages (the sub-agent's own prose) and its
 * tool calls, captured under the parent Task tool call. The detail tab shows
 * them as one time-ordered feed — a compact mirror of the main conversation.
 * This file decides the ORDER and the identity; `background-activity-view.ts`
 * draws it with the real `renderMarkdown` + `ToolCard`.
 */
import type { ThreadMessage, ToolCallRecord } from '../../shared/ipc-contract'

export type SubchatItem =
  | { kind: 'message'; message: ThreadMessage; at: string }
  | { kind: 'tool'; toolCall: ToolCallRecord; at: string }

/**
 * Interleave messages and tool calls into one feed, oldest first. Messages
 * sort by `createdAt`, tool calls by `startedAt`; on a tie the message (the
 * assistant text) precedes the tool it spawned, since a `tool_use` is reported
 * after the assistant message that contains it.
 */
export function buildSubchatFeed(
  messages: readonly ThreadMessage[],
  toolCalls: readonly ToolCallRecord[],
): SubchatItem[] {
  const items: SubchatItem[] = [
    ...messages.map((message) => ({ kind: 'message' as const, message, at: message.createdAt })),
    ...toolCalls.map((toolCall) => ({ kind: 'tool' as const, toolCall, at: toolCall.startedAt })),
  ]
  return items.sort((a, b) => {
    if (a.at !== b.at) return a.at < b.at ? -1 : 1
    if (a.kind !== b.kind) return a.kind === 'message' ? -1 : 1
    return 0
  })
}

/** Stable key for a feed item — used to reconcile across refetches. */
export function subchatItemKey(item: SubchatItem): string {
  return item.kind === 'message' ? `m:${item.message.id}` : `t:${item.toolCall.id}`
}

/** True when the sub-chat has nothing to show (no prose, no tools). */
export function isEmptyFeed(feed: readonly SubchatItem[]): boolean {
  return feed.length === 0
}
