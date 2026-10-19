// CodexRuntime is exercised with a FAKE child process (an EventEmitter with a
// mock stdin) — no real `codex` binary, no network. The event shapes emitted
// below are the real ones captured from a live `codex exec --json` run (mirrors
// codex-events.test.ts).

import { EventEmitter } from 'events'
import type { spawn } from 'child_process'
import type { AgentStreamEvent } from '../../../shared/ipc-contract'
import type { RuntimeCallbacks, RuntimeStartOptions } from './agent-runtime'
import { buildCodexArgs, CODEX_CAPABILITIES, CodexRuntime } from './codex-runtime'
import { CODEX_WRITABLE_ROOTS_NOTICE, CodexWritableRootsSupport } from '../flow-link-roots'

const NOW = '2026-08-18T00:00:00.000Z'
const SESSION = '01a01277-151c-7bc3-9d2e-b530e6fdb35b'

const LINE_THREAD_STARTED = JSON.stringify({ type: 'thread.started', thread_id: SESSION })
const LINE_AGENT_MSG = JSON.stringify({
  type: 'item.completed',
  item: { id: 'item_0', type: 'agent_message', text: 'done.' },
})

interface FakeChild extends EventEmitter {
  stdout: EventEmitter
  stderr: EventEmitter
  stdin: { write: jest.Mock; end: jest.Mock }
  kill: jest.Mock
}

function makeFakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.stdin = { write: jest.fn(), end: jest.fn() }
  child.kill = jest.fn()
  return child
}

