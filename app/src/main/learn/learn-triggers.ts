// Learn triggers (progressive-learning #513 phase 8) — the ALWAYS-ON staleness
// watcher that turns a source-file save into a re-hash pass and, when a note's
// stamped files drift, flips the module's board dot to 'stale'.
//
// The flow, per project root:
//   1. tap the root watcher's debounced file-change batch (index.ts adapts
//      ProjectRegistry's 'files-changed' event into this module's minimal
//      `FilesChangedBatch` shape — kept structural so this file never imports
//      the project registry / chokidar),
//   2. filter to SOURCE files (the SAME isSourceFileName rule the basic-derive
//      + orchestrator enumerator use — one definition of "source file"),
//   3. map each touched file to its owning depth-1 module (longest path-prefix
//      against the derived graph's depth-1 module paths — same modules the
//      orchestrator learns),
//   4. per-module IDLE debounce (12 min, injected timers): a fresh touch resets
//      the module's timer, so a burst of saves collapses into one check,
//   5. on idle: spawn the bundled CLI `blueprint stale-check --module <m> --json`
//      (P4 — the read-only staleness AUTHORITY; it never writes), parse it, and
//      if any note under the module drifted, append a 'stale' learning-state
//      entry (P5's channel — the board dot flips). This is FREE and ALWAYS ON:
//      hash-drift always flips the dot, no budget, no toggle.
//
// The optional `onModuleStale` seam is where phase-8 task 2 hangs the GUARDED
// auto re-learn (meaningful-diff + previously-learned + per-root toggle +
// budget) — task 1 never enqueues a learn; it only reports staleness.
//
// DECISION CORE — file→module mapping, the stale-report → entry rule, the
// numstat/comment-only meaningful-diff heuristic, and the auto-relearn gate —
// is PURE (no fs / no spawn / no Electron) and exhaustively unit-tested. The
// class holds only effects (timers, stale-check spawn, learning-state writes),
// every one injected, mirroring the orchestrator / provisioner idioms
// (main-side, plain-Node loadable) and allowed-pattern #14 (invariants in one
// code path, not prompt convention).

import { spawn } from 'node:child_process'
import { join, relative } from 'node:path'

import type {
  BlueprintLearningEntry,
  BlueprintLearningStatus,
} from '../../shared/ipc-contract'
import { isIgnoredModule } from '../../shared/learn-ignore'
import { isSourceFileName } from '../blueprint/basic-derive'
import type { BundledCli } from '../blueprint/derive-runner'
import { mutateLearningState, type MutateLearningState } from '../project/learning-state'

// ════════════════════════════════════════════════════════════════════════
// PURE DECISION CORE (no fs / no spawn / no Electron — exhaustively tested)
// ════════════════════════════════════════════════════════════════════════

/** Idle window after the last source touch before a module is re-checked. A
 *  burst of saves keeps resetting it, so one check runs per quiet module. */
export const IDLE_MS = 12 * 60 * 1000

/** One stale note in a P4 stale-check report (only the fields we consume). */
export interface StaleCheckStaleNote {
  fingerprint: string
  /** The note's anchors — carried through but not inspected here. */
  anchors: unknown[]
  /** Stamped files whose current content hash no longer matches the stamp. */
  changedFiles: string[]
  /** Stamped files that no longer exist. */
  missingFiles: string[]
}

/** The `blueprint stale-check --json` report shape (P4 contract). */
export interface StaleCheckReport {
  checked: number
  fresh: number
  stale: StaleCheckStaleNote[]
}

/** A single file event — the minimal slice this module needs (absolute path). */
export interface FileChangeLike {
  /** Absolute path of the changed/created/deleted file. */
  path: string
}

/** A debounced per-root batch of file events (structurally compatible with
 *  ProjectRegistry's ProjectFilesChangedEvent — no import needed). */
export interface FilesChangedBatch {
  rootPath: string
  changes: readonly FileChangeLike[]
}

/** Normalize a path to posix separators so prefix math is platform-stable. */
function toPosix(path: string): string {
  return path.split('\\').join('/')
}

/**
 * Map a repo-relative source file to its owning depth-1 module: the module
 * whose directory path CONTAINS the file (`file === module` or `file` under
 * `module/`), longest match winning if several nest. `undefined` when the file
 * lives outside every module (e.g. a repo-root file with no module spine).
 * Mirrors the CLI's module-containment rule (`fileMatchesNode` in anchors.ts).
 */
