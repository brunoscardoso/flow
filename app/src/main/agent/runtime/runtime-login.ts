// Sign in to an external runtime, in the app (multi_runtime_support).
//
// The first version opened a terminal and typed the login command into it. It
// worked, and it was still wrong: the user is in a graphical app, mid-setup,
// and the answer to "sign in" was "here is a shell, you do it". Claude's own
// sign-in has never worked that way — it shows a URL, waits, and tells you when
// it is done — and there is no reason the other two cannot.
//
// MEASURED AGAINST THE LIVE TOOLS, not their docs (allowed-pattern #11):
//
//   copilot login --device-code
//     → "To authenticate, visit https://github.com/login/device and enter code
//        6CB7-0989\nWaiting for authorization...\n"
//
// That is everything an in-app flow needs: a URL to open and a code to type,
// then a process that exits 0 when the browser side completes. `codex login`
// runs a browser/loopback flow and prints its URL the same way, so ONE parser
// serves both: first URL wins, a device code if one is offered, and whatever
// the tool says otherwise is relayed rather than interpreted.
//
// One login at a time, app-wide — the same rule the Claude orchestrator has.
// Two concurrent OAuth flows racing for one callback port is not a state worth
// supporting.

import { spawn } from 'child_process'

import { clearRuntimeAuthFailure } from './runtime-auth-state'
import { userPathEnv } from './tool-path'

/**
 * Why a sign-in ended, in Flow's vocabulary rather than the tool's.
 *
 * THE TOOL'S OWN WORDS DO NOT GO ON SCREEN. Relaying them produced "Codex
 * sign-in did not complete — in `model_reasoning_effort`" — the second line of
 * a config parse error, handed to somebody who pressed a button called Sign in.
 * The raw output still goes to the log, where a developer can read it.
 */
export type LoginFailureReason =
  | 'config-unreadable'
  | 'not-installed'
  | 'cancelled'
  | 'timeout'
  | 'failed'

export interface RuntimeLoginEvent {
  provider: string
  kind: 'url' | 'code' | 'done' | 'error'
  url?: string
  code?: string
  reason?: LoginFailureReason
}

export interface RuntimeLoginResult {
  ok: boolean
  reason?: LoginFailureReason
}

export interface RuntimeLoginDeps {
  spawnFn?: typeof spawn
  timeoutMs?: number
}

/** An OAuth round trip is a human doing things in a browser. */
const LOGIN_TIMEOUT_MS = 300_000

/**
 * What to run to sign in, per runtime.
 *
 * Copilot is asked for the DEVICE-CODE flow on purpose: its default is a
 * browser it opens itself with a loopback callback, which gives a GUI app
 * nothing to show if that browser never appears. A code and a URL can always be
 * shown, copied, and typed somewhere else.
 */
export function loginCommand(provider: string): { command: string; args: string[] } | null {
  if (provider === 'codex') return { command: 'codex', args: ['login'] }
  if (provider === 'copilot') return { command: 'copilot', args: ['login', '--device-code'] }
  // Claude's login is Flow's own orchestrator (accounts:add), not this path.
  return null
}

const URL_PATTERN = /https?:\/\/[^\s"'`<>]+/
/** `…enter code 6CB7-0989`, and the shapes near it. */
const CODE_PATTERN = /\bcode[:\s]+([A-Z0-9]{4,}-[A-Z0-9]{4,})\b/i

export function findLoginUrl(text: string): string | null {
  const match = URL_PATTERN.exec(text)
  return match === null ? null : match[0].replace(/[.,)]+$/, '')
}

export function findLoginCode(text: string): string | null {
  const match = CODE_PATTERN.exec(text)
  return match?.[1] ?? null
}

/** One line per sign-in, so a report of "it did not complete" is answerable. */
function logLogin(provider: string, message: string): void {
  console.log(`[runtime-login] ${provider}: ${message}`)
}

/** The single in-flight login, or null. */
let active: { kill: () => void; provider: string } | null = null

/** Set when WE stopped it, so the outcome is "cancelled", not "failed". */
let cancelled = false

/** Is a login running right now? */
export function runtimeLoginInFlight(): string | null {
  return active?.provider ?? null
}

/** Stop the in-flight login, if any. Safe to call when there is none. */
export function cancelRuntimeLogin(): void {
  if (active !== null) cancelled = true
  active?.kill()
  active = null
}

/**
 * What kind of failure this was, read from the tool's output.
 *
 * A tool that cannot parse its own configuration has not refused the login —
 * it never got to it. Measured here: `codex login` on codex-cli 0.19.0 with a
 * newer key in ~/.codex/config.toml exits before doing anything at all.
 */
