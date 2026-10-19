// Derive runner — CLI resolution order (pure, mock fs + mock shell lookup)
// and the runner's root validation / one-derive-per-root concurrency guard /
// per-session success cache (mock spawn).

import { EventEmitter } from 'events'
import type { ChildProcess, spawn } from 'child_process'

import {
  BlueprintDeriveRunner,
  compareNvmVersionsDesc,
  DERIVE_ARGS,
  ensureProjectInitialized,
  INIT_ARGS,
  loginShellLookup,
  resolveDeriveCommands,
  type DeriveCommand,
  type DeriveFsDeps,
} from './derive-runner'
import type { RootsProvider } from '../flow/flow-observer'

const ROOT = '/work/project'
const HOME = '/Users/tester'

/** Shell lookup that never finds anything (the default for these tests). */
const noShell = (): Promise<string | null> => Promise.resolve(null)

function fsDeps(options: {
  existing?: string[]
  executables?: string[]
  packageJson?: string | null
  nvmVersions?: string[]
}): DeriveFsDeps {
  const existing = new Set(options.existing ?? [])
  const executables = new Set(options.executables ?? [])
  return {
    fileExists: (path) => Promise.resolve(existing.has(path)),
    executableExists: (path) => Promise.resolve(executables.has(path)),
    readFile: (path) =>
      Promise.resolve(path === `${ROOT}/package.json` ? (options.packageJson ?? null) : null),
    listDir: (path) =>
      Promise.resolve(
        path === `${HOME}/.nvm/versions/node` ? (options.nvmVersions ?? []) : [],
      ),
    homedir: () => HOME,
  }
}

