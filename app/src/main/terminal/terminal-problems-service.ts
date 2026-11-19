/**
 * Terminal problems — main's reader of every user terminal's output (plain
 * shells, Launchpad steps, one-time actions) for the Problems list.
 *
 * WHY MAIN: the renderer only receives output for the terminals it attached,
 * and a Launchpad step in another conversation or a hidden tab still prints.
 * Main sees every byte once (TerminalManager's data event), so detection here
 * covers terminals nobody is looking at.
 *
 * COST (allowed-patterns #17/#18/#19): a chunk is only appended to its
 * terminal's pending batch; ONE timer per BATCH_MS reads every pending batch
 * line by line (never per character, never synchronously in the data
 * callback). A pending batch is char-bounded, so a flood drops its oldest
 * output instead of growing. A change arms ONE trailing broadcast per
 * BROADCAST_MS carrying the counts only; the list crosses IPC only when
 * asked (`snapshot`, bounded). Agent terminals are not read: they mirror the
 * agent's own commands, whose output the agent already sees.
 *
 * LIFETIME: a terminal's rows live while it is open. Its removal drops them,
 * which is also what clears a Launchpad step on restart — the supervisor
 * retires the step's terminal and starts a new one.
 */
import { basename } from 'path'

import type { TerminalInfo } from '../../shared/ipc-contract'
import {
  DEFAULT_TERMINAL_PROBLEMS_LIMIT,
  type TerminalProblem,
  type TerminalProblemCounts,
  type TerminalProblemGroup,
  type TerminalProblemsSnapshot,
} from '../../shared/terminal-problems'
import { TerminalProblemLog } from './terminal-problem-log'

/** Quiet window that gathers chunks into one batch. */
export const BATCH_MS = 40
/** At most one change broadcast per this window. */
export const BROADCAST_MS = 300
/** A terminal's unread output beyond this drops its oldest part. */
export const MAX_PENDING_CHARS = 512 * 1024

export interface TerminalProblemsTimers {
  set(callback: () => void, ms: number): unknown
  clear(handle: unknown): void
}

