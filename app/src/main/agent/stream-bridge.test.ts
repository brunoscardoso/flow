import { StreamBridge } from './stream-bridge'
import { BackgroundTaskTracker } from './background-tasks'
import type { AgentStreamEvent } from '../../shared/ipc-contract'
import type { ThreadStore } from '../store/thread-store'

/**
 * THE DEAD SCREEN BETWEEN A SENTENCE AND THE NEXT TOOL.
 *
 * Reported live: "the agent still waiting for response but we remove the
 * loading complete from the ui" — a turn that had finished a paragraph and was
 * choosing its next move showed no text moving and no loader, while the run was
 * still live and the Interrupt button still offered to stop it.
 *
 * The renderer drops its loader on the first `message-delta`, deliberately —
 * visible text IS the feedback while it flows. It could only put the loader back
 * on `thinking`, `tool-start` or `done`, so the gap before any of those arrived
 * rendered as nothing at all.
 *
 * The signal existed the whole time and was thrown away here: `content_block_stop`
 * fires for every block, and this bridge translated it ONLY for thinking blocks.
 * A text block ending emitted nothing, so the renderer could not learn that text
 * had stopped. These tests hold that translation.
 *
 * Why the bridge and not the pane: the pane's half is a `setTimeout` against a
 * live DOM, and this suite runs `testEnvironment: 'node'` with no layout. What
 * is testable here is the CONTRACT — that the stop is emitted, for the right
 * block type, naming the right message — and that is the half that was missing.
 */

function makeBridge(): { bridge: StreamBridge; events: AgentStreamEvent[] } {
  const events: AgentStreamEvent[] = []
  // The store is never reached by a `stream_event` path — every case under test
  // returns before persistence. A proxy that throws makes that a fact the test
  // asserts rather than a claim, so a future edit that starts persisting here
  // fails loudly instead of silently writing during a stream.
  const store = new Proxy(
    {},
    {
      get(_target, prop) {
        throw new Error(`stream path must not touch the store (read ${String(prop)})`)
      },
    },
  ) as unknown as ThreadStore
  const bridge = new StreamBridge('thread-1', store, {
    emit: (event: AgentStreamEvent) => events.push(event),
  } as unknown as ConstructorParameters<typeof StreamBridge>[2])
  return { bridge, events }
}

/** Open a message so deltas have an id to attach to, and drop the start event. */
function startMessage(bridge: StreamBridge, events: AgentStreamEvent[]): string {
  bridge.handleMessage({
    type: 'stream_event',
    parent_tool_use_id: null,
    event: { type: 'message_start' },
  } as never)
  const start = events.find((e) => e.kind === 'message-start')
  if (start === undefined || start.kind !== 'message-start') {
    throw new Error('no message-start emitted')
  }
  events.length = 0
  return start.messageId
}

function openBlock(bridge: StreamBridge, index: number, type: string): void {
  bridge.handleMessage({
    type: 'stream_event',
    parent_tool_use_id: null,
    event: { type: 'content_block_start', index, content_block: { type } },
  } as never)
}

function closeBlock(bridge: StreamBridge, index: number): void {
  bridge.handleMessage({
    type: 'stream_event',
    parent_tool_use_id: null,
    event: { type: 'content_block_stop', index },
  } as never)
}

