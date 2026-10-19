import { EventEmitter } from 'events'

import { canSignOut, logoutCommand, signOutRuntime } from './runtime-logout'
import { markRuntimeAuthFailure, resetRuntimeAuthFailures, runtimeAuthFailedAt } from './runtime-auth-state'
import { forgetUserPath } from './tool-path'

function child(): EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill: jest.Mock } {
  return Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    kill: jest.fn(),
  })
}

beforeEach(() => {
  resetRuntimeAuthFailures()
  forgetUserPath()
})

describe('who can be signed out', () => {
  it('runs Codex’s own command', () => {
    expect(logoutCommand('codex')).toEqual({ command: 'codex', args: ['logout'] })
    expect(canSignOut('codex')).toBe(true)
  })

  it('has no COMMAND for Copilot, and signs it out another way', () => {
    // Measured: `copilot logout` answers "Invalid command format". Its login is
    // a keychain item plus a record in ~/.copilot/config.json, so Flow removes
    // those — announced in the confirmation, never silently.
    expect(logoutCommand('copilot')).toBeNull()
    expect(canSignOut('copilot')).toBe(true)
  })

  it('offers nothing for Claude, whose accounts are Flow’s own', () => {
    expect(canSignOut('claude')).toBe(false)
  })
})

describe('signOutRuntime', () => {
  it('succeeds on a clean exit and forgets any refusal', async () => {
    markRuntimeAuthFailure('codex', 1)
    const c = child()
    const done = signOutRuntime('codex', { spawnFn: (() => c) as never })
    await new Promise((r) => setImmediate(r))
    c.stdout.emit('data', 'Successfully logged out\n')
    c.emit('close', 0)
    await expect(done).resolves.toEqual({ ok: true, detail: 'Successfully logged out' })
    expect(runtimeAuthFailedAt('codex')).toBeNull()
  })

  it('reports a refusal with the tool’s own words', async () => {
    const c = child()
    const done = signOutRuntime('codex', { spawnFn: (() => c) as never })
    await new Promise((r) => setImmediate(r))
    c.stderr.emit('data', 'not logged in\n')
    c.emit('close', 1)
    await expect(done).resolves.toEqual({ ok: false, detail: 'not logged in' })
  })

  it('answers rather than throwing for a runtime it cannot sign out', async () => {
    await expect(signOutRuntime('claude')).resolves.toMatchObject({ ok: false })
  })
})

describe('signing out of Copilot removes what it stored', () => {
  it('forgets the keychain item, then the record', async () => {
    const order: string[] = []
    const result = await signOutRuntime('copilot', {
      forgetKeychainFn: async (service) => {
        order.push(`keychain:${service}`)
        return { ok: true, absent: false, detail: '' }
      },
      clearCopilotRecordFn: () => {
        order.push('record')
        return { ok: true, detail: '' }
      },
    })
    expect(result.ok).toBe(true)
    // The keychain item is what the CLI authenticates with; the record is what
    // says who is signed in. Order matters, and so does doing both.
    expect(order).toEqual(['keychain:copilot-cli', 'record'])
  })

  it('STOPS if the credential could not be removed', async () => {
    // Clearing only the record would leave Flow saying "signed out" about a CLI
    // that is still perfectly logged in.
    const clear = jest.fn(() => ({ ok: true, detail: '' }))
    const result = await signOutRuntime('copilot', {
      forgetKeychainFn: async () => ({ ok: false, absent: false, detail: 'keychain refused' }),
      clearCopilotRecordFn: clear,
    })
    expect(result).toEqual({ ok: false, detail: 'keychain refused' })
    expect(clear).not.toHaveBeenCalled()
  })

  it('treats "nothing stored" as already signed out', async () => {
    const result = await signOutRuntime('copilot', {
      forgetKeychainFn: async () => ({ ok: false, absent: true, detail: 'could not be found' }),
      clearCopilotRecordFn: () => ({ ok: true, detail: '' }),
    })
    expect(result.ok).toBe(true)
  })

  it('fails honestly when the record cannot be cleared', async () => {
    const result = await signOutRuntime('copilot', {
      forgetKeychainFn: async () => ({ ok: true, absent: false, detail: '' }),
      clearCopilotRecordFn: () => ({ ok: false, detail: 'file is read-only' }),
    })
    expect(result).toEqual({ ok: false, detail: 'file is read-only' })
  })
})

describe('the destructive path cannot be reached by accident', () => {
  it('refuses a Copilot sign-out that nobody confirmed', async () => {
    // THIS TEST EXISTS BECAUSE IT HAPPENED. An earlier version of the suite
    // called signOutRuntime('copilot') with no injected deps, and the default
    // implementation deleted the keychain item and rewrote the config file of
    // the machine running the tests. A function whose default behaviour
    // destroys something must not be reachable without a person's yes.
    await expect(signOutRuntime('copilot')).resolves.toEqual({
      ok: false,
      detail: 'Signing out of Copilot needs an explicit confirmation.',
    })
  })

  it('proceeds when the caller carries the confirmation', async () => {
    const result = await signOutRuntime('copilot', {
      confirmed: true,
      forgetKeychainFn: async () => ({ ok: true, absent: false, detail: '' }),
      clearCopilotRecordFn: () => ({ ok: true, detail: '' }),
    })
    expect(result.ok).toBe(true)
  })
})
