// Merge-Changes conflict selector (#335, Phase 6). Pure membership for the panel's
// Merge Changes section + whether a section-level "Resolve all conflicts" affordance
// should show. assignSections() already routes conflicted files to `merge`; this is
// the small, directly-testable predicate the panel and its resolve controls read.
import type { GitFileChange } from '../../shared/ipc-contract'

/**
 * Confirm copy for the bulk keep-all splice — it rewrites EVERY conflicted
 * file in the section with one side on a single click, while its neighbour
 * "Revert all" always confirmed. Counted, like every destructive confirm here
 * (discard-all.ts owns the discard family's copy).
 */
export function keepAllConfirmMessage(fileCount: number, actionLabel: string): string {
  const files = `${fileCount} conflicted file${fileCount === 1 ? '' : 's'}`
  return `${actionLabel} in ${files}?\n\nEach file's other side is discarded. This cannot be undone.`
}

/** Confirm copy for a per-row whole-side accept — one file, same finality. */
export function resolveSideConfirmMessage(filePath: string, side: 'ours' | 'theirs'): string {
  const kept = side === 'ours' ? 'current (your) side' : 'incoming side'
  return `Resolve ${filePath} by keeping the ${kept}?\n\nThe other side's changes in this file are discarded.`
}

/** Whether the section-level "Resolve all conflicts" control should be offered. */
export function hasResolvableConflicts(changes: readonly GitFileChange[]): boolean {
  return changes.some((change) => change.state === 'conflicted')
}

// ── Conflict Overview hub (conflict-UX Phase 5, Task 2) ──────────────────────
//
// Per-file resolution status + an "N of M resolved" counter for the Merge
// Changes section. Pure + DOM-free so the derivation unit-tests under the node
// jest env; git-panel.ts renders the rows/counter these return.

/** A conflicted file's resolution state in the overview. */
export type FileResolutionStatus = 'unresolved' | 'resolved' | 'auto-resolved'

/** The minimal per-hunk-resolution signal the overview reads (a subset of
 *  merge-resolution-record's `HunkResolution`, kept local so this module needs
 *  no cross-import and stays DOM-free). */
export interface ResolutionSignal {
  /** Repo-relative path of the file the hunk belongs to. */
  filePath: string
  /** True when an AI auto-applied the hunk (drives the `auto-resolved` state). */
  auto: boolean
}

/** Inputs to the overview derivation. */
export interface ConflictOverviewInput {
  /**
   * The full conflict set for this in-progress op (the M denominator). Seeded
   * from the first-observed unmergedPaths and never shrunk while the op runs, so
   * a file that resolves (and drops out of `unmergedPaths`) still counts toward M.
   */
  files: readonly string[]
  /** Files that STILL carry git-level conflicts (the current unmergedPaths). */
  unmergedPaths: readonly string[]
  /** Per-hunk resolutions recorded this session (any file) — flags auto-resolved. */
  resolutions: readonly ResolutionSignal[]
}

/** One row of the overview: a file and its derived status. */
export interface ConflictFileRow {
  filePath: string
  status: FileResolutionStatus
}

/** The derived overview: per-file rows plus the "N of M resolved" counter. */
export interface ConflictOverview {
  rows: ConflictFileRow[]
  resolvedCount: number
  total: number
  /** Pre-rendered "N of M resolved" label. */
  counterLabel: string
  /** True when every file in the set is resolved (mirrors the file gate of
   *  `canComplete` — the git-level unmerged count still owns the hard gate). */
  allResolved: boolean
}

/**
 * The resolution status of ONE file: still-unmerged wins (a file carrying any
 * git-level conflict is `unresolved`, even with some hunks already spliced —
 * file status is whole-file). A fully-resolved file is `auto-resolved` when any
 * of its recorded hunks was AI-applied, else a plain human `resolved`.
 */
export function deriveFileResolutionStatus(
  filePath: string,
  unmerged: ReadonlySet<string>,
  resolutions: readonly ResolutionSignal[],
): FileResolutionStatus {
  if (unmerged.has(filePath)) return 'unresolved'
  const anyAuto = resolutions.some((entry) => entry.filePath === filePath && entry.auto)
  return anyAuto ? 'auto-resolved' : 'resolved'
}

/**
 * Derive the whole Conflict Overview. The file universe is the union of the
 * known conflict set, anything still unmerged, and any file with a recorded
 * resolution — so a whole-file bulk resolve (no per-hunk record) is still
 * counted via `files`/`unmergedPaths`, and a resolved file never silently drops
 * out of the denominator. Rows are path-sorted for a stable render.
 */
export function deriveConflictOverview(input: ConflictOverviewInput): ConflictOverview {
  const unmerged = new Set(input.unmergedPaths)
  const universe = new Set<string>(input.files)
  for (const path of input.unmergedPaths) universe.add(path)
  for (const entry of input.resolutions) universe.add(entry.filePath)

  const rows: ConflictFileRow[] = [...universe]
    .sort((a, b) => a.localeCompare(b))
    .map((filePath) => ({
      filePath,
      status: deriveFileResolutionStatus(filePath, unmerged, input.resolutions),
    }))
  const total = rows.length
  const resolvedCount = rows.filter((row) => row.status !== 'unresolved').length
  return {
    rows,
    resolvedCount,
    total,
    counterLabel: `${resolvedCount} of ${total} resolved`,
    allResolved: total > 0 && resolvedCount === total,
  }
}

/** Human label for a file's resolution status (the overview badge text). */
export function fileResolutionStatusLabel(status: FileResolutionStatus): string {
  switch (status) {
    case 'unresolved':
      return 'Unresolved'
    case 'resolved':
      return 'Resolved'
    case 'auto-resolved':
      return 'Auto-resolved ✓'
  }
}
