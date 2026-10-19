// Pinned against a LIVE `copilot -p … --output-format json` (1.0.80) run — the
// event objects below are field-for-field from the real stream.

import type { AgentStreamEvent } from '../../../shared/ipc-contract'
import { RuntimeEventSink } from './runtime-event-sink'
import { createCopilotParser, parseCopilotEvent, parseCopilotStream } from './copilot-events'

const THREAD = 'thread-1'
const NOW = '2026-08-18T00:00:00.000Z'

const EV_MSG_START = {
  type: 'assistant.message_start',
  data: { messageId: '6a4d60c2-3b37-4e97-8e58-539287413e08' },
  ephemeral: true,
}
const EV_MSG_DELTA = {
  type: 'assistant.message_delta',
  data: { messageId: '6a4d60c2-3b37-4e97-8e58-539287413e08', deltaContent: 'Creating' },
}
const EV_MSG = {
  type: 'assistant.message',
  data: { messageId: '6a4d60c2-3b37-4e97-8e58-539287413e08', model: 'gpt-5-mini', content: 'Creating the file.' },
}
const EV_TOOL_START = {
  type: 'tool.execution_start',
  data: {
    toolCallId: 'call_oPca3XNLHkdBu2CBZiCVrvEj',
    toolName: 'create',
    arguments: { path: '/tmp/x/test.txt', file_text: 'ok' },
  },
}
const EV_TOOL_COMPLETE = {
  type: 'tool.execution_complete',
  data: {
    toolCallId: 'call_oPca3XNLHkdBu2CBZiCVrvEj',
    success: true,
    result: { content: 'Created file /tmp/x/test.txt with 2 characters' },
  },
}
const EV_RESULT = {
  type: 'result',
  sessionId: 'd5c5a131-8bb7-491b-b30c-27360dff52a9',
  exitCode: 0,
  usage: { premiumRequests: 0 },
}
const EV_IGNORED = { type: 'session.usage_checkpoint', data: { totalNanoAiu: 319030000 } }

describe('parseCopilotEvent', () => {
  it('maps message_start → message-start', () => {
    expect(parseCopilotEvent(EV_MSG_START, THREAD, NOW).events).toEqual([
      { kind: 'message-start', threadId: THREAD, messageId: '6a4d60c2-3b37-4e97-8e58-539287413e08' },
    ])
  })

  it('maps message_delta → message-delta with deltaContent as text', () => {
    expect(parseCopilotEvent(EV_MSG_DELTA, THREAD, NOW).events).toEqual([
      { kind: 'message-delta', threadId: THREAD, messageId: '6a4d60c2-3b37-4e97-8e58-539287413e08', text: 'Creating' },
    ])
  })

  it('maps a completed message → model + text-stop', () => {
    const events = parseCopilotEvent(EV_MSG, THREAD, NOW).events
    expect(events).toContainEqual({ kind: 'model', threadId: THREAD, model: 'gpt-5-mini' })
    expect(events).toContainEqual({
      kind: 'text-stop',
      threadId: THREAD,
      messageId: '6a4d60c2-3b37-4e97-8e58-539287413e08',
    })
  })

  it('maps tool.execution_start → tool-start with arguments serialized as inputJson', () => {
    const events = parseCopilotEvent(EV_TOOL_START, THREAD, NOW).events
    expect(events).toHaveLength(1)
    const event = events[0] as Extract<AgentStreamEvent, { kind: 'tool-start' }>
    expect(event.kind).toBe('tool-start')
    expect(event.toolCall.id).toBe('call_oPca3XNLHkdBu2CBZiCVrvEj')
    expect(event.toolCall.toolName).toBe('create')
    expect(event.toolCall.status).toBe('running')
    expect(JSON.parse(event.toolCall.inputJson ?? '{}')).toEqual({ path: '/tmp/x/test.txt', file_text: 'ok' })
  })

  it('maps tool.execution_complete → tool-end with success status and result content', () => {
    const events = parseCopilotEvent(EV_TOOL_COMPLETE, THREAD, NOW).events
    const event = events[0] as Extract<AgentStreamEvent, { kind: 'tool-end' }>
    expect(event.kind).toBe('tool-end')
    expect(event.toolCall.id).toBe('call_oPca3XNLHkdBu2CBZiCVrvEj')
    expect(event.toolCall.status).toBe('success')
    expect(event.toolCall.outputJson).toContain('Created file')
  })

  it('maps a failed tool completion → error status', () => {
    const failed = { type: 'tool.execution_complete', data: { toolCallId: 'x', success: false } }
    const event = parseCopilotEvent(failed, THREAD, NOW).events[0] as Extract<AgentStreamEvent, { kind: 'tool-end' }>
    expect(event.toolCall.status).toBe('error')
  })

  it('captures the session id from the terminal result event (top-level sessionId)', () => {
    const result = parseCopilotEvent(EV_RESULT, THREAD, NOW)
    expect(result.sessionId).toBe('d5c5a131-8bb7-491b-b30c-27360dff52a9')
    expect(result.events).toEqual([])
  })

  it('ignores bookkeeping/ephemeral events, fail-soft', () => {
    expect(parseCopilotEvent(EV_IGNORED, THREAD, NOW).events).toEqual([])
    expect(parseCopilotEvent({ type: 'assistant.turn_end', data: { turnId: '0' } }, THREAD, NOW).events).toEqual([])
    expect(parseCopilotEvent('not an object', THREAD, NOW).events).toEqual([])
    expect(parseCopilotEvent({ no: 'type' }, THREAD, NOW).events).toEqual([])
  })
})