describe('resolveDeriveCommands (resolution order)', () => {
  it('prefers the project-local node_modules/.bin CLI, with PATH always last', async () => {
    const commands = await resolveDeriveCommands(
      ROOT,
      fsDeps({ existing: [`${ROOT}/node_modules/.bin/planflow-ai`] }),
      noShell,
    )
    expect(commands.map((command) => command.id)).toEqual(['local-bin', 'path'])
    expect(commands[0]).toEqual({
      id: 'local-bin',
      command: `${ROOT}/node_modules/.bin/planflow-ai`,
      args: [...DERIVE_ARGS],
    })
  })

  it('puts the app-embedded bundled CLI FIRST, spawned via Electron-as-node', async () => {
    const bundled = { execPath: '/Apps/Flow.app/Contents/MacOS/Flow', cliPath: '/res/cli/planflow-ai.mjs' }
    const commands = await resolveDeriveCommands(
      ROOT,
      fsDeps({ existing: [bundled.cliPath, `${ROOT}/node_modules/.bin/planflow-ai`] }),
      noShell,
      bundled,
    )
    expect(commands.map((command) => command.id)).toEqual(['bundled', 'local-bin', 'path'])
    expect(commands[0]).toEqual({
      id: 'bundled',
      command: bundled.execPath,
      args: [bundled.cliPath, ...DERIVE_ARGS],
      env: { ELECTRON_RUN_AS_NODE: '1' },
    })
  })

  it('skips the bundled CLI when its file is not present', async () => {
    const bundled = { execPath: '/x/Flow', cliPath: '/res/cli/planflow-ai.mjs' }
    const commands = await resolveDeriveCommands(ROOT, fsDeps({}), noShell, bundled)
    expect(commands.map((command) => command.id)).toEqual(['path'])
  })

  it('uses `node dist/cli/index.js` when the root IS the planflow-ai repo and dist exists', async () => {
    const commands = await resolveDeriveCommands(
      ROOT,
      fsDeps({
        existing: [`${ROOT}/dist/cli/index.js`],
        packageJson: JSON.stringify({ name: 'planflow-ai' }),
      }),
      noShell,
    )
    expect(commands.map((command) => command.id)).toEqual(['project-dist', 'path'])
    expect(commands[0]).toEqual({
      id: 'project-dist',
      command: 'node',
      args: [`${ROOT}/dist/cli/index.js`, ...DERIVE_ARGS],
    })
  })

  it('falls through to PATH when the planflow-ai repo has no built dist', async () => {
    const commands = await resolveDeriveCommands(
      ROOT,
      fsDeps({ packageJson: JSON.stringify({ name: 'planflow-ai' }) }),
      noShell,
    )
    expect(commands.map((command) => command.id)).toEqual(['path'])
  })

  it('offers only the PATH fallback for a plain project with no installs anywhere', async () => {
    const commands = await resolveDeriveCommands(
      ROOT,
      fsDeps({ packageJson: JSON.stringify({ name: 'some-other-app' }) }),
      noShell,
    )
    expect(commands.map((command) => command.id)).toEqual(['path'])
    expect(commands[0]).toEqual({ id: 'path', command: 'planflow-ai', args: [...DERIVE_ARGS] })
  })

  it('tolerates a corrupt or missing package.json (PATH fallback only)', async () => {
    expect(
      (await resolveDeriveCommands(ROOT, fsDeps({ packageJson: 'not json' }), noShell)).map(
        (c) => c.id,
      ),
    ).toEqual(['path'])
    expect(
      (await resolveDeriveCommands(ROOT, fsDeps({ packageJson: null }), noShell)).map(
        (c) => c.id,
      ),
    ).toEqual(['path'])
  })

  it('probes well-known install dirs (GUI Electron misses the shell PATH)', async () => {
    const commands = await resolveDeriveCommands(
      ROOT,
      fsDeps({
        executables: ['/opt/homebrew/bin/planflow-ai', `${HOME}/.npm-global/bin/planflow-ai`],
      }),
      noShell,
    )
    expect(commands.map((command) => command.command)).toEqual([
      '/opt/homebrew/bin/planflow-ai',
      `${HOME}/.npm-global/bin/planflow-ai`,
      'planflow-ai',
    ])
    expect(commands[0]?.id).toBe('well-known')
    expect(commands[1]?.id).toBe('well-known')
  })

  it('only offers well-known bins that are actually executable', async () => {
    // Present on disk (fileExists) but NOT executable → skipped.
    const commands = await resolveDeriveCommands(
      ROOT,
      fsDeps({ existing: ['/usr/local/bin/planflow-ai'] }),
      noShell,
    )
    expect(commands.map((command) => command.id)).toEqual(['path'])
  })

  it('picks the HIGHEST nvm node version that has the CLI', async () => {
    const nvmBin = (version: string): string =>
      `${HOME}/.nvm/versions/node/${version}/bin/planflow-ai`
    const commands = await resolveDeriveCommands(
      ROOT,
      fsDeps({
        nvmVersions: ['v18.20.1', 'v22.4.0', 'v20.11.0'],
        executables: [nvmBin('v18.20.1'), nvmBin('v20.11.0')],
      }),
      noShell,
    )
    // v22 has no CLI installed; v20 beats v18.
    expect(commands.map((command) => command.id)).toEqual(['nvm', 'path'])
    expect(commands[0]?.command).toBe(nvmBin('v20.11.0'))
  })

  it('adds the login-shell lookup result before the PATH fallback', async () => {
    const commands = await resolveDeriveCommands(ROOT, fsDeps({}), () =>
      Promise.resolve('/custom/tools/bin/planflow-ai'),
    )
    expect(commands.map((command) => command.id)).toEqual(['login-shell', 'path'])
    expect(commands[0]?.command).toBe('/custom/tools/bin/planflow-ai')
  })

  it('drops a login-shell result that duplicates a probed candidate', async () => {
    const commands = await resolveDeriveCommands(
      ROOT,
      fsDeps({ executables: ['/opt/homebrew/bin/planflow-ai'] }),
      () => Promise.resolve('/opt/homebrew/bin/planflow-ai'),
    )
    expect(commands.map((command) => command.id)).toEqual(['well-known', 'path'])
  })

  it('keeps the full order local-bin → project-dist → probes → shell → path', async () => {
    const commands = await resolveDeriveCommands(
      ROOT,
      fsDeps({
        existing: [`${ROOT}/node_modules/.bin/planflow-ai`, `${ROOT}/dist/cli/index.js`],
        executables: ['/usr/local/bin/planflow-ai'],
        nvmVersions: ['v20.0.0'],
        packageJson: JSON.stringify({ name: 'planflow-ai' }),
      }),
      () => Promise.resolve('/somewhere/planflow-ai'),
    )
    expect(commands.map((command) => command.id)).toEqual([
      'local-bin',
      'project-dist',
      'well-known',
      'login-shell',
      'path',
    ])
  })
})

