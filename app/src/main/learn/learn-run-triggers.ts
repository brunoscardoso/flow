// Run-aware learn triggers (progressive-learning #513 phase 9) — the app-side
// consumer of the two run-release rounds entries execute-plan emits into
// `flow/.rounds.jsonl` (see the "Rounds Record" section + the
// "Pause-during-runs rule" in `.claude/resources/skills/execute-plan-skill.md`):
//
//   • `module_completed` — the moment a module's LAST touching phase finishes,
//     the per-module release signal.
//   • `archive_sweep`    — once per run, at plan archive, covering every module
//     the run touched — a run-level safety net alongside the per-module signal.
//
// This module tail-reads `flow/.rounds.jsonl` from a per-root byte offset (the
// same fail-soft, cursor-based approach flow-observer.ts uses for the
// heartbeat events file), and funnels the two release entries into
// `learnOrchestrator.enqueueModule` — `module_completed` is an AUTO re-learn
// (`deliberate: false`, subject to the session budget); `archive_sweep` is
// DELIBERATE (`deliberate: true`) because the run itself was a deliberate,
// user-approved action, and the sweep must not be silently dropped for budget.
//
// Reconciling the two stated requirements: enqueue actions fire ONLY for
// `module_completed` / `archive_sweep` — every other rounds entry type
// (verification, risk, escalation, run_intent, plan_decision, review_verdict)
// is parsed-and-discarded, never triggering a re-learn. `phase_result` is the
// one exception: it carries no enqueue action of its own, but its optional
// `anchors` array (module-kind anchors) is the ONLY source of "which modules
// did this run touch" — required to answer `isModuleInPlay`, which must be
// true from the first phase_result naming a module until that module's
// release entry appears. Without reading phase_result's anchors there would
// be no way to know a module is in play before its release fires.
//
// `isModuleInPlay` is exported now for Phase 8's auto-relearn triggers to
// consult later (wiring lands in a later phase) — a module currently in play
// for ANY active run on a root must never be auto re-learned out from under
// the run per the pause-during-runs rule.
//
// This module touches only node:fs/path (no Electron) — plain-Node loadable,
// same discipline as flow-observer.ts and learning-state.ts.

import { closeSync, fstatSync, openSync, readSync } from 'node:fs'
import { join } from 'node:path'

import { FLOW_STATE_CHANGED_EVENT } from '../flow/flow-observer'

const ROUNDS_FILE = '.rounds.jsonl'

// ── Pure parsing (exported for tests) ─────────────────────────────────────

/** A `module_completed` rounds entry — the per-module release signal. */
export interface ModuleCompletedEntry {
  type: 'module_completed'
  run_id: string
  module: string
}

/** An `archive_sweep` rounds entry — the run-level release safety net. */
export interface ArchiveSweepEntry {
  type: 'archive_sweep'
  run_id: string
  modules: string[]
}

/** A `phase_result` rounds entry, reduced to just its module-kind anchors —
 *  the "which modules is this run touching" signal (no enqueue action). */
export interface PhaseResultAnchorEntry {
  type: 'phase_result'
  run_id: string
  moduleAnchors: string[]
}

export type RelevantRoundsEntry =
  | ModuleCompletedEntry
  | ArchiveSweepEntry
  | PhaseResultAnchorEntry

/**
 * Parse one rounds.jsonl line into a `RelevantRoundsEntry`, or `null` when
 * the line is malformed, shape-invalid, or an entry type we don't act on
 * (verification, risk, escalation, run_intent, plan_decision, review_verdict).
 * Fail-soft: a torn/corrupt line is skipped, never thrown — the coordinator
 * and this reader may race on the same growing file.
 */
export function parseRoundsLine(raw: string): RelevantRoundsEntry | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return null
  }
  const record = parsed as Record<string, unknown>
  const runId = typeof record.run_id === 'string' && record.run_id.length > 0 ? record.run_id : null
  if (!runId) {
    return null
  }
  switch (record.type) {
    case 'module_completed': {
      const module = typeof record.module === 'string' && record.module.length > 0 ? record.module : null
      if (!module) {
        return null
      }
      return { type: 'module_completed', run_id: runId, module }
    }
    case 'archive_sweep': {
      const modulesRaw = Array.isArray(record.modules) ? record.modules : []
      const modules = modulesRaw.filter((m): m is string => typeof m === 'string' && m.length > 0)
      return { type: 'archive_sweep', run_id: runId, modules }
    }
    case 'phase_result': {
      const anchorsRaw = Array.isArray(record.anchors) ? record.anchors : []
      const moduleAnchors = anchorsRaw
        .filter((a): a is Record<string, unknown> => typeof a === 'object' && a !== null)
        .filter((a) => a.kind === 'module' && typeof a.ref === 'string' && a.ref.length > 0)
        .map((a) => a.ref as string)
      return { type: 'phase_result', run_id: runId, moduleAnchors }
    }
    default:
      return null
  }
}

