import { EventEmitter } from 'events'

import { checkRuntimeAuth, runtimeSelectable } from './runtime-auth'
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

/** A spawn that plays a scripted answer per call. */
function scripted(
  steps: Array<(child: ReturnType<typeof makeChild>, command: string) => void>,
): jest.Mock {
  let call = 0
  return jest.fn((command: string) => {
    const child = makeChild()
    const step = steps[call]
    call += 1
    setImmediate(() => step?.(child, command))
    return child
  })
}

const says = (text: string, code: number) =>
  (child: ReturnType<typeof makeChild>): void => {
    child.stdout.emit('data', text)
    child.emit('close', code)
  }
const enoent = (child: ReturnType<typeof makeChild>): void => {
  child.emit('error', new Error('spawn ENOENT'))
}

beforeEach(() => forgetUserPath())

describe('checkRuntimeAuth — claude answers from Flow’s own store', () => {
  it('is ready when an account exists, and spawns nothing to find out', async () => {
    const spawnFn = scripted([])
    const result = await checkRuntimeAuth('claude', {
      spawnFn: spawnFn as never,
      claudeAccountCount: () => 2,
    })
    expect(result.status).toBe('ready')
    expect(spawnFn).not.toHaveBeenCalled()
  })

  it('is not signed in when there are no accounts', async () => {
    const result = await checkRuntimeAuth('claude', { claudeAccountCount: () => 0 })
    expect(result.status).toBe('not-signed-in')
    expect(runtimeSelectable(result)).toBe(false)
  })
})

describe('checkRuntimeAuth — the external runtimes', () => {
  const installed = says('1.0.80\n', 0)

  it('is ready when the tool is there AND its credential file says so', () => {
    return expect(
      checkRuntimeAuth('copilot', {
        spawnFn: scripted([installed]) as never,
        readCredentialsFn: () => ({ signedIn: true, identity: 'dev' }),
      }),
    ).resolves.toEqual({ provider: 'copilot', status: 'ready', detail: 'dev' })
  })

  it('is not-signed-in when the tool is there and no login was saved', async () => {
    const result = await checkRuntimeAuth('codex', {
      spawnFn: scripted([installed]) as never,
      readCredentialsFn: () => ({ signedIn: false }),
    })
    expect(result.status).toBe('not-signed-in')
    expect(runtimeSelectable(result)).toBe(false)
  })

  it('NEVER asks the CLI whether it is signed in — a config error is not a logout', async () => {
    // codex-cli 0.19.0 with a newer config key exits 1 from `login status`
    // while the user is signed in. The version probe does not read that file,
    // and the answer comes from auth.json, so the whole failure mode is gone.
    const spawnFn = scripted([installed])
    const result = await checkRuntimeAuth('codex', {
      spawnFn: spawnFn as never,
      readCredentialsFn: () => ({ signedIn: true }),
    })
    expect(result.status).toBe('ready')
    const [, args] = spawnFn.mock.calls[0] as [string, string[]]
    expect(args).toEqual(['--version'])
  })

  it('does not consult credentials for a tool that is not installed', async () => {
    const read = jest.fn(() => ({ signedIn: true }))
    const result = await checkRuntimeAuth('copilot', {
      spawnFn: scripted([enoent, says('FLOW_PATH=/usr/bin\n', 0), enoent]) as never,
      readCredentialsFn: read,
    })
    expect(result.status).toBe('not-installed')
    expect(read).not.toHaveBeenCalled()
  })
})

describe('checkRuntimeAuth — a version probe that fails for another reason', () => {
  it('is unknown, not a verdict about the user’s login', async () => {
    const result = await checkRuntimeAuth('copilot', {
      spawnFn: scripted([
        (child) => child.emit('error', new Error('EACCES: permission denied')),
      ]) as never,
      readCredentialsFn: () => ({ signedIn: true }),
    })
    expect(result.status).toBe('unknown')
  })
})

describe('a credential the runtime just refused is not a sign-in', () => {
  it('reports not-signed-in even though the file is full of tokens', async () => {
    // Measured live: "Failed to refresh token: 401 Unauthorized" on every turn,
    // while ~/.codex/auth.json still held a complete token set and Settings
    // showed a green tick.
    const result = await checkRuntimeAuth('codex', {
      spawnFn: scripted([says('0.19.0\n', 0)]) as never,
      readCredentialsFn: () => ({ signedIn: true, identity: 'acct_1' }),
      authFailedAtFn: () => 1_700_000_000_000,
    })
    expect(result.status).toBe('not-signed-in')
    expect(result.detail).toContain('sign in again')
  })

  it('trusts the file again once nothing has been refused', async () => {
    const result = await checkRuntimeAuth('codex', {
      spawnFn: scripted([says('0.19.0\n', 0)]) as never,
      readCredentialsFn: () => ({ signedIn: true, identity: 'acct_1' }),
      authFailedAtFn: () => null,
    })
    expect(result.status).toBe('ready')
  })
})
