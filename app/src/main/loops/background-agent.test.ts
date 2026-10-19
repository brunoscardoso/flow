import { EventEmitter } from 'events'

import {
  AGENTS_READ_TIMEOUT_MS,
  BACKGROUND_KIND,
  DISPATCH_TIMEOUT_MS,
  RunsInFlightCache,
  backgroundRuns,
  dispatchArgs,
  dispatchLoopRun,
  dispatchPrompt,
  extractJsonArray,
  parseAgentsOutput,
  readRunsInFlight,
  unknownRuns,
  type LoopRunRequest,
  type RunsInFlight,
} from './background-agent'

/**
 * NOTHING IN THIS FILE MAY START A RUN. Every test injects `spawnFn`, and the
 * loops in this repo point at a live GitHub queue — a single un-injected call
 * would file, claim or comment on real issues. The fake below records the argv
 * it was handed and answers with a scripted transcript; it never touches a
 * process, and `claudeBin` is a placeholder string that resolves to nothing.
 */
const CLAUDE_BIN = '/fake/claude'
const ROOT = '/fake/project'

interface FakeSpawn {
  spawnFn: any
  /** Every invocation's argv, in order. */
  calls: string[][]
  /** Every invocation's cwd, in order. */
  cwds: (string | undefined)[]
}

function fakeSpawn(
  out: {
    stdout?: string
    stderr?: string
    code?: number | null
    /** Emit an `error` event instead of closing — a process that never started. */
    error?: string
    /** Never settle, so the timeout is the only thing that can answer. */
    hang?: boolean
    /** Throw from spawn itself. */
    throws?: string
  } = {},
): FakeSpawn {
  const calls: string[][] = []
  const cwds: (string | undefined)[] = []
  const spawnFn = (_bin: string, argv: string[], options?: { cwd?: string }) => {
    calls.push(argv)
    cwds.push(options?.cwd)
    if (out.throws !== undefined) throw new Error(out.throws)
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter
      stderr: EventEmitter
      kill: () => void
    }
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    child.kill = () => undefined
    if (out.hang !== true) {
      setImmediate(() => {
        if (out.stdout !== undefined) child.stdout.emit('data', out.stdout)
        if (out.stderr !== undefined) child.stderr.emit('data', out.stderr)
        if (out.error !== undefined) {
          child.emit('error', new Error(out.error))
          return
        }
        child.emit('close', out.code ?? 0)
      })
    }
    return child
  }
  return { spawnFn, calls, cwds }
}

/** The two shapes, exactly as CLI 2.1.241 emitted them for this repo. */
const BACKGROUND_ENTRY = {
  id: '8b1e6bfd',
  cwd: ROOT,
  kind: 'background',
  startedAt: 1783733695215,
  sessionId: '8b1e6bfd-2e30-432d-993a-125dca91778f',
  name: 'loop fix',
  state: 'blocked',
}

const INTERACTIVE_ENTRY = {
  pid: 95820,
  cwd: ROOT,
  kind: 'interactive',
  startedAt: 1787580043902,
  sessionId: '7f87aba8-09a2-4c50-9bf6-2ae2e2a63ab0',
  name: 'plan-flow-56',
  status: 'busy',
}

const LIVE_OUTPUT = JSON.stringify([BACKGROUND_ENTRY, INTERACTIVE_ENTRY])

/** Silence the developer-facing warnings the fail-soft paths log on purpose. */
let warned: jest.SpyInstance
beforeEach(() => {
  warned = jest.spyOn(console, 'warn').mockImplementation(() => undefined)
})
afterEach(() => {
  warned.mockRestore()
})