describe('compareNvmVersionsDesc', () => {
  it('sorts semver-ish dir names descending', () => {
    expect(['v18.20.1', 'v22.4.0', 'v20.11.0'].sort(compareNvmVersionsDesc)).toEqual([
      'v22.4.0',
      'v20.11.0',
      'v18.20.1',
    ])
  })

  it('tolerates junk names (treated as zeros)', () => {
    expect(['garbage', 'v20.0.0'].sort(compareNvmVersionsDesc)[0]).toBe('v20.0.0')
  })
})

// ── Login-shell lookup (mock spawn) ────────────────────────────────────────

class FakeChild extends EventEmitter {
  stderr = new EventEmitter()
  stdout = new EventEmitter()
  killed = false
  kill(): boolean {
    this.killed = true
    return true
  }
}

describe('loginShellLookup', () => {
  function shellSpawn(onChild: (child: FakeChild) => void): typeof spawn {
    return ((_cmd: string, _args: string[]) => {
      const child = new FakeChild()
      setImmediate(() => onChild(child))
      return child as unknown as ChildProcess
    }) as unknown as typeof spawn
  }

  it('returns the absolute path printed by `command -v`', async () => {
    const result = await loginShellLookup(
      shellSpawn((child) => {
        child.stdout.emit('data', '/opt/homebrew/bin/planflow-ai\n')
        child.emit('close', 0)
      }),
    )
    expect(result).toBe('/opt/homebrew/bin/planflow-ai')
  })

  it('returns null on non-zero exit, relative output, or spawn error', async () => {
    expect(await loginShellLookup(shellSpawn((child) => child.emit('close', 1)))).toBeNull()
    expect(
      await loginShellLookup(
        shellSpawn((child) => {
          child.stdout.emit('data', 'planflow-ai: not found\n')
          child.emit('close', 0)
        }),
      ),
    ).toBeNull()
    expect(
      await loginShellLookup(shellSpawn((child) => child.emit('error', new Error('ENOENT')))),
    ).toBeNull()
  })

  it('never spawns on win32 — the whole probe is POSIX by construction (B4)', async () => {
    // `$SHELL`, `-lc`, `command -v` and the leading-`/` test are all POSIX
    // assumptions; on Windows the spawn either ENOENTs or burns the 3s cap for
    // an answer that is null either way.
    const spawnFn = jest.fn()
    const result = await loginShellLookup(spawnFn as unknown as typeof spawn, 'win32')

    expect(result).toBeNull()
    expect(spawnFn).not.toHaveBeenCalled()
  })

  it('still spawns on darwin — the skip is branch-guarded, not a removal', async () => {
    const result = await loginShellLookup(
      shellSpawn((child) => {
        child.stdout.emit('data', '/opt/homebrew/bin/planflow-ai\n')
        child.emit('close', 0)
      }),
      'darwin',
    )
    expect(result).toBe('/opt/homebrew/bin/planflow-ai')
  })
})

// ── Runner (mock spawn) ────────────────────────────────────────────────────

function rootsOf(...rootPaths: string[]): RootsProvider {
  return {
    getRoots: () => rootPaths.map((rootPath) => ({ rootPath })),
    onRootsChanged: () => () => undefined,
  }
}

function runnerWith(options: {
  roots: RootsProvider
  candidates: DeriveCommand[]
  onSpawn: (command: string, child: FakeChild) => void
}): {
  runner: BlueprintDeriveRunner
  spawned: string[]
  spawnOpts: Array<{ env?: Record<string, string> }>
  resolves: number[]
} {
  const spawned: string[] = []
  const spawnOpts: Array<{ env?: Record<string, string> }> = []
  const resolves: number[] = []
  const spawnFn = ((command: string, _args: string[], opts: { env?: Record<string, string> }) => {
    const child = new FakeChild()
    spawned.push(command)
    spawnOpts.push(opts)
    options.onSpawn(command, child)
    return child as unknown as ChildProcess
  }) as unknown as typeof spawn
  const runner = new BlueprintDeriveRunner(
    options.roots,
    () => {
      resolves.push(1)
      return Promise.resolve(options.candidates)
    },
    spawnFn,
  )
  return { runner, spawned, spawnOpts, resolves }
}

