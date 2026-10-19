// Warms each project's storyline import index ONCE per app session, in the
// background — so the board's first feature-graph read and the first plan
// review story find it built.
//
// WHY. Both `blueprint features graph` (folder rows) and `blueprint storyline`
// (the review's code story) read the project's import index, and building it
// cold opens every TS/JS file of the project. On a freshly checked-out repo
// each first open is slow: measured on a scratch clone of a 5,100-file repo,
// the graph read took 16–19 s wall for ~1.3 s of CPU (the app's graph timeout
// is 30 s), and the first review story 15–20 s. The CLI no longer blocks the
// graph on it (it answers with partial folder rows and starts the build
// itself), but a project whose board is never opened still pays at its first
// review. This warms every ready project shortly after launch and whenever one
// is added — `blueprint index warm`, concurrent reads, ~3.8 s on that clone.
//
// NEVER ON THE IPC PATH: a detached child, one at a time (two walks of two big
// repos at once would compete for the same disk), each project at most once
// per session — the CLI's own lock makes a warm that races a graph read's warm
// a no-op (`busy`), and a standing index answers `fresh` in ~30 ms.
import { spawn } from 'node:child_process'

import { resolveTypeScriptPath } from './storyline-runner'

/** How long after launch the first warm starts — the launch's own reads go first. */
export const IMPORT_INDEX_WARM_DELAY_MS = 10_000

/** A warm that has not finished by then is killed; the next session tries again. */
export const IMPORT_INDEX_WARM_TIMEOUT_MS = 5 * 60_000

/** While another process holds the build lock, ask again this often… */
export const IMPORT_INDEX_BUSY_RETRY_MS = 2_000

/** …at most this many times (2 minutes) — a build longer than that is left to finish alone. */
const MAX_BUSY_RETRIES = 60

/** Failed warms per project per session — retried once, never looped. */
const MAX_FAILURES = 2

/**
 * Follow-ups per project per session. A partial graph asks for one; a board
 * that somehow kept reading partial after the build would otherwise loop
 * read → warm → announce → read.
 */
const MAX_FOLLOW_UPS = 3

/** What one `blueprint index warm` answered; null when it failed or could not run. */
export type ImportIndexWarmStatus = 'built' | 'fresh' | 'busy' | 'no-cache' | null

export interface ImportIndexWarmerDeps {
  run: (rootPath: string) => Promise<ImportIndexWarmStatus>
  /** The index of a project whose graph read was partial is now built — re-read it. */
  onIndexReady?: (rootPath: string) => void
  delayMs?: number
  busyRetryMs?: number
  setTimer?: (fn: () => void, ms: number) => unknown
}

export interface ImportIndexWarmer {
  /** Launch / placement: queue every root not warmed yet this session (starts after the launch delay). */
  request(rootPaths: readonly string[]): void
  /** A graph read came back `partial`: warm it now, then `onIndexReady`. */
  followUp(rootPath: string): void
  /** Resolves when the queue is empty (tests). */
  idle(): Promise<void>
}

