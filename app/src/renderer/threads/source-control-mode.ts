/**
 * WHICH OF ITS THREE JOBS THE CHANGES TAB IS DOING — and what its tab says.
 *
 * ONE RULE, BECAUSE THE LABEL *IS* THE STATE. The tab renames itself: Changes,
 * Conflicts, History. If the mode and the word were decided separately, the
 * only way a reader could tell they had drifted is a tab that says one thing
 * and shows another — a bug with no test that fails and no error anyone sees.
 * So one function answers both, and the label is derived from the mode rather
 * than passed alongside it.
 *
 * A CONFLICT IS NOT A PREFERENCE. When a merge stops with unresolved files, the
 * reader is not browsing — they are stuck, and the thing they need is the only
 * thing that matters until it is done. So a live conflict WINS over whatever
 * mode was last asked for, and the tab switches itself. Returning to Changes is
 * something the repository does by being resolved, not something the reader has
 * to remember to do.
 *
 * HISTORY IS ALWAYS A REQUEST. Nothing about a repository's state means "you
 * wanted to look at past commits", so History is entered only by asking and is
 * given up the moment a conflict appears.
 *
 * Pure and DOM-free; no path, command or config key crosses it
 * (forbidden-pattern #12).
 */

import type { GitMergeState } from '../../shared/ipc-contract'

/** The three jobs the tab does. */
export type SourceControlMode = 'changes' | 'conflicts' | 'history'

/** What the reader last asked for. A conflict may override it; nothing else does. */
export type SourceControlRequest = 'changes' | 'history'

/** The mode, and the word on the tab — decided together, never separately. */
export interface SourceControlTab {
  mode: SourceControlMode
  label: string
}

/**
 * Whether a repository is actually stopped on a conflict.
 *
 * BOTH HALVES ARE REQUIRED. An operation in progress with nothing unmerged is a
 * merge that is going fine, and a tab that shouts "Conflicts" at it is wrong in
 * the way that teaches people to ignore the tab. `op: 'none'` with an empty
 * list is also the fail-soft answer for "this is not a repository at all", so
 * reading the paths keeps a non-repo out of Conflicts by construction.
 *
 * THE PATHS DECIDE, NOT THE OPERATION. A pull with `--autostash` finishes its
 * merge (no `MERGE_HEAD`, so `op: 'none'`) and THEN clashes re-applying the
 * kept work, leaving files unmerged with no operation in progress. That
 * repository is stopped on a conflict all the same.
 */
export function isConflicted(merge: GitMergeState | null): boolean {
  if (merge === null) return false
  return merge.unmergedPaths.length > 0
}

/**
 * The tab's mode and its label.
 *
 * The order of the two checks is the whole rule: a conflict is asked about
 * first, so nothing a reader previously asked for can hide one.
 */
export function sourceControlTab(
  merge: GitMergeState | null,
  requested: SourceControlRequest = 'changes',
): SourceControlTab {
  if (isConflicted(merge)) return { mode: 'conflicts', label: 'Conflicts' }
  if (requested === 'history') return { mode: 'history', label: 'History' }
  return { mode: 'changes', label: 'Changes' }
}

/**
 * What the reader is left asking for after a mode change.
 *
 * A CONFLICT MUST NOT ERASE THE REQUEST. The tab being seized by a conflict is
 * temporary; the reader was in History and will want it back when the merge is
 * done. So `conflicts` is never recorded as a request, and resolving the
 * conflict puts them back where they were rather than dumping them in Changes.
 */
export function nextRequest(
  current: SourceControlRequest,
  chosen: SourceControlMode,
): SourceControlRequest {
  if (chosen === 'conflicts') return current
  return chosen
}
