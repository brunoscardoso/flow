/**
 * DOCKER RUNNER — the one way main asks Docker anything.
 *
 *   - ASYNC, ALWAYS (allowed-pattern #19). Every call is a spawned child with a
 *     timeout; nothing here blocks the process every window waits on.
 *   - ARGV ONLY, never a shell: `run(['volume', 'ls', …])`. A value never meets
 *     a shell's quoting rules.
 *   - BOUNDED. Output is capped per stream, so a chatty `docker system df -v`
 *     cannot grow without limit; a call that outlives its timeout is killed and
 *     reported as `timedOut`.
 *   - INJECTED. Everything that touches Docker takes a `DockerRunner`, and the
 *     tests hand in a fake — they never reach the real daemon.
 *
 * Availability answers in the reader's terms (forbidden-pattern #12): the
 * `detail` sentences name no command, path or setting.
 */
import { spawn as nodeSpawn } from 'node:child_process'
import { homedir } from 'node:os'
import { delimiter } from 'node:path'

export interface DockerRunOptions {
  cwd?: string
  timeoutMs?: number
  /** Added to the app's environment for this call. */
  env?: Record<string, string>
}

export interface DockerRunResult {
  /** Exit code 0, not timed out. */
  ok: boolean
  code: number | null
  stdout: string
  stderr: string
  timedOut: boolean
  /** True when the Docker program itself could not be found. */
  notFound?: boolean
}

export interface DockerRunner {
  run(args: string[], opts?: DockerRunOptions): Promise<DockerRunResult>
}

/** A call that names no timeout gets this one. */
export const DOCKER_DEFAULT_TIMEOUT_MS = 30_000
/** Asking whether Docker answers at all. */
export const DOCKER_PROBE_TIMEOUT_MS = 10_000
/** Each stream keeps at most this many characters; the rest is dropped. */
export const DOCKER_OUTPUT_CAP = 2 * 1024 * 1024
/** After a timeout, how long a polite stop gets before a forced one. */
const KILL_GRACE_MS = 2_000

// ─── the real runner ─────────────────────────────────────────────────────────

/** The slice of a spawned child this module uses. */
export interface DockerChild {
  stdout: { on(event: 'data', listener: (chunk: Buffer | string) => void): unknown } | null
  stderr: { on(event: 'data', listener: (chunk: Buffer | string) => void): unknown } | null
  on(event: 'error', listener: (error: NodeJS.ErrnoException) => void): unknown
  on(event: 'close', listener: (code: number | null) => void): unknown
  kill(signal?: NodeJS.Signals): boolean
}

export type DockerSpawn = (
  command: string,
  args: string[],
  options: { cwd?: string; env: NodeJS.ProcessEnv; stdio: ['ignore', 'pipe', 'pipe'] },
) => DockerChild

export interface DockerRunnerOptions {
  /** Node's spawn by default. */
  spawn?: DockerSpawn
  /** The program — `docker` by default, found on the PATH below. */
  command?: string
  /** The environment calls start from — `process.env` by default. */
  baseEnv?: NodeJS.ProcessEnv
  /**
   * Folders added to the end of PATH. An app opened from the Dock gets a short
   * PATH that rarely holds Docker, so the usual install places are added.
   */
  extraPath?: string[]
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
}

/** Where Docker Desktop, Homebrew and the usual installers put the program. */
export function defaultDockerPath(home: string = homedir()): string[] {
  return [
    '/usr/local/bin',
    '/opt/homebrew/bin',
    `${home}/.docker/bin`,
    '/Applications/Docker.app/Contents/Resources/bin',
  ]
}

function withPath(base: NodeJS.ProcessEnv, extra: string[]): NodeJS.ProcessEnv {
  const current = (base['PATH'] ?? '').split(delimiter).filter((part) => part !== '')
  const added = extra.filter((part) => !current.includes(part))
  return { ...base, PATH: [...current, ...added].join(delimiter) }
}

function capped(text: string, chunk: string): string {
  if (text.length >= DOCKER_OUTPUT_CAP) return text
  const room = DOCKER_OUTPUT_CAP - text.length
  return text + (chunk.length > room ? chunk.slice(0, room) : chunk)
}