const realTimers: TerminalProblemsTimers = {
  set: (callback, ms) => {
    const timer = setTimeout(callback, ms)
    timer.unref?.()
    return timer
  },
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

export interface TerminalProblemsServiceOptions {
  /** Told the new counts after a change (debounced). */
  onChanged: (counts: TerminalProblemCounts) => void
  now?: () => number
  timers?: TerminalProblemsTimers
  /** A project's display name; defaults to its folder name. */
  projectName?: (rootPath: string) => string
}

interface Watched {
  info: TerminalInfo
  log: TerminalProblemLog
  pending: string[]
  pendingChars: number
  /** Output was dropped from the front of the batch: the first line is a fragment. */
  truncated: boolean
}

export class TerminalProblemsService {
  #watched = new Map<string, Watched>()
  #options: TerminalProblemsServiceOptions
  #timers: TerminalProblemsTimers
  #now: () => number
  #batchTimer: unknown = null
  #broadcastTimer: unknown = null
  #dirty = false

  constructor(options: TerminalProblemsServiceOptions) {
    this.#options = options
    this.#timers = options.timers ?? realTimers
    this.#now = options.now ?? Date.now
  }

  /** A terminal opened (or was found at start). Agent terminals are ignored. */
  track(info: TerminalInfo): void {
    if (info.kind !== 'user' || this.#watched.has(info.terminalId)) return
    this.#watched.set(info.terminalId, {
      info: { ...info },
      log: new TerminalProblemLog(info.terminalId, this.#now),
      pending: [],
      pendingChars: 0,
      truncated: false,
    })
  }

  /** The tab was renamed — its rows take the new name. */
  updateInfo(info: TerminalInfo): void {
    const watched = this.#watched.get(info.terminalId)
    if (watched === undefined) return
    watched.info = { ...info }
    if (watched.log.size > 0) this.#markDirty()
  }

  /** Output arrived. Cheap: appended, read later in a batch. */
  data(terminalId: string, data: string): void {
    const watched = this.#watched.get(terminalId)
    if (watched === undefined || data.length === 0) return
    watched.pending.push(data)
    watched.pendingChars += data.length
    while (watched.pendingChars > MAX_PENDING_CHARS && watched.pending.length > 1) {
      watched.pendingChars -= watched.pending.shift()!.length
      watched.truncated = true
    }
    if (this.#batchTimer === null) {
      this.#batchTimer = this.#timers.set(() => {
        this.#batchTimer = null
        this.processPending()
      }, BATCH_MS)
    }
  }

  /** The shell exited: what it printed last, without a newline, still counts. */
  exited(terminalId: string): void {
    const watched = this.#watched.get(terminalId)
    if (watched === undefined) return
    this.#drain(watched)
    if (watched.log.flush()) this.#markDirty()
  }

  /** The terminal closed: its rows go with it. */
  removed(terminalId: string): void {
    const watched = this.#watched.get(terminalId)
    if (watched === undefined) return
    this.#watched.delete(terminalId)
    if (watched.log.size > 0) this.#markDirty()
  }

  /** "Clear terminal problems": every terminal's rows, not the terminals. */
  clear(): void {
    let had = false
    for (const watched of this.#watched.values()) {
      if (watched.log.size > 0) had = true
      watched.log.clear()
    }
    if (had) this.#markDirty()
  }

  /** Read every pending batch now (the batch timer's job; public for tests). */
  processPending(): void {
    let changed = false
    for (const watched of this.#watched.values()) {
      if (this.#drain(watched)) changed = true
    }
    if (changed) this.#markDirty()
  }

  counts(): TerminalProblemCounts {
    const counts = { errors: 0, warnings: 0 }
    for (const watched of this.#watched.values()) {
      const own = watched.log.counts()
      counts.errors += own.errors
      counts.warnings += own.warnings
    }
    return counts
  }

  /**
   * The bounded read: at most `limit` problems (0 = counts only), errors
   * first across every terminal, then warnings — one noisy terminal's
   * warnings never push another's errors out.
   */
  snapshot(limit: number = DEFAULT_TERMINAL_PROBLEMS_LIMIT): TerminalProblemsSnapshot {
    const counts = this.counts()
    const total = counts.errors + counts.warnings
    const room = Math.max(0, Math.floor(limit))
    if (room === 0 || total === 0) return { counts, groups: [], withheld: total }
    const all = [...this.#watched.values()]
      .filter((watched) => watched.log.size > 0)
      .map((watched) => ({ watched, problems: watched.log.problems(), lastSeen: watched.log.lastSeen }))
      .sort((a, b) => b.lastSeen - a.lastSeen)
    const kept = new Map<string, TerminalProblem[]>()
    let sent = 0
    for (const severity of ['error', 'warning'] as const) {
      for (const { watched, problems } of all) {
        for (const problem of problems) {
          if (sent >= room) break
          if (problem.severity !== severity) continue
          const list = kept.get(watched.info.terminalId) ?? []
          list.push(problem)
          kept.set(watched.info.terminalId, list)
          sent += 1
        }
      }
    }
    const groups: TerminalProblemGroup[] = []
    for (const { watched } of all) {
      const problems = kept.get(watched.info.terminalId)
      if (problems === undefined) continue
      problems.sort((a, b) => b.lastSeen - a.lastSeen)
      groups.push({
        terminalId: watched.info.terminalId,
        label: watched.info.title,
        projectName: this.#projectName(watched.info),
        launchpad: watched.info.run !== undefined,
        problems,
      })
    }
    return { counts, groups, withheld: total - sent }
  }

  dispose(): void {
    if (this.#batchTimer !== null) this.#timers.clear(this.#batchTimer)
    if (this.#broadcastTimer !== null) this.#timers.clear(this.#broadcastTimer)
    this.#batchTimer = null
    this.#broadcastTimer = null
    this.#watched.clear()
  }

  #projectName(info: TerminalInfo): string {
    const root = info.run?.projectRoot ?? info.owner?.rootPath ?? info.projectRoot ?? info.cwd
    return this.#options.projectName?.(root) ?? (basename(root) || root)
  }

  #drain(watched: Watched): boolean {
    if (watched.pending.length === 0) return false
    let batch = watched.pending.join('')
    watched.pending = []
    watched.pendingChars = 0
    if (watched.truncated) {
      // The front was dropped mid-line: start at the next whole line.
      watched.truncated = false
      watched.log.dropPartial()
      const newline = batch.indexOf('\n')
      batch = newline < 0 ? '' : batch.slice(newline + 1)
    }
    return watched.log.feed(batch)
  }

  #markDirty(): void {
    this.#dirty = true
    if (this.#broadcastTimer !== null) return
    this.#broadcastTimer = this.#timers.set(() => {
      this.#broadcastTimer = null
      if (!this.#dirty) return
      this.#dirty = false
      this.#options.onChanged(this.counts())
    }, BROADCAST_MS)
  }
}
