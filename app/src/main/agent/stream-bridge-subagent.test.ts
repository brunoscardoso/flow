// Sub-agent capture tests (#1931) — a fake store captures what the bridge
// persists, so we can assert sub-agent rows are tagged with the parent Task id
// AND that the main-thread path is unchanged.

import { StreamBridge } from './stream-bridge'
import { BackgroundTaskTracker } from './background-tasks'
import type { AgentStreamEvent } from '../../shared/ipc-contract'
import type { ThreadStore } from '../store/thread-store'

interface StoredMessage {
  id: string
  threadId: string
  role: string
  content: string
  model: string | null
  parentToolCallId: string | null
}
interface StoredTool {
  id: string
  threadId: string
  messageId: string | null
  toolName: string
  inputJson: string | null
  outputJson: string | null
  status: string
  startedAt: string
  completedAt: string | null
  parentToolCallId: string | null
  agentId: string | null
}

function makeFakeStore() {
  const messages: StoredMessage[] = []
  const toolCalls = new Map<string, StoredTool>()
  /** spawn record id → promoted child thread id — the fake's one spawn→child
   *  mapping, mirroring the real store's #promotedChildId + redirect-at-write. */
  const promotions = new Map<string, string>()
  let seq = 0
  const store = {
    appendMessage(
      threadId: string,
      role: string,
      content: string,
      model: string | null = null,
      parentToolCallId: string | null = null,
    ): StoredMessage {
      // Redirect-at-write, like the real store: a row tagged with a PROMOTED
      // spawn is homed into the child, untagged.
      const child = parentToolCallId === null ? null : (promotions.get(parentToolCallId) ?? null)
      const m: StoredMessage = {
        id: `m${++seq}`,
        threadId: child ?? threadId,
        role,
        content,
        model,
        parentToolCallId: child === null ? parentToolCallId : null,
      }
      messages.push(m)
      return m
    },
    recordToolCall(input: {
      threadId: string
      messageId?: string
      toolName: string
      inputJson?: string
      parentToolCallId?: string | null
    }): StoredTool {
      const parentToolCallId = input.parentToolCallId ?? null
      const child = parentToolCallId === null ? null : (promotions.get(parentToolCallId) ?? null)
      const r: StoredTool = {
        id: `tc${++seq}`,
        threadId: child ?? input.threadId,
        messageId: input.messageId ?? null,
        toolName: input.toolName,
        inputJson: input.inputJson ?? null,
        outputJson: null,
        status: 'pending',
        startedAt: new Date().toISOString(),
        completedAt: null,
        parentToolCallId: child === null ? parentToolCallId : null,
        agentId: null,
      }
      toolCalls.set(r.id, r)
      return r
    },
    promotedChildId(_parentThreadId: string, toolCallId: string): string | null {
      return promotions.get(toolCallId) ?? null
    },
    // Write-once, like the real store (#1931 transcript backfill).
    setToolCallAgentId(id: string, agentId: string): void {
      const r = toolCalls.get(id)
      if (r && r.agentId === null) r.agentId = agentId
    },
    updateToolCall(
      id: string,
      patch: { status?: string; outputJson?: string | null; completedAt?: string | null },
    ): void {
      const r = toolCalls.get(id)
      if (!r) return
      if (patch.status !== undefined) r.status = patch.status
      if (patch.outputJson !== undefined) r.outputJson = patch.outputJson
      if (patch.completedAt !== undefined) r.completedAt = patch.completedAt
    },
    getToolCall(_threadId: string, id: string): StoredTool | null {
      return toolCalls.get(id) ?? null
    },
    // The sub-agent completion path reads by id alone — a promoted sub-agent's
    // rows live in the child thread, not under the parent's thread id (#1931).
    getToolCallById(id: string): StoredTool | null {
      return toolCalls.get(id) ?? null
    },
  }
  return { store: store as unknown as ThreadStore, messages, toolCalls, promotions }
}