describe('backgroundRuns — two entry shapes, one of which is not a run', () => {
  it('reads a background entry into a typed run', () => {
    const result = backgroundRuns([BACKGROUND_ENTRY], LIVE_OUTPUT, 100)
    expect(result.known).toBe(true)
    if (!result.known) throw new Error('unreachable')
    expect(result.runs).toEqual([
      {
        sessionId: '8b1e6bfd-2e30-432d-993a-125dca91778f',
        id: '8b1e6bfd',
        name: 'loop fix',
        cwd: ROOT,
        startedAt: 1783733695215,
        state: 'blocked',
      },
    ])
  })

  it("never draws the user's own interactive chat as a loop run", () => {
    const result = backgroundRuns([BACKGROUND_ENTRY, INTERACTIVE_ENTRY], LIVE_OUTPUT, 100)
    if (!result.known) throw new Error('expected a known snapshot')
    expect(result.runs.map((run) => run.sessionId)).toEqual([BACKGROUND_ENTRY.sessionId])
    expect(result.runs.some((run) => run.sessionId === INTERACTIVE_ENTRY.sessionId)).toBe(false)
  })

  it('tolerates an interactive entry that carries no session at all', () => {
    // An interactive entry is not a run, so nothing about it can make the
    // snapshot unreadable — only a BACKGROUND entry's identity matters.
    const result = backgroundRuns(
      [{ pid: 1, kind: 'interactive' }, BACKGROUND_ENTRY],
      LIVE_OUTPUT,
      100,
    )
    if (!result.known) throw new Error('expected a known snapshot')
    expect(result.runs).toHaveLength(1)
  })

  it('reports a background entry that is missing its decoration, not drops it', () => {
    const result = backgroundRuns(
      [{ kind: BACKGROUND_KIND, sessionId: BACKGROUND_ENTRY.sessionId }],
      LIVE_OUTPUT,
      100,
    )
    if (!result.known) throw new Error('expected a known snapshot')
    expect(result.runs).toEqual([
      {
        sessionId: BACKGROUND_ENTRY.sessionId,
        id: null,
        name: null,
        cwd: null,
        startedAt: null,
        state: null,
      },
    ])
  })

  it('an empty list is a KNOWN empty world, not unknown', () => {
    const result = backgroundRuns([], '[]', 100)
    expect(result.known).toBe(true)
    if (!result.known) throw new Error('unreachable')
    expect(result.runs).toEqual([])
  })

  it('carries the raw array through untouched, for the CLI to re-derive from', () => {
    const result = backgroundRuns([BACKGROUND_ENTRY, INTERACTIVE_ENTRY], LIVE_OUTPUT, 100)
    if (!result.known) throw new Error('expected a known snapshot')
    // The CLI's stuck-claim check is the authority and is handed the ARRAY —
    // including the interactive entry it filters itself.
    expect(JSON.parse(result.raw)).toHaveLength(2)
  })
})

