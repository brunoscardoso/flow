import { EventEmitter } from 'events'

import { installPackage, installRuntime } from './runtime-install'
import { forgetUserPath } from './tool-path'

/** A child we can drive by hand. */
function makeChild(): EventEmitter & {
  stdout: EventEmitter
  stderr: EventEmitter
  kill: jest.Mock
} {
  return Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    kill: jest.fn(),
  })
}

/** A spawn stand-in whose child we drive by hand. */
function fakeSpawn(): {
  fn: jest.Mock
  child: EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill: jest.Mock }
  args: () => unknown[]
} {
  const child = Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    kill: jest.fn(),
  })
  const fn = jest.fn(() => child)
  return { fn, child, args: () => fn.mock.calls[0] as unknown[] }
}

describe('installPackage', () => {
  it('knows the two external CLIs and nothing it has not checked', () => {
    expect(installPackage('codex')).toBe('@openai/codex')
    expect(installPackage('copilot')).toBe('@github/copilot')
    // Claude runs through the SDK Flow ships — there is nothing to install, and
    // inventing a package would be a button that fails when pressed.
    expect(installPackage('claude')).toBeNull()
    expect(installPackage('gemini')).toBeNull()
  })
})

describe('installRuntime', () => {
  it('installs the package globally with npm', async () => {
    const spawned = fakeSpawn()
    const done = installRuntime('copilot', { spawnFn: spawned.fn as never })
    spawned.child.stdout.emit('data', 'added 1 package in 4s\n')
    spawned.child.emit('close', 0)
    await expect(done).resolves.toEqual({ ok: true, detail: 'added 1 package in 4s' })
    expect(spawned.args()[0]).toBe('npm')
    expect(spawned.args()[1]).toEqual(['install', '-g', '@github/copilot'])
  })

  it('reports the installer OWN words when it fails, not a generic sentence', async () => {
    const spawned = fakeSpawn()
    const done = installRuntime('codex', { spawnFn: spawned.fn as never })
    spawned.child.stderr.emit('data', 'npm error code EACCES\nnpm error syscall mkdir\n')
    spawned.child.emit('close', 1)
    // The reason a global install failed (a permission, a proxy, a 404) is the
    // only thing that tells the reader what to do next.
    await expect(done).resolves.toEqual({
      ok: false,
      detail: 'npm error code EACCES · npm error syscall mkdir',
    })
  })

  it('says npm is missing in the reader’s terms, not as a spawn error', async () => {
    const spawned = fakeSpawn()
    const done = installRuntime('codex', { spawnFn: spawned.fn as never })
    spawned.child.emit('error', new Error('spawn npm ENOENT'))
    const result = await done
    expect(result.ok).toBe(false)
    expect(result.detail).toContain('could not find npm')
    expect(result.detail).not.toContain('ENOENT')
  })

  it('stops an install that never finishes rather than hanging the button', async () => {
    jest.useFakeTimers()
    try {
      const spawned = fakeSpawn()
      const done = installRuntime('copilot', { spawnFn: spawned.fn as never, timeoutMs: 50 })
      jest.advanceTimersByTime(60)
      await expect(done).resolves.toEqual({
        ok: false,
        detail: 'The install took too long and was stopped.',
      })
      expect(spawned.child.kill).toHaveBeenCalledWith('SIGKILL')
    } finally {
      jest.useRealTimers()
    }
  })

  it('refuses a runtime it has no package for, without spawning anything', async () => {
    const spawned = fakeSpawn()
    const result = await installRuntime('claude', { spawnFn: spawned.fn as never })
    expect(result.ok).toBe(false)
    expect(spawned.fn).not.toHaveBeenCalled()
  })
})

describe('when this process has no npm on its PATH (a Finder-launched app)', () => {
  it('retries with the user’s own PATH and installs with that', async () => {
    // Measured: with the GUI PATH (/usr/bin:/bin:/usr/sbin:/sbin), spawning
    // npm ENOENTs in 1 ms on a machine running npm 11.17.0.
    let call = 0
    const spawnFn = jest.fn(() => {
      const c = makeChild()
      call += 1
      const step = call
      setImmediate(() => {
        if (step === 1) c.emit('error', new Error('spawn npm ENOENT'))
        else if (step === 2) {
          c.stdout.emit('data', 'FLOW_PATH=/opt/homebrew/bin:/usr/bin\n')
          c.emit('close', 0)
        } else {
          c.stdout.emit('data', 'added 1 package\n')
          c.emit('close', 0)
        }
      })
      return c
    })
    forgetUserPath()
    const result = await installRuntime('copilot', { spawnFn: spawnFn as never })
    expect(result.ok).toBe(true)
    const options = (spawnFn.mock.calls[2] as unknown[])[2] as { env?: NodeJS.ProcessEnv }
    expect(options.env?.PATH).toBe('/opt/homebrew/bin:/usr/bin')
  })

  it('says npm is missing only when the user’s PATH has none either', async () => {
    let call = 0
    const spawnFn = jest.fn(() => {
      const c = makeChild()
      call += 1
      const step = call
      setImmediate(() => {
        if (step === 2) {
          c.stdout.emit('data', 'FLOW_PATH=/usr/bin:/bin\n')
          c.emit('close', 0)
        } else c.emit('error', new Error('spawn ENOENT'))
      })
      return c
    })
    forgetUserPath()
    const result = await installRuntime('codex', { spawnFn: spawnFn as never })
    expect(result).toEqual({
      ok: false,
      detail: 'Flow could not find npm on this machine, so it cannot install this tool.',
    })
  })
})