function makeBridge() {
  const events: AgentStreamEvent[] = []
  const fake = makeFakeStore()
  const bridge = new StreamBridge('thread-1', fake.store, {
    emit: (event: AgentStreamEvent) => events.push(event),
  } as unknown as ConstructorParameters<typeof StreamBridge>[2])
  return { bridge, events, ...fake }
}

/** Feed a main-thread assistant message carrying a sub-agent tool_use —
 *  named 'Agent', which is what SDK 0.3.204 actually emits (legacy: 'Task'). */
function startTask(bridge: StreamBridge, taskUseId: string): void {
  bridge.handleMessage({
    type: 'assistant',
    parent_tool_use_id: null,
    message: {
      model: 'claude',
      content: [{ type: 'tool_use', id: taskUseId, name: 'Agent', input: { description: 'Explore' } }],
    },
  } as never)
}

describe('StreamBridge sub-agent capture (#1931)', () => {
  it('persists a sub-agent message + tool call tagged with the parent Task id', () => {
    const { bridge, messages, toolCalls } = makeBridge()
    startTask(bridge, 'task-use-1')
    const taskId = [...toolCalls.values()].find((t) => t.toolName === 'Agent')?.id
    expect(taskId).toBeDefined()

    // Sub-agent assistant: text + a Grep tool_use, parent = the Task tool_use id.
    bridge.handleMessage({
      type: 'assistant',
      parent_tool_use_id: 'task-use-1',
      message: {
        model: 'claude',
        content: [
          { type: 'text', text: 'searching the codebase' },
          { type: 'tool_use', id: 'grep-use-1', name: 'Grep', input: { pattern: 'x' } },
        ],
      },
    } as never)

    const subMsg = messages.find((m) => m.content === 'searching the codebase')
    expect(subMsg?.parentToolCallId).toBe(taskId)
    const grep = [...toolCalls.values()].find((t) => t.toolName === 'Grep')
    expect(grep?.parentToolCallId).toBe(taskId)
    expect(grep?.status).toBe('running')

    // Sub-agent tool_result → finalize the Grep call.
    bridge.handleMessage({
      type: 'user',
      parent_tool_use_id: 'task-use-1',
      message: {
        content: [{ type: 'tool_result', tool_use_id: 'grep-use-1', content: 'found it', is_error: false }],
      },
    } as never)

    const grepDone = [...toolCalls.values()].find((t) => t.toolName === 'Grep')
    expect(grepDone?.status).toBe('success')
    expect(grepDone?.outputJson).toContain('found it')

    // The parent Task call is untouched by sub-agent activity (still open).
    expect(toolCalls.get(taskId as string)?.status).not.toBe('success')
  })

  it('leaves the main-thread path unchanged (parent null)', () => {
    const { bridge, messages, toolCalls } = makeBridge()
    bridge.handleMessage({
      type: 'assistant',
      parent_tool_use_id: null,
      message: {
        model: 'claude',
        content: [
          { type: 'text', text: 'main answer' },
          { type: 'tool_use', id: 'read-use-1', name: 'Read', input: { file_path: '/a' } },
        ],
      },
    } as never)
    const mainMsg = messages.find((m) => m.content === 'main answer')
    expect(mainMsg?.parentToolCallId ?? null).toBeNull()
    const read = [...toolCalls.values()].find((t) => t.toolName === 'Read')
    expect(read?.parentToolCallId ?? null).toBeNull()
  })

  it('ignores a sub-agent message whose parent Task is unknown', () => {
    const { bridge, messages, toolCalls } = makeBridge()
    bridge.handleMessage({
      type: 'assistant',
      parent_tool_use_id: 'never-seen',
      message: { model: 'claude', content: [{ type: 'text', text: 'orphan' }] },
    } as never)
    expect(messages).toHaveLength(0)
    expect(toolCalls.size).toBe(0)
  })
})