export function mapFileToModule(relPath: string, modules: readonly string[]): string | undefined {
  const file = toPosix(relPath)
  let best: string | undefined
  for (const module of modules) {
    const dir = toPosix(module).replace(/\/+$/, '')
    if (file === dir || file.startsWith(`${dir}/`)) {
      if (best === undefined || dir.length > best.length) {
        best = dir
      }
    }
  }
  return best
}

/**
 * From a debounced batch, the DISTINCT depth-1 modules touched by a source
 * file (created/changed/deleted alike — a deleted source file can drift a
 * note). Non-source files and files outside the module spine are dropped.
 * Result is sorted for deterministic scheduling.
 */
export function collectTouchedModules(
  batch: FilesChangedBatch,
  modules: readonly string[],
): string[] {
  const touched = new Set<string>()
  for (const change of batch.changes) {
    const posixAbs = toPosix(change.path)
    const base = posixAbs.slice(posixAbs.lastIndexOf('/') + 1)
    if (!isSourceFileName(base)) {
      continue
    }
    const relPath = relative(batch.rootPath, change.path)
    // A path outside the root (relative → '..'/absolute) can never own a module.
    if (relPath.startsWith('..') || relPath.length === 0) {
      continue
    }
    const module = mapFileToModule(relPath, modules)
    if (module !== undefined) {
      touched.add(module)
    }
  }
  return [...touched].sort((a, b) => a.localeCompare(b))
}

/** A report is STALE for its module when any note drifted (changed or missing
 *  stamped file). Fresh reports (or a null parse) never flip the dot. */
export function reportIsStale(report: StaleCheckReport | null): report is StaleCheckReport {
  return report !== null && report.stale.length > 0
}

/** Build the 'stale' learning-state entry for a drifted module. */
export function staleEntry(modulePath: string, now: Date): BlueprintLearningEntry {
  return { module: modulePath, status: 'stale', notedAt: now.toISOString() }
}

/**
 * Parse `blueprint stale-check --json` stdout into a `StaleCheckReport`.
 * Fail-soft: unparseable JSON, a non-object, or a missing/mis-typed `stale`
 * array all yield `null` (treated as "could not determine staleness" — nothing
 * is written). Only the fields this module consumes are validated.
 */
export function parseStaleCheckJson(raw: string): StaleCheckReport | null {
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
  if (!Array.isArray(record.stale)) {
    return null
  }
  const stale: StaleCheckStaleNote[] = []
  for (const item of record.stale) {
    if (typeof item !== 'object' || item === null) {
      continue
    }
    const note = item as Record<string, unknown>
    stale.push({
      fingerprint: typeof note.fingerprint === 'string' ? note.fingerprint : '',
      anchors: Array.isArray(note.anchors) ? note.anchors : [],
      changedFiles: asStringArray(note.changedFiles),
      missingFiles: asStringArray(note.missingFiles),
    })
  }
  return {
    checked: typeof record.checked === 'number' ? record.checked : stale.length,
    fresh: typeof record.fresh === 'number' ? record.fresh : 0,
    stale,
  }
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : []
}

// ── Meaningful-diff heuristic (phase-8 task 2, pure) ────────────────────────
//
// LIMITS (documented, by design): the comment check is a CHEAP line-prefix
// heuristic — it recognizes `//`, `#`, `/*`, `*`, `*/`, `--`, `<!--` markers on
// the trimmed added/removed line. It cannot understand block comments whose
// continuation lines lack a marker, `//`-looking text inside a string literal,
// or non-listed comment syntaxes; ambiguous lines are treated as CONTENT (a
// real change), biasing the gate toward NOT suppressing a genuine edit. It is
// a spend gate only — a false "meaningful" costs one budget slot; the dot has
// already flipped regardless, so the staleness signal is never lost.

/** Minimum total changed lines (added + deleted) for a diff to be "meaningful". */
export const MEANINGFUL_MIN_LINES = 15

const COMMENT_PREFIXES = ['//', '/*', '*/', '*', '#', '--', '<!--']

/** Sum of added+deleted lines across `git diff --numstat` output. Binary files
 *  (`-\t-\tpath`) contribute 0. Malformed lines are skipped. */
export function parseNumstatTotal(output: string): number {
  let total = 0
  for (const line of output.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.length === 0) {
      continue
    }
    const parts = trimmed.split('\t')
    if (parts.length < 2) {
      continue
    }
    const added = Number.parseInt(parts[0], 10)
    const deleted = Number.parseInt(parts[1], 10)
    if (Number.isFinite(added)) {
      total += added
    }
    if (Number.isFinite(deleted)) {
      total += deleted
    }
  }
  return total
}

