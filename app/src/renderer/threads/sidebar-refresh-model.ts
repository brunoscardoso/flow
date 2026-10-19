/**
 * Refresh policy for the thread sidebar's change-event subscriptions (#1696).
 *
 * The 50ms threads:updated batches arrive continuously during a streaming
 * agent turn — every assistant message is one event and every tool call is
 * two — and each one used to buy a full refetch of all threads plus every
 * root's tasks and a whole-sidebar rebuild, visible or not. Two rules retire
 * that (the #1640/#1666 doctrine — pay only for what someone can see):
 *
 * 1. A batch that touches nothing the sidebar renders is dropped outright.
 * 2. A batch that does, but lands while the sidebar is hidden, is deferred to
 *    one dirty-flag refresh on reveal.
 */
import type { ThreadChangeEvent } from '../../shared/ipc-contract'

/** What the sidebar should do with a change batch. */
export type SidebarRefreshAction = 'refresh' | 'defer' | 'skip'

/**
 * Whether a threads:updated batch changes anything the sidebar renders.
 * `tool_call` events touch no threads-table column (only appendMessage bumps
 * updated_at), so a batch that is purely tool-call churn draws nothing new.
 * An empty batch is treated as affecting — conservative, and the broadcaster
 * never sends one.
 */
export function threadEventsAffectSidebar(events: readonly ThreadChangeEvent[]): boolean {
  return events.length === 0 || events.some((event) => event.entity !== 'tool_call')
}

/** Fold relevance and visibility into the action the subscription takes. */
export function sidebarRefreshAction(options: {
  affectsSidebar: boolean
  visible: boolean
}): SidebarRefreshAction {
  if (!options.affectsSidebar) return 'skip'
  return options.visible ? 'refresh' : 'defer'
}
