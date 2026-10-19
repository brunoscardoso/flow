// Where the agents read actually RUNS (review finding H2).
//
// A file of its own, because the mocks are file-wide and deliberately harsh:
// `child_process.spawn` is replaced outright so nothing here can reach a real
// `claude` even by mistake, and the CLI host is a stub whose answers are
// scripted. The sibling suite keeps its own rule — every call injects `spawnFn`
// — and this one keeps the complementary one: nothing injects it, because what
// is on trial is precisely what happens when nobody does.

import { EventEmitter } from 'events'

jest.mock('../cli-host/client', () => ({ runInCliHost: jest.fn(() => null) }))
jest.mock('child_process', () => ({ spawn: jest.fn() }))

import { spawn } from 'child_process'

import { readRunsInFlight } from './background-agent'
import { runInCliHost } from '../cli-host/client'

const hosted = runInCliHost as unknown as jest.Mock
const spawned = spawn as unknown as jest.Mock

const CLAUDE_BIN = '/fake/claude'
const ROOT = '/fake/project'
const AGENTS = '[{"kind":"background","sessionId":"s-1","id":"a1","name":"loop fix","state":"running"}]'

/** A child that answers with one transcript, for the fallback path only. */
function fakeChild(stdout: string): unknown {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter
    stderr: EventEmitter
    kill: () => void
  }
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.kill = () => undefined
  setImmediate(() => {
    child.stdout.emit('data', stdout)
    child.emit('close', 0)
  })
  return child
}

beforeEach(() => {
  hosted.mockReset()
  spawned.mockReset()
  hosted.mockReturnValue(null)
  spawned.mockImplementation(() => fakeChild(AGENTS))
})

describe('the agents read runs in the CLI host, not on main', () => {
  it('sends the read to the host, with the binary and argv unchanged', async () => {
    // Every other main-process CLI runner — the provisioner, learn sessions,
    // git-manager and loops-handler itself — already routes through the host,
    // whose header says why: a sample of Electron's main process during a live
    // stall found 73% of its CPU inside `posix_spawn`. This module added a
    // spawn of a HEAVIER binary, on main, past the mitigation built for it.
    hosted.mockReturnValue(Promise.resolve({ ok: true, stdout: AGENTS, stderr: '' }))

    const runs = await readRunsInFlight(ROOT, { claudeBin: CLAUDE_BIN })

    expect(hosted).toHaveBeenCalledTimes(1)
    expect(hosted.mock.calls[0][0]).toMatchObject({
      execPath: CLAUDE_BIN,
      args: ['agents', '--cwd', ROOT, '--json'],
      cwd: ROOT,
      captureStdout: true,
    })
    // The host is where it ran, so main spawned nothing at all.
    expect(spawned).not.toHaveBeenCalled()
    expect(runs.known && runs.runs.map((run) => run.sessionId)).toEqual(['s-1'])
  })

  it('hands the host this process’s environment and adds nothing to it', async () => {
    // The bundled-CLI runner adds ELECTRON_RUN_AS_NODE because the thing it
    // runs is a script for Electron's own Node. The Claude binary is not, so
    // the environment crosses unchanged — exactly as it did when this module
    // spawned the child itself.
    hosted.mockReturnValue(Promise.resolve({ ok: true, stdout: AGENTS, stderr: '' }))
    await readRunsInFlight(ROOT, { claudeBin: CLAUDE_BIN })
    expect(hosted.mock.calls[0][0].env).toEqual({ ...process.env })
  })

  it('spawns here when the host is unavailable — a speed fix loses no feature', async () => {
    hosted.mockReturnValue(null)
    const runs = await readRunsInFlight(ROOT, { claudeBin: CLAUDE_BIN })
    expect(spawned).toHaveBeenCalledTimes(1)
    expect(spawned.mock.calls[0][1]).toEqual(['agents', '--cwd', ROOT, '--json'])
    expect(runs.known && runs.runs.map((run) => run.sessionId)).toEqual(['s-1'])
  })

  it('spawns here when the host died mid-request, rather than reporting nothing', async () => {
    hosted.mockReturnValue(
      Promise.resolve({ ok: false, stdout: '', stderr: '', error: 'cli host exited' }),
    )
    const runs = await readRunsInFlight(ROOT, { claudeBin: CLAUDE_BIN })
    expect(spawned).toHaveBeenCalledTimes(1)
    expect(runs.known && runs.runs.map((run) => run.sessionId)).toEqual(['s-1'])
  })

  it('keeps a host timeout its own answer, not a generic failure', async () => {
    // The host enforces the budget itself and reports it by that name; a reader
    // needs "it took too long" rather than "it could not say".
    hosted.mockReturnValue(
      Promise.resolve({ ok: false, stdout: '', stderr: '', error: 'timed out' }),
    )
    const runs = await readRunsInFlight(ROOT, { claudeBin: CLAUDE_BIN })
    expect(spawned).not.toHaveBeenCalled()
    expect(runs.known).toBe(false)
    expect(!runs.known && runs.reason).toContain('too long')
  })

  it('reports a non-zero run as unreadable rather than as an empty world', async () => {
    hosted.mockReturnValue(Promise.resolve({ ok: false, stdout: '', stderr: 'nope' }))
    const runs = await readRunsInFlight(ROOT, { claudeBin: CLAUDE_BIN })
    expect(runs.known).toBe(false)
  })

  it('NEVER reaches the host when a test injected its own spawn', async () => {
    // The rule that stops a real `claude --bg` from ever running in a suite:
    // an injected spawn is the one case that must still run in-process, and
    // the host must not become a way around it.
    const calls: string[][] = []
    const injected = (_bin: string, argv: string[]): unknown => {
      calls.push(argv)
      return fakeChild(AGENTS)
    }
    await readRunsInFlight(ROOT, { claudeBin: CLAUDE_BIN, spawnFn: injected as never })
    expect(hosted).not.toHaveBeenCalled()
    expect(spawned).not.toHaveBeenCalled()
    expect(calls).toEqual([['agents', '--cwd', ROOT, '--json']])
  })
})