export function createImportIndexWarmer(deps: ImportIndexWarmerDeps): ImportIndexWarmer {
  const delayMs = deps.delayMs ?? IMPORT_INDEX_WARM_DELAY_MS
  const busyRetryMs = deps.busyRetryMs ?? IMPORT_INDEX_BUSY_RETRY_MS
  const setTimer = deps.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms).unref())
  const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimer(resolve, ms))
  const done = new Set<string>()
  const failures = new Map<string, number>()
  const followUps = new Map<string, number>()
  /** Roots waiting, each with whether a partial read is waiting on it. */
  const queue = new Map<string, { announce: boolean }>()
  let draining: Promise<void> | null = null
  let started = false
  let ready = false
  let idleWaiters: Array<() => void> = []

  const warmOne = async (rootPath: string): Promise<ImportIndexWarmStatus> => {
    let status: ImportIndexWarmStatus = null
    for (let attempt = 0; attempt <= MAX_BUSY_RETRIES; attempt += 1) {
      try {
        status = await deps.run(rootPath)
      } catch (error) {
        console.warn('[ImportIndexWarm] warm failed', rootPath, error)
        status = null
      }
      if (status !== 'busy') return status
      await sleep(busyRetryMs)
    }
    return status
  }

  const drain = async (): Promise<void> => {
    while (queue.size > 0) {
      const [rootPath, entry] = queue.entries().next().value as [string, { announce: boolean }]
      queue.delete(rootPath)
      const status = await warmOne(rootPath)
      if (status === null) {
        failures.set(rootPath, (failures.get(rootPath) ?? 0) + 1)
        continue
      }
      if (status === 'busy') continue
      done.add(rootPath)
      // `fresh` after a partial read still means the index changed since that
      // read (another process built it meanwhile) — announce either way.
      if (entry.announce && status !== 'no-cache') deps.onIndexReady?.(rootPath)
    }
    draining = null
    const waiters = idleWaiters
    idleWaiters = []
    for (const resolve of waiters) resolve()
  }

  const kick = (): void => {
    if (!ready || draining !== null || queue.size === 0) return
    draining = drain()
  }

  const startClock = (): void => {
    if (started) return
    started = true
    setTimer(() => {
      ready = true
      kick()
    }, delayMs)
  }

  return {
    request(rootPaths) {
      for (const rootPath of rootPaths) {
        if (done.has(rootPath) || queue.has(rootPath)) continue
        if ((failures.get(rootPath) ?? 0) >= MAX_FAILURES) continue
        queue.set(rootPath, { announce: false })
      }
      startClock()
      kick()
    },
    followUp(rootPath) {
      const asked = followUps.get(rootPath) ?? 0
      if (asked >= MAX_FOLLOW_UPS || (failures.get(rootPath) ?? 0) >= MAX_FAILURES) return
      const queued = queue.get(rootPath)
      if (queued !== undefined) {
        queued.announce = true
      } else {
        // A root warmed earlier this session may have changed since (a branch
        // switch): the partial read is the evidence, so it warms again.
        done.delete(rootPath)
        queue.set(rootPath, { announce: true })
      }
      followUps.set(rootPath, asked + 1)
      // Someone is looking at this board: no launch delay.
      started = true
      ready = true
      kick()
    },
    idle() {
      if (draining === null && (queue.size === 0 || !ready)) return Promise.resolve()
      return new Promise((resolve) => idleWaiters.push(resolve))
    },
  }
}

/**
 * `blueprint index warm` through the bundled CLI, as a child the app waits on
 * (not detached: quitting the app ends it, and the CLI's lock is released by
 * its staleness rule if it is killed). Never throws.
 */
export function runImportIndexWarm(
  bundledCli: { execPath: string; cliPath: string } | null,
  rootPath: string,
  deps: { spawnFn?: typeof spawn; timeoutMs?: number; typescriptPath?: string | null } = {},
): Promise<ImportIndexWarmStatus> {
  if (bundledCli === null) return Promise.resolve(null)
  // The SAME compiler the story verb is handed (storyline-runner.ts): an index
  // warmed without one would record every TS file unread, for the story to read.
  const typescriptPath = deps.typescriptPath === undefined ? resolveTypeScriptPath() : deps.typescriptPath
  const spawnFn = deps.spawnFn ?? spawn
  const timeoutMs = deps.timeoutMs ?? IMPORT_INDEX_WARM_TIMEOUT_MS
  return new Promise<ImportIndexWarmStatus>((resolve) => {
    let stdout = ''
    let child: ReturnType<typeof spawnFn>
    try {
      child = spawnFn(bundledCli.execPath, [bundledCli.cliPath, 'blueprint', 'index', 'warm', '--json'], {
        cwd: rootPath,
        stdio: ['ignore', 'pipe', 'ignore'],
        // Libuv's default 4 file threads cap the concurrent cold opens the warm relies on.
        env: {
          ...process.env,
          ELECTRON_RUN_AS_NODE: '1',
          UV_THREADPOOL_SIZE: process.env['UV_THREADPOOL_SIZE'] ?? '16',
          ...(typescriptPath ? { FLOW_TYPESCRIPT_PATH: typescriptPath } : {}),
        },
      })
    } catch (error) {
      console.warn('[ImportIndexWarm] could not start the warm', rootPath, error)
      resolve(null)
      return
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      resolve(null)
    }, timeoutMs)
    child.stdout?.on('data', (chunk: Buffer | string) => {
      stdout += chunk.toString()
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      console.warn('[ImportIndexWarm] warm process failed', rootPath, error)
      resolve(null)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve(code === 0 ? parseWarmStatus(stdout) : null)
    })
  })
}

/** The status of `blueprint index warm --json`'s last JSON line, or null. */
export function parseWarmStatus(stdout: string): ImportIndexWarmStatus {
  const lines = stdout.trim().split('\n').reverse()
  for (const line of lines) {
    if (!line.trim().startsWith('{')) continue
    try {
      const status = (JSON.parse(line) as { status?: unknown }).status
      return status === 'built' || status === 'fresh' || status === 'busy' || status === 'no-cache' ? status : null
    } catch {
      // Not the result line — keep scanning upward.
      continue
    }
  }
  return null
}
