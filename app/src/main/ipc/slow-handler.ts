// One timer around every IPC handler, in one place — and a durable record.
//
// The preload logs slow ROUND TRIPS, and that number cannot tell a slow handler
// from a fast one queued behind something else. Chasing "the app is slow"
// produced `blueprint:read took 2135ms` for a read of files that do not exist;
// only a main-side timer said whether that was work or waiting (it was work:
// a vault scan of 4,764 directories).
//
// WRITTEN TO A FILE, because console.log in a packaged app goes nowhere its
// user can read. A report of "it is slow again" is answerable in seconds when
// the evidence is already on disk, and unanswerable when it is not.

import { appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'fs'
import { join } from 'path'

/** A handler slower than this is worth a line. */
export const SLOW_HANDLER_MS = 250

/** Keep the file small enough to read; older lines are dropped, not rotated. */
const MAX_LOG_BYTES = 256 * 1024

let logPath: string | null = null

/** Point the log at this session's userData. Called once at startup. */
export function setSlowLogDirectory(userDataPath: string): void {
  try {
    const dir = join(userDataPath, 'logs')
    mkdirSync(dir, { recursive: true })
    logPath = join(dir, 'slow.log')
  } catch {
    logPath = null // a log that cannot be written must never break the app
  }
}

/** Append one line, with the file's own size as the only bookkeeping. */
export function recordSlow(line: string): void {
  const path = logPath
  if (path === null) return
  try {
    const size = statSync(path).size
    if (size > MAX_LOG_BYTES) writeFileSync(path, '')
  } catch {
    // No file yet — appendFileSync creates it.
  }
  try {
    appendFileSync(path, `${new Date().toISOString()} ${line}\n`)
  } catch {
    // Out of space, read-only volume: not worth a single user-visible byte.
  }
}

/** Where the log lives — for the menu action that reveals it. Null until the
 *  app has a userData path, or if the directory could not be made. */
export function slowLogPath(): string | null {
  return logPath
}

/**
 * The tail of the log, as text — what a person hands over when they say "it is
 * slow". Newest last, so the end of the report is the most recent complaint.
 *
 * Empty string when there is no log yet, which is itself an answer: nothing has
 * been slow enough to record since this file was last cleared.
 */
export function readSlowLog(maxBytes = MAX_LOG_BYTES): string {
  const path = logPath
  if (path === null) return ''
  try {
    const text = readFileSync(path, 'utf8')
    return text.length > maxBytes ? text.slice(text.length - maxBytes) : text
  } catch {
    return ''
  }
}

/** Channels whose handler has not returned yet — named when a stall is seen. */
const inFlight = new Map<string, number>()

/** What was running when the loop stalled, longest-waiting first. */
function inFlightSummary(): string {
  if (inFlight.size === 0) return 'nothing in flight'
  const now = Date.now()
  return [...inFlight.entries()]
    .map(([channel, started]) => ({ channel, waited: now - started }))
    .sort((a, b) => b.waited - a.waited)
    .slice(0, 4)
    .map((entry) => `${entry.channel} ${String(entry.waited)}ms`)
    .join(', ')
}

/** Wrap a handler so anything slow says so, with the channel that spent it. */
export function timed<Request, Response>(
  channel: string,
  handler: (request: Request) => Response | Promise<Response>,
): (request: Request) => Promise<Response> {
  return async (request: Request): Promise<Response> => {
    const started = Date.now()
    const token = `${channel}#${String(started)}#${String(Math.round(performance.now()))}`
    inFlight.set(token, started)
    try {
      return await handler(request)
    } finally {
      inFlight.delete(token)
      const elapsed = Date.now() - started
      if (elapsed >= SLOW_HANDLER_MS) {
        const line = `[ipc] ${channel} handled in ${String(elapsed)}ms`
        console.warn(line)
        recordSlow(line)
      }
    }
  }
}

/**
 * Watch the main process's event loop for stalls.
 *
 * THE HANDLERS WERE ALL FAST AND THE APP WAS STILL BUSY — which is the shape of
 * work that never crosses IPC at all: a watcher's initial scan, a synchronous
 * read, a garbage collection, a CLI spawned by something that is not answering
 * a request. A timer that measures its own lateness catches all of it, costs one
 * wakeup a second, and names nothing it cannot prove.
 */
export function watchEventLoopLag(
  intervalMs = 1_000,
  thresholdMs = SLOW_HANDLER_MS,
): () => void {
  let last = Date.now()
  let lastCpu = process.cpuUsage()
  const timer = setInterval(() => {
    const now = Date.now()
    const cpu = process.cpuUsage(lastCpu)
    lastCpu = process.cpuUsage()
    const lag = now - last - intervalMs
    last = now
    if (lag >= thresholdMs) {
      // WAS IT WORKING OR WAITING? A loop 12 seconds late having spent 0.2 s of
      // CPU was blocked on something (a synchronous read, a starved scheduler);
      // one that spent 12 s was computing. The two have nothing in common
      // except the symptom, and guessing between them has cost this
      // investigation three rounds.
      const cpuMs = Math.round((cpu.user + cpu.system) / 1000)
      const heapMb = Math.round(process.memoryUsage().heapUsed / 1024 / 1024)
      const line = `[main] blocked for ${String(lag)}ms (cpu ${String(cpuMs)}ms, heap ${String(heapMb)}MB, ${inFlightSummary()})`
      console.warn(line)
      recordSlow(line)
    }
  }, intervalMs)
  timer.unref?.()
  return () => clearInterval(timer)
}
