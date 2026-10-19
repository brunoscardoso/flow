// Codex JSONL → AgentStreamEvent adapter (multi_runtime_support, Phase 5 core).
//
// `codex exec --json` prints one JSON object per line. This maps that taxonomy
// onto plan-flow's normalized `AgentStreamEvent` — the same stream the renderer
// already consumes — so a CodexRuntime plugs into the existing pipeline.
//
// The mapping was validated against a LIVE `codex exec --json` run (v0.147.0);
// the exact event shapes are pinned in the unit test. Fail-soft on anything
// unrecognized, mirroring stream-bridge's tolerance of Anthropic's stream.
//
//   thread.started {thread_id}              → (session id, for resume)
//   turn.started                            → (no stream event)
//   item.completed {item: agent_message}    → message-start / message-delta / text-stop
//   item.started/completed {file_change}    → tool-start / tool-end   (Write)
//   item.started/completed {command_exec}   → tool-start / tool-end   (Bash)
//   turn.completed {usage}                  → usage

import type { AgentStreamEvent, ToolCallRecord } from '../../../shared/ipc-contract'

/** What one Codex event translates to. */
export interface CodexParseResult {
  /** Normalized stream events to emit (possibly empty). */
  events: AgentStreamEvent[]
  /** Set ONLY by `thread.started`: the session id to persist for resume. */
  sessionId?: string
}

/** Codex item type → plan-flow tool name. */
function toolNameFor(itemType: string): string {
  if (itemType === 'command_execution') return 'Bash'
  if (itemType === 'file_change') return 'Write'
  return itemType
}

/** Build a ToolCallRecord from a Codex item. `now` is injected for determinism. */
function toolCallFor(
  item: Record<string, unknown>,
  threadId: string,
  now: string,
  done: boolean,
): ToolCallRecord {
  const id = typeof item.id === 'string' ? item.id : 'codex-item'
  const itemType = typeof item.type === 'string' ? item.type : 'unknown'
  return {
    id,
    threadId,
    messageId: null,
    toolName: toolNameFor(itemType),
    inputJson: JSON.stringify(item),
    outputJson: done ? JSON.stringify({ status: item.status ?? 'completed' }) : null,
    status: done ? 'success' : 'running',
    startedAt: now,
    completedAt: done ? now : null,
  }
}

/**
 * Translate one parsed Codex JSONL event into normalized stream events.
 * Pure and deterministic given `now`; unknown/malformed input yields no events.
 */
export function parseCodexEvent(raw: unknown, threadId: string, now: string): CodexParseResult {
  if (typeof raw !== 'object' || raw === null) return { events: [] }
  const ev = raw as Record<string, unknown>

  switch (ev.type) {
    case 'thread.started':
      return {
        events: [],
        sessionId: typeof ev.thread_id === 'string' ? ev.thread_id : undefined,
      }

    case 'turn.started':
      // No message id is available yet; message-start is emitted per
      // agent_message item, which carries its own id.
      return { events: [] }

    case 'item.started':
    case 'item.completed': {
      const item = ev.item
      if (typeof item !== 'object' || item === null) return { events: [] }
      const it = item as Record<string, unknown>
      const done = ev.type === 'item.completed'
      const itemType = it.type

      if (itemType === 'agent_message') {
        // `codex exec` is non-streaming: the full text arrives at completion.
        if (!done) return { events: [] }
        const text = typeof it.text === 'string' ? it.text : ''
        const messageId = typeof it.id === 'string' ? it.id : 'codex-msg'
        const out: AgentStreamEvent[] = [{ kind: 'message-start', threadId, messageId }]
        if (text.length > 0) out.push({ kind: 'message-delta', threadId, messageId, text })
        out.push({ kind: 'text-stop', threadId, messageId })
        return { events: out }
      }

      if (itemType === 'file_change' || itemType === 'command_execution') {
        const toolCall = toolCallFor(it, threadId, now, done)
        return {
          events: [done ? { kind: 'tool-end', threadId, toolCall } : { kind: 'tool-start', threadId, toolCall }],
        }
      }

      return { events: [] }
    }

    case 'turn.completed': {
      const usage = ev.usage
      if (typeof usage !== 'object' || usage === null) return { events: [] }
      const u = usage as Record<string, unknown>
      const num = (k: string): number => (typeof u[k] === 'number' ? (u[k] as number) : 0)
      // Codex `input_tokens` is the TOTAL input (the cached portion is a subset
      // reported as `cached_input_tokens`), matching AgentStreamEvent's
      // convention: inputTokens = everything the turn sent, cachedInputTokens =
      // the cached part of that same total (never a separate addend).
      return {
        events: [
          {
            kind: 'usage',
            threadId,
            inputTokens: num('input_tokens'),
            cachedInputTokens: num('cached_input_tokens'),
            outputTokens: num('output_tokens'),
          },
        ],
      }
    }

    default:
      // Unknown event type — skip it, never throw (mirrors stream-bridge).
      return { events: [] }
  }
}

/** Parse a full `codex exec --json` stdout stream (JSONL) into stream events +
 *  the session id. Malformed lines are skipped. */
export function parseCodexStream(
  stdout: string,
  threadId: string,
  now: string,
): { events: AgentStreamEvent[]; sessionId: string | null } {
  const events: AgentStreamEvent[] = []
  let sessionId: string | null = null
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      continue
    }
    const result = parseCodexEvent(parsed, threadId, now)
    if (result.sessionId !== undefined) sessionId = result.sessionId
    events.push(...result.events)
  }
  return { events, sessionId }
}