/** True when a stripped (no leading +/-) diff line reads as a comment. */
function looksLikeComment(content: string): boolean {
  const trimmed = content.trim()
  if (trimmed.length === 0) {
    return true // blank changed line carries no meaning — treat as non-content
  }
  return COMMENT_PREFIXES.some((prefix) => trimmed.startsWith(prefix))
}

/**
 * True when EVERY added/removed content line in a unified diff is a comment or
 * blank (i.e. the change carries no code). A diff with at least one non-comment
 * content line is NOT comment-only. An empty diff (no +/- lines) is treated as
 * comment-only (nothing meaningful to learn from).
 */
export function isCommentOnlyDiff(unifiedDiff: string): boolean {
  for (const line of unifiedDiff.split('\n')) {
    // Skip hunk/file headers (+++/---) — only real content lines start with a
    // single +/- followed by the line body.
    if (line.startsWith('+++') || line.startsWith('---')) {
      continue
    }
    if (line.startsWith('+') || line.startsWith('-')) {
      if (!looksLikeComment(line.slice(1))) {
        return false
      }
    }
  }
  return true
}

/** A change is meaningful when it moves ≥ MEANINGFUL_MIN_LINES lines AND is not
 *  comment/blank-only. Inputs are the two `git diff` outputs for the files. */
export function isMeaningfulDiff(numstatOutput: string, unifiedDiff: string): boolean {
  return parseNumstatTotal(numstatOutput) >= MEANINGFUL_MIN_LINES && !isCommentOnlyDiff(unifiedDiff)
}

/** The auto re-learn gate: all three must hold. Budget is enforced separately
 *  inside `LearnOrchestrator.enqueueModule` (auto items obey the session budget). */
export function shouldAutoRelearn(input: {
  meaningful: boolean
  previouslyLearned: boolean
  autoEnabled: boolean
}): boolean {
  return input.meaningful && input.previouslyLearned && input.autoEnabled
}

/** A module counts as previously-learned once a learn pass has touched it —
 *  its latest learning-state status is 'learned' (fresh) or 'stale' (drifted
 *  after a learn). A 'learning' (in-flight) or absent entry does not qualify. */
export function isPreviouslyLearned(status: BlueprintLearningStatus | undefined): boolean {
  return status === 'learned' || status === 'stale'
}

// ════════════════════════════════════════════════════════════════════════
// EFFECTS — the LearnTriggers class (every seam injected)
// ════════════════════════════════════════════════════════════════════════

/** Runs one `blueprint stale-check --module <m> --json` and returns the parsed
 *  report, or null when the CLI could not run / produced no parseable report. */
export type StaleCheckRunner = (rootPath: string, modulePath: string) => Promise<StaleCheckReport | null>

/** Context handed to the `onModuleStale` seam after a stale dot flips. */
export interface ModuleStaleContext {
  rootPath: string
  modulePath: string
  /** The stale-check report that flipped the dot (guaranteed `stale.length > 0`). */
  report: StaleCheckReport
  /** The module's learning-state status BEFORE this stale entry was written —
   *  read once, before the write, so "previously learned" is not self-fulfilled. */
  priorStatus: BlueprintLearningStatus | undefined
}

/** Opaque timer handle — the default uses Node's setTimeout; tests inject fakes. */
export type TimerHandle = unknown

