// Porcelain v2 status-letter mapping (#335). `git status --porcelain=v2` reports
// each tracked entry with an XY pair: X = the INDEX (staged) state, Y = the
// WORKTREE (unstaged) state, each a letter or '.' when clean. The read-only panel
// only ever surfaced a single "worktree-wins" state; the unified Source Control
// panel needs both sub-states so a file can appear in Staged AND Changes. These
// pure helpers split the pair; git-manager's status parser uses them.
import type { GitConflictType, GitFileState } from '../../shared/ipc-contract'

/** Map one porcelain v2 status letter to a GitFileState, or null when the slot is
 *  clean ('.'/absent). Shared by the index (X) and worktree (Y) slots. */
export function letterToState(letter: string | undefined): GitFileState | null {
  switch (letter) {
    case undefined:
    case '.':
      return null
    case 'A':
      return 'added'
    case 'D':
      return 'deleted'
    case 'R':
      return 'renamed'
    case 'U':
      return 'conflicted'
    default:
      // M (modified), T (type change), C (copied), and anything unexpected.
      return 'modified'
  }
}

/** Split a porcelain v2 XY pair into its staged (index) + unstaged (worktree) states. */
export function parsePorcelainStates(xy: string): {
  indexState: GitFileState | null
  worktreeState: GitFileState | null
} {
  return {
    indexState: letterToState(xy[0]),
    worktreeState: letterToState(xy[1]),
  }
}

/**
 * The porcelain v2 `u <XY>` unmerged codes → conflict sub-type. Only these
 * seven XY pairs are valid for `u` records; anything else yields `undefined`
 * (the caller keeps `state: 'conflicted'` with no refinement).
 */
const CONFLICT_TYPE_BY_XY: Record<string, GitConflictType> = {
  DD: 'both-deleted',
  AU: 'added-by-us',
  UD: 'deleted-by-them',
  UA: 'added-by-them',
  DU: 'deleted-by-us',
  AA: 'both-added',
  UU: 'both-modified',
}

/**
 * Decode a porcelain v2 unmerged XY pair (from a `u <XY>` record) into its
 * conflict sub-type. Returns undefined for any pair git never emits for `u`. */
export function conflictTypeFromXY(xy: string): GitConflictType | undefined {
  return CONFLICT_TYPE_BY_XY[xy]
}

/**
 * Derive the conflict sub-type from which of the three merge stages exist —
 * the stage-presence equivalent of {@link conflictTypeFromXY}, used where the
 * XY code is not at hand (readConflicted reads the stage blobs directly).
 *
 *   ours theirs base  → type
 *    ✓     ✓     ✓       both-modified (UU)
 *    ✓     ✓     ·       both-added    (AA)
 *    ✓     ·     ✓       deleted-by-them (UD, modify/delete)
 *    ✓     ·     ·       added-by-us   (AU)
 *    ·     ✓     ✓       deleted-by-us (DU, delete/modify)
 *    ·     ✓     ·       added-by-them (UA)
 *    ·     ·     ✓       both-deleted  (DD)
 *    ·     ·     ·       undefined (not an unmerged entry)
 */
export function conflictTypeFromStages(stages: {
  ours: boolean
  theirs: boolean
  base: boolean
}): GitConflictType | undefined {
  const { ours, theirs, base } = stages
  if (ours && theirs) return base ? 'both-modified' : 'both-added'
  if (ours && !theirs) return base ? 'deleted-by-them' : 'added-by-us'
  if (!ours && theirs) return base ? 'deleted-by-us' : 'added-by-them'
  return base ? 'both-deleted' : undefined
}
