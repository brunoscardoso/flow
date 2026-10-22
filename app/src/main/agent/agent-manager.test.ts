// AgentManager session-lifecycle tests — real ThreadStore/PermissionBroker
// over a temp-dir better-sqlite3 DB, with an injected fake SDK queryFn.
// Regression coverage for the review findings:
//   LOG-1 — concurrent ensureSession creates exactly ONE session
//   LOG-2 — a stale session's exit never tears down its replacement
//   LOG-5 — session-creation failure marks the thread failed and surfaces
//           an error stream event before rethrowing
//   LOG-6 — interrupt/teardown RESOLVES in-flight tool calls (never strands
//   them); since #1217 a deliberate stop resolves to 'interrupted', not 'error'
//           with an interrupted marker instead of leaving them 'running'

import { mkdtempSync, realpathSync, rmSync, symlinkSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import type { Query } from '@anthropic-ai/claude-agent-sdk'

import type { Options } from '@anthropic-ai/claude-agent-sdk'

import type { AgentStreamEvent } from '../../shared/ipc-contract'
import type { CredentialsManager } from '../credentials'
import { openDatabase, type FlowDatabase } from '../store/db'
import { AccountStore } from '../store/account-store'
import { ThreadStore } from '../store/thread-store'
import { TaskStore } from '../store/task-store'
import { createManualTask, syncTaskTitleFromThread } from '../tasks/task-service'
import {
  AgentManager,
  AGENT_STREAM_EVENT,
  PERMISSION_REQUEST_EVENT,
  DIALOG_REQUEST_EVENT,
  DIALOG_CANCEL_EVENT,
  threadWorktreeBriefing,
  TURN_CLOSE_BRIEFING,
  ASKING_BRIEFING,
  sessionBriefing,
  runtimeFirstPrompt,
  type QueryFunction,
} from './agent-manager'
import { writingRulesBriefing } from './writing-rules'
import type { DialogCancel } from './dialogs'
import type { UserQuestionRequest } from '../../shared/ipc-contract'
import { AccountResolver, type AuthProbe } from './account-resolver'
import { BRAIN_FIRST_COMPACT } from './brain-first'
import { PermissionBroker } from './permissions'
import type {
  AgentRuntime,
  RuntimeCallbacks,
  RuntimeStartOptions,
} from './runtime/agent-runtime'
import { CODEX_CAPABILITIES } from './runtime/codex-runtime'

/** A fake AgentRuntime for codex-provider tests — records starts/sends, spawns
 *  no real process. */
function makeFakeRuntime(
  starts: Array<{ opts: RuntimeStartOptions; callbacks: RuntimeCallbacks }>,
  sends: string[] = [],
): AgentRuntime {
  return {
    id: 'codex',
    capabilities: CODEX_CAPABILITIES,
    start: (opts, callbacks) => {
      starts.push({ opts, callbacks })
      return {
        sessionId: null,
        send: (text: string) => sends.push(text),
        setModel: () => {},
        interrupt: () => {},
        dispose: () => {},
      }
    },
  }
}

interface FakeQuery {
  /** Feed one SDK message into the session's parked iteration loop. */
  push(message: unknown): void
  /** Lets a test end the query's message loop deterministically. */
  release(): void
  /** Reject the parked iteration — models the SDK loop throwing (#981). */
  fail(error: Error): void
  interrupt: jest.Mock
  close: jest.Mock
  setModel: jest.Mock
  [Symbol.asyncIterator](): AsyncIterator<unknown>
}

/** A Query whose iteration parks until push() delivers a message or
 *  release() ends the stream. */
function makeFakeQuery(): FakeQuery {
  const buffered: unknown[] = []
  let waiting: ((result: IteratorResult<unknown>) => void) | null = null
  let waitingReject: ((error: Error) => void) | null = null
  let ended = false
  return {
    push(message: unknown): void {
      if (waiting) {
        const resolve = waiting
        waiting = null
        resolve({ value: message, done: false })
        return
      }
      buffered.push(message)
    },
    release(): void {
      ended = true
      if (waiting) {
        const resolve = waiting
        waiting = null
        waitingReject = null
        resolve({ value: undefined, done: true })
      }
    },
    fail(error: Error): void {
      ended = true
      if (waitingReject) {
        const reject = waitingReject
        waiting = null
        waitingReject = null
        reject(error)
      }
    },
    interrupt: jest.fn().mockResolvedValue(undefined),
    close: jest.fn(),
    setModel: jest.fn().mockResolvedValue(undefined),
    [Symbol.asyncIterator](): AsyncIterator<unknown> {
      return {
        next: (): Promise<IteratorResult<unknown>> => {
          if (buffered.length > 0) {
            return Promise.resolve({ value: buffered.shift(), done: false })
          }
          if (ended) {
            return Promise.resolve({ value: undefined, done: true })
          }
          return new Promise((resolve, reject) => {
            waiting = resolve
            waitingReject = reject
          })
        },
      }
    },
  }
}

/** A Query whose iteration rejects immediately — models an SDK resume that
 *  targets a session id the SDK no longer knows about. */
function makeFailingQuery(message: string): FakeQuery {
  const base = makeFakeQuery()
  return {
    ...base,
    [Symbol.asyncIterator](): AsyncIterator<unknown> {
      return {
        next: (): Promise<IteratorResult<unknown>> => Promise.reject(new Error(message)),
      }
    },
  }
}

/** SDK result message ending a turn cleanly (drives auto-title + status done). */
function resultSuccess(): unknown {
  return {
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: 'done',
    usage: { input_tokens: 1, output_tokens: 1 },
  }
}

/** SDK result message ending a turn with a failure — carries the raw internal
 *  diagnostic the SDK emits for an aborted turn (#981). */
function resultFailure(): unknown {
  return {
    type: 'result',
    subtype: 'error_during_execution',
    is_error: true,
    errors: ['[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=null'],
    usage: { input_tokens: 1, output_tokens: 1 },
  }
}

/** SDK assistant message carrying one tool_use block (starts a tool call). */
function assistantToolUse(toolUseId: string): unknown {
  return {
    type: 'assistant',
    parent_tool_use_id: null,
    message: {
      content: [{ type: 'tool_use', id: toolUseId, name: 'Bash', input: { command: 'sleep 5' } }],
    },
  }
}

/** SDK synthetic user message carrying the tool_result for a tool call. */
function toolResult(toolUseId: string): unknown {
  return {
    type: 'user',
    parent_tool_use_id: null,
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: toolUseId, content: 'late output' }],
    },
  }
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await new Promise((resolve) => setImmediate(resolve))
  }
}

