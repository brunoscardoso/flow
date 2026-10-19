// LoginOrchestrator tests — the non-interactive surface: config-dir allocation,
// teardown, and probe delegation — plus the interactive login()'s child-process
// protocol (#972) against a FAKE spawned child: progress detection (url /
// awaiting-code), submitCode → stdin, cancelLogin, and single-flight refusal.
// The real `claude auth login` (a browser OAuth) is never run here.

import { EventEmitter } from 'events'
import { existsSync, mkdtempSync, rmSync, statSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import type { AuthProbe } from './account-resolver'
import { LoginOrchestrator, type LoginProgress } from './login-orchestrator'

jest.mock('node:child_process', () => ({
  ...jest.requireActual('node:child_process'),
  spawn: jest.fn(),
}))
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { spawn: mockedSpawn } = jest.requireMock('node:child_process') as {
  spawn: jest.Mock
}

interface FakeChild extends EventEmitter {
  stdout: EventEmitter & { setEncoding: jest.Mock }
  stderr: EventEmitter & { setEncoding: jest.Mock }
  stdin: { write: jest.Mock }
  kill: jest.Mock
}

function makeFakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild
  child.stdout = Object.assign(new EventEmitter(), { setEncoding: jest.fn() })
  child.stderr = Object.assign(new EventEmitter(), { setEncoding: jest.fn() })
  child.stdin = { write: jest.fn() }
  child.kill = jest.fn()
  return child
}