export interface LearnTriggersDeps {
  /** Subscribe to per-root debounced file-change batches. Returns unsubscribe. */
  onFilesChanged: (listener: (batch: FilesChangedBatch) => void) => () => void
  /** Resolve a root's depth-1 module paths (from the derived/basic graph). */
  readModules: (rootPath: string) => Promise<string[]>
  /** True when a root is provisioned + ready (skip otherwise — a not-yet-set-up
   *  project has no notes to drift). */
  isRootReady: (rootPath: string) => boolean
  /** Runs the read-only stale-check pass for one module. */
  runStaleCheck: StaleCheckRunner
  /** Ignore-list extras for a root (flowconfig `learn_ignore`, see
   *  shared/learn-ignore). Touched modules matching the built-in defaults or
   *  these extras never arm an idle timer — an ignored module can't flip
   *  stale/amber from file churn (a manual Learn stays possible; the
   *  orchestrator's enqueueModule is not gated). Optional — omit (or fail) →
   *  defaults only. */
  readIgnoreExtras?: (rootPath: string) => Promise<string[]>
  /** The optional guarded auto re-learn seam (phase-8 task 2). */
  onModuleStale?: (ctx: ModuleStaleContext) => void | Promise<void>
  /** Resolve `flow/brain/.structure/` for a root. Default: the fixed suffix. */
  structureDirFor?: (rootPath: string) => string
  /**
   * Read-modify-write learning-state as one critical section. Default:
   * `mutateLearningState`. ONE seam rather than a read + a write, for the
   * reason the orchestrator's copy of this dep spells out: the store is a full
   * rewrite, and two seams let the read that decided it drift outside the lock.
   */
  mutateLearning?: MutateLearningState
  /** Set an idle timer. Default: global setTimeout. */
  setTimer?: (fn: () => void, ms: number) => TimerHandle
  /** Clear an idle timer. Default: global clearTimeout. */
  clearTimer?: (handle: TimerHandle) => void
  /** Clock — default new Date() (tests inject a fixed clock). */
  now?: () => Date
  /** Idle window before a touched module is re-checked. Default IDLE_MS. */
  idleMs?: number
  /** Best-effort error sink for background failures (default console.warn). */
  onError?: (message: string, error: unknown) => void
}

const STRUCTURE_SUFFIX = join('flow', 'brain', '.structure')

/**
 * The always-on staleness watcher. One instance per app: `start()` subscribes
 * to the file-change stream; a touched module's timer fires a stale-check after
 * the idle window; a drifted module gets a 'stale' learning-state entry (dot
 * flips) and, if wired, the `onModuleStale` seam runs the guarded auto re-learn.
 */
export class LearnTriggers {
  private readonly pending = new Map<string, TimerHandle>()
  private unsubscribe: (() => void) | null = null
  private disposed = false

  private readonly readModules: (rootPath: string) => Promise<string[]>
  private readonly isRootReady: (rootPath: string) => boolean
  private readonly runStaleCheck: StaleCheckRunner
  private readonly onModuleStale?: (ctx: ModuleStaleContext) => void | Promise<void>
  private readonly structureDirFor: (rootPath: string) => string
  private readonly mutateLearning: MutateLearningState
  private readonly setTimer: (fn: () => void, ms: number) => TimerHandle
  private readonly clearTimer: (handle: TimerHandle) => void
  private readonly now: () => Date
  private readonly idleMs: number
  private readonly onError: (message: string, error: unknown) => void

