/**
 * The renderer's own account of why it felt slow.
 *
 * Main already writes a slow-handler line and an event-loop-lag line, and both
 * were coming back clean while the app was described as unusable — because the
 * thing being described happens HERE: a main thread too busy to paint, an event
 * queued behind it, a startup that mounts before it can answer a keystroke.
 * None of that crosses IPC, so none of it was in the record.
 *
 * Everything observed here goes into the SAME file main writes, batched, with
 * what was in flight at the time. Cost when nothing is slow: two idle
 * PerformanceObservers and no timers.
 */
import type { FlowApi } from '../../shared/ipc-contract'

/**
 * The browser shapes this module reads, declared locally.
 *
 * Not for lack of lib.dom — for testability: the unit runner builds without it,
 * and an instrument that has never been seen produce a line is a hope rather
 * than a measurement. Reaching the constructor off `globalThis` also means the
 * test can hand it a stub without patching a module.
 */
interface ObservedEntry {
  name: string
  duration: number
  startTime?: number
  /** Event timing: when the handler began / ended (absent for long tasks). */
  processingStart?: number
  processingEnd?: number
  target?: { tagName?: string; className?: unknown; getAttribute?: (n: string) => string | null } | null
}

interface ObserverLike {
  observe(init: Record<string, unknown>): void
  disconnect(): void
}

type ObserverCtor = new (
  callback: (list: { getEntries(): ObservedEntry[] }) => void,
) => ObserverLike

import {
  LONG_TASK_MS,
  SLOW_INTERACTION_MS,
  collapseRepeats,
  describeTarget,
  formatInteraction,
  formatLongTask,
  formatStartup,
} from './perf-lines'

/** Lines are handed over a second at a time — the instrument must not add a
 *  round trip to the moments that are already struggling. */
const FLUSH_MS = 1_000

/** A burst bigger than this is a stall, not a list of events; the tail is kept
 *  because it is nearest whatever ended it. */
const MAX_BUFFER = 200

interface PerfLogHandle {
  /** Record a line from anywhere in the renderer (startup marks, surfaces). */
  note(line: string): void
  stop(): void
}

/**
 * Start watching. Safe to call in any environment: where PerformanceObserver or
 * the diagnostics channel is missing, this degrades to a no-op rather than
 * throwing inside the app it exists to measure.
 */
export function startPerformanceLog(api: Pick<FlowApi, 'diagnostics'>): PerfLogHandle {
  const buffer: string[] = []
  let timer: ReturnType<typeof setTimeout> | null = null
  const observers: ObserverLike[] = []

  const inFlight = (): string[] => {
    try {
      return api.diagnostics?.inFlight() ?? []
    } catch {
      return []
    }
  }

  const flush = (): void => {
    timer = null
    const lines = collapseRepeats(buffer.splice(0, buffer.length))
    if (lines.length === 0) return
    void api.diagnostics?.record({ lines }).catch(() => {
      // Never surface: a log that cannot be written is not the user's problem.
    })
  }

  const note = (line: string): void => {
    buffer.push(line)
    if (buffer.length > MAX_BUFFER) buffer.splice(0, buffer.length - MAX_BUFFER)
    if (timer === null) timer = setTimeout(flush, FLUSH_MS)
  }

  // `durationThreshold` is real (event timing, Chromium): the browser filters
  // before it calls back, so a fast press costs nothing. Filtering in the
  // callback would mean observing EVERY event on the thread this protects.
  const observe = (
    init: Record<string, unknown>,
    handle: (entry: ObservedEntry) => void,
  ): void => {
    const Ctor = (globalThis as { PerformanceObserver?: ObserverCtor }).PerformanceObserver
    if (Ctor === undefined) return
    try {
      const observer = new Ctor((list) => {
        for (const entry of list.getEntries()) handle(entry)
      })
      observer.observe(init)
      observers.push(observer)
    } catch {
      // An entry type this Chromium does not support is not worth a failure —
      // the other observers still report.
    }
  }

  // A frame the app could not paint.
  observe({ entryTypes: ['longtask'] }, (entry) => {
    if (entry.duration < LONG_TASK_MS) return
    note(formatLongTask(entry.duration, inFlight()))
  })

  // A press that did not feel instant — the reported symptom, measured where it
  // is felt: from the input event to the end of its handler.
  observe({ type: 'event', durationThreshold: SLOW_INTERACTION_MS, buffered: true }, (entry) => {
    if (entry.duration < SLOW_INTERACTION_MS) return
    const startTime = entry.startTime ?? 0
    const processingStart = entry.processingStart ?? startTime
    const processingEnd = entry.processingEnd ?? processingStart
    note(
      formatInteraction({
        name: entry.name,
        total: entry.duration,
        delay: processingStart - startTime,
        handler: processingEnd - processingStart,
        target: describeTarget(entry.target ?? null),
        inFlight: inFlight(),
      }),
    )
  })

  return {
    note,
    stop: () => {
      for (const observer of observers) observer.disconnect()
      observers.length = 0
      if (timer !== null) clearTimeout(timer)
      flush()
    },
  }
}

/**
 * Record how long the window took to become usable.
 *
 * "I click on the input when the app opens and the cursor spins" is a startup
 * report, and startup was the one stretch with no measurement at all: the shell
 * mounts, then a dozen surfaces initialise, and any of them can hold the thread
 * through the first click. Three marks say which stretch owned it.
 */
export function recordStartup(log: PerfLogHandle, scriptStart: number, shellMounted: number): void {
  // The first frame AFTER mount — the first moment anything the person can see
  // is on screen, which is what they are timing when they say "when it opens".
  const raf =
    (globalThis as { requestAnimationFrame?: (cb: () => void) => void }).requestAnimationFrame ??
    ((cb: () => void) => setTimeout(cb, 0))
  raf(() => {
    const painted = performance.now()
    log.note(
      formatStartup({
        scriptMs: scriptStart,
        shellMs: shellMounted - scriptStart,
        firstPaintMs: painted,
      }),
    )
  })
}
