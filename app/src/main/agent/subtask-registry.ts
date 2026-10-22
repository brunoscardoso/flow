/**
 * SubtaskRegistry — the ONLY writer of subtask rows (plan_mid-run-subtasks,
 * Phase 3; allowed-pattern #14).
 *
 * A subtask is work the agent hands to a background sub-agent while the person
 * keeps talking. Its life, and who moves it:
 *
 *   start      `start_subtask` asks for a ticket. The cap lives HERE: at most
 *              SUBTASK_RUNNING_CAP rows per thread hold a slot (`running`); a
 *              fourth is stored `queued` and the agent is told to wait.
 *   link       the Agent PreToolUse hook sees `name` = the ticket and links the
 *              Agent tool call. An unknown ticket, an ended one, or a queued one
 *              while every slot is taken is refused with a reason the agent can
 *              act on.
 *   started    `task_started` carries the Agent call's `tool_use_id` and the
 *              runtime's `task_id`; the task id is stored on the linked row. It
 *              has no `name`, which is why the hook links first (probe verdict c).
 *   settled    `task_notification` ends the row done / failed / stopped, and
 *              names the oldest queued ticket that may now start.
 *   writes     the edit hook reports every write. A sub-agent's write carries
 *              `agent_id` (= the task id); the main agent's carries none (probe
 *              verdict f). A file written by two sides in one request is marked
 *              on the subtask row(s) as an overlap. Nothing is blocked.
 *   stop       answers WHAT to stop; it never stops anything. The caller that a
 *              person's press reaches (Phase 4) calls the runtime's stopTask —
 *              a destructive act needs an explicit caller (forbidden #15).
 *
 * Every write emits exactly one `subtask` change event carrying the row as
 * stored. Reads go straight through the ThreadStore.
 */

import { randomBytes } from 'crypto'
import type { SubtaskPatch, SubtaskRecord, SubtaskState, ThreadChangeEvent } from '../store/thread-store'

/** How many subtasks of one thread may hold a slot at once. */
export const SUBTASK_RUNNING_CAP = 3

/** The slice of ThreadStore the registry uses — narrow, so a test can fake it. */
export interface SubtaskStoreLike {
  insertSubtask(record: SubtaskRecord): SubtaskRecord
  getSubtask(ticket: string): SubtaskRecord | null
  listSubtasks(threadId: string): SubtaskRecord[]
  listSubtasksInStates(states: readonly SubtaskState[]): SubtaskRecord[]
  updateSubtask(ticket: string, patch: SubtaskPatch): SubtaskRecord | null
}

export interface SubtaskRegistryOptions {
  /** ISO timestamp source — injected so a test controls ordering and times. */
  now?: () => string
  /** Ticket id source — injected so a test can force a collision. */
  newTicket?: () => string
}

export interface SubtaskStartInput {
  threadId: string
  fromMessageId: string | null
  title: string
  task: string
  retryOf?: string
}

export type SubtaskStartResult =
  | {
      ok: true
      ticket: string
      state: 'running' | 'queued'
      attempt: number
      /** On `queued` only: the tickets holding the slots it waits for. */
      queuedBehind?: string[]
      record: SubtaskRecord
    }
  | { ok: false; reason: string }

export type SubtaskLinkResult = { ok: true; record: SubtaskRecord } | { ok: false; reason: string }

export interface SubtaskSettleResult {
  /** The settled row, or null when the task is not a subtask (a skill sub-agent). */
  record: SubtaskRecord | null
  /** The oldest queued ticket that may start now a slot is free, if any. */
  next: SubtaskRecord | null
}

export type SubtaskStopAnswer = { ok: true; taskId: string } | { ok: false; reason: string }

/** States that are over: the row holds no slot, and only its files can still change. */
const ENDED: ReadonlySet<SubtaskState> = new Set(['done', 'failed', 'stopped'])

/** `st-` + 6 base36 characters: short enough for a model to copy exactly. */
export function makeTicket(): string {
  const bytes = randomBytes(6)
  let out = ''
  for (const byte of bytes) out += (byte % 36).toString(36)
  return `st-${out}`
}

export class SubtaskRegistry {
  readonly #store: SubtaskStoreLike
  readonly #emit: (event: ThreadChangeEvent) => void
  readonly #now: () => string
  readonly #newTicket: () => string
  /** Per thread: files the MAIN agent wrote in the current request. */
  readonly #mainWrites = new Map<string, Set<string>>()
  /** Per thread: when the current request began — rows that ended before it
   *  are outside the overlap check. Absent = every row is in scope. */
  readonly #requestStartedAt = new Map<string, string>()

  constructor(
    store: SubtaskStoreLike,
    emit: (event: ThreadChangeEvent) => void,
    options: SubtaskRegistryOptions = {},
  ) {
    this.#store = store
    this.#emit = emit
    this.#now = options.now ?? (() => new Date().toISOString())
    this.#newTicket = options.newTicket ?? makeTicket
  }

