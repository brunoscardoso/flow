// Talking to the CLI host (see host.ts) — with the old behaviour as a fallback.
//
// Every bundled-CLI run goes through here. If the host is unavailable for any
// reason (a build without it, a crashed utility process, a platform quirk), the
// caller's own spawn still works: this returns null and the caller spawns
// in-process exactly as before. A performance fix must not become a way for the
// app to lose a feature.

import { join } from 'path'

import { utilityProcess, type UtilityProcess } from 'electron'

import { recordSlow } from '../ipc/slow-handler'

export interface HostRunRequest {
  execPath: string
  args: readonly string[]
  cwd: string
  env?: Record<string, string | undefined>
  captureStdout: boolean
  timeoutMs: number
  /** Kill and report when stdout passes this many bytes (see host.ts). */
  maxStdoutBytes?: number
}

export interface HostRunResult {
  ok: boolean
  stdout: string
  stderr: string
  error?: string
}

let host: UtilityProcess | null = null
let hostPath: string | null = null
let nextId = 0
const pending = new Map<string, (result: HostRunResult) => void>()

/** Point the client at the built host script. Called once, at startup. */
export function configureCliHost(mainDir: string): void {
  hostPath = join(mainDir, 'cli-host.js')
}

/** Test-only: forget the host so the next call starts a fresh one. */
export function resetCliHostForTests(): void {
  host?.kill()
  host = null
  pending.clear()
}

function ensureHost(): UtilityProcess | null {
  if (host !== null) return host
  if (hostPath === null) return null
  try {
    const started = utilityProcess.fork(hostPath, [], { serviceName: 'flow-cli-host' })
    started.on('message', (message: HostRunResult & { id: string }) => {
      const resolve = pending.get(message.id)
      if (resolve === undefined) return
      pending.delete(message.id)
      resolve({ ok: message.ok, stdout: message.stdout, stderr: message.stderr, ...(message.error === undefined ? {} : { error: message.error }) })
    })
    started.on('exit', () => {
      // Everything still waiting fails over to the caller's own spawn.
      for (const [id, resolve] of pending) {
        pending.delete(id)
        resolve({ ok: false, stdout: '', stderr: '', error: 'cli host exited' })
      }
      host = null
    })
    host = started
    console.log(`[cli-host] started from ${hostPath}`)
    return started
  } catch (error) {
    // Worth one line: a host that will not start means every spawn is paid on
    // the main thread again, which is the whole thing this exists to avoid.
    console.warn(`[cli-host] could not start (${(error as Error).message}) — spawning in main`)
    host = null
    return null
  }
}

/**
 * Send every run back to the caller's own spawn, for the length of a test.
 *
 * E2E fixtures intercept `child_process.spawn` IN THE MAIN PROCESS, because
 * that is where these runs used to happen. The host is a DIFFERENT process with
 * its own `spawn`, so a fixture that patches main stops seeing anything the
 * moment a call moves here — and a suite that goes green against a stub it is
 * no longer using is worse than one that fails. Flipping this restores the
 * fallback this file already documents rather than adding a second code path:
 * the caller spawns exactly as it does on a build with no host at all.
 *
 * Read per call, so a fixture can set it after the app has started.
 */
function hostDisabled(): boolean {
  return process.env['FLOW_E2E_NO_CLI_HOST'] === '1'
}

/**
 * Run a command in the host. Returns null when the host is unavailable, which
 * means "spawn it yourself" — never an error the caller has to interpret.
 */
export function runInCliHost(request: HostRunRequest): Promise<HostRunResult> | null {
  if (hostDisabled()) return null
  const process_ = ensureHost()
  if (process_ === null) return null
  const id = `run-${String((nextId += 1))}`
  const startedAt = Date.now()
  return new Promise<HostRunResult>((resolve) => {
    pending.set(id, (result) => {
      // ON THE RECORD. Off the main thread is not the same as free: a run that
      // takes four seconds still holds up whatever asked for it, and a hundred
      // of them is a machine with no capacity left for the person using it.
      // The subcommand is enough to name it — never the whole argv, which
      // carries paths and would turn the log into something unshareable.
      const elapsed = Date.now() - startedAt
      if (elapsed >= SLOW_RUN_MS) {
        recordSlow(`[cli] ${describeRun(request.args)} ran for ${String(elapsed)}ms`)
      }
      resolve(result)
    })
    try {
      process_.postMessage({ ...request, args: [...request.args], id })
    } catch {
      pending.delete(id)
      resolve({ ok: false, stdout: '', stderr: '', error: 'cli host unreachable' })
    }
  })
}

/** A run worth a line — under this it is background noise, not a wait. */
const SLOW_RUN_MS = 1_000

/** `planflow-ai blueprint notes …` → `blueprint notes`. The verb, no paths. */
function describeRun(args: readonly string[]): string {
  const words = args.filter((arg) => !arg.startsWith('-') && !arg.includes('/'))
  return words.slice(0, 3).join(' ') || 'cli'
}
