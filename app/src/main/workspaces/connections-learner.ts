/**
 * CONNECTIONS LEARNING, the app's half (discovery
 * `workspace-connections-learning`, 2026-10-06).
 *
 * The CLI decides everything that can be decided without a model —
 * `workspace learn-connections` answers which pairs of projects are pending,
 * what signs they show of talking and, for the ones with a sign, the whole
 * prompt (the DOSSIER) — and it is the one writer of what is learned. This
 * module only does what the CLI cannot: ask the fast model, under a project's
 * own account, and hand the raw answer back. The CLI checks the answer against
 * the real features and writes what survives (allowed-pattern #14).
 *
 * ONE RUN PER WORKSPACE. Pairs are checked one after another; a run asked for
 * while one is going is folded into it (a person's ask re-runs once it ends,
 * so a change made meanwhile is not missed). A pair whose model call times out
 * or answers nothing is recorded as a failed check — its code matches are kept
 * and it stays pending for the NEXT run, never retried inside this one.
 *
 * TRIGGERS live in main's wiring: a project finishing its basic discovery (an
 * automatic run, honouring the automatic-learning setting), once after launch,
 * and a person pressing Learn connections on the Workspace map.
 *
 * Progress is broadcast once per pair, never per event (allowed-pattern #17).
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { ConnectionsLearningStatus } from '../../shared/ipc-contract'
import { lastJsonLine } from './cli-json'
import type { WorkspaceCliRunner } from './workspace-registry'

// ── Constants ────────────────────────────────────────────────────────────────

/** The plan reads every project's features, endpoints and calls. */
export const PLAN_TIMEOUT_MS = 60_000
/** One pair's write: its links, each mirrored into feature notes. */
export const PAIR_TIMEOUT_MS = 60_000
/** One model call over one dossier. */
export const MODEL_TIMEOUT_MS = 45_000

// ── Shapes ───────────────────────────────────────────────────────────────────

/** One fast-model call: the prompt in, its text out (null = nothing usable). */
export type ConnectionsModelCall = (input: { projectRoot: string; prompt: string; signal: AbortSignal }) => Promise<string | null>

export interface PlannedPair {
  pair: [string, string]
  state: 'learned' | 'pending' | 'blocked'
  dossier: string | null
}

export interface ConnectionsLearnerDeps {
  /** REQUIRED: the CLI is the only source and the only writer (allowed-pattern #26). */
  runCli: WorkspaceCliRunner
  /** REQUIRED: the fast model. Answers null when there is none to ask. */
  askModel: ConnectionsModelCall
  /** REQUIRED: which Workspace a project root is in (null: none). */
  workspaceOfRoot: (root: string) => Promise<string | null>
  /** REQUIRED: whether automatic learning is on — an automatic run honours it, a person's does not. */
  automatic: () => boolean
  /** Every status change of a run. */
  onStatus?: (status: ConnectionsLearningStatus) => void
  /** Hands the CLI the model's answer as a file; the default writes a temp file. */
  writeAnswer?: (text: string) => Promise<{ path: string; dispose: () => Promise<void> }>
  log?: (message: string, details: Record<string, unknown>) => void
  modelTimeoutMs?: number
}

export type LearnTrigger = 'automatic' | 'person'

export interface ConnectionsLearner {
  /**
   * Learn the pending pairs of `root`'s Workspace. Resolves when the run it
   * started (or joined) ends, with that run's last status — or null when there
   * is nothing to do (no Workspace, or automatic learning is off).
   */
  learn(root: string, trigger: LearnTrigger): Promise<ConnectionsLearningStatus | null>
  /** A Workspace's current (or last) run, or null if none ran in this session. */
  status(workspace: string): ConnectionsLearningStatus | null
}

// ── Pure helpers ─────────────────────────────────────────────────────────────

/** Narrow the plan's stdout to its pairs. Null when it is not a plan. */
export function parsePlan(stdout: string): PlannedPair[] | null {
  const obj = lastJsonLine(stdout)
  if (obj === null || obj.action !== 'learn-connections' || !Array.isArray(obj.pairs)) return null
  const pairs: PlannedPair[] = []
  for (const raw of obj.pairs) {
    if (raw === null || typeof raw !== 'object') continue
    const row = raw as Record<string, unknown>
    if (!Array.isArray(row.pair) || row.pair.length !== 2 || row.pair.some((slug) => typeof slug !== 'string')) continue
    const state = row.state === 'learned' || row.state === 'pending' || row.state === 'blocked' ? row.state : null
    if (state === null) continue
    pairs.push({
      pair: [row.pair[0] as string, row.pair[1] as string],
      state,
      dossier: typeof row.dossier === 'string' && row.dossier.trim() !== '' ? row.dossier : null,
    })
  }
  return pairs
}

/** How many connections one pair's check added. */
export function parsePairFound(stdout: string): number | null {
  const obj = lastJsonLine(stdout)
  if (obj === null || obj.action !== 'learn-connections' || obj.mode !== 'pair') return null
  const recorded = (value: unknown): number => {
    if (value === null || typeof value !== 'object') return 0
    const count = (value as Record<string, unknown>).recorded
    return typeof count === 'number' && Number.isFinite(count) ? count : 0
  }
  return recorded(obj.code) + recorded(obj.model)
}

