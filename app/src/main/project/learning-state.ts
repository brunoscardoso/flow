// Learning-state store — the SINGLE writer/reader for
// `flow/brain/.structure/learning-state.jsonl`, the progressive-learning
// channel a future learn orchestrator (Phase 8 wiring) uses to record each
// module's status (learning → learned, or stale when its code drifts).
//
// The file is small (one line per module), so every update is a FULL REWRITE:
// the caller passes the complete desired set, we dedup by module (keeping the
// latest record per module) and atomically replace the file via temp+rename —
// a reader can never observe a half-written store. Because a full rewrite
// discards whatever the writer did not know about, every write is held under
// an advisory lock shared with the CLI (`learning-state.jsonl.lock`), and a
// read-modify-write belongs inside `mutateLearningState` so the read and the
// rewrite are one critical section. The reader is fail-soft:
// a missing/corrupt file, or corrupt individual lines, never throw (mirrors
// the blueprint stores' per-line fail-soft) — the board treats absence and
// corruption alike as "no learning state".
//
// This module touches only node: builtins (no Electron), so it stays loadable
// from plain Node test harnesses — same discipline as blueprint-observer.ts.

import { promises as fsPromises } from 'node:fs'
import { basename, dirname, isAbsolute, join } from 'node:path'

import type { BlueprintLearningEntry, BlueprintLearningStatus } from '../../shared/ipc-contract'
import { withFileLock, type FileLockLimits } from '../store/file-lock'

/** Filename of the learning-state store inside `flow/brain/.structure/`. */
export const LEARNING_STATE_FILE = 'learning-state.jsonl'

/**
 * Limits for the store's advisory lock. Deliberately the same shape and the
 * same numbers as the CLI's loop-state lock: a learning-state rewrite is a
 * handful of milliseconds, so ten seconds of waiting means a holder that is
 * wedged rather than busy, and a lock file older than ten seconds belongs to a
 * process that is gone.
 */
const LEARNING_STATE_LOCK_LIMITS: FileLockLimits = {
  staleMs: 10_000,
  waitMs: 10_000,
  retryMs: 25,
}

/** Monotonic counter for UNIQUE temp filenames. A fixed temp name made
 *  concurrent writes race — one writer renamed the shared temp away and the next
 *  hit `ENOENT: rename ...jsonl.tmp` (surfaced by "Learn all" firing many
 *  transitions at once). pid + counter is unique per write within the process. */
let tempCounter = 0

const LEARNING_STATUSES: readonly BlueprintLearningStatus[] = ['queued', 'learning', 'learned', 'stale']

/**
 * Dedup entries by module, keeping the LATEST record per module — the one
 * with the greatest `notedAt` (ISO 8601 sorts lexicographically), ties broken
 * by later array position (the caller's own ordering). Result is sorted by
 * module for deterministic on-disk output.
 */
export function dedupLearningEntries(entries: readonly BlueprintLearningEntry[]): BlueprintLearningEntry[] {
  const latestByModule = new Map<string, BlueprintLearningEntry>()
  for (const entry of entries) {
    const existing = latestByModule.get(entry.module)
    // `>=` so a later array position wins on an equal timestamp.
    if (existing === undefined || entry.notedAt >= existing.notedAt) {
      latestByModule.set(entry.module, entry)
    }
  }
  return [...latestByModule.values()].sort((a, b) => a.module.localeCompare(b.module))
}

/**
 * Parse learning-state content into deduped entries. Fail-soft: `null`
 * (missing file), empty content, or content with no valid lines yields
 * `undefined`; corrupt or shape-invalid lines are skipped individually.
 * Mirrors the blueprint stores' contract — absence and corruption are
 * indistinguishable to the reader.
 */
