/**
 * The "Background work" panel, as data — the pure part (plan_mid-run-subtasks,
 * FR-9 to FR-16).
 *
 * Two kinds of background work reach a thread:
 *
 *   - the person's SUBTASKS — work the agent handed off under a ticket
 *     (`SubtaskRecord`, written only by main's registry). They have a source
 *     message, a state, an attempt chain, files written and overlaps, and the
 *     person can Stop, Steer and Retry them;
 *   - SKILL sub-agents — every other Agent spawn (a skill's phases, review
 *     passes). They show which run they belong to and offer no actions.
 *
 * Both arrive as activity rows (`background-activity-model`, one row per Agent
 * tool call or live task); a subtask's row is found by its `toolCallId` (the
 * row id is the tool-call id), so one spawn is never drawn twice.
 *
 * WHAT A RUN IS. Nothing stored says which skill run a sub-agent belongs to,
 * so the run is the REQUEST it started in: the newest person's message at or
 * before its start. A request whose message is a slash command is labelled by
 * that command, humanised ("Execute plan"); every other request's sub-agents
 * share one group, "Other background work". The command name never reaches
 * the screen as typed (forbidden-pattern #12).
 *
 * THE CURRENT REQUEST starts at the newest person's message. The pill counts
 * work running or queued anywhere (it is live by definition) and failures of
 * the current request; an older failure is history and sits in Done.
 *
 * DOM-free and clock-injected, so every rule here is unit-tested.
 */
import type { SubtaskRecord, SubtaskState, ThreadMessage, ToolCallRecord } from '../../shared/ipc-contract'
import { statusTone, type BackgroundActivityRow, type WorkCounts } from './background-activity-model'
import { stepHeadline } from './request-row-model'

/** A person's message, as far as the panel needs one. */
export interface SourceMessage {
  id: string
  content: string
  createdAt: string
}

export type WorkSectionState = 'running' | 'queued' | 'failed' | 'done'
export type WorkTone = 'running' | 'queued' | 'error' | 'done' | 'stopped'

/** One attempt of a retried subtask, oldest first. */
export interface WorkAttempt {
  attempt: number
  tone: WorkTone
  /** `Attempt 1 — 2 of 18 tests failed`. */
  text: string
  /** `4m`, or null when it never started. */
  duration: string | null
}

export interface WorkItem {
  /** Stable across renders: `subtask:<head ticket>` or `skill:<row id>`. */
  key: string
  origin: 'subtask' | 'skill'
  title: string
  tone: WorkTone
  /** The second line: `from “…”`, `part of the plan run`, the error, or the
   *  queued note. Null for none. */
  subline: string | null
  /** The facts at the end of the row: `3m 12s`, `attempt 2 · 4m`, `2 runs`. */
  meta: string
  /** When the work started, for a ticking duration while it runs. */
  startedAtMs: number | null
  /** The person's whole message, for "You asked". */
  sourceText: string | null
  overlapFiles: string[]
  filesWritten: string[]
  error: string | null
  /** Every attempt, oldest first — only when there was more than one. */
  attempts: WorkAttempt[]
  /** Same-title skill runs folded into this row (1 = just this one). */
  runs: number
  /** The subtask's ticket (head of its chain); null for a skill row. */
  ticket: string | null
  /** The Agent tool call behind the row, for steps and the full conversation. */
  toolCallId: string | null
  /** The activity row behind it, when one exists — a live task opens through it. */
  row: BackgroundActivityRow | null
  canStop: boolean
  canSteer: boolean
  canRetry: boolean
}

export interface WorkGroup {
  /** `subtasks` (Your subtasks) or a run's key. */
  key: string
  /** `Your subtasks`, `Execute plan · 4 phases`, `Other background work`. */
  title: string
  items: WorkItem[]
}

export interface WorkSection {
  state: WorkSectionState
  /** `Running · 4`. */
  title: string
  count: number
  /** Done starts closed. */
  collapsed: boolean
  groups: WorkGroup[]
}

export interface BackgroundWorkView {
  sections: WorkSection[]
  counts: WorkCounts
}

export interface BackgroundWorkInput {
  rows: readonly BackgroundActivityRow[]
  subtasks: readonly SubtaskRecord[]
  /** The person's messages the panel knows of, any order. */
  userMessages: readonly SourceMessage[]
  now: number
}

/** How many subtasks run at once — the registry's cap, said on queued rows. */
export const SUBTASK_SLOTS = 3
export const QUEUED_NOTE = `starts when a slot is free · ${String(SUBTASK_SLOTS)} run at once`
export const YOUR_SUBTASKS = 'Your subtasks'
export const OTHER_WORK = 'Other background work'
const SEPARATOR = ' ' + String.fromCharCode(183) + ' '
const PREVIEW_CHARS = 48