  constructor(private readonly deps: LearnTriggersDeps) {
    this.readModules = deps.readModules
    this.isRootReady = deps.isRootReady
    this.runStaleCheck = deps.runStaleCheck
    this.onModuleStale = deps.onModuleStale
    this.structureDirFor = deps.structureDirFor ?? ((rootPath) => join(rootPath, STRUCTURE_SUFFIX))
    this.mutateLearning = deps.mutateLearning ?? mutateLearningState
    this.setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
    this.clearTimer = deps.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>))
    this.now = deps.now ?? (() => new Date())
    this.idleMs = deps.idleMs ?? IDLE_MS
    this.onError = deps.onError ?? ((message, error) => console.warn(`[LearnTriggers] ${message}`, error))
  }

  /** Subscribe to the file-change stream. Idempotent per instance. */
  start(): void {
    if (this.disposed || this.unsubscribe !== null) {
      return
    }
    this.unsubscribe = this.deps.onFilesChanged((batch) => {
      void this.handleBatch(batch)
    })
  }

  /** Stop watching and cancel every pending idle timer. Safe to call twice. */
  dispose(): void {
    if (this.disposed) {
      return
    }
    this.disposed = true
    this.unsubscribe?.()
    this.unsubscribe = null
    for (const handle of this.pending.values()) {
      this.clearTimer(handle)
    }
    this.pending.clear()
  }

  // ── internals ──────────────────────────────────────────────────────────

  /** Map a batch to touched modules and (re)arm each module's idle timer. */
  private async handleBatch(batch: FilesChangedBatch): Promise<void> {
    if (this.disposed || !this.isRootReady(batch.rootPath)) {
      return
    }
    let modules: string[]
    try {
      modules = await this.readModules(batch.rootPath)
    } catch (error) {
      this.onError(`readModules failed for ${batch.rootPath}`, error)
      return
    }
    if (this.disposed || modules.length === 0) {
      return
    }
    let ignoreExtras: string[] = []
    try {
      ignoreExtras = (await this.deps.readIgnoreExtras?.(batch.rootPath)) ?? []
    } catch {
      ignoreExtras = [] // Fail-soft: the built-in defaults still apply below.
    }
    for (const modulePath of collectTouchedModules(batch, modules)) {
      // Ignored scaffolding modules never arm a timer — no stale-check spawn,
      // no amber dot from test/fixture churn (#learn-ignore).
      if (isIgnoredModule(modulePath, ignoreExtras)) {
        continue
      }
      this.scheduleIdle(batch.rootPath, modulePath)
    }
  }

  /** Reset the module's idle timer — a fresh touch collapses a save burst. */
  private scheduleIdle(rootPath: string, modulePath: string): void {
    const key = triggerKey(rootPath, modulePath)
    const existing = this.pending.get(key)
    if (existing !== undefined) {
      this.clearTimer(existing)
    }
    const handle = this.setTimer(() => {
      this.pending.delete(key)
      void this.onIdle(rootPath, modulePath)
    }, this.idleMs)
    this.pending.set(key, handle)
  }

  /** The tail of the stale-check queue — one child at a time (see onIdle). */
  private staleQueue: Promise<unknown> = Promise.resolve()

  /** Run one stale-check after every earlier one has finished. */
  private queueStaleCheck(rootPath: string, modulePath: string): Promise<StaleCheckReport | null> {
    const next = this.staleQueue.then(
      () => (this.disposed ? null : this.runStaleCheck(rootPath, modulePath)),
      () => (this.disposed ? null : this.runStaleCheck(rootPath, modulePath)),
    )
    // The queue never carries a rejection forward: one failed check must not
    // wedge every later one.
    this.staleQueue = next.catch(() => null)
    return next
  }

  /** Idle fired: re-hash the module's notes; flip the dot if any drifted. */
  private async onIdle(rootPath: string, modulePath: string): Promise<void> {
    if (this.disposed || !this.isRootReady(rootPath)) {
      return
    }
    try {
      const structureDir = this.structureDirFor(rootPath)
      // ONE AT A TIME, ACROSS EVERY ROOT. Each of these spawns a CLI that
      // re-hashes a module's stamped files — measured at ~7 s of CPU for one
      // root's worth — and a save touching several modules used to fire them
      // all at once. Four repos' worth of that is why the main process reported
      // itself blocked for 27 seconds with no slow handler in sight.
      const report = await this.queueStaleCheck(rootPath, modulePath)
      if (!reportIsStale(report)) {
        return // fresh, or the check could not run — nothing to flip
      }

      // ALWAYS ON: hash-drift flips the dot regardless of budget or toggle.
      //
      // INCLUDING for a module with no learning entry — deliberate, and pinned
      // by the tests below. Stamps come from any anchored note (`blueprint
      // observe`), not only from a learn pass, so "the notes we hold about this
      // drifted" is a real signal even when nobody ran a learn. What made this
      // read as a bug was Reset: it cleared the status table and left the notes
      // whose stamps this re-hashes, so a wiped board grew STALE rows again
      // within the hour. Reset now forgets the notes too, which removes the
      // cause without removing the signal.
      // The read that decides this rewrite lives INSIDE the mutation, not
      // before the stale-check above. That check spawns a CLI and takes
      // seconds; anything read before it is a view of the store from before a
      // whole learn pass could have landed, and rewriting from it would erase
      // whatever landed in the meantime. `priorStatus` still means what it
      // always meant — the module's status BEFORE this stale entry — because
      // `current` is the store as it stands the instant before the write (auto
      // re-learn's "previously learned" check must never see the entry we are
      // about to write).
      let priorStatus: BlueprintLearningStatus | undefined
      await this.mutateLearning(structureDir, (current) => {
        priorStatus = current.find((entry) => entry.module === modulePath)?.status
        return [...current, staleEntry(modulePath, this.now())]
      })

      if (this.onModuleStale !== undefined && !this.disposed) {
        await this.onModuleStale({ rootPath, modulePath, report, priorStatus })
      }
    } catch (error) {
      this.onError(`stale-check failed for ${rootPath}/${modulePath}`, error)
    }
  }
}

/** Dedupe/timer key for a (root, module) pair — NUL-joined so neither half can
 *  spoof a boundary (mirrors the orchestrator's jobKey). */
