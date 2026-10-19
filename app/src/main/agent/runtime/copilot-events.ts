// Copilot JSONL → normalized AgentStreamEvent (multi_runtime_support, Phase 5).
//
// The GitHub Copilot CLI (`copilot -p … --output-format json`) emits JSONL — one
// event object per line. This maps the mapping-relevant subset onto the
// AgentStreamEvent stream the renderer already consumes; everything else
// (session.* bookkeeping, reasoning, turn_start/end) is ignored, fail-soft.
// `tool_call_delta` is read only for the moment it starts — see
// `createCopilotParser`. Pinned against a LIVE copilot 1.0.80 run.
//
// Notable shape facts from the live stream:
//   • most events nest their payload under `data`; `result` puts `sessionId`
//     and `usage` at the TOP level.
//   • the resume handle is `result.sessionId`.
//   • Copilot reports usage as AI-units / premium-requests, NOT token counts,
//     so no `usage` event is emitted — emitting wrong token numbers would be
//     worse than none.

import type { AgentStreamEvent, ToolCallRecord } from '../../../shared/ipc-contract'

export interface CopilotParseResult {
  /** Normalized stream events to emit (possibly empty). */
  events: AgentStreamEvent[]
  /** Set ONLY by the terminal `result` event: the session id to persist for resume. */
  sessionId?: string
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function safeStringify(value: unknown): string | null {
  try {
    return JSON.stringify(value)
  } catch {
    return null
  }
}

export function parseCopilotEvent(raw: unknown, threadId: string, now: string): CopilotParseResult {
  const obj = asRecord(raw)
  if (obj === null) return { events: [] }
  const type = str(obj.type)
  if (type === undefined) return { events: [] }
  const data = asRecord(obj.data) ?? {}

  switch (type) {
    case 'assistant.message_start': {
      const messageId = str(data.messageId)
      if (messageId === undefined) return { events: [] }
      return { events: [{ kind: 'message-start', threadId, messageId }] }
    }
    case 'assistant.message_delta': {
      const messageId = str(data.messageId)
      const text = str(data.deltaContent)
      if (messageId === undefined || text === undefined) return { events: [] }
      return { events: [{ kind: 'message-delta', threadId, messageId, text }] }
    }
    case 'assistant.message': {
      // The completed message: surface the resolved model, then close the text
      // block (Copilot has no explicit text-stop event).
      const messageId = str(data.messageId)
      if (messageId === undefined) return { events: [] }
      const events: AgentStreamEvent[] = []
      const model = str(data.model)
      if (model !== undefined) events.push({ kind: 'model', threadId, model })
      events.push({ kind: 'text-stop', threadId, messageId })
      return { events }
    }
    case 'tool.execution_start': {
      const id = str(data.toolCallId)
      if (id === undefined) return { events: [] }
      const record: ToolCallRecord = {
        id,
        threadId,
        messageId: null,
        toolName: str(data.toolName) ?? 'tool',
        inputJson: data.arguments !== undefined ? safeStringify(data.arguments) : null,
        outputJson: null,
        status: 'running',
        startedAt: now,
        completedAt: null,
      }
      return { events: [{ kind: 'tool-start', threadId, toolCall: record }] }
    }
    case 'tool.execution_complete': {
      const id = str(data.toolCallId)
      if (id === undefined) return { events: [] }
      const result = asRecord(data.result)
      const record: ToolCallRecord = {
        id,
        threadId,
        messageId: null,
        // toolName is not repeated on completion; the sink correlates by id, so
        // the empty name here is never read.
        toolName: '',
        inputJson: null,
        outputJson: result !== null ? (str(result.content) ?? null) : null,
        status: data.success === true ? 'success' : 'error',
        startedAt: now,
        completedAt: now,
      }
      return { events: [{ kind: 'tool-end', threadId, toolCall: record }] }
    }
    case 'result': {
      // Terminal event: sessionId + usage live at the TOP level here.
      const sessionId = str(obj.sessionId)
      return sessionId !== undefined ? { events: [], sessionId } : { events: [] }
    }
    default:
      // session.* / assistant.reasoning / assistant.tool_call_delta /
      // assistant.turn_* / model.call_start / assistant.idle — not part of the
      // durable/rendered set.
      return { events: [] }
  }
}

/**
 * A parser for ONE turn's stream, which remembers the assistant message whose
 * text is still open.
 *
 * WHY IT NEEDS MEMORY. Copilot closes a text block only with
 * `assistant.message`, and it sends that AFTER the model has finished
 * streaming the arguments of the tool call the message ends with
 * (`assistant.tool_call_delta`, one per chunk). A large tool call — an
 * `apply_patch` writing a whole file — streams its arguments for minutes. Until
 * `text-stop`, the conversation pane reads the last sentence as still being
 * typed and keeps its loader hidden (streaming text IS the progress
 * indicator), so the feed sat frozen while the sidebar and the composer's
 * Interrupt both said the turn was running. Measured on a live thread:
 * 3.5 minutes between the last visible word and the tool starting.
 *
 * So the first tool-call delta ends the open text: the words are done, what
 * follows is a tool being written. `assistant.message` still emits its own
 * `text-stop` — a repeat for an already-closed message persists nothing
 * (RuntimeEventSink flushes on the first and finds no text on the second), and
 * the pane only drops its streaming flag, which is already down.
 */
export function createCopilotParser(threadId: string): (raw: unknown, now: string) => CopilotParseResult {
  let openMessageId: string | null = null
  return (raw, now) => {
    const obj = asRecord(raw)
    const type = obj === null ? undefined : str(obj.type)
    if (type === 'assistant.tool_call_delta') {
      if (openMessageId === null) return { events: [] }
      const messageId = openMessageId
      openMessageId = null
      return { events: [{ kind: 'text-stop', threadId, messageId }] }
    }
    const result = parseCopilotEvent(raw, threadId, now)
    for (const event of result.events) {
      if (event.kind === 'message-start') openMessageId = event.messageId
      else if (event.kind === 'text-stop' && event.messageId === openMessageId) openMessageId = null
    }
    return result
  }
}

export function parseCopilotStream(
  stdout: string,
  threadId: string,
  now: string,
): { events: AgentStreamEvent[]; sessionId: string | null } {
  const events: AgentStreamEvent[] = []
  let sessionId: string | null = null
  const parse = createCopilotParser(threadId)
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      continue
    }
    const result = parse(parsed, now)
    if (result.sessionId !== undefined) sessionId = result.sessionId
    events.push(...result.events)
  }
  return { events, sessionId }
}