const SECTION_TITLES: Record<WorkSectionState, string> = {
  running: 'Running',
  queued: 'Queued',
  failed: 'Failed',
  done: 'Done',
}

function ms(iso: string | null | undefined): number | null {
  if (iso === null || iso === undefined) return null
  const value = Date.parse(iso)
  return Number.isNaN(value) ? null : value
}

/** `3m 12s` while running; `4m` or `41s` once ended. */
export function formatWorkDuration(durationMs: number, running: boolean): string {
  const total = Math.max(0, Math.floor(durationMs / 1000))
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  if (running) return `${String(minutes)}m ${String(seconds).padStart(2, '0')}s`
  return minutes > 0 ? `${String(minutes)}m` : `${String(seconds)}s`
}

function duration(start: number | null, end: number | null, now: number, running: boolean): string | null {
  if (start === null) return null
  const stop = running ? now : (end ?? now)
  return formatWorkDuration(stop - start, running)
}

/** The first line of a text, cut to a preview. */
export function previewOf(text: string, limit = PREVIEW_CHARS): string {
  const line = text.trim().split('\n', 1)[0]?.trim() ?? ''
  if (line.length <= limit) return line
  return line.slice(0, limit).trimEnd() + '…'
}

/**
 * The run a person's message starts, when it is a slash command: `/execute-plan
 * @plan.md` is `{ name: 'Execute plan', noun: 'plan' }`. Null for anything else.
 */
export function commandRun(content: string): { name: string; noun: string } | null {
  const match = /^\/([a-z][a-z0-9-]*)(?:\s|$)/i.exec(content.trim())
  if (match === null) return null
  const words = (match[1] ?? '').toLowerCase().split('-').filter((word) => word.length > 0)
  if (words.length === 0) return null
  const phrase = words.join(' ')
  const name = phrase.charAt(0).toUpperCase() + phrase.slice(1)
  // "the plan run" reads better than "the execute plan run"; every other run
  // is named by its own words.
  const noun = phrase === 'execute plan' ? 'plan' : phrase
  return { name, noun }
}

function subtaskTone(state: SubtaskState): WorkTone {
  switch (state) {
    case 'running':
      return 'running'
    case 'queued':
      return 'queued'
    case 'failed':
      return 'error'
    case 'stopped':
      return 'stopped'
    case 'done':
      return 'done'
  }
}

function rowTone(row: BackgroundActivityRow): WorkTone {
  if (row.running) return 'running'
  if (row.status === 'interrupted') return 'stopped'
  return statusTone(row.status) === 'error' ? 'error' : 'done'
}

/** The retry chains: each head (the newest attempt) with its attempts, oldest first. */
export function subtaskChains(subtasks: readonly SubtaskRecord[]): SubtaskRecord[][] {
  const byTicket = new Map(subtasks.map((record) => [record.ticket, record]))
  const retried = new Set<string>()
  for (const record of subtasks) if (record.retryOf !== null) retried.add(record.retryOf)
  const chains: SubtaskRecord[][] = []
  for (const record of subtasks) {
    if (retried.has(record.ticket)) continue
    const chain: SubtaskRecord[] = [record]
    const seen = new Set<string>([record.ticket])
    let previous = record.retryOf
    while (previous !== null && !seen.has(previous)) {
      const earlier = byTicket.get(previous)
      if (earlier === undefined) break
      seen.add(previous)
      chain.unshift(earlier)
      previous = earlier.retryOf
    }
    chains.push(chain)
  }
  return chains
}

/** The newest person's message at or before `at`, from a list sorted oldest first. */
function requestOf(sorted: readonly SourceMessage[], at: number | null): SourceMessage | null {
  if (at === null) return null
  let found: SourceMessage | null = null
  for (const message of sorted) {
    const created = ms(message.createdAt)
    if (created === null || created > at) break
    found = message
  }
  return found
}

interface Placed {
  section: WorkSectionState
  groupKey: string
  groupTitle: string
  item: WorkItem
}

function sectionOf(tone: WorkTone, inCurrentRequest: boolean): WorkSectionState {
  if (tone === 'running') return 'running'
  if (tone === 'queued') return 'queued'
  if (tone === 'error' && inCurrentRequest) return 'failed'
  return 'done'
}