export function createDockerRunner(options: DockerRunnerOptions = {}): DockerRunner {
  const spawn: DockerSpawn = options.spawn ?? (nodeSpawn as unknown as DockerSpawn)
  const command = options.command ?? 'docker'
  const extraPath = options.extraPath ?? defaultDockerPath()
  const setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
  const clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as NodeJS.Timeout))

  return {
    run: (args, opts = {}) =>
      new Promise<DockerRunResult>((resolve) => {
        const env = withPath({ ...(options.baseEnv ?? process.env), ...(opts.env ?? {}) }, extraPath)
        let stdout = ''
        let stderr = ''
        let timedOut = false
        let settled = false
        let killTimer: unknown = null
        const finish = (result: DockerRunResult): void => {
          if (settled) return
          settled = true
          clearTimer(timer)
          if (killTimer !== null) clearTimer(killTimer)
          resolve(result)
        }

        let child: DockerChild
        try {
          child = spawn(command, args, { ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}), env, stdio: ['ignore', 'pipe', 'pipe'] })
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code
          resolve({ ok: false, code: null, stdout: '', stderr: String((error as Error).message), timedOut: false, notFound: code === 'ENOENT' })
          return
        }

        const timer = setTimer(() => {
          timedOut = true
          child.kill('SIGTERM')
          killTimer = setTimer(() => child.kill('SIGKILL'), KILL_GRACE_MS)
        }, opts.timeoutMs ?? DOCKER_DEFAULT_TIMEOUT_MS)

        child.stdout?.on('data', (chunk) => {
          stdout = capped(stdout, String(chunk))
        })
        child.stderr?.on('data', (chunk) => {
          stderr = capped(stderr, String(chunk))
        })
        child.on('error', (error) => {
          finish({ ok: false, code: null, stdout, stderr: stderr || error.message, timedOut, notFound: error.code === 'ENOENT' })
        })
        child.on('close', (code) => {
          finish({ ok: code === 0 && !timedOut, code, stdout, stderr, timedOut })
        })
      }),
  }
}

// ─── availability ────────────────────────────────────────────────────────────

export type DockerUnavailableReason = 'not-installed' | 'not-running' | 'compose-missing'

export type DockerAvailability =
  | { available: true }
  | { available: false; reason: DockerUnavailableReason; detail: string }

export const DOCKER_UNAVAILABLE: Record<DockerUnavailableReason, string> = {
  'not-installed': "Docker isn't installed on this computer, so this conversation's services can't start.",
  'not-running': "Docker isn't running, so this conversation's services can't start. Open Docker and press Run again.",
  'compose-missing': "This copy of Docker can't start a project's services together, so this conversation's services can't start. Updating Docker fixes it.",
}

/**
 * Whether Docker can run a thread's services: the program is there, its
 * engine answers, and it has Compose. Never throws.
 */
export async function dockerAvailability(runner: DockerRunner): Promise<DockerAvailability> {
  const unavailable = (reason: DockerUnavailableReason): DockerAvailability => ({
    available: false,
    reason,
    detail: DOCKER_UNAVAILABLE[reason],
  })
  let engine: DockerRunResult
  try {
    engine = await runner.run(['version', '--format', '{{.Server.Version}}'], { timeoutMs: DOCKER_PROBE_TIMEOUT_MS })
  } catch {
    return unavailable('not-running')
  }
  if (engine.notFound === true) return unavailable('not-installed')
  // A client that runs but an engine that does not answer — or answers nothing.
  if (!engine.ok || engine.stdout.trim() === '') return unavailable('not-running')

  let compose: DockerRunResult
  try {
    compose = await runner.run(['compose', 'version', '--short'], { timeoutMs: DOCKER_PROBE_TIMEOUT_MS })
  } catch {
    return unavailable('compose-missing')
  }
  if (!compose.ok || compose.stdout.trim() === '') return unavailable('compose-missing')
  return { available: true }
}

/** Where Docker Desktop lives on a Mac. */
export const DOCKER_DESKTOP_APP = '/Applications/Docker.app'

export interface OpenDockerResult {
  ok: boolean
  /** A sentence for the person when it did not open; empty when it did. */
  detail: string
}

/**
 * Open Docker Desktop. The opener is injected — electron's `shell.openPath`
 * in the app (it answers '' on success, else an error message) — so this file
 * never imports electron and the tests open nothing.
 */
export async function openDockerDesktop(
  opener: (path: string) => Promise<string>,
  platform: NodeJS.Platform = process.platform,
): Promise<OpenDockerResult> {
  if (platform !== 'darwin') {
    return { ok: false, detail: 'Start Docker on this computer, then press Run again.' }
  }
  let error: string
  try {
    error = await opener(DOCKER_DESKTOP_APP)
  } catch {
    error = 'failed'
  }
  if (error === '') return { ok: true, detail: '' }
  return { ok: false, detail: "Flow couldn't open Docker. Start it yourself, then press Run again." }
}
