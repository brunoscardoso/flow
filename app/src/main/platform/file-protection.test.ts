// Owner-only protection tests (B5).
//
// The Windows branch is asserted from a POSIX host by injecting the ACL runner
// (NFR3) — never by stubbing PATH or shelling out to a real `icacls`, which
// would make the result depend on what is installed on the machine.

import { mkdtempSync, rmSync, statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import {
  OWNER_ONLY_DIR_MODE,
  OWNER_ONLY_FILE_MODE,
  ownerOnlyAclCommand,
  protectionFailureMessage,
  protectOwnerOnly,
  windowsOwnerPrincipal,
  type AclCommand,
} from './file-protection'

const WINDOWS_PATH = 'C:\\Users\\me\\.flow\\credentials.json'
const WINDOWS_ENV = { USERNAME: 'me', USERDOMAIN: 'LAPTOP' } as NodeJS.ProcessEnv

/** Records every ACL command and answers with canned icacls output. */
function recordingRunner(output = 'Successfully processed 1 files; Failed processing 0 files\n'): {
  runAcl: (command: AclCommand) => string
  calls: AclCommand[]
} {
  const calls: AclCommand[] = []
  return {
    runAcl: (command: AclCommand): string => {
      calls.push(command)
      return output
    },
    calls,
  }
}

describe('windowsOwnerPrincipal', () => {
  it('qualifies the user with the domain when there is one', () => {
    expect(windowsOwnerPrincipal(WINDOWS_ENV)).toBe('LAPTOP\\me')
  })

  it('falls back to the bare user name', () => {
    expect(windowsOwnerPrincipal({ USERNAME: 'me' } as NodeJS.ProcessEnv)).toBe('me')
  })

  it('returns null rather than guessing when the user is unknown', () => {
    // Granting the wrong principal either locks the owner out or leaves the
    // file readable — both worse than a loud refusal.
    expect(windowsOwnerPrincipal({} as NodeJS.ProcessEnv)).toBeNull()
    expect(windowsOwnerPrincipal({ USERNAME: '  ' } as NodeJS.ProcessEnv)).toBeNull()
  })
})

describe('ownerOnlyAclCommand', () => {
  it('strips inheritance and replaces the grant in ONE invocation', () => {
    const command = ownerOnlyAclCommand(WINDOWS_PATH, 'LAPTOP\\me', 'file')

    expect(command.command).toBe('icacls')
    // /inheritance:r drops the ACEs inherited from the profile directory
    // (SYSTEM, Administrators, the user) — without it the "owner-only" ACL
    // still grants everyone the profile granted.
    expect(command.args).toEqual([
      WINDOWS_PATH,
      '/inheritance:r',
      '/grant:r',
      'LAPTOP\\me:(F)',
    ])
    // One call: there is never a window in which the path has no ACE at all.
    expect(command.args.filter((arg) => arg.startsWith('/grant'))).toHaveLength(1)
  })

  it('uses /grant:r (replace), never /grant (add)', () => {
    // /grant would accumulate ACEs across runs and is not idempotent.
    const args = ownerOnlyAclCommand(WINDOWS_PATH, 'me', 'file').args
    expect(args).toContain('/grant:r')
    expect(args).not.toContain('/grant')
  })

  it('adds object/container inheritance for a directory only', () => {
    expect(ownerOnlyAclCommand('C:\\dir', 'me', 'directory').args).toContain('me:(OI)(CI)F')
    expect(ownerOnlyAclCommand('C:\\file', 'me', 'file').args).toContain('me:(F)')
  })

  it('passes the path as argv, never as a shell string', () => {
    // A profile path with a space (`C:\Users\Jane Doe\...`) is the common case.
    const spaced = 'C:\\Users\\Jane Doe\\.flow\\credentials.json'
    expect(ownerOnlyAclCommand(spaced, 'me', 'file').args[0]).toBe(spaced)
  })
})

describe('protectOwnerOnly — POSIX branch', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'flow-protect-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('applies 0600 to a file and 0700 to a directory', () => {
    const file = join(dir, 'secret.json')
    writeFileSync(file, '{}', { encoding: 'utf8', mode: 0o644 })

    expect(protectOwnerOnly(file, { platform: 'darwin', kind: 'file' })).toEqual({
      applied: true,
      method: 'posix-mode',
    })
    expect(statSync(file).mode & 0o777).toBe(OWNER_ONLY_FILE_MODE)

    expect(protectOwnerOnly(dir, { platform: 'linux', kind: 'directory' })).toEqual({
      applied: true,
      method: 'posix-mode',
    })
    expect(statSync(dir).mode & 0o777).toBe(OWNER_ONLY_DIR_MODE)
  })

  it('never shells out on POSIX', () => {
    const file = join(dir, 'secret.json')
    writeFileSync(file, '{}', 'utf8')
    const { runAcl, calls } = recordingRunner()

    protectOwnerOnly(file, { platform: 'darwin', runAcl })

    expect(calls).toHaveLength(0)
  })

  it('reports a chmod failure instead of throwing', () => {
    const result = protectOwnerOnly(join(dir, 'missing.json'), { platform: 'darwin' })

    expect(result.applied).toBe(false)
    expect(result.method).toBe('posix-mode')
    expect(result.error).toBeTruthy()
  })
})

