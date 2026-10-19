/**
 * Live sub-agent progress (#1931) — pure, DOM-free.
 *
 * The LEFT SIDEBAR lists a thread's running sub-agents from the live
 * `background-tasks` stream (`BackgroundTaskInfo`, keyed by the runtime task id).
 * Clicking one opens a right-side progress view driven by this model: it folds
 * each fresh snapshot into a running record and accumulates the sub-agent's
 * reported `lastTool` into a timeline (the only per-step signal the runtime
 * exposes for a backgrounded sub-agent). The view draws it; this decides it.
 */
import type { BackgroundTaskInfo } from '../../shared/ipc-contract'

export interface SubagentProgress {
  taskId: string
  title: string
  agentType: string | null
  status: 'running' | 'done'
  elapsedMs: number | null
  startedAt: string
  /** Tools the sub-agent has used, in first-seen order (its `lastTool` over time). */
  log: string[]
}

export function initialProgress(task: BackgroundTaskInfo, title: string): SubagentProgress {
  return {
    taskId: task.id,
    title,
    agentType: task.agentType ?? null,
    status: 'running',
    elapsedMs: task.elapsedMs ?? null,
    startedAt: task.startedAt,
    log: task.lastTool ? [task.lastTool] : [],
  }
}

/** Fold a fresh snapshot (the task is still alive) into the progress. */
export function foldProgress(prev: SubagentProgress, task: BackgroundTaskInfo): SubagentProgress {
  const log = prev.log.slice()
  const tool = task.lastTool ?? null
  if (tool && log[log.length - 1] !== tool) log.push(tool)
  return {
    ...prev,
    agentType: task.agentType ?? prev.agentType,
    status: 'running',
    elapsedMs: task.elapsedMs ?? prev.elapsedMs,
    log,
  }
}

/** Mark the sub-agent finished — it dropped off the live set. */
export function markDone(prev: SubagentProgress): SubagentProgress {
  return prev.status === 'done' ? prev : { ...prev, status: 'done' }
}