describe('AgentManager', () => {
  let tempDir: string
  let db: FlowDatabase
  let store: ThreadStore
  let broker: PermissionBroker
  let events: AgentStreamEvent[]

  const credentialsStub = { get: () => null } as unknown as CredentialsManager

  function makeManager(queryFn: QueryFunction): AgentManager {
    const manager = new AgentManager(store, credentialsStub, broker, { queryFn })
    manager.on(AGENT_STREAM_EVENT, (event: AgentStreamEvent) => events.push(event))
    return manager
  }

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'flow-agent-manager-'))
    db = openDatabase(join(tempDir, 'flow.sqlite'))
    store = new ThreadStore(db)
    broker = new PermissionBroker(db)
    events = []
  })

  afterEach(() => {
    db.close()
    rmSync(tempDir, { recursive: true, force: true })
    jest.restoreAllMocks()
  })

  describe('runtime provider resolution (multi_runtime_support)', () => {
    it('starts a Claude SDK session when no provider is configured (default, unchanged)', async () => {
      const queryFn = jest.fn((): Query => makeFakeQuery() as unknown as Query)
      const manager = new AgentManager(store, credentialsStub, broker, { queryFn })
      manager.on(AGENT_STREAM_EVENT, (event: AgentStreamEvent) => events.push(event))
      const thread = store.createThread({ projectRoot: tempDir })
      await manager.sendMessage(thread.id, 'go')
      expect(queryFn).toHaveBeenCalledTimes(1)
      expect(manager.hasActiveSession(thread.id)).toBe(true)
    })

    it('resolveProviderFor returning null is still a Claude thread', async () => {
      const queryFn = jest.fn((): Query => makeFakeQuery() as unknown as Query)
      const manager = new AgentManager(store, credentialsStub, broker, {
        queryFn,
        resolveProviderFor: () => null,
      })
      manager.on(AGENT_STREAM_EVENT, (event: AgentStreamEvent) => events.push(event))
      const thread = store.createThread({ projectRoot: tempDir })
      await manager.sendMessage(thread.id, 'go')
      expect(queryFn).toHaveBeenCalledTimes(1)
    })

    it('a copilot-provider thread starts a CopilotRuntime turn via its factory, not a Claude session', async () => {
      const starts: Array<{ opts: RuntimeStartOptions; callbacks: RuntimeCallbacks }> = []
      const queryFn = jest.fn((): Query => makeFakeQuery() as unknown as Query)
      const manager = new AgentManager(store, credentialsStub, broker, {
        queryFn,
        resolveProviderFor: () => 'copilot',
        copilotRuntimeFactory: () => makeFakeRuntime(starts),
      })
      manager.on(AGENT_STREAM_EVENT, (event: AgentStreamEvent) => events.push(event))
      const thread = store.createThread({ projectRoot: tempDir })
      await manager.sendMessage(thread.id, 'do the copilot thing')
      expect(queryFn).not.toHaveBeenCalled() // no Claude SDK session
      expect(starts).toHaveLength(1)
      expect(starts[0].opts.prompt).toContain('do the copilot thing')
    })

    it('a copilot turn receives the slash command EXPANDED, not the literal /name', async () => {
      // Live: Copilot got "/discovery-plan that plan again", answered "Skill not
      // found", and improvised the discovery from the last version on disk.
      const { mkdirSync, writeFileSync } = require('fs') as typeof import('fs')
      mkdirSync(join(tempDir, '.claude', 'commands'), { recursive: true })
      writeFileSync(join(tempDir, '.claude', 'commands', 'discovery-plan.md'), '---\nd: x\n---\n# Create Discovery Document\n')
      const starts: Array<{ opts: RuntimeStartOptions; callbacks: RuntimeCallbacks }> = []
      const manager = new AgentManager(store, credentialsStub, broker, {
        queryFn: jest.fn((): Query => makeFakeQuery() as unknown as Query),
        resolveProviderFor: () => 'copilot',
        copilotRuntimeFactory: () => makeFakeRuntime(starts),
      })
      const thread = store.createThread({ projectRoot: tempDir })
      await manager.sendMessage(thread.id, '/discovery-plan that plan again')
      expect(starts).toHaveLength(1)
      expect(starts[0].opts.prompt).toContain('# Create Discovery Document')
      expect(starts[0].opts.prompt).toContain('ARGUMENTS: that plan again')
      expect(starts[0].opts.prompt).not.toContain('/discovery-plan')
    })

    it('hands a native-containment runtime the resolved flow/ symlink target as a writable root (#1928)', async () => {
      // The real shape: flow/ is a symlink into the vault, OUTSIDE the project.
      // Copilot/Codex confine writes to cwd + --add-dir roots, so without this
      // the vault realpath is denied and every planflow-ai / flow/ write fails.
      const vaultFlow = realpathSync(mkdtempSync(join(tmpdir(), 'flow-vault-')))
      symlinkSync(vaultFlow, join(tempDir, 'flow'))
      const starts: Array<{ opts: RuntimeStartOptions; callbacks: RuntimeCallbacks }> = []
      const manager = new AgentManager(store, credentialsStub, broker, {
        queryFn: jest.fn((): Query => makeFakeQuery() as unknown as Query),
        resolveProviderFor: () => 'copilot',
        copilotRuntimeFactory: () => makeFakeRuntime(starts),
      })
      manager.on(AGENT_STREAM_EVENT, (event: AgentStreamEvent) => events.push(event))
      const thread = store.createThread({ projectRoot: tempDir })
      try {
        await manager.sendMessage(thread.id, 'write into flow')
        expect(starts).toHaveLength(1)
        expect(starts[0].opts.additionalRoots).toContain(vaultFlow)
      } finally {
        rmSync(vaultFlow, { recursive: true, force: true })
      }
    })

    it('a copilot turn is given the resolved flow/ vault target, so its sandbox can write there', async () => {
      // flow/ is a symlink into the vault, outside the project. Copilot's
      // sandbox resolves it and denied every write until the runtime was told.
      const { mkdtempSync, mkdirSync, symlinkSync, realpathSync, rmSync } = require('fs') as typeof import('fs')
      const vault = mkdtempSync(join(require('os').tmpdir(), 'flow-vault-'))
      const target = join(vault, 'flow')
      mkdirSync(target)
      symlinkSync(target, join(tempDir, 'flow'))
      try {
        const starts: Array<{ opts: RuntimeStartOptions; callbacks: RuntimeCallbacks }> = []
        const manager = new AgentManager(store, credentialsStub, broker, {
          queryFn: jest.fn((): Query => makeFakeQuery() as unknown as Query),
          resolveProviderFor: () => 'copilot',
          copilotRuntimeFactory: () => makeFakeRuntime(starts),
        })
        const thread = store.createThread({ projectRoot: tempDir })
        await manager.sendMessage(thread.id, 'write the brainstorm')
        expect(starts).toHaveLength(1)
        expect(starts[0].opts.additionalRoots).toContain(realpathSync(target))
      } finally {
        rmSync(vault, { recursive: true, force: true })
      }
    })

    it('a codex turn may WRITE the real target of every project’s flow link — primary and attached', async () => {
      const outside = realpathSync(mkdtempSync(join(tmpdir(), 'flow-ws-')))
      const sibling = realpathSync(mkdtempSync(join(tmpdir(), 'flow-sibling-')))
      const { mkdirSync } = require('fs') as typeof import('fs')
      mkdirSync(join(outside, 'primary'))
      mkdirSync(join(outside, 'sibling'))
      symlinkSync(join(outside, 'primary'), join(tempDir, 'flow'))
      symlinkSync(join(outside, 'sibling'), join(sibling, 'flow'))
      // Both targets live in the vault — the only place (with the Workspaces
      // folder) a flow link's target may be granted (flow-link-roots.ts).
      const priorVault = process.env.PLAN_FLOW_VAULT_DIR
      process.env.PLAN_FLOW_VAULT_DIR = outside
      try {
        const starts: Array<{ opts: RuntimeStartOptions; callbacks: RuntimeCallbacks }> = []
        const manager = new AgentManager(store, credentialsStub, broker, {
          queryFn: jest.fn((): Query => makeFakeQuery() as unknown as Query),
          resolveProviderFor: () => 'codex',
          codexRuntimeFactory: () => makeFakeRuntime(starts),
          isAttachableRoot: () => true,
        })
        const thread = store.createThread({ projectRoot: tempDir })
        store.setThreadRoots(thread.id, [sibling])
        await manager.sendMessage(thread.id, 'write knowledge')
        expect(starts).toHaveLength(1)
        expect(starts[0].opts.writableRoots).toEqual([
          sibling,
          join(outside, 'primary'),
          join(outside, 'sibling'),
        ])
      } finally {
        if (priorVault === undefined) delete process.env.PLAN_FLOW_VAULT_DIR
        else process.env.PLAN_FLOW_VAULT_DIR = priorVault
        rmSync(outside, { recursive: true, force: true })
        rmSync(sibling, { recursive: true, force: true })
      }
    })

    it('a codex turn may write only attached roots Flow knows — a registered project or a thread checkout', async () => {
      const known = realpathSync(mkdtempSync(join(tmpdir(), 'flow-known-')))
      const stranger = realpathSync(mkdtempSync(join(tmpdir(), 'flow-stranger-')))
      try {
        const starts: Array<{ opts: RuntimeStartOptions; callbacks: RuntimeCallbacks }> = []
        const asked: string[] = []
        const manager = new AgentManager(store, credentialsStub, broker, {
          queryFn: jest.fn((): Query => makeFakeQuery() as unknown as Query),
          resolveProviderFor: () => 'codex',
          codexRuntimeFactory: () => makeFakeRuntime(starts),
          isAttachableRoot: (root) => {
            asked.push(root)
            return root === known
          },
        })
        const thread = store.createThread({ projectRoot: tempDir })
        store.setThreadRoots(thread.id, [known, stranger])
        await manager.sendMessage(thread.id, 'write both')
        expect(starts).toHaveLength(1)
        // The positive first: the known root IS writable, and both were asked about.
        expect(starts[0].opts.writableRoots).toEqual([known])
        expect(asked.sort()).toEqual([known, stranger].sort())
      } finally {
        rmSync(known, { recursive: true, force: true })
        rmSync(stranger, { recursive: true, force: true })
      }
    })

    it('a codex turn with a plain flow folder and no other project is handed nothing extra to write', async () => {
      const { mkdirSync } = require('fs') as typeof import('fs')
      mkdirSync(join(tempDir, 'flow'))
      const starts: Array<{ opts: RuntimeStartOptions; callbacks: RuntimeCallbacks }> = []
      const manager = new AgentManager(store, credentialsStub, broker, {
        queryFn: jest.fn((): Query => makeFakeQuery() as unknown as Query),
        resolveProviderFor: () => 'codex',
        codexRuntimeFactory: () => makeFakeRuntime(starts),
      })
      const thread = store.createThread({ projectRoot: tempDir })
      await manager.sendMessage(thread.id, 'go')
      expect(starts).toHaveLength(1)
      expect(starts[0].opts.writableRoots).toBeUndefined()
    })

    it('a runtime notice is kept in the thread as a calm system line', async () => {
      const starts: Array<{ opts: RuntimeStartOptions; callbacks: RuntimeCallbacks }> = []
      const manager = new AgentManager(store, credentialsStub, broker, {
        queryFn: jest.fn((): Query => makeFakeQuery() as unknown as Query),
        resolveProviderFor: () => 'codex',
        codexRuntimeFactory: () => makeFakeRuntime(starts),
      })
      const thread = store.createThread({ projectRoot: tempDir })
      await manager.sendMessage(thread.id, 'go')
      starts[0].callbacks.onNotice?.('Notes may not be kept.')
      const system = store.listMessages(thread.id).filter((m) => m.role === 'system')
      expect(system.map((m) => m.content)).toEqual(['Notes may not be kept.'])
      expect(store.getThread(thread.id)?.status).not.toBe('failed')
    })

    it('a codex-provider thread starts a CodexRuntime turn with the prompt, not a Claude session', async () => {
      const starts: Array<{ opts: RuntimeStartOptions; callbacks: RuntimeCallbacks }> = []
      const queryFn = jest.fn((): Query => makeFakeQuery() as unknown as Query)
      const manager = new AgentManager(store, credentialsStub, broker, {
        queryFn,
        resolveProviderFor: () => 'codex',
        codexRuntimeFactory: () => makeFakeRuntime(starts),
      })
      manager.on(AGENT_STREAM_EVENT, (event: AgentStreamEvent) => events.push(event))
      const thread = store.createThread({ projectRoot: tempDir })
      await manager.sendMessage(thread.id, 'do the codex thing')
      expect(queryFn).not.toHaveBeenCalled() // no Claude SDK session
      expect(starts).toHaveLength(1)
      expect(starts[0].opts.cwd).toBe(tempDir)
      expect(starts[0].opts.prompt).toContain('do the codex thing')
    })

    it('persists a codex turn: streamed text becomes a stored assistant message, and onDone idles the thread', async () => {
      const starts: Array<{ opts: RuntimeStartOptions; callbacks: RuntimeCallbacks }> = []
      const manager = new AgentManager(store, credentialsStub, broker, {
        queryFn: jest.fn((): Query => makeFakeQuery() as unknown as Query),
        resolveProviderFor: () => 'codex',
        codexRuntimeFactory: () => makeFakeRuntime(starts),
      })
      manager.on(AGENT_STREAM_EVENT, (event: AgentStreamEvent) => events.push(event))
      const thread = store.createThread({ projectRoot: tempDir })
      await manager.sendMessage(thread.id, 'go')
      const { callbacks: cb } = starts[0]
      cb.onEvent({ kind: 'message-start', threadId: thread.id, messageId: 'm1' })
      cb.onEvent({ kind: 'message-delta', threadId: thread.id, messageId: 'm1', text: 'codex reply' })
      cb.onEvent({ kind: 'text-stop', threadId: thread.id, messageId: 'm1' })
      cb.onDone?.()
      const assistant = store.listMessages(thread.id).filter((m) => m.role === 'assistant')
      expect(assistant.map((m) => m.content)).toContain('codex reply')
      expect(store.getThread(thread.id)?.status).toBe('idle')
    })

    it('a codex follow-up turn resumes the runtime instead of starting a new one', async () => {
      const starts: Array<{ opts: RuntimeStartOptions; callbacks: RuntimeCallbacks }> = []
      const sends: string[] = []
      const manager = new AgentManager(store, credentialsStub, broker, {
        queryFn: jest.fn((): Query => makeFakeQuery() as unknown as Query),
        resolveProviderFor: () => 'codex',
        codexRuntimeFactory: () => makeFakeRuntime(starts, sends),
      })
      manager.on(AGENT_STREAM_EVENT, (event: AgentStreamEvent) => events.push(event))
      const thread = store.createThread({ projectRoot: tempDir })
      await manager.sendMessage(thread.id, 'first')
      starts[0].callbacks.onDone?.() // turn 1 ends → idle
      await manager.sendMessage(thread.id, 'second')
      expect(starts).toHaveLength(1) // NOT a second start
      expect(sends).toContain('second')
    })

    it('a codex session starts with the writing rules ahead of the prompt; the stored message is what was typed', async () => {
      const starts: Array<{ opts: RuntimeStartOptions; callbacks: RuntimeCallbacks }> = []
      const sends: string[] = []
      const manager = new AgentManager(store, credentialsStub, broker, {
        queryFn: jest.fn((): Query => makeFakeQuery() as unknown as Query),
        resolveProviderFor: () => 'codex',
        codexRuntimeFactory: () => makeFakeRuntime(starts, sends),
      })
      manager.on(AGENT_STREAM_EVENT, (event: AgentStreamEvent) => events.push(event))
      const thread = store.createThread({ projectRoot: tempDir })
      await manager.sendMessage(thread.id, 'fix the login bug')
      expect(starts).toHaveLength(1)
      const prompt = starts[0].opts.prompt
      expect(prompt.startsWith(writingRulesBriefing())).toBe(true)
      expect(prompt.endsWith('fix the login bug')).toBe(true)
      const users = store.listMessages(thread.id).filter((m) => m.role === 'user')
      expect(users.map((m) => m.content)).toEqual(['fix the login bug'])
      expect(users[0].content).not.toContain(writingRulesBriefing())

      // A later send reaches the runtime unchanged — the rules ride once.
      starts[0].callbacks.onDone?.()
      await manager.sendMessage(thread.id, 'now the logout bug')
      expect(sends).toEqual(['now the logout bug'])
      const usersAfter = store.listMessages(thread.id).filter((m) => m.role === 'user')
      expect(usersAfter.map((m) => m.content)).toEqual(['fix the login bug', 'now the logout bug'])
    })

    it('throws on an unknown provider string (fail-closed, never silently Claude)', async () => {
      const queryFn = jest.fn((): Query => makeFakeQuery() as unknown as Query)
      const manager = new AgentManager(store, credentialsStub, broker, {
        queryFn,
        resolveProviderFor: () => 'gpt5',
      })
      manager.on(AGENT_STREAM_EVENT, (event: AgentStreamEvent) => events.push(event))
      const thread = store.createThread({ projectRoot: tempDir })
      await expect(manager.sendMessage(thread.id, 'go')).rejects.toThrow(/unknown provider 'gpt5'/)
    })
  })

  it('setModel keeps the effort for an Auto thread — it is what Auto routes on (#147)', async () => {
    const manager = makeManager(jest.fn())
    const thread = store.createThread({ projectRoot: tempDir })

    await manager.setModel(thread.id, { model: 'auto', effort: 'high' })

    // The regression: selecting Auto used to wipe effort to null, so Auto always
    // fell back to the medium tier. Effort must persist for Auto too.
    const persisted = store.getThread(thread.id)
    expect(persisted?.model).toBe('auto')
    expect(persisted?.effort).toBe('high')
  })

  it('emits a model event on a mid-thread setModel so the UI stays in sync (#151)', async () => {
    const fakes: FakeQuery[] = []
    const queryFn = jest.fn((): Query => {
      const fake = makeFakeQuery()
      fakes.push(fake)
      return fake as unknown as Query
    })
    const manager = makeManager(queryFn)
    const thread = store.createThread({ projectRoot: tempDir })
    await manager.sendMessage(thread.id, 'go') // starts the persistent session
    expect(manager.hasActiveSession(thread.id)).toBe(true)

    events.length = 0 // ignore the session-start events
    await manager.setModel(thread.id, { model: 'opus', effort: 'high' })

    // The live model changed → the SDK is told AND a model event is emitted, so
    // the usage line / composer indicator reflect the new model (not the init one).
    expect(fakes[0].setModel).toHaveBeenCalledWith('opus')
    expect(events).toContainEqual({ kind: 'model', threadId: thread.id, model: 'opus' })

    fakes[0].release()
  })

  it('concurrent sendMessage calls share ONE session creation (LOG-1)', async () => {
    const fakes: FakeQuery[] = []
    const queryFn = jest.fn((): Query => {
      const fake = makeFakeQuery()
      fakes.push(fake)
      return fake as unknown as Query
    })
    const manager = makeManager(queryFn)
    const thread = store.createThread({ projectRoot: tempDir })

    // Neither call awaits the other — the check-then-act gap in the old
    // ensureSession would spawn two live SDK sessions here.
    await Promise.all([
      manager.sendMessage(thread.id, 'first'),
      manager.sendMessage(thread.id, 'second'),
    ])

    expect(queryFn).toHaveBeenCalledTimes(1)
    expect(manager.hasActiveSession(thread.id)).toBe(true)

    manager.dispose()
    fakes.forEach((fake) => fake.release())
    await flushMicrotasks()
  })

  it('a stale session exiting never tears down its replacement (LOG-2)', async () => {
    const fakes: FakeQuery[] = []
    const queryFn = jest.fn((): Query => {
      const fake = makeFakeQuery()
      fakes.push(fake)
      return fake as unknown as Query
    })
    const manager = makeManager(queryFn)
    const thread = store.createThread({ projectRoot: tempDir })

    await manager.sendMessage(thread.id, 'first') // session A
    manager.disposeThread(thread.id) // A removed; its loop is still parked
    await manager.sendMessage(thread.id, 'retry') // session B replaces it
    expect(queryFn).toHaveBeenCalledTimes(2)
    expect(manager.hasActiveSession(thread.id)).toBe(true)

    // A's loop exits NOW — without the identity check its finally block
    // would delete B's map entry and force-deny B's parked permissions.
    fakes[0].release()
    await flushMicrotasks()

    expect(manager.hasActiveSession(thread.id)).toBe(true)
    expect(store.getThread(thread.id)?.status).not.toBe('failed')

    manager.dispose()
    fakes[1].release()
    await flushMicrotasks()
  })

  it('session-creation failure fails the thread and emits an error (LOG-5)', async () => {
    const queryFn = jest.fn((): Query => {
      throw new Error('SDK spawn failed')
    })
    const manager = makeManager(queryFn)
    const thread = store.createThread({ projectRoot: tempDir })

    await expect(manager.sendMessage(thread.id, 'hello')).rejects.toThrow('SDK spawn failed')

    expect(store.getThread(thread.id)?.status).toBe('failed')
    expect(events).toEqual(
      expect.arrayContaining([
        { kind: 'status', threadId: thread.id, status: 'failed' },
        {
          kind: 'error',
          threadId: thread.id,
          message: expect.stringContaining('SDK spawn failed'),
        },
      ]),
    )
    expect(manager.hasActiveSession(thread.id)).toBe(false)
    // #1048: the failure survives the ephemeral stream — persisted as a system
    // row so a pane mounted on another thread still finds it on history load.
    const failureRows = store
      .listMessages(thread.id)
      .filter((message) => message.role === 'system')
    expect(failureRows).toHaveLength(1)
    expect(failureRows[0].content).toContain('Agent session error:')
    expect(failureRows[0].content).toContain('SDK spawn failed')

    // The failed creation is not sticky — a retry attempts a fresh session.
    await expect(manager.sendMessage(thread.id, 'again')).rejects.toThrow('SDK spawn failed')
    expect(queryFn).toHaveBeenCalledTimes(2)
  })

  describe("a Workspace's links.jsonl is writable as a FILE (2026-10-08)", () => {
    // `workspace link-knowledge` appends to <workspaces>/<w>/links.jsonl, one
    // level above the project folder flow/ resolves to. The sandbox refused it
    // and the agent switched the sandbox off. The grant is that one file.
    async function spawnIn(flowTarget: string | null): Promise<Options | undefined> {
      if (flowTarget !== null) symlinkSync(flowTarget, join(tempDir, 'flow'))
      let captured: Options | undefined
      const fakes: FakeQuery[] = []
      const manager = new AgentManager(store, credentialsStub, broker, {
        queryFn: (params) => {
          captured = params.options
          const fake = makeFakeQuery()
          fakes.push(fake)
          return fake as unknown as Query
        },
      })
      const thread = store.createThread({ projectRoot: tempDir })
      await manager.sendMessage(thread.id, 'link the two projects')
      fakes.forEach((fake) => fake.release())
      await flushMicrotasks()
      manager.dispose()
      return captured
    }

    it('grants <w>/links.jsonl through sandbox.filesystem.allowWrite, and the project folder as before', async () => {
      const flowFolder = realpathSync(mkdtempSync(join(tmpdir(), 'flow-home-')))
      const { mkdirSync } = require('fs') as typeof import('fs')
      const ws = join(flowFolder, 'workspaces', 'orbit')
      const project = join(ws, 'projects', 'orbit-app')
      mkdirSync(project, { recursive: true })
      const prior = process.env.PLAN_FLOW_HOME
      process.env.PLAN_FLOW_HOME = flowFolder
      try {
        const options = await spawnIn(project)
        expect(options?.additionalDirectories).toEqual([project])
        expect(options?.sandbox).toEqual({ filesystem: { allowWrite: [join(ws, 'links.jsonl')] } })
        // Never the Workspace folder itself — siblings and its .git live there.
        expect(options?.additionalDirectories).not.toContain(ws)
      } finally {
        if (prior === undefined) delete process.env.PLAN_FLOW_HOME
        else process.env.PLAN_FLOW_HOME = prior
        rmSync(flowFolder, { recursive: true, force: true })
      }
    })

    it('passes no sandbox key at all outside a Workspace', async () => {
      const vault = realpathSync(mkdtempSync(join(tmpdir(), 'flow-vault-')))
      try {
        const options = await spawnIn(vault)
        expect(options?.additionalDirectories).toEqual([vault]) // the positive first
        expect(options !== undefined && 'sandbox' in options).toBe(false)
      } finally {
        rmSync(vault, { recursive: true, force: true })
      }
    })
  })

  describe('stale-resume recovery', () => {
    it('restarts fresh (not failed) when the resumed SDK session is gone', async () => {
      const fakes: FakeQuery[] = []
      const queryFn = jest.fn((): Query => {
        // First creation resumes a dead session and rejects; the recovery
        // path must create a second, fresh session.
        const fake =
          fakes.length === 0
            ? makeFailingQuery('No conversation found with session ID: stale-123')
            : makeFakeQuery()
        fakes.push(fake)
        return fake as unknown as Query
      })
      const manager = makeManager(queryFn)
      const thread = store.createThread({ projectRoot: tempDir })
      // The thread carries a persisted SDK session id → the session resumes it.
      store.setSdkSessionId(thread.id, 'stale-123')

      await manager.sendMessage(thread.id, 'reopen me')
      await flushMicrotasks()

      // Recovered: a second session exists, the thread is NOT failed, and the
      // dead session id was cleared so it won't be resumed again.
      expect(queryFn).toHaveBeenCalledTimes(2)
      expect(manager.hasActiveSession(thread.id)).toBe(true)
      expect(store.getThread(thread.id)?.status).not.toBe('failed')
      expect(store.getThread(thread.id)?.sdkSessionId).toBeNull()

      manager.dispose()
      fakes.forEach((fake) => fake.release())
      await flushMicrotasks()
    })
  })

  describe('auto-titling', () => {
    it('names an untitled thread from a clean turn via the title generator', async () => {
      const fakes: FakeQuery[] = []
      const queryFn = jest.fn((): Query => {
        const fake = makeFakeQuery()
        fakes.push(fake)
        return fake as unknown as Query
      })
      const titleGenerator = jest.fn().mockResolvedValue('Fix the login redirect')
      const manager = new AgentManager(store, credentialsStub, broker, {
        queryFn,
        titleGenerator,
      })
      const thread = store.createThread({ projectRoot: tempDir })
      expect(store.getThread(thread.id)?.title).toBe('New thread')

      await manager.sendMessage(thread.id, 'the login page keeps redirecting')
      fakes[0].push(resultSuccess())
      await flushMicrotasks()

      expect(titleGenerator).toHaveBeenCalledTimes(1)
      expect(store.getThread(thread.id)?.title).toBe('Fix the login redirect')

      manager.dispose()
      fakes.forEach((fake) => fake.release())
      await flushMicrotasks()
    })

    it('falls back to the first user message when the generator is empty', async () => {
      const fakes: FakeQuery[] = []
      const queryFn = jest.fn((): Query => {
        const fake = makeFakeQuery()
        fakes.push(fake)
        return fake as unknown as Query
      })
      const manager = new AgentManager(store, credentialsStub, broker, {
        queryFn,
        titleGenerator: jest.fn().mockResolvedValue(''),
      })
      const thread = store.createThread({ projectRoot: tempDir })

      await manager.sendMessage(thread.id, 'Add dark mode to the settings screen')
      fakes[0].push(resultSuccess())
      await flushMicrotasks()

      expect(store.getThread(thread.id)?.title).toBe('Add dark mode to the settings screen')

      manager.dispose()
      fakes.forEach((fake) => fake.release())
      await flushMicrotasks()
    })

    it('does not overwrite a title the user already set', async () => {
      const fakes: FakeQuery[] = []
      const queryFn = jest.fn((): Query => {
        const fake = makeFakeQuery()
        fakes.push(fake)
        return fake as unknown as Query
      })
      const titleGenerator = jest.fn().mockResolvedValue('Generated')
      const manager = new AgentManager(store, credentialsStub, broker, {
        queryFn,
        titleGenerator,
      })
      const thread = store.createThread({ projectRoot: tempDir, title: 'My own title' })

      await manager.sendMessage(thread.id, 'hello')
      fakes[0].push(resultSuccess())
      await flushMicrotasks()

      expect(titleGenerator).not.toHaveBeenCalled()
      expect(store.getThread(thread.id)?.title).toBe('My own title')

      manager.dispose()
      fakes.forEach((fake) => fake.release())
      await flushMicrotasks()
    })
  })

  describe('per-project account injection', () => {
    const loggedInProbe: AuthProbe = async () => ({ loggedIn: true })
    const loggedOutProbe: AuthProbe = async () => ({ loggedIn: false })

    it('account-bound project injects CLAUDE_CONFIG_DIR and strips ANTHROPIC_API_KEY', async () => {
      const prevKey = process.env['ANTHROPIC_API_KEY']
      process.env['ANTHROPIC_API_KEY'] = 'sk-should-be-stripped'
      try {
        const fakes: FakeQuery[] = []
        let capturedEnv: Record<string, string | undefined> | undefined
        const queryFn = jest.fn((params: { options?: Options }): Query => {
          capturedEnv = params.options?.env
          const fake = makeFakeQuery()
          fakes.push(fake)
          return fake as unknown as Query
        })
        const accounts = new AccountStore(db)
        const acct = accounts.createAccount({ label: 'Acme', configDirPath: '/dir/acme' })
        accounts.setDefaultAccountId(acct.id)
        const resolver = new AccountResolver(accounts, loggedInProbe)
        const manager = new AgentManager(store, credentialsStub, broker, {
          queryFn,
          accountResolver: resolver,
        })
        const thread = store.createThread({ projectRoot: tempDir })

        await manager.sendMessage(thread.id, 'hi')
        await flushMicrotasks()

        expect(capturedEnv?.['CLAUDE_CONFIG_DIR']).toBe('/dir/acme')
        expect(capturedEnv?.['ANTHROPIC_API_KEY']).toBeUndefined()

        manager.dispose()
        fakes.forEach((fake) => fake.release())
        await flushMicrotasks()
      } finally {
        if (prevKey === undefined) delete process.env['ANTHROPIC_API_KEY']
        else process.env['ANTHROPIC_API_KEY'] = prevKey
      }
    })

    it('generateBrief (brief + commit-message) authenticates AS the bound account, not legacy auth (#237)', async () => {
      const prevKey = process.env['ANTHROPIC_API_KEY']
      process.env['ANTHROPIC_API_KEY'] = 'sk-should-be-stripped'
      try {
        const fakes: FakeQuery[] = []
        let capturedEnv: Record<string, string | undefined> | undefined
        const queryFn = jest.fn((params: { options?: Options }): Query => {
          capturedEnv = params.options?.env
          const fake = makeFakeQuery()
          fakes.push(fake)
          return fake as unknown as Query
        })
        const accounts = new AccountStore(db)
        const acct = accounts.createAccount({ label: 'Acme', configDirPath: '/dir/acme' })
        accounts.setDefaultAccountId(acct.id)
        const resolver = new AccountResolver(accounts, loggedInProbe)
        const manager = new AgentManager(store, credentialsStub, broker, {
          queryFn,
          accountResolver: resolver,
        })

        // One-shot: kick it off, let queryFn capture the env, then release.
        const briefPromise = manager.generateBrief({ projectRoot: tempDir, prompt: 'summarize' })
        await flushMicrotasks()
        fakes.forEach((fake) => fake.release())
        await briefPromise

        expect(capturedEnv?.['CLAUDE_CONFIG_DIR']).toBe('/dir/acme')
        expect(capturedEnv?.['ANTHROPIC_API_KEY']).toBeUndefined()
        manager.dispose()
      } finally {
        if (prevKey === undefined) delete process.env['ANTHROPIC_API_KEY']
        else process.env['ANTHROPIC_API_KEY'] = prevKey
      }
    })

    it('generateBrief fails closed on an unavailable account — never runs under wrong auth (#237)', async () => {
      const queryFn = jest.fn((): Query => makeFakeQuery() as unknown as Query)
      const accounts = new AccountStore(db)
      const acct = accounts.createAccount({ label: 'Acme', configDirPath: '/dir/acme' })
      accounts.setDefaultAccountId(acct.id)
      const resolver = new AccountResolver(accounts, loggedOutProbe)
      const manager = new AgentManager(store, credentialsStub, broker, {
        queryFn,
        accountResolver: resolver,
      })

      await expect(
        manager.generateBrief({ projectRoot: tempDir, prompt: 'x' }),
      ).rejects.toThrow()
      expect(queryFn).not.toHaveBeenCalled() // model never ran under the wrong account
      manager.dispose()
    })

    it('an unavailable account fails the thread closed and never starts a session', async () => {
      const queryFn = jest.fn((): Query => makeFakeQuery() as unknown as Query)
      const accounts = new AccountStore(db)
      const acct = accounts.createAccount({ label: 'Acme', configDirPath: '/dir/acme' })
      accounts.setDefaultAccountId(acct.id)
      const resolver = new AccountResolver(accounts, loggedOutProbe)
      const manager = new AgentManager(store, credentialsStub, broker, {
        queryFn,
        accountResolver: resolver,
      })
      const thread = store.createThread({ projectRoot: tempDir })

      await expect(manager.sendMessage(thread.id, 'hi')).rejects.toThrow(/unavailable/i)
      expect(queryFn).not.toHaveBeenCalled()
      expect(store.getThread(thread.id)?.status).toBe('failed')

      manager.dispose()
    })
  })

  describe('interrupt semantics for in-flight tool calls (LOG-6)', () => {
    let fakes: FakeQuery[]
    let manager: AgentManager

    beforeEach(() => {
      fakes = []
      const queryFn = jest.fn((): Query => {
        const fake = makeFakeQuery()
        fakes.push(fake)
        return fake as unknown as Query
      })
      manager = makeManager(queryFn)
    })

    afterEach(async () => {
      manager.dispose()
      fakes.forEach((fake) => fake.release())
      await flushMicrotasks()
    })

    it("interrupt resolves running tool calls to 'interrupted' (#1217), never stranding them", async () => {
      const thread = store.createThread({ projectRoot: tempDir })
      await manager.sendMessage(thread.id, 'run something')
      fakes[0].push(assistantToolUse('tu-1'))
      await flushMicrotasks()

      let calls = store.listToolCalls(thread.id)
      expect(calls).toHaveLength(1)
      expect(calls[0].status).toBe('running')

      await manager.interrupt(thread.id)

      calls = store.listToolCalls(thread.id)
      // #1217: a stop the user ASKED for is `interrupted`, not `error` — LOG-6's
      // point is that the call is resolved rather than stranded, which holds.
      expect(calls[0].status).toBe('interrupted')
      expect(calls[0].outputJson).toContain('Stopped')
      expect(calls[0].completedAt).not.toBeNull()

      const toolEnds = events.filter((event) => event.kind === 'tool-end')
      expect(toolEnds).toHaveLength(1)
      expect(toolEnds[0]).toMatchObject({
        threadId: thread.id,
        toolCall: { id: calls[0].id, status: 'interrupted' },
      })
    })

    it('interrupt cancels a parked AskUserQuestion so the card is removed (#1909)', async () => {
      const thread = store.createThread({ projectRoot: tempDir })
      store.updateThread(thread.id, { status: 'working' })
      await manager.sendMessage(thread.id, 'run something') // live session for interrupt()

      // Park a real AskUserQuestion through canUseTool (the SDK-mode channel).
      const parked: UserQuestionRequest[] = []
      manager.on(DIALOG_REQUEST_EVENT, (r: UserQuestionRequest) => parked.push(r))
      const cancels: DialogCancel[] = []
      manager.on(DIALOG_CANCEL_EVENT, (c: DialogCancel) => cancels.push(c))
      const canUseTool = broker.createCanUseTool(thread.id, [tempDir])
      void canUseTool(
        'AskUserQuestion',
        {
          questions: [
            {
              question: 'Ship it?',
              header: 'Ship',
              multiSelect: false,
              options: [{ label: 'Yes', description: '' }],
            },
          ],
        },
        {
          signal: new AbortController().signal,
          toolUseID: 'tu-ask',
        } as Parameters<typeof canUseTool>[2],
      )
      await flushMicrotasks()
      expect(parked).toHaveLength(1)
      expect(store.getThread(thread.id)?.status).toBe('needs-decision')

      // The user STOPS the stream while the question is parked.
      await manager.interrupt(thread.id)

      // The renderer is told to drop the card (DIALOG_CANCEL_EVENT with the id),
      // the parked dialog is gone, and the thread is no longer needs-decision —
      // rather than the question component sitting on screen forever.
      expect(cancels).toEqual([{ threadId: thread.id, requestIds: [parked[0].requestId] }])
      // The parked dialog is gone: a late answer finds nothing to resolve.
      expect(manager.respondDialog(parked[0].requestId, [{ header: 'Ship', selected: ['Yes'] }])).toBe(
        false,
      )
      expect(store.getThread(thread.id)?.status).toBe('idle')
    })

    it('a late genuine tool_result for an interrupted call neither crashes nor double-completes', async () => {
      const thread = store.createThread({ projectRoot: tempDir })
      await manager.sendMessage(thread.id, 'run something')
      fakes[0].push(assistantToolUse('tu-1'))
      await flushMicrotasks()
      await manager.interrupt(thread.id)

      // The tool_result arrives AFTER the interrupt already resolved the
      // record — StreamBridge's toolCallIds entry is gone and the status
      // guard rejects re-completion.
      fakes[0].push(toolResult('tu-1'))
      await flushMicrotasks()

      const calls = store.listToolCalls(thread.id)
      expect(calls).toHaveLength(1)
      expect(calls[0].status).toBe('interrupted')
      expect(calls[0].outputJson).toContain('Stopped')
      expect(events.filter((event) => event.kind === 'tool-end')).toHaveLength(1)
      expect(events.filter((event) => event.kind === 'error')).toEqual([])
    })

    it('session teardown (stream end) resolves running tool calls instead of stranding them', async () => {
      const thread = store.createThread({ projectRoot: tempDir })
      await manager.sendMessage(thread.id, 'run something')
      fakes[0].push(assistantToolUse('tu-2'))
      await flushMicrotasks()
      expect(store.listToolCalls(thread.id)[0].status).toBe('running')

      // The SDK stream ends without ever delivering a tool_result.
      fakes[0].release()
      await flushMicrotasks()

      const calls = store.listToolCalls(thread.id)
      expect(calls[0].status).toBe('interrupted')
      expect(calls[0].outputJson).toContain('Stopped')
      expect(events.filter((event) => event.kind === 'tool-end')).toHaveLength(1)
    })

    it('disposeThread resolves running tool calls', async () => {
      const thread = store.createThread({ projectRoot: tempDir })
      await manager.sendMessage(thread.id, 'run something')
      fakes[0].push(assistantToolUse('tu-3'))
      await flushMicrotasks()
      expect(store.listToolCalls(thread.id)[0].status).toBe('running')

      manager.disposeThread(thread.id)
      await flushMicrotasks()

      const calls = store.listToolCalls(thread.id)
      expect(calls[0].status).toBe('interrupted')
      expect(calls[0].outputJson).toContain('Stopped')
    })
  })

  describe('interrupt classified as a deliberate stop, not a crash (#981)', () => {
    let fakes: FakeQuery[]
    let manager: AgentManager

    beforeEach(() => {
      fakes = []
      const queryFn = jest.fn((): Query => {
        const fake = makeFakeQuery()
        fakes.push(fake)
        return fake as unknown as Query
      })
      manager = makeManager(queryFn)
    })

    afterEach(async () => {
      manager.dispose()
      fakes.forEach((fake) => fake.release())
      await flushMicrotasks()
    })

    it("the aborted turn's non-success result settles idle with a calm notice — no failed status, no error card", async () => {
      const thread = store.createThread({ projectRoot: tempDir })
      await manager.sendMessage(thread.id, 'count slowly to 200')
      await manager.interrupt(thread.id)

      // The SDK delivers the interrupted turn's result AFTER the interrupt.
      fakes[0].push(resultFailure())
      await flushMicrotasks()

      expect(store.getThread(thread.id)?.status).toBe('idle')
      expect(events.filter((event) => event.kind === 'error')).toEqual([])
      expect(
        events.filter((event) => event.kind === 'status' && event.status === 'failed'),
      ).toEqual([])
      // The raw SDK diagnostic never reaches the UI for a user-initiated stop.
      expect(JSON.stringify(events)).not.toContain('ede_diagnostic')
      // A calm persisted one-liner is the transcript's only trace.
      const systemMessages = store
        .listMessages(thread.id)
        .filter((message) => message.role === 'system')
      expect(systemMessages).toHaveLength(1)
      expect(systemMessages[0].content).toBe('Interrupted by you')
      // The turn still closes for the renderer (reconcile fires).
      expect(events.filter((event) => event.kind === 'done')).toHaveLength(1)
    })

    it('a genuine failure without an interrupt keeps the visible error card (#846/#878)', async () => {
      const thread = store.createThread({ projectRoot: tempDir })
      await manager.sendMessage(thread.id, 'do work')

      fakes[0].push(resultFailure())
      await flushMicrotasks()

      expect(store.getThread(thread.id)?.status).toBe('failed')
      const errors = events.filter((event) => event.kind === 'error')
      expect(errors).toHaveLength(1)
      expect(errors[0]).toMatchObject({
        threadId: thread.id,
        message: expect.stringContaining('Agent turn failed'),
      })
      // #1048: the failure is also persisted (same text as the emitted event),
      // so a thread failing in the BACKGROUND still explains itself when its
      // history is next loaded — and after a restart.
      const failureRows = store
        .listMessages(thread.id)
        .filter((message) => message.role === 'system')
      expect(failureRows).toHaveLength(1)
      expect(failureRows[0].content).toBe(
        (errors[0] as { message: string }).message,
      )
      expect(failureRows[0].content).toContain('Agent turn failed:')
    })

    it('an interrupt racing a clean finish does not hijack the success', async () => {
      const thread = store.createThread({ projectRoot: tempDir })
      await manager.sendMessage(thread.id, 'quick task')
      await manager.interrupt(thread.id)

      // The turn actually completed — the result is a clean success.
      fakes[0].push(resultSuccess())
      await flushMicrotasks()

      expect(store.getThread(thread.id)?.status).toBe('done')
      expect(events.filter((event) => event.kind === 'error')).toEqual([])
      expect(
        store.listMessages(thread.id).filter((message) => message.role === 'system'),
      ).toEqual([])
    })

    it("a stale interrupt mark does not swallow the NEXT turn's genuine failure", async () => {
      const thread = store.createThread({ projectRoot: tempDir })
      await manager.sendMessage(thread.id, 'first')
      // Interrupt whose settling result never arrives.
      await manager.interrupt(thread.id)

      // A new turn starts — the stale mark must be cleared.
      await manager.sendMessage(thread.id, 'second')
      fakes[0].push(resultFailure())
      await flushMicrotasks()

      expect(store.getThread(thread.id)?.status).toBe('failed')
      expect(events.filter((event) => event.kind === 'error')).toHaveLength(1)
    })

    it('an interrupt that surfaces as a thrown abort (no result message) settles idle, not failed', async () => {
      const thread = store.createThread({ projectRoot: tempDir })
      await manager.sendMessage(thread.id, 'long task')
      await manager.interrupt(thread.id)

      // The SDK loop throws instead of delivering a result message.
      fakes[0].fail(new Error('The operation was aborted'))
      await flushMicrotasks()

      expect(store.getThread(thread.id)?.status).toBe('idle')
      expect(events.filter((event) => event.kind === 'error')).toEqual([])
      expect(
        events.filter((event) => event.kind === 'status' && event.status === 'failed'),
      ).toEqual([])
    })
  })

  describe('parked permission asks (#949)', () => {
    /** Park a real ask through the broker's canUseTool path and return its
     *  renderer-facing request (the manager re-emits it). */
    async function parkAsk(
      manager: AgentManager,
      threadId: string,
    ): Promise<{ requestId: string; threadId: string }> {
      const parked: Array<{ requestId: string; threadId: string }> = []
      manager.on(PERMISSION_REQUEST_EVENT, (request: { requestId: string; threadId: string }) =>
        parked.push(request),
      )
      const canUseTool = broker.createCanUseTool(threadId, [tempDir])
      void canUseTool('Bash', { command: 'rm -rf .cache' }, {
        signal: new AbortController().signal,
        toolUseID: 'tu-949',
      } as Parameters<typeof canUseTool>[2])
      await new Promise((resolve) => setImmediate(resolve))
      expect(parked).toHaveLength(1)
      return parked[0]
    }

    it("a parked ask flips the thread to 'needs-decision' so it is discoverable from the sidebar", async () => {
      const manager = makeManager(jest.fn())
      const thread = store.createThread({ projectRoot: tempDir })
      store.updateThread(thread.id, { status: 'working' })

      const request = await parkAsk(manager, thread.id)

      expect(request.threadId).toBe(thread.id)
      expect(store.getThread(thread.id)?.status).toBe('needs-decision')
      expect(
        events.filter(
          (event) => event.kind === 'status' && event.status === 'needs-decision',
        ),
      ).toHaveLength(1)
    })

    it("answering the last parked ask hands the thread back to 'working'", async () => {
      const manager = makeManager(jest.fn())
      const thread = store.createThread({ projectRoot: tempDir })
      store.updateThread(thread.id, { status: 'working' })
      const request = await parkAsk(manager, thread.id)

      manager.respondPermission(request.requestId, 'allow-once')

      expect(store.getThread(thread.id)?.status).toBe('working')
      expect(manager.pendingPermissions(thread.id)).toEqual([])
    })

    it('a verdict never resurrects a thread that interrupt/teardown already settled', async () => {
      const manager = makeManager(jest.fn())
      const thread = store.createThread({ projectRoot: tempDir })
      store.updateThread(thread.id, { status: 'working' })
      const request = await parkAsk(manager, thread.id)

      // Interrupt/teardown settled the thread while the ask was still parked.
      store.updateThread(thread.id, { status: 'idle' })
      manager.respondPermission(request.requestId, 'deny')

      expect(store.getThread(thread.id)?.status).toBe('idle')
    })

    it('pendingPermissions lists only the given thread — the renderer re-sync surface', async () => {
      const manager = makeManager(jest.fn())
      const threadA = store.createThread({ projectRoot: tempDir })
      const threadB = store.createThread({ projectRoot: tempDir })
      const requestA = await parkAsk(manager, threadA.id)
      const requestB = await parkAsk(manager, threadB.id)

      expect(manager.pendingPermissions(threadA.id).map((r) => r.requestId)).toEqual([
        requestA.requestId,
      ])
      expect(manager.pendingPermissions(threadB.id).map((r) => r.requestId)).toEqual([
        requestB.requestId,
      ])
      // Answering A's ask leaves B's parked — and B's thread stays needs-decision.
      manager.respondPermission(requestA.requestId, 'deny')
      expect(manager.pendingPermissions(threadA.id)).toEqual([])
      expect(manager.pendingPermissions(threadB.id)).toHaveLength(1)
      expect(store.getThread(threadB.id)?.status).toBe('needs-decision')
    })
  })

  describe('AskUserQuestion flips needs-decision (thread-agent-status)', () => {
    /** Fire a real AskUserQuestion through canUseTool (the SDK-mode channel) and
     *  return the parked request the manager re-emits. It does NOT resolve until
     *  respondDialog answers it — so the caller fires it, then waits for the
     *  DIALOG_REQUEST_EVENT. */
    async function parkQuestion(
      manager: AgentManager,
      threadId: string,
    ): Promise<UserQuestionRequest> {
      const parked: UserQuestionRequest[] = []
      manager.on(DIALOG_REQUEST_EVENT, (request: UserQuestionRequest) => parked.push(request))
      const canUseTool = broker.createCanUseTool(threadId, [tempDir])
      void canUseTool(
        'AskUserQuestion',
        {
          questions: [
            {
              question: 'Ship it?',
              header: 'Ship',
              multiSelect: false,
              options: [{ label: 'Yes', description: '' }],
            },
          ],
        },
        {
          signal: new AbortController().signal,
          toolUseID: 'tu-ask',
        } as Parameters<typeof canUseTool>[2],
      )
      await new Promise((resolve) => setImmediate(resolve))
      expect(parked).toHaveLength(1)
      return parked[0]
    }

    it("an agent asking a question flips the thread to 'needs-decision'", async () => {
      const manager = makeManager(jest.fn())
      const thread = store.createThread({ projectRoot: tempDir })
      store.updateThread(thread.id, { status: 'working' })

      const request = await parkQuestion(manager, thread.id)

      expect(request.threadId).toBe(thread.id)
      expect(store.getThread(thread.id)?.status).toBe('needs-decision')
      expect(
        events.filter((e) => e.kind === 'status' && e.status === 'needs-decision'),
      ).toHaveLength(1)
    })

    it("answering the question hands the thread back to 'working'", async () => {
      const manager = makeManager(jest.fn())
      const thread = store.createThread({ projectRoot: tempDir })
      store.updateThread(thread.id, { status: 'working' })
      const request = await parkQuestion(manager, thread.id)

      expect(manager.respondDialog(request.requestId, [{ header: 'Ship', selected: ['Yes'] }])).toBe(
        true,
      )

      expect(store.getThread(thread.id)?.status).toBe('working')
    })

    it('with BOTH a permission and a question parked, answering one does NOT restore', async () => {
      const manager = makeManager(jest.fn())
      const thread = store.createThread({ projectRoot: tempDir })
      store.updateThread(thread.id, { status: 'working' })

      // A permission ask…
      const permParked: Array<{ requestId: string }> = []
      manager.on(PERMISSION_REQUEST_EVENT, (r: { requestId: string }) => permParked.push(r))
      const canUseTool = broker.createCanUseTool(thread.id, [tempDir])
      void canUseTool('Bash', { command: 'rm -rf .cache' }, {
        signal: new AbortController().signal,
        toolUseID: 'tu-perm',
      } as Parameters<typeof canUseTool>[2])
      await new Promise((resolve) => setImmediate(resolve))
      // …and a question, both on the same thread.
      const question = await parkQuestion(manager, thread.id)
      expect(store.getThread(thread.id)?.status).toBe('needs-decision')

      // Answer the question — the permission is still parked, so it must hold.
      manager.respondDialog(question.requestId, [{ header: 'Ship', selected: ['Yes'] }])
      expect(store.getThread(thread.id)?.status).toBe('needs-decision')

      // Answer the permission too — now nothing remains, so it restores.
      manager.respondPermission(permParked[0].requestId, 'allow-once')
      expect(store.getThread(thread.id)?.status).toBe('working')
    })
  })

  // THE 7h13m HANG. `canUseTool` parks with NO timeout — deliberately; a
  // question answers whenever the person gets to it. But the only copy of that
  // question was the RENDERER's in-memory queue, so a reload / window recreate
  // left the agent parked with nothing on screen to answer. Measured on a real
  // thread: `needs-decision` for 7 hours 13 minutes. `parkedQuestions` is what
  // a rebuilt renderer reads back over `threads:pendingDialogs`.
  describe('parkedQuestions — what a rebuilt renderer reads back', () => {
    /** Park a REAL AskUserQuestion through canUseTool (the SDK-mode channel)
     *  and return the request the manager re-emitted. Each call needs its own
     *  `toolUseID` — the permission broker keys a parked ask by it. */
    async function parkQuestion(
      manager: AgentManager,
      threadId: string,
      toolUseID: string,
      question = 'Ship it?',
    ): Promise<UserQuestionRequest> {
      const parked: UserQuestionRequest[] = []
      const listener = (request: UserQuestionRequest): void => {
        parked.push(request)
      }
      manager.on(DIALOG_REQUEST_EVENT, listener)
      const canUseTool = broker.createCanUseTool(threadId, [tempDir])
      void canUseTool(
        'AskUserQuestion',
        {
          questions: [
            {
              question,
              header: 'Ship',
              multiSelect: false,
              options: [{ label: 'Yes', description: '' }],
            },
          ],
        },
        {
          signal: new AbortController().signal,
          toolUseID,
        } as Parameters<typeof canUseTool>[2],
      )
      await new Promise((resolve) => setImmediate(resolve))
      manager.off(DIALOG_REQUEST_EVENT, listener)
      expect(parked).toHaveLength(1)
      return parked[0]
    }

    it('lists a parked question — the same payload the renderer was sent', async () => {
      const manager = makeManager(jest.fn())
      const thread = store.createThread({ projectRoot: tempDir })
      store.updateThread(thread.id, { status: 'working' })
      const emitted = await parkQuestion(manager, thread.id, 'tu-park-1')

      // The thread really is waiting on a person…
      expect(store.getThread(thread.id)?.status).toBe('needs-decision')
      // …and main can still name the question, so the card is rebuildable.
      const listed = manager.parkedQuestions(thread.id)
      expect(listed).toHaveLength(1)
      expect(listed[0]?.requestId).toBe(emitted.requestId)
      expect(listed[0]?.threadId).toBe(thread.id)
      expect(listed[0]?.questions).toEqual(emitted.questions)
      expect(listed[0]?.questions[0]?.question).toBe('Ship it?')
    })

    it('stops listing it once the renderer answers', async () => {
      const manager = makeManager(jest.fn())
      const thread = store.createThread({ projectRoot: tempDir })
      store.updateThread(thread.id, { status: 'working' })
      const request = await parkQuestion(manager, thread.id, 'tu-park-2')
      // Positive first (allowed-pattern #28): it WAS listed, and the answer
      // reached a real parked dialog…
      expect(manager.parkedQuestions(thread.id)).toHaveLength(1)
      expect(manager.respondDialog(request.requestId, [{ header: 'Ship', selected: ['Yes'] }])).toBe(
        true,
      )
      // …so the empty list below is the answer, not an empty broker.
      expect(manager.parkedQuestions(thread.id)).toEqual([])
      expect(store.getThread(thread.id)?.status).toBe('working')
    })

    it('answers per thread — one thread’s re-sync never shows another’s question', async () => {
      const manager = makeManager(jest.fn())
      const threadA = store.createThread({ projectRoot: tempDir })
      const threadB = store.createThread({ projectRoot: tempDir })
      const a = await parkQuestion(manager, threadA.id, 'tu-park-a', 'Ship A?')
      const b = await parkQuestion(manager, threadB.id, 'tu-park-b', 'Ship B?')

      expect(manager.parkedQuestions(threadA.id).map((r) => r.requestId)).toEqual([a.requestId])
      expect(manager.parkedQuestions(threadB.id).map((r) => r.requestId)).toEqual([b.requestId])

      // Answering A leaves B parked — B's own reload still finds its card.
      manager.respondDialog(a.requestId, [{ header: 'Ship', selected: ['Yes'] }])
      expect(manager.parkedQuestions(threadA.id)).toEqual([])
      expect(manager.parkedQuestions(threadB.id).map((r) => r.requestId)).toEqual([b.requestId])
      expect(store.getThread(threadB.id)?.status).toBe('needs-decision')
    })

    it('lists nothing for a thread with no question parked', () => {
      const manager = makeManager(jest.fn())
      const thread = store.createThread({ projectRoot: tempDir })
      expect(manager.parkedQuestions(thread.id)).toEqual([])
    })
  })

  describe('auto-attach on agent writes (multi-project threads, phase 6)', () => {
    let primaryDir: string
    let siblingDir: string
    let outsideDir: string
    let fakes: FakeQuery[]
    let captured: Options | undefined

    /** The system-note rows the transcript persisted for a thread. */
    function systemNotes(threadId: string): string[] {
      return store
        .listMessages(threadId)
        .filter((message) => message.role === 'system')
        .map((message) => message.content)
    }

    type PreToolUseHook = NonNullable<NonNullable<Options['hooks']>['PreToolUse']>[number]

    /** The captured session's PreToolUse hook whose matcher covers `toolName`. */
    function hookFor(toolName: string): PreToolUseHook['hooks'][number] {
      const entries = captured?.hooks?.PreToolUse ?? []
      const entry = entries.find((candidate) =>
        (candidate.matcher ?? '').split('|').includes(toolName),
      )
      if (!entry) throw new Error(`no PreToolUse hook matches ${toolName}`)
      return entry.hooks[0]
    }

    /** Drive one containment hook exactly as the SDK would. */
    async function invokeHook(toolName: string, toolInput: unknown): Promise<unknown> {
      const hook = hookFor(toolName)
      return hook(
        {
          hook_event_name: 'PreToolUse' as const,
          tool_name: toolName,
          tool_input: toolInput,
          tool_use_id: 'tu-attach',
          session_id: 's-attach',
          transcript_path: '',
          cwd: primaryDir,
        },
        'tu-attach',
        { signal: new AbortController().signal },
      )
    }

    function expectDenied(outcome: unknown): void {
      expect(outcome).toMatchObject({
        hookSpecificOutput: { permissionDecision: 'deny' },
      })
    }

    async function makeAttachedManager(): Promise<{
      manager: AgentManager
      threadId: string
    }> {
      const queryFn: QueryFunction = (params) => {
        captured = params.options
        const fake = makeFakeQuery()
        fakes.push(fake)
        return fake as unknown as Query
      }
      const manager = new AgentManager(store, credentialsStub, broker, {
        queryFn,
        // primary + sibling are KNOWN project roots; outsideDir is not.
        knownProjectRoots: () => [primaryDir, siblingDir],
      })
      manager.on(AGENT_STREAM_EVENT, (event: AgentStreamEvent) => events.push(event))
      const thread = store.createThread({ projectRoot: primaryDir })
      await manager.sendMessage(thread.id, 'go') // spins the session, captures hooks
      return { manager, threadId: thread.id }
    }

    beforeEach(() => {
      // Deliberately NOT under tempDir: tmpdir() is a temp SINK for bash
      // containment (writes there are always allowed), which would bypass the
      // attach path entirely. Containment is lexical — no disk access — so
      // fictional absolute roots exercise the real decision.
      primaryDir = '/attach-e2e/primary'
      siblingDir = '/attach-e2e/sibling'
      outsideDir = '/attach-e2e/outside'
      fakes = []
      captured = undefined
    })

    afterEach(async () => {
      fakes.forEach((fake) => fake.release())
      await flushMicrotasks()
    })

    it('a write into a known-but-unattached root attaches it, allows, and persists ONE notice', async () => {
      const { manager, threadId } = await makeAttachedManager()

      const outcome = await invokeHook('Write', {
        file_path: join(siblingDir, 'src/index.ts'),
        content: 'x',
      })

      // Attach-then-allow: no deny decision, and the root is in thread_roots
      // (the one write seam — the scope layer re-derives from this).
      expect(outcome).toEqual({ continue: true })
      expect(store.getThreadRoots(threadId)).toEqual([siblingDir])
      expect(systemNotes(threadId)).toEqual([
        'Attached sibling to this thread — the agent is working there',
      ])

      // Second write in the same turn: allowed (the root is attached), and the
      // notice is NOT duplicated (once per root per turn).
      const again = await invokeHook('Edit', { file_path: join(siblingDir, 'other.ts') })
      expect(again).toEqual({ continue: true })
      expect(systemNotes(threadId)).toHaveLength(1)

      manager.dispose()
    })

    it('a write outside every known root stays blocked exactly as today', async () => {
      const { manager, threadId } = await makeAttachedManager()

      const outcome = await invokeHook('Write', {
        file_path: join(outsideDir, 'evil.ts'),
        content: 'x',
      })

      expectDenied(outcome)
      expect(store.getThreadRoots(threadId)).toEqual([])
      expect(systemNotes(threadId)).toEqual([])

      manager.dispose()
    })

    it('a Bash write into a known root attaches it; one also escaping known roots stays blocked', async () => {
      const { manager, threadId } = await makeAttachedManager()

      // Attaches: the only escaping write target is inside the known sibling.
      const attached = await invokeHook('Bash', {
        command: `echo hi > ${join(siblingDir, 'out.txt')}`,
      })
      expect(attached).toEqual({ continue: true })
      expect(store.getThreadRoots(threadId)).toEqual([siblingDir])

      // Blocked, nothing further attached: a target outside every known root.
      const blocked = await invokeHook('Bash', {
        command: `cp x.txt ${join(outsideDir, 'y.txt')}`,
      })
      expectDenied(blocked)
      expect(store.getThreadRoots(threadId)).toEqual([siblingDir])

      manager.dispose()
    })

    it('the containment hook re-reads thread roots — an externally attached root is honored mid-session', async () => {
      const { manager, threadId } = await makeAttachedManager()

      // Attached AFTER session start (e.g. by the user), not via auto-attach.
      store.addThreadRoot(threadId, siblingDir)

      const write = await invokeHook('Write', { file_path: join(siblingDir, 'x.ts') })
      const read = await invokeHook('Read', { file_path: join(siblingDir, 'x.ts') })
      expect(write).toEqual({ continue: true })
      expect(read).toEqual({ continue: true })
      // No auto-attach fired — no notice.
      expect(systemNotes(threadId)).toEqual([])

      manager.dispose()
    })

    it('reads never auto-attach — a read into a known-but-unattached root stays blocked', async () => {
      const { manager, threadId } = await makeAttachedManager()

      const outcome = await invokeHook('Read', { file_path: join(siblingDir, 'secret.ts') })

      expectDenied(outcome)
      expect(store.getThreadRoots(threadId)).toEqual([])

      manager.dispose()
    })

    it('a new turn resets the notice debounce for a root that failed to persist', async () => {
      const { manager, threadId } = await makeAttachedManager()
      await invokeHook('Write', { file_path: join(siblingDir, 'a.ts') })
      expect(systemNotes(threadId)).toHaveLength(1)

      // Next turn re-arms the tracker; the root is already attached, so the
      // write is allowed by containment with no second attach or notice.
      await manager.sendMessage(threadId, 'next turn')
      const outcome = await invokeHook('Write', { file_path: join(siblingDir, 'b.ts') })
      expect(outcome).toEqual({ continue: true })
      expect(systemNotes(threadId)).toHaveLength(1)

      manager.dispose()
    })
  })

  describe('brain-first first-turn seed (brain-first-retrieval phase 3)', () => {
    function makeQueryFn(): jest.Mock {
      return jest.fn((): Query => makeFakeQuery() as unknown as Query)
    }

    /** Consume the first user message the SDK session was fed. */
    async function firstPromptContent(queryFn: jest.Mock): Promise<string> {
      const { prompt } = queryFn.mock.calls[0][0] as {
        prompt: AsyncIterable<{ message: { content: unknown } }>
      }
      const next = await prompt[Symbol.asyncIterator]().next()
      expect(next.done).toBe(false)
      return String((next.value as { message: { content: unknown } }).message.content)
    }

    it('prefixes the FIRST turn with the compact block when the CLI shim is on PATH', async () => {
      const queryFn = makeQueryFn()
      const manager = new AgentManager(store, credentialsStub, broker, {
        queryFn: queryFn as unknown as QueryFunction,
        cliShimDir: '/tmp/planflow-shim',
      })
      const thread = store.createThread({ projectRoot: tempDir })
      await manager.sendMessage(thread.id, 'where is the thread store?')

      const content = await firstPromptContent(queryFn)
      expect(content.startsWith(BRAIN_FIRST_COMPACT)).toBe(true)
      expect(content).toContain('where is the thread store?')
      // The stored user message stays verbatim — the block is agent input only.
      expect(store.listMessages(thread.id)[0].content).toBe('where is the thread store?')
      manager.dispose()
    })

    it('never instructs the verb when the shim is unavailable (cliShimDir null)', async () => {
      const queryFn = makeQueryFn()
      const manager = new AgentManager(store, credentialsStub, broker, {
        queryFn: queryFn as unknown as QueryFunction,
        cliShimDir: null,
      })
      const thread = store.createThread({ projectRoot: tempDir })
      await manager.sendMessage(thread.id, 'hello')

      expect(await firstPromptContent(queryFn)).toBe('hello')
      manager.dispose()
    })

    it('later turns (an assistant reply landed) carry no block', async () => {
      const queryFn = makeQueryFn()
      const manager = new AgentManager(store, credentialsStub, broker, {
        queryFn: queryFn as unknown as QueryFunction,
        cliShimDir: '/tmp/planflow-shim',
      })
      const thread = store.createThread({ projectRoot: tempDir })
      store.appendMessage(thread.id, 'assistant', 'earlier reply')
      await manager.sendMessage(thread.id, 'again')

      expect(await firstPromptContent(queryFn)).toBe('again')
      manager.dispose()
    })

    it('orders brain-first before the task seed on a seeded thread', async () => {
      const queryFn = makeQueryFn()
      const manager = new AgentManager(store, credentialsStub, broker, {
        queryFn: queryFn as unknown as QueryFunction,
        cliShimDir: '/tmp/planflow-shim',
        seedProvider: () => 'Issue context: fix the widget',
      })
      const thread = store.createThread({ projectRoot: tempDir })
      await manager.sendMessage(thread.id, 'go')

      expect(await firstPromptContent(queryFn)).toBe(
        `${BRAIN_FIRST_COMPACT}\n\nIssue context: fix the widget\n\ngo`,
      )
      manager.dispose()
    })
  })
  describe('a send into a live Claude turn is not a new turn (mid-run-subtasks note 2)', () => {
    interface Fed {
      message: { content: unknown }
      priority?: string
    }

    function harness(): {
      manager: AgentManager
      query: () => FakeQuery
      fed: () => Promise<Fed>
      turnStarts: string[]
    } {
      let current: FakeQuery | null = null
      let iterator: AsyncIterator<Fed> | null = null
      const turnStarts: string[] = []
      const queryFn = jest.fn((params: { prompt: AsyncIterable<Fed> }): Query => {
        iterator = params.prompt[Symbol.asyncIterator]()
        current = makeFakeQuery()
        return current as unknown as Query
      })
      const manager = new AgentManager(store, credentialsStub, broker, {
        queryFn: queryFn as unknown as QueryFunction,
        cliShimDir: '/tmp/planflow-shim',
        seedProvider: () => 'Issue context: fix the widget',
        onTurnStart: (threadId) => turnStarts.push(threadId),
      })
      manager.on(AGENT_STREAM_EVENT, (event: AgentStreamEvent) => events.push(event))
      return {
        manager,
        query: () => current as FakeQuery,
        fed: async () => {
          const next = await (iterator as AsyncIterator<Fed>).next()
          expect(next.done).toBe(false)
          return next.value
        },
        turnStarts,
      }
    }

    const workingFlips = (threadId: string): number =>
      events.filter((e) => e.kind === 'status' && e.threadId === threadId && e.status === 'working').length

    it('pushes into the working turn with priority next and skips the turn-start work', async () => {
      const { manager, fed, turnStarts } = harness()
      const thread = store.createThread({ projectRoot: tempDir })
      await manager.sendMessage(thread.id, 'first')
      // The positive first (allowed-pattern #28): the first send IS a turn start.
      expect(turnStarts).toEqual([thread.id])
      expect(workingFlips(thread.id)).toBe(1)
      const first = await fed()
      expect(String(first.message.content)).toContain('Issue context: fix the widget')
      expect(first.priority).toBeUndefined()

      await manager.sendMessage(thread.id, 'also do this')
      const second = await fed()
      // Verbatim — no seed or brain-first block, although no assistant reply
      // has landed yet (isFirstTurn is still true for this message).
      expect(second.message.content).toBe('also do this')
      expect(second.priority).toBe('next')
      expect(turnStarts).toEqual([thread.id])
      expect(workingFlips(thread.id)).toBe(1)
      // Stored as sent, so the chat shows it.
      expect(store.listMessages(thread.id).map((m) => [m.role, m.content])).toEqual([
        ['user', 'first'],
        ['user', 'also do this'],
      ])
      expect(store.getThread(thread.id)?.status).toBe('working')
      manager.dispose()
    })

    it('a turn that has ended takes the next send as a new turn', async () => {
      const { manager, fed, query, turnStarts } = harness()
      const thread = store.createThread({ projectRoot: tempDir })
      await manager.sendMessage(thread.id, 'first')
      await fed()
      query().push(resultSuccess())
      await flushMicrotasks()
      expect(store.getThread(thread.id)?.status).toBe('done')

      await manager.sendMessage(thread.id, 'next turn')
      const second = await fed()
      expect(second.priority).toBeUndefined()
      expect(turnStarts).toEqual([thread.id, thread.id])
      expect(workingFlips(thread.id)).toBe(2)
      manager.dispose()
    })

    it('a turn parked on a decision is not joined — main takes the normal path (#1470)', async () => {
      const { manager, fed, turnStarts } = harness()
      const thread = store.createThread({ projectRoot: tempDir })
      await manager.sendMessage(thread.id, 'first')
      await fed()
      store.updateThread(thread.id, { status: 'needs-decision' })

      await manager.sendMessage(thread.id, 'stop that')
      const second = await fed()
      expect(second.priority).toBeUndefined()
      expect(turnStarts).toEqual([thread.id, thread.id])
      manager.dispose()
    })
  })

  describe("the session moves into the thread's worktree (phase 4)", () => {
    // Fictional absolute roots: containment is lexical (no disk access), and
    // tmpdir() is a temp SINK for bash containment — writes there are always
    // allowed, which would hide exactly what these tests assert.
    const projectDir = '/worktree-e2e/project'
    const worktreeDir = '/worktree-e2e/.project-threads/blue-heron'
    const siblingDir = '/worktree-e2e/sibling'
    let fakes: FakeQuery[]
    let captured: Options | undefined

    beforeEach(() => {
      fakes = []
      captured = undefined
    })

    afterEach(async () => {
      fakes.forEach((fake) => fake.release())
      await flushMicrotasks()
    })

    /** Spin a session for a thread, capturing the options it was built with. */
    async function spawn(options?: {
      worktree?: { path: string; branch: string | null; base: string | null }
      extraRoots?: string[]
      /** An attached project's own thread checkout: root → checkout path. */
      rootWorktrees?: Record<string, string>
      knownProjectRoots?: string[]
    }): Promise<{ manager: AgentManager; threadId: string }> {
      const queryFn: QueryFunction = (params) => {
        captured = params.options
        const fake = makeFakeQuery()
        fakes.push(fake)
        return fake as unknown as Query
      }
      const manager = new AgentManager(store, credentialsStub, broker, {
        queryFn,
        knownProjectRoots: () => options?.knownProjectRoots ?? [projectDir, siblingDir],
      })
      manager.on(AGENT_STREAM_EVENT, (event: AgentStreamEvent) => events.push(event))
      const thread = store.createThread({ projectRoot: projectDir })
      if (options?.worktree) store.setThreadWorktree(thread.id, options.worktree)
      if (options?.extraRoots) store.setThreadRoots(thread.id, options.extraRoots)
      for (const [root, path] of Object.entries(options?.rootWorktrees ?? {})) {
        store.setThreadRootWorktree(thread.id, root, { path, branch: null, base: 'main' })
      }
      await manager.sendMessage(thread.id, 'go')
      return { manager, threadId: thread.id }
    }

    type PreToolUseHook = NonNullable<NonNullable<Options['hooks']>['PreToolUse']>[number]

    function hookFor(toolName: string): PreToolUseHook['hooks'][number] {
      const entries = captured?.hooks?.PreToolUse ?? []
      const entry = entries.find((candidate) =>
        (candidate.matcher ?? '').split('|').includes(toolName),
      )
      if (!entry) throw new Error(`no PreToolUse hook matches ${toolName}`)
      return entry.hooks[0]
    }

    async function invokeHook(toolName: string, toolInput: unknown): Promise<unknown> {
      return hookFor(toolName)(
        {
          hook_event_name: 'PreToolUse' as const,
          tool_name: toolName,
          tool_input: toolInput,
          tool_use_id: 'tu-wt',
          session_id: 's-wt',
          transcript_path: '',
          cwd: worktreeDir,
        },
        'tu-wt',
        { signal: new AbortController().signal },
      )
    }

    it('spawns in the worktree, not the project checkout', async () => {
      const { manager } = await spawn({
        worktree: { path: worktreeDir, branch: null, base: 'main' },
      })
      expect(captured?.cwd).toBe(worktreeDir)
      manager.dispose()
    })

    it('a thread with no worktree keeps the project cwd and no extra directories', async () => {
      const { manager } = await spawn()
      expect(captured?.cwd).toBe(projectDir)
      expect(captured?.additionalDirectories).toBeUndefined()
      manager.dispose()
    })

    // A DELIBERATE FLIP, PINNED HERE (review F-2). Until this change a thread
    // with no worktree omitted `systemPrompt` altogether, and the test that
    // stood here asserted exactly that: `expect(captured?.systemPrompt)
    // .toBeUndefined()`. Omitting the key never meant "use the SDK default" —
    // the shipped bundle reads `if (n === void 0) d = ""` and sends
    // `systemPrompt: ""`, an explicit override to an EMPTY prompt. So these
    // threads ran with no system prompt at all. They now get the full
    // `claude_code` preset plus the append, on purpose (see the call site in
    // agent-manager.ts). If this test fails, someone reverted that decision —
    // read the reasoning before agreeing with them.
    it('runs with the full claude_code preset even with no worktree — not the empty prompt it used to get', async () => {
      const { manager } = await spawn()
      const prompt = captured?.systemPrompt
      // Present, and specifically the preset — not undefined (`""` to the SDK)
      // and not a custom string that would replace the preset instead of adding
      // to it.
      expect(prompt).toBeDefined()
      expect(typeof prompt).toBe('object')
      expect(prompt).toMatchObject({ type: 'preset', preset: 'claude_code' })
      // …and the append rides along, which is the half the fold depends on:
      // the writing rules, then the answer shape.
      expect(prompt).toMatchObject({
        append: `${writingRulesBriefing()}\n\n${TURN_CLOSE_BRIEFING}\n\n${ASKING_BRIEFING}`,
      })
      manager.dispose()
    })

    // No built-in plan mode (user, 2026-10-09): Flow plans through its own
    // workflow, and the agent's plan mode wrote a private plan file and asked
    // for an ExitPlanMode permission in the middle of /execute-plan.
    it('never offers the agent its built-in plan mode', async () => {
      const { manager } = await spawn()
      expect(captured?.disallowedTools).toEqual(expect.arrayContaining(['EnterPlanMode', 'ExitPlanMode']))
      manager.dispose()
    })

    it('says nothing about a worktree it does not have — only the answer shape', async () => {
      const { manager } = await spawn()
      const prompt = captured?.systemPrompt
      expect(prompt).toMatchObject({ type: 'preset', preset: 'claude_code' })
      const append =
        typeof prompt === 'object' && prompt !== null && 'append' in prompt
          ? String(prompt.append)
          : ''
      expect(append).toBe(`${writingRulesBriefing()}\n\n${TURN_CLOSE_BRIEFING}\n\n${ASKING_BRIEFING}`)
      expect(append).not.toContain('worktree')
      manager.dispose()
    })

    it('never lists the main checkout in additionalDirectories', async () => {
      const { manager } = await spawn({
        worktree: { path: worktreeDir, branch: 'thread/blue-heron', base: 'main' },
        extraRoots: [siblingDir],
      })
      expect(captured?.additionalDirectories).toContain(siblingDir)
      expect(captured?.additionalDirectories).not.toContain(projectDir)
      manager.dispose()
    })

    it('denies a write into the main checkout, and never auto-attaches it (it is a known root)', async () => {
      const { manager, threadId } = await spawn({
        worktree: { path: worktreeDir, branch: null, base: 'main' },
      })

      const outcome = await invokeHook('Write', {
        file_path: join(projectDir, 'src/index.ts'),
        content: 'x',
      })

      expect(outcome).toMatchObject({
        hookSpecificOutput: { permissionDecision: 'deny' },
      })
      // The door auto-attach would otherwise open: the main checkout is a known
      // project root, so without the filter this write would have attached it.
      expect(store.getThreadRoots(threadId)).toEqual([])
      manager.dispose()
    })

    it('allows a write inside the worktree, and still auto-attaches other known roots', async () => {
      const { manager, threadId } = await spawn({
        worktree: { path: worktreeDir, branch: null, base: 'main' },
      })

      expect(
        await invokeHook('Write', { file_path: join(worktreeDir, 'src/index.ts'), content: 'x' }),
      ).toEqual({ continue: true })

      expect(
        await invokeHook('Write', { file_path: join(siblingDir, 'src/index.ts'), content: 'x' }),
      ).toEqual({ continue: true })
      expect(store.getThreadRoots(threadId)).toEqual([siblingDir])
      manager.dispose()
    })

    it('tells the session where it is — worktree, branch, base, and the missing working copy', async () => {
      const { manager } = await spawn({
        worktree: { path: worktreeDir, branch: 'thread/blue-heron', base: 'main' },
      })
      const prompt = captured?.systemPrompt
      expect(prompt).toMatchObject({ type: 'preset', preset: 'claude_code' })
      const append = typeof prompt === 'object' && prompt !== null && 'append' in prompt
        ? String(prompt.append)
        : ''
      expect(append).toContain(worktreeDir)
      expect(append).toContain(projectDir)
      expect(append).toContain('thread/blue-heron')
      expect(append).toContain('main')
      expect(append).toContain('UNCOMMITTED')
      // Situation first, then the writing rules, then the answer shape.
      const rulesAt = append.indexOf(writingRulesBriefing())
      expect(append.indexOf(worktreeDir)).toBeLessThan(rulesAt)
      expect(rulesAt).toBeLessThan(append.indexOf(TURN_CLOSE_BRIEFING))
      manager.dispose()
    })

    describe('an attached project works in ITS thread checkout, not its main tree', () => {
      const siblingWorktree = '/worktree-e2e/.sibling-threads/blue-heron'

      it('the SDK session lists the checkout among its extra folders', async () => {
        const { manager } = await spawn({
          worktree: { path: worktreeDir, branch: null, base: 'main' },
          extraRoots: [siblingDir],
          rootWorktrees: { [siblingDir]: siblingWorktree },
        })
        expect(captured?.additionalDirectories).toContain(siblingWorktree)
        expect(captured?.additionalDirectories).not.toContain(siblingDir)
        manager.dispose()
      })

      it('an attached project WITHOUT a checkout keeps its main tree', async () => {
        const { manager } = await spawn({ extraRoots: [siblingDir] })
        expect(captured?.additionalDirectories).toContain(siblingDir)
        manager.dispose()
      })

      it('writes land in the checkout; the main tree is refused and never re-attached', async () => {
        const { manager, threadId } = await spawn({
          worktree: { path: worktreeDir, branch: null, base: 'main' },
          extraRoots: [siblingDir],
          rootWorktrees: { [siblingDir]: siblingWorktree },
        })
        const before = store.listMessages(threadId).length
        expect(
          await invokeHook('Write', { file_path: join(siblingWorktree, 'src/a.ts'), content: 'x' }),
        ).toEqual({ continue: true })
        expect(
          await invokeHook('Write', { file_path: join(siblingDir, 'src/a.ts'), content: 'x' }),
        ).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } })
        // No "Attached sibling" line: it was refused, not re-attached.
        expect(store.listMessages(threadId)).toHaveLength(before)
        expect(store.getThreadRoots(threadId)).toEqual([siblingDir])
        manager.dispose()
      })

      it('a codex thread is handed the checkout as a folder it may write', async () => {
        const starts: Array<{ opts: RuntimeStartOptions; callbacks: RuntimeCallbacks }> = []
        const manager = new AgentManager(store, credentialsStub, broker, {
          queryFn: jest.fn((): Query => makeFakeQuery() as unknown as Query),
          resolveProviderFor: () => 'codex',
          codexRuntimeFactory: () => makeFakeRuntime(starts),
          isAttachableRoot: () => true,
        })
        const thread = store.createThread({ projectRoot: projectDir })
        store.setThreadRoots(thread.id, [siblingDir])
        store.setThreadRootWorktree(thread.id, siblingDir, { path: siblingWorktree, branch: null, base: 'main' })
        await manager.sendMessage(thread.id, 'go')
        expect(starts).toHaveLength(1)
        expect(starts[0].opts.additionalRoots).toContain(siblingWorktree)
        expect(starts[0].opts.writableRoots).toContain(siblingWorktree)
        expect(starts[0].opts.additionalRoots).not.toContain(siblingDir)
        expect(starts[0].opts.writableRoots).not.toContain(siblingDir)
        manager.dispose()
      })
    })

    it('a codex thread starts its runtime in the worktree too', async () => {
      const starts: Array<{ opts: RuntimeStartOptions; callbacks: RuntimeCallbacks }> = []
      const manager = new AgentManager(store, credentialsStub, broker, {
        queryFn: jest.fn((): Query => makeFakeQuery() as unknown as Query),
        resolveProviderFor: () => 'codex',
        codexRuntimeFactory: () => makeFakeRuntime(starts),
      })
      manager.on(AGENT_STREAM_EVENT, (event: AgentStreamEvent) => events.push(event))
      const thread = store.createThread({ projectRoot: projectDir })
      store.setThreadWorktree(thread.id, { path: worktreeDir, branch: null, base: 'main' })
      await manager.sendMessage(thread.id, 'go')
      expect(starts[0].opts.cwd).toBe(worktreeDir)
      manager.dispose()
    })
  })

  describe('threadWorktreeBriefing', () => {
    const base = {
      projectRoot: '/repos/project',
      worktreePath: '/repos/.project-threads/blue',
      worktreeBranch: null,
      worktreeBase: 'main',
    }

    it('is null for a thread with no worktree — nothing to say', () => {
      expect(threadWorktreeBriefing({ ...base, worktreePath: null })).toBeNull()
    })

    it('reads honestly while detached — the normal state before the first turn names it', () => {
      const text = threadWorktreeBriefing(base) ?? ''
      expect(text).toContain('DETACHED')
      expect(text).not.toContain('null')
      expect(text).toContain('main')
    })

    it('names the branch once it has one', () => {
      const text = threadWorktreeBriefing({ ...base, worktreeBranch: 'thread/blue' }) ?? ''
      expect(text).toContain('thread/blue')
      expect(text).not.toContain('DETACHED')
    })

    it('says nothing about a base it does not have', () => {
      const text = threadWorktreeBriefing({ ...base, worktreeBase: null }) ?? ''
      expect(text).not.toContain('cut from')
      expect(text).not.toContain('null')
    })
  })
  describe('the checkout is cut before the session (phase 5)', () => {
    const projectDir = '/worktree-p5/project'
    const checkout = '/worktree-p5/.project-threads/t'

    it('creates the checkout BEFORE the session spawns, so the session lands in it', async () => {
      const fakes: FakeQuery[] = []
      let captured: Options | undefined
      const queryFn: QueryFunction = (params) => {
        captured = params.options
        const fake = makeFakeQuery()
        fakes.push(fake)
        return fake as unknown as Query
      }
      let threadId = ''
      const manager = new AgentManager(store, credentialsStub, broker, {
        queryFn,
        // The real service does exactly this: it writes worktree_path and
        // returns. If it ran after the spawn, the cwd below would be the
        // project — the session's root is fixed at spawn and never moves.
        ensureThreadWorktree: async (id) => {
          store.setThreadWorktree(id, { path: checkout, branch: null, base: 'main' })
        },
      })
      const thread = store.createThread({ projectRoot: projectDir })
      threadId = thread.id
      await manager.sendMessage(threadId, 'go')

      expect(captured?.cwd).toBe(checkout)
      manager.dispose()
      fakes.forEach((fake) => fake.release())
      await flushMicrotasks()
    })

    it('a thread that is only ever created never asks for one', async () => {
      const ensureThreadWorktree = jest.fn(async () => undefined)
      const manager = new AgentManager(store, credentialsStub, broker, {
        queryFn: jest.fn((): Query => makeFakeQuery() as unknown as Query),
        ensureThreadWorktree,
      })
      // THE CHAT-ONLY GUARANTEE. Everything a thread does short of sending —
      // being created, being read back, being renamed — and the hook is never
      // reached, so nothing is ever created on disk.
      const thread = store.createThread({ projectRoot: projectDir })
      store.getThread(thread.id)
      store.updateThread(thread.id, { title: 'Just chatting' })
      store.listThreads(projectDir)

      expect(ensureThreadWorktree).not.toHaveBeenCalled()
      manager.dispose()
    })

    it('does not reach for one on a thread that is already running a session', async () => {
      const fakes: FakeQuery[] = []
      const ensureThreadWorktree = jest.fn(async () => undefined)
      const manager = new AgentManager(store, credentialsStub, broker, {
        queryFn: jest.fn((): Query => {
          const fake = makeFakeQuery()
          fakes.push(fake)
          return fake as unknown as Query
        }),
        ensureThreadWorktree,
      })
      const thread = store.createThread({ projectRoot: projectDir })
      await manager.sendMessage(thread.id, 'first')
      await manager.sendMessage(thread.id, 'second')

      // Once. A session already bound to a root cannot be relocated, so asking
      // again would only spawn a process to be told "ready".
      expect(ensureThreadWorktree).toHaveBeenCalledTimes(1)
      // AND IT WAS TOLD THIS WAS THE CONVERSATION'S FIRST TURN, which is what
      // gates the folder-behind notice to once per conversation. Asserted here
      // because this is the only caller that can answer it.
      expect(ensureThreadWorktree).toHaveBeenCalledWith(thread.id, { firstTurn: true })
      manager.dispose()
      fakes.forEach((fake) => fake.release())
      await flushMicrotasks()
    })

    it('names the checkout only after the title has settled', async () => {
      const fakes: FakeQuery[] = []
      const queryFn = jest.fn((): Query => {
        const fake = makeFakeQuery()
        fakes.push(fake)
        return fake as unknown as Query
      })
      const titleAtHook: Array<string | undefined> = []
      const thread = store.createThread({ projectRoot: projectDir })
      const manager = new AgentManager(store, credentialsStub, broker, {
        queryFn,
        titleGenerator: jest.fn().mockResolvedValue('Fix the login redirect'),
        onThreadTitleSettled: (id) => titleAtHook.push(store.getThread(id)?.title),
      })

      await manager.sendMessage(thread.id, 'the login page keeps redirecting')
      fakes[0].push(resultSuccess())
      await flushMicrotasks()

      // A branch named from the title has to be named AFTER it — beside it, the
      // checkout would be branded from the placeholder.
      expect(titleAtHook).toEqual(['Fix the login redirect'])
      manager.dispose()
      fakes.forEach((fake) => fake.release())
      await flushMicrotasks()
    })

    it('never fires the naming hook for a failed turn', async () => {
      const fakes: FakeQuery[] = []
      const onThreadTitleSettled = jest.fn()
      const manager = new AgentManager(store, credentialsStub, broker, {
        queryFn: jest.fn((): Query => {
          const fake = makeFakeQuery()
          fakes.push(fake)
          return fake as unknown as Query
        }),
        onThreadTitleSettled,
      })
      const thread = store.createThread({ projectRoot: projectDir })
      await manager.sendMessage(thread.id, 'go')
      fakes[0].push(resultFailure())
      await flushMicrotasks()

      expect(onThreadTitleSettled).not.toHaveBeenCalled()
      manager.dispose()
      fakes.forEach((fake) => fake.release())
      await flushMicrotasks()
    })
  })

  // The card the user sees is the TASK, not the thread. A "from scratch" task is
  // created titleless and named from its opening message via the thread
  // auto-titler — which writes the thread store directly. This wires the exact
  // production path (main/index.ts's onThreadTitleSettled → syncTaskTitleFromThread)
  // to prove the generated name reaches the card, not just the chat.
  describe('a from-scratch task card takes its chat’s generated name', () => {
    it('mirrors the auto-title onto the owning task on a clean turn', async () => {
      const taskStore = new TaskStore(db)
      const task = createManualTask({ taskStore, threadStore: store }, { projectRoot: '/tmp/proj', title: '' })
      expect(task.title).toBe('') // starts untitled — the card reads "Untitled task"

      const fakes: FakeQuery[] = []
      const manager = new AgentManager(store, credentialsStub, broker, {
        queryFn: jest.fn((): Query => {
          const fake = makeFakeQuery()
          fakes.push(fake)
          return fake as unknown as Query
        }),
        titleGenerator: jest.fn().mockResolvedValue('Group repeated tool calls'),
        // The exact wiring from main/index.ts.
        onThreadTitleSettled: (id) => {
          const thread = store.getThread(id)
          if (thread) syncTaskTitleFromThread({ taskStore }, id, thread.title)
        },
      })

      await manager.sendMessage(task.threadId!, 'the chat feed stacks N identical edit cards')
      fakes[0].push(resultSuccess())
      await flushMicrotasks()

      expect(store.getThread(task.threadId!)?.title).toBe('Group repeated tool calls')
      expect(taskStore.getTask(task.id)?.title).toBe('Group repeated tool calls')

      manager.dispose()
      fakes.forEach((fake) => fake.release())
      await flushMicrotasks()
    })
  })
})