describe('parseCopilotStream', () => {
  it('parses a JSONL transcript, collecting events and the session id', () => {
    const stdout = [
      JSON.stringify(EV_MSG_START),
      'not json — ignored',
      JSON.stringify(EV_MSG_DELTA),
      JSON.stringify(EV_TOOL_START),
      JSON.stringify(EV_TOOL_COMPLETE),
      JSON.stringify(EV_RESULT),
      '',
    ].join('\n')
    const { events, sessionId } = parseCopilotStream(stdout, THREAD, NOW)
    expect(sessionId).toBe('d5c5a131-8bb7-491b-b30c-27360dff52a9')
    expect(events.map((e) => e.kind)).toEqual(['message-start', 'message-delta', 'tool-start', 'tool-end'])
  })
})

// Shape pinned from a live copilot 1.0.89 run: the arguments of the tool call a
// message ends with stream BEFORE `assistant.message` closes the text.
const EV_TOOL_CALL_DELTA = {
  type: 'assistant.tool_call_delta',
  data: { toolCallId: 'call_P6P9G', toolName: 'apply_patch', toolType: 'function', inputDelta: '{"' },
  ephemeral: true,
}

describe('createCopilotParser — a tool call being written ends the text', () => {
  it('emits text-stop at the FIRST tool-call delta, before the arguments finish streaming', () => {
    const parse = createCopilotParser(THREAD)
    const kinds = [EV_MSG_START, EV_MSG_DELTA, EV_TOOL_CALL_DELTA, EV_TOOL_CALL_DELTA, EV_TOOL_CALL_DELTA]
      .flatMap((event) => parse(event, NOW).events)
      .map((event) => event.kind)
    // Without the early stop the pane read these minutes of argument streaming
    // as text still being typed, and hid its loader for all of it.
    expect(kinds).toEqual(['message-start', 'message-delta', 'text-stop'])
  })

  it('names the open message on the early stop, and still passes through the completed message', () => {
    const parse = createCopilotParser(THREAD)
    parse(EV_MSG_START, NOW)
    parse(EV_MSG_DELTA, NOW)
    expect(parse(EV_TOOL_CALL_DELTA, NOW).events).toEqual([
      { kind: 'text-stop', threadId: THREAD, messageId: EV_MSG_START.data.messageId },
    ])
    expect(parse(EV_MSG, NOW).events.map((event) => event.kind)).toEqual(['model', 'text-stop'])
  })

  it('emits nothing for tool-call deltas when no text is open', () => {
    const parse = createCopilotParser(THREAD)
    expect(parse(EV_TOOL_CALL_DELTA, NOW).events).toEqual([])
    parse(EV_MSG_START, NOW)
    parse(EV_MSG, NOW)
    expect(parse(EV_TOOL_CALL_DELTA, NOW).events).toEqual([])
  })

  it('persists each message once: the repeat text-stop from assistant.message saves nothing', () => {
    const { events } = parseCopilotStream(
      [EV_MSG_START, EV_MSG_DELTA, EV_TOOL_CALL_DELTA, EV_MSG, EV_TOOL_START, EV_TOOL_COMPLETE]
        .map((event) => JSON.stringify(event))
        .join('\n'),
      THREAD,
      NOW,
    )
    const saved: string[] = []
    const sink = new RuntimeEventSink(THREAD, {
      appendMessage: (_thread: string, _role: string, text: string) => {
        saved.push(text)
        return { id: `m${saved.length}` }
      },
      recordToolCall: (record: object) => ({ ...record, id: 'tc1' }),
      updateToolCall: () => undefined,
      updateThread: () => undefined,
    } as unknown as ConstructorParameters<typeof RuntimeEventSink>[1])
    for (const event of events) sink.handle(event)
    expect(saved).toEqual(['Creating'])
  })
})