describe('LoginOrchestrator', () => {
  let accountsDir: string

  beforeEach(() => {
    accountsDir = mkdtempSync(join(tmpdir(), 'flow-login-orch-'))
    mockedSpawn.mockReset()
  })

  afterEach(() => {
    rmSync(accountsDir, { recursive: true, force: true })
  })

  it('allocateConfigDir creates an isolated per-account dir under accountsDir', () => {
    const orch = new LoginOrchestrator({ accountsDir })
    const dir = orch.allocateConfigDir('acct-1')
    expect(existsSync(dir)).toBe(true)
    expect(dir.startsWith(accountsDir)).toBe(true)
    expect(dir.endsWith('acct-1')).toBe(true)
  })

  it('two accounts get distinct config dirs', () => {
    const orch = new LoginOrchestrator({ accountsDir })
    expect(orch.allocateConfigDir('a')).not.toBe(orch.allocateConfigDir('b'))
  })

  // ── B5: the config dir holds a live session — protect it like a secret ──

  it('allocateConfigDir is owner-only by mode on POSIX', () => {
    const orch = new LoginOrchestrator({ accountsDir })
    const dir = orch.allocateConfigDir('acct-mode')

    expect(statSync(dir).mode & 0o777).toBe(0o700)
    expect(orch.protectionWarning()).toBeNull()
  })

  it('allocateConfigDir applies owner-only protection to the DIRECTORY', () => {
    // On Windows `mkdirSync`'s mode is ignored outright, so the explicit
    // protection call — not the mode — is what makes the dir private there.
    const calls: { target: string; kind: string }[] = []
    const orch = new LoginOrchestrator({
      accountsDir,
      protect: (target, kind) => {
        calls.push({ target, kind })
        return { applied: true, method: 'windows-acl' }
      },
    })

    const dir = orch.allocateConfigDir('acct-acl')

    expect(calls).toEqual([{ target: dir, kind: 'directory' }])
    expect(orch.protectionWarning()).toBeNull()
  })

  it('SAYS SO when the config dir could not be protected, and still signs in (NFR5)', () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined)
    const orch = new LoginOrchestrator({
      accountsDir,
      protect: () => ({ applied: false, method: 'windows-acl', error: 'icacls: Access is denied.' }),
    })

    const dir = orch.allocateConfigDir('acct-open')

    // The dir is still usable — refusing to sign in at all is the worse
    // failure — but the exposure is named rather than swallowed.
    expect(existsSync(dir)).toBe(true)
    const warning = orch.protectionWarning()
    expect(warning).toContain(dir)
    expect(warning).toContain('other users on this machine may be able to read it')
    expect(errorSpy.mock.calls.flat().join(' ')).toContain('SECURITY')
    errorSpy.mockRestore()
  })

  it('removeConfigDir deletes the dir and tolerates a missing one', () => {
    const orch = new LoginOrchestrator({ accountsDir })
    const dir = orch.allocateConfigDir('acct-2')
    orch.removeConfigDir(dir)
    expect(existsSync(dir)).toBe(false)
    expect(() => orch.removeConfigDir(dir)).not.toThrow()
  })

  it('verify delegates to the injected auth probe', async () => {
    const probe: AuthProbe = async (dir) => ({
      loggedIn: dir.includes('yes'),
      identity: 'x@y · Org',
    })
    const orch = new LoginOrchestrator({ accountsDir, probe })
    await expect(orch.verify('/tmp/yes')).resolves.toEqual({
      loggedIn: true,
      identity: 'x@y · Org',
    })
    await expect(orch.verify('/tmp/no')).resolves.toEqual({
      loggedIn: false,
      identity: 'x@y · Org',
    })
  })

  // ── Interactive login protocol (#972) ──────────────────────────────────

  const loggedInProbe: AuthProbe = async () => ({ loggedIn: true, identity: 'me@x · Org' })

  function makeOrchestrator(probe: AuthProbe = loggedInProbe): {
    orch: LoginOrchestrator
    child: FakeChild
  } {
    const child = makeFakeChild()
    mockedSpawn.mockReturnValue(child)
    const orch = new LoginOrchestrator({ accountsDir, claudeBin: '/fake/claude', probe })
    return { orch, child }
  }

  it('spawns with stdin OPEN (pipe) so the auth code can reach the child', async () => {
    const { orch, child } = makeOrchestrator()
    const pending = orch.login('/tmp/dir')
    expect(mockedSpawn).toHaveBeenCalledWith(
      '/fake/claude',
      ['auth', 'login'],
      expect.objectContaining({ stdio: ['pipe', 'pipe', 'pipe'] }),
    )
    child.emit('exit', 0)
    await expect(pending).resolves.toEqual({ completed: true, identity: 'me@x · Org' })
  })

  it('emits url progress ONCE from the first https URL on stdout', async () => {
    const { orch, child } = makeOrchestrator()
    const progress: LoginProgress[] = []
    const pending = orch.login('/tmp/dir', (p) => progress.push(p))
    child.stdout.emit('data', 'Opening browser to sign in…\n')
    child.stdout.emit(
      'data',
      "If the browser didn't open, visit: https://claude.com/oauth/authorize?code=true\n",
    )
    child.stdout.emit('data', 'visit again: https://other.example/second\n')
    expect(progress).toEqual([
      { kind: 'url', url: 'https://claude.com/oauth/authorize?code=true' },
    ])
    child.emit('exit', 0)
    await pending
  })

  // The CLI prints the URL as an OSC 8 hyperlink whenever it believes the
  // terminal supports one — reproduced on Windows with WT_SESSION set, which
  // an Electron app inherits when launched from a terminal. \S+ has no
  // whitespace to stop at inside the escape, so the captured "url" was the
  // escape bytes plus the address twice over, and that string is what the
  // fallback link and shell.openExternal were handed.
  it('captures the bare URL when the CLI wraps it in an OSC 8 hyperlink', async () => {
    const { orch, child } = makeOrchestrator()
    const progress: LoginProgress[] = []
    const pending = orch.login('/tmp/dir', (p) => progress.push(p))
    const url = 'https://claude.com/oauth/authorize?code=true'
    child.stdout.emit(
      'data',
      `If the browser didn't open, visit: \u001b]8;;${url}\u0007${url}\u001b]8;;\u0007\n`,
    )
    expect(progress).toEqual([{ kind: 'url', url }])
    child.emit('exit', 0)
    await pending
  })

  it('sees the paste-code prompt through surrounding colour codes', async () => {
    const { orch, child } = makeOrchestrator()
    const progress: LoginProgress[] = []
    const pending = orch.login('/tmp/dir', (p) => progress.push(p))
    child.stdout.emit('data', `visit: https://claude.com/oauth/authorize?code=true\n`)
    child.stdout.emit('data', `\u001b[1mPaste code here if prompted\u001b[0m > `)
    expect(progress).toEqual([
      { kind: 'url', url: 'https://claude.com/oauth/authorize?code=true' },
      { kind: 'awaiting-code' },
    ])
    child.emit('exit', 0)
    await pending
  })

  it('emits awaiting-code ONCE when the paste-code prompt appears', async () => {
    const { orch, child } = makeOrchestrator()
    const progress: LoginProgress[] = []
    const pending = orch.login('/tmp/dir', (p) => progress.push(p))
    child.stdout.emit('data', 'visit: https://claude.com/oauth\n')
    child.stdout.emit('data', 'Paste code here if prompted > ')
    child.stdout.emit('data', ' ')
    expect(progress).toEqual([
      { kind: 'url', url: 'https://claude.com/oauth' },
      { kind: 'awaiting-code' },
    ])
    child.emit('exit', 0)
    await pending
  })

  it('detects the prompt on stderr too (combined-output scan)', async () => {
    const { orch, child } = makeOrchestrator()
    const progress: LoginProgress[] = []
    const pending = orch.login('/tmp/dir', (p) => progress.push(p))
    child.stderr.emit('data', 'visit: https://claude.com/oauth\nPaste code here if prompted > ')
    expect(progress).toEqual([
      { kind: 'url', url: 'https://claude.com/oauth' },
      { kind: 'awaiting-code' },
    ])
    child.emit('exit', 0)
    await pending
  })

  it('submitCode writes the trimmed code + newline to the child stdin', async () => {
    const { orch, child } = makeOrchestrator()
    const pending = orch.login('/tmp/dir')
    expect(orch.submitCode('  my-auth-code  ')).toBe(true)
    expect(child.stdin.write).toHaveBeenCalledWith('my-auth-code\n')
    child.emit('exit', 0)
    await pending
  })

  it('submitCode refuses a blank code and refuses when no login is active', async () => {
    const { orch, child } = makeOrchestrator()
    expect(orch.submitCode('code-before-login')).toBe(false)
    const pending = orch.login('/tmp/dir')
    expect(orch.submitCode('   ')).toBe(false)
    expect(child.stdin.write).not.toHaveBeenCalled()
    child.emit('exit', 0)
    await pending
    expect(orch.submitCode('code-after-exit')).toBe(false)
  })

  it('cancelLogin SIGTERMs the child and resolves the login as canceled', async () => {
    const { orch, child } = makeOrchestrator()
    const pending = orch.login('/tmp/dir')
    expect(orch.cancelLogin()).toBe(true)
    expect(child.kill).toHaveBeenCalledWith('SIGTERM')
    await expect(pending).resolves.toEqual({ completed: false, error: 'sign-in canceled' })
    // No login active anymore.
    expect(orch.cancelLogin()).toBe(false)
  })

  it('cancelLogin returns false when nothing is in flight', () => {
    const { orch } = makeOrchestrator()
    expect(orch.cancelLogin()).toBe(false)
  })

  it('refuses a second concurrent login without spawning', async () => {
    const { orch, child } = makeOrchestrator()
    const first = orch.login('/tmp/dir')
    await expect(orch.login('/tmp/other')).resolves.toEqual({
      completed: false,
      error: 'another sign-in is already in progress',
    })
    expect(mockedSpawn).toHaveBeenCalledTimes(1)
    child.emit('exit', 0)
    await first
    // After the first settles, a new login may spawn again.
    const { child: second } = { child: makeFakeChild() }
    mockedSpawn.mockReturnValue(second)
    const next = orch.login('/tmp/dir')
    expect(mockedSpawn).toHaveBeenCalledTimes(2)
    second.emit('exit', 0)
    await next
  })

  it('probe still decides success: logged-out probe fails the login after exit', async () => {
    const loggedOut: AuthProbe = async () => ({ loggedIn: false })
    const { orch, child } = makeOrchestrator(loggedOut)
    const pending = orch.login('/tmp/dir')
    child.emit('exit', 0)
    await expect(pending).resolves.toEqual({
      completed: false,
      error: 'login did not complete (still logged out)',
    })
  })

  it('times out after 5 minutes with a message that names the missing code', async () => {
    jest.useFakeTimers()
    try {
      const { orch, child } = makeOrchestrator()
      const pending = orch.login('/tmp/dir')
      jest.advanceTimersByTime(5 * 60_000)
      expect(child.kill).toHaveBeenCalledWith('SIGTERM')
      await expect(pending).resolves.toEqual({
        completed: false,
        error: 'sign-in timed out after 5 minutes — the pasted code never arrived',
      })
    } finally {
      jest.useRealTimers()
    }
  })

  it('spawn error surfaces as the login failure', async () => {
    const { orch, child } = makeOrchestrator()
    const pending = orch.login('/tmp/dir')
    child.emit('error', new Error('spawn claude ENOENT'))
    await expect(pending).resolves.toEqual({ completed: false, error: 'spawn claude ENOENT' })
  })
})
