/**
 * BASIC DISCOVERY, FOR EVERY WORKSPACE PROJECT — the one place that decides
 * whether a project "has its basic discovery", runs the sweep when it does
 * not, and lets a held message wait for it (decision 2026-10-06: "we should
 * start a thread only for projects that have the basic discovery").
 *
 * WHAT "HAS BASIC DISCOVERY" MEANS — ONE RULE (`hasBasicDiscovery`):
 *
 *   1. A completed sweep was RECORDED: a line in
 *      `flow/brain/.structure/basic-discovery.jsonl`, appended when a sweep
 *      ended `done` (at least one module learned, or nothing there to learn).
 *      It lives in the project's own knowledge folder — the Workspace's project
 *      folder — so it travels with the project when it moves between
 *      Workspaces, and as an append-only `.structure/*.jsonl` it syncs to
 *      teammates with the module docs and notes it vouches for: a project a
 *      teammate already discovered is not discovered again here.
 *   2. Or, for projects learned before the record existed: the learning state
 *      holds at least one `learned` module. (Queued, learning and stale do not
 *      count — those are intentions and drift, not knowledge.)
 *
 * A sweep in flight is `queued`/`running`, never done; one that failed (every
 * module failed, the run paused itself, it was stopped) is `failed` and waits
 * for a person's Try again — it is never retried on its own, because each
 * attempt is real agent runs.
 *
 * WHO IS SWEPT AUTOMATICALLY: every registered project that is in a Workspace
 * (which, since the hard migration, is every project) — re-checked on launch,
 * after every Workspace change (a launch migration, an add, Move it in, a
 * join, a move) and when a project finishes provisioning. A project outside
 * every Workspace keeps the old consent ask and is never held.
 *
 * BOUNDED. Sweeps run `maxConcurrent` at a time (default ONE): ten projects
 * joining at once queue ten sweeps, not ten sessions — and the learn
 * orchestrator below this is itself one pass at a time. A person waiting on a
 * project (a held first message) moves it to the front.
 *
 * Nothing here is synchronous on disk or a child process (allowed-pattern #19):
 * every read is async and every sweep is the orchestrator's own queue.
 */

import { promises as fsPromises } from 'node:fs'
import { basename, join } from 'node:path'

import type { BlueprintLearningEntry } from '../../shared/ipc-contract'
import type { BasicDiscoveryStatus } from '../../shared/basic-discovery'
import type { BasicDiscoveryRunOutcome } from '../project/learn-orchestrator'
import { LEARNING_STATE_FILE, parseLearningStateContent } from '../project/learning-state'

export type { BasicDiscoveryStatus } from '../../shared/basic-discovery'

/** The completion record, beside the learning state in `flow/brain/.structure/`. */
export const BASIC_DISCOVERY_FILE = 'basic-discovery.jsonl'

/** One completed sweep. */
export interface BasicDiscoveryRecord {
  completedAt: string
  learned: number
  failed: number
}

/** What the rule reads. */
export interface BasicDiscoveryEvidence {
  records: readonly BasicDiscoveryRecord[]
  learning: readonly BlueprintLearningEntry[] | undefined
}

/** THE rule — see the header. Pure. */
export function hasBasicDiscovery(evidence: BasicDiscoveryEvidence): boolean {
  if (evidence.records.length > 0) return true
  return (evidence.learning ?? []).some((entry) => entry.status === 'learned')
}

/** Parse the record file; corrupt lines are skipped (fail-soft, like every `.structure` store). */
export function parseBasicDiscoveryRecords(raw: string | null): BasicDiscoveryRecord[] {
  if (raw === null) return []
  const records: BasicDiscoveryRecord[] = []
  for (const line of raw.split('\n')) {
    const text = line.trim()
    if (text === '') continue
    try {
      const value = JSON.parse(text) as Record<string, unknown>
      if (typeof value['completedAt'] !== 'string') continue
      const count = (key: string): number => {
        const n = value[key]
        return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : 0
      }
      records.push({ completedAt: value['completedAt'], learned: count('learned'), failed: count('failed') })
    } catch {
      // A corrupt line is not a record.
    }
  }
  return records
}

async function readOrNull(path: string): Promise<string | null> {
  try {
    return await fsPromises.readFile(path, 'utf-8')
  } catch {
    return null
  }
}

