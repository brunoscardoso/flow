// Owner-only protection for the files and directories that hold secrets (B5).
//
// POSIX says "only I may read this" with a mode: 0600 for a file, 0700 for a
// directory. On Windows `fs.chmodSync` accepts the very same number and does
// almost nothing — the only bit it can touch is the read-only ATTRIBUTE, which
// is not an access control at all. So `chmodSync(credentialsPath, 0o600)` on
// Windows leaves the file with whatever ACL it inherited from the user profile
// directory: the call READS as protection and IS none. That silent lie is the
// defect, not the missing feature.
//
// The Windows equivalent is an explicit ACL, applied with the in-box `icacls`:
//
//   icacls "<path>" /inheritance:r /grant:r "<principal>:(F)"
//
//   /inheritance:r  removes every INHERITED ACE, leaving only explicit ones. A
//                   freshly created file under the profile carries nothing but
//                   inherited ACEs (SYSTEM, Administrators, the user), so after
//                   this it has none at all.
//   /grant:r        REPLACES the principal's ACE rather than adding one, which
//                   is what makes re-running this idempotent.
//   (OI)(CI)        object/container inheritance — directories only, so files
//                   created inside inherit the same single-principal ACL.
//
// The order matters: inheritance is stripped and the grant applied in ONE
// invocation, so there is no window in which the path has no ACE and nobody
// (including the owner) can open it.
//
// NFR5 — failure is never swallowed. Every call returns a ProtectionResult and
// the caller is required to say so out loud when `applied` is false. A secret
// that is not actually protected while the code reports success is precisely
// the failure mode this module exists to remove.
//
// Everything here takes the platform as an argument and injects its side
// effects, so both branches are asserted from a test on either host (NFR3).

import { execFileSync } from 'child_process'
import { chmodSync } from 'fs'

/** What is being protected — the flags and the POSIX mode differ. */
export type ProtectionKind = 'file' | 'directory'

/** How protection was (or would have been) applied. */
export type ProtectionMethod = 'posix-mode' | 'windows-acl'

export interface ProtectionResult {
  /** True only when the protection is actually in force. */
  applied: boolean
  method: ProtectionMethod
  /** Human-readable detail — present iff `applied` is false. */
  error?: string
}

/** Owner read/write only — other local users can't snoop the file. */
export const OWNER_ONLY_FILE_MODE = 0o600

/** Owner traverse/read/write only — the directory listing is private too. */
export const OWNER_ONLY_DIR_MODE = 0o700

/** `icacls` is a local, in-box call; anything slower than this is stuck. */
const ACL_TIMEOUT_MS = 10_000

/** A command to run, kept as argv (never a shell string — paths have spaces). */
export interface AclCommand {
  command: string
  args: string[]
}

/** Runs an ACL command and returns its combined output. Throws on failure. */
export type AclRunner = (command: AclCommand) => string

export interface ProtectOwnerOnlyOptions {
  /** Platform whose protection mechanism applies. Default: the host's. */
  platform?: NodeJS.Platform | string
  /** File or directory. Default: `'file'`. */
  kind?: ProtectionKind
  /** Windows principal to grant. Default: derived from the environment. */
  principal?: string | null
  /** POSIX mode application. Default: `fs.chmodSync`. */
  chmod?: (path: string, mode: number) => void
  /** Windows ACL application. Default: `icacls` via `execFileSync`. */
  runAcl?: AclRunner
  /** Environment the default principal is derived from. Default: `process.env`. */
  env?: NodeJS.ProcessEnv
}

/**
 * The Windows principal to grant sole access to: `DOMAIN\user` when the domain
 * is known (it always is on a real Windows session, `WORKGROUP`-style machines
 * included), otherwise the bare user name.
 *
 * Returns null when neither is set rather than guessing — granting the wrong
 * principal would either lock the owner out or leave the file readable, and
 * both are worse than a loud refusal.
 */
