import { EventEmitter } from 'events'

import { createImportIndexWarmer, parseWarmStatus, runImportIndexWarm, type ImportIndexWarmStatus } from './import-index-warmer'

/** A clock the test advances by hand: timers fire only when `flush` is called. */
function manualTimers(): { setTimer: (fn: () => void, ms: number) => void; fire: () => Promise<void>; pending: () => number } {
  let timers: Array<() => void> = []
  return {
    setTimer: (fn) => {
      timers.push(fn)
    },
    fire: async () => {
      const due = timers
      timers = []
      for (const fn of due) fn()
      // Let the drain's awaits settle.
      for (let i = 0; i < 10; i += 1) await Promise.resolve()
    },
    pending: () => timers.length,
  }
}

describe('createImportIndexWarmer', () => {
  it('warms each project once per session, one at a time, after the launch delay', async () => {
    const timers = manualTimers()
    const runs: string[] = []
    let inFlight = 0
    let maxInFlight = 0
    const warmer = createImportIndexWarmer({
      setTimer: timers.setTimer,
      run: async (rootPath) => {
        runs.push(rootPath)
        inFlight += 1
        maxInFlight = Math.max(maxInFlight, inFlight)
        await Promise.resolve()
        inFlight -= 1
        return 'built'
      },
    })
    warmer.request(['/a', '/b'])
    warmer.request(['/a', '/b', '/c'])
    // Nothing before the launch delay.
    expect(runs).toEqual([])
    await timers.fire()
    await warmer.idle()
    expect(runs).toEqual(['/a', '/b', '/c'])
    expect(maxInFlight).toBe(1)

    // Roots-changed fires again (placement, provisioning): nothing re-runs.
    warmer.request(['/a', '/b', '/c'])
    await warmer.idle()
    expect(runs).toEqual(['/a', '/b', '/c'])
  })

  it('retries a failed warm once on a later request, never more', async () => {
    const timers = manualTimers()
    const runs: string[] = []
    const warmer = createImportIndexWarmer({
      setTimer: timers.setTimer,
      run: async (rootPath) => {
        runs.push(rootPath)
        return null
      },
    })
    warmer.request(['/a'])
    await timers.fire()
    await warmer.idle()
    warmer.request(['/a'])
    await warmer.idle()
    warmer.request(['/a'])
    await warmer.idle()
    expect(runs).toEqual(['/a', '/a'])
  })

  it('a partial graph read warms at once, waits out a busy build, then announces the index', async () => {
    const answers: ImportIndexWarmStatus[] = ['busy', 'busy', 'fresh']
    const announced: string[] = []
    const sleeps: number[] = []
    const warmer = createImportIndexWarmer({
      // Busy → it sleeps between asks; here each sleep ends on the next tick.
      setTimer: (fn, ms) => {
        sleeps.push(ms)
        setImmediate(fn)
      },
      busyRetryMs: 7,
      run: async () => answers.shift() ?? 'fresh',
      onIndexReady: (rootPath) => announced.push(rootPath),
    })
    warmer.followUp('/a')
    await warmer.idle()
    expect(sleeps).toEqual([7, 7])
    expect(answers).toEqual([])
    expect(announced).toEqual(['/a'])
  })

  it('a follow-up on a root queued by the launch warm joins it rather than running twice', async () => {
    const timers = manualTimers()
    const runs: string[] = []
    const announced: string[] = []
    const warmer = createImportIndexWarmer({
      setTimer: timers.setTimer,
      run: async (rootPath) => {
        runs.push(rootPath)
        return 'built'
      },
      onIndexReady: (rootPath) => announced.push(rootPath),
    })
    warmer.request(['/a'])
    warmer.followUp('/a')
    await warmer.idle()
    expect(runs).toEqual(['/a'])
    expect(announced).toEqual(['/a'])
  })

  it('stops following up a project whose reads stay partial', async () => {
    const timers = manualTimers()
    const runs: string[] = []
    const warmer = createImportIndexWarmer({
      setTimer: timers.setTimer,
      run: async (rootPath) => {
        runs.push(rootPath)
        return 'fresh'
      },
    })
    for (let i = 0; i < 6; i += 1) {
      warmer.followUp('/a')
      await warmer.idle()
    }
    expect(runs).toHaveLength(3)
  })
})