/** Read both halves of the evidence from a project's structure folder. Never throws. */
export async function readBasicDiscoveryEvidence(structureDir: string): Promise<BasicDiscoveryEvidence> {
  const [records, learning] = await Promise.all([
    readOrNull(join(structureDir, BASIC_DISCOVERY_FILE)),
    readOrNull(join(structureDir, LEARNING_STATE_FILE)),
  ])
  return { records: parseBasicDiscoveryRecords(records), learning: parseLearningStateContent(learning) }
}

/**
 * `hasBasicDiscovery` over a project's evidence — and when the answer rests on
 * learned modules alone (no record yet), WRITE the record now, lazily.
 *
 * Self-healing for a sweep that learned its modules but never got to record
 * itself (live, 2026-10-06: a project's every module learned, no record, the
 * chip on "Learning…"). The rule already counts such a project as discovered;
 * the record makes that durable — it travels with the project, and survives a
 * reset of the learning state. A failed write is logged and the answer stands:
 * the knowledge is on disk either way. Never throws on a read.
 */
export async function ensureBasicDiscoveryRecord(structureDir: string, now: () => Date = () => new Date()): Promise<boolean> {
  const evidence = await readBasicDiscoveryEvidence(structureDir)
  if (!hasBasicDiscovery(evidence)) return false
  if (evidence.records.length > 0) return true
  const learned = (evidence.learning ?? []).filter((entry) => entry.status === 'learned').length
  try {
    await recordBasicDiscovery(structureDir, { completedAt: now().toISOString(), learned, failed: 0 })
  } catch (error) {
    console.warn('[BasicDiscovery] could not record a project discovered before its record existed', error)
  }
  return true
}

/** Append one completed sweep. Append-only: a line is never rewritten. */
export async function recordBasicDiscovery(structureDir: string, record: BasicDiscoveryRecord): Promise<void> {
  await fsPromises.mkdir(structureDir, { recursive: true })
  await fsPromises.appendFile(join(structureDir, BASIC_DISCOVERY_FILE), `${JSON.stringify(record)}\n`, 'utf-8')
}

/**
 * Does a project still get the one-time "Run a basic discovery?" ask? Only
 * when nothing sweeps it automatically: a Workspace project gets its basic
 * discovery on its own and is never asked; a project outside every Workspace
 * (its placement failed), or any project while the automatic layer is off,
 * keeps the ask — once, and never again after an answer.
 */
export function shouldAskBasicDiscovery(input: {
  answered: boolean
  askedThisSession: boolean
  automatic: boolean
  inWorkspace: boolean
}): boolean {
  if (input.answered || input.askedThisSession) return false
  return !(input.automatic && input.inWorkspace)
}

// ── The coordinator ─────────────────────────────────────────────────────────

export interface BasicDiscoveryDeps {
  /** Does the project have its basic discovery on disk? (`hasBasicDiscovery` over its evidence.) */
  hasRecord: (root: string) => Promise<boolean>
  /** Record a completed sweep. */
  record: (root: string, outcome: Extract<BasicDiscoveryRunOutcome, { kind: 'done' }>) => Promise<void>
  /** Run one project's sweep to its end (the learn orchestrator's `runBasicDiscovery`). */
  run: (root: string, options: { resume?: boolean }) => Promise<BasicDiscoveryRunOutcome>
  /** Is the project provisioned and ready to learn? */
  isReady: (root: string) => boolean
  /** Is the project in a Workspace? Only those are swept automatically and held. */
  inWorkspace: (root: string) => Promise<boolean>
  /** Is the automatic layer on at all? (Off only in a hidden e2e run without a stand-in.) */
  automatic: () => boolean
  /** A project's status changed (broadcast to the renderer). */
  onChange: (root: string, status: BasicDiscoveryStatus) => void
  /** Sweeps at once. Default 1. */
  maxConcurrent?: number
  log?: (message: string, details?: Record<string, unknown>) => void
}

export type BasicDiscoverySettled = { ok: true } | { ok: false; reason: string }

export interface RequireOptions {
  /** A person is waiting on these projects: move them to the front of the queue. */
  priority?: boolean
  /** A person asked again: re-run a sweep that failed (and lift a pause it caused). */
  retry?: boolean
}