export function windowsOwnerPrincipal(env: NodeJS.ProcessEnv = process.env): string | null {
  const user = env.USERNAME?.trim()
  if (!user) return null
  const domain = env.USERDOMAIN?.trim()
  return domain ? `${domain}\\${user}` : user
}

/**
 * The exact `icacls` invocation for owner-only access. Pure, so the flags are
 * asserted in a test rather than trusted — the difference between `/grant` and
 * `/grant:r`, or a missing `/inheritance:r`, is the difference between a
 * protected secret and one that merely looks protected.
 */
export function ownerOnlyAclCommand(
  target: string,
  principal: string,
  kind: ProtectionKind = 'file',
): AclCommand {
  // (OI)(CI) makes the grant inheritable by the directory's future contents;
  // on a file those flags are meaningless and Windows rejects them.
  const rights = kind === 'directory' ? '(OI)(CI)F' : '(F)'
  return {
    command: 'icacls',
    args: [target, '/inheritance:r', '/grant:r', `${principal}:${rights}`],
  }
}

function defaultRunAcl(command: AclCommand): string {
  return execFileSync(command.command, command.args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: ACL_TIMEOUT_MS,
    windowsHide: true,
  })
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * `icacls` prints `Successfully processed N files; Failed processing M files`
 * and does not always exit non-zero when M > 0. Reading the count is the only
 * way to tell a real application from a reported one.
 */
function aclOutputFailure(output: string): string | null {
  const match = /Failed processing (\d+)/i.exec(output)
  if (match && match[1] !== '0') {
    return `icacls reported ${match[1]} failed path(s): ${output.trim()}`
  }
  return null
}

/**
 * Restrict a path to its owner alone, by the mechanism the platform actually
 * honours. Never throws — the result is the contract, and the caller must
 * surface `applied: false` rather than continue as though the secret is safe.
 */
export function protectOwnerOnly(
  target: string,
  options: ProtectOwnerOnlyOptions = {},
): ProtectionResult {
  const platform = options.platform ?? process.platform
  const kind = options.kind ?? 'file'

  if (platform !== 'win32') {
    const chmod = options.chmod ?? chmodSync
    const mode = kind === 'directory' ? OWNER_ONLY_DIR_MODE : OWNER_ONLY_FILE_MODE
    try {
      chmod(target, mode)
      return { applied: true, method: 'posix-mode' }
    } catch (error) {
      return { applied: false, method: 'posix-mode', error: describeError(error) }
    }
  }

  const principal =
    options.principal !== undefined
      ? options.principal
      : windowsOwnerPrincipal(options.env ?? process.env)
  if (!principal) {
    return {
      applied: false,
      method: 'windows-acl',
      error: 'could not identify the current Windows user (USERNAME is unset)',
    }
  }

  const run = options.runAcl ?? defaultRunAcl
  try {
    const output = run(ownerOnlyAclCommand(target, principal, kind)) ?? ''
    const failure = aclOutputFailure(output)
    if (failure) {
      return { applied: false, method: 'windows-acl', error: failure }
    }
    return { applied: true, method: 'windows-acl' }
  } catch (error) {
    return { applied: false, method: 'windows-acl', error: describeError(error) }
  }
}

/**
 * The one sentence a caller prints when protection failed. Centralised so every
 * unprotected secret reports itself the same recognisable way (NFR5) — and so
 * the message always names the path, the mechanism, and the consequence rather
 * than just echoing an errno.
 */
export function protectionFailureMessage(
  target: string,
  kind: ProtectionKind,
  result: ProtectionResult,
): string {
  const consequence =
    result.method === 'windows-acl'
      ? 'other users on this machine may be able to read it'
      : 'its permissions are not owner-only'
  return (
    `could not apply owner-only protection to ${kind} ${target} — ` +
    `${consequence}. Cause: ${result.error ?? 'unknown'}`
  )
}