describe('session briefings compose the one writing-rules text', () => {
  const noWorktree = {
    projectRoot: '/repo',
    worktreePath: null,
    worktreeBase: null,
    worktreeBranch: null,
  }

  it('a Claude briefing is the writing rules, then the answer shape, then how to ask', () => {
    expect(sessionBriefing(noWorktree)).toBe(`${writingRulesBriefing()}\n\n${TURN_CLOSE_BRIEFING}\n\n${ASKING_BRIEFING}`)
  })

  it('a runtime first prompt is the writing rules, then the text', () => {
    expect(runtimeFirstPrompt('hello')).toBe(`${writingRulesBriefing()}\n\nhello`)
  })

  it('the answer shape follows the rules it sits beside — no sentence over 25 words', () => {
    const sentences = TURN_CLOSE_BRIEFING.split(/(?<=[.!?])\s+/).filter((s) => s.length > 0)
    const long = sentences.filter((s) => s.split(/\s+/).length > 25)
    expect(long).toEqual([])
  })

  // ── Asking is a tool, not a lettered list (user, 2026-10-13) ─────────────

  it('tells a Claude session to ask with the tool, and not to list the choice in prose', () => {
    // The reported thread wrote "A. … B. … C. …" in the answer, so no card
    // could appear and the person had to type their choice back.
    expect(ASKING_BRIEFING).toContain('AskUserQuestion')
    expect(ASKING_BRIEFING).toMatch(/lettered or numbered list/)
    expect(ASKING_BRIEFING).toMatch(/2 to 4 options/)
  })

  it('leaves reporting and explaining in prose — it is not an instruction to ask more', () => {
    // A rule that said "ask with the tool" and stopped would turn every
    // recommendation into a picker. The carve-out is part of the rule.
    expect(ASKING_BRIEFING).toMatch(/report, explain or recommend/)
  })

  it('never reaches a runtime that has no question card', () => {
    // The card exists only on the Claude path (canUseTool → the dialog
    // broker). Naming the tool to Copilot or Codex would point at a control
    // that is not there.
    expect(runtimeFirstPrompt('hello')).not.toContain('AskUserQuestion')
    expect(writingRulesBriefing()).not.toContain('AskUserQuestion')
  })

  it('follows the rules it sits beside — no sentence over 25 words', () => {
    const sentences = ASKING_BRIEFING.split(/(?<=[.!?])\s+/).filter((s) => s.length > 0)
    const long = sentences.filter((s) => s.split(/\s+/).length > 25)
    expect(long).toEqual([])
  })
})
