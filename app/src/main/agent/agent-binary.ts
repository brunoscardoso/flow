// Agent binary provisioning — makes sure Claude's native engine exists on THIS
// machine before any agent session, auth probe or login needs it.
//
// WHY THIS EXISTS. The Claude Agent SDK does not run in-process: every session
// spawns a ~247MB native binary shipped as a per-platform optional npm package
// (`@anthropic-ai/claude-agent-sdk-<platform>-<arch>`). The packaged app is
// supposed to carry it, and twice it did not:
//   - 2026-07-23, v0.1.7 macOS: the hoisted package lost its binary and the
//     build shipped the empty shell.
//   - 2026-09-24, v0.1.10 Windows: the installer was built on a host whose npm
//     had only installed ITS OWN platform package, so the Windows one was
//     never there to pack.
// Both times every chat failed with "Native CLI binary for <platform> not
// found" and there was nothing a user could do about it. The packaging scripts
// now refuse such builds (scripts/verify-agent-binary.mjs), but an installed
// app should not depend on every build having been right: if the binary is
// missing, the app fetches the exact matching one itself.
//
// Resolution, first hit wins:
//   1. bundled     — the package inside the app (the normal case, no network)
//   2. provisioned — a copy this module downloaded earlier, under userData
//   3. download    — npm registry tarball for the SAME version as the SDK,
//                    sha512-verified against the registry's `integrity`
//                    before it is moved into place (never run a partial file)
//
// The binary is version-locked to the SDK's JS (they speak one protocol), so
// the provisioned copy lives under a version directory and an app update that
// bumps the SDK simply provisions a new one.

