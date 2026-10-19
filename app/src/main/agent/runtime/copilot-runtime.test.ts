// CopilotRuntime with a FAKE child process — no real `copilot`, no network.
// Event lines are the real shapes from a live `copilot --output-format json` run.

import { EventEmitter } from 'events'
import type { spawn } from 'child_process'
import type { AgentStreamEvent } from '../../../shared/ipc-contract'
import type { RuntimeCallbacks, RuntimeStartOptions } from './agent-runtime'
import { buildCopilotArgs, COPILOT_CAPABILITIES, CopilotRuntime } from './copilot-runtime'

const NOW = '2026-08-18T00:00:00.000Z'
const SESSION = 'd5c5a131-8bb7-491b-b30c-27360dff52a9'

const LINE_MSG_START = JSON.stringify({
  type: 'assistant.message_start',
  data: { messageId: 'm1' },
})
const LINE_RESULT = JSON.stringify({ type: 'result', sessionId: SESSION, exitCode: 0 })

interface FakeChild extends EventEmitter {
  stdout: EventEmitter
  stderr: EventEmitter
  kill: jest.Mock
}

function makeFakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.kill = jest.fn()
  return child
}

function makeRuntime() {
  const spawns: { cmd: string; args: string[]; child: FakeChild }[] = []
  const spawnFn = ((cmd: string, args: string[]) => {
    const child = makeFakeChild()
    spawns.push({ cmd, args, child })
    return child
  }) as unknown as typeof spawn
  const runtime = new CopilotRuntime({ spawnFn, execPath: 'copilot', now: () => NOW })
  return { runtime, spawns }
}

function startOptions(over: Partial<RuntimeStartOptions> = {}): RuntimeStartOptions {
  return {
    threadId: 'plan-flow-thread-1',
    cwd: '/work/proj',
    additionalRoots: [],
    prompt: 'make a change',
    abortSignal: new AbortController().signal,
    ...over,
  }
}

function callbacks(over: Partial<RuntimeCallbacks> = {}) {
  const events: AgentStreamEvent[] = []
  const sessionIds: string[] = []
  const done = jest.fn()
  const base: RuntimeCallbacks = {
    onEvent: (e) => events.push(e),
    onSessionId: (id) => sessionIds.push(id),
    onDone: done,
    ...over,
  }
  return Object.assign(base, { events, sessionIds, done })
}

describe('CopilotRuntime — identity & capabilities', () => {
  it('is the "copilot" runtime with NATIVE containment and instance-spawn sub-agents', () => {
    const { runtime } = makeRuntime()
    expect(runtime.id).toBe('copilot')
    expect(runtime.capabilities).toEqual(COPILOT_CAPABILITIES)
    expect(runtime.capabilities.containment).toBe('native')
    expect(runtime.capabilities.subAgents).toBe('instance-spawn')
  })
})

describe('buildCopilotArgs', () => {
  it('builds a contained headless turn: -p prompt, json, cwd, allow-all-tools, NO allow-all-paths', () => {
    const args = buildCopilotArgs('do it', { resumeId: null, cwd: '/w', additionalRoots: [] })
    expect(args).toEqual(['-p', 'do it', '--output-format', 'json', '-C', '/w', '--allow-all-tools', '--no-color'])
    expect(args).not.toContain('--allow-all-paths')
  })

  it('widens containment with --add-dir per additional root', () => {
    const args = buildCopilotArgs('x', { resumeId: null, cwd: '/w', additionalRoots: ['/a', '/b'] })
    expect(args.filter((a, i) => a === '/a' && args[i - 1] === '--add-dir')).toHaveLength(1)
    expect(args).toContain('/b')
  })

  it('adds --model and --resume when provided', () => {
    const args = buildCopilotArgs('x', { resumeId: SESSION, cwd: '/w', additionalRoots: [], model: 'gpt-5.4' })
    expect(args).toContain('--model')
    expect(args).toContain('gpt-5.4')
    expect(args[args.length - 2]).toBe('--resume')
    expect(args[args.length - 1]).toBe(SESSION)
  })
})

describe('CopilotRuntime — turn lifecycle', () => {
  it('spawns a fresh copilot turn with the prompt on -p (no stdin)', () => {
    const { runtime, spawns } = makeRuntime()
    runtime.start(startOptions({ cwd: '/work/proj', prompt: 'hello copilot' }), callbacks())
    expect(spawns).toHaveLength(1)
    expect(spawns[0].cmd).toBe('copilot')
    expect(spawns[0].args.slice(0, 4)).toEqual(['-p', 'hello copilot', '--output-format', 'json'])
  })

  it('captures the session id from the terminal result event and stamps events with the plan-flow thread id', () => {
    const { runtime, spawns } = makeRuntime()
    const cb = callbacks()
    const session = runtime.start(startOptions({ threadId: 'plan-flow-thread-1' }), cb)
    spawns[0].child.stdout.emit('data', `${LINE_MSG_START}\n${LINE_RESULT}\n`)
    expect(cb.sessionIds).toEqual([SESSION])
    expect(session.sessionId).toBe(SESSION)
    for (const event of cb.events) {
      expect((event as { threadId?: string }).threadId).toBe('plan-flow-thread-1')
    }
  })

  it('fires onDone when the child closes', () => {
    const { runtime, spawns } = makeRuntime()
    const cb = callbacks()
    runtime.start(startOptions(), cb)
    spawns[0].child.emit('close', 0)
    expect(cb.done).toHaveBeenCalledTimes(1)
  })
})