  /** A new request (a person's prompt) began on `threadId`: forget the main
   *  agent's writes from the previous one. */
  beginRequest(threadId: string): void {
    this.#mainWrites.delete(threadId)
    this.#requestStartedAt.set(threadId, this.#now())
  }

  list(threadId: string): SubtaskRecord[] {
    return this.#store.listSubtasks(threadId)
  }

  start(input: SubtaskStartInput): SubtaskStartResult {
    const title = input.title.trim()
    const task = input.task.trim()
    if (title === '') return { ok: false, reason: 'A subtask needs a title.' }
    if (task === '') return { ok: false, reason: 'A subtask needs a task to do.' }

    let attempt = 1
    let retryOf: string | null = null
    if (input.retryOf !== undefined && input.retryOf !== '') {
      const previous = this.#store.getSubtask(input.retryOf)
      if (previous === null || previous.threadId !== input.threadId) {
        return {
          ok: false,
          reason: `There is no subtask "${input.retryOf}" in this conversation to retry. Start a new one without retry_of.`,
        }
      }
      if (!ENDED.has(previous.state)) {
        return { ok: false, reason: `Subtask "${input.retryOf}" has not ended yet, so it cannot be retried.` }
      }
      attempt = previous.attempt + 1
      retryOf = previous.ticket
    }

    const running = this.#running(input.threadId)
    const state: 'running' | 'queued' = running.length < SUBTASK_RUNNING_CAP ? 'running' : 'queued'
    const at = this.#now()
    const record = this.#store.insertSubtask({
      ticket: this.#uniqueTicket(),
      threadId: input.threadId,
      fromMessageId: input.fromMessageId,
      title,
      task,
      state,
      attempt,
      retryOf,
      toolCallId: null,
      sdkTaskId: null,
      createdAt: at,
      startedAt: state === 'running' ? at : null,
      endedAt: null,
      error: null,
      filesWritten: [],
      overlapFiles: [],
    })
    this.#emitRow(record, 'created')
    return {
      ok: true,
      ticket: record.ticket,
      state,
      attempt,
      ...(state === 'queued' ? { queuedBehind: running.map((row) => row.ticket) } : {}),
      record,
    }
  }

  /** The Agent hook saw `name` = `ticket` on tool call `toolCallId`. */
  link(input: { threadId: string; ticket: string; toolCallId: string }): SubtaskLinkResult {
    const row = this.#store.getSubtask(input.ticket)
    if (row === null || row.threadId !== input.threadId) {
      return {
        ok: false,
        reason: `"${input.ticket}" is not a subtask ticket in this conversation. Get a ticket from start_subtask first.`,
      }
    }
    if (ENDED.has(row.state)) {
      return {
        ok: false,
        reason: `Subtask "${row.ticket}" has already ended (${row.state}). To run it again, start a retry with retry_of.`,
      }
    }
    if (row.toolCallId !== null) {
      if (row.toolCallId === input.toolCallId) return { ok: true, record: row }
      return { ok: false, reason: `Subtask "${row.ticket}" is already running under another agent call.` }
    }
    const patch: SubtaskPatch = { toolCallId: input.toolCallId }
    if (row.state === 'queued') {
      const running = this.#running(input.threadId)
      if (running.length >= SUBTASK_RUNNING_CAP) {
        return {
          ok: false,
          reason: `Subtask "${row.ticket}" is queued: ${SUBTASK_RUNNING_CAP} subtasks are already running. Wait until one ends, then start it.`,
        }
      }
      patch.state = 'running'
      patch.startedAt = this.#now()
    }
    return { ok: true, record: this.#write(row.ticket, patch) }
  }

  /** `task_started`: store the runtime's task id on the row linked to the
   *  Agent call. Null when the call carried no ticket (a skill sub-agent). */
  onTaskStarted(input: { threadId: string; toolUseId: string; taskId: string }): SubtaskRecord | null {
    const row = this.#store
      .listSubtasks(input.threadId)
      .find((candidate) => candidate.toolCallId === input.toolUseId)
    if (row === undefined) return null
    if (row.sdkTaskId === input.taskId) return row
    return this.#write(row.ticket, { sdkTaskId: input.taskId })
  }

  /** `task_notification`: end the row, and name the queued ticket that may
   *  start now. A task that is not a subtask, or a row already ended, changes
   *  nothing. */
  onTaskSettled(input: {
    threadId: string
    taskId: string
    status: 'completed' | 'failed' | 'stopped'
    error?: string
  }): SubtaskSettleResult {
    const row = this.#byTaskId(input.threadId, input.taskId)
    if (row === null || ENDED.has(row.state)) return { record: null, next: null }
    const state: SubtaskState =
      input.status === 'completed' ? 'done' : input.status === 'failed' ? 'failed' : 'stopped'
    const record = this.#write(row.ticket, {
      state,
      endedAt: this.#now(),
      ...(input.error !== undefined && input.error !== '' ? { error: input.error } : {}),
    })
    return { record, next: this.#nextQueued(input.threadId) }
  }

  /**
   * A file was written. `agentId` null = the main agent; otherwise the
   * sub-agent's id, which is a subtask's task id — or a skill sub-agent's,
   * which is not tracked here. Returns the subtask rows this write changed.
   */
  recordWrite(input: { threadId: string; agentId: string | null; filePath: string }): SubtaskRecord[] {
    const file = input.filePath
    if (file === '') return []
    const changed: SubtaskRecord[] = []
    const inScope = this.#inRequest(input.threadId)

    if (input.agentId === null) {
      let mine = this.#mainWrites.get(input.threadId)
      if (mine === undefined) {
        mine = new Set()
        this.#mainWrites.set(input.threadId, mine)
      }
      mine.add(file)
      for (const row of inScope) {
        if (row.filesWritten.includes(file) && !row.overlapFiles.includes(file)) {
          changed.push(this.#write(row.ticket, { overlapFiles: [...row.overlapFiles, file] }))
        }
      }
      return changed
    }

    const writer = inScope.find((row) => row.sdkTaskId === input.agentId) ?? this.#byTaskId(input.threadId, input.agentId)
    if (writer === null) return []
    const others = inScope.filter((row) => row.ticket !== writer.ticket && row.filesWritten.includes(file))
    const overlaps = others.length > 0 || (this.#mainWrites.get(input.threadId)?.has(file) ?? false)

    const patch: SubtaskPatch = {}
    if (!writer.filesWritten.includes(file)) patch.filesWritten = [...writer.filesWritten, file]
    if (overlaps && !writer.overlapFiles.includes(file)) patch.overlapFiles = [...writer.overlapFiles, file]
    if (patch.filesWritten !== undefined || patch.overlapFiles !== undefined) {
      changed.push(this.#write(writer.ticket, patch))
    }
    for (const other of others) {
      if (!other.overlapFiles.includes(file)) {
        changed.push(this.#write(other.ticket, { overlapFiles: [...other.overlapFiles, file] }))
      }
    }
    return changed
  }

  /**
   * What a Stop press on `ticket` should stop. Answers only — the caller does
   * the stopping. Refused for anything that is not a running subtask of this
   * conversation with a runtime task behind it.
   */
  stop(input: { threadId: string; ticket: string }): SubtaskStopAnswer {
    const row = this.#store.getSubtask(input.ticket)
    if (row === null || row.threadId !== input.threadId) {
      return { ok: false, reason: 'Only your own subtasks can be stopped from here.' }
    }
    if (row.state !== 'running') {
      return { ok: false, reason: `This subtask is ${row.state}, not running, so there is nothing to stop.` }
    }
    if (row.sdkTaskId === null) {
      return { ok: false, reason: 'This subtask has not started its work yet, so there is nothing to stop.' }
    }
    return { ok: true, taskId: row.sdkTaskId }
  }

  /**
   * Restart sweep: no background task survives a restart, so a row left
   * `running` or `queued` by the previous run can never settle. End it as
   * failed, with a sentence, so the person sees it and can retry it.
   */
  reconcileInterrupted(): number {
    const stranded = this.#store.listSubtasksInStates(['running', 'queued'])
    for (const row of stranded) {
      this.#write(row.ticket, {
        state: 'failed',
        endedAt: this.#now(),
        error: 'Flow closed before this subtask ended.',
      })
    }
    return stranded.length
  }

  #running(threadId: string): SubtaskRecord[] {
    return this.#store.listSubtasks(threadId).filter((row) => row.state === 'running')
  }

  #nextQueued(threadId: string): SubtaskRecord | null {
    const rows = this.#store.listSubtasks(threadId)
    if (rows.filter((row) => row.state === 'running').length >= SUBTASK_RUNNING_CAP) return null
    return rows.find((row) => row.state === 'queued') ?? null
  }

  #byTaskId(threadId: string, taskId: string): SubtaskRecord | null {
    return this.#store.listSubtasks(threadId).find((row) => row.sdkTaskId === taskId) ?? null
  }

  /** Rows the overlap check compares: running ones, and ones that ended in
   *  the current request. */
  #inRequest(threadId: string): SubtaskRecord[] {
    const since = this.#requestStartedAt.get(threadId)
    return this.#store
      .listSubtasks(threadId)
      .filter(
        (row) =>
          row.state === 'running' || (since === undefined ? true : row.endedAt !== null && row.endedAt >= since),
      )
  }

  #uniqueTicket(): string {
    for (let tries = 0; tries < 16; tries += 1) {
      const ticket = this.#newTicket()
      if (this.#store.getSubtask(ticket) === null) return ticket
    }
    throw new Error('Could not mint a unique subtask ticket.')
  }

  #write(ticket: string, patch: SubtaskPatch): SubtaskRecord {
    const record = this.#store.updateSubtask(ticket, patch)
    if (record === null) throw new Error(`Subtask ${ticket} vanished while being written.`)
    this.#emitRow(record, 'updated')
    return record
  }

  #emitRow(record: SubtaskRecord, action: 'created' | 'updated'): void {
    this.#emit({ entity: 'subtask', action, threadId: record.threadId, subtask: record })
  }
}
