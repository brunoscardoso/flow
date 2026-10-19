// Agent binary provisioning — an install that shipped without Claude's native
// engine downloads the matching one itself, verified, before any session.
//
// The registry is faked as a table keyed by URL that THROWS on anything else,
// so each case asserts which requests the code made, not just what it got.

import { createHash } from 'crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { gzipSync } from 'zlib'

import {
  bindAgentBinary,
  ensureAgentBinary,
  findAgentBinary,
  provisionedBinaryPath,
  resetAgentBinaryForTests,
} from './agent-binary'

const VERSION = '9.9.9'
const PKG = '@anthropic-ai/claude-agent-sdk-win32-x64'
const METADATA_URL = `https://registry.npmjs.org/@anthropic-ai%2fclaude-agent-sdk-win32-x64/${VERSION}`
const TARBALL_URL = 'https://registry.npmjs.org/fake/claude-agent-sdk-win32-x64-9.9.9.tgz'
/** Small stand-in for the 247MB binary — the floor is shrunk to match. */
const MIN_BYTES = 1024
const NOT_BUNDLED = (): string => {
  throw new Error('Cannot find module')
}

// ── A tiny tar writer, so fixtures are real ustar bytes ─────────────────────

function tarHeader(name: string, size: number, type = '0'): Buffer {
  const header = Buffer.alloc(512)
  header.write(name, 0, 100, 'utf8')
  header.write('0000644\0', 100)
  header.write('0000000\0', 108)
  header.write('0000000\0', 116)
  header.write(size.toString(8).padStart(11, '0') + '\0', 124)
  header.write('00000000000\0', 136)
  header.write('        ', 148)
  header.write(type, 156)
  header.write('ustar\0', 257)
  header.write('00', 263)
  let sum = 0
  for (const byte of header) sum += byte
  header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148)
  return header
}

function tarEntry(name: string, data: Buffer, type = '0'): Buffer {
  const padding = Buffer.alloc((512 - (data.length % 512)) % 512)
  return Buffer.concat([tarHeader(name, data.length, type), data, padding])
}

function tarball(entries: Buffer[]): Buffer {
  return gzipSync(Buffer.concat([...entries, Buffer.alloc(1024)]))
}

function integrityOf(bytes: Buffer): string {
  return `sha512-${createHash('sha512').update(bytes).digest('base64')}`
}

/** A binary big enough to clear MIN_BYTES and to span several tar blocks. */
const BINARY = Buffer.from(Array.from({ length: 5000 }, (_, i) => i % 251))

function fakeRegistry(tgz: Buffer, integrity = integrityOf(tgz)) {
  const calls: string[] = []
  const fetchFn = (async (url: string | URL) => {
    const href = String(url)
    calls.push(href)
    if (href === METADATA_URL) {
      return new Response(JSON.stringify({ dist: { tarball: TARBALL_URL, integrity } }))
    }
    if (href === TARBALL_URL) return new Response(tgz)
    throw new Error(`unexpected request: ${href}`)
  }) as typeof fetch
  return { calls, fetchFn }
}