// ── Pure state core (exported for tests) ──────────────────────────────────

/** Per-root bookkeeping: run_id -> the set of modules still "in play" for
 *  that run (touched by a phase_result, not yet released). */
export interface TriggerRunState {
  runs: Map<string, Set<string>>
}

/** A fresh, empty state. */
export function emptyTriggerRunState(): TriggerRunState {
  return { runs: new Map() }
}

/** One enqueue action to perform against `learnOrchestrator.enqueueModule`. */
export interface TriggerAction {
  module: string
  reason: string
  deliberate: boolean
}

/** Result of folding one parsed entry into state. */
export interface FoldResult {
  state: TriggerRunState
  actions: TriggerAction[]
}

/**
 * Fold one parsed rounds entry into the run-tracking state.
 *
 * - `phase_result` — adds its module anchors to the run's in-play set. No
 *   enqueue action (bookkeeping only).
 * - `module_completed` — removes the module from its run's in-play set and
 *   emits an AUTO enqueue action (`deliberate: false`).
 * - `archive_sweep` — CLEARS the entire run's in-play set (the run is over)
 *   and emits a DELIBERATE enqueue action per module (`deliberate: true`).
 */
export function foldRoundsEntry(state: TriggerRunState, entry: RelevantRoundsEntry): FoldResult {
  const runs = new Map(state.runs)
  switch (entry.type) {
    case 'phase_result': {
      if (entry.moduleAnchors.length === 0) {
        return { state, actions: [] }
      }
      const next = new Set(runs.get(entry.run_id) ?? [])
      for (const module of entry.moduleAnchors) {
        next.add(module)
      }
      runs.set(entry.run_id, next)
      return { state: { runs }, actions: [] }
    }
    case 'module_completed': {
      const existing = runs.get(entry.run_id)
      if (existing) {
        const next = new Set(existing)
        next.delete(entry.module)
        runs.set(entry.run_id, next)
      }
      return {
        state: { runs },
        actions: [{ module: entry.module, reason: 'run module completed', deliberate: false }],
      }
    }
    case 'archive_sweep': {
      runs.delete(entry.run_id)
      return {
        state: { runs },
        actions: entry.modules.map((module) => ({
          module,
          reason: 'post-run sweep',
          deliberate: true,
        })),
      }
    }
  }
}

/** Whether `module` is in play for ANY tracked run in this state. */
export function isModuleInPlayState(state: TriggerRunState, module: string): boolean {
  for (const inPlay of state.runs.values()) {
    if (inPlay.has(module)) {
      return true
    }
  }
  return false
}

// ── Tail reading (byte-cursor, fail-soft — mirrors flow-observer.ts) ───────

interface RoundsTail {
  lines: string[]
  cursor: number
  truncated: boolean
}

function isCompleteJsonLine(text: string): boolean {
  try {
    JSON.parse(text)
    return true
  } catch {
    return false
  }
}

function readLinesFrom(fd: number, cursor: number, size: number): { lines: string[]; cursor: number } {
  if (size === cursor) {
    return { lines: [], cursor }
  }
  const buffer = Buffer.alloc(size - cursor)
  const bytesRead = readSync(fd, buffer, 0, buffer.length, cursor)
  const chunk = buffer.subarray(0, bytesRead)
  const text = chunk.toString('utf-8')
  // The coordinator may be mid-append: if the trailing residue after the last
  // newline is not complete JSON, leave it for the next read.
  const lastNewline = text.lastIndexOf('\n')
  let consumedText = text
  let consumedBytes = chunk.length
  const residue = text.slice(lastNewline + 1)
  if (residue && !isCompleteJsonLine(residue)) {
    consumedText = text.slice(0, lastNewline + 1)
    consumedBytes = Buffer.byteLength(consumedText, 'utf-8')
  }
  const lines = consumedText
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
  return { lines, cursor: cursor + consumedBytes }
}

/**
 * Read `flow/.rounds.jsonl` from a byte cursor. A shrunken file means it was
 * truncated/rotated (e.g. a fresh run started after archiving) — re-read
 * from the start and report `truncated` so the caller resets its
 * accumulated run-tracking state instead of concatenating onto stale data.
 * A missing file yields an empty read (fail-soft — most roots have no
 * `.rounds.jsonl` until a run starts).
 */
