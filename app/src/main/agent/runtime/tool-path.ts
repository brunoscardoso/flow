// The PATH the user has, for an app that was launched by clicking an icon.
//
// A GUI-launched macOS app inherits `/usr/bin:/bin:/usr/sbin:/sbin` — NOT the
// PATH its user's terminal has. Measured here with exactly that PATH:
//
//   spawn codex   → ENOENT in 1 ms      (installed, /opt/homebrew/bin)
//   spawn copilot → ENOENT in 1 ms      (installed, 1.0.80)
//   spawn npm     → ENOENT in 1 ms      (installed, 11.17.0)
//
// Every one becomes a confident, wrong sentence — "Copilot is not installed on
// this machine" — reported from a real desktop where it was installed and
// working. Fast, and wrong.
//
// TWO measured details decide the shape of the fix:
//
//   1. `zsh -lc` IS NOT ENOUGH. A plain login shell under the GUI PATH still
//      cannot see /opt/homebrew/bin, because Homebrew's shellenv is set in
//      ~/.zshrc — which only an INTERACTIVE shell reads. `-ilc` finds it, in
//      about a second.
//   2. AN ABSOLUTE PATH IS NOT ENOUGH EITHER. Spawning the copilot we found by
//      its full path then died with "env: node: No such file or directory" —
//      its shebang needs `node`, which is not on the GUI PATH. The child needs
//      the user's whole PATH, not a pointer to one file in it.
//
// So: ask the shell for $PATH once per session, and hand it to the children.

import { spawn } from 'child_process'

/** An interactive shell loading a full rc is ~1s here, and must not hang. */
const LOOKUP_TIMEOUT_MS = 5_000

export interface ShellPathDeps {
  spawnFn?: typeof spawn
  platform?: NodeJS.Platform | string
  timeoutMs?: number
}

/** Session cache — the answer only, never a failure (see resolveUserPath). */
let cachedPath: string | null = null

/** Test-only: forget what the session resolved. */
export function forgetUserPath(): void {
  cachedPath = null
}

/**
 * Ask the user's interactive login shell for its PATH. Null when it cannot say.
 *
 * POSIX by construction — on Windows there is no shell to ask, and the PATH the
 * app already has is the only answer available.
 */
export function loginShellPath(deps: ShellPathDeps = {}): Promise<string | null> {
  const platform = deps.platform ?? process.platform
  if (platform === 'win32') return Promise.resolve(null)
  const spawnFn = deps.spawnFn ?? spawn
  return new Promise((resolve) => {
    let stdout = ''
    let settled = false
    const settle = (value: string | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }
    let child: ReturnType<typeof spawnFn>
    try {
      // The marker is what makes this readable: an interactive shell may greet,
      // warn about an update, or print a banner, and the PATH has to be picked
      // out of that rather than assumed to be the first or last line.
      child = spawnFn(
        process.env['SHELL'] || '/bin/zsh',
        ['-ilc', 'printf "FLOW_PATH=%s\\n" "$PATH"'],
        { stdio: ['ignore', 'pipe', 'ignore'] },
      )
    } catch {
      resolve(null)
      return
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      settle(null)
    }, deps.timeoutMs ?? LOOKUP_TIMEOUT_MS)
    child.stdout?.on('data', (chunk: Buffer | string) => {
      stdout += String(chunk)
    })
    child.on('error', () => settle(null))
    child.on('close', () => {
      const line = stdout
        .split('\n')
        .map((entry) => entry.trim())
        .filter((entry) => entry.startsWith('FLOW_PATH='))
        .pop()
      const value = line === undefined ? '' : line.slice('FLOW_PATH='.length)
      settle(value.includes('/') ? value : null)
    })
  })
}

/**
 * The user's PATH, resolved once per session. Null when the shell could not
 * say — the caller then keeps whatever PATH it already had, and a genuine
 * "not installed" stays a genuine "not installed".
 *
 * Only successes are cached: a failed lookup is cheap to repeat and the answer
 * can change (a shell profile is edited, a tool is installed).
 */
export async function resolveUserPath(deps: ShellPathDeps = {}): Promise<string | null> {
  if (cachedPath !== null) return cachedPath
  const found = await loginShellPath(deps)
  if (found !== null) cachedPath = found
  return found
}

/**
 * The resolved PATH, if the session has already asked. Synchronous, for the
 * places that cannot await — a runtime's `spawn` happens inside `start()`.
 * Null until the first resolution lands, which is what `warmUserPath` is for.
 */
export function cachedUserPathEnv(): NodeJS.ProcessEnv | null {
  if (cachedPath === null || cachedPath === process.env['PATH']) return null
  return { ...process.env, PATH: cachedPath }
}

/**
 * Start resolving the user's PATH now, so the first agent turn does not pay
 * for it — a GUI-launched app cannot see /opt/homebrew/bin, and a turn that
 * cannot spawn its runtime is a message that vanishes.
 */
export function warmUserPath(deps: ShellPathDeps = {}): void {
  void resolveUserPath(deps)
}

/**
 * An env for spawning a user's tool: this process's env with the user's PATH.
 * Returns null when nothing better than the current PATH could be found, so
 * callers can skip a pointless second attempt.
 */
export async function userPathEnv(
  deps: ShellPathDeps = {},
): Promise<NodeJS.ProcessEnv | null> {
  const path = await resolveUserPath(deps)
  if (path === null || path === process.env['PATH']) return null
  return { ...process.env, PATH: path }
}
