// Pinned against a LIVE `codex exec --json` v0.147.0 run — these event objects
// are the real shapes the CLI emitted, not invented ones.

import type { AgentStreamEvent } from '../../../shared/ipc-contract'
import { parseCodexEvent, parseCodexStream } from './codex-events'

const THREAD = 'thread-1'
const NOW = '2026-08-17T00:00:00.000Z'

// Real captured events (field-for-field from the live run).
const EV_THREAD_STARTED = { type: 'thread.started', thread_id: '01a01277-151c-7bc3-9d2e-b530e6fdb35b' }
const EV_TURN_STARTED = { type: 'turn.started' }
const EV_AGENT_MSG = {
  type: 'item.completed',
  item: { id: 'item_0', type: 'agent_message', text: 'I’ll create the file exactly as requested.' },
}
const EV_FILE_CHANGE_START = {
  type: 'item.started',
  item: {
    id: 'item_1',
    type: 'file_change',
    changes: [{ path: '/tmp/x/note.txt', kind: 'add' }],
    status: 'in_progress',
  },
}
const EV_FILE_CHANGE_DONE = {
  type: 'item.completed',
  item: { id: 'item_1', type: 'file_change', changes: [{ path: '/tmp/x/note.txt', kind: 'add' }], status: 'completed' },
}
const EV_CMD_EXEC_DONE = {
  type: 'item.completed',
  item: { id: 'item_2', type: 'command_execution', command: 'cat note.txt', status: 'completed' },
}
const EV_TURN_COMPLETED = {
  type: 'turn.completed',
  usage: {
    input_tokens: 42121,
    cached_input_tokens: 35072,
    cache_write_input_tokens: 0,
    output_tokens: 141,
    reasoning_output_tokens: 13,
  },
}

describe('parseCodexEvent', () => {
  it('captures the session id from thread.started, emits no stream event', () => {
    const r = parseCodexEvent(EV_THREAD_STARTED, THREAD, NOW)
    expect(r.sessionId).toBe('01a01277-151c-7bc3-9d2e-b530e6fdb35b')
    expect(r.events).toEqual([])
  })

  it('turn.started produces no stream event', () => {
    expect(parseCodexEvent(EV_TURN_STARTED, THREAD, NOW).events).toEqual([])
  })

  it('maps an agent_message item to message-start / delta / text-stop', () => {
    const { events } = parseCodexEvent(EV_AGENT_MSG, THREAD, NOW)
    expect(events).toEqual<AgentStreamEvent[]>([
      { kind: 'message-start', threadId: THREAD, messageId: 'item_0' },
      { kind: 'message-delta', threadId: THREAD, messageId: 'item_0', text: 'I’ll create the file exactly as requested.' },
      { kind: 'text-stop', threadId: THREAD, messageId: 'item_0' },
    ])
  })

  it('maps a file_change item.started to a running tool-start (Write)', () => {
    const { events } = parseCodexEvent(EV_FILE_CHANGE_START, THREAD, NOW)
    expect(events).toHaveLength(1)
    const ev = events[0]
    expect(ev.kind).toBe('tool-start')
    if (ev.kind === 'tool-start') {
      expect(ev.toolCall.toolName).toBe('Write')
      expect(ev.toolCall.status).toBe('running')
      expect(ev.toolCall.completedAt).toBeNull()
      expect(ev.toolCall.startedAt).toBe(NOW)
      expect(ev.toolCall.id).toBe('item_1')
    }
  })

  it('maps a file_change item.completed to a success tool-end (Write)', () => {
    const { events } = parseCodexEvent(EV_FILE_CHANGE_DONE, THREAD, NOW)
    expect(events).toHaveLength(1)
    const ev = events[0]
    expect(ev.kind).toBe('tool-end')
    if (ev.kind === 'tool-end') {
      expect(ev.toolCall.toolName).toBe('Write')
      expect(ev.toolCall.status).toBe('success')
      expect(ev.toolCall.completedAt).toBe(NOW)
    }
  })

  it('maps command_execution to a Bash tool call', () => {
    const { events } = parseCodexEvent(EV_CMD_EXEC_DONE, THREAD, NOW)
    const ev = events[0]
    expect(ev.kind).toBe('tool-end')
    if (ev.kind === 'tool-end') expect(ev.toolCall.toolName).toBe('Bash')
  })

  it('maps turn.completed.usage — input_tokens is the total, cached is a subset', () => {
    const { events } = parseCodexEvent(EV_TURN_COMPLETED, THREAD, NOW)
    expect(events).toEqual<AgentStreamEvent[]>([
      { kind: 'usage', threadId: THREAD, inputTokens: 42121, cachedInputTokens: 35072, outputTokens: 141 },
    ])
  })

  it('is fail-soft on unknown types and non-objects', () => {
    expect(parseCodexEvent({ type: 'mystery.future' }, THREAD, NOW).events).toEqual([])
    expect(parseCodexEvent(null, THREAD, NOW).events).toEqual([])
    expect(parseCodexEvent(42, THREAD, NOW).events).toEqual([])
    expect(parseCodexEvent({ type: 'turn.completed' }, THREAD, NOW).events).toEqual([]) // no usage
  })
})

describe('parseCodexStream', () => {
  it('parses a full JSONL run into ordered events + the session id, skipping blank/bad lines', () => {
    const stdout = [
      JSON.stringify(EV_THREAD_STARTED),
      '',
      JSON.stringify(EV_TURN_STARTED),
      JSON.stringify(EV_AGENT_MSG),
      'not json — should be skipped',
      JSON.stringify(EV_FILE_CHANGE_DONE),
      JSON.stringify(EV_TURN_COMPLETED),
    ].join('\n')

    const { events, sessionId } = parseCodexStream(stdout, THREAD, NOW)
    expect(sessionId).toBe('01a01277-151c-7bc3-9d2e-b530e6fdb35b')
    const kinds = events.map((e) => e.kind)
    expect(kinds).toEqual(['message-start', 'message-delta', 'text-stop', 'tool-end', 'usage'])
  })
})
