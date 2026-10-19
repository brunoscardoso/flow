// Sign OUT of an external runtime (multi_runtime_support).
//
// Flow can start a sign-in, so it has to be able to end one — an account you
// cannot leave is not an account you chose.
//
// MEASURED, per runtime, and they differ:
//
//   codex logout    → "Remove stored authentication credentials". Its own
//                     command, doing its own cleanup. Flow runs it.
//   copilot         → HAS NO LOGOUT. Not undocumented: `copilot logout`
//                     answers "Invalid command format". Its login is two
//                     things on disk — a keychain item (service `copilot-cli`)
//                     and a record in ~/.copilot/config.json — so signing out
//                     means removing both, ourselves.
//
// That second one is a bigger promise than "run the tool's own command", so it
// is made out loud: the confirmation says what will be removed, and the button
// only appears because a person asked for it twice. Both halves matter — the
// keychain item is what the CLI authenticates with, and the config record is
// what says who is signed in. Removing one and not the other produces a state
// where the tool and the app disagree, which is the failure this whole area has
// been about.

import { spawn } from 'child_process'
import { readFileSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

import { clearRuntimeAuthFailure } from './runtime-auth-state'
import { userPathEnv } from './tool-path'

export interface RuntimeLogoutResult {
  ok: boolean
  /** The tool's own last words when it refused — for the log, and the panel. */
  detail: string
}

export interface RuntimeLogoutDeps {
  /**
   * The caller has a person's explicit yes.
   *
   * REQUIRED FOR THE DESTRUCTIVE PATH, and it is required because it already
   * went wrong: a unit test called `signOutRuntime('copilot')` with no injected
   * deps, and the default implementation deleted a real keychain item and
   * rewrote a real config file on the machine running the suite. A function
   * whose default behaviour destroys something must not be reachable by
   * accident — so the deletion happens only when the caller says, in the call,
   * that a human asked for it.
   */
  confirmed?: boolean
  spawnFn?: typeof spawn
  timeoutMs?: number
  platform?: NodeJS.Platform | string
  /** Injected in tests: remove a keychain item. */
  forgetKeychainFn?: (
    service: string,
    deps: RuntimeLogoutDeps,
  ) => Promise<{ ok: boolean; absent: boolean; detail: string }>
  /** Injected in tests: clear Copilot's own signed-in record. */
  clearCopilotRecordFn?: () => { ok: boolean; detail: string }
}

/** Removing local credentials is a local operation; it should be quick. */
const LOGOUT_TIMEOUT_MS = 30_000

/** What to run to sign out, or null when the runtime offers no such command. */
export function logoutCommand(provider: string): { command: string; args: string[] } | null {
  if (provider === 'codex') return { command: 'codex', args: ['logout'] }
  // Claude's accounts are Flow's own (Settings → Accounts → Remove); Copilot
  // has no command and is signed out by removing what it stored — see below.
  return null
}

/** True when Flow can sign this runtime out at all, by any means. */
export function canSignOut(provider: string): boolean {
  return logoutCommand(provider) !== null || provider === 'copilot'
}

function run(
  plan: { command: string; args: string[] },
  deps: RuntimeLogoutDeps,
  env?: NodeJS.ProcessEnv,
): Promise<RuntimeLogoutResult & { missing?: boolean }> {
  const spawnFn = deps.spawnFn ?? spawn
  return new Promise((resolve) => {
    let output = ''
    let child: ReturnType<typeof spawnFn>
    try {
      child = spawnFn(plan.command, plan.args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        ...(env === undefined ? {} : { env }),
      })
    } catch (error) {
      const message = (error as Error).message
      resolve({ ok: false, detail: message, ...(isMissing(message) ? { missing: true } : {}) })
      return
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      resolve({ ok: false, detail: 'The sign-out took too long and was stopped.' })
    }, deps.timeoutMs ?? LOGOUT_TIMEOUT_MS)
    const read = (chunk: Buffer | string): void => {
      output += String(chunk)
    }
    child.stdout?.on('data', read)
    child.stderr?.on('data', read)
    child.on('error', (error) => {
      clearTimeout(timer)
      resolve({
        ok: false,
        detail: error.message,
        ...(isMissing(error.message) ? { missing: true } : {}),
      })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      const detail = output.trim().replace(/\s+/g, ' ').slice(0, 300)
      resolve({ ok: code === 0, detail })
    })
  })
}