describe('StreamBridge — a text block ending is a signal', () => {
  it('emits text-stop when a text block closes, naming the streaming message', () => {
    const { bridge, events } = makeBridge()
    const messageId = startMessage(bridge, events)

    openBlock(bridge, 0, 'text')
    closeBlock(bridge, 0)

    expect(events).toEqual([{ kind: 'text-stop', threadId: 'thread-1', messageId }])
  })

  it('does not confuse a thinking block for a text block', () => {
    const { bridge, events } = makeBridge()
    startMessage(bridge, events)

    openBlock(bridge, 0, 'thinking')
    closeBlock(bridge, 0)

    // Thinking keeps its own active/inactive PAIR and must NOT also report that
    // visible text stopped — the pane treats those as different states, and a
    // spurious text-stop here would re-show the loader under a thinking block
    // that is already its own indicator.
    expect(events).toEqual([
      { kind: 'thinking', threadId: 'thread-1', active: true },
      { kind: 'thinking', threadId: 'thread-1', active: false },
    ])
  })

  it('emits nothing for a tool_use block closing', () => {
    const { bridge, events } = makeBridge()
    startMessage(bridge, events)

    openBlock(bridge, 0, 'tool_use')
    closeBlock(bridge, 0)

    // A tool has its own card, which is its own running indicator.
    expect(events).toEqual([])
  })

  it('emits one stop per text block, so interleaved prose and tools each end', () => {
    const { bridge, events } = makeBridge()
    const messageId = startMessage(bridge, events)

    // The shape that produced the report: prose, a tool, more prose.
    openBlock(bridge, 0, 'text')
    closeBlock(bridge, 0)
    openBlock(bridge, 1, 'tool_use')
    closeBlock(bridge, 1)
    openBlock(bridge, 2, 'text')
    closeBlock(bridge, 2)

    expect(events.filter((e) => e.kind === 'text-stop')).toEqual([
      { kind: 'text-stop', threadId: 'thread-1', messageId },
      { kind: 'text-stop', threadId: 'thread-1', messageId },
    ])
  })

  it('drops a stop with no open message rather than inventing an id', () => {
    const { bridge, events } = makeBridge()
    // No message_start — e.g. the bridge attached mid-turn.
    openBlock(bridge, 0, 'text')
    closeBlock(bridge, 0)

    expect(events.filter((e) => e.kind === 'text-stop')).toEqual([])
  })

  it('flushes buffered delta text BEFORE the stop, never after', () => {
    const { bridge, events } = makeBridge()
    const messageId = startMessage(bridge, events)

    openBlock(bridge, 0, 'text')
    bridge.handleMessage({
      type: 'stream_event',
      parent_tool_use_id: null,
      event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } },
    } as never)
    closeBlock(bridge, 0)

    // Ordering is the point: a stop arriving before its own text would tell the
    // renderer the prose ended and THEN hand it more prose to render.
    expect(events).toEqual([
      { kind: 'message-delta', threadId: 'thread-1', messageId, text: 'hi' },
      { kind: 'text-stop', threadId: 'thread-1', messageId },
    ])
  })
})

/**
 * WORK THAT OUTLIVES THE TURN.
 *
 * Reported live: "we are not having any indicator of subagent in background,
 * seems to me that the chat is stopped, everywhere, thread list, tasks, chat".
 * Nothing was stopped — an agent had backgrounded four review passes, the
 * parent turn ended normally, and the thread went to its resting status with
 * every surface reading that as "finished".
 *
 * The evidence was arriving the whole time and being dropped here: the runtime
 * emits `background_tasks_changed` (the live set, on every change) plus
 * `task_started` / `task_progress` / `task_notification`, and this bridge
 * translated exactly two system subtypes — `init` and `permission_denied`.
 * Everything else fell through the switch's default.
 *
 * These tests hold the routing. The rules themselves (level replaces, edges
 * decorate, a settled task dies either way) live in BackgroundTaskTracker and
 * are tested there — what can only be checked HERE is that the SDK's real
 * message shapes reach it at all, which is the half that was missing and the
 * half a rename upstream would silently break.
 */
function makeTrackingBridge(): {
  bridge: StreamBridge
  events: AgentStreamEvent[]
  tracker: BackgroundTaskTracker
} {
  const events: AgentStreamEvent[] = []
  const tracker = new BackgroundTaskTracker()
  const store = new Proxy(
    {},
    {
      get(_target, prop) {
        throw new Error(`background-task path must not touch the store (read ${String(prop)})`)
      },
    },
  ) as unknown as ThreadStore
  const bridge = new StreamBridge('thread-1', store, {
    emit: (event: AgentStreamEvent) => events.push(event),
    // Needed only by the `init` case below — the background-task path calls
    // nothing but `emit`, which is the point of asserting both here.
    onSessionId: () => {},
    backgroundTasks: tracker,
  } as unknown as ConstructorParameters<typeof StreamBridge>[2])
  return { bridge, events, tracker }
}

/** The `background-tasks` payloads emitted so far. */
function backgroundPayloads(events: AgentStreamEvent[]): AgentStreamEvent[] {
  return events.filter((event) => event.kind === 'background-tasks')
}