describe('CopilotRuntime — session handle', () => {
  it('send() resumes the known session (--resume <id>) as a fresh turn with the follow-up on -p', () => {
    const { runtime, spawns } = makeRuntime()
    const session = runtime.start(startOptions(), callbacks())
    spawns[0].child.stdout.emit('data', `${LINE_RESULT}\n`)
    session.send('next thing')
    expect(spawns).toHaveLength(2)
    expect(spawns[1].args).toContain('--resume')
    expect(spawns[1].args).toContain(SESSION)
    expect(spawns[1].args.slice(0, 2)).toEqual(['-p', 'next thing'])
  })

  it('interrupt kills the in-flight turn but keeps the session (a later send resumes)', () => {
    const { runtime, spawns } = makeRuntime()
    const session = runtime.start(startOptions(), callbacks())
    spawns[0].child.stdout.emit('data', `${LINE_RESULT}\n`)
    session.interrupt()
    expect(spawns[0].child.kill).toHaveBeenCalledWith('SIGKILL')
    // The session survives — a follow-up resumes the rollout.
    session.send('again')
    expect(spawns).toHaveLength(2)
    expect(spawns[1].args).toContain(SESSION)
  })

  it('dispose kills the child and is idempotent', () => {
    const { runtime, spawns } = makeRuntime()
    const session = runtime.start(startOptions(), callbacks())
    session.dispose()
    session.dispose()
    expect(spawns[0].child.kill).toHaveBeenCalledTimes(1)
  })
})

describe('CopilotRuntime — abort forwarding', () => {
  it('aborting the coordinator signal kills the running child', () => {
    const external = new AbortController()
    const { runtime, spawns } = makeRuntime()
    runtime.start(startOptions({ abortSignal: external.signal }), callbacks())
    external.abort()
    expect(spawns[0].child.kill).toHaveBeenCalledWith('SIGKILL')
  })
})

describe('a failed turn is not a silent turn', () => {
  it('surfaces what the tool printed when it exits non-zero', () => {
    // The live bug: `--model opus` under Copilot printed
    //   Error: Model "opus" from --model flag is not available.
    // on stdout as plain text, JSON.parse dropped it, and close() went straight
    // to onDone — so a sent message produced NOTHING on screen.
    const { runtime, spawns } = makeRuntime()
    const cb = callbacks()
    runtime.start(startOptions(), cb)
    const child = spawns[0]!.child
    child.stdout.emit('data', 'Error: Model "opus" from --model flag is not available.\n')
    child.emit('close', 1)
    const error = cb.events.find((event) => event.kind === 'error')
    expect(error).toBeDefined()
    expect(error && 'message' in error ? error.message : '').toContain('not available')
  })

  it('surfaces stderr, and a spawn that never started', () => {
    const { runtime, spawns } = makeRuntime()
    const cb = callbacks()
    runtime.start(startOptions(), cb)
    const child = spawns[0]!.child
    child.stderr.emit('data', 'copilot: something went wrong\n')
    child.emit('close', 2)
    expect(cb.events.some((event) => event.kind === 'error')).toBe(true)

    const second = makeRuntime()
    const cb2 = callbacks()
    second.runtime.start(startOptions(), cb2)
    second.spawns[0]!.child.emit('error', new Error('spawn copilot ENOENT'))
    expect(cb2.events.some((event) => event.kind === 'error')).toBe(true)
  })

  it('says nothing extra when the turn succeeded', () => {
    const { runtime, spawns } = makeRuntime()
    const cb = callbacks()
    runtime.start(startOptions(), cb)
    const child = spawns[0]!.child
    child.stdout.emit('data', 'some banner line\n')
    child.emit('close', 0)
    expect(cb.events.some((event) => event.kind === 'error')).toBe(false)
  })
})

describe('a refused credential inside the protocol', () => {
  it('is caught even though it arrives as valid JSON', () => {
    // Measured on Codex, and the same shape applies here: the 401 rides in a
    // JSON event, so a scan of only the non-JSON lines misses it entirely —
    // and the settings panel goes on showing a green tick.
    const { runtime, spawns } = makeRuntime()
    const cb = callbacks()
    runtime.start(startOptions(), cb)
    const child = spawns[0]!.child
    child.stdout.emit(
      'data',
      JSON.stringify({ type: 'background', message: 'Failed to refresh token: 401 Unauthorized' }) + '\n',
    )
    child.emit('close', 1)
    const error = cb.events.find((event) => event.kind === 'error')
    expect(error && 'message' in error ? error.message : '').toContain('rejected the sign-in')
  })
})