/**
 * Copilot's sign-out: forget the keychain item, then the record.
 *
 * IN THAT ORDER, deliberately. The keychain item is what the CLI actually
 * authenticates with; the config record is what says who is signed in. If the
 * first fails we stop, because clearing only the record would leave Flow saying
 * "signed out" about a CLI that is still perfectly logged in — the exact
 * disagreement between a tool and its app that this area keeps producing.
 */
async function signOutCopilot(deps: RuntimeLogoutDeps): Promise<RuntimeLogoutResult> {
  const forget = deps.forgetKeychainFn ?? forgetKeychainItem
  const clear = deps.clearCopilotRecordFn ?? clearCopilotRecord
  const removed = await forget(COPILOT_KEYCHAIN_SERVICE, deps)
  if (!removed.ok && !removed.absent) {
    return { ok: false, detail: removed.detail }
  }
  const cleared = clear()
  return cleared.ok
    ? { ok: true, detail: 'Signed out of Copilot on this machine.' }
    : { ok: false, detail: cleared.detail }
}

/** The service name Copilot stores its token under (read from the login
 *  keychain on the machine this was written on). */
const COPILOT_KEYCHAIN_SERVICE = 'copilot-cli'

/** Delete a generic-password item. `absent` = there was nothing to delete,
 *  which is a sign-out that has already happened, not a failure. */
async function forgetKeychainItem(
  service: string,
  deps: RuntimeLogoutDeps,
): Promise<{ ok: boolean; absent: boolean; detail: string }> {
  if ((deps.platform ?? process.platform) !== 'darwin') {
    // No `security` outside macOS; the record below is then all Flow can clear.
    return { ok: false, absent: true, detail: '' }
  }
  const result = await run({ command: 'security', args: ['delete-generic-password', '-s', service] }, deps)
  const absent = /could not be found|SecKeychainSearchCopyNext/i.test(result.detail)
  return { ok: result.ok, absent, detail: result.detail }
}

/**
 * Remove the "who is signed in" record from Copilot's own settings file,
 * leaving everything else in it exactly as it was — it is that program's file,
 * and Flow is a guest in it.
 */
function clearCopilotRecord(): { ok: boolean; detail: string } {
  const home = process.env['COPILOT_HOME'] ?? join(homedir(), '.copilot')
  const path = join(home, 'config.json')
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return { ok: true, detail: '' } // nothing recorded: already signed out
  }
  // The file is JSON with // comment lines (see runtime-credentials.ts).
  const body = raw
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('//'))
    .join('\n')
  let data: Record<string, unknown>
  try {
    data = JSON.parse(body) as Record<string, unknown>
  } catch {
    return { ok: false, detail: 'Copilot’s settings file could not be read.' }
  }
  delete data['loggedInUsers']
  delete data['lastLoggedInUser']
  try {
    writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`)
  } catch {
    return { ok: false, detail: 'Copilot’s settings file could not be written.' }
  }
  return { ok: true, detail: '' }
}

function isMissing(message: string): boolean {
  return /ENOENT|not found|no such file/i.test(message)
}

/**
 * Sign `provider` out. Never throws — a refusal is an answer.
 *
 * Same PATH story as everything else that spawns a user's tool: try what this
 * process can see, then the user's own PATH (tool-path.ts).
 */
export async function signOutRuntime(
  provider: string,
  deps: RuntimeLogoutDeps = {},
): Promise<RuntimeLogoutResult> {
  if (provider === 'copilot') {
    // No accidental deletions — see `confirmed`.
    if (deps.confirmed !== true && deps.forgetKeychainFn === undefined) {
      return { ok: false, detail: 'Signing out of Copilot needs an explicit confirmation.' }
    }
    const result = await signOutCopilot(deps)
    if (result.ok) clearRuntimeAuthFailure(provider)
    console.log(
      `[runtime-logout] copilot: ${result.ok ? 'signed out' : `refused — ${result.detail}`}`,
    )
    return result
  }
  const plan = logoutCommand(provider)
  if (plan === null) {
    return { ok: false, detail: `Flow cannot sign out of ${provider}.` }
  }
  let result = await run(plan, deps)
  if (result.missing === true) {
    const env = await userPathEnv({
      ...(deps.spawnFn === undefined ? {} : { spawnFn: deps.spawnFn }),
    })
    if (env !== null) result = await run(plan, deps, env)
  }
  console.log(`[runtime-logout] ${provider}: ${result.ok ? 'signed out' : `refused — ${result.detail}`}`)
  // Whatever the session had observed about this credential is moot now.
  if (result.ok) clearRuntimeAuthFailure(provider)
  return { ok: result.ok, detail: result.detail }
}