export interface BasicDiscovery {
  /**
   * THE ONE DOOR every caller uses (the launch re-check, a Workspace change, a
   * thread's send, an attach): for each root that is in a Workspace and lacks
   * basic discovery, make sure its sweep is queued or running. Answers which
   * of `roots` are still learning (queued, running or failed).
   */
  require(roots: readonly string[], options?: RequireOptions): Promise<{ learning: string[] }>
  /** `require` with no one waiting — the launch / Workspace-change re-check. */
  reconcile(roots: readonly string[]): Promise<void>
  /** Wait for a root's sweep to end. A root not learning answers at once. */
  whenSettled(root: string): Promise<BasicDiscoverySettled>
  /** The last known status (null when this root was never asked about). */
  status(root: string): BasicDiscoveryStatus | null
  /** Why the last sweep failed, or null. */
  failure(root: string): string | null
  /** Is this root known to still be learning — kept out of a session's folders? */
  isDeferred(root: string): boolean
  /** A root finished provisioning: a sweep parked on it may run now. */
  rootReady(root: string): void
  /** A root left the app. */
  forget(root: string): void
}

const STOPPED_REASON = 'Learning this project was stopped before it finished.'

/** One log line's worth of how a sweep ended. */
function describeOutcome(outcome: BasicDiscoveryRunOutcome): string {
  switch (outcome.kind) {
    case 'done':
      return `done (${String(outcome.learned)} learned, ${String(outcome.failed)} failed)`
    case 'failed':
      return `failed — ${outcome.reason}`
    case 'not-ready':
      return 'waiting for setup to finish'
    case 'cancelled':
      return 'stopped'
  }
}