describe('StreamBridge task → persisted-record join (#1931 D-4)', () => {
  function makeTrackedBridge() {
    const events: AgentStreamEvent[] = []
    const fake = makeFakeStore()
    const tracker = new BackgroundTaskTracker()
    const bridge = new StreamBridge('thread-1', fake.store, {
      emit: (event: AgentStreamEvent) => events.push(event),
      backgroundTasks: tracker,
    } as unknown as ConstructorParameters<typeof StreamBridge>[2])
    return { bridge, events, tracker, ...fake }
  }

  it("resolves a task event's tool_use_id to the persisted record id", () => {
    const { bridge, tracker, toolCalls } = makeTrackedBridge()
    startTask(bridge, 'task-use-1')
    const recordId = [...toolCalls.values()].find((t) => t.toolName === 'Agent')?.id
    bridge.handleMessage({
      type: 'system',
      subtype: 'background_tasks_changed',
      tasks: [{ task_id: 'bg-1', task_type: 'local_agent', description: 'Explore' }],
    } as never)
    bridge.handleMessage({
      type: 'system',
      subtype: 'task_started',
      task_id: 'bg-1',
      tool_use_id: 'task-use-1',
      description: 'Explore',
      subagent_type: 'general-purpose',
    } as never)
    expect(tracker.list('thread-1')[0]?.toolCallId).toBe(recordId)
    // …and persists the sub-agent's id onto the spawn record — the transcript
    // backfill key future promotions resolve deterministically (#1931).
    expect(toolCalls.get(recordId as string)?.agentId).toBe('bg-1')
  })

  it('still resolves AFTER the spawning tool call completed (a backgrounded agent)', () => {
    // A backgrounded Agent call gets its tool_result immediately — which drops
    // the completion map's entry — while task events keep arriving. The join
    // must survive that, or every backgrounded sub-agent loses its chat route.
    const { bridge, tracker, toolCalls } = makeTrackedBridge()
    startTask(bridge, 'task-use-1')
    const recordId = [...toolCalls.values()].find((t) => t.toolName === 'Agent')?.id
    bridge.handleMessage({
      type: 'user',
      parent_tool_use_id: null,
      message: {
        content: [
          { type: 'tool_result', tool_use_id: 'task-use-1', content: 'backgrounded', is_error: false },
        ],
      },
    } as never)
    bridge.handleMessage({
      type: 'system',
      subtype: 'background_tasks_changed',
      tasks: [{ task_id: 'bg-1', task_type: 'local_agent', description: 'Explore' }],
    } as never)
    bridge.handleMessage({
      type: 'system',
      subtype: 'task_progress',
      task_id: 'bg-1',
      tool_use_id: 'task-use-1',
      description: 'Explore',
      usage: { total_tokens: 10, tool_uses: 1, duration_ms: 5000 },
    } as never)
    expect(tracker.list('thread-1')[0]?.toolCallId).toBe(recordId)
    // Progress stamps the agent id too — a start that raced the spawn's
    // persistence still gets its backfill key from the next report.
    expect(toolCalls.get(recordId as string)?.agentId).toBe('bg-1')
  })

  it('carries no join when the runtime sent no tool_use_id', () => {
    const { bridge, tracker } = makeTrackedBridge()
    startTask(bridge, 'task-use-1')
    bridge.handleMessage({
      type: 'system',
      subtype: 'background_tasks_changed',
      tasks: [{ task_id: 'bg-1', task_type: 'local_agent', description: 'Explore' }],
    } as never)
    bridge.handleMessage({
      type: 'system',
      subtype: 'task_started',
      task_id: 'bg-1',
      description: 'Explore',
    } as never)
    expect(tracker.list('thread-1')[0]?.toolCallId).toBeUndefined()
  })
})