describe('agent binary provisioning', () => {
  let dataDir: string
  let logs: string[]

  beforeEach(() => {
    resetAgentBinaryForTests()
    dataDir = mkdtempSync(join(tmpdir(), 'flow-agent-binary-'))
    logs = []
  })

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true })
  })

  const base = () => ({
    dataDir,
    platform: 'win32',
    arch: 'x64',
    sdkVersion: VERSION,
    resolveModule: NOT_BUNDLED,
    minBytes: MIN_BYTES,
    log: (message: string) => logs.push(message),
  })

  const target = () => provisionedBinaryPath(dataDir, VERSION, 'win32', 'x64')

  it('downloads the matching binary when the install has none, and uses it', async () => {
    const tgz = tarball([
      tarEntry('package/package.json', Buffer.from('{}')),
      tarEntry('package/claude.exe', BINARY),
      tarEntry('package/README.md', Buffer.from('readme')),
    ])
    const registry = fakeRegistry(tgz)

    expect(findAgentBinary(base())).toBeNull()
    const binary = await ensureAgentBinary({ ...base(), fetchFn: registry.fetchFn })

    expect(binary).toEqual({ path: target(), source: 'downloaded' })
    expect(readFileSync(target()).equals(BINARY)).toBe(true)
    expect(registry.calls).toEqual([METADATA_URL, TARBALL_URL])
    // …and the next resolution finds it without the network.
    expect(findAgentBinary(base())).toEqual({ path: target(), source: 'provisioned' })
    expect(logs.join('\n')).toContain(`${PKG}@${VERSION}`)
  })

  it('never downloads when the bundled binary is present', async () => {
    const bundled = join(dataDir, 'bundled', 'claude.exe')
    mkdirSync(dirname(bundled), { recursive: true })
    writeFileSync(bundled, BINARY)
    const registry = fakeRegistry(tarball([]))

    const binary = await ensureAgentBinary({ ...base(), resolveModule: () => bundled, fetchFn: registry.fetchFn })

    expect(binary).toEqual({ path: bundled, source: 'bundled' })
    expect(registry.calls).toEqual([])
  })

  it('treats a stub bundled binary as missing (the v0.1.7 gutted-package case)', async () => {
    const stub = join(dataDir, 'bundled', 'claude.exe')
    mkdirSync(dirname(stub), { recursive: true })
    writeFileSync(stub, 'stub')
    const registry = fakeRegistry(tarball([tarEntry('package/claude.exe', BINARY)]))

    const binary = await ensureAgentBinary({ ...base(), resolveModule: () => stub, fetchFn: registry.fetchFn })

    expect(binary.source).toBe('downloaded')
  })

  it('refuses a download whose checksum does not match, leaving nothing behind', async () => {
    const tgz = tarball([tarEntry('package/claude.exe', BINARY)])
    const registry = fakeRegistry(tgz, integrityOf(Buffer.from('something else')))

    await expect(ensureAgentBinary({ ...base(), fetchFn: registry.fetchFn })).rejects.toThrow(
      /did not match its published checksum/,
    )
    // State the positive first: the download really happened…
    expect(registry.calls).toEqual([METADATA_URL, TARBALL_URL])
    // …and still nothing usable, partial or otherwise, was left on disk.
    expect(existsSync(target())).toBe(false)
    expect(findAgentBinary(base())).toBeNull()
  })

  it('refuses a tarball that does not contain the binary', async () => {
    const registry = fakeRegistry(tarball([tarEntry('package/README.md', Buffer.from('x'))]))

    await expect(ensureAgentBinary({ ...base(), fetchFn: registry.fetchFn })).rejects.toThrow(
      /did not contain package\/claude\.exe/,
    )
    expect(existsSync(target())).toBe(false)
  })

  it('honours a pax header that names the entry', async () => {
    const pax = Buffer.from('27 path=package/claude.exe\n')
    const tgz = tarball([tarEntry('PaxHeader/x', pax, 'x'), tarEntry('package/renamed', BINARY)])
    const registry = fakeRegistry(tgz)

    const binary = await ensureAgentBinary({ ...base(), fetchFn: registry.fetchFn })

    expect(readFileSync(binary.path).equals(BINARY)).toBe(true)
  })

  it('shares one download between concurrent callers', async () => {
    const registry = fakeRegistry(tarball([tarEntry('package/claude.exe', BINARY)]))

    const [a, b] = await Promise.all([
      ensureAgentBinary({ ...base(), fetchFn: registry.fetchFn }),
      ensureAgentBinary({ ...base(), fetchFn: registry.fetchFn }),
    ])

    expect(a.path).toBe(b.path)
    expect(registry.calls.filter((url) => url === TARBALL_URL)).toHaveLength(1)
  })

  it('does not re-ask the registry right after a failure, and retries after the cooldown', async () => {
    let now = 1_000_000
    const offline = jest.fn(async () => {
      throw new Error('getaddrinfo ENOTFOUND registry.npmjs.org')
    }) as unknown as typeof fetch

    const options = { ...base(), fetchFn: offline, now: () => now }
    await expect(ensureAgentBinary(options)).rejects.toThrow(/couldn't download Claude's engine/)
    await expect(ensureAgentBinary(options)).rejects.toThrow(/couldn't download Claude's engine/)
    expect(offline).toHaveBeenCalledTimes(1)

    now += 61_000
    const registry = fakeRegistry(tarball([tarEntry('package/claude.exe', BINARY)]))
    const binary = await ensureAgentBinary({ ...options, fetchFn: registry.fetchFn })
    expect(binary.source).toBe('downloaded')
  })

  it('names the problem in words, not a command, when the registry has no such version', async () => {
    const fetchFn = (async () => new Response('not found', { status: 404 })) as unknown as typeof fetch

    const error = await ensureAgentBinary({ ...base(), fetchFn }).catch((caught: Error) => caught)

    expect(String(error)).toContain('answered 404')
    expect(String(error)).not.toMatch(/npm|--omit|planflow-ai/)
  })

  it('rejects by name on a platform the SDK does not publish for', async () => {
    await expect(ensureAgentBinary({ ...base(), platform: 'aix', arch: 'ppc64' })).rejects.toThrow(
      /not available for this kind of computer \(aix-ppc64\)/,
    )
  })
})

describe('bindAgentBinary', () => {
  it('injects the binary path into every query call', () => {
    const query = jest.fn((params: { prompt: string; options?: { pathToClaudeCodeExecutable?: string; cwd?: string } }) => params)
    const bound = bindAgentBinary(query, '/data/claude')

    expect(bound({ prompt: 'hi', options: { cwd: '/p' } })).toEqual({
      prompt: 'hi',
      options: { pathToClaudeCodeExecutable: '/data/claude', cwd: '/p' },
    })
    expect(bound({ prompt: 'hi' }).options).toEqual({ pathToClaudeCodeExecutable: '/data/claude' })
  })

  it('lets an explicit per-call path win', () => {
    const query = jest.fn((params: { options?: { pathToClaudeCodeExecutable?: string } }) => params)
    const bound = bindAgentBinary(query, '/data/claude')

    expect(bound({ options: { pathToClaudeCodeExecutable: '/explicit' } }).options?.pathToClaudeCodeExecutable).toBe(
      '/explicit',
    )
  })
})
