// LoginOrchestrator — Flow-orchestrated login for a new account into its own
// isolated CLAUDE_CONFIG_DIR.
//
// The runtime spike proved the model end-to-end: `CLAUDE_CONFIG_DIR=<dir>
// claude auth status` reports `loggedIn:false` for a fresh dir and the real
// login for the default dir — i.e. per-process env fully controls auth
// identity, keychain included. So onboarding an account is:
//   1. allocate an isolated dir under ~/.flow/accounts/<id>/
//   2. run `claude auth login` against it (the one interactive, user-only step
//      — a browser OAuth flow Flow cannot complete on the user's behalf)
//   3. detect completion + capture identity via the auth-status probe
//
// #972: `claude auth login` always uses the paste-the-code OAuth mode — it
// prints "If the browser didn't open, visit: <url>", then blocks on
// "Paste code here if prompted >" waiting for the authorization code on STDIN.
// So the spawn keeps stdin open, streams stdout/stderr to detect the URL and
// the code prompt (surfaced to the UI via `onProgress`), and `submitCode`
// delivers the user's pasted code to the child. `cancelLogin` lets the user
// abort instead of waiting out the 5-minute timeout.

import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import type { AuthProbe } from './account-resolver'
import { createClaudeAuthProbe, resolveClaudeBinForSpawn } from './account-resolver'
import { buildAccountEnv } from './account-env'
import {
  OWNER_ONLY_DIR_MODE,
  protectionFailureMessage,
  protectOwnerOnly,
  type ProtectionKind,
  type ProtectionResult,
} from '../platform/file-protection'

export interface LoginResult {
  completed: boolean
  /** Identity (email · org) when the login succeeded. */
  identity?: string
  /** Failure detail when `completed` is false. */
  error?: string
}

/** Progress of an interactive login, surfaced to the UI (#972). Each kind is
 *  emitted at most once per login. */
export type LoginProgress = { kind: 'url'; url: string } | { kind: 'awaiting-code' }

export interface LoginOrchestratorOptions {
  /** Root for per-account config dirs. Default: ~/.flow/accounts. */
  accountsDir?: string
  /** `claude` binary. Default: the SDK's bundled native binary, PATH fallback
   *  (see resolveClaudeBin — a packaged app's PATH has no `claude`). */
  claudeBin?: string
  /** Availability probe. Default: `claude auth status` against the dir. */
  probe?: AuthProbe
  /**
   * Owner-only protection for the per-account config dir. Default:
   * `protectOwnerOnly` — mode 0700 on POSIX, an explicit ACL on Windows.
   * Injected so both branches are testable off-platform (NFR3).
   */
  protect?: (target: string, kind: ProtectionKind) => ProtectionResult
}

/** How long to wait for the interactive `claude auth login` to finish. */
const LOGIN_TIMEOUT_MS = 5 * 60_000

/**
 * Terminal escape sequences — OSC (`ESC ] … BEL` or `ESC ] … ESC \`) and CSI
 * (`ESC [ … final`) — removed before anything is matched.
 *
 * `claude` prints the sign-in URL as an OSC 8 HYPERLINK when it believes the
 * terminal supports one: `ESC ] 8 ; ; <url> BEL <url> ESC ] 8 ; ; BEL`. None
 * of that is whitespace, so a `\S+` capture ran straight through the escape
 * bytes and took the address TWICE OVER as one "URL" — which is then what the
 * assist's fallback link and `shell.openExternal` are handed.
 *
 * Reproduced on Windows against the bundled claude 2.1.204 with the app's own
 * spawn options: with `WT_SESSION` in the environment the output is the
 * hyperlink form, without it a plain URL. It is not a terminal-only concern —
 * an Electron app inherits the environment it was launched from, so `npm run
 * dev` from Windows Terminal reaches the app while a shortcut launch does not.
 */