function readRoundsTail(path: string, cursor: number): RoundsTail {
  let fd: number
  try {
    fd = openSync(path, 'r')
  } catch {
    return { lines: [], cursor: 0, truncated: cursor > 0 }
  }
  try {
    const size = fstatSync(fd).size
    if (size < cursor) {
      return { ...readLinesFrom(fd, 0, size), truncated: true }
    }
    return { ...readLinesFrom(fd, cursor, size), truncated: false }
  } finally {
    closeSync(fd)
  }
}

// ── The consumer (effects — enqueueModule is the only injected seam) ──────

/** Injectable seams — `enqueueModule` is `learnOrchestrator.enqueueModule` in
 *  production; tests inject a spy. */
export interface LearnRunTriggersDeps {
  enqueueModule: (
    rootPath: string,
    modulePath: string,
    options: { reason: string; deliberate?: boolean },
  ) => void
  /** Best-effort error sink (default console.warn). */
  onError?: (message: string, error: unknown) => void
}

/** A change-event source shaped like FlowObserver (structural — no import of
 *  the class itself needed, keeping this module decoupled from Electron). */
export interface FlowStateChangeSource {
  on(event: string, listener: (payload: { rootId: string }) => void): unknown
}

interface RootTriggerState {
  offset: number
  triggerState: TriggerRunState
}

/**
 * Tails each attached root's `flow/.rounds.jsonl`, folding `module_completed`
 * / `archive_sweep` entries into `enqueueModule` calls and `phase_result`
 * module anchors into the `isModuleInPlay` bookkeeping. One instance per app;
 * `attach` wires it to FlowObserver's `state-changed` event (fired whenever
 * `.rounds.jsonl` changes, among other watched files — see flow-observer.ts's
 * `WATCHED_BASENAMES`).
 */
export class LearnRunTriggers {
  private readonly roots = new Map<string, RootTriggerState>()
  private readonly enqueueModule: LearnRunTriggersDeps['enqueueModule']
  private readonly onError: (message: string, error: unknown) => void

  constructor(deps: LearnRunTriggersDeps) {
    this.enqueueModule = deps.enqueueModule
    this.onError =
      deps.onError ?? ((message, error) => console.warn(`[LearnRunTriggers] ${message}`, error))
  }

  /**
   * Subscribe to a FlowObserver-like change source — every `state-changed`
   * event re-tails that root's rounds file. Additive subscription only: this
   * never modifies the source, it just listens.
   */
  attach(source: FlowStateChangeSource): void {
    source.on(FLOW_STATE_CHANGED_EVENT, (payload) => {
      void this.checkRoot(payload.rootId)
    })
  }

  /**
   * Whether `module` is currently in play (touched by an active run for
   * `rootPath`, not yet released via `module_completed`/`archive_sweep`).
   * `false` for a root we've never tailed — a module is only "in play" once
   * we've actually observed a phase_result naming it.
   */
  isModuleInPlay(rootPath: string, module: string): boolean {
    const root = this.roots.get(rootPath)
    if (!root) {
      return false
    }
    return isModuleInPlayState(root.triggerState, module)
  }

  /**
   * Tail-read `rootPath`'s `flow/.rounds.jsonl` from the stored byte offset,
   * fold every new complete line, and perform the resulting enqueue actions.
   * Fail-soft: a missing/unreadable file or a malformed line never throws —
   * at worst a module's re-learn is delayed to the next change event.
   * Idempotent: calling this again before new bytes are appended reads zero
   * new lines and performs zero actions (the byte cursor never rewinds on a
   * stable file).
   */
  async checkRoot(rootPath: string): Promise<void> {
    const current = this.roots.get(rootPath) ?? { offset: 0, triggerState: emptyTriggerRunState() }
    const roundsPath = join(rootPath, 'flow', ROUNDS_FILE)

    let tail: RoundsTail
    try {
      tail = readRoundsTail(roundsPath, current.offset)
    } catch (error) {
      this.onError(`failed to tail ${roundsPath}`, error)
      return
    }

    // A truncated/rotated file (new run started fresh) invalidates prior
    // run-tracking state — start clean rather than carry stale run_ids.
    let triggerState = tail.truncated ? emptyTriggerRunState() : current.triggerState

    for (const line of tail.lines) {
      const entry = parseRoundsLine(line)
      if (!entry) {
        continue
      }
      const { state: nextState, actions } = foldRoundsEntry(triggerState, entry)
      triggerState = nextState
      for (const action of actions) {
        try {
          this.enqueueModule(rootPath, action.module, {
            reason: action.reason,
            deliberate: action.deliberate,
          })
        } catch (error) {
          this.onError(`enqueueModule failed for ${rootPath}/${action.module}`, error)
        }
      }
    }

    this.roots.set(rootPath, { offset: tail.cursor, triggerState })
  }
}