async function defaultWriteAnswer(text: string): Promise<{ path: string; dispose: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), 'flow-connections-'))
  const path = join(dir, 'answer.txt')
  await writeFile(path, text, 'utf-8')
  return { path, dispose: () => rm(dir, { recursive: true, force: true }) }
}

// ── The learner ──────────────────────────────────────────────────────────────

export function createConnectionsLearner(deps: ConnectionsLearnerDeps): ConnectionsLearner {
  const statuses = new Map<string, ConnectionsLearningStatus>()
  const running = new Map<string, Promise<ConnectionsLearningStatus>>()
  /** A person asked while a run was going — run again when it ends. */
  const again = new Map<string, string>()
  const writeAnswer = deps.writeAnswer ?? defaultWriteAnswer
  const modelTimeoutMs = deps.modelTimeoutMs ?? MODEL_TIMEOUT_MS
  const log = deps.log ?? ((): void => undefined)

  function publish(status: ConnectionsLearningStatus): ConnectionsLearningStatus {
    statuses.set(status.workspace, status)
    deps.onStatus?.(status)
    return status
  }

  async function askWithTimeout(root: string, prompt: string): Promise<string | null> {
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => {
        controller.abort()
        resolve(null)
      }, modelTimeoutMs)
    })
    try {
      return await Promise.race([deps.askModel({ projectRoot: root, prompt, signal: controller.signal }).catch(() => null), timeout])
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }

  /** Check one pair. Returns how many connections it added, or null when the check could not be recorded. */
  async function checkPair(root: string, workspace: string, planned: PlannedPair): Promise<number | null> {
    const base = ['workspace', 'learn-connections', '--target', root, '--workspace', workspace, '--pair', planned.pair.join(','), '--json']
    if (planned.dossier === null) {
      const result = await deps.runCli(root, [...base, '--model', 'no-signal'], { timeoutMs: PAIR_TIMEOUT_MS })
      return result.ok ? parsePairFound(result.stdout) : null
    }
    const answer = await askWithTimeout(root, planned.dossier)
    if (answer === null || answer.trim() === '') {
      const result = await deps.runCli(root, [...base, '--model', 'failed'], { timeoutMs: PAIR_TIMEOUT_MS })
      return result.ok ? parsePairFound(result.stdout) : null
    }
    const file = await writeAnswer(answer)
    try {
      const result = await deps.runCli(root, [...base, '--answer', file.path], { timeoutMs: PAIR_TIMEOUT_MS })
      if (!result.ok) log('connections: a pair could not be recorded', { pair: planned.pair, error: result.error ?? result.stdout })
      return result.ok ? parsePairFound(result.stdout) : null
    } finally {
      await file.dispose().catch(() => undefined)
    }
  }

  async function run(root: string, workspace: string): Promise<ConnectionsLearningStatus> {
    const plan = await deps.runCli(root, ['workspace', 'learn-connections', '--target', root, '--workspace', workspace, '--json'], {
      timeoutMs: PLAN_TIMEOUT_MS,
    })
    const pairs = plan.ok ? parsePlan(plan.stdout) : null
    if (pairs === null) {
      log('connections: the plan could not be read', { workspace, error: plan.error ?? plan.stdout.slice(0, 400) })
      return publish({ workspace, running: false, done: 0, total: 0, found: 0, error: "Flow couldn't read this Workspace's projects." })
    }
    const pending = pairs.filter((pair) => pair.state === 'pending')
    let status = publish({ workspace, running: pending.length > 0, done: 0, total: pending.length, found: 0, error: null })
    let failures = 0
    for (const planned of pending) {
      status = publish({ ...status, current: planned.pair })
      const found = await checkPair(root, workspace, planned)
      if (found === null) failures += 1
      status = publish({ ...status, done: status.done + 1, found: status.found + (found ?? 0) })
    }
    return publish({
      ...status,
      current: null,
      running: false,
      error: failures === 0 ? null : `${String(failures)} of ${String(pending.length)} pairs couldn't be checked; Flow will try them again.`,
    })
  }

  async function learn(root: string, trigger: LearnTrigger): Promise<ConnectionsLearningStatus | null> {
    if (trigger === 'automatic' && !deps.automatic()) return null
    const workspace = await deps.workspaceOfRoot(root)
    if (workspace === null) return null
    const inFlight = running.get(workspace)
    if (inFlight !== undefined) {
      if (trigger === 'person') again.set(workspace, root)
      return inFlight
    }
    // SAID AT ONCE: reading every project's endpoints and calls takes a while
    // on a large Workspace, and a run that says nothing until then looks dead.
    publish({ workspace, running: true, done: 0, total: 0, found: 0, error: null, current: null })
    const go = async (): Promise<ConnectionsLearningStatus> => {
      let last = await run(root, workspace)
      const rerunRoot = again.get(workspace)
      if (rerunRoot !== undefined) {
        again.delete(workspace)
        last = await run(rerunRoot, workspace)
      }
      return last
    }
    const promise = go()
      .catch((error: unknown) => {
        log('connections: a run failed', { workspace, error: error instanceof Error ? error.message : String(error) })
        return publish({ workspace, running: false, done: 0, total: 0, found: 0, error: "Flow couldn't finish learning connections." })
      })
      .finally(() => running.delete(workspace))
    running.set(workspace, promise)
    return promise
  }

  return {
    learn,
    status: (workspace) => statuses.get(workspace) ?? null,
  }
}