export function parseLearningStateContent(raw: string | null): BlueprintLearningEntry[] | undefined {
  if (raw === null) {
    return undefined
  }
  const entries: BlueprintLearningEntry[] = []
  for (const line of raw.split('\n')) {
    if (line.trim().length === 0) {
      continue
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      // Sanctioned fail-soft: corrupt line — skip it rather than failing the whole read
      continue
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      continue
    }
    const record = parsed as Record<string, unknown>
    if (typeof record.module !== 'string' || record.module.length === 0) {
      continue
    }
    if (!LEARNING_STATUSES.includes(record.status as BlueprintLearningStatus)) {
      continue
    }
    entries.push({
      module: record.module,
      status: record.status as BlueprintLearningStatus,
      notedAt: typeof record.notedAt === 'string' ? record.notedAt : '',
      // Enqueue provenance (#1132) — carried through so a restart resumes the
      // work with the reason and deliberateness the user originally chose.
      // Absent/invalid stays absent: older stores simply resume as deliberate.
      ...(typeof record.reason === 'string' && record.reason.length > 0
        ? { reason: record.reason }
        : {}),
      ...(typeof record.deliberate === 'boolean' ? { deliberate: record.deliberate } : {}),
    })
  }
  if (entries.length === 0) {
    return undefined
  }
  return dedupLearningEntries(entries)
}

/**
 * Read the learning-state store for a `.structure` directory. Fail-soft:
 * a missing/unreadable file or corrupt content resolves to `undefined`.
 */
export async function readLearningState(structureDir: string): Promise<BlueprintLearningEntry[] | undefined> {
  let raw: string | null
  try {
    raw = await fsPromises.readFile(join(structureDir, LEARNING_STATE_FILE), 'utf-8')
  } catch {
    // Sanctioned fail-soft: missing/unreadable store — treat as no learning state
    raw = null
  }
  return parseLearningStateContent(raw)
}

/**
 * Resolve `structureDir` to a real, existing directory. Creating it first is
 * what makes `realpath` legal; resolving symlinks is what keeps `rename` on
 * one filesystem when `flow/` is a symlink (a cross-device rename ENOENTs on
 * macOS). Both the lock path and the store path are derived from the RESOLVED
 * directory, so two callers reaching the store by different symlinked routes
 * still contend for the same lock file.
 */
async function resolveStructureDir(structureDir: string): Promise<string> {
  // NEVER A RELATIVE PATH (2026-10-09). A project id passed where its folder
  // belongs made `mkdir -p '<uuid>/flow/brain/.structure'` relative to the
  // process's cwd — 6,641 stray folders beside the app, each one more for every
  // scan to walk, until the main process stalled ~8 s in every 9.
  if (!isAbsolute(structureDir)) {
    throw new Error(`learning state needs an absolute project path, got '${structureDir}'`)
  }
  await assertProjectStillThere(structureDir)
  await fsPromises.mkdir(structureDir, { recursive: true })
  return await fsPromises.realpath(structureDir)
}

/**
 * NEVER RESURRECT A PROJECT. `mkdir -p` of `<root>/flow/brain/.structure`
 * recreates `<root>` itself when it is gone — and a project folder the person
 * moved or deleted while Flow ran is exactly when the file events that drive
 * learning-state writes arrive. The write recreated an empty
 * `<root>/flow/brain/.structure`, the project then stat'ed as reachable again,
 * and the app went on treating a folder the user had moved away as live
 * (#1118's "it knows the folder is gone" undone a moment later).
 *
 * Only for the project layout this module writes (`<root>/flow/brain/.structure`);
 * `flow` itself may still be created (a project with no flow/ yet is normal).
 */
async function assertProjectStillThere(structureDir: string): Promise<void> {
  const brain = dirname(structureDir)
  const flow = dirname(brain)
  if (basename(structureDir) !== '.structure' || basename(brain) !== 'brain' || basename(flow) !== 'flow') {
    return
  }
  // Throws ENOENT — the caller's write fails as it would on any missing path.
  await fsPromises.access(dirname(flow))
}

/** Where the store's advisory lock lives — the CLI's `<target>.lock` shape. */
function learningStateLockPath(realDir: string): string {
  return join(realDir, `${LEARNING_STATE_FILE}.lock`)
}

/**
 * Run `fn` holding the store's advisory lock.
 *
 * A full-rewrite store is only safe if the READ that decided what to write is
 * inside the same critical section: two writers that each read, append their
 * own entry and rewrite will otherwise both succeed and the slower one's file
 * will be missing the faster one's entry — a silent lost update, not an error.
 * `writeLearningState` takes this lock itself and the lock is re-entrant
 * within a holder's async context, so a caller may wrap a read-modify-write in
 * it without double-locking. The lock file is shared with the CLI, so a
 * `planflow-ai` verb rewriting the same store interlocks with the app.
 */