function subtaskItem(
  chain: SubtaskRecord[],
  rowsById: Map<string, BackgroundActivityRow>,
  messages: Map<string, SourceMessage>,
  now: number,
): WorkItem {
  const head = chain[chain.length - 1] as SubtaskRecord
  const tone = subtaskTone(head.state)
  const running = tone === 'running'
  const start = ms(head.startedAt)
  const time = duration(start, ms(head.endedAt), now, running)
  const source = head.fromMessageId === null ? null : (messages.get(head.fromMessageId) ?? null)
  const error = head.error === null || head.error.trim() === '' ? null : head.error.trim()

  let subline: string | null
  if (tone === 'queued') subline = QUEUED_NOTE
  else if (tone === 'error' && error !== null) subline = previewOf(error, 80)
  else subline = source === null ? null : `from “${previewOf(source.content)}”`

  const meta: string[] = []
  if (head.attempt > 1 || tone === 'error') meta.push(`attempt ${String(head.attempt)}`)
  if (tone === 'stopped') meta.push('stopped')
  if (time !== null && tone !== 'queued') meta.push(time)

  const attempts: WorkAttempt[] =
    chain.length > 1
      ? chain.map((record) => {
          const attemptError = record.error === null ? '' : previewOf(record.error, 60)
          const recordTone = subtaskTone(record.state)
          const word =
            attemptError !== ''
              ? attemptError
              : recordTone === 'running'
                ? 'running'
                : recordTone === 'queued'
                  ? 'waiting for a slot'
                  : recordTone === 'stopped'
                    ? 'stopped'
                    : recordTone === 'error'
                      ? 'failed'
                      : 'done'
          return {
            attempt: record.attempt,
            tone: recordTone,
            text: `Attempt ${String(record.attempt)} — ${word}`,
            duration: duration(ms(record.startedAt), ms(record.endedAt), now, recordTone === 'running'),
          }
        })
      : []

  return {
    key: `subtask:${head.ticket}`,
    origin: 'subtask',
    title: head.title,
    tone,
    subline,
    meta: meta.join(SEPARATOR),
    startedAtMs: running ? start : null,
    sourceText: source?.content ?? null,
    overlapFiles: [...head.overlapFiles],
    filesWritten: [...head.filesWritten],
    error,
    attempts,
    runs: 1,
    ticket: head.ticket,
    toolCallId: head.toolCallId,
    row: head.toolCallId === null ? null : (rowsById.get(head.toolCallId) ?? null),
    canStop: tone === 'running',
    canSteer: tone === 'running',
    canRetry: tone === 'error',
  }
}

/**
 * The whole panel: sections by state (Running, Queued, Failed, Done), and in
 * each, the person's subtasks first, then skill work by run. A retry chain is
 * one row; same-title skill rows of one run are one row that says `N runs`.
 */
