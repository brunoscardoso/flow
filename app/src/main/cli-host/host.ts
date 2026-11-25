// The CLI host — a utility process whose whole job is spawning child processes.
//
// WHY IT EXISTS, measured rather than assumed: during a live stall on a real
// machine, a sample of Electron's main process found 73% of its CPU inside
// `posix_spawn`. Spawning is not free from a process with a large address
// space, and Flow spawns constantly — the bundled CLI for provisioning, derive,
// rosters, notes and observations, once or more per learn pass, hundreds of
// times in a run. Every one of those was paid on the thread that draws the UI.
//
// So the spawning moved. This process receives {id, execPath, args, cwd, env},
// runs the child, and posts back {id, ok, stdout, stderr}. It holds no state
// and makes no decisions: the caller still owns timeouts, retries and meaning.

import { ChildGroups, killGroup, spawnInGroup } from './child-group'

// Every child this host is running. Each is its own process group, so stopping
// one stops what it started too (see child-group.ts).
const children = new ChildGroups()

// The host never outlives the app, and neither do its children: a sync left
// running after Flow quit held the Workspace's lock and refused every later
// launch (user report 2026-11-24). Stopped on every way out — a signal, a
// normal exit, or the app going away (this process re-parented).
const parentAtStart = process.ppid
function stopEverything(): void {
  children.killAll()
}
process.on('exit', stopEverything)
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) {
  process.on(signal, () => {
    stopEverything()
    process.exit(0)
  })
}
setInterval(() => {
  if (process.ppid !== parentAtStart) {
    stopEverything()
    process.exit(0)
  }
}, 2_000).unref()

interface RunRequest {
  id: string
  execPath: string
  args: string[]
  cwd: string
  env?: Record<string, string | undefined>
  /** Capture stdout, or ignore it (provisioning does not read it). */
  captureStdout: boolean
  timeoutMs: number
  /** Kill the child once stdout passes this many bytes, and say so. Callers
   *  that map a size budget to a user-visible answer (git's oversize diff)
   *  need the overflow REPORTED, not a truncated string that reads as data. */
  maxStdoutBytes?: number
}

interface RunReply {
  id: string
  ok: boolean
  stdout: string
  stderr: string
  error?: string
}

function reply(message: RunReply): void {
  process.parentPort?.postMessage(message)
}

process.parentPort?.on('message', (event: { data: RunRequest }) => {
  const request = event.data
  let stdout = ''
  let stderr = ''
  let child: ReturnType<typeof spawnInGroup>
  try {
    child = spawnInGroup(request.execPath, request.args, {
      cwd: request.cwd,
      stdio: ['ignore', request.captureStdout ? 'pipe' : 'ignore', 'pipe'],
      ...(request.env === undefined ? {} : { env: request.env }),
    })
  } catch (error) {
    reply({ id: request.id, ok: false, stdout: '', stderr: '', error: (error as Error).message })
    return
  }
  children.track(child)
  const timer = setTimeout(() => {
    killGroup(child)
    reply({ id: request.id, ok: false, stdout, stderr, error: 'timed out' })
  }, request.timeoutMs)
  child.stdout?.on('data', (chunk: Buffer | string) => {
    stdout += String(chunk)
    const cap = request.maxStdoutBytes
    if (cap !== undefined && stdout.length > cap) {
      clearTimeout(timer)
      killGroup(child)
      reply({ id: request.id, ok: false, stdout: '', stderr, error: 'maxBuffer length exceeded' })
    }
  })
  child.stderr?.on('data', (chunk: Buffer | string) => {
    // Bounded: a runaway child must not grow this process's memory without end.
    stderr = `${stderr}${String(chunk)}`.slice(-4000)
  })
  child.on('error', (error) => {
    clearTimeout(timer)
    reply({ id: request.id, ok: false, stdout, stderr, error: error.message })
  })
  child.on('close', (code) => {
    clearTimeout(timer)
    reply({ id: request.id, ok: code === 0, stdout, stderr })
  })
})