describe('runImportIndexWarm', () => {
  function fakeSpawn(stdout: string, code = 0): { spawnFn: any; calls: Array<{ argv: string[]; options: any }> } {
    const calls: Array<{ argv: string[]; options: any }> = []
    const spawnFn = (_exec: string, argv: string[], options: unknown) => {
      calls.push({ argv, options })
      const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; kill: () => void }
      child.stdout = new EventEmitter()
      child.kill = () => {}
      setImmediate(() => {
        child.stdout.emit('data', stdout)
        child.emit('close', code)
      })
      return child
    }
    return { spawnFn, calls }
  }

  it('runs `blueprint index warm --json` in the project with the app compiler, and reads its status', async () => {
    const { spawnFn, calls } = fakeSpawn('{"status":"built","files":3,"read":3,"ms":5}\n')
    const status = await runImportIndexWarm({ execPath: '/bin/electron', cliPath: '/app/cli.mjs' }, '/repo', {
      spawnFn,
      typescriptPath: '/app/node_modules/typescript/lib/typescript.js',
    })
    expect(status).toBe('built')
    expect(calls[0].argv).toEqual(['/app/cli.mjs', 'blueprint', 'index', 'warm', '--json'])
    expect(calls[0].options.cwd).toBe('/repo')
    expect(calls[0].options.env.ELECTRON_RUN_AS_NODE).toBe('1')
    expect(calls[0].options.env.FLOW_TYPESCRIPT_PATH).toBe('/app/node_modules/typescript/lib/typescript.js')
  })

  it('a failed exit or no CLI is null, never a throw', async () => {
    expect(await runImportIndexWarm({ execPath: '/x', cliPath: '/y' }, '/repo', { spawnFn: fakeSpawn('', 1).spawnFn, typescriptPath: null })).toBeNull()
    expect(await runImportIndexWarm(null, '/repo')).toBeNull()
  })

  it('parses the last JSON line only', () => {
    expect(parseWarmStatus('noise\n{"status":"busy"}\n')).toBe('busy')
    expect(parseWarmStatus('{"status":"weird"}')).toBeNull()
    expect(parseWarmStatus('')).toBeNull()
  })
})

describe('the feature graph carries the partial state to main', () => {
  it('passes importIndex and a folder block’s partial mark through the parser', async () => {
    const { runFeatures } = await import('./feature-runner')
    const graph = {
      nodes: [
        {
          id: 'feature:app',
          slug: 'app',
          name: 'App',
          kind: 'core',
          understanding: 'none',
          active: false,
          anchorCount: 1,
          folders: { rows: [{ path: 'src/app', lines: 2, files: 1, share: 1 }], folderCount: 1, spread: false, pinned: false, pinMissing: null, files: 1, lines: 2, partial: true },
        },
      ],
      edges: [],
      limitations: null,
      importIndex: 'partial',
    }
    const spawnFn: any = () => {
      const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; kill: () => void }
      child.stdout = new EventEmitter()
      child.kill = () => {}
      setImmediate(() => {
        child.stdout.emit('data', JSON.stringify(graph))
        child.emit('close', 0)
      })
      return child
    }
    const result = await runFeatures({ execPath: '/x', cliPath: '/y' } as never, '/repo', { spawnFn })
    expect(result.importIndex).toBe('partial')
    expect(result.nodes[0].folders?.partial).toBe(true)
    // Rows are still drawn.
    expect(result.nodes[0].folders?.rows.map((row) => row.path)).toEqual(['src/app'])
  })
})
