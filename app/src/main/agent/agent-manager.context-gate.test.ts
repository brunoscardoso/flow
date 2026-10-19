// AgentManager × the context gate (Workspaces Phase 7) — a REAL ThreadStore
// over a temp better-sqlite3 DB, a fake SDK query and a fake Codex runtime.
//
// What is proven here is the half the gate's own suite cannot see: that the
// projects the gate attaches are in the session's folders WHEN IT STARTS (for
// Claude and Codex), that an attach mid-thread widens the NEXT turn's folders
// and a detach narrows them (the session is stood down and resumed), and that
// with the gate absent or off a send is exactly what it was.

import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import type { Options, Query } from '@anthropic-ai/claude-agent-sdk'

import type { CredentialsManager } from '../credentials'
import { openDatabase, type FlowDatabase } from '../store/db'
import { ThreadStore } from '../store/thread-store'
import { AgentManager, type QueryFunction } from './agent-manager'
import { createContextGate, type ContextGateDeps, type GateWorkspace } from './context-gate'
import { PermissionBroker } from './permissions'
import type { AgentRuntime, RuntimeCallbacks, RuntimeStartOptions } from './runtime/agent-runtime'
import { CODEX_CAPABILITIES } from './runtime/codex-runtime'

interface FakeQuery {
  push(message: unknown): void
  close: jest.Mock
  interrupt: jest.Mock
  setModel: jest.Mock
  [Symbol.asyncIterator](): AsyncIterator<unknown>
}

/** A Query that streams what the test pushes and ends when closed. */
function makeFakeQuery(): FakeQuery {
  const buffered: unknown[] = []
  let waiting: ((result: IteratorResult<unknown>) => void) | null = null
  let ended = false
  const end = (): void => {
    ended = true
    if (waiting) {
      const resolve = waiting
      waiting = null
      resolve({ value: undefined, done: true })
    }
  }
  return {
    push(message) {
      if (waiting) {
        const resolve = waiting
        waiting = null
        resolve({ value: message, done: false })
      } else buffered.push(message)
    },
    close: jest.fn(end),
    interrupt: jest.fn().mockResolvedValue(undefined),
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

function makeFakeRuntime(starts: Array<{ opts: RuntimeStartOptions; callbacks: RuntimeCallbacks }>, sends: string[]): AgentRuntime {
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

const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve))
}

const LONG = 'Add a discount field to the orders endpoint and show it on the checkout screen please.'

