/**
 * Mid-run subtasks, Phase 4 — the agent wiring around SubtaskRegistry, against a
 * real ThreadStore on a temp database and a fake SDK query:
 *   - the Agent PreToolUse ticket gate (link, deny unknown, deny over cap, pass
 *     a skill sub-agent through),
 *   - the source-prompt resolution `start_subtask` uses,
 *   - the session wiring (the gate, the pre-approved tool, the write record),
 *   - the bridge forwarding task_started / task_notification and announcing a
 *     freed slot to the agent (SDK input only — never a stored message),
 *   - Stop (refused without a live session; stopTask on the linked task id,
 *     settled once, by the SDK's own notification).
 * Runs under Electron-as-Node (node scripts/run-jest.mjs) for better-sqlite3.
 */
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import type { Options, Query } from '@anthropic-ai/claude-agent-sdk'

import type { CredentialsManager } from '../credentials'
import { openDatabase, type FlowDatabase } from '../store/db'
import { ThreadStore } from '../store/thread-store'
import { AgentManager, subtaskAgentHookDecision, subtaskSlotFreeText, type QueryFunction } from './agent-manager'
import { flowToolName, SUBTASK_TOOL_NAME } from './board-tools/board-tools-shared'
import { PermissionBroker } from './permissions'
import { StreamBridge } from './stream-bridge'
import {
  SUBTASK_RUNNING_CAP,
  SubtaskRegistry,
  isSubtaskTicket,
  makeTicket,
  subtaskSourceMessageId,
} from './subtask-registry'

interface Fed {
  message: { content: unknown }
  priority?: string
}

/** A query whose iteration parks until push() delivers a message. */
function makeFakeQuery(): {
  push(message: unknown): void
  release(): void
  stopTask: jest.Mock
  interrupt: jest.Mock
  close: jest.Mock
  setModel: jest.Mock
  [Symbol.asyncIterator](): AsyncIterator<unknown>
} {
  const buffered: unknown[] = []
  let waiting: ((result: IteratorResult<unknown>) => void) | null = null
  let ended = false
  return {
    push(message) {
      if (waiting) {
        const resolve = waiting
        waiting = null
        resolve({ value: message, done: false })
        return
      }
      buffered.push(message)
    },
    release() {
      ended = true
      if (waiting) {
        const resolve = waiting
        waiting = null
        resolve({ value: undefined, done: true })
      }
    },
    stopTask: jest.fn().mockResolvedValue(undefined),
    interrupt: jest.fn().mockResolvedValue(undefined),
    close: jest.fn(),
    setModel: jest.fn().mockResolvedValue(undefined),
    [Symbol.asyncIterator]() {
      return {
        next: () => {
          if (buffered.length > 0) return Promise.resolve({ value: buffered.shift(), done: false })
          if (ended) return Promise.resolve({ value: undefined, done: true })
          return new Promise((resolve) => {
            waiting = resolve
          })
        },
      }
    },
  }
}

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve))
}

