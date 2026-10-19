/**
 * The sidebar's view of what a thread is still waiting on.
 *
 * The report this exists for: a thread launched four review agents, its turn
 * ended, and every surface went still — "we are not having any indicator of
 * subagent in background, seems to me that the chat is stopped, everywhere,
 * thread list, tasks, chat". The work was running the whole time; nothing drew
 * it.
 *
 * Two things follow from that, and they are separate on purpose:
 *
 *  1. A thread with live background tasks READS AS ALIVE, whatever its turn
 *     status says. `status` is about the turn — it is what unlocks the composer
 *     and moves a Kanban card, and a thread awaiting its agents genuinely is
 *     resting by that measure. Conflating the two would either lock a composer
 *     that should accept typing or leave the list silent, and this is the
 *     second mistake made twice already.
 *  2. The tasks THEMSELVES get rows, nested under the thread — one line each,
 *     with what it is and how long it has been at it.
 *
 * DOM-free so it is unit-testable (the sidebar component touches
 * customElements at import time).
 */
import type { BackgroundTaskInfo, ThreadStatus } from '../../shared/ipc-contract'

/**
 * Whether a row should read as ALIVE — its agent is moving, or something it
 * started still is.
 *
 * Takes the count rather than the tasks so callers that only track "how many"
 * need not carry the payloads.
 */
export function threadIsLive(status: ThreadStatus, backgroundTaskCount: number): boolean {
  return status === 'working' || backgroundTaskCount > 0
}

/**
 * How long a task has been running, in milliseconds, at time `now`.
 *
 * The runtime's own `elapsedMs` is authoritative WHEN IT ARRIVES — it is the
 * task's real duration, measured where the task runs. But progress reports come
 * irregularly (seconds apart, sometimes not at all for a quiet task), and a
 * timer that only moved when one landed would sit frozen at "4s" for a minute
 * and read as a hung agent. So the clock ticks locally from the last thing the
 * runtime said, and each report re-syncs it:
 *
 *   reported elapsed  +  (now − when we heard it)
 *
 * `reportedAt` is when the local process took delivery, not a runtime
 * timestamp — the two clocks are never mixed, only ever differenced against
 * themselves.
 */
export function taskElapsedMs(
  task: Pick<BackgroundTaskInfo, 'elapsedMs' | 'startedAt'>,
  now: Date,
  reportedAt?: Date,
): number {
  const since = (from: string | Date): number =>
    Math.max(0, now.getTime() - new Date(from).getTime())
  if (task.elapsedMs === undefined) return since(task.startedAt)
  return task.elapsedMs + (reportedAt === undefined ? 0 : since(reportedAt))
}

/**
 * A duration as the reference writes it: `21s`, `4m`, `1h 12m`.
 *
 * SECONDS UNTIL A MINUTE, THEN MINUTES. A running agent's first half-minute is
 * the part a person actually watches, and `0m` for all of it says nothing;
 * past an hour the seconds are noise and the hour is the news. Nothing is ever
 * rendered with more than two units — a timer is a glance, not a measurement.
 */
export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`
}

/**
 * What a background task's row is called.
 *
 * THE DESCRIPTION, NOT THE TYPE — and the first cut had this exactly backwards.
 * It preferred `agentType` on the reasoning that it was "the word a person used
 * when they asked for the work". That is true of a NAMED sub-agent type, and
 * false of the one people actually use: eight parallel `general-purpose` agents
 * rendered as eight identical rows reading `general-purpose`, which is a list
 * that looks duplicated, cannot be told apart, and answers no question a reader
 * has (reported 2026-09-08 as "we should have unique name for each one").
 *
 * `description` is the per-task name the caller wrote — "Review: logic and
 * bugs", "Phase 3 — bash grouping" — so it is what distinguishes one row from
 * its siblings. The type goes on the tooltip, where a coarse label costs
 * nothing.
 *
 * Never both: two names on a 22px row means neither is readable.
 */
export function taskLabel(task: BackgroundTaskInfo): string {
  const described = task.description.trim()
  if (described.length > 0) return described
  const typed = task.agentType?.trim() ?? ''
  return typed.length > 0 ? typed : task.taskType
}

/**
 * The row's hover text: everything the label could not fit.
 *
 * Assembled rather than templated so a task missing a field simply has a
 * shorter tooltip — an empty parenthesis or a dangling separator is how a
 * hover ends up reading as a bug.
 */
export function taskTooltip(task: BackgroundTaskInfo): string {
  const lines = [task.description]
  if (task.agentType !== undefined) lines.push(`Agent: ${task.agentType}`)
  else lines.push(`Type: ${task.taskType}`)
  // The label shows the description now, so the type is what the hover adds.
  if (task.lastTool !== undefined) lines.push(`Last tool: ${task.lastTool}`)
  return lines.filter((line) => line.trim().length > 0).join('\n')
}

/**
 * The chat's standing note while a resting thread still has work out.
 *
 * NAMES THE WORK WHEN THERE IS ONE OF IT, counts when there are several. One
 * agent has a name worth reading; four have four names too long for a line, and
 * the number is the fact that matters — the sidebar's nested rows are where the
 * four are listed.
 *
 * Never "Working…": the turn IS over, the composer is free, and saying the
 * agent is working would misdescribe a pane you can type into.
 */
export function backgroundActivityLabel(tasks: readonly BackgroundTaskInfo[]): string {
  if (tasks.length === 0) return ''
  if (tasks.length === 1) {
    const only = tasks[0]
    return only === undefined ? '' : `Running in the background: ${taskLabel(only)}`
  }
  return `${tasks.length} agents running in the background`
}