const PATH_CANDIDATE: DeriveCommand = { id: 'path', command: 'planflow-ai', args: [...DERIVE_ARGS] }

/** Let the runner's awaited resolution step reach the actual spawn. */
function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

describe('BlueprintDeriveRunner', () => {
  it('rejects roots that are not current project roots (never spawns)', async () => {
    const { runner, spawned } = runnerWith({
      roots: rootsOf('/somewhere/else'),
      candidates: [PATH_CANDIDATE],
      onSpawn: () => undefined,
    })
    const result = await runner.derive(ROOT)
    expect(result).toEqual({ ok: false, error: 'Unknown project' })
    expect(spawned).toEqual([])
  })

  it('resolves ok on exit 0 and tries the next candidate after a spawn miss', async () => {
    const { runner, spawned } = runnerWith({
      roots: rootsOf(ROOT),
      candidates: [
        { id: 'local-bin', command: '/missing/bin', args: [...DERIVE_ARGS] },
        PATH_CANDIDATE,
      ],
      onSpawn: (command, child) => {
        setImmediate(() => {
          if (command === '/missing/bin') {
            child.emit('error', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }))
          } else {
            child.emit('close', 0)
          }
        })
      },
    })
    expect(await runner.derive(ROOT)).toEqual({ ok: true, error: null })
    expect(spawned).toEqual(['/missing/bin', 'planflow-ai'])
  })

  it('passes the bundled candidate env (ELECTRON_RUN_AS_NODE) through to spawn', async () => {
    const { runner, spawnOpts } = runnerWith({
      roots: rootsOf(ROOT),
      candidates: [
        { id: 'bundled', command: '/Flow', args: [...DERIVE_ARGS], env: { ELECTRON_RUN_AS_NODE: '1' } },
      ],
      onSpawn: (_command, child) => setImmediate(() => child.emit('close', 0)),
    })
    expect(await runner.derive(ROOT)).toEqual({ ok: true, error: null })
    expect(spawnOpts[0]?.env?.['ELECTRON_RUN_AS_NODE']).toBe('1')
  })

  it('reports a real derive failure (non-zero exit) with the last stderr line', async () => {
    const { runner } = runnerWith({
      roots: rootsOf(ROOT),
      candidates: [PATH_CANDIDATE],
      onSpawn: (_command, child) => {
        setImmediate(() => {
          child.stderr.emit('data', 'warming up\nboom: graph lock held\n')
          child.emit('close', 1)
        })
      },
    })
    expect(await runner.derive(ROOT)).toEqual({ ok: false, error: 'boom: graph lock held' })
  })

  it('coalesces concurrent derives for the same root into one spawn', async () => {
    const children: FakeChild[] = []
    const { runner, spawned } = runnerWith({
      roots: rootsOf(ROOT),
      candidates: [PATH_CANDIDATE],
      onSpawn: (_command, child) => {
        children.push(child)
      },
    })
    const first = runner.derive(ROOT)
    const second = runner.derive(ROOT)
    expect(second).toBe(first)
    await flush()
    children[0]?.emit('close', 0)
    expect(await first).toEqual({ ok: true, error: null })
    expect(spawned).toHaveLength(1)
    // After settling, a new derive spawns again (the guard is per in-flight run).
    const third = runner.derive(ROOT)
    expect(third).not.toBe(first)
    await flush()
    children[1]?.emit('close', 0)
    await third
    expect(spawned).toHaveLength(2)
  })

  it('caches the successful candidate per session and reuses it without re-resolving', async () => {
    const { runner, spawned, resolves } = runnerWith({
      roots: rootsOf(ROOT),
      candidates: [
        { id: 'local-bin', command: '/missing/bin', args: [...DERIVE_ARGS] },
        PATH_CANDIDATE,
      ],
      onSpawn: (command, child) => {
        setImmediate(() => {
          if (command === '/missing/bin') {
            child.emit('error', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }))
          } else {
            child.emit('close', 0)
          }
        })
      },
    })
    expect(await runner.derive(ROOT)).toEqual({ ok: true, error: null })
    expect(spawned).toEqual(['/missing/bin', 'planflow-ai'])
    expect(resolves).toHaveLength(1)
    // Second derive: goes straight to the cached winner — no resolution pass.
    expect(await runner.derive(ROOT)).toEqual({ ok: true, error: null })
    expect(spawned).toEqual(['/missing/bin', 'planflow-ai', 'planflow-ai'])
    expect(resolves).toHaveLength(1)
  })

  it('invalidates the cache when the cached candidate stops spawning', async () => {
    let pathGone = false
    const { runner, spawned, resolves } = runnerWith({
      roots: rootsOf(ROOT),
      candidates: [PATH_CANDIDATE],
      onSpawn: (command, child) => {
        setImmediate(() => {
          if (command === 'planflow-ai' && pathGone) {
            child.emit('error', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }))
          } else {
            child.emit('close', 0)
          }
        })
      },
    })
    expect(await runner.derive(ROOT)).toEqual({ ok: true, error: null })
    expect(resolves).toHaveLength(1)
    // The CLI disappears: the cached candidate misses → cache invalidated →
    // full resolution runs again (and its PATH candidate also misses).
    pathGone = true
    const result = await runner.derive(ROOT)
    expect(result.ok).toBe(false)
    expect(resolves).toHaveLength(2)
    // Cached spawn + resolved spawn on the second derive.
    expect(spawned).toEqual(['planflow-ai', 'planflow-ai', 'planflow-ai'])
  })
})