describe('mid-run subtasks — agent wiring', () => {
  let tempDir: string
  let db: FlowDatabase
  let store: ThreadStore
  let registry: SubtaskRegistry
  let threadId: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'flow-subtask-wiring-'))
    db = openDatabase(join(tempDir, 'flow.sqlite'))
    store = new ThreadStore(db)
    registry = new SubtaskRegistry(store, () => {})
    threadId = store.createThread({ projectRoot: tempDir, title: 'main' }).id
  })

  afterEach(() => {
    db.close()
    rmSync(tempDir, { recursive: true, force: true })
    jest.restoreAllMocks()
  })

  const start = (title: string): string => {
    const result = registry.start({ threadId, fromMessageId: null, title, task: `do ${title}` })
    if (!result.ok) throw new Error(result.reason)
    return result.ticket
  }

  describe('ticket shape and source prompt', () => {
    it('knows a minted ticket and nothing else', () => {
      expect(isSubtaskTicket(makeTicket())).toBe(true)
      expect(isSubtaskTicket('code-reviewer')).toBe(false)
      expect(isSubtaskTicket('st-')).toBe(false)
      expect(isSubtaskTicket(undefined)).toBe(false)
    })

    it('resolves the quoted prompt, newest first, else the latest user message', () => {
      const messages = [
        { id: 'u1', role: 'user', content: 'Fix the  Login page' },
        { id: 'a1', role: 'assistant', content: 'fix the login page — on it' },
        { id: 'u2', role: 'user', content: 'also update the README' },
      ]
      expect(subtaskSourceMessageId(messages, 'fix the login')).toBe('u1')
      expect(subtaskSourceMessageId(messages, 'README')).toBe('u2')
      expect(subtaskSourceMessageId(messages, 'nothing like this')).toBe('u2')
      expect(subtaskSourceMessageId(messages)).toBe('u2')
      expect(subtaskSourceMessageId([{ id: 'a', role: 'assistant', content: 'x' }])).toBeNull()
    })
  })

  describe('the Agent ticket gate', () => {
    it('links a known running ticket to the Agent call and allows it', () => {
      const ticket = start('a')
      const outcome = subtaskAgentHookDecision(registry, threadId, { name: ticket, prompt: 'p' }, 'tu-1')
      expect(outcome).toEqual({ continue: true })
      expect(store.getSubtask(ticket)?.toolCallId).toBe('tu-1')
    })

    it('denies an unknown ticket with a reason the agent can act on', () => {
      // The positive first (#28): a real ticket on this thread does link.
      expect(subtaskAgentHookDecision(registry, threadId, { name: start('real') }, 'tu-0')).toEqual({ continue: true })
      const outcome = subtaskAgentHookDecision(registry, threadId, { name: 'st-zzzzzz' }, 'tu-2')
      expect(outcome.hookSpecificOutput?.permissionDecision).toBe('deny')
      expect(outcome.hookSpecificOutput?.permissionDecisionReason).toContain('start_subtask')
    })

    it('denies a queued ticket while every slot is taken', () => {
      const tickets = Array.from({ length: SUBTASK_RUNNING_CAP }, (_, i) => start(`r${i}`))
      tickets.forEach((ticket, i) => {
        expect(subtaskAgentHookDecision(registry, threadId, { name: ticket }, `tu-r${i}`)).toEqual({ continue: true })
      })
      const queued = start('over')
      expect(store.getSubtask(queued)?.state).toBe('queued')
      const outcome = subtaskAgentHookDecision(registry, threadId, { name: queued }, 'tu-over')
      expect(outcome.hookSpecificOutput?.permissionDecision).toBe('deny')
      expect(outcome.hookSpecificOutput?.permissionDecisionReason).toContain('queued')
      expect(store.getSubtask(queued)?.toolCallId).toBeNull()
    })

    it('passes an Agent call with no ticket (a skill sub-agent) unchanged', () => {
      const link = jest.fn()
      const fake = { link } as unknown as Pick<SubtaskRegistry, 'link'>
      // The positive first (#28): a ticket-shaped name does reach the registry.
      link.mockReturnValue({ ok: true, record: {} })
      subtaskAgentHookDecision(fake, threadId, { name: 'st-abc123' }, 'tu-x')
      expect(link).toHaveBeenCalledTimes(1)
      expect(subtaskAgentHookDecision(fake, threadId, { prompt: 'review' }, 'tu-y')).toEqual({ continue: true })
      expect(subtaskAgentHookDecision(fake, threadId, { name: 'code-reviewer' }, 'tu-z')).toEqual({ continue: true })
      expect(link).toHaveBeenCalledTimes(1)
    })
  })

  describe('the bridge forwards task events', () => {
    function bridge(onSlotFree: jest.Mock): StreamBridge {
      return new StreamBridge(threadId, store, {
        onSessionId: () => {},
        emit: () => {},
        subtasks: registry,
        onSubtaskSlotFree: onSlotFree,
      })
    }

    it('task_started stores the task id; task_notification settles and names the next ticket', () => {
      const onSlotFree = jest.fn()
      const b = bridge(onSlotFree)
      const tickets = Array.from({ length: SUBTASK_RUNNING_CAP }, (_, i) => start(`r${i}`))
      tickets.forEach((ticket, i) => registry.link({ threadId, ticket, toolCallId: `tu-${i}` }))
      const queued = start('waiting')

      b.handleMessage({ type: 'system', subtype: 'task_started', task_id: 'task-0', tool_use_id: 'tu-0', description: 'r0' } as never)
      expect(store.getSubtask(tickets[0])?.sdkTaskId).toBe('task-0')

      b.handleMessage({
        type: 'system',
        subtype: 'task_notification',
        task_id: 'task-0',
        tool_use_id: 'tu-0',
        status: 'failed',
        output_file: '',
        summary: 'it broke',
      } as never)
      expect(store.getSubtask(tickets[0])).toMatchObject({ state: 'failed', error: 'it broke' })
      expect(onSlotFree).toHaveBeenCalledTimes(1)
      expect(onSlotFree.mock.calls[0][0].ticket).toBe(queued)
    })

    it('a skill sub-agent task changes no subtask row', () => {
      const onSlotFree = jest.fn()
      const b = bridge(onSlotFree)
      const ticket = start('mine')
      registry.link({ threadId, ticket, toolCallId: 'tu-mine' })
      b.handleMessage({ type: 'system', subtype: 'task_started', task_id: 'task-mine', tool_use_id: 'tu-mine', description: '' } as never)
      expect(store.getSubtask(ticket)?.sdkTaskId).toBe('task-mine')
      b.handleMessage({ type: 'system', subtype: 'task_started', task_id: 'task-skill', tool_use_id: 'tu-skill', description: '' } as never)
      b.handleMessage({
        type: 'system',
        subtype: 'task_notification',
        task_id: 'task-skill',
        status: 'completed',
        output_file: '',
        summary: '',
      } as never)
      expect(store.getSubtask(ticket)).toMatchObject({ state: 'running', sdkTaskId: 'task-mine' })
      expect(onSlotFree).not.toHaveBeenCalled()
    })
  })

  describe('the session', () => {
    const credentialsStub = { get: () => null } as unknown as CredentialsManager

    function harness() {
      let captured: Options | undefined
      let current: ReturnType<typeof makeFakeQuery> | null = null
      let iterator: AsyncIterator<Fed> | null = null
      const queryFn = jest.fn((params: { prompt: AsyncIterable<Fed>; options?: Options }): Query => {
        captured = params.options
        iterator = params.prompt[Symbol.asyncIterator]()
        current = makeFakeQuery()
        return current as unknown as Query
      })
      jest.spyOn(console, 'error').mockImplementation(() => {})
      const manager = new AgentManager(store, credentialsStub, new PermissionBroker(db), {
        queryFn: queryFn as unknown as QueryFunction,
        subtasks: registry,
      })
      const hook = (toolName: string) => {
        const entries = captured?.hooks?.PreToolUse ?? []
        const matching = entries.filter((entry) => (entry.matcher ?? '').split('|').includes(toolName))
        if (matching.length === 0) throw new Error(`no PreToolUse hook matches ${toolName}`)
        return async (input: Record<string, unknown>) => {
          const outcomes: unknown[] = []
          for (const entry of matching) {
            outcomes.push(
              await entry.hooks[0](
                {
                  hook_event_name: 'PreToolUse',
                  tool_name: toolName,
                  session_id: 's',
                  transcript_path: '',
                  cwd: tempDir,
                  ...input,
                } as never,
                input.tool_use_id as string,
                { signal: new AbortController().signal },
              ),
            )
          }
          return outcomes
        }
      }
      return {
        manager,
        options: () => captured as Options,
        query: () => current as ReturnType<typeof makeFakeQuery>,
        fed: async () => {
          const next = await (iterator as AsyncIterator<Fed>).next()
          return next.value
        },
        hook,
      }
    }

    it('wires the gate, pre-approves start_subtask and records writes per subtask', async () => {
      const h = harness()
      await h.manager.sendMessage(threadId, 'go')
      await h.fed()
      expect(h.options().allowedTools).toContain(flowToolName(SUBTASK_TOOL_NAME))

      const ticket = start('docs')
      const [linked] = await h.hook('Agent')({ tool_input: { name: ticket }, tool_use_id: 'tu-docs' })
      expect(linked).toEqual({ continue: true })
      h.query().push({ type: 'system', subtype: 'task_started', task_id: 'task-docs', tool_use_id: 'tu-docs', description: '' })
      await flush()
      expect(store.getSubtask(ticket)?.sdkTaskId).toBe('task-docs')

      const file = join(tempDir, 'README.md')
      await h.hook('Write')({ tool_input: { file_path: file, content: 'x' }, tool_use_id: 'tu-w1', agent_id: 'task-docs' })
      expect(store.getSubtask(ticket)?.filesWritten).toEqual([file])
      expect(store.getSubtask(ticket)?.overlapFiles).toEqual([])
      // The main agent (no agent_id) writes the same file: an overlap, not a block.
      const [mainOutcome] = await h.hook('Write')({ tool_input: { file_path: file, content: 'y' }, tool_use_id: 'tu-w2' })
      expect(mainOutcome).toEqual({ continue: true })
      expect(store.getSubtask(ticket)?.overlapFiles).toEqual([file])

      const [denied] = await h.hook('Agent')({ tool_input: { name: 'st-zzzzzz' }, tool_use_id: 'tu-bad' })
      expect(denied).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } })
      h.manager.dispose()
    })

    it('tells the agent a queued ticket may start, through the SDK input only', async () => {
      const h = harness()
      await h.manager.sendMessage(threadId, 'go')
      await h.fed()
      const tickets = Array.from({ length: SUBTASK_RUNNING_CAP }, (_, i) => start(`r${i}`))
      tickets.forEach((ticket, i) => registry.link({ threadId, ticket, toolCallId: `tu-${i}` }))
      const queued = start('waiting')
      h.query().push({ type: 'system', subtype: 'task_started', task_id: 'task-0', tool_use_id: 'tu-0', description: '' })
      h.query().push({
        type: 'system',
        subtype: 'task_notification',
        task_id: 'task-0',
        status: 'completed',
        output_file: '',
        summary: 'done',
      })
      const told = await h.fed()
      expect(told.message.content).toBe(subtaskSlotFreeText({ ticket: queued, title: 'waiting' }))
      expect(told.priority).toBe('next')
      expect(store.getSubtask(tickets[0])?.state).toBe('done')
      // Not the person's message: only their own prompt is stored.
      expect(store.listMessages(threadId).map((m) => [m.role, m.content])).toEqual([['user', 'go']])
      h.manager.dispose()
    })

    it('Stop refuses without a live session, then stops the linked task and settles once', async () => {
      const h = harness()
      const ticket = start('slow')
      registry.link({ threadId, ticket, toolCallId: 'tu-slow' })
      registry.onTaskStarted({ threadId, toolUseId: 'tu-slow', taskId: 'task-slow' })

      const refused = await h.manager.stopSubtask(threadId, ticket)
      expect(refused.ok).toBe(false)
      expect(refused.detail).toMatch(/not running/)

      await h.manager.sendMessage(threadId, 'go')
      await h.fed()
      const stopped = await h.manager.stopSubtask(threadId, ticket)
      expect(stopped).toEqual({ ok: true })
      expect(h.query().stopTask).toHaveBeenCalledWith('task-slow')
      // The press does not settle the row: the SDK's notification does.
      expect(store.getSubtask(ticket)?.state).toBe('running')
      h.query().push({
        type: 'system',
        subtype: 'task_notification',
        task_id: 'task-slow',
        status: 'stopped',
        output_file: '',
        summary: '',
      })
      await flush()
      expect(store.getSubtask(ticket)?.state).toBe('stopped')

      const again = await h.manager.stopSubtask(threadId, ticket)
      expect(again.ok).toBe(false)
      expect(h.query().stopTask).toHaveBeenCalledTimes(1)
      h.manager.dispose()
    })
  })
})