const ANSI_PATTERN =
  // eslint-disable-next-line no-control-regex
  /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b\[[0-9;?]*[ -/]*[@-~]/g

const stripAnsi = (text: string): string => text.replace(ANSI_PATTERN, '')

/**
 * A URL runs to whitespace — and, defensively, never contains the control
 * bytes above even if a sequence shape slips past the stripper.
 */
// eslint-disable-next-line no-control-regex
const URL_PATTERN = /https?:\/\/[^\s\u0007\u001b]+/

export class LoginOrchestrator {
  private readonly accountsDir: string
  /** Explicit binary (tests); undefined = resolved when a login starts. */
  private readonly claudeBin: string | undefined
  /** A login is resolving its binary (possibly downloading it) — not yet spawned. */
  private preparing = false
  private readonly probe: AuthProbe
  private readonly protect: (target: string, kind: ProtectionKind) => ProtectionResult
  /** The single in-flight login's child + abort hook — null when idle (#972). */
  private active: { child: ChildProcess; cancel: () => void } | null = null
  /** Why the last allocated config dir is NOT owner-only, or null when it is. */
  private protectionFailure: string | null = null

  constructor(options: LoginOrchestratorOptions = {}) {
    this.accountsDir = options.accountsDir ?? join(homedir(), '.flow', 'accounts')
    this.claudeBin = options.claudeBin
    this.probe = options.probe ?? createClaudeAuthProbe(this.claudeBin)
    this.protect = options.protect ?? ((target, kind) => protectOwnerOnly(target, { kind }))
  }

  /**
   * Absolute, isolated config-dir path for an account id (created on demand).
   *
   * The dir holds a live Claude session — the same class of secret as
   * `credentials.json` — so it gets the same owner-only treatment (B5). The
   * `mode` below is honoured on POSIX and IGNORED on Windows, which is why the
   * explicit protection call follows it rather than trusting the mode alone.
   * A protection failure is reported, never swallowed (NFR5); the dir is still
   * returned, because refusing to sign in at all is the worse failure.
   */
  allocateConfigDir(accountId: string): string {
    const dir = join(this.accountsDir, accountId)
    mkdirSync(dir, { recursive: true, mode: OWNER_ONLY_DIR_MODE })
    const result = this.protect(dir, 'directory')
    if (result.applied) {
      this.protectionFailure = null
    } else {
      this.protectionFailure = protectionFailureMessage(dir, 'directory', result)
      console.error(`[Login] SECURITY: ${this.protectionFailure}`)
    }
    return dir
  }

  /**
   * Why the last allocated account config dir is NOT owner-only, or null when
   * it is. Non-null means another local user may be able to read a live Claude
   * session from disk.
   *
   * NOTE (review F3): nothing calls this outside tests today — the failure is
   * loud to logs (`console.error` with `SECURITY:`), not to the user. Wiring it
   * to a user-visible surface is tracked separately; see the same note in
   * `../credentials.ts`.
   */
  protectionWarning(): string | null {
    return this.protectionFailure
  }

  /**
   * Run the interactive `claude auth login` against an isolated config dir,
   * then confirm success with the auth-status probe. Resolves when the login
   * process exits (or times out / is canceled); success is decided by the
   * probe, never by the exit code alone — the config dir is the source of
   * truth. `onProgress` receives the sign-in URL and the awaiting-code prompt
   * as the child emits them (#972). Only ONE login may be active at a time.
   */
  async login(
    configDirPath: string,
    onProgress?: (progress: LoginProgress) => void,
  ): Promise<LoginResult> {
    if (this.active !== null || this.preparing) {
      return { completed: false, error: 'another sign-in is already in progress' }
    }
    // Resolved now, not at construction: an install that has to download its
    // binary constructs this orchestrator before the download lands. The
    // `preparing` flag keeps the one-login guard closed across that await.
    this.preparing = true
    let claudeBin: string
    try {
      claudeBin = this.claudeBin ?? (await resolveClaudeBinForSpawn())
    } finally {
      this.preparing = false
    }
    const exited = await this.spawnLogin(claudeBin, configDirPath, onProgress)
    if (exited.error) {
      return { completed: false, error: exited.error }
    }
    // The config dir — not the exit code — is authoritative.
    const status = await this.probe(configDirPath)
    if (!status.loggedIn) {
      return { completed: false, error: 'login did not complete (still logged out)' }
    }
    return { completed: true, identity: status.identity }
  }

  /**
   * Deliver the pasted authorization code to the active login's stdin (#972).
   * Returns false when no login is waiting (or the code is blank).
   */
  submitCode(code: string): boolean {
    const trimmed = code.trim()
    if (trimmed.length === 0) return false
    const stdin = this.active?.child.stdin
    if (!stdin) return false
    stdin.write(`${trimmed}\n`)
    return true
  }

  /**
   * Abort the active login (#972): SIGTERM the child and resolve the pending
   * `login()` as canceled. Returns false when no login is active.
   */
  cancelLogin(): boolean {
    if (this.active === null) return false
    this.active.cancel()
    return true
  }

  /** Re-check an account's login without re-running it (for fail-closed probes). */
  verify(configDirPath: string): Promise<{ loggedIn: boolean; identity?: string }> {
    return this.probe(configDirPath)
  }

  /** Remove an account's isolated config dir (on account deletion). */
  removeConfigDir(configDirPath: string): void {
    rmSync(configDirPath, { recursive: true, force: true })
  }

  /** Spawn `claude auth login` with the isolated dir; resolve on exit/timeout/
   *  cancel. Streams stdout+stderr to detect the sign-in URL and the paste-code
   *  prompt, each reported once via `onProgress` (#972). */
  private spawnLogin(
    claudeBin: string,
    configDirPath: string,
    onProgress?: (progress: LoginProgress) => void,
  ): Promise<{ error?: string }> {
    return new Promise((resolve) => {
      let settled = false
      const done = (result: { error?: string }): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        this.active = null
        resolve(result)
      }

      const child = spawn(claudeBin, ['auth', 'login'], {
        // #107: same token-stripped env as the session/probe, so a login can't
        // spuriously succeed on an inherited token the session won't use.
        env: buildAccountEnv(configDirPath),
        // #972: stdin stays OPEN — the CLI blocks on "Paste code here if
        // prompted >" and the code can only arrive via submitCode → stdin.
        stdio: ['pipe', 'pipe', 'pipe'],
      })

      // Line-oriented progress detection over the combined output. The CLI
      // prints "If the browser didn't open, visit: <url>" then blocks on
      // "Paste code here if prompted >" (verified against claude 2.1.204).
      let output = ''
      let urlEmitted = false
      let awaitingEmitted = false
      const scan = (chunk: string): void => {
        output += chunk
        // Strip on the ACCUMULATED text, never per chunk: an escape sequence
        // can be split across two reads.
        const clean = stripAnsi(output)
        if (!urlEmitted) {
          const match = clean.match(URL_PATTERN)
          if (match) {
            urlEmitted = true
            onProgress?.({ kind: 'url', url: match[0] })
          }
        }
        if (!awaitingEmitted) {
          const pastePrompt = /paste code/i.test(clean)
          const trailingPrompt = urlEmitted && />\s*$/.test(clean)
          if (pastePrompt || trailingPrompt) {
            awaitingEmitted = true
            onProgress?.({ kind: 'awaiting-code' })
          }
        }
      }
      child.stdout?.setEncoding('utf8')
      child.stdout?.on('data', (chunk: string) => scan(chunk))
      child.stderr?.setEncoding('utf8')
      child.stderr?.on('data', (chunk: string) => scan(chunk))

      this.active = {
        child,
        cancel: () => {
          child.kill('SIGTERM')
          done({ error: 'sign-in canceled' })
        },
      }

      const timer = setTimeout(() => {
        child.kill('SIGTERM')
        done({ error: 'sign-in timed out after 5 minutes — the pasted code never arrived' })
      }, LOGIN_TIMEOUT_MS)

      child.on('error', (error) => {
        done({ error: error.message })
      })
      child.on('exit', () => {
        done({})
      })
    })
  }
}