export function createBasicDiscovery(deps: BasicDiscoveryDeps): BasicDiscovery {
  const maxConcurrent = Math.max(1, deps.maxConcurrent ?? 1)
  const log =
    deps.log ??
    ((message: string, details?: Record<string, unknown>) =>
      details === undefined ? console.info(`[BasicDiscovery] ${message}`) : console.warn(`[BasicDiscovery] ${message}`, details))
  /** A project as the log names it — its folder name, never its path. */
  const nameOf = (root: string): string => basename(root) || root
  const statuses = new Map<string, BasicDiscoveryStatus>()
  const failures = new Map<string, string>()
  /** Roots waiting for a turn, in order. */
  const queue: string[] = []
  /** Roots waiting for provisioning to finish. */
  const parked = new Set<string>()
  /** Roots whose sweep is running now. */
  const active = new Set<string>()
  /** Roots whose next run is a person's Try again. */
  const resumeNext = new Set<string>()
  const waiters = new Map<string, Array<(answer: BasicDiscoverySettled) => void>>()
  /** Per-root checks in flight — two callers asking at once share one read. */
  const checking = new Map<string, Promise<boolean>>()

  function setStatus(root: string, status: BasicDiscoveryStatus): void {
    if (statuses.get(root) === status) return
    statuses.set(root, status)
    deps.onChange(root, status)
  }

  function settle(root: string, answer: BasicDiscoverySettled): void {
    const list = waiters.get(root) ?? []
    waiters.delete(root)
    for (const resolve of list) resolve(answer)
  }

  function enqueue(root: string, priority: boolean): void {
    if (active.has(root)) return
    const at = queue.indexOf(root)
    if (at !== -1) {
      if (priority && at > 0) {
        queue.splice(at, 1)
        queue.unshift(root)
      }
      return
    }
    parked.delete(root)
    if (priority) queue.unshift(root)
    else queue.push(root)
    setStatus(root, 'queued')
  }

  function pump(): void {
    // A root that is not provisioned yet waits outside the queue; `rootReady`
    // (or a later `not-ready` answer) brings it back.
    for (let index = queue.length - 1; index >= 0; index -= 1) {
      const root = queue[index] as string
      if (!deps.isReady(root)) {
        queue.splice(index, 1)
        parked.add(root)
      }
    }
    while (active.size < maxConcurrent && queue.length > 0) {
      const root = queue.shift() as string
      active.add(root)
      setStatus(root, 'running')
      void runOne(root, resumeNext.delete(root))
    }
  }

  async function runOne(root: string, resume: boolean): Promise<void> {
    log(`sweep started for ${nameOf(root)}`)
    let outcome: BasicDiscoveryRunOutcome
    try {
      outcome = await deps.run(root, { resume })
    } catch (error) {
      log('a basic discovery threw', { project: nameOf(root), error: String(error) })
      outcome = { kind: 'failed', reason: "Flow couldn't start learning this project." }
    }
    log(`sweep ended for ${nameOf(root)}: ${describeOutcome(outcome)}`)
    active.delete(root)
    // Forgotten while it ran: nobody is owed an answer about it any more.
    if (!statuses.has(root)) {
      pump()
      return
    }
    switch (outcome.kind) {
      case 'done':
        try {
          await deps.record(root, outcome)
        } catch (error) {
          // The knowledge is there; only the record of it is not. Say so in the
          // log and treat the project as discovered for this session.
          log('could not record a completed basic discovery', { root, error: String(error) })
        }
        failures.delete(root)
        setStatus(root, 'done')
        settle(root, { ok: true })
        break
      case 'not-ready':
        parked.add(root)
        setStatus(root, 'queued')
        break
      case 'failed':
        failures.set(root, outcome.reason)
        setStatus(root, 'failed')
        settle(root, { ok: false, reason: outcome.reason })
        break
      case 'cancelled':
        failures.set(root, STOPPED_REASON)
        setStatus(root, 'failed')
        settle(root, { ok: false, reason: STOPPED_REASON })
        break
    }
    pump()
  }

  /** Does the root have basic discovery? Cached once true; reads shared. */
  function check(root: string): Promise<boolean> {
    if (statuses.get(root) === 'done') return Promise.resolve(true)
    const inFlight = checking.get(root)
    if (inFlight !== undefined) return inFlight
    const read = deps
      .hasRecord(root)
      .catch((error: unknown) => {
        log('could not read whether a project has its basic discovery', { root, error: String(error) })
        return false
      })
      .finally(() => checking.delete(root))
    checking.set(root, read)
    return read
  }

  async function requireOne(root: string, options: RequireOptions): Promise<boolean> {
    if (!deps.automatic()) return false
    const status = statuses.get(root)
    if (status === 'queued' || status === 'running') {
      // PARKED ON SETUP, AND SETUP HAS SINCE FINISHED: the ready signal was
      // missed (or came before the park). Any later check picks it back up
      // rather than leaving it "queued" for good.
      if (parked.has(root) && deps.isReady(root)) {
        parked.delete(root)
        if (options.priority === true) queue.unshift(root)
        else queue.push(root)
        return true
      }
      if (options.priority === true) enqueue(root, true)
      return true
    }
    if (status === 'failed') {
      if (options.retry !== true) {
        // A failed sweep may have been learned since (its queue drained after
        // a pause lifted, or a person's Learn): the rule decides, not the
        // failure this session remembers.
        if (await check(root)) {
          failures.delete(root)
          setStatus(root, 'done')
          return false
        }
        return true
      }
      failures.delete(root)
      resumeNext.add(root)
      enqueue(root, options.priority === true)
      return true
    }
    if (status === 'done') return false
    let inside = false
    try {
      inside = await deps.inWorkspace(root)
    } catch (error) {
      log('could not read which Workspace a project is in', { root, error: String(error) })
    }
    if (!inside) {
      setStatus(root, 'not-required')
      return false
    }
    if (await check(root)) {
      setStatus(root, 'done')
      return false
    }
    // Re-read: another caller may have queued it during the awaits above.
    const now = statuses.get(root)
    if (now === 'running') return true
    enqueue(root, options.priority === true)
    return true
  }

  async function require(roots: readonly string[], options: RequireOptions = {}): Promise<{ learning: string[] }> {
    const learning: string[] = []
    for (const root of roots) {
      if (await requireOne(root, options)) learning.push(root)
    }
    pump()
    return { learning }
  }

  return {
    require,
    async reconcile(roots) {
      await require(roots)
    },
    whenSettled(root) {
      const status = statuses.get(root)
      if (status === undefined || status === 'done' || status === 'not-required') return Promise.resolve({ ok: true })
      if (status === 'failed') return Promise.resolve({ ok: false, reason: failures.get(root) ?? STOPPED_REASON })
      return new Promise((resolve) => {
        const list = waiters.get(root) ?? []
        list.push(resolve)
        waiters.set(root, list)
      })
    },
    status: (root) => statuses.get(root) ?? null,
    failure: (root) => failures.get(root) ?? null,
    isDeferred(root) {
      const status = statuses.get(root)
      return status === 'queued' || status === 'running' || status === 'failed'
    },
    rootReady(root) {
      if (!parked.delete(root)) return
      queue.push(root)
      pump()
    },
    forget(root) {
      const at = queue.indexOf(root)
      if (at !== -1) queue.splice(at, 1)
      parked.delete(root)
      resumeNext.delete(root)
      failures.delete(root)
      statuses.delete(root)
      settle(root, { ok: false, reason: STOPPED_REASON })
    },
  }
}
