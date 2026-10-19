/**
 * What a thread is still waiting on after its turn ended.
 *
 * THE PROBLEM THIS EXISTS FOR. When an agent backgrounds a sub-agent, the
 * parent turn finishes normally: the SDK sends `result`, the thread goes
 * `done`, the composer unlocks and every surface in the app goes quiet — while
 * four review agents are still running and will wake the session when they
 * land. The report was "seems to me that the chat is stopped, everywhere,
 * thread list, tasks, chat". Nothing was stopped; nothing had a word for
 * "resting, still owed work".
 *
 * WHERE THE FACTS COME FROM. All of them from the agent runtime, none from
 * reading a tool's output prose:
 *
 *   background_tasks_changed   the LEVEL — every live task, on every change
 *   task_started               a task's identity (description, sub-agent type)
 *   task_progress              how it is doing (elapsed, last tool used)
 *   task_notification          it settled (completed / failed / stopped)
 *
 * THE LEVEL IS THE TRUTH; THE EDGES ONLY DECORATE. The SDK emits the whole set
 * on every membership change specifically so that a consumer answering "is
 * background work running" can swap its set and be immune to a dropped edge —
 * pairing start/stop events instead is what leaves a spinner turning forever
 * after one gets lost. So `applyLevel` REPLACES, and a task the level no longer
 * lists is gone even if its `task_notification` never arrived. The edges may
 * only add detail to tasks the level already admits, and one that arrives for
 * an unknown id is dropped rather than resurrecting it.
 *
 * PER PROCESS, NOT PERSISTED. The SDK emits nothing at startup, so a session
 * whose CLI restarts must reset to empty and let the next membership change
 * repopulate — `reset` is that, and it is why none of this is written to the
 * thread store: a set of live tasks read back from disk describes a process
 * that no longer exists.
 *
 * DOM- and SDK-free so it can be unit-tested directly.
 */
import type { BackgroundTaskInfo } from '../../shared/ipc-contract'

/** One entry of the SDK's `background_tasks_changed` payload. */
export interface BackgroundTaskLevelEntry {
  task_id: string
  task_type: string
  description: string
}

/** The parts of `task_started` this tracker reads. */
export interface BackgroundTaskStarted {
  task_id: string
  description?: string
  subagent_type?: string
  task_type?: string
  /** Persisted ToolCallRecord id of the spawning tool call, RESOLVED BY THE
   *  BRIDGE from the event's `tool_use_id` (#1931) — not an SDK field. */
  toolCallId?: string
}

/** The parts of `task_progress` this tracker reads. */
export interface BackgroundTaskProgress {
  task_id: string
  description?: string
  subagent_type?: string
  last_tool_name?: string
  usage?: { duration_ms: number }
  /** Same resolved record id as on `BackgroundTaskStarted` (#1931). */
  toolCallId?: string
}

/** A clock, injected so the tick between progress reports is testable. */
export type Now = () => Date

export class BackgroundTaskTracker {
  /** Live tasks per thread, in the order the runtime last reported them. */
  readonly #byThread = new Map<string, Map<string, BackgroundTaskInfo>>()
  readonly #now: Now

  constructor(now: Now = () => new Date()) {
    this.#now = now
  }

