/**
 * What a thread ran in the background, as rows — the pure part.
 *
 * "Background activity" is the work an agent hands off while it keeps talking:
 * the SUB-AGENTS it spawns (the `Agent` tool; `Task` in legacy rows). These are already persisted as
 * tool calls — with an input, an output and a status — so the list is derived
 * from those, not invented from a second store that forgets everything on
 * restart (background-tasks is live only). A row's `id` IS the tool call's id,
 * so the tab it opens fetches its own output (the sub-agent's execution log)
 * with `toolCalls:get`.
 *
 * Terminal/command (`Bash`) runs are intentionally excluded — this surface is
 * sub-agents only (#1931).
 *
 * DOM-free so it is unit-testable; the strip, the popover and the store all read
 * these functions and never re-derive a kind or a label of their own — one code
 * path decides what counts and what it is called (allowed-pattern #14).
 */
import type {
  BackgroundTaskInfo,
  ToolCallRecord,
  ToolCallStatus,
} from '../../shared/ipc-contract'

/** The two kinds of background work a thread shows. */
export type BackgroundActivityKind = 'subagent' | 'terminal'

/**
 * Where a row came from (#1931). `toolcall` rows are PERSISTED sub-agent tool calls —
 * clicking opens the sub-chat tab, keyed by the tool-call id. `task` rows are
 * LIVE background-tasks (a backgrounded sub-agent with no persisted tool call) —
 * clicking opens the live-progress tab, keyed by the runtime task id.
 */
export type BackgroundActivitySource = 'toolcall' | 'task'

export interface BackgroundActivityRow {
  /** tool-call id (source 'toolcall') or runtime task id (source 'task'). */
  id: string
  threadId: string
  kind: BackgroundActivityKind
  source: BackgroundActivitySource
  /** The one-line name: a sub-agent's description, or the command's first line. */
  label: string
  /** The second line: the sub-agent's type, or the full command. May be empty. */
  detail: string
  status: ToolCallStatus
  /** Still going — pending or running — so the row reads as alive. */
  running: boolean
  /** The live task behind a source 'task' row — passed to the progress tab. */
  task?: BackgroundTaskInfo
}

/**
 * The tool names a persisted sub-agent spawn arrives under. Observed live:
 * SDK 0.3.204 names the tool_use 'Agent' (its legacy rename map carries
 * Task → Agent) and stream-bridge persists `toolUse.name` verbatim; 'Task' is
 * the legacy name still present in already-persisted rows and older SDKs.
 */
export const SUBAGENT_TOOL_NAMES: readonly string[] = ['Agent', 'Task']

/**
 * The task types a LIVE background sub-agent carries. Observed live: SDK
 * 0.3.204's background_tasks_changed/task_started events say 'local_agent'
 * (stored verbatim by background-tasks.ts); 'subagent' is the legacy value.
 */
export const SUBAGENT_TASK_TYPES: readonly string[] = ['local_agent', 'subagent']

/**
 * Which kind of activity a tool name is, or `null` when it is not one.
 *
 * Only a sub-agent spawn (`SUBAGENT_TOOL_NAMES`) is background work; every
 * other tool — including `Bash`/terminal runs (#1931) and the agent's own
 * foreground tools (`Edit`, `Read`, `Grep`, …) — belongs in the transcript,
 * not here.
 */
export function activityKind(toolName: string): BackgroundActivityKind | null {
  if (SUBAGENT_TOOL_NAMES.includes(toolName)) return 'subagent'
  return null
}

/** A tool call's `inputJson` as an object — `{}` for null or malformed. Shared
 *  with the detail view so the list and the tab parse an input the same way. */
