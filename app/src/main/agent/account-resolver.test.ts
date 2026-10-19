// AccountResolver tests — resolution (override ?? default ?? legacy, dangling)
// and fail-closed availability with an injected fake auth probe.

import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { openDatabase, type FlowDatabase } from '../store/db'
import { AccountStore } from '../store/account-store'
import { AccountResolver, createClaudeAuthProbe, resolveClaudeBin, type AuthProbe } from './account-resolver'

jest.mock('node:child_process', () => ({
  ...jest.requireActual('node:child_process'),
  execFile: jest.fn(),
}))
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { execFile: mockedExecFile } = jest.requireMock('node:child_process') as {
  execFile: jest.Mock
}

describe('AccountResolver', () => {
  let tempDir: string
  let db: FlowDatabase
  let store: AccountStore

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'flow-resolver-'))
    db = openDatabase(join(tempDir, 'flow.sqlite'))
    store = new AccountStore(db)
  })

  afterEach(() => {
    db.close()
    rmSync(tempDir, { recursive: true, force: true })
  })

  const loggedInProbe: AuthProbe = async () => ({ loggedIn: true, identity: 'me@x' })
  const loggedOutProbe: AuthProbe = async () => ({ loggedIn: false })

  // ── Pure resolution ────────────────────────────────────────────────────

  it('resolves to legacy when nothing is configured', () => {
    const resolver = new AccountResolver(store, loggedInProbe)
    expect(resolver.resolve('/proj/x')).toEqual({ status: 'legacy' })
  })

  it('resolves to the default account when no override is set', () => {
    const a = store.createAccount({ label: 'Default', configDirPath: '/dir/a' })
    store.setDefaultAccountId(a.id)
    const resolver = new AccountResolver(store, loggedInProbe)
    expect(resolver.resolve('/proj/x')).toMatchObject({ status: 'ready', account: { id: a.id } })
  })

  it('reports WHERE the account came from — inherited default vs explicit pin (#1108)', () => {
    const def = store.createAccount({ label: 'Default', configDirPath: '/dir/def' })
    store.setDefaultAccountId(def.id)
    const resolver = new AccountResolver(store, loggedInProbe)
    // No override → the project merely FOLLOWS the default.
    expect(resolver.resolve('/proj/x')).toMatchObject({ status: 'ready', source: 'default' })
    // Pinning the very same account is a DIFFERENT stored state.
    store.setProjectAccountId('/proj/x', def.id)
    expect(resolver.resolve('/proj/x')).toMatchObject({ status: 'ready', source: 'override' })
  })

  it('override wins over the default', () => {
    const def = store.createAccount({ label: 'Default', configDirPath: '/dir/def' })
    const over = store.createAccount({ label: 'Override', configDirPath: '/dir/over' })
    store.setDefaultAccountId(def.id)
    store.setProjectAccountId('/proj/x', over.id)
    const resolver = new AccountResolver(store, loggedInProbe)
    expect(resolver.resolve('/proj/x')).toMatchObject({ status: 'ready', account: { id: over.id } })
  })

  it('flags a dangling override (points to a removed account)', () => {
    const a = store.createAccount({ label: 'Gone', configDirPath: '/dir/a' })
    store.setProjectAccountId('/proj/x', a.id)
    // Simulate the account row vanishing without cleanup.
    db.prepare('DELETE FROM accounts WHERE id = ?').run(a.id)
    const resolver = new AccountResolver(store, loggedInProbe)
    expect(resolver.resolve('/proj/x')).toMatchObject({ status: 'dangling', accountId: a.id })
  })

  // ── Fail-closed availability ───────────────────────────────────────────

  it('resolveForSession returns ready with identity when the account is logged in', async () => {
    const a = store.createAccount({ label: 'Acme', configDirPath: '/dir/a' })
    store.setDefaultAccountId(a.id)
    const resolver = new AccountResolver(store, loggedInProbe)
    await expect(resolver.resolveForSession('/proj/x')).resolves.toMatchObject({
      status: 'ready',
      account: { id: a.id },
      identity: 'me@x',
    })
  })

  it('resolveForSession fails closed (unavailable) when the account is logged out', async () => {
    const a = store.createAccount({ label: 'Acme', configDirPath: '/dir/a' })
    store.setDefaultAccountId(a.id)
    const resolver = new AccountResolver(store, loggedOutProbe)
    const result = await resolver.resolveForSession('/proj/x')
    expect(result.status).toBe('unavailable')
  })

  it('resolveForSession fails closed when the probe throws', async () => {
    const a = store.createAccount({ label: 'Acme', configDirPath: '/dir/a' })
    store.setDefaultAccountId(a.id)
    const throwingProbe: AuthProbe = async () => {
      throw new Error('claude not found')
    }
    const resolver = new AccountResolver(store, throwingProbe)
    const result = await resolver.resolveForSession('/proj/x')
    // A thrown probe observed NOTHING — the reason says the CHECK failed,
    // never "not logged in" (the 2026-07-27 false-lockout).
    expect(result).toMatchObject({ status: 'unavailable' })
    expect((result as { reason?: string }).reason).toContain('did not complete')
  })

  it('a failed probe within the grace window of a good one proceeds ready (transient tolerance)', async () => {
    const a = store.createAccount({ label: 'Acme', configDirPath: '/dir/a' })
    store.setDefaultAccountId(a.id)
    let call = 0
    const flaky: AuthProbe = async () => {
      call += 1
      if (call === 1) return { loggedIn: true, identity: 'me@acme.com' }
      return { loggedIn: false, probeFailed: true }
    }
    const resolver = new AccountResolver(store, flaky)
    expect(await resolver.resolveForSession('/proj/x')).toMatchObject({ status: 'ready' })
    // Fresh-cache skip: second resolve doesn't even probe.
    expect(await resolver.resolveForSession('/proj/x')).toMatchObject({ status: 'ready', identity: 'me@acme.com' })
    expect(call).toBe(1)
  })

  it('a VALID logged-out observation still fails closed', async () => {
    const a = store.createAccount({ label: 'Acme', configDirPath: '/dir/a' })
    store.setDefaultAccountId(a.id)
    const probe: AuthProbe = async () => ({ loggedIn: false })
    const resolver = new AccountResolver(store, probe)
    const result = await resolver.resolveForSession('/proj/x')
    expect(result).toMatchObject({ status: 'unavailable' })
    expect((result as { reason?: string }).reason).toContain('not logged in')
  })

  it('resolveForSession passes legacy through without probing', async () => {
    const probe: AuthProbe = async () => {
      throw new Error('should not be called for legacy')
    }
    const resolver = new AccountResolver(store, probe)
    await expect(resolver.resolveForSession('/proj/x')).resolves.toEqual({ status: 'legacy' })
  })
})

