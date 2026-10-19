import { EventEmitter } from 'events'

import {
  cancelRuntimeLogin,
  findLoginCode,
  findLoginUrl,
  loginCommand,
  startRuntimeLogin,
  type RuntimeLoginEvent,
} from './runtime-login'
import { forgetUserPath } from './tool-path'

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

beforeEach(() => {
  cancelRuntimeLogin()
  forgetUserPath()
})

describe('what each runtime’s sign-in runs', () => {
  it('asks Copilot for the DEVICE-CODE flow — a GUI app can show a code', () => {
    // Its default opens a browser itself against a loopback callback, which
    // leaves this panel with nothing to display if that browser never appears.
    expect(loginCommand('copilot')).toEqual({
      command: 'copilot',
      args: ['login', '--device-code'],
    })
    expect(loginCommand('codex')).toEqual({ command: 'codex', args: ['login'] })
  })

  it('has nothing to run for Claude — that login is Flow’s own', () => {
    expect(loginCommand('claude')).toBeNull()
  })
})

describe('reading what the tool printed', () => {
  it('finds the URL and code in Copilot’s real device-code line', () => {
    // Captured live: `copilot login --device-code`.
    const real = 'To authenticate, visit https://github.com/login/device and enter code 6CB7-0989\n'
    expect(findLoginUrl(real)).toBe('https://github.com/login/device')
    expect(findLoginCode(real)).toBe('6CB7-0989')
  })

  it('does not swallow trailing punctuation into the link', () => {
    expect(findLoginUrl('open https://example.com/auth.')).toBe('https://example.com/auth')
  })

  it('answers null rather than guessing when there is nothing to find', () => {
    expect(findLoginUrl('Waiting for authorization...')).toBeNull()
    expect(findLoginCode('Waiting for authorization...')).toBeNull()
  })
})

describe('startRuntimeLogin', () => {
  it('relays the URL and code, then the tool’s own verdict', async () => {
    const child = makeChild()
    const events: RuntimeLoginEvent[] = []
    const done = startRuntimeLogin('copilot', (event) => events.push(event), {
      spawnFn: (() => child) as never,
    })
    await new Promise((r) => setImmediate(r))
    child.stdout.emit(
      'data',
      'To authenticate, visit https://github.com/login/device and enter code 6CB7-0989\n',
    )
    child.stdout.emit('data', 'Waiting for authorization...\n')
    child.emit('close', 0)
    await expect(done).resolves.toEqual({ ok: true })
    expect(events.map((e) => e.kind)).toEqual(expect.arrayContaining(['url', 'code', 'done']))
    expect(events.find((e) => e.kind === 'url')?.url).toBe('https://github.com/login/device')
    expect(events.find((e) => e.kind === 'code')?.code).toBe('6CB7-0989')
  })

  it('fails on a non-zero exit with a CLASSIFIED reason, never the tool’s words', async () => {
    const child = makeChild()
    const done = startRuntimeLogin('copilot', () => undefined, { spawnFn: (() => child) as never })
    await new Promise((r) => setImmediate(r))
    child.stderr.emit('data', 'device code expired\n')
    child.emit('close', 1)
    await expect(done).resolves.toEqual({ ok: false, reason: 'failed' })
  })

  it('calls a config parse failure what it is — the login never started', async () => {
    // Live on this machine: `codex login` on codex-cli 0.19.0 prints
    //   Error loading configuration: unknown variant `xhigh`, …
    //   in `model_reasoning_effort`
    // and the second line is what the user was shown as their sign-in result.
    const child = makeChild()
    const done = startRuntimeLogin('codex', () => undefined, { spawnFn: (() => child) as never })
    await new Promise((r) => setImmediate(r))
    child.stderr.emit(
      'data',
      'Error loading configuration: unknown variant `xhigh`, expected one of `low`, `medium`, `high`, `none`\nin `model_reasoning_effort`\n',
    )
    child.emit('close', 1)
    await expect(done).resolves.toEqual({ ok: false, reason: 'config-unreadable' })
  })

  it('refuses a second login while one is running — one OAuth at a time', async () => {
    const child = makeChild()
    const first = startRuntimeLogin('copilot', () => undefined, {
      spawnFn: (() => child) as never,
    })
    await new Promise((r) => setImmediate(r))
    await expect(
      startRuntimeLogin('codex', () => undefined, { spawnFn: (() => makeChild()) as never }),
    ).resolves.toEqual({ ok: false, reason: 'failed' })
    child.emit('close', 0)
    await first
  })

  it('cancel kills the child — an abandoned OAuth must not hold the slot', async () => {
    const child = makeChild()
    const done = startRuntimeLogin('copilot', () => undefined, {
      spawnFn: (() => child) as never,
    })
    await new Promise((r) => setImmediate(r))
    cancelRuntimeLogin()
    expect(child.kill).toHaveBeenCalledWith('SIGKILL')
    child.emit('close', null)
    // Cancelling is not failing — the sentence a person reads differs.
    await expect(done).resolves.toEqual({ ok: false, reason: 'cancelled' })
    // …and the slot is free again.
    const second = makeChild()
    const next = startRuntimeLogin('codex', () => undefined, { spawnFn: (() => second) as never })
    await new Promise((r) => setImmediate(r))
    second.emit('close', 0)
    await expect(next).resolves.toMatchObject({ ok: true })
  })

  it('has nothing to run for a runtime it cannot sign in', async () => {
    await expect(startRuntimeLogin('claude', () => undefined)).resolves.toEqual({
      ok: false,
      reason: 'failed',
    })
  })

  it('retries with the user’s PATH before giving up on a GUI-launched app', async () => {
    // Same blind spot as the probes: /usr/bin:/bin:/usr/sbin:/sbin cannot see
    // /opt/homebrew/bin, where the tool actually is.
    let call = 0
    const login = makeChild()
    const spawnFn = jest.fn(() => {
      call += 1
      const step = call
      if (step === 1) {
        const first = makeChild()
        setImmediate(() => first.emit('error', new Error('spawn copilot ENOENT')))
        return first
      }
      if (step === 2) {
        const shell = makeChild()
        setImmediate(() => {
          shell.stdout.emit('data', 'FLOW_PATH=/opt/homebrew/bin:/usr/bin\n')
          shell.emit('close', 0)
        })
        return shell
      }
      setImmediate(() => login.emit('close', 0))
      return login
    })
    await expect(
      startRuntimeLogin('copilot', () => undefined, { spawnFn: spawnFn as never }),
    ).resolves.toEqual({ ok: true })
    const options = (spawnFn.mock.calls[2] as unknown[])[2] as { env?: NodeJS.ProcessEnv }
    expect(options.env?.PATH).toBe('/opt/homebrew/bin:/usr/bin')
  })
})
