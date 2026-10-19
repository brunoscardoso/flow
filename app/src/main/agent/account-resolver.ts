// AccountResolver — decides which Anthropic account a project runs under, and
// whether it is usable RIGHT NOW (fail-closed).
//
// Resolution is override ?? default ?? legacy:
//   - override: workspace_state.account_id for the project
//   - default:  app_settings.default_account_id
//   - legacy:   no account configured → inherit the CLI's own auth (today's
//               behavior, backward compatible)
//
// Availability is probed via `claude auth status` run against the account's
// isolated CLAUDE_CONFIG_DIR (the runtime spike proved this isolates auth,
// keychain included). A resolved-but-not-logged-in account is NEVER silently
// substituted — the caller fails closed (data isolation is a safety property).

import { execFile } from 'node:child_process'

import { sdkBinarySpecifier } from '../../../shared/sdk-platform.mjs'
import { buildAccountEnv } from './account-env'
import { ensureAgentBinary, findAgentBinary } from './agent-binary'
import type { AccountRecord, AccountStore } from '../store/account-store'

/** Parsed slice of `claude auth status` JSON. */
export interface AuthStatus {
  loggedIn: boolean
  /** Identity string for the cached hint / future verification (email · org). */
  identity?: string
  /** True when the probe itself failed (timeout/spawn/parse) — it observed
   *  NOTHING, which must never be reported as "not logged in" (live false
   *  positive: a loaded machine timing out the probe locked out a healthy
   *  account, 2026-07-27). */
  probeFailed?: boolean
}

/** Probe an isolated config dir for auth state. Injected for testability. */
export type AuthProbe = (configDirPath: string) => Promise<AuthStatus>

/**
 * WHERE a resolved account came from (#1108). `override` = the project is
 * explicitly PINNED to this account; `default` = it merely INHERITS the app
 * default and will follow it if the default moves. Both resolve to a concrete
 * account, so callers that only need "which account" ignore this — but the
 * settings UI must not render the two states identically, or a project that
 * inherits looks pinned and silently switches account later.
 */
export type AccountSource = 'override' | 'default'

/** The account decision for a project, resolved AND availability-checked. */
export type AccountResolution =
  | { status: 'legacy' }
  | { status: 'ready'; account: AccountRecord; source: AccountSource; identity?: string }
  | { status: 'unavailable'; account: AccountRecord; source: AccountSource; reason: string }
  | { status: 'dangling'; accountId: string; reason: string }

const AUTH_PROBE_TIMEOUT_MS = 15_000
/** A good probe this fresh skips the subprocess entirely. */
const GOOD_PROBE_FRESH_MS = 60_000
/** A FAILED probe within this window of a good one proceeds (transient). */
const GOOD_PROBE_GRACE_MS = 15 * 60_000

export class AccountResolver {
  constructor(
    private readonly store: AccountStore,
    private readonly probe: AuthProbe = createClaudeAuthProbe(),
  ) {}

  /** Last GOOD probe per config dir — fresh-skip + transient-failure grace. */
  private readonly lastGoodProbe = new Map<string, { ts: number; identity?: string }>()

  /**
   * Pure resolution (no subprocess) — which account a project maps to, or
   * `legacy` when none is configured, or `dangling` when the mapped id no
   * longer exists. Kept sync + side-effect-free so it is trivially unit-tested.
   */
  resolve(projectRoot: string): AccountResolution {
    const overrideId = this.store.getProjectAccountId(projectRoot)
    if (overrideId !== null) {
      const account = this.store.getAccount(overrideId)
      return account
        ? { status: 'ready', account, source: 'override' }
        : { status: 'dangling', accountId: overrideId, reason: 'project override points to a removed account' }
    }
    const defaultId = this.store.getDefaultAccountId()
    if (defaultId !== null) {
      const account = this.store.getAccount(defaultId)
      return account
        ? { status: 'ready', account, source: 'default' }
        : { status: 'dangling', accountId: defaultId, reason: 'default account was removed' }
    }
    return { status: 'legacy' }
  }

  /**
   * Live auth probe for ONE config dir (settings UI). A good result warms the
   * session cache, so a green settings check also unblocks the next session.
   */
  async probeStatus(configDirPath: string): Promise<AuthStatus> {
    let status: AuthStatus
    try {
      status = await this.probe(configDirPath)
    } catch (error) {
      return { loggedIn: false, probeFailed: true, identity: error instanceof Error ? error.message : undefined }
    }
    if (status.loggedIn) {
      this.lastGoodProbe.set(configDirPath, { ts: Date.now(), identity: status.identity })
    }
    return status
  }

