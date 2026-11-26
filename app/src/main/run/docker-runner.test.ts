// The Docker runner — a fake spawn and fake timers; the real `docker` is never run.

import { EventEmitter } from 'node:events'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

import {
  DOCKER_DESKTOP_APP,
  DOCKER_OUTPUT_CAP,
  DOCKER_UNAVAILABLE,
  createDockerRunner,
  dockerAvailability,
  openDockerDesktop,
  type DockerChild,
  type DockerRunResult,
  type DockerRunner,
  type DockerSpawn,
} from './docker-runner'

class FakeChild extends EventEmitter {
  stdout = new EventEmitter()
  stderr = new EventEmitter()
  kills: string[] = []
  kill(signal?: NodeJS.Signals): boolean {
    this.kills.push(signal ?? 'SIGTERM')
    return true
  }
}

interface Harness {
  spawn: DockerSpawn
  calls: Array<{ command: string; args: string[]; cwd?: string; env: NodeJS.ProcessEnv }>
  child: () => FakeChild
  timers: Array<{ fn: () => void; ms: number; cleared: boolean }>
  runner: DockerRunner
}

function harness(): Harness {
  const calls: Harness['calls'] = []
  const children: FakeChild[] = []
  const timers: Harness['timers'] = []
  const spawn: DockerSpawn = (command, args, options) => {
    calls.push({ command, args, ...(options.cwd !== undefined ? { cwd: options.cwd } : {}), env: options.env })
    const child = new FakeChild()
    children.push(child)
    return child as unknown as DockerChild
  }
  const runner = createDockerRunner({
    spawn,
    baseEnv: { PATH: '/usr/bin' },
    extraPath: ['/opt/docker/bin'],
    setTimer: (fn, ms) => {
      const timer = { fn, ms, cleared: false }
      timers.push(timer)
      return timer
    },
    clearTimer: (handle) => {
      ;(handle as { cleared: boolean }).cleared = true
    },
  })
  return { spawn, calls, child: () => children[children.length - 1]!, timers, runner }
}

describe('createDockerRunner', () => {
  it('runs docker with argv, the cwd, the extra PATH and the call env, and reports success', async () => {
    const h = harness()
    const pending = h.runner.run(['volume', 'ls'], { cwd: '/work', env: { FOO: 'bar' }, timeoutMs: 500 })
    h.child().stdout.emit('data', Buffer.from('a\n'))
    h.child().stderr.emit('data', 'warn')
    h.child().emit('close', 0)
    const result = await pending
    expect(result).toEqual({ ok: true, code: 0, stdout: 'a\n', stderr: 'warn', timedOut: false })
    expect(h.calls[0]!.command).toBe('docker')
    expect(h.calls[0]!.args).toEqual(['volume', 'ls'])
    expect(h.calls[0]!.cwd).toBe('/work')
    expect(h.calls[0]!.env['PATH']).toBe('/usr/bin:/opt/docker/bin')
    expect(h.calls[0]!.env['FOO']).toBe('bar')
    expect(h.timers[0]!.ms).toBe(500)
    expect(h.timers[0]!.cleared).toBe(true)
  })

  it('reports a non-zero exit as not ok', async () => {
    const h = harness()
    const pending = h.runner.run(['ps'])
    h.child().emit('close', 1)
    expect((await pending).ok).toBe(false)
  })

  it('kills a call that outlives its timeout and reports timedOut', async () => {
    const h = harness()
    const pending = h.runner.run(['system', 'df'], { timeoutMs: 100 })
    h.timers[0]!.fn() // the timeout fires
    expect(h.child().kills).toEqual(['SIGTERM'])
    h.timers[1]!.fn() // the grace period passes
    expect(h.child().kills).toEqual(['SIGTERM', 'SIGKILL'])
    h.child().emit('close', null)
    const result = await pending
    expect(result.timedOut).toBe(true)
    expect(result.ok).toBe(false)
    expect(result.code).toBeNull()
  })

  it('a timed-out call that still exits 0 is not ok', async () => {
    const h = harness()
    const pending = h.runner.run(['ps'], { timeoutMs: 100 })
    h.timers[0]!.fn()
    h.child().emit('close', 0)
    expect(await pending).toMatchObject({ ok: false, timedOut: true })
  })

  it('reports a missing program as notFound', async () => {
    const h = harness()
    const pending = h.runner.run(['version'])
    h.child().emit('error', Object.assign(new Error('spawn docker ENOENT'), { code: 'ENOENT' }))
    expect(await pending).toMatchObject({ ok: false, code: null, notFound: true })
  })

  it('caps each stream', async () => {
    const h = harness()
    const pending = h.runner.run(['logs'])
    const chunk = 'x'.repeat(DOCKER_OUTPUT_CAP)
    h.child().stdout.emit('data', chunk)
    h.child().stdout.emit('data', chunk)
    h.child().emit('close', 0)
    expect((await pending).stdout.length).toBe(DOCKER_OUTPUT_CAP)
  })
})