describe('protectOwnerOnly — Windows branch', () => {
  it('runs the owner-only icacls command', () => {
    const { runAcl, calls } = recordingRunner()

    const result = protectOwnerOnly(WINDOWS_PATH, {
      platform: 'win32',
      kind: 'file',
      env: WINDOWS_ENV,
      runAcl,
    })

    expect(result).toEqual({ applied: true, method: 'windows-acl' })
    expect(calls).toEqual([ownerOnlyAclCommand(WINDOWS_PATH, 'LAPTOP\\me', 'file')])
  })

  it('never chmods on Windows — the call would be a no-op that reads as protection', () => {
    const chmod = jest.fn()
    const { runAcl } = recordingRunner()

    protectOwnerOnly(WINDOWS_PATH, { platform: 'win32', env: WINDOWS_ENV, runAcl, chmod })

    expect(chmod).not.toHaveBeenCalled()
  })

  it('reports failure when icacls throws', () => {
    const result = protectOwnerOnly(WINDOWS_PATH, {
      platform: 'win32',
      env: WINDOWS_ENV,
      runAcl: () => {
        throw new Error('icacls: command not found')
      },
    })

    expect(result.applied).toBe(false)
    expect(result.method).toBe('windows-acl')
    expect(result.error).toContain('icacls: command not found')
  })

  it('reports failure when icacls exits 0 but processed nothing', () => {
    // icacls does not reliably exit non-zero on a failed path — the printed
    // counts are the only trustworthy signal.
    const result = protectOwnerOnly(WINDOWS_PATH, {
      platform: 'win32',
      env: WINDOWS_ENV,
      runAcl: () =>
        'C:\\...: Access is denied.\nSuccessfully processed 0 files; Failed processing 1 files\n',
    })

    expect(result.applied).toBe(false)
    expect(result.error).toContain('1 failed path')
  })

  it('accepts the success transcript with zero failures', () => {
    const result = protectOwnerOnly(WINDOWS_PATH, {
      platform: 'win32',
      env: WINDOWS_ENV,
      runAcl: () => 'Successfully processed 1 files; Failed processing 0 files\n',
    })

    expect(result.applied).toBe(true)
  })

  it('refuses rather than guessing when the Windows user is unknown', () => {
    const { runAcl, calls } = recordingRunner()

    const result = protectOwnerOnly(WINDOWS_PATH, {
      platform: 'win32',
      env: {} as NodeJS.ProcessEnv,
      runAcl,
    })

    expect(result.applied).toBe(false)
    expect(result.error).toContain('USERNAME')
    expect(calls).toHaveLength(0)
  })
})

describe('protectionFailureMessage', () => {
  it('names the path, and the consequence in the platform’s own terms', () => {
    const windows = protectionFailureMessage(WINDOWS_PATH, 'file', {
      applied: false,
      method: 'windows-acl',
      error: 'icacls exploded',
    })
    expect(windows).toContain(WINDOWS_PATH)
    expect(windows).toContain('other users on this machine may be able to read it')
    expect(windows).toContain('icacls exploded')

    const posix = protectionFailureMessage('/home/x/.flow', 'directory', {
      applied: false,
      method: 'posix-mode',
      error: 'EPERM',
    })
    expect(posix).toContain('not owner-only')
    expect(posix).toContain('directory')
  })
})
