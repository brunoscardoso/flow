/**
 * Merge-resolution record store (#66) — two layers over one in-progress merge:
 *
 * 1. PER-HUNK resolutions (conflict-UX Phase 3) — the granular, reversible record
 *    of every hunk choice applied during a merge (mine/theirs/both), whether an
 *    AI auto-applied it or a human clicked it. This is the source of truth for
 *    per-hunk UNDO and for reconstructing what was decided at Cursor-parity
 *    granularity.
 * 2. PER-FILE summary set — the decoupled hand-off to the merge-COMPLETION path
 *    (renderer/git/index.ts fires the summary write at `Complete merge`). The
 *    merge-resolution summary is inherently per-file (`MergeSummaryConflict`), so
 *    this layer is retained and kept in lock-step: clearing a root drops BOTH.
 *
 * The orchestration (conflict-resolve-index.ts) and the completion button live in
 * different domains and can't call each other directly, so both layers are parked
 * here, keyed by root, for the completion path to read. Best-effort by design.
 *
 * PERSISTENCE NOTE: this store is renderer-only, in-memory (session-scoped). The
 * per-hunk records survive within a session (so an auto-applied hunk can be undone
 * before reload) but do NOT survive a reload. Durable persistence — a main-process
 * store keyed by rootPath so auto-applied hunks are reversible across reloads — is
 * deliberately deferred to a follow-up (needs a new IPC channel + store table);
 * see notes_for_next_phase. The undo API below is fully robust in-session.
 */
import type { MergeSummaryConflict, MergeSummaryVerify } from '../../shared/ipc-contract'
import type { ConflictHunkChoice, ConflictHunkOrder } from '../../shared/conflict-hunks'
import type { SideIdentity } from '../../shared/side-identity'

/** One applied hunk choice within a merge — the reversible unit of resolution. */
export interface HunkResolution {
  /** Repo-relative path of the conflicted file. */
  filePath: string
  /** Stable hunk id (see conflict-hunks.ts) — the (filePath, hunkId) pair is unique. */
  hunkId: string
  /** Which side(s) were kept. */
  choice: ConflictHunkChoice
  /** Concatenation order when `choice: 'both'`. */
  order?: ConflictHunkOrder
  /** Concrete identity of the `ours` side, when known (labels the undo history). */
  oursIdentity?: SideIdentity
  /** Concrete identity of the `theirs` side, when known. */
  theirsIdentity?: SideIdentity
  /** True when an AI auto-applied this choice; false for a human click. */
  auto: boolean
  /**
   * The ORIGINAL marker-laden text of this hunk (the `<<<<<<< … >>>>>>>` region)
   * captured BEFORE it was spliced away (conflict-UX Phase 5, Task 4). It is the
   * material `undoHunkResolution` needs to REVERSE an auto-applied hunk —
   * re-introducing the conflict markers so the user can decide again. Optional:
   * a record written without it can still be forgotten, just not re-splice-reversed.
   */
  originalBlock?: string
}

/** The resolution state recorded for one root's in-progress merge. */
export interface MergeResolutionSession {
  /** Per-file summary set consumed by the completion summary writer. */
  conflicts: MergeSummaryConflict[]
  verify?: MergeSummaryVerify
}

/** rootPath → the latest recorded per-file summary session (last write wins). */
const sessionsByRoot = new Map<string, MergeResolutionSession>()

/** rootPath → ordered list of per-hunk resolutions applied this session. */
const hunkResolutionsByRoot = new Map<string, HunkResolution[]>()

// ── Per-hunk layer (Phase 3) ────────────────────────────────────────────────

/**
 * Record (or REPLACE) the resolution for one hunk. Keyed by (filePath, hunkId):
 * re-resolving the same hunk overwrites the prior choice rather than stacking a
 * duplicate, so the record always reflects the hunk's CURRENT decision.
 */
export function recordHunkResolution(rootPath: string, resolution: HunkResolution): void {
  const list = hunkResolutionsByRoot.get(rootPath) ?? []
  const existingIndex = list.findIndex(
    (entry) => entry.filePath === resolution.filePath && entry.hunkId === resolution.hunkId,
  )
  if (existingIndex >= 0) {
    list[existingIndex] = resolution
  } else {
    list.push(resolution)
  }
  hunkResolutionsByRoot.set(rootPath, list)
}

/**
 * Hunk id for a WHOLE-FILE resolution (#1288). The Source Control panel's own
 * side buttons resolve a file outright — there is no hunk id to key them by,
 * and they wrote NOTHING, so the completion review said "No recorded hunk
 * resolutions" immediately after you used the panel's primary button, and the
 * summary doc + commit trailer recorded `0 conflict(s) resolved`.
 *
 * `*` mirrors the main-side ALL_HUNKS convention (diff-review-index.ts).
 */
