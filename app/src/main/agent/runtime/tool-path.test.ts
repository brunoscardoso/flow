import { EventEmitter } from 'events'

import { forgetUserPath, loginShellPath, resolveUserPath, userPathEnv } from './tool-path'

function child(): EventEmitter & {
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

/** A shell that prints `lines` then exits. */
function shellPrinting(lines: string[], code = 0): jest.Mock {
  return jest.fn(() => {
    const c = child()
    setImmediate(() => {
      for (const line of lines) c.stdout.emit('data', `${line}\n`)
      c.emit('close', code)
    })
    return c
  })
}

beforeEach(() => forgetUserPath())

describe('loginShellPath', () => {
  it('asks an INTERACTIVE login shell — a plain one cannot see Homebrew', async () => {
    // Measured: `zsh -lc` under the GUI PATH does not have /opt/homebrew/bin,
    // because brew shellenv lives in ~/.zshrc, which only `-i` reads.
    const spawnFn = shellPrinting(['FLOW_PATH=/opt/homebrew/bin:/usr/bin:/bin'])
    await expect(loginShellPath({ spawnFn: spawnFn as never })).resolves.toBe(
      '/opt/homebrew/bin:/usr/bin:/bin',
    )
    const [, args] = spawnFn.mock.calls[0] as [string, string[]]
    expect(args[0]).toBe('-ilc')
  })

  it('finds the PATH inside an interactive shell’s chatter', async () => {
    const spawnFn = shellPrinting([
      'Welcome back!',
      'A new release of your shell is available.',
      'FLOW_PATH=/opt/homebrew/bin:/usr/bin',
    ])
    await expect(loginShellPath({ spawnFn: spawnFn as never })).resolves.toBe(
      '/opt/homebrew/bin:/usr/bin',
    )
  })

  it('answers null rather than a half-answer when the shell says nothing usable', async () => {
    await expect(loginShellPath({ spawnFn: shellPrinting(['hello']) as never })).resolves.toBeNull()
    await expect(
      loginShellPath({ spawnFn: shellPrinting(['FLOW_PATH=']) as never }),
    ).resolves.toBeNull()
  })

  it('has no shell to ask on Windows', async () => {
    const spawnFn = shellPrinting(['FLOW_PATH=/x'])
    await expect(
      loginShellPath({ spawnFn: spawnFn as never, platform: 'win32' }),
    ).resolves.toBeNull()
    expect(spawnFn).not.toHaveBeenCalled()
  })

  it('gives up rather than hanging on a profile that never returns', async () => {
    jest.useFakeTimers()
    try {
      const hung = child()
      const done = loginShellPath({ spawnFn: (() => hung) as never, timeoutMs: 50 })
      jest.advanceTimersByTime(60)
      await expect(done).resolves.toBeNull()
      expect(hung.kill).toHaveBeenCalled()
    } finally {
      jest.useRealTimers()
    }
  })
})

describe('resolveUserPath / userPathEnv', () => {
  it('spawns ONE shell per session, however many tools ask', async () => {
    const spawnFn = shellPrinting(['FLOW_PATH=/opt/homebrew/bin:/usr/bin'])
    await resolveUserPath({ spawnFn: spawnFn as never })
    await resolveUserPath({ spawnFn: spawnFn as never })
    await userPathEnv({ spawnFn: spawnFn as never })
    expect(spawnFn).toHaveBeenCalledTimes(1)
  })

  it('does NOT cache a failure — a profile can be fixed while the app runs', async () => {
    const failing = shellPrinting(['nothing useful'])
    await resolveUserPath({ spawnFn: failing as never })
    await resolveUserPath({ spawnFn: failing as never })
    expect(failing).toHaveBeenCalledTimes(2)
  })

  it('hands back an env carrying the user’s PATH, not just the path', async () => {
    // An absolute path to the tool is not enough: copilot’s shebang needs
    // `node`, which the GUI PATH also lacks. The CHILD needs the whole PATH.
    const env = await userPathEnv({
      spawnFn: shellPrinting(['FLOW_PATH=/opt/homebrew/bin:/usr/bin']) as never,
    })
    expect(env?.PATH).toBe('/opt/homebrew/bin:/usr/bin')
  })

  it('answers null when the shell’s PATH is the one we already have', async () => {
    const same = process.env['PATH'] ?? ''
    const env = await userPathEnv({ spawnFn: shellPrinting([`FLOW_PATH=${same}`]) as never })
    expect(env).toBeNull()
  })
})
