// CredentialsManager — Flow's secret storage (noto CredentialsManager pattern).
//
// Secrets live at `~/.flow/credentials.json` — OUTSIDE the app database and
// any project directory, so copying a project or the app DB never drags
// secrets along. The file is restricted to its owner so other local users
// can't read it: mode 0600 on POSIX, an explicit owner-only ACL on Windows
// where `chmod` is a no-op that reads as protection (B5, see
// `platform/file-protection.ts`). If that protection cannot be applied, the
// manager records it: a `console.error` carrying `SECURITY:`, and the reason
// readable from `protectionWarning()` (NFR5).
//
// SCOPE OF THAT PROMISE, honestly stated (review F3): the failure is loud to
// LOGS, not to the user. Nothing reads `protectionWarning()` outside tests —
// `index.ts` constructs this manager and never consults it, and no IPC or
// renderer surface exposes it. So on a Windows host where `icacls` is blocked
// by policy or `USERNAME` is unset, the secret is written with inherited ACLs
// and a packaged app shows the user nothing. Surfacing it needs an IPC channel
// plus a renderer affordance; that is tracked separately and is deliberately
// NOT done here, because a new user-facing channel on the credential path
// deserves its own change and its own review.
//
// The Windows branch warns rather than throwing on purpose: refusing to store
// would break sign-in outright, which is worse than a named exposure. POSIX
// still throws, exactly as the bare `chmodSync` it replaced did (NFR1).
//
// Shape:
//   {
//     "version": 1,
//     "services": {
//       "anthropic": { "apiKey": "..." },
//       "github":    { "personalAccessToken": "..." }
//     }
//   }
//
// INVARIANT: this file is NEVER composed into prompts and secret values are
// never sent over IPC to the renderer. It is a tool-time lookup only —
// whichever main-process service needs a credential reads it at the moment
// of use. The IPC surface exposes only service names (list/set/delete).
//
// The `version` field exists for forward migration: when the shape changes,
// bump CURRENT_VERSION and migrate old files in `load()`.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { dirname, join } from 'path'
import { homedir } from 'os'

import {
  OWNER_ONLY_FILE_MODE,
  protectionFailureMessage,
  protectOwnerOnly,
  type ProtectionKind,
  type ProtectionResult,
} from './platform/file-protection'

export interface CredentialsFile {
  version: 1
  services: Record<string, Record<string, unknown>>
}

const CURRENT_VERSION = 1
/** Owner read/write only — other local users can't snoop the file. */
const CREDENTIALS_FILE_MODE = OWNER_ONLY_FILE_MODE

export const DEFAULT_CREDENTIALS_PATH = join(homedir(), '.flow', 'credentials.json')

/** Applies owner-only protection to a path. Injected so tests can exercise the
 *  Windows branch (and its failure) from any host. */
export type ProtectFn = (target: string, kind: ProtectionKind) => ProtectionResult

export interface CredentialsManagerOptions {
  /** Default: `protectOwnerOnly` — chmod on POSIX, an ACL on Windows. */
  protect?: ProtectFn
}

export class CredentialsManager {
  private cache: CredentialsFile | null = null
  private readonly protect: ProtectFn
  /** The last unresolved protection failure, or null when the file is safe. */
  private protectionFailure: string | null = null

  constructor(
    private readonly filePath: string = DEFAULT_CREDENTIALS_PATH,
    options: CredentialsManagerOptions = {},
  ) {
    this.protect = options.protect ?? ((target, kind) => protectOwnerOnly(target, { kind }))
  }

  /**
   * Why the credentials file is NOT owner-only, or null when it is. Non-null
   * means the secrets on disk are readable by other local users — the caller
   * is expected to surface it, never to ignore it (NFR5).
   */
  protectionWarning(): string | null {
    return this.protectionFailure
  }

  /**
   * Restrict the credentials file to its owner, or say so loudly.
   *
   * The POSIX branch RETHROWS, because that is exactly what the bare
   * `chmodSync` it replaced did — `load()` degrades to an empty store and
   * `persist()` propagates, unchanged from before B5 (NFR1).
   *
   * The Windows branch is new ground and deliberately does not throw: refusing
   * to store credentials at all when `icacls` is unavailable would break
   * sign-in outright, which is a worse outcome than a stored secret the user
   * has been explicitly told is unprotected.
   */
  private applyProtection(target: string, kind: ProtectionKind): void {
    const result = this.protect(target, kind)
    if (result.applied) {
      this.protectionFailure = null
      return
    }
    const message = protectionFailureMessage(target, kind, result)
    this.protectionFailure = message
    console.error(`[Credentials] SECURITY: ${message}`)
    if (result.method === 'posix-mode') {
      throw new Error(message)
    }
  }

  /** Read a service's credentials. Returns null when the file doesn't exist
   *  or the service isn't configured. Never throws — callers branch on null. */
  get(service: string): Record<string, unknown> | null {
    const file = this.load()
    return file.services[service] ?? null
  }

  /** Write credentials for a service. Creates the file on demand. Merges
   *  with any existing fields for that service — delete first if you want
   *  a clean replacement. */
  set(service: string, creds: Record<string, unknown>): void {
    const file = this.load()
    file.services[service] = { ...file.services[service], ...creds }
    this.persist(file)
  }

  /** Remove a service's credentials. No-op if not present. */
  delete(service: string): void {
    const file = this.load()
    if (file.services[service]) {
      delete file.services[service]
      this.persist(file)
    }
  }

  /** Service names that have credentials configured. Safe to expose over
   *  IPC — names only, never values. */
  listServices(): string[] {
    const file = this.load()
    return Object.keys(file.services)
  }

  private load(): CredentialsFile {
    if (this.cache) return this.cache
    if (!existsSync(this.filePath)) {
      this.cache = { version: CURRENT_VERSION, services: {} }
      return this.cache
    }
    try {
      // Re-tighten permissions in case the file was created or altered
      // outside the app (e.g. a manual edit that left it world-readable).
      this.applyProtection(this.filePath, 'file')
      const raw = readFileSync(this.filePath, 'utf8')
      const parsed = JSON.parse(raw) as Partial<CredentialsFile>
      // Version gate: today only v1 exists; future versions migrate here.
      this.cache = {
        version: CURRENT_VERSION,
        services: parsed.services ?? {},
      }
      return this.cache
    } catch (error) {
      console.error('[Credentials] Failed to load — starting with empty store:', error)
      this.cache = { version: CURRENT_VERSION, services: {} }
      return this.cache
    }
  }

  private persist(file: CredentialsFile): void {
    try {
      mkdirSync(dirname(this.filePath), { recursive: true })
      writeFileSync(this.filePath, JSON.stringify(file, null, 2) + '\n', {
        encoding: 'utf8',
        mode: CREDENTIALS_FILE_MODE,
      })
      // writeFileSync `mode` only applies on creation (and is ignored outright
      // on Windows) — enforce on every write, by the platform's real mechanism.
      this.applyProtection(this.filePath, 'file')
      this.cache = file
    } catch (error) {
      console.error('[Credentials] Failed to persist:', error)
      throw error
    }
  }
}