export const WHOLE_FILE_HUNK_ID = '*'

/**
 * Record a whole-file resolution (the panel's keep-this-side / keep-all), so
 * every path that resolves a conflict lands in the SAME store the review, the
 * summary doc and the commit trailer read. One record per file: re-resolving
 * overwrites, exactly as the per-hunk path does.
 */
export function recordWholeFileResolution(
  rootPath: string,
  resolution: Omit<HunkResolution, 'hunkId' | 'auto'> & { auto?: boolean },
): void {
  recordHunkResolution(rootPath, {
    ...resolution,
    hunkId: WHOLE_FILE_HUNK_ID,
    auto: resolution.auto ?? false,
  })
}

/** All per-hunk resolutions recorded for a root (empty array when none). */
export function getHunkResolutions(rootPath: string): HunkResolution[] {
  return [...(hunkResolutionsByRoot.get(rootPath) ?? [])]
}

/** The per-hunk resolutions recorded for one file under a root. */
export function getHunkResolutionsForFile(rootPath: string, filePath: string): HunkResolution[] {
  return getHunkResolutions(rootPath).filter((entry) => entry.filePath === filePath)
}

/**
 * The AI-AUTO-APPLIED per-hunk resolutions for a root (conflict-UX Phase 5, Task
 * 4) — the set the Conflict Overview surfaces as "auto-resolved ✓ — review /
 * undo". A human-clicked resolution (`auto:false`) is never in this set.
 */
export function getAutoResolutions(rootPath: string): HunkResolution[] {
  return getHunkResolutions(rootPath).filter((entry) => entry.auto)
}

/** Whether a file has ANY auto-applied hunk — drives the file's overview badge. */
export function hasAutoResolution(rootPath: string, filePath: string): boolean {
  return getHunkResolutions(rootPath).some(
    (entry) => entry.auto && entry.filePath === filePath,
  )
}

/**
 * Undo (forget) one hunk's resolution. Returns the removed record so the caller
 * can reverse the file edit — the record's `originalBlock` (captured at record
 * time for auto-applies, Phase 5 Task 4) carries the marker-laden text to
 * re-introduce — or null when nothing matched. In-session undo is robust;
 * file-level reversal is the caller's responsibility.
 */
export function undoHunkResolution(
  rootPath: string,
  filePath: string,
  hunkId: string,
): HunkResolution | null {
  const list = hunkResolutionsByRoot.get(rootPath)
  if (!list) return null
  const index = list.findIndex((entry) => entry.filePath === filePath && entry.hunkId === hunkId)
  if (index < 0) return null
  const [removed] = list.splice(index, 1)
  if (list.length === 0) hunkResolutionsByRoot.delete(rootPath)
  return removed
}

/** Drop every per-hunk resolution for a root (called at merge completion). */
export function clearHunkResolutions(rootPath: string): void {
  hunkResolutionsByRoot.delete(rootPath)
}

// ── Per-file summary layer (completion hand-off) ────────────────────────────

/**
 * Record the per-file resolution set for one or more roots (grouped by rootPath).
 * Overwrites any prior session for each root — the newest resolution turn is the
 * source of truth. Verify (if already known) can be attached later via
 * `recordMergeResolutionVerify`.
 */
export function recordMergeResolutionConflicts(byRoot: Map<string, MergeSummaryConflict[]>): void {
  for (const [rootPath, conflicts] of byRoot) {
    sessionsByRoot.set(rootPath, { conflicts })
  }
}

/**
 * Attach a verification outcome to a root's recorded session. No-op when the
 * root has no session yet — verify without a prior resolution set is not
 * meaningful, and the summary treats a missing session as "no conflicts".
 */
export function recordMergeResolutionVerify(rootPath: string, verify: MergeSummaryVerify): void {
  const session = sessionsByRoot.get(rootPath)
  if (session) session.verify = verify
}

/** Read (peek, non-destructive) the recorded session for a root, or null. */
export function getMergeResolutionSession(rootPath: string): MergeResolutionSession | null {
  return sessionsByRoot.get(rootPath) ?? null
}

/**
 * Drop a root's recorded state — called once the merge has been completed. Clears
 * BOTH layers so a fresh merge on the same root starts clean.
 */
export function clearMergeResolutionSession(rootPath: string): void {
  sessionsByRoot.delete(rootPath)
  hunkResolutionsByRoot.delete(rootPath)
}