describe('ensureProjectInitialized (first-run provisioning)', () => {
  const BUNDLED = { execPath: '/Flow', cliPath: '/res/cli/planflow-ai.mjs' }

  /** A fake spawn that drives a FakeChild via `onSpawn`, capturing the call. */
  function fakeSpawn(onSpawn: (args: string[], child: FakeChild, opts: { env?: Record<string, string> }) => void) {
    const calls: Array<{ command: string; args: string[]; opts: { env?: Record<string, string> } }> = []
    const spawnFn = ((command: string, args: string[], opts: { env?: Record<string, string> }) => {
      const child = new FakeChild()
      calls.push({ command, args, opts })
      onSpawn(args, child, opts)
      return child as unknown as ChildProcess
    }) as unknown as typeof spawn
    return { spawnFn, calls }
  }

  it('is a no-op when the project already has a flow/ dir', async () => {
    const { spawnFn, calls } = fakeSpawn(() => undefined)
    const result = await ensureProjectInitialized('/proj', {
      bundledCli: BUNDLED,
      spawnFn,
      pathExists: (p) => p === '/proj/flow',
    })
    expect(result).toEqual({ ok: true, ranInit: false })
    expect(calls).toEqual([]) // never spawned init
  })

  it('runs `init --yes` via Electron-as-node when flow/ is missing', async () => {
    const { spawnFn, calls } = fakeSpawn((_args, child) => setImmediate(() => child.emit('close', 0)))
    const result = await ensureProjectInitialized('/proj', {
      bundledCli: BUNDLED,
      spawnFn,
      pathExists: (p) => p === BUNDLED.cliPath, // flow/ absent, CLI present
    })
    expect(result).toEqual({ ok: true, ranInit: true })
    expect(calls[0]?.args).toEqual([BUNDLED.cliPath, ...INIT_ARGS])
    expect(calls[0]?.opts.env?.['ELECTRON_RUN_AS_NODE']).toBe('1')
  })

  it('fails soft when no bundled CLI is available (never spawns)', async () => {
    const { spawnFn, calls } = fakeSpawn(() => undefined)
    const result = await ensureProjectInitialized('/proj', {
      bundledCli: null,
      spawnFn,
      pathExists: () => false,
    })
    expect(result.ok).toBe(false)
    expect(result.ranInit).toBe(false)
    expect(calls).toEqual([])
  })

  it('reports a failed init (non-zero exit) with the last stderr line', async () => {
    const { spawnFn } = fakeSpawn((_args, child) =>
      setImmediate(() => {
        child.stderr.emit('data', 'setting up\nboom: could not write flow/\n')
        child.emit('close', 1)
      }),
    )
    const result = await ensureProjectInitialized('/proj', {
      bundledCli: BUNDLED,
      spawnFn,
      pathExists: (p) => p === BUNDLED.cliPath,
    })
    expect(result).toEqual({ ok: false, ranInit: true, error: 'boom: could not write flow/' })
  })
})