/** A runner keyed by the first argv word that throws on anything else. */
function table(answers: Record<string, Partial<DockerRunResult> | Error>): DockerRunner & { calls: string[][] } {
  const calls: string[][] = []
  return {
    calls,
    run: async (args) => {
      calls.push(args)
      const answer = answers[args[0]!]
      if (answer === undefined) throw new Error(`unexpected docker call: ${args.join(' ')}`)
      if (answer instanceof Error) throw answer
      return { ok: true, code: 0, stdout: '', stderr: '', timedOut: false, ...answer }
    },
  }
}

describe('dockerAvailability', () => {
  it('is available when the engine and Compose both answer', async () => {
    const runner = table({ version: { stdout: '27.3.1\n' }, compose: { stdout: '2.29.0\n' } })
    expect(await dockerAvailability(runner)).toEqual({ available: true })
    expect(runner.calls).toEqual([
      ['version', '--format', '{{.Server.Version}}'],
      ['compose', 'version', '--short'],
    ])
  })

  it('not installed when the program is missing', async () => {
    const runner = table({ version: { ok: false, code: null, notFound: true } })
    expect(await dockerAvailability(runner)).toEqual({
      available: false,
      reason: 'not-installed',
      detail: DOCKER_UNAVAILABLE['not-installed'],
    })
    expect(runner.calls).toHaveLength(1)
  })

  it('not running when the engine does not answer, or times out', async () => {
    const refused = table({ version: { ok: false, code: 1, stderr: 'Cannot connect to the Docker daemon' } })
    expect(await dockerAvailability(refused)).toMatchObject({ available: false, reason: 'not-running' })
    const slow = table({ version: { ok: false, code: null, timedOut: true } })
    expect(await dockerAvailability(slow)).toMatchObject({ available: false, reason: 'not-running' })
  })

  it('compose missing when the engine answers but Compose does not', async () => {
    const runner = table({ version: { stdout: '20.10.0\n' }, compose: { ok: false, code: 1 } })
    expect(await dockerAvailability(runner)).toMatchObject({ available: false, reason: 'compose-missing' })
  })

  it('reasons speak in the reader’s terms', () => {
    for (const detail of Object.values(DOCKER_UNAVAILABLE)) {
      expect(detail).not.toMatch(/`|\/|--|docker /)
    }
  })
})

describe('openDockerDesktop', () => {
  it('opens the app on a Mac', async () => {
    const opened: string[] = []
    const result = await openDockerDesktop(async (path) => {
      opened.push(path)
      return ''
    }, 'darwin')
    expect(result).toEqual({ ok: true, detail: '' })
    expect(opened).toEqual([DOCKER_DESKTOP_APP])
  })

  it('says so when it could not open, without a path', async () => {
    const result = await openDockerDesktop(async () => 'not found', 'darwin')
    expect(result.ok).toBe(false)
    expect(result.detail).not.toMatch(/\//)
  })

  it('opens nothing elsewhere', async () => {
    const opened: string[] = []
    const result = await openDockerDesktop(async (path) => {
      opened.push(path)
      return ''
    }, 'linux')
    expect(result.ok).toBe(false)
    expect(opened).toEqual([])
  })
})

describe('no test can reach the real Docker', () => {
  const SRC = join(__dirname, '..', '..')
  function testFiles(dir: string): string[] {
    const out: string[] = []
    for (const name of readdirSync(dir)) {
      const path = join(dir, name)
      if (statSync(path).isDirectory()) out.push(...testFiles(path))
      else if (name.endsWith('.test.ts')) out.push(path)
    }
    return out
  }

  it('every test that builds a Docker runner hands it a fake spawn, and none imports the main entry', () => {
    const files = testFiles(SRC)
    // Positive first: the scan sees the suite, including this file.
    expect(files.some((file) => file.endsWith('docker-runner.test.ts'))).toBe(true)
    const builders: string[] = []
    for (const file of files) {
      const text = readFileSync(file, 'latin1')
      for (const match of text.matchAll(/createDockerRunner\(([^)]*)/g)) {
        builders.push(relative(SRC, file))
        expect(`${relative(SRC, file)}: ${match[1] ?? ''}`).toMatch(/spawn/)
      }
      expect(`${relative(SRC, file)}: ${/from '(\.\.\/)+index'|main\/index'/.test(text)}`).toMatch(/: false$/)
    }
    expect(builders).toEqual(['main/run/docker-runner.test.ts'])
  })
})
