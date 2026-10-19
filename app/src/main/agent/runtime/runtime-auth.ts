// Is this runtime ready to run? (multi_runtime_support)
//
// TWO QUESTIONS, and the reader's decision needs no more: is the tool
// installed, and is it signed in. Each is asked of the thing that can actually
// answer it.
//
//   installed → the tool's own `--version`, which every CLI answers without
//               touching config, credentials or the network.
//   signed in → the tool's own CREDENTIAL FILE (runtime-credentials.ts), not
//               the tool.
//
// That second choice is the whole lesson of this module, learned twice from
// real machines (allowed-pattern #11):
//
//   codex login status → exit 1, "Error loading configuration: unknown variant
//                        `xhigh`" — from ONE unrelated key in config.toml, to a
//                        user who was signed in.
//   copilot            → no status subcommand exists; asking the binary could
//                        only ever produce "Flow cannot check its sign-in from
//                        here", which a user who had just completed the GitHub
//                        device flow read — correctly — as broken.
//
// Asking a CLI whether it is signed in means running a program that has many
// other reasons to fail. Reading the file it writes at login has one.
//
// `unknown` survives for the case that is genuinely unreadable: a version probe
// that failed for a reason other than "not installed".

import { spawn } from 'child_process'

import { readCredentials, type CredentialRecord } from './runtime-credentials'
import { runtimeAuthFailedAt } from './runtime-auth-state'
import { userPathEnv } from './tool-path'

/** What a probe found. `unknown` = the tool answered something we cannot read. */
export type RuntimeAuthStatus = 'ready' | 'not-installed' | 'not-signed-in' | 'unknown'

export interface RuntimeAuthResult {
  provider: string
  status: RuntimeAuthStatus
  /** The CLI's own first line, or the reason a probe could not run. */
  detail: string
}

/** A probe gets this long before it is a failure — a login check is local. */
const PROBE_TIMEOUT_MS = 10_000

export interface RuntimeAuthDeps {
  spawnFn?: typeof spawn
  /** Injected in tests; production reads the runtime's own credential file. */
  readCredentialsFn?: (provider: string) => CredentialRecord
  /** Injected in tests; production asks the session's refusal record. */
  authFailedAtFn?: (provider: string) => number | null
  /** Accounts configured in Flow (the Claude answer). */
  claudeAccountCount?: () => number
  timeoutMs?: number
}

/** Run one probe, capturing both streams. Never throws — a probe is a question. */
function probe(
  command: string,
  args: readonly string[],
  deps: RuntimeAuthDeps,
  env?: NodeJS.ProcessEnv,
): Promise<{ code: number | null; output: string; spawnError: string | null }> {
  const spawnFn = deps.spawnFn ?? spawn
  return new Promise((resolve) => {
    let output = ''
    let child: ReturnType<typeof spawnFn>
    try {
      child = spawnFn(command, [...args], {
        stdio: ['ignore', 'pipe', 'pipe'],
        ...(env === undefined ? {} : { env }),
      })
    } catch (error) {
      resolve({ code: null, output: '', spawnError: (error as Error).message })
      return
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      resolve({ code: null, output, spawnError: 'timed out' })
    }, deps.timeoutMs ?? PROBE_TIMEOUT_MS)
    child.stdout?.on('data', (chunk: Buffer | string) => {
      output += String(chunk)
    })
    child.stderr?.on('data', (chunk: Buffer | string) => {
      output += String(chunk)
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      resolve({ code: null, output, spawnError: error.message })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, output, spawnError: null })
    })
  })
}

/**
 * Run a probe, and when the command simply is not on the PATH this process
 * inherited, retry once with the PATH the USER has (tool-path.ts).
 *
 * WHY THE SECOND TRY EXISTS: a Finder-launched app gets
 * `/usr/bin:/bin:/usr/sbin:/sbin`, so `spawn('codex')` ENOENTs in 1 ms on a
 * machine where codex is installed and working — reported from a real desktop
 * as "Copilot is not installed on this machine". The plain attempt stays first,
 * so the common case (a terminal-launched app, a tool on the system PATH) costs
 * nothing at all.
 */