describe('createClaudeAuthProbe (#965 — exit code is not a verdict)', () => {
  beforeEach(() => mockedExecFile.mockReset())

  const arm = (error: Error | null, stdout: string): void => {
    mockedExecFile.mockImplementation(
      (_bin: string, _args: string[], _opts: unknown, cb: (e: Error | null, out: string) => void) =>
        cb(error, stdout),
    )
  }

  it('exit 1 + valid loggedIn:false JSON is an OBSERVED logout, not a failed probe', async () => {
    // `claude auth status` exits non-zero when logged out while still printing
    // the verdict — the exact shape from the live CLI (claude 2.1.204).
    arm(new Error('Command failed: exit 1'), '{"loggedIn": false, "authMethod": "none", "apiProvider": "firstParty"}')
    const result = await createClaudeAuthProbe('/fake/claude')('/dir/a')
    expect(result.loggedIn).toBe(false)
    expect(result.probeFailed).toBeUndefined()
  })

  it('a clean logged-in probe carries identity and no failure flag', async () => {
    arm(null, '{"loggedIn": true, "email": "me@acme.com", "orgName": "Acme"}')
    const result = await createClaudeAuthProbe('/fake/claude')('/dir/a')
    expect(result).toMatchObject({ loggedIn: true, identity: 'me@acme.com · Acme' })
    expect(result.probeFailed).toBeUndefined()
  })

  it('unparseable output IS a failed probe (timeout/spawn) — busy-machine tolerance preserved', async () => {
    arm(new Error('timeout'), '')
    const result = await createClaudeAuthProbe('/fake/claude')('/dir/a')
    expect(result).toMatchObject({ loggedIn: false, probeFailed: true })
  })

  it('parseable JSON WITHOUT a boolean verdict is a failed probe, not a logout', async () => {
    arm(null, '{"status": "weird"}')
    const result = await createClaudeAuthProbe('/fake/claude')('/dir/a')
    expect(result.loggedIn).toBe(false)
    expect(result.probeFailed).toBe(true)
  })
})

describe('resolveClaudeBin (B3 — the SDK binary is per-platform)', () => {
  // Which SDK platform package is actually installed depends on the HOST npm
  // ran on (they are optionalDependencies), so these cases assert the DECISION
  // — which package was asked for, and that a fallback names itself — never a
  // concrete resolved path, which would only pass on one machine.
  let warned: jest.SpyInstance

  beforeEach(() => {
    warned = jest.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    warned.mockRestore()
  })

  /** The package a call asked for: its resolved path, or the warning it logged. */
  function askedFor(result: string): string {
    return result === 'claude' ? String(warned.mock.calls[0]?.[0] ?? '') : result
  }

  it('asks for the win32 package on Windows — never the darwin one', () => {
    // The defect: `…-darwin-arm64/claude` was hardcoded, so on Windows this
    // threw and fell through to bare `claude`, which "worked" on the test host
    // only because Claude Code happened to be installed there separately.
    const asked = askedFor(resolveClaudeBin('win32', 'x64'))
    expect(asked).toContain('claude-agent-sdk-win32-x64')
    expect(asked).not.toContain('darwin')
    // Windows needs the .exe suffix — an extensionless name is not runnable.
    expect(asked).toContain('claude.exe')
  })

  it('still asks for the darwin package on macOS (unchanged behavior)', () => {
    const asked = askedFor(resolveClaudeBin('darwin', 'arm64'))
    expect(asked).toContain('claude-agent-sdk-darwin-arm64')
    expect(asked).not.toContain('claude.exe')
  })

  it('falls back to PATH and NAMES the platform when the SDK publishes none', () => {
    expect(resolveClaudeBin('sunos', 'sparc')).toBe('claude')
    expect(String(warned.mock.calls[0]?.[0])).toContain('sunos-sparc')
  })

  it('never falls back to PATH silently — every fallback logs (NFR5)', () => {
    const result = resolveClaudeBin('win32', 'arm64')
    if (result === 'claude') {
      expect(warned).toHaveBeenCalled()
      expect(String(warned.mock.calls[0]?.[0])).toContain('falling back to `claude` on PATH')
    } else {
      expect(warned).not.toHaveBeenCalled()
    }
  })
})
