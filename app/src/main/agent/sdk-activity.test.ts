import { describeSdkActivity } from './sdk-activity'

describe('describeSdkActivity', () => {
  it('reports a partial message as a heartbeat, the composing phase signal', () => {
    // The one kind that exists between the last tool result and the finished
    // answer — and the one a log must not print, at a chunk each.
    expect(describeSdkActivity({ type: 'stream_event' })).toEqual({ kind: 'stream' })
  })

  it('names the tool a turn is calling', () => {
    expect(
      describeSdkActivity({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read' }] } }),
    ).toEqual({ kind: 'tool', detail: 'Read' })
  })

  it('ranks thinking above writing above calling, one headline per turn', () => {
    // A turn can carry all three. Thinking explains a long gap; a tool name
    // does not, and printing all three makes the log a transcript.
    const mixed = {
      type: 'assistant',
      message: {
        content: [{ type: 'tool_use', name: 'Grep' }, { type: 'text' }, { type: 'thinking' }],
      },
    }
    expect(describeSdkActivity(mixed)).toEqual({ kind: 'thinking' })
    expect(
      describeSdkActivity({ type: 'assistant', message: { content: [{ type: 'text' }, { type: 'tool_use', name: 'Grep' }] } }),
    ).toEqual({ kind: 'writing' })
  })

  it('reports tool results and session lifecycle', () => {
    expect(
      describeSdkActivity({ type: 'user', message: { content: [{ type: 'tool_result' }] } }),
    ).toEqual({ kind: 'tool result' })
    expect(describeSdkActivity({ type: 'system', subtype: 'init' })).toEqual({
      kind: 'session',
      detail: 'init',
    })
    expect(describeSdkActivity({ type: 'result', subtype: 'success' })).toEqual({
      kind: 'result',
      detail: 'success',
    })
  })

  it('survives shapes it was not told about', () => {
    // This reads RAW SDK messages, so a provider adding a field or a type must
    // not throw inside a translator on the session's only code path.
    expect(describeSdkActivity(null)).toBeNull()
    expect(describeSdkActivity('nonsense')).toBeNull()
    expect(describeSdkActivity({ type: 'unheard_of' })).toBeNull()
    expect(describeSdkActivity({ type: 'assistant' })).toEqual({ kind: 'assistant' })
    expect(describeSdkActivity({ type: 'assistant', message: { content: 'not-an-array' } })).toEqual({
      kind: 'assistant',
    })
    expect(
      describeSdkActivity({ type: 'assistant', message: { content: [{ type: 'tool_use' }] } }),
    ).toEqual({ kind: 'tool' })
  })
})
