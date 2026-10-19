// ClaudeRuntime is exercised with a MOCK SDK query (a scripted async stream) and
// a fake translator — no real @anthropic-ai/claude-agent-sdk, no Electron. The
// runtime imports the SDK type-only, so nothing loads it at runtime here.

import type { Options, Query, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import type { AgentStreamEvent } from '../../../shared/ipc-contract'
import type { RuntimeCallbacks, RuntimeStartOptions } from './agent-runtime'
import { CLAUDE_CAPABILITIES, ClaudeRuntime, type ClaudeRuntimeDeps } from './claude-runtime'

interface Captured {
  prompt: AsyncIterable<SDKUserMessage>
  options?: Options
}

function makeRuntime(opts: {
  messages?: SDKMessage[]
  translate?: ClaudeRuntimeDeps['translate']
  providerOptions?: ClaudeRuntimeDeps['providerOptions']
} = {}) {
  const captured: Captured[] = []
  const setModel = jest.fn()
  const close = jest.fn()
  const msgs = opts.messages ?? []
  const query = {
    async *[Symbol.asyncIterator](): AsyncGenerator<SDKMessage> {
      for (const m of msgs) yield m
    },
    setModel,
    close,
    interrupt: jest.fn(),
  } as unknown as Query
  const queryFn: ClaudeRuntimeDeps['queryFn'] = (params) => {
    captured.push(params)
    return query
  }
  const deps: ClaudeRuntimeDeps = {
    queryFn,
    translate: opts.translate ?? (() => {}),
    ...(opts.providerOptions ? { providerOptions: opts.providerOptions } : {}),
  }
  return { runtime: new ClaudeRuntime(deps), captured, setModel, close }
}

function startOptions(over: Partial<RuntimeStartOptions> = {}): RuntimeStartOptions {
  return {
    threadId: 't1',
    cwd: '/work/proj',
    additionalRoots: [],
    prompt: 'do the thing',
    abortSignal: new AbortController().signal,
    ...over,
  }
}

function callbacks(over: Partial<RuntimeCallbacks> = {}) {
  const events: AgentStreamEvent[] = []
  const sessionIds: string[] = []
  const base: RuntimeCallbacks = {
    onEvent: (e) => events.push(e),
    onSessionId: (id) => sessionIds.push(id),
    ...over,
  }
  return Object.assign(base, { events, sessionIds })
}

/** Let the background stream-consumer drain the scripted messages. */
async function drain(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await new Promise((r) => setImmediate(r))
}

const ctx = (toolUseID?: string): any => ({
  signal: new AbortController().signal,
  ...(toolUseID ? { toolUseID } : {}),
})

describe('ClaudeRuntime — identity & capabilities', () => {
  it('is the "claude" runtime with native containment and full productivity capabilities', () => {
    const { runtime } = makeRuntime()
    expect(runtime.id).toBe('claude')
    expect(runtime.capabilities).toEqual(CLAUDE_CAPABILITIES)
    expect(runtime.capabilities.containment).toBe('native')
    expect(runtime.capabilities.toolApproval).toBe('per-tool')
    expect(runtime.capabilities.subAgents).toBe('native')
    expect(runtime.capabilities.resumeHandle).toBe(true)
    expect(runtime.capabilities.modelSelection).toBe(true)
  })
})

describe('ClaudeRuntime — SDK option assembly', () => {
  it('builds default options and seeds the first user turn onto the prompt stream', async () => {
    const { runtime, captured } = makeRuntime()
    runtime.start(startOptions({ cwd: '/work/proj', prompt: 'hello' }), callbacks())
    expect(captured).toHaveLength(1)
    const options = captured[0].options!
    expect(options.cwd).toBe('/work/proj')
    expect(options.includePartialMessages).toBe(true)
    expect(options.permissionMode).toBe('default')
    expect(options.abortController).toBeInstanceOf(AbortController)
    // Omitted-when-empty keeps a single-root session byte-identical to before.
    expect('additionalDirectories' in options).toBe(false)
    expect('model' in options).toBe(false)
    expect('resume' in options).toBe(false)
    expect('canUseTool' in options).toBe(false)
    const first: any = await captured[0].prompt[Symbol.asyncIterator]().next()
    expect(first.done).toBe(false)
    expect(first.value.message).toEqual({ role: 'user', content: 'hello' })
  })

  it('threads additionalDirectories, model, and resume when provided', () => {
    const { runtime, captured } = makeRuntime()
    runtime.start(
      startOptions({
        additionalRoots: ['/work/extra', '/vault/flow'],
        model: 'opus',
        resumeSessionId: 'sess-123',
      }),
      callbacks(),
    )
    const options = captured[0].options!
    expect(options.additionalDirectories).toEqual(['/work/extra', '/vault/flow'])
    expect(options.model).toBe('opus')
    expect(options.resume).toBe('sess-123')
  })

  it('omits resume for a null resumeSessionId (fresh session)', () => {
    const { runtime, captured } = makeRuntime()
    runtime.start(startOptions({ resumeSessionId: null }), callbacks())
    expect('resume' in captured[0].options!).toBe(false)
  })

  it('merges providerOptions over the base — coordinator-owned options win', () => {
    const providerOptions: ClaudeRuntimeDeps['providerOptions'] = () => ({
      permissionMode: 'bypassPermissions',
      env: { PATH: '/shimmed' },
    })
    const { runtime, captured } = makeRuntime({ providerOptions })
    runtime.start(startOptions(), callbacks())
    const options = captured[0].options!
    expect(options.permissionMode).toBe('bypassPermissions')
    expect((options.env as Record<string, string>).PATH).toBe('/shimmed')
    expect(options.cwd).toBe('/work/proj')
  })
})

describe('ClaudeRuntime — canUseTool bridge (containment)', () => {
  it('wires canUseTool only when the coordinator supplies an approval callback', () => {
    const { runtime, captured } = makeRuntime()
    runtime.start(startOptions(), callbacks())
    expect('canUseTool' in captured[0].options!).toBe(false)

    const { runtime: r2, captured: c2 } = makeRuntime()
    r2.start(startOptions(), callbacks({ canUseTool: async () => ({ behavior: 'allow' }) }))
    expect(typeof c2[0].options!.canUseTool).toBe('function')
  })

  it('bridges allow to a PermissionResult that carries updatedInput (#10) even with no rewrite', async () => {
    const { runtime, captured } = makeRuntime()
    runtime.start(startOptions(), callbacks({ canUseTool: async () => ({ behavior: 'allow' }) }))
    const sdkCanUse = captured[0].options!.canUseTool!
    const result: any = await sdkCanUse('Bash', { command: 'ls' }, ctx('tu-1'))
    expect(result).toEqual({ behavior: 'allow', updatedInput: { command: 'ls' }, toolUseID: 'tu-1' })
  })

  it('passes a verdict rewrite through as updatedInput', async () => {
    const { runtime, captured } = makeRuntime()
    runtime.start(
      startOptions(),
      callbacks({ canUseTool: async () => ({ behavior: 'allow', updatedInput: { command: 'ls -a' } }) }),
    )
    const sdkCanUse = captured[0].options!.canUseTool!
    const result: any = await sdkCanUse('Bash', { command: 'ls' }, ctx('t'))
    expect(result.behavior).toBe('allow')
    expect(result.updatedInput).toEqual({ command: 'ls -a' })
  })

  it('bridges deny to a PermissionResult deny carrying the message', async () => {
    const { runtime, captured } = makeRuntime()
    runtime.start(
      startOptions(),
      callbacks({ canUseTool: async () => ({ behavior: 'deny', message: 'escapes root' }) }),
    )
    const sdkCanUse = captured[0].options!.canUseTool!
    const result: any = await sdkCanUse('Write', { file_path: '/etc/x' }, ctx())
    expect(result).toEqual({ behavior: 'deny', message: 'escapes root' })
  })
})

describe('ClaudeRuntime — stream consumption', () => {
  it('runs the injected translator per SDK message and surfaces the session id once', async () => {
    const messages = [{ type: 'a' }, { type: 'b' }] as unknown as SDKMessage[]
    const seen: SDKMessage[] = []
    const translate: ClaudeRuntimeDeps['translate'] = (m, emit, onSessionId) => {
      seen.push(m)
      emit({ kind: 'status', threadId: 't1', status: 'working' } as unknown as AgentStreamEvent)
      onSessionId('sess-xyz')
    }
    const { runtime } = makeRuntime({ messages, translate })
    const cb = callbacks()
    runtime.start(startOptions(), cb)
    await drain()
    expect(seen).toHaveLength(2)
    expect(cb.events).toHaveLength(2)
    // Deduped despite the translator reporting the id on every message.
    expect(cb.sessionIds).toEqual(['sess-xyz'])
  })

  it('fires onDone exactly once when the stream ends (headless completion signal)', async () => {
    const messages = [{ type: 'a' }, { type: 'result' }] as unknown as SDKMessage[]
    const done = jest.fn()
    const { runtime } = makeRuntime({ messages })
    runtime.start(startOptions(), callbacks({ onDone: done }))
    await drain()
    expect(done).toHaveBeenCalledTimes(1)
  })
})

describe('ClaudeRuntime — session handle', () => {
  it('exposes the session id through the handle after the translator reports it', async () => {
    const messages = [{ type: 'init' }] as unknown as SDKMessage[]
    const translate: ClaudeRuntimeDeps['translate'] = (_m, _e, onSessionId) => onSessionId('sess-42')
    const { runtime } = makeRuntime({ messages, translate })
    const session = runtime.start(startOptions(), callbacks())
    expect(session.sessionId).toBeNull()
    await drain()
    expect(session.sessionId).toBe('sess-42')
  })

  it('send pushes a follow-up user turn after the seeded first turn', async () => {
    const { runtime, captured } = makeRuntime()
    const session = runtime.start(startOptions({ prompt: 'first' }), callbacks())
    session.send('second')
    const iter = captured[0].prompt[Symbol.asyncIterator]()
    expect(((await iter.next()).value as any).message.content).toBe('first')
    expect(((await iter.next()).value as any).message.content).toBe('second')
  })

  it('setModel forwards to the SDK query', () => {
    const { runtime, setModel } = makeRuntime()
    const session = runtime.start(startOptions(), callbacks())
    session.setModel('sonnet')
    expect(setModel).toHaveBeenCalledWith('sonnet')
  })

  it('interrupt calls query.interrupt without disposing the session', () => {
    const interrupt = jest.fn()
    const query = {
      async *[Symbol.asyncIterator](): AsyncGenerator<SDKMessage> {},
      setModel: jest.fn(),
      close: jest.fn(),
      interrupt,
    } as unknown as Query
    const captured: Captured[] = []
    const runtime = new ClaudeRuntime({
      queryFn: (params) => {
        captured.push(params)
        return query
      },
      translate: () => {},
    })
    const session = runtime.start(startOptions(), callbacks())
    session.interrupt()
    expect(interrupt).toHaveBeenCalledTimes(1)
  })

  it('dispose ends input, aborts the controller, closes the query, and is idempotent', () => {
    const { runtime, captured, close } = makeRuntime()
    const session = runtime.start(startOptions(), callbacks())
    const ac = captured[0].options!.abortController!
    session.dispose()
    expect(ac.signal.aborted).toBe(true)
    expect(close).toHaveBeenCalledTimes(1)
    session.dispose()
    expect(close).toHaveBeenCalledTimes(1)
  })
})

describe('ClaudeRuntime — abort forwarding', () => {
  it('forwards the coordinator abort signal to the SDK abort controller', () => {
    const external = new AbortController()
    const { runtime, captured } = makeRuntime()
    runtime.start(startOptions({ abortSignal: external.signal }), callbacks())
    const ac = captured[0].options!.abortController!
    expect(ac.signal.aborted).toBe(false)
    external.abort()
    expect(ac.signal.aborted).toBe(true)
  })

  it('a pre-aborted coordinator signal starts the SDK controller already aborted', () => {
    const external = new AbortController()
    external.abort()
    const { runtime, captured } = makeRuntime()
    runtime.start(startOptions({ abortSignal: external.signal }), callbacks())
    expect(captured[0].options!.abortController!.signal.aborted).toBe(true)
  })
})