  /**
   * Replace a thread's live set from a `background_tasks_changed` payload.
   *
   * Returns whether anything a surface draws actually changed, so a caller can
   * skip broadcasting a payload that says what the last one said — the level
   * fires on every membership change, including ones that add nothing here.
   *
   * Detail already learned from the edges SURVIVES for a task that is still
   * listed: the level payload carries ids only, and re-admitting a task from it
   * would blank the sub-agent type and elapsed time the progress reports had
   * filled in — the row would lose its name and its clock every few seconds.
   */
  applyLevel(threadId: string, entries: readonly BackgroundTaskLevelEntry[]): boolean {
    const previous = this.#byThread.get(threadId) ?? new Map<string, BackgroundTaskInfo>()
    const next = new Map<string, BackgroundTaskInfo>()
    for (const entry of entries) {
      const known = previous.get(entry.task_id)
      next.set(entry.task_id, {
        ...(known ?? { id: entry.task_id, startedAt: this.#now().toISOString() }),
        id: entry.task_id,
        taskType: entry.task_type,
        // The level's description wins: it is the runtime's current word for
        // the task, and a task that changed what it is doing says so here.
        description: entry.description,
        startedAt: known?.startedAt ?? this.#now().toISOString(),
      })
    }
    if (next.size === 0) this.#byThread.delete(threadId)
    else this.#byThread.set(threadId, next)
    return !sameTasks(previous, next)
  }

  /**
   * Fill in a task's identity from `task_started`.
   *
   * Only for a task the level already lists — see the class note. The two
   * messages race by design ("ordering relative to the bookends is
   * unspecified"), so a start that arrives first is simply dropped and its
   * detail comes back on the next progress report, which is the same shape.
   */
  applyStarted(threadId: string, event: BackgroundTaskStarted): boolean {
    return this.#decorate(threadId, event.task_id, (task) => ({
      ...task,
      description: event.description ?? task.description,
      taskType: event.task_type ?? task.taskType,
      agentType: event.subagent_type ?? task.agentType,
      toolCallId: event.toolCallId ?? task.toolCallId,
    }))
  }

  /** Fold a `task_progress` report into a live task. */
  applyProgress(threadId: string, event: BackgroundTaskProgress): boolean {
    return this.#decorate(threadId, event.task_id, (task) => ({
      ...task,
      description: event.description ?? task.description,
      agentType: event.subagent_type ?? task.agentType,
      lastTool: event.last_tool_name ?? task.lastTool,
      elapsedMs: event.usage?.duration_ms ?? task.elapsedMs,
      toolCallId: event.toolCallId ?? task.toolCallId,
    }))
  }

  /**
   * A task settled (`task_notification`).
   *
   * Removed here as well as by the level that accompanies it, because the two
   * orderings are unspecified and a settled task must never outlive its
   * notification: the level might be the one that goes missing.
   */
  applySettled(threadId: string, taskId: string): boolean {
    const tasks = this.#byThread.get(threadId)
    if (!tasks?.delete(taskId)) return false
    if (tasks.size === 0) this.#byThread.delete(threadId)
    return true
  }

  /** Forget a thread's tasks — its CLI process restarted, or it was deleted. */
  reset(threadId: string): boolean {
    return this.#byThread.delete(threadId)
  }

  /** A thread's live tasks, oldest first. Empty for a thread with none. */
  list(threadId: string): BackgroundTaskInfo[] {
    return [...(this.#byThread.get(threadId)?.values() ?? [])].sort((a, b) =>
      a.startedAt.localeCompare(b.startedAt),
    )
  }

  /** Every thread with live tasks — what a surface mounting mid-run reads. */
  snapshot(): Record<string, BackgroundTaskInfo[]> {
    const out: Record<string, BackgroundTaskInfo[]> = {}
    for (const threadId of this.#byThread.keys()) out[threadId] = this.list(threadId)
    return out
  }

  #decorate(
    threadId: string,
    taskId: string,
    change: (task: BackgroundTaskInfo) => BackgroundTaskInfo,
  ): boolean {
    const tasks = this.#byThread.get(threadId)
    const existing = tasks?.get(taskId)
    if (tasks === undefined || existing === undefined) return false
    const updated = change(existing)
    if (sameTask(existing, updated)) return false
    tasks.set(taskId, updated)
    return true
  }
}

/** Whether two task records would draw identically. */
function sameTask(a: BackgroundTaskInfo, b: BackgroundTaskInfo): boolean {
  return (
    a.id === b.id &&
    a.taskType === b.taskType &&
    a.description === b.description &&
    a.agentType === b.agentType &&
    a.lastTool === b.lastTool &&
    a.elapsedMs === b.elapsedMs &&
    // Not drawn, but it decides WHERE a click goes (#1931) — a task that just
    // learned its spawning record must rebroadcast, or every surface keeps
    // routing to the fallback progress view.
    a.toolCallId === b.toolCallId
  )
}

/** Whether two live sets would draw identically (same ids, same detail). */
function sameTasks(
  a: ReadonlyMap<string, BackgroundTaskInfo>,
  b: ReadonlyMap<string, BackgroundTaskInfo>,
): boolean {
  if (a.size !== b.size) return false
  for (const [id, task] of a) {
    const other = b.get(id)
    if (other === undefined || !sameTask(task, other)) return false
  }
  return true
}
