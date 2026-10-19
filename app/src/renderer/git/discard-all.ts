// "Revert all" serialization (#506). Reverting a file runs `git checkout HEAD --
// <path>` (or deletes an untracked one), which takes `.git/index.lock`. Firing
// them concurrently (the original Promise.all) makes the second-and-later checkouts
// collide on the lock and silently leave files undiscarded. So the reverts run ONE
// AT A TIME — reliable, and still fast for a working-tree-sized set. Pure + injected
// revert fn → unit-testable with no IPC.

import type { GitFileChange } from '../../shared/ipc-contract'

/** An untracked change is DELETED by a discard, not reverted — the confirm must
 *  say so instead of the euphemistic "discard changes" (#1054). */
function isUntracked(change: Pick<GitFileChange, 'state' | 'worktreeState'>): boolean {
  return change.worktreeState === 'untracked' || change.state === 'untracked'
}

/**
 * Per-row discard confirm copy (#1054). The three cases say what actually
 * happens:
 *   - untracked DIRECTORY (rolled-up `dir/`): its untracked files are deleted,
 *     scoped to what `git clean` (no `-x`) would remove — `.gitignore`d files
 *     inside are explicitly called out as kept;
 *   - untracked FILE: the file is deleted;
 *   - tracked change: reverted (the original copy).
 */
export function discardConfirmMessage(
  change: Pick<GitFileChange, 'filePath' | 'state' | 'worktreeState' | 'submodule'>,
  repoName?: string | null,
): string {
  const where = repoIn(repoName)
  // #1478: a submodule's "change" is a moved pointer, and discarding it puts the
  // submodule back on the commit this repo records. Saying "this can't be undone"
  // about that overstated it in one direction (the submodule's own commits are
  // untouched) and understated it in another (the question never said the working
  // tree of ANOTHER repository was about to move).
  if (change.submodule === true) {
    return (
      `Reset submodule ${change.filePath}${where} to the commit recorded here? ` +
      `Its own history is untouched, and uncommitted work inside it will block the reset.`
    )
  }
  if (isUntracked(change)) {
    if (change.filePath.endsWith('/')) {
      return (
        `Delete the untracked files in ${change.filePath}${where}? ` +
        `Files matched by .gitignore are kept. This can't be undone.`
      )
    }
    return `Delete untracked file ${change.filePath}${where}? This can't be undone.`
  }
  return `Discard changes in ${change.filePath}${where}? This can't be undone.`
}

/**
 * The repo clause for destructive copy (#1144) — ` in <repo>`, or nothing.
 *
 * The paths in these confirms are repo-RELATIVE, so in a multi-repo panel two
 * repos with the same file changed (README.md in an app+core pair — the
 * ordinary shape) produced byte-identical questions on an unrecoverable
 * action. Absent/blank name → the copy is unchanged, which is exactly the
 * single-repo panel.
 */
function repoIn(repoName: string | null | undefined): string {
  return repoName && repoName.trim().length > 0 ? ` in ${repoName}` : ''
}

/** Bulk "Revert all" confirm copy — names the deletion blast radius when the
 *  set contains untracked paths (#1054), and the repo it will destroy (#1144). */
export function discardAllConfirmMessage(
  changes: ReadonlyArray<Pick<GitFileChange, 'filePath' | 'state' | 'worktreeState'>>,
  repoName?: string | null,
): string {
  const untracked = changes.filter(isUntracked).length
  const base = `Discard ALL ${changes.length} working-tree change(s)${repoIn(repoName)}?`
  if (untracked === 0) return `${base} This can't be undone.`
  return (
    `${base} ${untracked} untracked path(s) will be DELETED ` +
    `(files matched by .gitignore are kept). This can't be undone.`
  )
}

export interface DiscardAllResult {
  /** Paths whose revert threw — left undiscarded, surfaced so the user can retry. */
  failed: string[]
}

/**
 * Revert `filePaths` sequentially via `revert`, collecting the ones that throw.
 * Never rejects — a failing path is recorded and the next path still runs.
 */
export async function discardAllSequential(
  filePaths: readonly string[],
  revert: (filePath: string) => Promise<void>,
): Promise<DiscardAllResult> {
  const failed: string[] = []
  for (const filePath of filePaths) {
    try {
      await revert(filePath)
    } catch {
      failed.push(filePath)
    }
  }
  return { failed }
}

/** Toast body naming the first few files left undiscarded (#506). */
export function discardFailureMessage(failed: readonly string[], total: number): string {
  const names = failed.slice(0, 3).map((path) => path.split('/').pop() ?? path)
  const more = failed.length > 3 ? ` +${failed.length - 3} more` : ''
  return `${failed.length} of ${total} file(s) failed to revert: ${names.join(', ')}${more}. Try again to finish.`
}