function makeRuntime(writableRootsSupport = new CodexWritableRootsSupport()) {
  const spawns: { cmd: string; args: string[]; child: FakeChild }[] = []
  const spawnFn = ((cmd: string, args: string[]) => {
    const child = makeFakeChild()
    spawns.push({ cmd, args, child })
    return child
  }) as unknown as typeof spawn
  const runtime = new CodexRuntime({ spawnFn, execPath: 'codex', now: () => NOW, writableRootsSupport })
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

describe('CodexRuntime — identity & capabilities', () => {
  it('is the "codex" runtime with NATIVE containment and instance-spawn sub-agents', () => {
    const { runtime } = makeRuntime()
    expect(runtime.id).toBe('codex')
    expect(runtime.capabilities).toEqual(CODEX_CAPABILITIES)
    expect(runtime.capabilities.containment).toBe('native')
    expect(runtime.capabilities.toolApproval).toBe('on-request')
    expect(runtime.capabilities.subAgents).toBe('instance-spawn')
    expect(runtime.capabilities.resumeHandle).toBe(true)
  })
})

describe('buildCodexArgs', () => {
  it('builds a fresh exec turn (prompt read from stdin, no positional)', () => {
    expect(buildCodexArgs({ resumeId: null, cwd: '/work/proj' })).toEqual([
      'exec', '--json', '-s', 'workspace-write', '-C', '/work/proj', '--skip-git-repo-check',
    ])
  })

  it('adds -m for a model', () => {
    expect(buildCodexArgs({ resumeId: null, cwd: '/w', model: 'o3' })).toContain('-m')
    expect(buildCodexArgs({ resumeId: null, cwd: '/w', model: 'o3' })).toContain('o3')
  })

  it('builds a resume turn with the session id and a `-` stdin PROMPT positional', () => {
    const args = buildCodexArgs({ resumeId: SESSION, cwd: '/w' })
    expect(args.slice(0, 2)).toEqual(['exec', 'resume'])
    expect(args).toContain(SESSION)
    expect(args[args.length - 1]).toBe('-')
  })
})

describe('CodexRuntime — turn lifecycle', () => {
  it('spawns a fresh codex exec turn and writes the prompt to stdin', () => {
    const { runtime, spawns } = makeRuntime()
    runtime.start(startOptions({ cwd: '/work/proj', prompt: 'hello codex' }), callbacks())
    expect(spawns).toHaveLength(1)
    expect(spawns[0].cmd).toBe('codex')
    expect(spawns[0].args).toEqual([
      'exec', '--json', '-s', 'workspace-write', '-C', '/work/proj', '--skip-git-repo-check',
    ])
    expect(spawns[0].child.stdin.write).toHaveBeenCalledWith('hello codex')
    expect(spawns[0].child.stdin.end).toHaveBeenCalledTimes(1)
  })

  it('captures the codex session id from thread.started and stamps events with the plan-flow thread id', () => {
    const { runtime, spawns } = makeRuntime()
    const cb = callbacks()
    const session = runtime.start(startOptions({ threadId: 'plan-flow-thread-1' }), cb)
    const { child } = spawns[0]
    child.stdout.emit('data', `${LINE_THREAD_STARTED}\n${LINE_AGENT_MSG}\n`)
    expect(cb.sessionIds).toEqual([SESSION])
    expect(session.sessionId).toBe(SESSION)
    expect(cb.events.length).toBeGreaterThan(0)
    // Normalized events carry the PLAN-FLOW thread id, not the codex session id.
    for (const event of cb.events) {
      expect((event as { threadId?: string }).threadId).toBe('plan-flow-thread-1')
    }
  })

  it('fires onDone when the child closes (turn complete)', () => {
    const { runtime, spawns } = makeRuntime()
    const cb = callbacks()
    runtime.start(startOptions(), cb)
    spawns[0].child.emit('close', 0)
    expect(cb.done).toHaveBeenCalledTimes(1)
  })

  it('buffers a JSON line split across chunks and parses a trailing unterminated line on close', () => {
    const { runtime, spawns } = makeRuntime()
    const cb = callbacks()
    const session = runtime.start(startOptions(), cb)
    const { child } = spawns[0]
    const half = LINE_THREAD_STARTED.slice(0, 20)
    const rest = LINE_THREAD_STARTED.slice(20)
    child.stdout.emit('data', half) // no newline yet
    expect(session.sessionId).toBeNull()
    child.stdout.emit('data', `${rest}\n`) // completes the line
    expect(session.sessionId).toBe(SESSION)
    // A final line with no trailing newline is flushed on close.
    child.stdout.emit('data', LINE_AGENT_MSG)
    const before = cb.events.length
    child.emit('close', 0)
    expect(cb.events.length).toBeGreaterThan(before)
  })

  it('fires onDone once on a spawn error too (never hangs)', () => {
    const { runtime, spawns } = makeRuntime()
    const cb = callbacks()
    runtime.start(startOptions(), cb)
    spawns[0].child.emit('error', new Error('ENOENT: codex not found'))
    expect(cb.done).toHaveBeenCalledTimes(1)
  })
})

describe('CodexRuntime — session handle', () => {
  it('send() resumes the known session as a fresh exec turn with the follow-up on stdin', () => {
    const { runtime, spawns } = makeRuntime()
    const session = runtime.start(startOptions(), callbacks())
    spawns[0].child.stdout.emit('data', `${LINE_THREAD_STARTED}\n`)
    session.send('and now do the next thing')
    expect(spawns).toHaveLength(2)
    const resume = spawns[1]
    expect(resume.args.slice(0, 2)).toEqual(['exec', 'resume'])
    expect(resume.args).toContain(SESSION)
    expect(resume.child.stdin.write).toHaveBeenCalledWith('and now do the next thing')
  })

  it('setModel applies to the NEXT turn only (a spawned turn is fixed)', () => {
    const { runtime, spawns } = makeRuntime()
    const session = runtime.start(startOptions({ model: undefined }), callbacks())
    expect(spawns[0].args).not.toContain('-m')
    spawns[0].child.stdout.emit('data', `${LINE_THREAD_STARTED}\n`)
    session.setModel('o3')
    session.send('follow-up')
    expect(spawns[1].args).toContain('-m')
    expect(spawns[1].args).toContain('o3')
  })

  it('interrupt kills the in-flight turn but keeps the session (a later send resumes)', () => {
    const { runtime, spawns } = makeRuntime()
    const session = runtime.start(startOptions(), callbacks())
    spawns[0].child.stdout.emit('data', `${LINE_THREAD_STARTED}\n`)
    session.interrupt()
    expect(spawns[0].child.kill).toHaveBeenCalledWith('SIGKILL')
    // The session is NOT disposed — a follow-up spawns a resume turn.
    session.send('continue')
    expect(spawns).toHaveLength(2)
    expect(spawns[1].args).toContain(SESSION)
  })

  it('dispose kills the child and is idempotent', () => {
    const { runtime, spawns } = makeRuntime()
    const session = runtime.start(startOptions(), callbacks())
    session.dispose()
    expect(spawns[0].child.kill).toHaveBeenCalledWith('SIGKILL')
    session.dispose()
    expect(spawns[0].child.kill).toHaveBeenCalledTimes(1)
  })
})

describe('CodexRuntime — abort forwarding', () => {
  it('aborting the coordinator signal kills the running child', () => {
    const external = new AbortController()
    const { runtime, spawns } = makeRuntime()
    runtime.start(startOptions({ abortSignal: external.signal }), callbacks())
    expect(spawns[0].child.kill).not.toHaveBeenCalled()
    external.abort()
    expect(spawns[0].child.kill).toHaveBeenCalledWith('SIGKILL')
  })

  it('a pre-aborted signal kills the child immediately', () => {
    const external = new AbortController()
    external.abort()
    const { runtime, spawns } = makeRuntime()
    runtime.start(startOptions({ abortSignal: external.signal }), callbacks())
    expect(spawns[0].child.kill).toHaveBeenCalledWith('SIGKILL')
  })
})

describe('the thread’s effort reaches Codex', () => {
  it('passes it as the reasoning-effort override', () => {
    const args = buildCodexArgs({ resumeId: null, cwd: '/w', effort: 'high' })
    const index = args.indexOf('-c')
    expect(index).toBeGreaterThan(-1)
    expect(args[index + 1]).toBe('model_reasoning_effort="high"')
  })

  it('says nothing when the thread has no effort', () => {
    expect(buildCodexArgs({ resumeId: null, cwd: '/w' })).not.toContain('-c')
  })

  it('un-breaks a config a given build cannot parse', () => {
    // Measured on a real machine: `model_reasoning_effort = "xhigh"` in
    // ~/.codex/config.toml makes EVERY headless run die before it starts —
    // "Failed to deserialize overridden config: unknown variant `xhigh`". A
    // `-c` override replaces the value before deserialization, and the same
    // binary with the same file then ran on gpt-5.1-codex-max.
    const args = buildCodexArgs({ resumeId: null, cwd: '/w', effort: 'medium' })
    expect(args.join(' ')).toContain('model_reasoning_effort="medium"')
  })
})

describe('the flow/ link target reaches Codex as a writable root', () => {
  const ROOTS = ['/vault/projects/proj/flow', '/work/other']
  /** The value following the writable-roots `-c`, or null when absent. */
  function writableRootsArg(args: string[]): string | null {
    const found = args.find((arg) => arg.startsWith('sandbox_workspace_write.writable_roots='))
    if (found === undefined) return null
    expect(args[args.indexOf(found) - 1]).toBe('-c')
    return found
  }
  const REJECTION =
    'ERROR codex_core::config: Failed to deserialize overridden config: invalid type: integer `5`, expected a sequence in `sandbox_workspace_write.writable_roots`'

  it('passes the roots as one escaped TOML array on a fresh turn and on a resume', () => {
    expect(writableRootsArg(buildCodexArgs({ resumeId: null, cwd: '/w', writableRoots: ROOTS }))).toBe(
      'sandbox_workspace_write.writable_roots=["/vault/projects/proj/flow", "/work/other"]',
    )
    const resume = buildCodexArgs({ resumeId: SESSION, cwd: '/w', writableRoots: ['/a "b"\\c'] })
    expect(writableRootsArg(resume)).toBe('sandbox_workspace_write.writable_roots=["/a \\"b\\"\\\\c"]')
    // The session id and the stdin positional stay last.
    expect(resume.slice(-2)).toEqual([SESSION, '-'])
  })

  it('omits the key when there is nothing to grant', () => {
    expect(writableRootsArg(buildCodexArgs({ resumeId: null, cwd: '/w' }))).toBeNull()
    expect(writableRootsArg(buildCodexArgs({ resumeId: null, cwd: '/w', writableRoots: ['rel'] }))).toBeNull()
  })

  it('a turn spawned with writable roots carries them', () => {
    const { runtime, spawns } = makeRuntime()
    runtime.start(startOptions({ writableRoots: ROOTS }), callbacks())
    expect(writableRootsArg(spawns[0].args)).not.toBeNull()
  })

  it('a Codex that rejects the key: the turn re-runs without it, says so once, and never passes it again', () => {
    const support = new CodexWritableRootsSupport()
    const { runtime, spawns } = makeRuntime(support)
    const notices: string[] = []
    const cb = callbacks({ onNotice: (text: string) => notices.push(text) })
    runtime.start(startOptions({ writableRoots: ROOTS }), cb)
    // The positive first: the first attempt DID pass the key.
    expect(writableRootsArg(spawns[0].args)).not.toBeNull()
    spawns[0].child.stderr.emit('data', REJECTION)
    spawns[0].child.emit('close', 1)

    // Re-run at once, same prompt, without the key — and no error card.
    expect(spawns).toHaveLength(2)
    expect(writableRootsArg(spawns[1].args)).toBeNull()
    expect(spawns[1].child.stdin.write).toHaveBeenCalledWith('make a change')
    expect(cb.events.filter((event) => event.kind === 'error')).toEqual([])
    expect(cb.done).not.toHaveBeenCalled()
    expect(notices).toEqual([CODEX_WRITABLE_ROOTS_NOTICE])
    expect(support.refuses('codex')).toBe(true)

    spawns[1].child.emit('close', 0)
    expect(cb.done).toHaveBeenCalledTimes(1)

    // A later turn of the same session, and a new session on the same Codex.
    const session = runtime.start(startOptions({ writableRoots: ROOTS }), cb)
    expect(writableRootsArg(spawns[2].args)).toBeNull()
    spawns[2].child.emit('close', 0)
    session.send('more')
    expect(spawns).toHaveLength(4)
    expect(writableRootsArg(spawns[3].args)).toBeNull()
    expect(notices).toHaveLength(1)
  })

  it('an unrelated failure is reported as before and does not mark the key refused', () => {
    const support = new CodexWritableRootsSupport()
    const { runtime, spawns } = makeRuntime(support)
    const cb = callbacks()
    runtime.start(startOptions({ writableRoots: ROOTS }), cb)
    spawns[0].child.stderr.emit('data', 'Error: model "gpt-x" is not available')
    spawns[0].child.emit('close', 1)
    expect(spawns).toHaveLength(1)
    expect(cb.events.some((event) => event.kind === 'error')).toBe(true)
    expect(support.refuses('codex')).toBe(false)
  })

  it('never retries after the turn produced anything — a session id or a tool already ran', () => {
    const support = new CodexWritableRootsSupport()
    const { runtime, spawns } = makeRuntime(support)
    const cb = callbacks()
    runtime.start(startOptions({ writableRoots: ROOTS }), cb)
    // The turn started for real: a session id and an event came back…
    spawns[0].child.stdout.emit('data', `${LINE_THREAD_STARTED}\n${LINE_AGENT_MSG}\n`)
    // …and only then something on stderr mentioned the key.
    spawns[0].child.stderr.emit('data', REJECTION)
    spawns[0].child.emit('close', 1)
    expect(spawns).toHaveLength(1)
    expect(support.refuses('codex')).toBe(false)
    expect(cb.done).toHaveBeenCalledTimes(1)
  })

  it('never retries when stdout merely mentions the key (a tool printing it), only on the config-parse phrase', () => {
    const support = new CodexWritableRootsSupport()
    const { runtime, spawns } = makeRuntime(support)
    const cb = callbacks()
    runtime.start(startOptions({ writableRoots: ROOTS }), cb)
    // A plain log line naming the key, without the config-parse failure.
    spawns[0].child.stderr.emit('data', 'warning: sandbox_workspace_write.writable_roots includes a missing folder')
    spawns[0].child.emit('close', 1)
    expect(spawns).toHaveLength(1)
    expect(support.refuses('codex')).toBe(false)
  })

  it('a turn without the key never retries, whatever the failure says', () => {
    const { runtime, spawns } = makeRuntime()
    const cb = callbacks()
    runtime.start(startOptions(), cb)
    expect(writableRootsArg(spawns[0].args)).toBeNull()
    spawns[0].child.stderr.emit('data', REJECTION)
    spawns[0].child.emit('close', 1)
    expect(spawns).toHaveLength(1)
    expect(cb.done).toHaveBeenCalledTimes(1)
  })
})
