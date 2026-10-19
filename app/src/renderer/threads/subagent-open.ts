/**
 * THE ONE WAY a click on a LIVE sub-agent opens anything (#1931).
 *
 * Two surfaces show running sub-agents — the chip popover's live rows and the
 * sidebar's agent-task rows — and both call this, so the routing decision
 * cannot fork (allowed-pattern #14). The decision itself is pure and lives in
 * `background-activity-model.subagentOpenTarget`:
 *
 *   resolved to its persisted spawn  →  `flow:open-subagent-thread`
 *       — promote to a real child thread and switch the MAIN pane to it,
 *         live-updating while the sub-agent runs (D-4)
 *   unresolvable / ambiguous         →  `flow:open-subagent-progress`
 *       — the right-side live-progress view, the honest fallback for a task
 *         with no persisted Task tool call it can be safely matched to (D-5)
 *
 * The records come from the background-activity store's OWN last list read
 * (spawn records only — refreshed on every tool_call change while any activity
 * surface is on screen, so at most one debounce window behind), not a fresh
 * whole-thread `toolCalls:list` per click: that read shipped every top-level
 * call's metadata to judge a handful of spawns (allowed-pattern #18). When the
 * store has none to offer, ONE list read is the fallback. Staleness and fetch
 * failure both degrade the same way — to the progress fallback, never the
 * wrong chat (the deterministic branch only ever confirms a record that
 * exists; a record the snapshot missed can only read as "unresolved").
 */
import type { BackgroundTaskInfo, ToolCallRecord } from '../../shared/ipc-contract'
import { subagentOpenTarget } from './background-activity-model'
import { backgroundActivityStore } from './background-activity-store'

/**
 * Dispatched (by the one `flow:open-subagent-thread` handler) when the main
 * pane switches to a sub-agent child thread — every right-side
 * background-activity / sub-agent-progress view closes on it, including one
 * opened moments earlier via the fallback for the same task.
 */
export const CLOSE_SUBAGENT_VIEWS_EVENT = 'flow:close-subagent-views'

/** Names and statuses only — the resolution reads no output blob
 *  (allowed-pattern #18; `1` because the store treats `<= 0` as unbounded). */
const OUTPUT_LIMIT = 1

export async function openSubagentTask(
  threadId: string,
  task: BackgroundTaskInfo,
  options: { label: string; running: boolean },
): Promise<void> {
  let records: ToolCallRecord[] = backgroundActivityStore.spawnRecords(threadId) ?? []
  if (records.length === 0) {
    try {
      records = await window.flow.toolCalls.list({ threadId, outputLimit: OUTPUT_LIMIT })
    } catch (error) {
      console.error('flow: sub-agent resolution fetch failed', { threadId, error })
    }
  }
  const target = subagentOpenTarget(task, records)
  if (target.kind === 'thread') {
    document.dispatchEvent(
      new CustomEvent('flow:open-subagent-thread', {
        detail: { parentThreadId: threadId, toolCallId: target.toolCallId },
      }),
    )
    return
  }
  document.dispatchEvent(
    new CustomEvent('flow:open-subagent-progress', {
      detail: { threadId, taskId: task.id, task, label: options.label, running: options.running },
    }),
  )
}