export async function withLearningStateLock<T>(
  structureDir: string,
  fn: () => T | Promise<T>,
): Promise<T> {
  const realDir = await resolveStructureDir(structureDir)
  return await withFileLock(learningStateLockPath(realDir), LEARNING_STATE_LOCK_LIMITS, fn)
}

/**
 * What a mutation decided: the complete desired set, or `null` for "nothing to
 * change".
 *
 * `null` is not a convenience — it is what keeps a reconcile that finds nothing
 * interrupted from rewriting the store with its own bytes. Every rewrite fires
 * the blueprint watcher, and the board answers that by re-reading and
 * repainting; a store that gets rewritten identically on every startup and
 * every root add is a repaint nobody asked for (the same class of cost
 * allowed-pattern #17 exists for). The decision still happens inside the
 * critical section, so choosing `null` is as safe as choosing a set.
 */
export type LearningStateMutation = readonly BlueprintLearningEntry[] | null

/** Decide the store's next contents from its current ones. See `mutateLearningState`. */
export type LearningStateMutator = (
  current: readonly BlueprintLearningEntry[],
) => LearningStateMutation | Promise<LearningStateMutation>

/**
 * The read-modify-write seam, as a type — what a caller injects to substitute
 * the store in tests. It is deliberately the ONLY learning-state seam those
 * callers get: handing them a `read` and a `write` separately is handing them
 * the two halves of the lost update, and no amount of care at the call site
 * puts them back inside one critical section (allowed-pattern #14).
 */
export type MutateLearningState = (
  structureDir: string,
  mutate: LearningStateMutator,
) => Promise<BlueprintLearningEntry[]>

/**
 * Read-modify-write the store as ONE critical section: `mutate` receives the
 * current entries (empty when the store is absent) and returns the complete
 * desired set, or `null` to leave the store untouched. This is the API every
 * caller that appends or re-maps entries should use — a bare
 * `readLearningState` … `writeLearningState` pair around the same work is the
 * lost update described above.
 */
export const mutateLearningState: MutateLearningState = async (structureDir, mutate) => {
  return await withLearningStateLock(structureDir, async () => {
    const current = (await readLearningState(structureDir)) ?? []
    const next = await mutate(current)
    if (next === null) {
      return [...current]
    }
    await writeLearningState(structureDir, next)
    return dedupLearningEntries(next)
  })
}

/**
 * Rewrite the learning-state store with `entries` (deduped by module, latest
 * per module). Full rewrite via temp+rename so a reader never sees a
 * half-written file. Creates `structureDir` if it does not exist yet.
 *
 * Held under the store's advisory lock: the file
 * is rewritten on every module transition — hundreds during a "Learn all" —
 * and the app is not its only writer, so an unguarded rewrite is a lost update
 * waiting for two writers to overlap. Re-entrant, so a caller already inside
 * `withLearningStateLock` / `mutateLearningState` pays nothing extra.
 */
export async function writeLearningState(
  structureDir: string,
  entries: readonly BlueprintLearningEntry[],
): Promise<void> {
  const realDir = await resolveStructureDir(structureDir)
  await withFileLock(learningStateLockPath(realDir), LEARNING_STATE_LOCK_LIMITS, async () => {
    const deduped = dedupLearningEntries(entries)
    const content = deduped.length > 0 ? `${deduped.map((entry) => JSON.stringify(entry)).join('\n')}\n` : ''
    // Unique temp name so concurrent writes never rename the SAME temp (ENOENT race).
    const tempPath = join(realDir, `${LEARNING_STATE_FILE}.${process.pid}.${tempCounter++}.tmp`)
    const finalPath = join(realDir, LEARNING_STATE_FILE)
    try {
      await fsPromises.writeFile(tempPath, content, 'utf-8')
      await fsPromises.rename(tempPath, finalPath)
    } catch (error) {
      // Best-effort cleanup so a failed write never leaves an orphan temp behind.
      await fsPromises.rm(tempPath, { force: true }).catch(() => undefined)
      throw error
    }
  })
}