describe('StreamBridge — background work that outlives the turn', () => {
  const level = {
    type: 'system' as const,
    subtype: 'background_tasks_changed' as const,
    session_id: 's',
    uuid: 'u1',
    tasks: [
      // 'local_agent' is the task_type SDK 0.3.204's events actually carry.
      { task_id: 'bg1', task_type: 'local_agent', description: 'security review pass' },
      { task_id: 'bg2', task_type: 'local_agent', description: 'performance review pass' },
    ],
  }

  it('broadcasts the live set when the runtime announces one', () => {
    const { bridge, events } = makeTrackingBridge()
    bridge.handleMessage(level as never)
    const emitted = backgroundPayloads(events)
    expect(emitted).toHaveLength(1)
    const only = emitted[0]
    expect(only?.kind === 'background-tasks' && only.tasks.map((t) => t.id)).toEqual(['bg1', 'bg2'])
  })

  it('carries the sub-agent’s type and elapsed time from a progress report', () => {
    const { bridge, events } = makeTrackingBridge()
    bridge.handleMessage(level as never)
    events.length = 0
    bridge.handleMessage({
      type: 'system',
      subtype: 'task_progress',
      session_id: 's',
      uuid: 'u2',
      task_id: 'bg1',
      description: 'security review pass',
      subagent_type: 'security-reviewer',
      last_tool_name: 'Grep',
      usage: { total_tokens: 10, tool_uses: 2, duration_ms: 21_000 },
    } as never)
    const emitted = backgroundPayloads(events)
    expect(emitted).toHaveLength(1)
    const payload = emitted[0]
    expect(payload?.kind === 'background-tasks' && payload.tasks[0]).toMatchObject({
      agentType: 'security-reviewer',
      lastTool: 'Grep',
      elapsedMs: 21_000,
    })
  })

  it('drops a task from the set when it settles', () => {
    const { bridge, events } = makeTrackingBridge()
    bridge.handleMessage(level as never)
    events.length = 0
    bridge.handleMessage({
      type: 'system',
      subtype: 'task_notification',
      session_id: 's',
      uuid: 'u3',
      task_id: 'bg1',
      status: 'completed',
      output_file: '/tmp/bg1.jsonl',
      summary: 'security review pass finished',
    } as never)
    const payload = backgroundPayloads(events).at(-1)
    expect(payload?.kind === 'background-tasks' && payload.tasks.map((t) => t.id)).toEqual(['bg2'])
  })

  it('says nothing when a level repeats what it already said', () => {
    // The level fires on every membership change anywhere in the session. A
    // repeat that draws identically must not cost an IPC broadcast and a
    // repaint on every surface.
    const { bridge, events } = makeTrackingBridge()
    bridge.handleMessage(level as never)
    events.length = 0
    bridge.handleMessage(level as never)
    expect(backgroundPayloads(events)).toEqual([])
  })

  it('still handles the two subtypes it always did', () => {
    // The routing change added an `else` to this switch — a mistake there would
    // silently stop binding the session or resolving a denied tool call.
    const { bridge, events } = makeTrackingBridge()
    bridge.handleMessage({
      type: 'system',
      subtype: 'init',
      session_id: 's',
      uuid: 'u4',
      model: 'claude-opus-5',
    } as never)
    expect(events.some((event) => event.kind === 'model')).toBe(true)
  })

  it('tracks nothing when no tracker is wired, and does not throw', () => {
    // A runtime that reports no background work, and every existing test's
    // bridge, must be unaffected.
    const { bridge, events } = makeBridge()
    expect(() => bridge.handleMessage(level as never)).not.toThrow()
    expect(backgroundPayloads(events)).toEqual([])
  })
})

/**
 * THE TURN'S END IS A STORED FACT (plan_chat-cleanup, Phase 1).
 *
 * The feed shows one answer per request: the last assistant message that ended
 * a turn. The bridge marks that message on the turn-end result — on success,
 * on interrupt and on failure — and before `done`, so the reconcile `done`
 * triggers already reads the mark.
 */