import { createHash } from 'node:crypto'
import { createWriteStream, promises as fs, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { Readable, Transform, Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createGunzip } from 'node:zlib'

import {
  SDK_BINARY_MIN_BYTES,
  sdkBinaryName,
  sdkBinarySpecifier,
  sdkPackageName,
} from '../../../shared/sdk-platform.mjs'

const SDK_MODULE_SPECIFIER = '@anthropic-ai/claude-agent-sdk'
const NPM_REGISTRY = 'https://registry.npmjs.org'
/** Metadata is tiny; the tarball is ~60MB, so it gets a generous window. */
const METADATA_TIMEOUT_MS = 30_000
const TARBALL_TIMEOUT_MS = 15 * 60_000
const TAR_BLOCK = 512
/** After a failed download, answer from memory for this long instead of
 *  re-asking the registry — background pollers resolve the binary too. */
const FAILURE_COOLDOWN_MS = 60_000

export type AgentBinarySource = 'bundled' | 'provisioned' | 'downloaded'

export interface AgentBinary {
  path: string
  source: AgentBinarySource
}

export interface AgentBinaryOptions {
  /** Where downloaded binaries live — the app's userData in production. */
  dataDir: string
  platform?: NodeJS.Platform | string
  arch?: string
  /** SDK version the binary must match; read from the installed SDK by default. */
  sdkVersion?: string
  fetchFn?: typeof fetch
  now?: () => number
  /** Smallest size accepted as a real binary. Tests shrink it; production never sets it. */
  minBytes?: number
  /** `require.resolve` — injectable so tests can say "not bundled". */
  resolveModule?: (specifier: string) => string
  log?: (message: string) => void
}

// ── Configuration (set once at startup) ─────────────────────────────────────

let configuredDataDir: string | null = null

/** Point the provisioner at the app's data directory. Called once from main. */
export function configureAgentBinary(dataDir: string): void {
  configuredDataDir = dataDir
}

/** The configured data dir, or null before main has started. */
export function agentBinaryDataDir(): string | null {
  return configuredDataDir
}

// ── Resolution ──────────────────────────────────────────────────────────────

/** Version of the installed SDK JS — the binary must be the same version. */
export function installedSdkVersion(resolveModule: (specifier: string) => string = require.resolve): string {
  // The SDK's `exports` map hides ./package.json, so read it beside the entry.
  const entry = resolveModule(SDK_MODULE_SPECIFIER)
  const manifest = JSON.parse(readFileSync(join(dirname(entry), 'package.json'), 'utf8')) as {
    version?: unknown
  }
  if (typeof manifest.version !== 'string') {
    throw new Error(`${SDK_MODULE_SPECIFIER} has no version in its package.json`)
  }
  return manifest.version
}

/** Where a downloaded binary for this version/target lives. */
export function provisionedBinaryPath(
  dataDir: string,
  sdkVersion: string,
  platform: NodeJS.Platform | string,
  arch: string,
): string {
  return join(dataDir, 'agent-binary', sdkVersion, `${platform}-${arch}`, sdkBinaryName(platform))
}

/** A real binary, not a stub or a truncated copy. */
function isIntactBinary(path: string, minBytes: number = SDK_BINARY_MIN_BYTES): boolean {
  try {
    return statSync(path).size >= minBytes
  } catch {
    return false
  }
}

/**
 * The binary already on disk — bundled first, then a previous download — or
 * null when neither exists. Synchronous and network-free, so the sync callers
 * (auth probe, login, background agents) can use it directly.
 */
export function findAgentBinary(options: Partial<AgentBinaryOptions> = {}): AgentBinary | null {
  const platform = options.platform ?? process.platform
  const arch = options.arch ?? process.arch
  const resolveModule = options.resolveModule ?? require.resolve
  const specifier = sdkBinarySpecifier(platform, arch)
  if (specifier === null) return null

  try {
    const bundled = resolveModule(specifier)
    if (isIntactBinary(bundled, options.minBytes)) return { path: bundled, source: 'bundled' }
  } catch {
    // Not bundled — fall through to a provisioned copy.
  }

  const dataDir = options.dataDir ?? configuredDataDir
  if (dataDir === null) return null
  let sdkVersion: string
  try {
    sdkVersion = options.sdkVersion ?? installedSdkVersion(resolveModule)
  } catch {
    return null
  }
  const provisioned = provisionedBinaryPath(dataDir, sdkVersion, platform, arch)
  return isIntactBinary(provisioned, options.minBytes) ? { path: provisioned, source: 'provisioned' } : null
}

// ── Provisioning ────────────────────────────────────────────────────────────

/** One download per target at a time — concurrent sessions share it. */
const inFlight = new Map<string, Promise<AgentBinary>>()
/** The last failure per target, so a poller does not re-download every tick. */
const recentFailures = new Map<string, { at: number; error: Error }>()

/**
 * The binary to run, downloading it first when this install lacks one.
 * Rejects with a sentence a person can read (it reaches the chat as the
 * session error); a failed attempt is not cached, so the next session retries.
 */
export function ensureAgentBinary(options: Partial<AgentBinaryOptions> = {}): Promise<AgentBinary> {
  const found = findAgentBinary(options)
  if (found !== null) return Promise.resolve(found)

  const platform = options.platform ?? process.platform
  const arch = options.arch ?? process.arch
  const dataDir = options.dataDir ?? configuredDataDir
  const pkg = sdkPackageName(platform, arch)
  if (pkg === null) {
    return Promise.reject(
      new Error(`Claude's engine is not available for this kind of computer (${platform}-${arch}).`),
    )
  }
  if (dataDir === null) {
    return Promise.reject(new Error("Flow couldn't set up Claude's engine: the app has not finished starting."))
  }
  let sdkVersion: string
  try {
    sdkVersion = options.sdkVersion ?? installedSdkVersion(options.resolveModule ?? require.resolve)
  } catch (error) {
    return Promise.reject(
      new Error(`Flow couldn't set up Claude's engine: ${error instanceof Error ? error.message : String(error)}`),
    )
  }

  const target = provisionedBinaryPath(dataDir, sdkVersion, platform, arch)
  const pending = inFlight.get(target)
  if (pending !== undefined) return pending
  const now = options.now ?? Date.now
  const failed = recentFailures.get(target)
  if (failed !== undefined && now() - failed.at < FAILURE_COOLDOWN_MS) return Promise.reject(failed.error)

  const log = options.log ?? ((message: string) => console.log(`[agent-binary] ${message}`))
  const attempt = downloadBinary({
    pkg,
    sdkVersion,
    platform,
    target,
    fetchFn: options.fetchFn ?? fetch,
    minBytes: options.minBytes ?? SDK_BINARY_MIN_BYTES,
    log,
  })
    .then((): AgentBinary => ({ path: target, source: 'downloaded' }))
    .catch((error: unknown) => {
      const reason = error instanceof Error ? error.message : String(error)
      log(`provisioning ${pkg}@${sdkVersion} failed: ${reason}`)
      const failure = new Error(
        `Flow couldn't download Claude's engine for this computer (${reason}). ` +
          'Check your internet connection and try again.',
      )
      recentFailures.set(target, { at: now(), error: failure })
      throw failure
    })
    .finally(() => inFlight.delete(target))
  inFlight.set(target, attempt)
  return attempt
}

interface DownloadParams {
  pkg: string
  sdkVersion: string
  platform: NodeJS.Platform | string
  target: string
  fetchFn: typeof fetch
  minBytes: number
  log: (message: string) => void
}

async function downloadBinary(params: DownloadParams): Promise<void> {
  const { pkg, sdkVersion, platform, target, fetchFn, minBytes, log } = params
  const metadataUrl = `${NPM_REGISTRY}/${pkg.replace('/', '%2f')}/${sdkVersion}`
  const metadataResponse = await fetchFn(metadataUrl, { signal: AbortSignal.timeout(METADATA_TIMEOUT_MS) })
  if (!metadataResponse.ok) {
    throw new Error(`the package registry answered ${metadataResponse.status} for ${pkg}@${sdkVersion}`)
  }
  const metadata = (await metadataResponse.json()) as { dist?: { tarball?: unknown; integrity?: unknown } }
  const tarball = metadata.dist?.tarball
  const integrity = metadata.dist?.integrity
  if (typeof tarball !== 'string' || typeof integrity !== 'string' || !integrity.startsWith('sha512-')) {
    throw new Error(`the package registry gave no verifiable download for ${pkg}@${sdkVersion}`)
  }
  const expectedDigest = integrity.slice('sha512-'.length)

  log(`downloading ${pkg}@${sdkVersion}`)
  const response = await fetchFn(tarball, { signal: AbortSignal.timeout(TARBALL_TIMEOUT_MS) })
  if (!response.ok || response.body === null) {
    throw new Error(`the download answered ${response.status}`)
  }

  await fs.mkdir(dirname(target), { recursive: true })
  // A unique partial name: the binary only appears under its real name after
  // the whole tarball has been hashed and matched.
  const partial = `${target}.${process.pid}.${Date.now()}.partial`
  const hash = createHash('sha512')
  const binaryEntry = `package/${sdkBinaryName(platform)}`
  const extractor = new TarEntryExtractor(binaryEntry, partial)

  try {
    const body = Readable.fromWeb(response.body as import('node:stream/web').ReadableStream<Uint8Array>)
    const hashing = new Transform({
      transform(chunk: Buffer, _encoding, done) {
        hash.update(chunk)
        done(null, chunk)
      },
    })
    await pipeline(body, hashing, createGunzip(), extractor)
    if (!extractor.found) throw new Error(`the download did not contain ${binaryEntry}`)

    const actualDigest = hash.digest('base64')
    if (actualDigest !== expectedDigest) {
      throw new Error('the download did not match its published checksum')
    }
    if (!isIntactBinary(partial, minBytes)) throw new Error('the downloaded engine is incomplete')
    if (platform !== 'win32') await fs.chmod(partial, 0o755)
    await fs.rename(partial, target)
    log(`installed ${pkg}@${sdkVersion} → ${target}`)
  } finally {
    await fs.rm(partial, { force: true })
  }
}

// ── A one-entry tar reader ──────────────────────────────────────────────────
//
// npm tarballs are plain ustar (occasionally with a pax header). The app needs
// ONE file out of one, streamed straight to disk — a 247MB entry must never be
// buffered — so a small reader beats shipping a tar dependency in the bundle.

/** Streams one named regular-file entry of a (gunzipped) tar to `outPath`. */
export class TarEntryExtractor extends Writable {
  found = false
  private pending: Buffer = Buffer.alloc(0)
  /** Bytes of the current entry's data still to consume (incl. padding). */
  private remaining = 0
  private dataLeft = 0
  private writing: import('node:fs').WriteStream | null = null
  private paxPath: string | null = null
  private collectingPax: Buffer[] | null = null
  private ended = false

  constructor(
    private readonly entryName: string,
    private readonly outPath: string,
  ) {
    super()
  }

  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.consume(chunk).then(() => callback(), callback)
  }

  override _final(callback: (error?: Error | null) => void): void {
    this.closeOutput().then(() => callback(), callback)
  }

  private async consume(chunk: Buffer): Promise<void> {
    let buffer = this.pending.length > 0 ? Buffer.concat([this.pending, chunk]) : chunk
    this.pending = Buffer.alloc(0)

    while (buffer.length > 0 && !this.ended) {
      if (this.remaining > 0) {
        const take = Math.min(this.remaining, buffer.length)
        const dataTake = Math.min(this.dataLeft, take)
        if (dataTake > 0) await this.onData(buffer.subarray(0, dataTake))
        this.dataLeft -= dataTake
        this.remaining -= take
        buffer = buffer.subarray(take)
        if (this.remaining === 0) await this.onEntryEnd()
        continue
      }
      if (buffer.length < TAR_BLOCK) {
        this.pending = Buffer.from(buffer)
        return
      }
      const header = buffer.subarray(0, TAR_BLOCK)
      buffer = buffer.subarray(TAR_BLOCK)
      if (header.every((byte) => byte === 0)) {
        this.ended = true
        return
      }
      this.onHeader(header)
      if (this.remaining === 0) await this.onEntryEnd()
    }
  }

  private onHeader(header: Buffer): void {
    const size = parseOctal(header.subarray(124, 136))
    const type = String.fromCharCode(header[156] ?? 0)
    const isUstar = header.subarray(257, 262).toString('latin1') === 'ustar'
    const name = cString(header.subarray(0, 100))
    const prefix = isUstar ? cString(header.subarray(345, 500)) : ''
    const path = this.paxPath ?? (prefix.length > 0 ? `${prefix}/${name}` : name)

    this.dataLeft = size
    this.remaining = Math.ceil(size / TAR_BLOCK) * TAR_BLOCK

    if (type === 'x') {
      this.collectingPax = []
      return
    }
    this.paxPath = null
    if ((type === '0' || type === '\0') && path === this.entryName && !this.found) {
      this.found = true
      this.writing = createWriteStream(this.outPath)
    }
  }

  private async onData(data: Buffer): Promise<void> {
    if (this.collectingPax !== null) {
      this.collectingPax.push(Buffer.from(data))
      return
    }
    const out = this.writing
    if (out === null) return
    if (!out.write(data)) {
      await new Promise<void>((resolve, reject) => {
        out.once('drain', resolve)
        out.once('error', reject)
      })
    }
  }

  private async onEntryEnd(): Promise<void> {
    if (this.collectingPax !== null) {
      this.paxPath = paxPathOf(Buffer.concat(this.collectingPax))
      this.collectingPax = null
      return
    }
    await this.closeOutput()
  }

  private async closeOutput(): Promise<void> {
    const out = this.writing
    if (out === null) return
    this.writing = null
    await new Promise<void>((resolve, reject) => {
      out.once('error', reject)
      out.end(resolve)
    })
  }
}

function cString(bytes: Buffer): string {
  const end = bytes.indexOf(0)
  return bytes.subarray(0, end === -1 ? bytes.length : end).toString('utf8')
}

function parseOctal(bytes: Buffer): number {
  const text = cString(bytes).trim()
  return text.length === 0 ? 0 : parseInt(text, 8)
}

/** The `path=` record of a pax extended header, if any. */
function paxPathOf(body: Buffer): string | null {
  for (const record of body.toString('utf8').split('\n')) {
    const match = /^\d+ path=(.*)$/.exec(record)
    if (match) return match[1] ?? null
  }
  return null
}

/**
 * Bind the binary into an SDK `query()` so every session spawns it — an
 * explicit per-call `pathToClaudeCodeExecutable` still wins.
 */
export function bindAgentBinary<P extends { options?: { pathToClaudeCodeExecutable?: string } }, R>(
  query: (params: P) => R,
  binaryPath: string,
): (params: P) => R {
  return (params) =>
    query({ ...params, options: { pathToClaudeCodeExecutable: binaryPath, ...params.options } })
}

/** Test seam: forget in-flight downloads and failures between cases. */
export function resetAgentBinaryForTests(): void {
  inFlight.clear()
  recentFailures.clear()
  configuredDataDir = null
}