describe('AgentManager × the context gate', () => {
  let tempDir: string
  let projectDir: string
  let webDir: string
  let docsDir: string
  let db: FlowDatabase
  let store: ThreadStore
  let broker: PermissionBroker
  const credentialsStub = { get: () => null } as unknown as CredentialsManager

  beforeEach(() => {
    tempDir = realpathSync(mkdtempSync(join(tmpdir(), 'flow-context-gate-')))
    projectDir = join(tempDir, 'api')
    webDir = join(tempDir, 'web')
    docsDir = join(tempDir, 'docs')
    for (const dir of [projectDir, webDir, docsDir]) mkdirSync(dir)
    db = openDatabase(join(tempDir, 'flow.sqlite'))
    store = new ThreadStore(db)
    broker = new PermissionBroker(db)
  })

  afterEach(() => {
    db.close()
    rmSync(tempDir, { recursive: true, force: true })
  })

  function workspace(): GateWorkspace {
    const view = (slug: string, name: string, localPath: string) => ({
      slug,
      name,
      description: `${name} things`,
      localPath,
      flowPath: join(tempDir, 'flow', slug),
    })
    return {
      workspace: { slug: 'acme', name: 'Acme' },
      current: view('api', 'Backend', projectDir),
      siblings: [view('web', 'Frontend', webDir), view('docs', 'Docs', docsDir)],
    }
  }

  function gateDeps(overrides: Partial<ContextGateDeps> = {}): ContextGateDeps & { chosen: unknown[] } {
    const chosen: unknown[] = []
    return {
      chosen,
      workspaceOf: async () => workspace(),
      askModel: async ({ prompt }) => (prompt.includes('"attached"') ? '{"primary":"api","attached":["web"]}' : null),
      attachedRoots: (threadId) => store.getThreadRoots(threadId),
      projectsChosen: () => false,
      attach: (threadId, roots) => {
        for (const root of roots) store.addThreadRoot(threadId, root)
      },
      recordNote: (threadId, text) => {
        store.appendMessage(threadId, 'system', text)
      },
      announceChosen: (event) => chosen.push(event),
      announceOffer: () => undefined,
      openRoot: async (localPath) => localPath,
      localDescriptions: { get: () => null, set: () => undefined },
      readHead: async () => null,
      log: () => undefined,
      ...overrides,
    }
  }

  /** A Claude manager whose every session's options are captured, in order. */
  function claudeManager(gate: ContextGateDeps | null) {
    const captured: Options[] = []
    const queries: FakeQuery[] = []
    const queryFn = jest.fn(({ options }: { options?: Options }): Query => {
      captured.push(options ?? {})
      const query = makeFakeQuery()
      queries.push(query)
      return query as unknown as Query
    }) as unknown as QueryFunction
    const manager = new AgentManager(store, credentialsStub, broker, {
      queryFn,
      // Neither the auto-titler's one-shot nor the machine's own MCP config
      // belongs in what this suite captures.
      titleGenerator: async () => null,
      loadExternalMcpServers: () => ({}),
      ...(gate === null ? {} : { contextGate: createContextGate(gate) }),
    })
    return { manager, captured, queries }
  }

  /** End the current Claude turn cleanly: a session id, an answer, a success result. */
  async function finishClaudeTurn(query: FakeQuery, threadId: string): Promise<void> {
    query.push({ type: 'system', subtype: 'init', session_id: 'sdk-1', model: 'claude' })
    store.appendMessage(threadId, 'assistant', 'done')
    query.push({ type: 'result', subtype: 'success', is_error: false, result: 'done', usage: { input_tokens: 1, output_tokens: 1 } })
    await flush()
  }

  it('Claude: the gate\'s projects are in additionalDirectories when the session starts', async () => {
    const deps = gateDeps()
    const { manager, captured } = claudeManager(deps)
    const thread = store.createThread({ projectRoot: projectDir })
    await manager.sendMessage(thread.id, LONG)

    expect(captured).toHaveLength(1)
    expect(captured[0].additionalDirectories).toContain(webDir)
    expect(captured[0].additionalDirectories).not.toContain(docsDir)
    expect(store.getThreadRoots(thread.id)).toEqual([webDir])
    expect(store.listMessages(thread.id).map((message) => message.content)).toContain('Added Frontend to this conversation.')
    expect(deps.chosen).toEqual([{ threadId: thread.id, added: [{ root: webDir, name: 'Frontend' }], source: 'gate' }])
    manager.dispose()
  })

  it('Codex: the gate\'s projects are its extra and writable folders when the runtime starts', async () => {
    const starts: Array<{ opts: RuntimeStartOptions; callbacks: RuntimeCallbacks }> = []
    const manager = new AgentManager(store, credentialsStub, broker, {
      queryFn: jest.fn(),
      resolveProviderFor: () => 'codex',
      codexRuntimeFactory: () => makeFakeRuntime(starts, []),
      // Every root in this suite is a project Flow knows.
      isAttachableRoot: () => true,
      contextGate: createContextGate(gateDeps()),
    })
    const thread = store.createThread({ projectRoot: projectDir })
    await manager.sendMessage(thread.id, LONG)
    expect(starts).toHaveLength(1)
    expect(starts[0].opts.additionalRoots).toContain(webDir)
    expect(starts[0].opts.writableRoots).toContain(webDir)
    expect(starts[0].opts.additionalRoots).not.toContain(docsDir)
    manager.dispose()
  })

  it('a second send while the first send\'s gate is deciding waits for the decision — one session, the attachments, the order kept', async () => {
    let answer: ((text: string) => void) | null = null
    const inputs: unknown[] = []
    const captured: Options[] = []
    const queryFn = jest.fn(({ prompt, options }: { prompt: unknown; options?: Options }): Query => {
      captured.push(options ?? {})
      inputs.push(prompt)
      return makeFakeQuery() as unknown as Query
    }) as unknown as QueryFunction
    const manager = new AgentManager(store, credentialsStub, broker, {
      queryFn,
      titleGenerator: async () => null,
      loadExternalMcpServers: () => ({}),
      contextGate: createContextGate(
        gateDeps({
          askModel: ({ prompt }) =>
            prompt.includes('"attached"')
              ? new Promise<string>((resolve) => {
                  answer = resolve
                })
              : Promise.resolve(null),
        }),
      ),
    })
    const thread = store.createThread({ projectRoot: projectDir })
    const first = manager.sendMessage(thread.id, LONG)
    await flush()
    // Positive first: the gate IS deciding (its question is out).
    expect(answer).not.toBeNull()
    const second = manager.sendMessage(thread.id, 'and also the tests')
    await flush()
    // The second send has not started a session without the attachments.
    expect(captured).toHaveLength(0)
    ;(answer as unknown as (text: string) => void)('{"primary":"api","attached":["web"]}')
    await Promise.all([first, second])
    expect(captured).toHaveLength(1)
    expect(captured[0].additionalDirectories).toContain(webDir)
    // Both messages reached the one session, in the order they were sent.
    const pending = (inputs[0] as { takePending(): Array<{ message: { content: unknown } }> }).takePending()
    expect(pending.map((entry) => JSON.stringify(entry.message.content))).toEqual([
      expect.stringContaining('Add a discount field'),
      expect.stringContaining('and also the tests'),
    ])
    manager.dispose()
  })

  it('the hand-pick path: projects attached before the first send are the session\'s, and the model is not asked', async () => {
    const asked: string[] = []
    const { manager, captured } = claudeManager(
      gateDeps({
        askModel: async ({ prompt }) => {
          asked.push(prompt)
          return '{"primary":"api","attached":["web"]}'
        },
      }),
    )
    const thread = store.createThread({ projectRoot: projectDir })
    store.setThreadRoots(thread.id, [docsDir])
    await manager.sendMessage(thread.id, LONG)
    expect(asked).toEqual([])
    expect(captured[0].additionalDirectories).toContain(docsDir)
    expect(captured[0].additionalDirectories).not.toContain(webDir)

    // …and the explicit flag skips it on a thread with nothing picked.
    const other = store.createThread({ projectRoot: projectDir })
    await manager.sendMessage(other.id, LONG, undefined, { skipContextGate: true })
    expect(asked).toEqual([])
    expect(store.getThreadRoots(other.id)).toEqual([])
    manager.dispose()
  })

  it('with no gate at all a send is exactly today\'s', async () => {
    // Positive first: the same setup with the gate DOES widen the session.
    const on = claudeManager(gateDeps())
    const first = store.createThread({ projectRoot: projectDir })
    await on.manager.sendMessage(first.id, LONG)
    expect(on.captured[0].additionalDirectories).toContain(webDir)
    on.manager.dispose()

    const none = claudeManager(null)
    const third = store.createThread({ projectRoot: projectDir })
    await none.manager.sendMessage(third.id, LONG)
    expect(store.getThreadRoots(third.id)).toEqual([])
    none.manager.dispose()
  })

  it('Claude: an attach mid-thread widens the NEXT turn (resumed), a detach narrows it', async () => {
    const { manager, captured, queries } = claudeManager(null)
    const thread = store.createThread({ projectRoot: projectDir })
    await manager.sendMessage(thread.id, 'first')
    await finishClaudeTurn(queries[0], thread.id)
    expect(captured).toHaveLength(1)
    expect(captured[0].additionalDirectories?.includes(webDir) ?? false).toBe(false)

    // Nothing changed → the same session takes the next turn.
    await manager.sendMessage(thread.id, 'second')
    expect(captured).toHaveLength(1)
    await finishClaudeTurn(queries[0], thread.id)

    // Attach (the offer accepted / "+"): the next turn is a NEW session that
    // resumes the conversation with the wider folder set.
    store.setThreadRoots(thread.id, [webDir])
    await manager.sendMessage(thread.id, 'third')
    expect(captured).toHaveLength(2)
    expect(queries[0].close).toHaveBeenCalled()
    expect(captured[1].resume).toBe('sdk-1')
    expect(captured[1].additionalDirectories).toContain(webDir)
    await finishClaudeTurn(queries[1], thread.id)

    // Detach (a chip removed): the next turn no longer has that folder.
    store.setThreadRoots(thread.id, [])
    await manager.sendMessage(thread.id, 'fourth')
    expect(captured).toHaveLength(3)
    expect(captured[2].resume).toBe('sdk-1')
    expect(captured[2].additionalDirectories?.includes(webDir) ?? false).toBe(false)
    manager.dispose()
  })

  it('Claude: a checkout cut (or released) for an attached project mid-thread restarts the session on the next turn', async () => {
    const { manager, captured, queries } = claudeManager(null)
    const thread = store.createThread({ projectRoot: projectDir })
    store.setThreadRoots(thread.id, [webDir])
    await manager.sendMessage(thread.id, 'first')
    await finishClaudeTurn(queries[0], thread.id)
    expect(captured[0].additionalDirectories).toContain(webDir)

    // Same projects, but Frontend now has its own checkout for this thread.
    const checkout = join(tempDir, 'web-checkout')
    mkdirSync(checkout)
    store.setThreadRootWorktree(thread.id, webDir, { path: checkout, branch: 'flow/t', base: 'main' })
    await manager.sendMessage(thread.id, 'second')
    expect(captured).toHaveLength(2)
    expect(captured[1].additionalDirectories).toContain(checkout)
    await finishClaudeTurn(queries[1], thread.id)

    // Released again: back to the main tree on the next turn.
    store.setThreadRootWorktree(thread.id, webDir, null)
    await manager.sendMessage(thread.id, 'third')
    expect(captured).toHaveLength(3)
    expect(captured[2].additionalDirectories).toContain(webDir)
    expect(captured[2].additionalDirectories?.includes(checkout) ?? false).toBe(false)
    manager.dispose()
  })

  it('Claude: a change made while a turn runs waits for the turn to end', async () => {
    const { manager, captured, queries } = claudeManager(null)
    const thread = store.createThread({ projectRoot: projectDir })
    await manager.sendMessage(thread.id, 'first')
    // Still working — an interjection keeps the live session.
    store.setThreadRoots(thread.id, [webDir])
    await manager.sendMessage(thread.id, 'while working')
    expect(captured).toHaveLength(1)
    expect(queries[0].close).not.toHaveBeenCalled()
    await finishClaudeTurn(queries[0], thread.id)
    // Resting now — the next send picks the change up.
    await manager.sendMessage(thread.id, 'after')
    expect(captured).toHaveLength(2)
    expect(captured[1].additionalDirectories).toContain(webDir)
    manager.dispose()
  })

  it.each(['codex', 'copilot'] as const)('%s: an attach mid-thread widens the next turn\'s folders, a detach narrows them', async (provider) => {
    const starts: Array<{ opts: RuntimeStartOptions; callbacks: RuntimeCallbacks }> = []
    const sends: string[] = []
    const manager = new AgentManager(store, credentialsStub, broker, {
      queryFn: jest.fn(),
      titleGenerator: async () => null,
      resolveProviderFor: () => provider,
      codexRuntimeFactory: () => makeFakeRuntime(starts, sends),
      copilotRuntimeFactory: () => ({ ...makeFakeRuntime(starts, sends), id: 'copilot' }),
      isAttachableRoot: () => true,
    })
    const thread = store.createThread({ projectRoot: projectDir })
    const finish = (index: number): void => {
      starts[index].callbacks.onSessionId('codex-1')
      store.appendMessage(thread.id, 'assistant', 'done')
      starts[index].callbacks.onDone?.()
    }

    await manager.sendMessage(thread.id, 'first')
    finish(0)
    // Unchanged: the same runtime resumes in place.
    await manager.sendMessage(thread.id, 'second')
    expect(starts).toHaveLength(1)
    expect(sends).toEqual([expect.stringContaining('second')])
    finish(0)

    store.setThreadRoots(thread.id, [webDir])
    await manager.sendMessage(thread.id, 'third')
    expect(starts).toHaveLength(2)
    expect(starts[1].opts.resumeSessionId).toBe('codex-1')
    expect(starts[1].opts.additionalRoots).toContain(webDir)
    expect(starts[1].opts.writableRoots).toContain(webDir)
    finish(1)

    store.setThreadRoots(thread.id, [])
    await manager.sendMessage(thread.id, 'fourth')
    expect(starts).toHaveLength(3)
    expect(starts[2].opts.additionalRoots).not.toContain(webDir)
    expect(starts[2].opts.writableRoots ?? []).not.toContain(webDir)
    manager.dispose()
  })

  it('a later send asks for an OFFER and never attaches', async () => {
    const offers: unknown[] = []
    const clock = { now: 1_000_000 }
    const { manager, captured, queries } = claudeManager(
      gateDeps({
        askModel: async ({ prompt }) =>
          prompt.includes('"attached"') ? '{"primary":"api","attached":[]}' : '{"needs":"docs","reason":"It edits the docs."}',
        announceOffer: (event) => offers.push(event),
        now: () => clock.now,
      }),
    )
    const thread = store.createThread({ projectRoot: projectDir })
    await manager.sendMessage(thread.id, LONG)
    await finishClaudeTurn(queries[0], thread.id)
    expect(store.getThreadRoots(thread.id)).toEqual([])
    // Rate limit: the first send counted as a check, so the next sends ask nothing…
    for (let i = 0; i < 3; i += 1) {
      await manager.sendMessage(thread.id, LONG)
      await finishClaudeTurn(queries[0], thread.id)
    }
    await flush()
    expect(offers).toEqual([])
    // …until enough time has passed too.
    clock.now += 10 * 60_000
    await manager.sendMessage(thread.id, LONG)
    await finishClaudeTurn(queries[0], thread.id)
    await flush()
    expect(offers).toEqual([{ threadId: thread.id, project: { root: docsDir, name: 'Docs' }, reason: 'It edits the docs.' }])
    expect(store.getThreadRoots(thread.id)).toEqual([])
    expect(captured).toHaveLength(1)
    manager.dispose()
  })
})