describe('StreamBridge — the turn-end result marks the turn’s last assistant message', () => {
  interface MarkingHarness {
    bridge: StreamBridge
    events: AgentStreamEvent[]
    /** Every store call, in order: `append:<id>`, `mark:<id>`, `status:<s>`, `system`. */
    log: string[]
  }

  function makeMarkingBridge(): MarkingHarness {
    const events: AgentStreamEvent[] = []
    const log: string[] = []
    let next = 0
    const store = {
      appendMessage: (_thread: string, role: string) => {
        if (role !== 'assistant') {
          log.push(role)
          return { id: `sys-${(next += 1)}` }
        }
        const id = `msg-${(next += 1)}`
        log.push(`append:${id}`)
        return { id }
      },
      markTurnEnd: (id: string) => {
        log.push(`mark:${id}`)
        return true
      },
      updateThread: (_thread: string, patch: { status: string }) => {
        log.push(`status:${patch.status}`)
      },
    } as unknown as ThreadStore
    const bridge = new StreamBridge('thread-1', store, {
      emit: (event: AgentStreamEvent) => {
        if (event.kind === 'done') log.push('done')
        events.push(event)
      },
    } as unknown as ConstructorParameters<typeof StreamBridge>[2])
    return { bridge, events, log }
  }

  function assistantText(bridge: StreamBridge, text: string): void {
    bridge.handleMessage({
      type: 'assistant',
      parent_tool_use_id: null,
      message: { model: 'claude-opus-5', content: [{ type: 'text', text }] },
    } as never)
  }

  function success(bridge: StreamBridge): void {
    bridge.handleMessage({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'ok',
      usage: { input_tokens: 1, output_tokens: 1 },
    } as never)
  }

  function failure(bridge: StreamBridge): void {
    bridge.handleMessage({
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      errors: ['the API went away'],
      usage: { input_tokens: 1, output_tokens: 1 },
    } as never)
  }

  it('marks the LAST assistant message of the turn, before done', () => {
    const { bridge, events, log } = makeMarkingBridge()
    assistantText(bridge, 'Reading the files.')
    assistantText(bridge, 'Here is the answer.')
    success(bridge)

    // Positive first: both messages persisted and the turn finished.
    expect(log.filter((entry) => entry.startsWith('append:'))).toEqual(['append:msg-1', 'append:msg-2'])
    expect(events.some((event) => event.kind === 'done')).toBe(true)
    // Only the last one is marked, and the mark lands before `done`.
    expect(log.filter((entry) => entry.startsWith('mark:'))).toEqual(['mark:msg-2'])
    expect(log.indexOf('mark:msg-2')).toBeLessThan(log.indexOf('done'))
  })

  it('marks nothing for a turn that wrote no text — not even the previous turn’s message', () => {
    const { bridge, events, log } = makeMarkingBridge()
    assistantText(bridge, 'First turn answer.')
    success(bridge)
    expect(log.filter((entry) => entry.startsWith('mark:'))).toEqual(['mark:msg-1'])

    events.length = 0
    log.length = 0
    success(bridge)
    expect(events.some((event) => event.kind === 'done')).toBe(true)
    expect(log.filter((entry) => entry.startsWith('mark:'))).toEqual([])
  })

  it('marks on the interrupted path', () => {
    const { bridge, log } = makeMarkingBridge()
    assistantText(bridge, 'Working on it.')
    bridge.markInterruptRequested()
    failure(bridge)

    expect(log).toContain('status:idle')
    expect(log.filter((entry) => entry.startsWith('mark:'))).toEqual(['mark:msg-1'])
    expect(log.indexOf('mark:msg-1')).toBeLessThan(log.indexOf('done'))
  })

  it('marks on the failed path', () => {
    const { bridge, log } = makeMarkingBridge()
    assistantText(bridge, 'Trying the call.')
    failure(bridge)

    expect(log).toContain('status:failed')
    expect(log.filter((entry) => entry.startsWith('mark:'))).toEqual(['mark:msg-1'])
    expect(log.indexOf('mark:msg-1')).toBeLessThan(log.indexOf('done'))
  })

  it('marks nothing on a nested sub-agent result while a parent tool call is open', () => {
    const { bridge, log } = makeMarkingBridge()
    const store = (bridge as unknown as { threadStore: Record<string, unknown> }).threadStore
    store.recordToolCall = () => ({ id: 'tc-1' })
    store.updateToolCall = () => undefined
    bridge.handleMessage({
      type: 'assistant',
      parent_tool_use_id: null,
      message: {
        model: 'claude-opus-5',
        content: [
          { type: 'text', text: 'Asking a helper.' },
          { type: 'tool_use', id: 'tu-1', name: 'Task', input: {} },
        ],
      },
    } as never)
    success(bridge)

    // Positive first: the message persisted; the nested result is not the turn's end.
    expect(log).toContain('append:msg-1')
    expect(log).not.toContain('done')
    expect(log.filter((entry) => entry.startsWith('mark:'))).toEqual([])
  })
})