export function backgroundWorkView(input: BackgroundWorkInput): BackgroundWorkView {
  const { now } = input
  const sorted = [...input.userMessages].sort((a, b) => (ms(a.createdAt) ?? 0) - (ms(b.createdAt) ?? 0))
  const messages = new Map(sorted.map((message) => [message.id, message]))
  const newest = sorted.length > 0 ? sorted[sorted.length - 1] : undefined
  const requestStart = newest === undefined ? null : ms(newest.createdAt)
  const inCurrent = (at: number | null): boolean => requestStart === null || at === null || at >= requestStart

  const rowsById = new Map(input.rows.map((row) => [row.id, row]))
  // Every id a subtask can be known by, so its spawn never shows twice.
  const subtaskIds = new Set<string>()
  for (const record of input.subtasks) {
    if (record.toolCallId !== null) subtaskIds.add(record.toolCallId)
    if (record.sdkTaskId !== null) subtaskIds.add(record.sdkTaskId)
  }

  const placed: Placed[] = []

  for (const chain of subtaskChains(input.subtasks)) {
    const item = subtaskItem(chain, rowsById, messages, now)
    const head = chain[chain.length - 1] as SubtaskRecord
    const at = ms(head.endedAt) ?? ms(head.createdAt)
    placed.push({ section: sectionOf(item.tone, inCurrent(at)), groupKey: 'subtasks', groupTitle: YOUR_SUBTASKS, item })
  }

  // Skill rows, grouped by run, same titles folded within a run.
  interface Run {
    key: string
    title: string
    noun: string | null
    rows: BackgroundActivityRow[]
  }
  const runs = new Map<string, Run>()
  for (const row of input.rows) {
    if (row.kind !== 'subagent') continue
    if (subtaskIds.has(row.id)) continue
    if (row.task?.toolCallId !== undefined && subtaskIds.has(row.task.toolCallId)) continue
    const request = requestOf(sorted, ms(row.startedAt))
    const command = request === null ? null : commandRun(request.content)
    const key = command === null || request === null ? 'run:other' : `run:${request.id}`
    let run = runs.get(key)
    if (run === undefined) {
      run = { key, title: command?.name ?? OTHER_WORK, noun: command?.noun ?? null, rows: [] }
      runs.set(key, run)
    }
    run.rows.push(row)
  }

  for (const run of runs.values()) {
    const phases = run.rows.every((row) => /^phase\b/i.test(row.label))
    const total = run.rows.length
    const title =
      run.noun === null
        ? run.title
        : `${run.title}${SEPARATOR}${String(total)} ${phases ? (total === 1 ? 'phase' : 'phases') : total === 1 ? 'agent' : 'agents'}`
    const byLabel = new Map<string, BackgroundActivityRow[]>()
    for (const row of run.rows) {
      const same = byLabel.get(row.label)
      if (same === undefined) byLabel.set(row.label, [row])
      else same.push(row)
    }
    for (const same of byLabel.values()) {
      const row = same[same.length - 1] as BackgroundActivityRow
      const tone = rowTone(row)
      const running = tone === 'running'
      const start = ms(row.startedAt)
      const time = duration(start, ms(row.endedAt ?? null), now, running)
      const meta: string[] = []
      if (same.length > 1) meta.push(`${String(same.length)} runs`)
      if (time !== null) meta.push(time)
      const item: WorkItem = {
        key: `skill:${row.id}`,
        origin: 'skill',
        title: row.label,
        tone,
        subline: run.noun === null ? null : `part of the ${run.noun} run`,
        meta: meta.join(SEPARATOR),
        startedAtMs: running ? start : null,
        sourceText: null,
        overlapFiles: [],
        filesWritten: [],
        error: null,
        attempts: [],
        runs: same.length,
        ticket: null,
        toolCallId: row.source === 'toolcall' ? row.id : (row.task?.toolCallId ?? null),
        row,
        canStop: false,
        canSteer: false,
        canRetry: false,
      }
      placed.push({ section: sectionOf(tone, inCurrent(ms(row.endedAt ?? null) ?? start)), groupKey: run.key, groupTitle: title, item })
    }
  }

  const order: WorkSectionState[] = ['running', 'queued', 'failed', 'done']
  const sections: WorkSection[] = []
  for (const state of order) {
    const here = placed.filter((entry) => entry.section === state)
    if (here.length === 0) continue
    const groups: WorkGroup[] = []
    const byKey = new Map<string, WorkGroup>()
    // Your subtasks first, then the runs in the order they started.
    const ranked = [...here.filter((entry) => entry.groupKey === 'subtasks'), ...here.filter((entry) => entry.groupKey !== 'subtasks')]
    for (const entry of ranked) {
      let group = byKey.get(entry.groupKey)
      if (group === undefined) {
        group = { key: entry.groupKey, title: entry.groupTitle, items: [] }
        byKey.set(entry.groupKey, group)
        groups.push(group)
      }
      group.items.push(entry.item)
    }
    // Newest first inside a group: the work a reader just watched start.
    for (const group of groups) group.items.reverse()
    sections.push({
      state,
      title: `${SECTION_TITLES[state]}${SEPARATOR}${String(here.length)}`,
      count: here.length,
      collapsed: state === 'done',
      groups,
    })
  }

  const count = (state: WorkSectionState): number =>
    sections.find((section) => section.state === state)?.count ?? 0
  return { sections, counts: { running: count('running'), queued: count('queued'), failed: count('failed') } }
}

/** One numbered step of a sub-agent's work, for an opened row. */
export interface WorkStep {
  number: number
  text: string
  tools: number
  running: boolean
}

/**
 * A sub-agent's transcript as numbered steps: each assistant message with
 * something to say opens a step, and the tools after it count toward it.
 * Tools before any message form a head-less step. The last step is running
 * while the work is.
 */
export function transcriptSteps(
  messages: readonly ThreadMessage[],
  toolCalls: readonly ToolCallRecord[],
  running: boolean,
): WorkStep[] {
  const items: Array<{ at: string; message?: ThreadMessage; tool?: ToolCallRecord }> = [
    ...messages.map((message) => ({ at: message.createdAt, message })),
    ...toolCalls.map((tool) => ({ at: tool.startedAt, tool })),
  ]
  items.sort((a, b) => {
    if (a.at !== b.at) return a.at < b.at ? -1 : 1
    if ((a.message === undefined) !== (b.message === undefined)) return a.message !== undefined ? -1 : 1
    return 0
  })
  const steps: Array<{ text: string | null; tools: number }> = []
  for (const item of items) {
    if (item.message !== undefined) {
      if (item.message.role !== 'assistant' || item.message.content.trim() === '') continue
      steps.push({ text: item.message.content, tools: 0 })
      continue
    }
    if (steps.length === 0) steps.push({ text: null, tools: 0 })
    const last = steps[steps.length - 1]
    if (last !== undefined) last.tools += 1
  }
  return steps.map((step, index) => ({
    number: index + 1,
    text: stepHeadline(step.text),
    tools: step.tools,
    running: running && index === steps.length - 1,
  }))
}

/** The message the composer sends to retry a failed subtask. */
export function retryPrompt(title: string, ticket: string): string {
  return `Please retry the subtask “${title.replace(/\s+/g, ' ').trim()}” (ticket ${ticket}).`
}