function triggerKey(rootPath: string, modulePath: string): string {
  return `${rootPath}\x00${modulePath}`
}

// ── default stale-check runner (bundled CLI) ────────────────────────────────

/** Hard cap on one stale-check spawn — a hung CLI must not pin a module. */
const STALE_CHECK_TIMEOUT_MS = 30_000
/** Keep only the tail of stdout — the JSON report is small. */
const STDOUT_TAIL_CHARS = 1_000_000

/**
 * Build the default `StaleCheckRunner`: spawn the app-embedded CLI as
 * Electron-as-Node (`blueprint stale-check --module <m> --json`) in the root,
 * capture stdout, and parse it. Read-only — stale-check never writes. Fail-soft:
 * a spawn failure, non-zero exit, timeout, or unparseable output resolves to
 * null (the trigger then writes nothing). Mirrors the derive-runner's bundled
 * spawn, but captures stdout (which runBundledCli intentionally ignores).
 */
export function makeBundledStaleCheck(
  bundledCli: BundledCli,
  spawnFn: typeof spawn = spawn,
): StaleCheckRunner {
  return (rootPath, modulePath) =>
    new Promise<StaleCheckReport | null>((resolve) => {
      let stdout = ''
      let settled = false
      const settle = (value: StaleCheckReport | null): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(value)
      }
      let child: ReturnType<typeof spawnFn>
      try {
        child = spawnFn(
          bundledCli.execPath,
          [bundledCli.cliPath, 'blueprint', 'stale-check', '--module', modulePath, '--json'],
          {
            cwd: rootPath,
            stdio: ['ignore', 'pipe', 'ignore'],
            env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
          },
        )
      } catch {
        resolve(null)
        return
      }
      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        settle(null)
      }, STALE_CHECK_TIMEOUT_MS)
      child.stdout?.on('data', (chunk: Buffer | string) => {
        stdout = (stdout + String(chunk)).slice(-STDOUT_TAIL_CHARS)
      })
      child.on('error', () => settle(null))
      child.on('close', (code) => {
        settle(code === 0 ? parseStaleCheckJson(stdout) : null)
      })
    })
}

// ── default git-diff runner (bundled auto re-learn gate, phase-8 task 2) ─────

/** The two `git diff` outputs the meaningful-diff heuristic consumes. */
export interface GitDiffOutput {
  numstat: string
  unified: string
}

/** Runs `git diff` for a set of files and returns the numstat + unified output. */
export type GitDiffRunner = (rootPath: string, files: readonly string[]) => Promise<GitDiffOutput | null>

/** Hard cap on one git-diff spawn. */
const GIT_DIFF_TIMEOUT_MS = 10_000

function runGit(rootPath: string, args: string[], spawnFn: typeof spawn): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    let stdout = ''
    let settled = false
    const settle = (value: string | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }
    let child: ReturnType<typeof spawnFn>
    try {
      child = spawnFn('git', args, { cwd: rootPath, stdio: ['ignore', 'pipe', 'ignore'] })
    } catch {
      resolve(null)
      return
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      settle(null)
    }, GIT_DIFF_TIMEOUT_MS)
    child.stdout?.on('data', (chunk: Buffer | string) => {
      stdout += String(chunk)
    })
    child.on('error', () => settle(null))
    child.on('close', (code) => settle(code === 0 ? stdout : null))
  })
}

/**
 * Build the default `GitDiffRunner`: `git diff HEAD -- <files>` in numstat and
 * unified (`--unified=0`) form. HEAD is the proxy for "since the module was
 * learned" — it captures working-tree drift from the last commit, the common
 * mid-edit case. LIMIT: changes committed after a learn (HEAD moved past them)
 * show no diff, so the auto re-learn stays quiet for that module — the dot has
 * still flipped, and a manual Learn re-runs it. Fail-soft: a non-repo / git
 * failure resolves to null (the gate then declines to auto-relearn).
 */
export function makeBundledGitDiff(spawnFn: typeof spawn = spawn): GitDiffRunner {
  return async (rootPath, files) => {
    if (files.length === 0) {
      return null
    }
    const paths = [...files]
    const [numstat, unified] = await Promise.all([
      runGit(rootPath, ['diff', '--numstat', 'HEAD', '--', ...paths], spawnFn),
      runGit(rootPath, ['diff', '--unified=0', 'HEAD', '--', ...paths], spawnFn),
    ])
    if (numstat === null || unified === null) {
      return null
    }
    return { numstat, unified }
  }
}