export function classifyFailure(output: string): LoginFailureReason {
  return /error loading configuration|failed to (parse|load) config|invalid config|unknown variant/i.test(
    output,
  )
    ? 'config-unreadable'
    : 'failed'
}

/** True when a spawn failure means "the tool is not on this PATH". */
function isMissingCommand(message: string): boolean {
  return /ENOENT|not found|no such file/i.test(message)
}

/** One attempt, with one env. `missing` means the tool was not on that PATH. */
function runLogin(
  provider: string,
  plan: { command: string; args: string[] },
  emit: (event: RuntimeLoginEvent) => void,
  deps: RuntimeLoginDeps,
  env?: NodeJS.ProcessEnv,
): Promise<RuntimeLoginResult & { missing?: boolean }> {
  const spawnFn = deps.spawnFn ?? spawn
  return new Promise((resolve) => {
    let output = ''
    let sentUrl = false
    let sentCode = false
    let child: ReturnType<typeof spawnFn>
    try {
      child = spawnFn(plan.command, plan.args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        ...(env === undefined ? {} : { env }),
      })
    } catch (error) {
      const detail = (error as Error).message
      logLogin(provider, `spawn failed: ${detail}`)
      resolve({
        ok: false,
        reason: isMissingCommand(detail) ? 'not-installed' : 'failed',
        ...(isMissingCommand(detail) ? { missing: true } : {}),
      })
      return
    }
    const settle = (result: RuntimeLoginResult & { missing?: boolean }): void => {
      clearTimeout(timer)
      active = null
      resolve(result)
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      settle({ ok: false, reason: 'timeout' })
    }, deps.timeoutMs ?? LOGIN_TIMEOUT_MS)
    active = { provider, kill: () => child.kill('SIGKILL') }

    const read = (chunk: Buffer | string): void => {
      const text = String(chunk)
      output += text
      if (!sentUrl) {
        const url = findLoginUrl(output)
        if (url !== null) {
          sentUrl = true
          emit({ provider, kind: 'url', url })
        }
      }
      if (!sentCode) {
        const code = findLoginCode(output)
        if (code !== null) {
          sentCode = true
          emit({ provider, kind: 'code', code })
        }
      }
    }
    child.stdout?.on('data', read)
    child.stderr?.on('data', read)
    child.on('error', (error) => {
      logLogin(provider, `error: ${error.message}`)
      settle({
        ok: false,
        reason: isMissingCommand(error.message) ? 'not-installed' : 'failed',
        ...(isMissingCommand(error.message) ? { missing: true } : {}),
      })
    })
    const finish = (code: number | null): void => {
      // The tool's own words, in the LOG — the one place they help.
      logLogin(provider, `exit ${String(code)}: ${output.trim().replace(/\s+/g, ' ').slice(0, 300)}`)
      if (code === 0) {
        settle({ ok: true })
        return
      }
      settle({
        ok: false,
        reason: cancelled ? 'cancelled' : classifyFailure(output),
      })
    }
    child.on('close', finish)
    // 'close' waits for every pipe to close, and a killed login can leave one
    // held by a child of its own — measured: cancelling left the panel saying
    // "Flow is waiting" for as long as the test would wait. 'exit' is the
    // process's own end, so settle on it if the pipes lag behind.
    child.on('exit', (code) => {
      setTimeout(() => finish(code), 250)
    })
  })
}

/**
 * Run `provider`'s login, reporting what it says as it says it. Resolves when
 * the process exits — success is the tool's own exit code, never a guess.
 *
 * Tries the PATH this process has first; only a tool that is not there costs a
 * shell lookup (tool-path.ts), which is the same order the probes use.
 */
export async function startRuntimeLogin(
  provider: string,
  emit: (event: RuntimeLoginEvent) => void,
  deps: RuntimeLoginDeps = {},
): Promise<RuntimeLoginResult> {
  const plan = loginCommand(provider)
  if (plan === null) return { ok: false, reason: 'failed' }
  if (active !== null) return { ok: false, reason: 'failed' }
  cancelled = false
  let result = await runLogin(provider, plan, emit, deps)
  if (result.missing === true) {
    const env = await userPathEnv({
      ...(deps.spawnFn === undefined ? {} : { spawnFn: deps.spawnFn }),
    })
    if (env !== null) result = await runLogin(provider, plan, emit, deps, env)
  }
  const settled: RuntimeLoginResult = {
    ok: result.ok,
    ...(result.ok ? {} : { reason: result.reason ?? 'failed' }),
  }
  // A fresh sign-in answers the refusal that sent them here.
  if (settled.ok) clearRuntimeAuthFailure(provider)
  emit({
    provider,
    kind: settled.ok ? 'done' : 'error',
    ...(settled.reason === undefined ? {} : { reason: settled.reason }),
  })
  return settled
}