export function parseInput(json: string | null): Record<string, unknown> {
  if (json === null) return {}
  try {
    const value: unknown = JSON.parse(json)
    return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/** A trimmed string, or '' for anything that is not one. */
export function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/** How a status reads as a dot or a badge, in one place for every surface. */
export function statusTone(status: ToolCallStatus): 'running' | 'error' | 'done' {
  if (status === 'pending' || status === 'running') return 'running'
  if (status === 'error' || status === 'interrupted' || status === 'denied') return 'error'
  return 'done'
}

function firstLine(text: string): string {
  const line = text.split('\n', 1)[0] ?? text
  return line.trim()
}

/**
 * One tool call as a background-activity row, or `null` when it is not one.
 *
 * THE DESCRIPTION LEADS, THE COMMAND OR TYPE FOLLOWS — the same choice the
 * sidebar's background rows made (`background-task-rows.ts`): the per-task name
 * the caller wrote is what tells two rows apart, and eight `general-purpose`
 * agents reading `general-purpose` eight times is a list that looks duplicated.
 * When there is no description, the command's first line (a terminal run) or the
 * sub-agent's type (a spawn) is the honest fallback.
 */
export function toActivityRow(record: ToolCallRecord): BackgroundActivityRow | null {
  const kind = activityKind(record.toolName)
  if (kind === null) return null
  const input = parseInput(record.inputJson)
  const running = record.status === 'pending' || record.status === 'running'
  const description = str(input.description)

  if (kind === 'subagent') {
    const agentType = str(input.subagent_type)
    const label = description.length > 0 ? description : agentType.length > 0 ? agentType : 'Sub-agent'
    return { id: record.id, threadId: record.threadId, kind, source: 'toolcall', label, detail: agentType, status: record.status, running }
  }

  const command = str(input.command)
  const label = description.length > 0 ? description : command.length > 0 ? firstLine(command) : 'Command'
  return { id: record.id, threadId: record.threadId, kind, source: 'toolcall', label, detail: command, status: record.status, running }
}

/**
 * The background-activity rows of a thread's tool calls, IN THE GIVEN ORDER.
 *
 * `toolCalls:list` is oldest-first; the popover reverses for newest-first
 * display. Order is preserved here so the one reversal lives at the one surface
 * that shows it, not smeared across two.
 */
export function activityRows(records: readonly ToolCallRecord[]): BackgroundActivityRow[] {
  const rows: BackgroundActivityRow[] = []
  for (const record of records) {
    const row = toActivityRow(record)
    if (row !== null) rows.push(row)
  }
  return rows
}

/**
 * Rows for a thread's LIVE background-tasks (#1931) — the backgrounded sub-agents
 * that have no persisted Task tool call, so `activityRows` never sees them. Only
 * sub-agents (not shell/monitor); each is running by definition (the live set is
 * what is alive). A row carries its `BackgroundTaskInfo` so the progress tab can
 * open from it.
 */
export function taskActivityRows(
  tasks: readonly BackgroundTaskInfo[],
  threadId: string,
): BackgroundActivityRow[] {
  const rows: BackgroundActivityRow[] = []
  for (const task of tasks) {
    if (!SUBAGENT_TASK_TYPES.includes(task.taskType)) continue
    const description = task.description.trim()
    const agentType = (task.agentType ?? '').trim()
    const label = description.length > 0 ? description : agentType.length > 0 ? agentType : 'Sub-agent'
    rows.push({
      id: task.id,
      threadId,
      kind: 'subagent',
      source: 'task',
      label,
      detail: agentType,
      status: 'running',
      running: true,
      task,
    })
  }
  return rows
}

/**
 * The live tracker task standing behind a persisted spawn, or undefined.
 *
 * The deterministic join (`task.toolCallId` → record id), gated to sub-agent
 * task types so a shell or monitor task can never claim a spawn. ONE matcher
 * for every surface that asks "does the tracker know this spawn"
 * (allowed-pattern #14).
 */
export function trackerTaskFor(
  toolCallId: string,
  trackerTasks: readonly BackgroundTaskInfo[],
): BackgroundTaskInfo | undefined {
  return trackerTasks.find(
    (task) => SUBAGENT_TASK_TYPES.includes(task.taskType) && task.toolCallId === toolCallId,
  )
}

/** What `subagentRunState` answered, and which authority answered it. */
export interface SubagentRunState {
  running: boolean
  source: 'tracker' | 'record'
}

/**
 * THE lifecycle merge rule for a sub-agent spawn (#1931 follow-up): the
 * BackgroundTaskTracker is the LIVE authority, the persisted tool-call status
 * is the fallback.
 *
 *   - The tracker currently holds a task claiming this spawn's tool-call id →
 *     RUNNING, whatever the persisted row says. This fixes the backgrounded
 *     caveat: a backgrounded agent's tool call settles EARLY, while the task
 *     is still working — the tracker knows the truth.
 *   - No matching tracker entry → the persisted status decides. This covers
 *     app restarts (the tracker is empty, the rows survive) and foreground
 *     spawns the tracker never carried. A tracker entry claiming a DIFFERENT
 *     tool call changes nothing.
 *
 * `record` may be null when the row is unknown (not yet read, or gone);
 * `toolCallId` then still allows the tracker join, and a null record with no
 * tracker entry reads as not running. ONE code path for every consumer — the
 * sidebar fold, the composer send-gate, the activity rows — so no two
 * surfaces can disagree about whether a sub-agent is alive (allowed-pattern
 * #14).
 */
export function subagentRunState(
  record: Pick<ToolCallRecord, 'id' | 'status'> | null,
  trackerTasks: readonly BackgroundTaskInfo[],
  toolCallId?: string,
): SubagentRunState {
  const id = record?.id ?? toolCallId
  if (id !== undefined && trackerTaskFor(id, trackerTasks) !== undefined) {
    return { running: true, source: 'tracker' }
  }
  return {
    running: record !== null && (record.status === 'pending' || record.status === 'running'),
    source: 'record',
  }
}

/**
 * Merge the persisted tool-call rows with the live task rows, oldest-first.
 *
 * TWO JOINS, IN ORDER:
 *
 *   1. DETERMINISTIC — a live task claiming a persisted spawn's id folds INTO
 *      that row, whose running state then comes from the merge rule
 *      (`subagentRunState`): a backgrounded task alive over an early-settled
 *      tool-call row shows as ONE row, RUNNING — never two rows, never a
 *      "done" dot on work that is still going.
 *   2. LABEL fallback — a task with no claimed id that matches a persisted
 *      row's label is dropped; the persisted one wins because it can open the
 *      full sub-chat (the two id spaces can't dedupe by id).
 *
 * The un-joined sets don't otherwise overlap: a foreground agent persists a
 * tool call and isn't in the live set; a backgrounded one is live and (#1931)
 * may ALSO have a persisted row — that is case 1.
 */
export function mergeActivityRows(
  toolcallRows: readonly BackgroundActivityRow[],
  taskRows: readonly BackgroundActivityRow[],
): BackgroundActivityRow[] {
  const liveTasks: BackgroundTaskInfo[] = []
  for (const row of taskRows) {
    if (row.running && row.task !== undefined) liveTasks.push(row.task)
  }
  const merged = toolcallRows.map((row) => {
    if (row.kind !== 'subagent') return row
    const state = subagentRunState({ id: row.id, status: row.status }, liveTasks)
    if (state.source === 'tracker' && !row.running) {
      return { ...row, running: true, status: 'running' as ToolCallStatus }
    }
    return row
  })
  const toolcallIds = new Set(toolcallRows.map((row) => row.id))
  const seenLabels = new Set(toolcallRows.map((row) => row.label))
  const freshTasks = taskRows.filter((row) => {
    const claimed = row.task?.toolCallId
    // Joined into its persisted row above — one spawn, one row.
    if (claimed !== undefined && toolcallIds.has(claimed)) return false
    return !seenLabels.has(row.label)
  })
  return [...merged, ...freshTasks]
}

/**
 * The persisted tool-call id a LIVE background task corresponds to, or `null`
 * when it cannot be told apart (#1931).
 *
 * ONLY A SUB-AGENT TASK MAY ATTEMPT THE JOIN AT ALL: a shell or monitor task
 * has no spawn record to resolve to, but its description can still EQUAL an
 * Agent spawn's (the sidebar routes every live task row through this), and the
 * heuristic below would then open a chat for work that is not a sub-agent. The
 * taskType gate sits before any resolution attempt — non-sub-agent tasks read
 * as null (the progress fallback), always.
 *
 * TWO ID SPACES, ONE JOIN, in this order:
 *
 *   1. DETERMINISTIC — the runtime's task events carry the spawning
 *      `tool_use_id`, which main resolves to the persisted record id and ships
 *      as `task.toolCallId`. Verified against the given records (the row must
 *      exist and be a sub-agent spawn) so a stale claim can never open a chat
 *      for something else; a claimed id that is not in the list returns null —
 *      it does NOT fall through to the heuristic, because a deterministic claim
 *      that cannot be verified is exactly when a guess is most dangerous.
 *   2. HEURISTIC — description equality against the spawn input's
 *      `description` (the same field both sides display), narrowed by
 *      `subagent_type` when both sides carry one. One match wins; several
 *      matches prefer the still-running ones; anything still ambiguous is null.
 *
 * Null means "open the live-progress fallback", never "pick the closest".
 */
export function resolveTaskToolCallId(
  task: BackgroundTaskInfo,
  records: readonly ToolCallRecord[],
): string | null {
  if (!SUBAGENT_TASK_TYPES.includes(task.taskType)) return null
  if (task.toolCallId !== undefined) {
    const claimed = records.find(
      (record) => record.id === task.toolCallId && activityKind(record.toolName) === 'subagent',
    )
    return claimed?.id ?? null
  }

  const description = task.description.trim()
  if (description.length === 0) return null
  const agentType = (task.agentType ?? '').trim()
  const candidates = records.filter((record) => {
    if (activityKind(record.toolName) !== 'subagent') return false
    const input = parseInput(record.inputJson)
    if (str(input.description) !== description) return false
    if (agentType.length > 0) {
      const recordType = str(input.subagent_type)
      if (recordType.length > 0 && recordType !== agentType) return false
    }
    return true
  })
  if (candidates.length === 1) return candidates[0]?.id ?? null
  const running = candidates.filter(
    (record) => record.status === 'pending' || record.status === 'running',
  )
  return running.length === 1 ? (running[0]?.id ?? null) : null
}

/** Where a click on a LIVE sub-agent row goes (#1931). */
export type SubagentOpenTarget =
  | { kind: 'thread'; toolCallId: string }
  | { kind: 'progress' }

/**
 * THE routing decision for a live sub-agent click, shared by every surface
 * (popover live rows, sidebar agent-task rows — allowed-pattern #14): resolved
 * to a persisted spawn → the full child-thread chat in the MAIN pane;
 * unresolvable or ambiguous → the right-side live-progress fallback.
 */
export function subagentOpenTarget(
  task: BackgroundTaskInfo,
  records: readonly ToolCallRecord[],
): SubagentOpenTarget {
  const toolCallId = resolveTaskToolCallId(task, records)
  return toolCallId === null ? { kind: 'progress' } : { kind: 'thread', toolCallId }
}

/**
 * The compact one-line presentation a FINISHED sub-agent spawn card collapses
 * to in the parent feed (#1931 follow-up). Null while the spawn is still
 * running (live progress keeps the full card) and for every non-sub-agent
 * tool. Label/detail use the SAME derivation the activity rows use
 * (description → subagent_type → 'Sub-agent'), so the chip and the popover can
 * never name one spawn two ways (allowed-pattern #14).
 *
 * Terminal is `statusTone(status) !== 'running'` — the one place every
 * activity surface already reads "still going" from. Known caveat accepted: a
 * BACKGROUNDED agent's tool call may complete early; the chip then shows
 * finished while the background task still runs, which is what the persisted
 * record honestly says.
 */
export interface SubagentSpawnChip {
  /** The spawn's description (same leading field the activity rows show). */
  label: string
  /** The sub-agent type; may be ''. */
  detail: string
  /** The subtle state word the collapsed line carries. */
  state: 'finished' | 'failed'
}

export function subagentSpawnChip(
  toolName: string,
  inputJson: string | null,
  status: ToolCallStatus,
): SubagentSpawnChip | null {
  if (activityKind(toolName) !== 'subagent') return null
  const tone = statusTone(status)
  if (tone === 'running') return null
  const input = parseInput(inputJson)
  const description = str(input.description)
  const agentType = str(input.subagent_type)
  const label = description.length > 0 ? description : agentType.length > 0 ? agentType : 'Sub-agent'
  return { label, detail: agentType, state: tone === 'done' ? 'finished' : 'failed' }
}

export interface ActivityStripState {
  /**
   * Shown only while a sub-agent is actually RUNNING (user, 2026-10-13: "even
   * when the sub agents already finished, we are still showing this sub agents
   * activity here … that looks like something that still running").
   *
   * It used to show whenever the thread had ever spawned one, so a strip with
   * two green dots in it sat above the composer for the rest of the
   * conversation — a live indicator reporting something that finished minutes
   * ago. The finished runs are not lost with it: every spawn is already a
   * one-line chip in the transcript (`subagentSpawnChip`, right above), at the
   * point in the conversation where it happened, and pressing either one goes
   * through the same `flow:open-subagent-thread` — so the strip was the second
   * door to a room the chat already opens onto.
   */
  show: boolean
  count: number
  runningCount: number
  label: string
  title: string
}

/**
 * What the footer button shows — pure, so the button and any other surface that
 * carries the same count can never disagree.
 */
export function activityStripState(rows: readonly BackgroundActivityRow[]): ActivityStripState {
  const count = rows.length
  const runningCount = rows.filter((row) => row.running).length
  const noun = count === 1 ? 'activity' : 'activities'
  const title =
    runningCount > 0
      ? `${String(runningCount)} of ${String(count)} sub-agent ${noun} running`
      : `${String(count)} sub-agent ${noun}`
  // THE COUNT STILL COUNTS EVERYTHING, because it is the number of rows the
  // popover lists and the two must not disagree. Only the showing is live: a
  // strip that appears while one of four runs says "4", and its title says
  // which of them is running.
  return { show: runningCount > 0, count, runningCount, label: 'Sub-agents activity', title }
}
