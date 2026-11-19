/**
 * THE HISTORY MODEL — which snapshot an undo restores, how many steps there
 * are, and which snapshots a folder keeps. Pure and DOM-free: the store lists
 * the folders and does the writing, this decides.
 *
 * A canvas keeps one history folder per file (a screen's is its slug, the
 * layout's is `.layout`, the tokens' is `.tokens`). A snapshot is named
 * `<15-digit ms>-<3-digit counter>.<ext>`, so names sort by time as strings.
 *
 * UNDO IS PER CANVAS. One press steps back one change, whoever made it: the
 * newest stamp across every folder is the step, and every file that has a
 * snapshot at that stamp goes back together. A version restore writes all its
 * files under one stamp (the store passes one clock reading), so undoing a
 * restore is one press too.
 */
import { DRAFT_LAYOUT_FILE, DRAFT_TOKENS_FILE } from '../../shared/ui-drafts'

const SNAPSHOT_NAME = /^(\d{15})-(\d{3})\.[a-z]+$/

/** Whether `name` is an undo snapshot's file name. */
export function isSnapshotName(name: string): boolean {
  return SNAPSHOT_NAME.test(name)
}

/**
 * A snapshot's name: a zero-padded millisecond stamp and a counter for a tie —
 * always present, so `…-000` and `…-001` sort in order (a bare stamp would sort
 * AFTER its own tie, since '-' < '.').
 */
export function snapshotName(at: number, attempt: number, extension: string): string {
  return `${String(at).padStart(15, '0')}-${String(attempt).padStart(3, '0')}${extension}`
}

/** The time stamp of a snapshot name, or null when it is not one. */
export function snapshotStamp(name: string): string | null {
  return SNAPSHOT_NAME.exec(name)?.[1] ?? null
}

/** The snapshot names of a folder, oldest first; anything else in it is ignored. */
export function sortedSnapshots(names: readonly string[]): string[] {
  return names.filter(isSnapshotName).sort()
}

/** The oldest names beyond `limit` — what a folder drops after a new snapshot. */
export function snapshotsToPrune(names: readonly string[], limit: number): string[] {
  const all = sortedSnapshots(names)
  return all.slice(0, Math.max(0, all.length - limit))
}

/** The canvas file a history folder belongs to, or null for a folder that is not one. */
export function fileOfHistoryFolder(folder: string): string | null {
  if (folder === '.layout') return DRAFT_LAYOUT_FILE
  if (folder === '.tokens') return DRAFT_TOKENS_FILE
  return /^[a-z0-9][a-z0-9-]*$/.test(folder) ? `${folder}.html` : null
}

/** One history folder and the names inside it. */
export interface HistoryFolder {
  folder: string
  names: string[]
}

/** One snapshot an undo puts back. */
export interface UndoRestore {
  folder: string
  name: string
}

export interface UndoPlan {
  /** How many presses of Undo there are left. */
  steps: number
  /** What the next press puts back (empty when there is nothing to undo). */
  restore: UndoRestore[]
}

/** Which snapshots the next undo restores, and how many steps remain. */
export function planCanvasUndo(folders: readonly HistoryFolder[]): UndoPlan {
  const stamps = new Set<string>()
  const newest: Array<{ folder: string; name: string; stamp: string }> = []
  for (const { folder, names } of folders) {
    if (fileOfHistoryFolder(folder) === null) continue
    const sorted = sortedSnapshots(names)
    for (const name of sorted) {
      const stamp = snapshotStamp(name)
      if (stamp !== null) stamps.add(stamp)
    }
    const last = sorted[sorted.length - 1]
    const stamp = last === undefined ? null : snapshotStamp(last)
    if (last !== undefined && stamp !== null) newest.push({ folder, name: last, stamp })
  }
  if (newest.length === 0) return { steps: 0, restore: [] }
  const top = newest.reduce((best, entry) => (entry.stamp > best ? entry.stamp : best), newest[0].stamp)
  return {
    steps: stamps.size,
    restore: newest.filter((entry) => entry.stamp === top).map(({ folder, name }) => ({ folder, name })),
  }
}
