// CredentialsManager tests — temp-dir credentials file per test; verifies
// the 0600 mode invariant (on write AND load-repair), merge semantics, and
// the never-throws contract on corrupt/missing files.
//
// B5 added a second branch: on Windows `chmod` is a no-op that reads as
// protection, so the file is restricted with an explicit ACL instead. That
// branch is exercised here by INJECTING the protect function (NFR3) — the
// POSIX branch keeps running the real `chmodSync` and asserting real modes, so
// macOS behaviour stays pinned rather than mocked away (NFR1).

import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { CredentialsManager, type ProtectFn } from './credentials'
import type { ProtectionKind, ProtectionResult } from './platform/file-protection'

function fileMode(path: string): number {
  return statSync(path).mode & 0o777
}

describe('CredentialsManager', () => {
  let tempDir: string
  let filePath: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'flow-credentials-'))
    filePath = join(tempDir, '.flow', 'credentials.json')
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
    jest.restoreAllMocks()
  })

  // ── 0600 mode invariant ──────────────────────────────────────────────

  it('writes the file with mode 0600 (creating parent dirs on demand)', () => {
    const manager = new CredentialsManager(filePath)
    manager.set('anthropic', { apiKey: 'sk-test' })

    expect(existsSync(filePath)).toBe(true)
    expect(fileMode(filePath)).toBe(0o600)
  })

  it('keeps mode 0600 on rewrite of an existing file', () => {
    const manager = new CredentialsManager(filePath)
    manager.set('anthropic', { apiKey: 'sk-test' })
    manager.set('github', { personalAccessToken: 'ghp-test' })

    expect(fileMode(filePath)).toBe(0o600)
  })

  it('re-tightens a loosened file to 0600 on load', () => {
    const manager = new CredentialsManager(filePath)
    manager.set('anthropic', { apiKey: 'sk-test' })

    // Simulate a manual edit that left the file world-readable.
    chmodSync(filePath, 0o644)
    expect(fileMode(filePath)).toBe(0o644)

    // A fresh manager (no warm cache) repairs permissions on first read.
    const fresh = new CredentialsManager(filePath)
    fresh.get('anthropic')
    expect(fileMode(filePath)).toBe(0o600)
  })

  // ── set / get / delete / listServices ────────────────────────────────

  it('set merges fields with existing credentials for the service', () => {
    const manager = new CredentialsManager(filePath)
    manager.set('anthropic', { apiKey: 'sk-old', org: 'acme' })
    manager.set('anthropic', { apiKey: 'sk-new' })

    expect(manager.get('anthropic')).toEqual({ apiKey: 'sk-new', org: 'acme' })
  })

  it('get returns null for an unconfigured service', () => {
    const manager = new CredentialsManager(filePath)
    manager.set('anthropic', { apiKey: 'sk-test' })
    expect(manager.get('github')).toBeNull()
  })

  it('delete removes a service and is a no-op when absent', () => {
    const manager = new CredentialsManager(filePath)
    manager.set('anthropic', { apiKey: 'sk-test' })
    manager.set('github', { personalAccessToken: 'ghp-test' })

    manager.delete('anthropic')
    expect(manager.get('anthropic')).toBeNull()
    expect(manager.listServices()).toEqual(['github'])

    expect(() => manager.delete('never-existed')).not.toThrow()
    expect(manager.listServices()).toEqual(['github'])
  })

  it('delete persists across manager instances', () => {
    const manager = new CredentialsManager(filePath)
    manager.set('anthropic', { apiKey: 'sk-test' })
    manager.delete('anthropic')

    const fresh = new CredentialsManager(filePath)
    expect(fresh.get('anthropic')).toBeNull()
  })

  it('listServices returns names only', () => {
    const manager = new CredentialsManager(filePath)
    expect(manager.listServices()).toEqual([])

    manager.set('anthropic', { apiKey: 'sk-test' })
    manager.set('github', { personalAccessToken: 'ghp-test' })
    expect(manager.listServices().sort()).toEqual(['anthropic', 'github'])
  })

  // ── Never-throws contract ────────────────────────────────────────────

  it('never throws when the file is missing', () => {
    const manager = new CredentialsManager(filePath)
    expect(manager.get('anthropic')).toBeNull()
    expect(manager.listServices()).toEqual([])
  })

  it('never throws on a corrupt file — degrades to an empty store', () => {
    const manager = new CredentialsManager(filePath)
    manager.set('seed', { value: 1 }) // creates the parent dir + file
    // Replace the file with real garbage.
    writeFileSync(filePath, '{ not json !!!', 'utf8')

    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined)
    const fresh = new CredentialsManager(filePath)
    expect(fresh.get('seed')).toBeNull()
    expect(fresh.listServices()).toEqual([])
    expect(errorSpy).toHaveBeenCalled()

    // The store still works for new writes after corruption.
    fresh.set('anthropic', { apiKey: 'sk-recovered' })
    expect(fresh.get('anthropic')).toEqual({ apiKey: 'sk-recovered' })
  })

  it('tolerates a valid-JSON file missing the services field', () => {
    const manager = new CredentialsManager(filePath)
    manager.set('seed', { value: 1 })
    writeFileSync(filePath, '{"version": 1}', 'utf8')

    const fresh = new CredentialsManager(filePath)
    expect(fresh.listServices()).toEqual([])
  })

  // ── Version field ────────────────────────────────────────────────────

  it('persists a version field (currently 1) for forward migration', () => {
    const manager = new CredentialsManager(filePath)
    manager.set('anthropic', { apiKey: 'sk-test' })

    const raw = JSON.parse(readFileSync(filePath, 'utf8')) as Record<string, unknown>
    expect(raw.version).toBe(1)
    expect(raw.services).toEqual({ anthropic: { apiKey: 'sk-test' } })
  })

  it('normalizes a file with a missing version back to version 1 on rewrite', () => {
    const manager = new CredentialsManager(filePath)
    manager.set('seed', { value: 1 })
    writeFileSync(filePath, JSON.stringify({ services: { legacy: { token: 't' } } }), 'utf8')

    const fresh = new CredentialsManager(filePath)
    fresh.set('anthropic', { apiKey: 'sk-test' })

    const raw = JSON.parse(readFileSync(filePath, 'utf8')) as Record<string, unknown>
    expect(raw.version).toBe(1)
    expect(fresh.get('legacy')).toEqual({ token: 't' })
  })

  // ── B5: owner-only protection, both branches ─────────────────────────

  describe('owner-only protection', () => {
    /** Records every protection request and answers with a fixed verdict. */
    function spyProtect(result: ProtectionResult): {
      protect: ProtectFn
      calls: { target: string; kind: ProtectionKind }[]
    } {
      const calls: { target: string; kind: ProtectionKind }[] = []
      return {
        protect: (target, kind) => {
          calls.push({ target, kind })
          return result
        },
        calls,
      }
    }

    it('protects the credentials file on every write and on load', () => {
      const { protect, calls } = spyProtect({ applied: true, method: 'windows-acl' })
      const manager = new CredentialsManager(filePath, { protect })

      manager.set('anthropic', { apiKey: 'sk-test' })
      expect(calls).toEqual([{ target: filePath, kind: 'file' }])

      // A fresh manager re-tightens on first read — a file created or edited
      // outside the app is repaired, not trusted.
      const fresh = new CredentialsManager(filePath, { protect })
      fresh.get('anthropic')
      expect(calls).toEqual([
        { target: filePath, kind: 'file' },
        { target: filePath, kind: 'file' },
      ])
      expect(manager.protectionWarning()).toBeNull()
    })

    it('SAYS SO when the Windows ACL could not be applied (NFR5)', () => {
      const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined)
      const { protect } = spyProtect({
        applied: false,
        method: 'windows-acl',
        error: 'icacls: Access is denied.',
      })
      const manager = new CredentialsManager(filePath, { protect })

      manager.set('anthropic', { apiKey: 'sk-test' })

      const warning = manager.protectionWarning()
      expect(warning).not.toBeNull()
      expect(warning).toContain(filePath)
      expect(warning).toContain('other users on this machine may be able to read it')
      expect(warning).toContain('icacls: Access is denied.')
      expect(errorSpy.mock.calls.flat().join(' ')).toContain('SECURITY')
    })

    it('still stores the credential when the ACL fails — sign-in is not broken', () => {
      jest.spyOn(console, 'error').mockImplementation(() => undefined)
      const { protect } = spyProtect({
        applied: false,
        method: 'windows-acl',
        error: 'icacls missing',
      })
      const manager = new CredentialsManager(filePath, { protect })

      expect(() => manager.set('anthropic', { apiKey: 'sk-test' })).not.toThrow()
      expect(manager.get('anthropic')).toEqual({ apiKey: 'sk-test' })
      // The user is told, loudly, rather than silently handed an open file.
      expect(manager.protectionWarning()).not.toBeNull()
    })

    it('clears the warning once protection succeeds again', () => {
      jest.spyOn(console, 'error').mockImplementation(() => undefined)
      let applied = false
      const manager = new CredentialsManager(filePath, {
        protect: () =>
          applied
            ? { applied: true, method: 'windows-acl' }
            : { applied: false, method: 'windows-acl', error: 'transient' },
      })

      manager.set('anthropic', { apiKey: 'sk-test' })
      expect(manager.protectionWarning()).not.toBeNull()

      applied = true
      manager.set('github', { personalAccessToken: 'ghp-test' })
      expect(manager.protectionWarning()).toBeNull()
    })

    it('keeps the POSIX failure fatal, exactly as the bare chmodSync was (NFR1)', () => {
      jest.spyOn(console, 'error').mockImplementation(() => undefined)
      const { protect } = spyProtect({
        applied: false,
        method: 'posix-mode',
        error: 'EPERM: operation not permitted',
      })
      const manager = new CredentialsManager(filePath, { protect })

      // Before B5 a failing `chmodSync(path, 0o600)` propagated out of persist;
      // it still does. Only the Windows branch is new ground.
      expect(() => manager.set('anthropic', { apiKey: 'sk-test' })).toThrow(
        /owner-only protection/
      )
    })

    it('uses the real chmod by default — the POSIX path is not mocked away', () => {
      // No injection: the default protect is the platform one, and on this
      // POSIX host that means a real 0600 on a real file.
      const manager = new CredentialsManager(filePath)
      manager.set('anthropic', { apiKey: 'sk-test' })

      expect(fileMode(filePath)).toBe(0o600)
      expect(manager.protectionWarning()).toBeNull()
    })
  })
})
