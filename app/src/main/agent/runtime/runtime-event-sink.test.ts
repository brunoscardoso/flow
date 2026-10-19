import type { AgentStreamEvent, ToolCallRecord } from '../../../shared/ipc-contract'
import { RuntimeEventSink, type EventSinkStore } from './runtime-event-sink'

const THREAD = 'thread-1'

function makeStore() {
  let msgSeq = 0
  let toolSeq = 0
  const appendMessage = jest.fn((threadId: string, role: string, content: string, model: string | null) => {
    msgSeq += 1
    return { id: `msg-${msgSeq}`, threadId, role, content, model }
  })
  const recordToolCall = jest.fn((input: { threadId: string; messageId?: string; toolName: string; inputJson?: string }) => {
    toolSeq += 1
    return { id: `tool-${toolSeq}`, ...input }
  })
  const updateToolCall = jest.fn()
  const updateThread = jest.fn()
  const markTurnEnd = jest.fn(() => true)
  const store = { appendMessage, recordToolCall, updateToolCall, updateThread, markTurnEnd } as unknown as EventSinkStore
  return { store, appendMessage, recordToolCall, updateToolCall, updateThread, markTurnEnd }
}

function toolRecord(over: Partial<ToolCallRecord>): ToolCallRecord {
  return {
    id: 'evt-tool-1',
    threadId: THREAD,
    messageId: null,
    toolName: 'Bash',
    inputJson: '{"command":"ls"}',
    outputJson: null,
    status: 'running',
    startedAt: '2026-08-18T00:00:00.000Z',
    completedAt: null,
    ...over,
  }
}

describe('RuntimeEventSink — assistant text', () => {
  it('accumulates deltas and persists on text-stop with the current model', () => {
    const { store, appendMessage } = makeStore()
    const sink = new RuntimeEventSink(THREAD, store)
    sink.handle({ kind: 'model', threadId: THREAD, model: 'o3' })
    sink.handle({ kind: 'message-start', threadId: THREAD, messageId: 'm1' })
    sink.handle({ kind: 'message-delta', threadId: THREAD, messageId: 'm1', text: 'Hello ' })
    sink.handle({ kind: 'message-delta', threadId: THREAD, messageId: 'm1', text: 'world' })
    expect(appendMessage).not.toHaveBeenCalled() // nothing persisted mid-stream
    sink.handle({ kind: 'text-stop', threadId: THREAD, messageId: 'm1' })
    expect(appendMessage).toHaveBeenCalledWith(THREAD, 'assistant', 'Hello world', 'o3')
  })

  it('persists nothing for an empty text block', () => {
    const { store, appendMessage } = makeStore()
    const sink = new RuntimeEventSink(THREAD, store)
    sink.handle({ kind: 'message-start', threadId: THREAD, messageId: 'm1' })
    sink.handle({ kind: 'text-stop', threadId: THREAD, messageId: 'm1' })
    expect(appendMessage).not.toHaveBeenCalled()
  })

  it('persists a null model when none was reported', () => {
    const { store, appendMessage } = makeStore()
    const sink = new RuntimeEventSink(THREAD, store)
    sink.handle({ kind: 'message-start', threadId: THREAD, messageId: 'm1' })
    sink.handle({ kind: 'message-delta', threadId: THREAD, messageId: 'm1', text: 'hi' })
    sink.handle({ kind: 'text-stop', threadId: THREAD, messageId: 'm1' })
    expect(appendMessage).toHaveBeenCalledWith(THREAD, 'assistant', 'hi', null)
  })
})