// ── Sub-agent LIVE layer (#1931 follow-up) ─────────────────────────────────
// A PROMOTED spawn's live traffic re-emits on the main stream channel targeted
// at the CHILD's threadId; unpromoted spawns emit nothing (the old behavior).

function subStream(bridge: StreamBridge, parentUseId: string, event: unknown): void {
  bridge.handleMessage({
    type: 'stream_event',
    parent_tool_use_id: parentUseId,
    event,
  } as never)
}

/** Spawn a Task and promote it, returning the spawn's record id. */
function startPromotedTask(
  fake: ReturnType<typeof makeBridge>,
  taskUseId: string,
  childId: string,
): string {
  startTask(fake.bridge, taskUseId)
  const taskId = [...fake.toolCalls.values()].find((t) => t.toolName === 'Agent')?.id as string
  fake.promotions.set(taskId, childId)
  return taskId
}

describe('StreamBridge sub-agent live layer (#1931 follow-up)', () => {
  it('streams a promoted sub-agent message into the CHILD: start, delta, text-stop', () => {
    const fake = makeBridge()
    startPromotedTask(fake, 'task-use-1', 'child-1')
    fake.events.length = 0

    subStream(fake.bridge, 'task-use-1', { type: 'message_start', message: {} })
    subStream(fake.bridge, 'task-use-1', {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text' },
    })
    subStream(fake.bridge, 'task-use-1', {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: 'live sub-agent text' },
    })
    // A non-delta event flushes the coalesced delta first (PERF-2 ordering).
    subStream(fake.bridge, 'task-use-1', { type: 'content_block_stop', index: 0 })

    expect(fake.events.map((event) => event.kind)).toEqual([
      'message-start',
      'message-delta',
      'text-stop',
    ])
    for (const event of fake.events) {
      expect((event as { threadId: string }).threadId).toBe('child-1')
    }
    const delta = fake.events.find((event) => event.kind === 'message-delta')
    expect((delta as { text: string }).text).toBe('live sub-agent text')
    const start = fake.events.find((event) => event.kind === 'message-start')
    const stop = fake.events.find((event) => event.kind === 'text-stop')
    expect((start as { messageId: string }).messageId).toBe(
      (stop as { messageId: string }).messageId,
    )
  })

  it('emits NOTHING for an unpromoted spawn (the old behavior, to the byte)', () => {
    const fake = makeBridge()
    startTask(fake.bridge, 'task-use-1')
    fake.events.length = 0

    subStream(fake.bridge, 'task-use-1', { type: 'message_start', message: {} })
    subStream(fake.bridge, 'task-use-1', {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text' },
    })
    subStream(fake.bridge, 'task-use-1', {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: 'invisible' },
    })
    subStream(fake.bridge, 'task-use-1', { type: 'content_block_stop', index: 0 })
    // The whole-message fallback stays silent too.
    fake.bridge.handleMessage({
      type: 'assistant',
      parent_tool_use_id: 'task-use-1',
      message: { model: 'claude', content: [{ type: 'text', text: 'invisible' }] },
    } as never)

    expect(fake.events).toEqual([])
  })

  it('forwards a thinking block as child-targeted thinking edges', () => {
    const fake = makeBridge()
    startPromotedTask(fake, 'task-use-1', 'child-1')
    fake.events.length = 0

    subStream(fake.bridge, 'task-use-1', { type: 'message_start', message: {} })
    subStream(fake.bridge, 'task-use-1', {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'thinking' },
    })
    subStream(fake.bridge, 'task-use-1', { type: 'content_block_stop', index: 0 })

    const thinking = fake.events.filter((event) => event.kind === 'thinking')
    expect(thinking).toEqual([
      { kind: 'thinking', threadId: 'child-1', active: true },
      { kind: 'thinking', threadId: 'child-1', active: false },
    ])
  })

  it('without partials, a persisted sub-agent message emits one synthetic live burst (no debounce lag)', () => {
    const fake = makeBridge()
    startPromotedTask(fake, 'task-use-1', 'child-1')
    fake.events.length = 0

    fake.bridge.handleMessage({
      type: 'assistant',
      parent_tool_use_id: 'task-use-1',
      message: { model: 'claude', content: [{ type: 'text', text: 'whole message' }] },
    } as never)

    expect(fake.events.map((event) => event.kind)).toEqual([
      'message-start',
      'message-delta',
      'text-stop',
    ])
    const delta = fake.events.find((event) => event.kind === 'message-delta')
    expect(delta).toMatchObject({ threadId: 'child-1', text: 'whole message' })
    // …and the durable row landed in the child (redirect-at-write unchanged).
    expect(fake.messages.find((m) => m.content === 'whole message')?.threadId).toBe('child-1')
  })

  it('with partials already streamed, the persisted message emits NO synthetic duplicate', () => {
    const fake = makeBridge()
    startPromotedTask(fake, 'task-use-1', 'child-1')
    fake.events.length = 0

    subStream(fake.bridge, 'task-use-1', { type: 'message_start', message: {} })
    subStream(fake.bridge, 'task-use-1', {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: 'streamed text' },
    })
    fake.bridge.handleMessage({
      type: 'assistant',
      parent_tool_use_id: 'task-use-1',
      message: { model: 'claude', content: [{ type: 'text', text: 'streamed text' }] },
    } as never)

    // One message-start (the stream's), one delta (flushed by the assistant
    // message arriving) — and no second start/delta pair for the persisted row.
    expect(fake.events.filter((event) => event.kind === 'message-start')).toHaveLength(1)
    expect(fake.events.filter((event) => event.kind === 'message-delta')).toHaveLength(1)
  })

  it("emits child-targeted tool-start / tool-end for a promoted sub-agent's tools", () => {
    const fake = makeBridge()
    startPromotedTask(fake, 'task-use-1', 'child-1')
    fake.events.length = 0

    fake.bridge.handleMessage({
      type: 'assistant',
      parent_tool_use_id: 'task-use-1',
      message: {
        model: 'claude',
        content: [{ type: 'tool_use', id: 'grep-use-1', name: 'Grep', input: { pattern: 'x' } }],
      },
    } as never)
    const toolStart = fake.events.find((event) => event.kind === 'tool-start')
    expect(toolStart).toMatchObject({
      threadId: 'child-1',
      toolCall: { toolName: 'Grep', status: 'running', threadId: 'child-1' },
    })

    fake.bridge.handleMessage({
      type: 'user',
      parent_tool_use_id: 'task-use-1',
      message: {
        content: [
          { type: 'tool_result', tool_use_id: 'grep-use-1', content: 'found', is_error: false },
        ],
      },
    } as never)
    const toolEnd = fake.events.find((event) => event.kind === 'tool-end')
    expect(toolEnd).toMatchObject({
      threadId: 'child-1',
      toolCall: { toolName: 'Grep', status: 'success' },
    })
  })

  it('emits no tool events for an unpromoted spawn', () => {
    const fake = makeBridge()
    startTask(fake.bridge, 'task-use-1')
    fake.events.length = 0
    fake.bridge.handleMessage({
      type: 'assistant',
      parent_tool_use_id: 'task-use-1',
      message: {
        model: 'claude',
        content: [{ type: 'tool_use', id: 'grep-use-1', name: 'Grep', input: {} }],
      },
    } as never)
    fake.bridge.handleMessage({
      type: 'user',
      parent_tool_use_id: 'task-use-1',
      message: {
        content: [
          { type: 'tool_result', tool_use_id: 'grep-use-1', content: 'found', is_error: false },
        ],
      },
    } as never)
    expect(fake.events).toEqual([])
  })

  it("the spawn settling closes the child's live turn with a targeted done", () => {
    const fake = makeBridge()
    startPromotedTask(fake, 'task-use-1', 'child-1')
    fake.bridge.handleMessage({
      type: 'assistant',
      parent_tool_use_id: 'task-use-1',
      message: { model: 'claude', content: [{ type: 'text', text: 'finding' }] },
    } as never)
    const childMessageId = fake.messages.find((m) => m.content === 'finding')?.id
    fake.events.length = 0

    // The parent Task's tool_result — the spawn is over.
    fake.bridge.handleMessage({
      type: 'user',
      parent_tool_use_id: null,
      message: {
        content: [
          { type: 'tool_result', tool_use_id: 'task-use-1', content: 'done', is_error: false },
        ],
      },
    } as never)

    const done = fake.events.filter((event) => event.kind === 'done')
    expect(done).toEqual([{ kind: 'done', threadId: 'child-1', messageId: childMessageId }])
    // The parent's own tool-end still carries the PARENT threadId.
    const toolEnd = fake.events.find((event) => event.kind === 'tool-end')
    expect(toolEnd).toMatchObject({ threadId: 'thread-1' })
  })

  it('a backgrounded spawn settles the child again at task_notification', () => {
    const events: AgentStreamEvent[] = []
    const fake = makeFakeStore()
    const tracker = new BackgroundTaskTracker()
    const bridge = new StreamBridge('thread-1', fake.store, {
      emit: (event: AgentStreamEvent) => events.push(event),
      backgroundTasks: tracker,
    } as unknown as ConstructorParameters<typeof StreamBridge>[2])
    startTask(bridge, 'task-use-1')
    const taskId = [...fake.toolCalls.values()].find((t) => t.toolName === 'Agent')?.id as string
    fake.promotions.set(taskId, 'child-1')

    // Backgrounded: the Task's tool_result arrives immediately…
    bridge.handleMessage({
      type: 'user',
      parent_tool_use_id: null,
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'task-use-1',
            content: 'backgrounded',
            is_error: false,
          },
        ],
      },
    } as never)
    bridge.handleMessage({
      type: 'system',
      subtype: 'background_tasks_changed',
      tasks: [{ task_id: 'bg-1', task_type: 'local_agent', description: 'Explore' }],
    } as never)
    bridge.handleMessage({
      type: 'system',
      subtype: 'task_started',
      task_id: 'bg-1',
      tool_use_id: 'task-use-1',
      description: 'Explore',
      subagent_type: 'general-purpose',
    } as never)
    // …while the agent keeps writing into the promoted child.
    bridge.handleMessage({
      type: 'assistant',
      parent_tool_use_id: 'task-use-1',
      message: { model: 'claude', content: [{ type: 'text', text: 'late finding' }] },
    } as never)
    events.length = 0

    // The real end: the background task notification.
    bridge.handleMessage({
      type: 'system',
      subtype: 'task_notification',
      task_id: 'bg-1',
    } as never)

    const done = events.filter((event) => event.kind === 'done')
    expect(done).toHaveLength(1)
    expect(done[0]).toMatchObject({ threadId: 'child-1' })
  })

  it('leaves the PARENT stream path untouched: parent partials still target the parent', () => {
    const fake = makeBridge()
    startPromotedTask(fake, 'task-use-1', 'child-1')
    fake.events.length = 0

    fake.bridge.handleMessage({
      type: 'stream_event',
      parent_tool_use_id: null,
      event: { type: 'message_start', message: {} },
    } as never)
    fake.bridge.handleMessage({
      type: 'stream_event',
      parent_tool_use_id: null,
      event: {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'parent prose' },
      },
    } as never)
    fake.bridge.handleMessage({
      type: 'stream_event',
      parent_tool_use_id: null,
      event: { type: 'content_block_stop', index: 0 },
    } as never)

    for (const event of fake.events) {
      expect((event as { threadId: string }).threadId).toBe('thread-1')
    }
    expect(fake.events.some((event) => event.kind === 'message-delta')).toBe(true)
  })
})