  /**
   * Full resolution for starting a session: resolve, then probe availability.
   * Returns `ready` only when the account is resolved AND logged in; otherwise
   * `unavailable`/`dangling`/`legacy`. The caller must fail closed on anything
   * that is not `ready` or `legacy`.
   */
  async resolveForSession(projectRoot: string): Promise<AccountResolution> {
    const resolved = this.resolve(projectRoot)
    if (resolved.status !== 'ready') {
      return resolved
    }
    const configDir = resolved.account.configDirPath
    // Fresh good probe → skip the subprocess entirely (briefs/explains fire
    // often; one probe per minute per account is plenty).
    const cached = this.lastGoodProbe.get(configDir)
    const now = Date.now()
    if (cached !== undefined && now - cached.ts < GOOD_PROBE_FRESH_MS) {
      return { status: 'ready', account: resolved.account, source: resolved.source, identity: cached.identity }
    }
    let status: AuthStatus
    try {
      status = await this.probe(configDir)
    } catch (error) {
      status = {
        loggedIn: false,
        probeFailed: true,
        identity: error instanceof Error ? error.message : undefined,
      }
    }
    if (status.loggedIn) {
      this.lastGoodProbe.set(configDir, { ts: now, identity: status.identity })
      return { status: 'ready', account: resolved.account, source: resolved.source, identity: status.identity }
    }
    // A FAILED probe (not an observed logout): tolerate transiently when a
    // recent probe was good — the session itself will fail loudly if auth is
    // truly gone. Only a VALID "loggedIn: false" observation fails closed.
    if (status.probeFailed === true) {
      if (cached !== undefined && now - cached.ts < GOOD_PROBE_GRACE_MS) {
        return { status: 'ready', account: resolved.account, source: resolved.source, identity: cached.identity }
      }
      return {
        status: 'unavailable',
        account: resolved.account,
        source: resolved.source,
        reason: `auth check for "${resolved.account.label}" did not complete (busy machine?) — try again`,
      }
    }
    this.lastGoodProbe.delete(configDir)
    return {
      status: 'unavailable',
      account: resolved.account,
      source: resolved.source,
      reason: `account "${resolved.account.label}" is not logged in`,
    }
  }
}

/**
 * The claude binary for auth login/probe subprocesses. A PACKAGED app launched
 * from Finder (or from the Start menu) gets the bare system PATH where `claude`
 * is not resolvable — spawning it ENOENTs and sign-in fails. Prefer the SDK's
 * bundled native binary (ships in node_modules; the same binary agent sessions
 * run via the SDK's own resolution), and fall back to PATH for environments
 * without it.
 *
 * B3: the package name used to be the literal `…-darwin-arm64/claude`, which on
 * any other platform threw and fell through to the bare-`claude` fallback. That
 * looked like it worked on the Windows test host ONLY because Claude Code
 * happened to be installed there independently — on a clean machine sign-in
 * simply fails. The name now comes from `shared/sdk-platform.mjs` (the one
 * authority both the main process and the packaging scripts read), and the
 * PATH fallback stays a genuine last resort that LOGS when it is taken, so the
 * degraded state names itself instead of being discovered at sign-in (NFR5).
 *
 * A binary the app provisioned itself (agent-binary.ts — downloaded when the
 * build shipped without one) counts the same as a bundled one.
 *
 * `platform`/`arch` are parameters so both branches are assertable off-platform
 * (NFR3); production callers take the defaults.
 */
export function resolveClaudeBin(
  platform: NodeJS.Platform | string = process.platform,
  arch: string = process.arch,
): string {
  const specifier = sdkBinarySpecifier(platform, arch)
  if (specifier === null) {
    console.warn(
      `[account-resolver] The Claude Agent SDK publishes no native package for ${platform}-${arch} — ` +
        'falling back to `claude` on PATH. Sign-in will fail unless Claude Code is installed separately.',
    )
    return 'claude'
  }
  const found = findAgentBinary({ platform, arch })
  if (found !== null) return found.path
  console.warn(
    `[account-resolver] SDK binary ${specifier} is not present in this build — ` +
      'falling back to `claude` on PATH. Sign-in will fail unless Claude Code is installed separately.',
  )
  return 'claude'
}

/**
 * The binary for a spawn that is about to happen: provisions it first when
 * this install lacks one (a download, once), and only then falls back to
 * `claude` on PATH. Async callers use this; resolveClaudeBin stays for the
 * sync ones.
 */
export async function resolveClaudeBinForSpawn(): Promise<string> {
  try {
    return (await ensureAgentBinary()).path
  } catch (error) {
    console.warn(`[account-resolver] ${error instanceof Error ? error.message : String(error)}`)
    return resolveClaudeBin()
  }
}

/**
 * Default probe: `claude auth status` (JSON) against a given CLAUDE_CONFIG_DIR.
 * `claude auth status` prints `{"loggedIn":false,...}` to stdout even on a
 * non-zero exit, so stdout is parsed regardless of the exit code.
 */
export function createClaudeAuthProbe(claudeBin?: string): AuthProbe {
  // Resolved per probe, not at construction: on an install that had to
  // download its binary, construction happens before the download lands.
  return async (configDirPath) => {
    const bin = claudeBin ?? (await resolveClaudeBinForSpawn())
    return new Promise<AuthStatus>((resolve) => {
      execFile(
        bin,
        ['auth', 'status'],
        {
          // #107: strip inherited auth tokens so the probe evaluates the SAME
          // auth the token-stripped session will — never report `ready` on a
          // token the session discards.
          env: buildAccountEnv(configDirPath),
          timeout: AUTH_PROBE_TIMEOUT_MS,
        },
        (_error, stdout) => {
          try {
            const parsed = JSON.parse(stdout) as {
              loggedIn?: unknown
              email?: unknown
              orgName?: unknown
            }
            const identityParts = [parsed.email, parsed.orgName].filter(
              (part): part is string => typeof part === 'string' && part.length > 0,
            )
            resolve({
              loggedIn: parsed.loggedIn === true,
              identity: identityParts.length > 0 ? identityParts.join(' · ') : undefined,
              // `claude auth status` EXITS 1 when logged out while still printing
              // a valid verdict — a parsed boolean is an OBSERVATION regardless
              // of exit code (#965). Failed = we observed nothing usable.
              ...(typeof parsed.loggedIn !== 'boolean' ? { probeFailed: true } : {}),
            })
          } catch {
            // No parseable JSON — the probe FAILED; it did not observe a logout.
            resolve({ loggedIn: false, probeFailed: true })
          }
        },
      )
    })
  }
}
