// Install a runtime's command-line tool (multi_runtime_support).
//
// "Copilot is not installed on this machine, so Flow cannot run it. Install it,
// sign in, then pick it here." — that sentence was the whole answer a person got
// from a graphical app that knows exactly what to run. It is the shape
// forbidden-pattern #12 exists to catch: the app hands its own job back to the
// reader and calls it guidance.
//
// So Flow installs it. Two rules keep that honest:
//
//   1. INSTALL ONLY, NEVER SIGN IN. `npm install -g` needs no input; a login
//      opens a browser and waits for a pasted code. Running the second one out
//      of sight would hang forever with nothing on screen to answer. The login
//      keeps its terminal.
//   2. The package names were checked against the LIVE registry, not docs
//      (allowed-pattern #11): @github/copilot 1.0.80 and @openai/codex 0.147.0
//      both resolve today. A name that only appeared in a README is a button
//      that fails at press time.

import { spawn } from 'child_process'

import { userPathEnv } from './tool-path'

export interface RuntimeInstallResult {
  ok: boolean
  /** The installer's own last words — the reason, when it failed. */
  detail: string
}

export interface RuntimeInstallDeps {
  spawnFn?: typeof spawn
  timeoutMs?: number
}

/** A global npm install over a slow link is minutes, not seconds. */
const INSTALL_TIMEOUT_MS = 300_000

/** What each runtime's CLI is published as. Claude is absent on purpose — Flow
 *  drives it through the SDK it ships, so there is nothing to install. */
const PACKAGES: Record<string, string> = {
  codex: '@openai/codex',
  copilot: '@github/copilot',
}

/** The package for `provider`, or null when Flow cannot install this one. */
export function installPackage(provider: string): string | null {
  return PACKAGES[provider] ?? null
}

/** The tail of an installer's output — enough to show the reason, not a wall. */
function lastLines(output: string, count = 3): string {
  const lines = output
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
  return lines.slice(-count).join(' · ')
}

/** True when a spawn failure means "the installer is not on PATH". */
function isMissingCommand(message: string): boolean {
  return /ENOENT|not found|no such file/i.test(message)
}

/** One attempt with one npm. `missing` distinguishes "no npm here" from a
 *  failed install, because only the first one is worth a second try. */
function runInstall(
  pkg: string,
  deps: RuntimeInstallDeps,
  env?: NodeJS.ProcessEnv,
): Promise<RuntimeInstallResult & { missing?: boolean }> {
  const spawnFn = deps.spawnFn ?? spawn
  return new Promise((resolve) => {
    let output = ''
    let child: ReturnType<typeof spawnFn>
    try {
      child = spawnFn('npm', ['install', '-g', pkg], {
        stdio: ['ignore', 'pipe', 'pipe'],
        ...(env === undefined ? {} : { env }),
      })
    } catch (error) {
      const message = (error as Error).message
      resolve({ ok: false, detail: message, ...(isMissingCommand(message) ? { missing: true } : {}) })
      return
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      resolve({ ok: false, detail: 'The install took too long and was stopped.' })
    }, deps.timeoutMs ?? INSTALL_TIMEOUT_MS)
    child.stdout?.on('data', (chunk: Buffer | string) => {
      output += String(chunk)
    })
    child.stderr?.on('data', (chunk: Buffer | string) => {
      output += String(chunk)
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      resolve({
        ok: false,
        detail: error.message,
        ...(isMissingCommand(error.message) ? { missing: true } : {}),
      })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve(
        code === 0
          ? { ok: true, detail: lastLines(output, 1) }
          : { ok: false, detail: lastLines(output) },
      )
    })
  })
}

/**
 * Install `provider`'s CLI. Never throws — a failed install is an answer.
 *
 * Tries the npm this process can see, and only when there is none retries with
 * the user's own PATH (tool-path.ts): a Finder-launched app inherits a PATH
 * with no npm in it, and "Flow could not find npm" is a lie on a machine
 * running npm 11.
 */
export async function installRuntime(
  provider: string,
  deps: RuntimeInstallDeps = {},
): Promise<RuntimeInstallResult> {
  const pkg = installPackage(provider)
  if (pkg === null) {
    return { ok: false, detail: `Flow does not know how to install the ${provider} runtime.` }
  }
  const first = await runInstall(pkg, deps)
  if (first.missing !== true) return { ok: first.ok, detail: first.detail }
  const env = await userPathEnv({
    ...(deps.spawnFn === undefined ? {} : { spawnFn: deps.spawnFn }),
  })
  const second = env === null ? first : await runInstall(pkg, deps, env)
  return second.missing === true
    ? {
        ok: false,
        // The reader's situation, not our spawn error.
        detail: 'Flow could not find npm on this machine, so it cannot install this tool.',
      }
    : { ok: second.ok, detail: second.detail }
}