async function probeOrFindIt(
  command: string,
  args: readonly string[],
  deps: RuntimeAuthDeps,
): Promise<{ code: number | null; output: string; spawnError: string | null }> {
  const first = await probe(command, args, deps)
  if (first.spawnError === null || !isMissingCommand(first.spawnError)) return first
  const env = await userPathEnv({
    ...(deps.spawnFn === undefined ? {} : { spawnFn: deps.spawnFn }),
  })
  if (env === null) return first
  return probe(command, args, deps, env)
}

/** True when a spawn failure means "the command is not on PATH". */
function isMissingCommand(spawnError: string): boolean {
  return /ENOENT|not found|no such file/i.test(spawnError)
}

/**
 * Is `provider` usable right now?
 *
 * Claude answers from Flow's own account store — the app manages those logins
 * itself, so no subprocess is needed and none is spawned. The other two are
 * external CLIs and get asked.
 */
/**
 * One line per check, so a report of "it says I am not signed in" can be
 * answered with what was actually observed rather than a guess. Cheap enough
 * to leave on: a runtime check happens when a person picks from a dropdown.
 */
function logCheck(answer: RuntimeAuthResult, source: string): void {
  console.log(
    `[runtime-auth] ${answer.provider}: ${answer.status} (${source}) — ${answer.detail}`,
  )
}

export async function checkRuntimeAuth(
  provider: string,
  deps: RuntimeAuthDeps = {},
): Promise<RuntimeAuthResult> {
  if (provider === 'claude') {
    const count = deps.claudeAccountCount?.() ?? 0
    logCheck(
      {
        provider,
        status: count > 0 ? 'ready' : 'not-signed-in',
        detail: `${String(count)} account(s)`,
      },
      'account store',
    )
    return count > 0
      ? { provider, status: 'ready', detail: `${String(count)} account${count === 1 ? '' : 's'}` }
      : {
          provider,
          status: 'not-signed-in',
          detail: 'No Claude account is connected yet.',
        }
  }

  if (provider === 'codex' || provider === 'copilot') {
    // ONE: is it there? The tool's own version flag, which every CLI answers
    // without touching config, credentials or the network.
    const presence = await probeOrFindIt(provider, ['--version'], deps)
    if (presence.spawnError !== null) {
      const answer: RuntimeAuthResult = isMissingCommand(presence.spawnError)
        ? {
            provider,
            status: 'not-installed',
            detail: `The ${provider} command is not installed.`,
          }
        : { provider, status: 'unknown', detail: presence.spawnError }
      logCheck(answer, 'version probe')
      return answer
    }

    // TWO: is it signed in? ASKED OF THE TOOL'S OWN CREDENTIAL FILE, not of
    // the tool. `codex login status` exits non-zero over an unrelated config
    // key, and copilot has no status command at all — between them they
    // produced "Flow could not confirm…" for two users who were both signed in.
    // …UNLESS THE RUNTIME ITSELF JUST REFUSED IT. A file full of tokens says
    // nothing about whether they are still accepted, and one that is not is
    // exactly the state a person needs to be told about: measured as
    // "Failed to refresh token: 401 Unauthorized" on every turn, under a
    // settings panel that went on showing a green tick.
    const refusedAt = (deps.authFailedAtFn ?? runtimeAuthFailedAt)(provider)
    if (refusedAt !== null) {
      const answer: RuntimeAuthResult = {
        provider,
        status: 'not-signed-in',
        detail: 'The last turn was rejected — sign in again.',
      }
      logCheck(answer, 'runtime refused')
      return answer
    }
    const credentials = (deps.readCredentialsFn ?? readCredentials)(provider)
    const answer: RuntimeAuthResult = credentials.signedIn
      ? {
          provider,
          status: 'ready',
          detail: credentials.identity ?? 'signed in',
        }
      : { provider, status: 'not-signed-in', detail: 'No saved sign-in was found.' }
    logCheck(answer, 'credential file')
    return answer
  }

  return { provider, status: 'unknown', detail: `Flow does not know the ${provider} runtime.` }
}

/** Whether a runtime may be selected — everything but a verified `ready` is a no. */
export function runtimeSelectable(result: RuntimeAuthResult): boolean {
  return result.status === 'ready'
}