describe('RuntimeEventSink — tool calls', () => {
  it('records a tool call at start (running) and updates it at end, correlating by event id', () => {
    const { store, recordToolCall, updateToolCall } = makeStore()
    const sink = new RuntimeEventSink(THREAD, store)
    sink.handle({ kind: 'tool-start', threadId: THREAD, toolCall: toolRecord({ id: 'evt-42' }) })
    expect(recordToolCall).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: THREAD, toolName: 'Bash', inputJson: '{"command":"ls"}' }),
    )
    expect(updateToolCall).toHaveBeenCalledWith('tool-1', { status: 'running' })

    sink.handle({
      kind: 'tool-end',
      threadId: THREAD,
      toolCall: toolRecord({ id: 'evt-42', status: 'success', outputJson: '"ok"', completedAt: '2026-08-18T00:00:01.000Z' }),
    })
    expect(updateToolCall).toHaveBeenLastCalledWith('tool-1', {
      status: 'success',
      outputJson: '"ok"',
      completedAt: '2026-08-18T00:00:01.000Z',
    })
  })

  it('links a tool call to the last persisted assistant message', () => {
    const { store, recordToolCall } = makeStore()
    const sink = new RuntimeEventSink(THREAD, store)
    sink.handle({ kind: 'message-start', threadId: THREAD, messageId: 'm1' })
    sink.handle({ kind: 'message-delta', threadId: THREAD, messageId: 'm1', text: 'running a command' })
    sink.handle({ kind: 'text-stop', threadId: THREAD, messageId: 'm1' })
    sink.handle({ kind: 'tool-start', threadId: THREAD, toolCall: toolRecord({ id: 'evt-1' }) })
    expect(recordToolCall).toHaveBeenCalledWith(expect.objectContaining({ messageId: 'msg-1' }))
  })

  it('ignores a tool-end with no matching start (fail-soft, never throws)', () => {
    const { store, updateToolCall } = makeStore()
    const sink = new RuntimeEventSink(THREAD, store)
    expect(() =>
      sink.handle({ kind: 'tool-end', threadId: THREAD, toolCall: toolRecord({ id: 'orphan' }) }),
    ).not.toThrow()
    expect(updateToolCall).not.toHaveBeenCalled()
  })
})

describe('RuntimeEventSink — status & ephemeral events', () => {
  it('persists thread status transitions', () => {
    const { store, updateThread } = makeStore()
    const sink = new RuntimeEventSink(THREAD, store)
    sink.handle({ kind: 'status', threadId: THREAD, status: 'working' })
    expect(updateThread).toHaveBeenCalledWith(THREAD, { status: 'working' })
  })

  it('does NOT persist ephemeral events (usage / thinking / done)', () => {
    const { store, appendMessage, recordToolCall, updateThread } = makeStore()
    const sink = new RuntimeEventSink(THREAD, store)
    const ephemeral: AgentStreamEvent[] = [
      { kind: 'usage', threadId: THREAD, inputTokens: 10, cachedInputTokens: 0, outputTokens: 5 },
      { kind: 'thinking', threadId: THREAD, active: true },
      { kind: 'done', threadId: THREAD, messageId: 'm1' },
    ]
    for (const event of ephemeral) sink.handle(event)
    expect(appendMessage).not.toHaveBeenCalled()
    expect(recordToolCall).not.toHaveBeenCalled()
    expect(updateThread).not.toHaveBeenCalled()
  })
})

describe('RuntimeEventSink — the end of a turn', () => {
  const say = (sink: RuntimeEventSink, id: string, text: string): void => {
    sink.handle({ kind: 'message-start', threadId: THREAD, messageId: id } as AgentStreamEvent)
    sink.handle({ kind: 'message-delta', threadId: THREAD, messageId: id, text } as AgentStreamEvent)
    sink.handle({ kind: 'text-stop', threadId: THREAD, messageId: id } as AgentStreamEvent)
  }
  const done = (sink: RuntimeEventSink): void =>
    sink.handle({ kind: 'done', threadId: THREAD, messageId: 'x' } as AgentStreamEvent)

  it('marks the last message the turn wrote, once', () => {
    const { store, markTurnEnd } = makeStore()
    const sink = new RuntimeEventSink(THREAD, store)
    say(sink, 'a', 'Reading the files.')
    say(sink, 'b', 'Done: the sort is server-side.')
    done(sink)
    expect(markTurnEnd).toHaveBeenCalledTimes(1)
    expect(markTurnEnd).toHaveBeenCalledWith('msg-2')
  })

  it('marks nothing for a turn that wrote no text — never the previous turn\'s answer', () => {
    const { store, markTurnEnd } = makeStore()
    const sink = new RuntimeEventSink(THREAD, store)
    say(sink, 'a', 'First answer.')
    done(sink)
    expect(markTurnEnd).toHaveBeenCalledTimes(1)
    done(sink)
    expect(markTurnEnd).toHaveBeenCalledTimes(1)
  })
})