describe('backgroundRuns — unknown is never empty', () => {
  const cases: [string, unknown][] = [
    ['not a list', { kind: 'background' }],
    ['an entry that is not an agent', ['nope']],
    ['an entry that does not say what kind it is', [{ sessionId: 'x' }]],
    ['a background entry with no session', [{ kind: 'background', id: 'a' }]],
    ['a background entry whose session is blank', [{ kind: 'background', sessionId: '   ' }]],
  ]

  it.each(cases)('%s → unknown with a stated reason', (_label, snapshot) => {
    const result = backgroundRuns(snapshot, '', 100)
    expect(result.known).toBe(false)
    if (result.known) throw new Error('unreachable')
    expect(result.reason.length).toBeGreaterThan(0)
  })

  it('an unidentifiable background entry poisons the whole snapshot', () => {
    // Deliberate: that entry may BE the run holding the claim under test, so a
    // partial answer would report a live claim as dead.
    const result = backgroundRuns([BACKGROUND_ENTRY, { kind: 'background' }], '', 100)
    expect(result.known).toBe(false)
  })

  it('every unknown reason names the problem without naming a command', () => {
    for (const [, snapshot] of cases) {
      const result = backgroundRuns(snapshot, '', 100)
      if (result.known) throw new Error('expected unknown')
      // forbidden-pattern #12: the reason is surfaced to a panel with no terminal.
      expect(result.reason).not.toMatch(/`|--|\/[a-z]+\//)
    }
  })
})

describe('extractJsonArray / parseAgentsOutput — stdout is not pure JSON', () => {
  it('reads the array when stdout is nothing but the array', () => {
    expect(extractJsonArray(LIVE_OUTPUT)).toBe(LIVE_OUTPUT)
  })

  it('reads the array past a banner line the CLI printed first', () => {
    const withBanner = `Claude Code v2.1.241\n${LIVE_OUTPUT}\n`
    const result = parseAgentsOutput(withBanner, 100)
    expect(result.known).toBe(true)
    if (!result.known) throw new Error('unreachable')
    expect(result.runs.map((run) => run.sessionId)).toEqual([BACKGROUND_ENTRY.sessionId])
  })

  it('reads the array past a trailing notice as well', () => {
    const result = parseAgentsOutput(`banner\n${LIVE_OUTPUT}\nDone.\n`, 100)
    expect(result.known).toBe(true)
  })

  it('unparseable stdout is unknown, never "no runs"', () => {
    const result = parseAgentsOutput('[ this is not json', 100)
    expect(result.known).toBe(false)
    if (result.known) throw new Error('unreachable')
    expect(result.reason).toBe('the list of running agents could not be read')
  })

  it('empty stdout is unknown — silence is not an empty world', () => {
    const result = parseAgentsOutput('', 100)
    expect(result.known).toBe(false)
  })

  it('stamps the snapshot with the clock it was given', () => {
    const result = parseAgentsOutput(LIVE_OUTPUT, 4242)
    expect(result.readAt).toBe(4242)
  })
})

describe('readRunsInFlight — the process, scoped to one root', () => {
  it('asks only for this root and parses the answer', async () => {
    const spawn = fakeSpawn({ stdout: LIVE_OUTPUT })
    const result = await readRunsInFlight(ROOT, {
      spawnFn: spawn.spawnFn,
      claudeBin: CLAUDE_BIN,
      now: () => 7,
    })
    expect(spawn.calls).toEqual([['agents', '--cwd', ROOT, '--json']])
    expect(spawn.cwds).toEqual([ROOT])
    expect(result.known).toBe(true)
    if (!result.known) throw new Error('unreachable')
    expect(result.runs).toHaveLength(1)
    expect(result.readAt).toBe(7)
  })

  it('no Claude Code on the machine → unknown, and says so by name', async () => {
    const spawn = fakeSpawn({ error: 'spawn claude ENOENT' })
    const result = await readRunsInFlight(ROOT, {
      spawnFn: spawn.spawnFn,
      claudeBin: CLAUDE_BIN,
      now: () => 1,
    })
    expect(result.known).toBe(false)
    if (result.known) throw new Error('unreachable')
    expect(result.reason).toContain("Claude Code isn't available here")
  })

  it('a spawn that throws outright is unknown, not a rejection', async () => {
    const spawn = fakeSpawn({ throws: 'EACCES' })
    const result = await readRunsInFlight(ROOT, {
      spawnFn: spawn.spawnFn,
      claudeBin: CLAUDE_BIN,
      now: () => 1,
    })
    expect(result.known).toBe(false)
  })

  it('a non-zero exit is unknown with its own reason — never "no runs"', async () => {
    const spawn = fakeSpawn({ code: 1, stderr: 'not logged in' })
    const result = await readRunsInFlight(ROOT, {
      spawnFn: spawn.spawnFn,
      claudeBin: CLAUDE_BIN,
      now: () => 1,
    })
    expect(result.known).toBe(false)
    if (result.known) throw new Error('unreachable')
    expect(result.reason).toBe("Claude Code couldn't say which runs are going in this project.")
  })

  it('a non-zero exit that still printed an array is STILL unknown', async () => {
    // The exit code is the CLI saying it could not answer; trusting the array
    // anyway would be reading a partial list as a complete one.
    const spawn = fakeSpawn({ code: 2, stdout: LIVE_OUTPUT })
    const result = await readRunsInFlight(ROOT, {
      spawnFn: spawn.spawnFn,
      claudeBin: CLAUDE_BIN,
      now: () => 1,
    })
    expect(result.known).toBe(false)
  })

  it('relays nothing the reader cannot act on — the tool line is logged, not shown', async () => {
    const spawn = fakeSpawn({ code: 1, stderr: 'run `claude auth login` to fix this' })
    const result = await readRunsInFlight(ROOT, {
      spawnFn: spawn.spawnFn,
      claudeBin: CLAUDE_BIN,
      now: () => 1,
    })
    if (result.known) throw new Error('expected unknown')
    expect(result.reason).not.toContain('claude auth login')
    expect(warned).toHaveBeenCalled()
  })

  it('a read that never answers is killed and reported as taking too long', async () => {
    jest.useFakeTimers()
    try {
      const spawn = fakeSpawn({ hang: true })
      const pending = readRunsInFlight(ROOT, {
        spawnFn: spawn.spawnFn,
        claudeBin: CLAUDE_BIN,
        timeoutMs: 50,
        now: () => 1,
      })
      jest.advanceTimersByTime(51)
      const result = await pending
      expect(result.known).toBe(false)
      if (result.known) throw new Error('unreachable')
      expect(result.reason).toContain('took too long')
    } finally {
      jest.useRealTimers()
    }
  })

  it('has a timeout at all — nothing on main may wait forever', () => {
    expect(AGENTS_READ_TIMEOUT_MS).toBeGreaterThan(0)
    expect(DISPATCH_TIMEOUT_MS).toBeGreaterThan(0)
  })
})

describe('RunsInFlightCache — pay only for what someone can see', () => {
  function countingRead(answers: RunsInFlight[]): {
    readFn: (rootPath: string) => Promise<RunsInFlight>
    roots: string[]
  } {
    const roots: string[] = []
    let index = 0
    return {
      roots,
      readFn: (rootPath) => {
        roots.push(rootPath)
        const answer = answers[Math.min(index, answers.length - 1)]
        index += 1
        return Promise.resolve(answer as RunsInFlight)
      },
    }
  }

  const known = (readAt: number): RunsInFlight => ({ known: true, runs: [], raw: '[]', readAt })

  it('serves a fresh snapshot without reading again', async () => {
    const read = countingRead([known(0)])
    let clock = 0
    const cache = new RunsInFlightCache({ readFn: read.readFn, now: () => clock, ttlMs: 100 })
    await cache.read(ROOT)
    clock = 50
    await cache.read(ROOT)
    expect(read.roots).toHaveLength(1)
  })

  it('reads again once the window has passed', async () => {
    const read = countingRead([known(0), known(200)])
    let clock = 0
    const cache = new RunsInFlightCache({ readFn: read.readFn, now: () => clock, ttlMs: 100 })
    await cache.read(ROOT)
    clock = 200
    await cache.read(ROOT)
    expect(read.roots).toHaveLength(2)
  })

  it('two concurrent callers share one read', async () => {
    const read = countingRead([known(0)])
    const cache = new RunsInFlightCache({ readFn: read.readFn, now: () => 0, ttlMs: 100 })
    await Promise.all([cache.read(ROOT), cache.read(ROOT)])
    expect(read.roots).toHaveLength(1)
  })

  it('an off-screen caller spawns NOTHING, even with a stale snapshot', async () => {
    const read = countingRead([known(0), known(999)])
    let clock = 0
    const cache = new RunsInFlightCache({ readFn: read.readFn, now: () => clock, ttlMs: 100 })
    await cache.read(ROOT, { visible: true })
    clock = 9_000
    const hidden = await cache.read(ROOT, { visible: false })
    expect(read.roots).toHaveLength(1)
    expect(hidden.known).toBe(true)
  })

  it('an off-screen caller with nothing known gets "unknown", never "no runs"', async () => {
    const read = countingRead([known(0)])
    const cache = new RunsInFlightCache({ readFn: read.readFn, now: () => 0 })
    const result = await cache.read(ROOT, { visible: false })
    expect(read.roots).toHaveLength(0)
    expect(result.known).toBe(false)
  })

  it('reads again on the way back into view', async () => {
    const read = countingRead([known(0), known(9_000)])
    let clock = 0
    const cache = new RunsInFlightCache({ readFn: read.readFn, now: () => clock, ttlMs: 100 })
    await cache.read(ROOT, { visible: true })
    clock = 9_000
    await cache.read(ROOT, { visible: false })
    await cache.read(ROOT, { visible: true })
    expect(read.roots).toHaveLength(2)
  })

  it('keys on the root, so one project never answers for another', async () => {
    const read = countingRead([known(0)])
    const cache = new RunsInFlightCache({ readFn: read.readFn, now: () => 0, ttlMs: 100 })
    await cache.read(ROOT)
    await cache.read('/other/project')
    expect(read.roots).toEqual([ROOT, '/other/project'])
  })

  it('forgetting a project drops its snapshot', async () => {
    const read = countingRead([known(0)])
    const cache = new RunsInFlightCache({ readFn: read.readFn, now: () => 0, ttlMs: 100 })
    await cache.read(ROOT)
    cache.forget(ROOT)
    await cache.read(ROOT)
    expect(read.roots).toHaveLength(2)
  })

  it('a failed read does not poison the cache', async () => {
    let attempt = 0
    const cache = new RunsInFlightCache({
      now: () => 0,
      readFn: () => {
        attempt += 1
        return attempt === 1 ? Promise.reject(new Error('boom')) : Promise.resolve(known(0))
      },
    })
    await expect(cache.read(ROOT)).rejects.toThrow('boom')
    const second = await cache.read(ROOT)
    expect(second.known).toBe(true)
  })
})

describe('dispatchLoopRun — a run starts only when someone asked for one', () => {
  const request = (over: Partial<LoopRunRequest> = {}): LoopRunRequest => ({
    rootPath: ROOT,
    loop: 'fix',
    confirmed: true,
    ...over,
  })

  const SESSION = '11111111-2222-4333-8444-555555555555'

  it('refuses without confirmation, and spawns nothing at all', async () => {
    const spawn = fakeSpawn()
    // The IPC boundary hands over unvalidated JSON, so the guard is a RUNTIME
    // check as well as a type — this cast is what a caller with no `confirmed`
    // field actually looks like on the wire (forbidden-pattern #15).
    const result = await dispatchLoopRun(
      { rootPath: ROOT, loop: 'fix' } as unknown as LoopRunRequest,
      { spawnFn: spawn.spawnFn, claudeBin: CLAUDE_BIN },
    )
    expect(spawn.calls).toEqual([])
    expect(result.dispatched).toBe(false)
    if (result.dispatched) throw new Error('unreachable')
    expect(result.reason).toContain('only when someone asks for it')
  })

  it('refuses a confirmation that is not one', async () => {
    const spawn = fakeSpawn()
    const result = await dispatchLoopRun(
      { rootPath: ROOT, loop: 'fix', confirmed: false } as unknown as LoopRunRequest,
      { spawnFn: spawn.spawnFn, claudeBin: CLAUDE_BIN },
    )
    expect(spawn.calls).toEqual([])
    expect(result.dispatched).toBe(false)
  })

  it('refuses a request with no project, before spawning', async () => {
    const spawn = fakeSpawn()
    const result = await dispatchLoopRun(request({ rootPath: '  ' }), {
      spawnFn: spawn.spawnFn,
      claudeBin: CLAUDE_BIN,
    })
    expect(spawn.calls).toEqual([])
    expect(result.dispatched).toBe(false)
  })

  it('refuses a request with no loop, before spawning', async () => {
    const spawn = fakeSpawn()
    const result = await dispatchLoopRun(request({ loop: '' }), {
      spawnFn: spawn.spawnFn,
      claudeBin: CLAUDE_BIN,
    })
    expect(spawn.calls).toEqual([])
    expect(result.dispatched).toBe(false)
  })

  it('refuses a pinned session that Claude Code could not start', async () => {
    const spawn = fakeSpawn()
    const result = await dispatchLoopRun(request({ sessionId: 'not-a-uuid' }), {
      spawnFn: spawn.spawnFn,
      claudeBin: CLAUDE_BIN,
    })
    expect(spawn.calls).toEqual([])
    expect(result.dispatched).toBe(false)
  })

  it('starts one background run in the project root and returns its session', async () => {
    const spawn = fakeSpawn({ code: 0 })
    const result = await dispatchLoopRun(request(), {
      spawnFn: spawn.spawnFn,
      claudeBin: CLAUDE_BIN,
      newSessionId: () => SESSION,
      now: () => 555,
    })
    expect(result).toEqual({ dispatched: true, sessionId: SESSION, loop: 'fix', startedAt: 555 })
    expect(spawn.calls).toHaveLength(1)
    expect(spawn.cwds).toEqual([ROOT])
    const argv = spawn.calls[0] as string[]
    expect(argv.slice(0, 4)).toEqual(['--bg', '--session-id', SESSION, '--name'])
  })

  it('honours a pinned session so a binding recorded elsewhere matches', async () => {
    const spawn = fakeSpawn({ code: 0 })
    const result = await dispatchLoopRun(request({ sessionId: SESSION }), {
      spawnFn: spawn.spawnFn,
      claudeBin: CLAUDE_BIN,
      newSessionId: () => 'should-not-be-used',
      now: () => 1,
    })
    if (!result.dispatched) throw new Error('expected a dispatch')
    expect(result.sessionId).toBe(SESSION)
    expect((spawn.calls[0] as string[]).includes(SESSION)).toBe(true)
  })

  it("tells the run its session, so the claims it takes can be checked later", async () => {
    const spawn = fakeSpawn({ code: 0 })
    await dispatchLoopRun(request(), {
      spawnFn: spawn.spawnFn,
      claudeBin: CLAUDE_BIN,
      newSessionId: () => SESSION,
      now: () => 1,
    })
    const prompt = (spawn.calls[0] as string[]).at(-1) ?? ''
    expect(prompt).toContain('/agent-loop fix')
    expect(prompt).toContain(`--session ${SESSION}`)
  })

  it('passes an aim through to the run without widening it', () => {
    expect(dispatchPrompt('fix', SESSION, ' the loops panel ')).toContain(
      '/agent-loop fix the loops panel',
    )
    expect(dispatchPrompt('fix', SESSION)).toContain('/agent-loop fix\n')
  })

  it('names the session in the args exactly once, as the pinned id', () => {
    const argv = dispatchArgs('fix', SESSION, 'prompt')
    expect(argv.filter((arg) => arg === SESSION)).toHaveLength(1)
    expect(argv.at(-1)).toBe('prompt')
  })

  it('no Claude Code on the machine → a named refusal, not a throw', async () => {
    const spawn = fakeSpawn({ error: 'spawn claude ENOENT' })
    const result = await dispatchLoopRun(request(), {
      spawnFn: spawn.spawnFn,
      claudeBin: CLAUDE_BIN,
      newSessionId: () => SESSION,
    })
    expect(result.dispatched).toBe(false)
    if (result.dispatched) throw new Error('unreachable')
    expect(result.reason).toContain("Claude Code isn't available here")
  })

  it('a non-zero exit is a named refusal', async () => {
    const spawn = fakeSpawn({ code: 1, stderr: 'no such flag' })
    const result = await dispatchLoopRun(request(), {
      spawnFn: spawn.spawnFn,
      claudeBin: CLAUDE_BIN,
      newSessionId: () => SESSION,
    })
    expect(result.dispatched).toBe(false)
    if (result.dispatched) throw new Error('unreachable')
    expect(result.reason).toBe("Claude Code couldn't start a run for this loop.")
  })

  it('a dispatch that never returns is killed and named', async () => {
    jest.useFakeTimers()
    try {
      const spawn = fakeSpawn({ hang: true })
      const pending = dispatchLoopRun(request(), {
        spawnFn: spawn.spawnFn,
        claudeBin: CLAUDE_BIN,
        newSessionId: () => SESSION,
        timeoutMs: 20,
      })
      jest.advanceTimersByTime(21)
      const result = await pending
      expect(result.dispatched).toBe(false)
      if (result.dispatched) throw new Error('unreachable')
      expect(result.reason).toContain('took too long')
    } finally {
      jest.useRealTimers()
    }
  })

  it('every refusal reads as a sentence, never as something to type', async () => {
    const spawn = fakeSpawn({ code: 1 })
    const results = await Promise.all([
      dispatchLoopRun({ rootPath: ROOT, loop: 'fix' } as unknown as LoopRunRequest, {
        spawnFn: spawn.spawnFn,
        claudeBin: CLAUDE_BIN,
      }),
      dispatchLoopRun(request({ loop: '' }), { spawnFn: spawn.spawnFn, claudeBin: CLAUDE_BIN }),
      dispatchLoopRun(request(), {
        spawnFn: spawn.spawnFn,
        claudeBin: CLAUDE_BIN,
        newSessionId: () => SESSION,
      }),
    ])
    for (const result of results) {
      if (result.dispatched) throw new Error('expected a refusal')
      expect(result.reason).not.toMatch(/`|\s--|\/agent-loop/)
      expect(result.reason.endsWith('.')).toBe(true)
    }
  })
})

describe('unknownRuns — the shared shape', () => {
  it('carries the reason and the clock, and no runs to read', () => {
    const result = unknownRuns('nobody could say', 12)
    expect(result).toEqual({ known: false, reason: 'nobody could say', readAt: 12 })
  })
})
