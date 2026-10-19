import type { ThreadMessage, ToolCallRecord } from '../../shared/ipc-contract'
import { buildSubchatFeed, isEmptyFeed, subchatItemKey } from './subagent-subchat-model'

function msg(id: string, createdAt: string, overrides: Partial<ThreadMessage> = {}): ThreadMessage {
  return {
    id,
    threadId: 't',
    role: 'assistant',
    content: `msg ${id}`,
    createdAt,
    model: null,
    ...overrides,
  }
}

function tool(id: string, startedAt: string, overrides: Partial<ToolCallRecord> = {}): ToolCallRecord {
  return {
    id,
    threadId: 't',
    messageId: null,
    toolName: 'Grep',
    inputJson: null,
    outputJson: null,
    status: 'success',
    startedAt,
    completedAt: null,
    ...overrides,
  }
}

describe('buildSubchatFeed (#1931)', () => {
  it('interleaves messages and tool calls oldest-first by timestamp', () => {
    const feed = buildSubchatFeed(
      [msg('m1', '2026-10-06T10:00:00.000Z'), msg('m2', '2026-10-06T10:00:02.000Z')],
      [tool('t1', '2026-10-06T10:00:01.000Z')],
    )
    expect(feed.map(subchatItemKey)).toEqual(['m:m1', 't:t1', 'm:m2'])
  })

  it('puts a message before a tool it spawned at the same timestamp', () => {
    const feed = buildSubchatFeed(
      [msg('m1', '2026-10-06T10:00:00.000Z')],
      [tool('t1', '2026-10-06T10:00:00.000Z')],
    )
    expect(feed.map(subchatItemKey)).toEqual(['m:m1', 't:t1'])
  })

  it('carries the underlying records through', () => {
    const feed = buildSubchatFeed([msg('m1', 'a', { content: 'hi' })], [tool('t1', 'b')])
    const message = feed.find((item) => item.kind === 'message')
    const toolItem = feed.find((item) => item.kind === 'tool')
    expect(message?.kind === 'message' && message.message.content).toBe('hi')
    expect(toolItem?.kind === 'tool' && toolItem.toolCall.id).toBe('t1')
  })

  it('isEmptyFeed is true only when there is nothing', () => {
    expect(isEmptyFeed([])).toBe(true)
    expect(isEmptyFeed(buildSubchatFeed([msg('m1', 'x')], []))).toBe(false)
    expect(isEmptyFeed(buildSubchatFeed([], [tool('t1', 'x')]))).toBe(false)
  })
})
